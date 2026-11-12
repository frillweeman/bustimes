#!/usr/bin/env python3
"""Keep RTD's static GTFS (google_transit.zip) current. Standard library only.

Why this matters: the server matches realtime trips to the static schedule by
trip_id. RTD publishes a new static feed every few months and every trip_id
changes. Once the zip here is out of date, realtime trips can't be matched, the
direction of travel is guessed wrong, and whole destinations go empty.

What it does:
  1. Download the current feed (default: RTD's public URL; override with GTFS_URL).
  2. Skip everything if it is the same feed_version as the installed zip.
  3. Validate it against transit-config.json: it must cover today, every
     configured route and stop must exist, and every (route, direction, stop)
     must have trips. A feed that fails validation is NOT installed.
  4. Install it atomically (the old zip is kept as google_transit.zip.prev).
  5. With --rebuild, rebuild and restart the docker compose service so the
     preprocessed schedule is regenerated.

Usage:
  scripts/update_gtfs.py [--rebuild] [--force] [--check]

  --check     only validate the installed zip (no download); exit 2 if it is bad
  --force     reinstall even if the feed_version is unchanged
  --rebuild   docker compose up -d --build after installing a new feed

Exit codes: 0 ok or already current, 1 download failed, 2 validation failed.

Cron (docker usually needs root, so use root's crontab; 04:30 every day):
  30 4 * * * cd /home/plex/bustimes && /usr/bin/python3 scripts/update_gtfs.py --rebuild >> /var/log/bustimes-gtfs.log 2>&1
"""
import argparse
import collections
import csv
import datetime
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
ZIP_PATH = ROOT / "google_transit.zip"
CONFIG_PATH = ROOT / "transit-config.json"
URL = os.environ.get("GTFS_URL", "https://www.rtd-denver.com/files/gtfs/google_transit.zip")
TZ = ZoneInfo("America/Denver")
REQUIRED = ("routes.txt", "stops.txt", "trips.txt", "stop_times.txt")


def log(msg):
    print(f"{datetime.datetime.now(TZ):%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, "utf-8-sig", newline=""))


def feed_info(path):
    """feed_version / feed_end_date of a zip, or {} if unreadable."""
    try:
        with zipfile.ZipFile(path) as z:
            if "feed_info.txt" in z.namelist():
                return next(rows(z, "feed_info.txt"), {})
    except (OSError, zipfile.BadZipFile):
        pass
    return {}


def ymd(d):
    return d.strftime("%Y%m%d")


def active_services(z, day):
    """service_ids running on `day` (a date), from calendar.txt and calendar_dates.txt."""
    names = z.namelist()
    weekday = day.strftime("%A").lower()
    active = set()
    if "calendar.txt" in names:
        for r in rows(z, "calendar.txt"):
            if r["start_date"] <= ymd(day) <= r["end_date"] and r.get(weekday) == "1":
                active.add(r["service_id"])
    if "calendar_dates.txt" in names:
        for r in rows(z, "calendar_dates.txt"):
            if r["date"] == ymd(day):
                (active.add if r["exception_type"] == "1" else active.discard)(r["service_id"])
    return active


def validate(path, config):
    """Returns (errors, warnings, summary lines)."""
    errors, warnings, notes = [], [], []
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        return ["not a valid zip file"], warnings, notes
    with z:
        bad = z.testzip()
        if bad:
            return [f"corrupt zip member: {bad}"], warnings, notes
        missing = [n for n in REQUIRED if n not in z.namelist()]
        if missing:
            return [f"missing files: {', '.join(missing)}"], warnings, notes

        today = datetime.datetime.now(TZ).date()
        if not active_services(z, today):
            errors.append(f"no service is active today ({today}); the feed does not cover today")
        info = next(rows(z, "feed_info.txt"), {}) if "feed_info.txt" in z.namelist() else {}
        end = info.get("feed_end_date", "")
        if end:
            left = (datetime.datetime.strptime(end, "%Y%m%d").date() - today).days
            notes.append(f"feed {info.get('feed_version', '?')} valid through {end} ({left} days left)")
            if 0 <= left < 14:
                warnings.append(f"feed expires in {left} days; RTD should publish a replacement soon")

        wanted = collections.defaultdict(set)  # (route, direction) -> configured stops
        for city in config["destinationCities"]:
            for r in city["routes"]:
                wanted[(r["routeId"], str(r["directionId"]))] |= set(r["stopsIds"])
        routes = {r["route_id"] for r in rows(z, "routes.txt")}
        stops = {r["stop_id"] for r in rows(z, "stops.txt")}
        for rid in sorted({k[0] for k in wanted} - routes):
            errors.append(f"route {rid} is not in the feed (RTD renamed or dropped it?)")
        for sid in sorted(set().union(*wanted.values()) - stops):
            errors.append(f"stop {sid} is not in the feed (RTD renumbered it?)")

        if not errors:
            trips = {r["trip_id"]: (r["route_id"], r["direction_id"]) for r in rows(z, "trips.txt")
                     if (r["route_id"], r["direction_id"]) in wanted}
            served = collections.Counter()
            for r in rows(z, "stop_times.txt"):
                key = trips.get(r["trip_id"])
                if key and r["stop_id"] in wanted[key]:
                    served[(key, r["stop_id"])] += 1
            for key in sorted(wanted):
                for sid in sorted(wanted[key]):
                    n = served[(key, sid)]
                    notes.append(f"route {key[0]} dir {key[1]} stop {sid}: {n} scheduled stops")
                    if n == 0:
                        errors.append(f"no trips for route {key[0]} direction {key[1]} at stop {sid}")
    return errors, warnings, notes


def download(dest):
    req = urllib.request.Request(URL, headers={"User-Agent": "bus-thing/1.0 (personal transit dashboard)"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as out:
        shutil.copyfileobj(resp, out)


def rebuild():
    cmd = ["docker", "compose", "up", "-d", "--build"]
    log("rebuilding: " + " ".join(cmd))
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0 and "permission denied" in (r.stdout + r.stderr).lower() and os.geteuid() != 0:
        log("docker needs privileges; retrying with sudo -n")
        r = subprocess.run(["sudo", "-n"] + cmd, cwd=ROOT, capture_output=True, text=True)
    tail = (r.stdout + r.stderr).strip().splitlines()[-5:]
    for line in tail:
        log("  " + line)
    if r.returncode != 0:
        log("rebuild FAILED")
        return False
    log("rebuild ok")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--rebuild", action="store_true", help="docker compose up -d --build after installing")
    ap.add_argument("--force", action="store_true", help="reinstall even if feed_version is unchanged")
    ap.add_argument("--check", action="store_true", help="validate the installed zip only")
    args = ap.parse_args()
    config = json.loads(CONFIG_PATH.read_text())

    if args.check:
        errors, warnings, notes = validate(ZIP_PATH, config)
        for n in notes:
            log(n)
        for w in warnings:
            log("WARNING: " + w)
        for e in errors:
            log("ERROR: " + e)
        return 2 if errors else 0

    with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
        new = Path(tmp) / "google_transit.zip"
        log(f"downloading {URL}")
        try:
            download(new)
        except Exception as ex:  # network, HTTP, disk
            log(f"ERROR: download failed: {ex}")
            return 1
        log(f"downloaded {new.stat().st_size / 1e6:.1f} MB")

        old_v, new_v = feed_info(ZIP_PATH).get("feed_version"), feed_info(new).get("feed_version")
        if not args.force and old_v and old_v == new_v:
            log(f"already current: feed_version {new_v}")
            errors, warnings, _ = validate(ZIP_PATH, config)
            for w in warnings:
                log("WARNING: " + w)
            for e in errors:
                log("ERROR: installed feed is current but invalid: " + e)
            return 2 if errors else 0

        errors, warnings, notes = validate(new, config)
        for n in notes:
            log(n)
        for w in warnings:
            log("WARNING: " + w)
        if errors:
            for e in errors:
                log("ERROR: " + e)
            log("new feed rejected; keeping the installed one")
            return 2

        if ZIP_PATH.exists():
            shutil.copy2(ZIP_PATH, ZIP_PATH.with_suffix(".zip.prev"))
        os.replace(new, ZIP_PATH)  # same filesystem (temp dir lives in ROOT), so atomic
        log(f"installed feed_version {new_v} (was {old_v or 'none'})")

    if args.rebuild and not rebuild():
        return 1
    elif not args.rebuild:
        log("not rebuilding; run: docker compose up -d --build")
    return 0


if __name__ == "__main__":
    sys.exit(main())
