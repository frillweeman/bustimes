# Bus Thing

Personal transit dashboard for RTD Denver. It shows live bus arrivals for a few configured
stops, with how long you have to leave by e-skate or bike. There are two front ends:

- **Web page** (`public/index.html`), fed by server-sent events.
- **E-ink board** (`eink/bus-board.liquid`), a 960 x 672 black-and-white layout rendered by
  a [LaraPaper](https://github.com/usetrmnl/larapaper) (TRMNL BYOS) recipe that polls
  `/api/arrivals`, and shown on the Supercon badge.

## How it works

- Every `pollFrequencySeconds` (60) the server fetches RTD's GTFS-realtime `TripUpdate`
  feed and merges it with the static schedule (`google_transit.zip`, reduced at build time
  to `gtfs-preprocessed.json`). Realtime trips are matched to the static schedule by
  `trip_id`, which gives each trip its route and direction. The result is cached.
- Nothing time-relative is cached. Only RTD's absolute arrival times are; every request
  computes `minutesAway`, `leaveInMinutes` and `arrivalTime` from the current time.
- A trip stays listed until its **last** configured stop has passed (Terracina, then
  Starbucks). The web page keeps the original rule (first stop only) via `forWebPage()`.

## Endpoints

| path | what |
| --- | --- |
| `GET /` | web page |
| `GET /events` | server-sent events: `{destinations, updatedAt}` on every poll |
| `GET /api/arrivals` | JSON for polling clients: per trip `stops[]`, `nextStop`, `thenStop`; per stop `minutesAway`, `arrivalTime` (America/Denver), `leaveInMinutes {electric, bike}`, `isRealtime` |
| `GET /healthz` | `ok`, `updatedAt`, `gtfsValidThrough`, `scheduleExpired` (503 until the first poll; `ok:false` once the schedule has expired) |

## Configuration (`transit-config.json`)

`tripUpdateUrl`, `pollFrequencySeconds`, `stops[]` (id, nickname, comfortable access time
in seconds for e-skate and bike) and `destinationCities[]` (per route: `routeId`,
`directionId`, `stopsIds`). `functions/transit-config.json` and
`functions/google_transit.zip` are symlinks to the root files.

## Keeping the static schedule current

RTD publishes a new static feed every few months and **every trip_id changes**. When the
zip here is out of date, realtime trips can't be matched, direction defaults to 0 and
whole destinations go empty. `scripts/update_gtfs.py` handles it (Python 3.10+, stdlib only):

```sh
python3 scripts/update_gtfs.py --check      # validate the installed zip, no download
python3 scripts/update_gtfs.py              # download, validate, install
python3 scripts/update_gtfs.py --rebuild    # ...and docker compose up -d --build
```

It rejects a feed that doesn't cover today, drops a configured route or stop, or has no
trips at a configured stop, and keeps the old zip in that case (exit 2). A download failure
exits 1. The zip is **not in git**; run the script once on a fresh clone before building.
Daily cron on the host (it rebuilds only when RTD publishes a new feed version):

```
30 10 * * * cd /home/plex/bustimes && /usr/bin/python3 scripts/update_gtfs.py --rebuild >> /home/plex/bustimes-gtfs.log 2>&1
```

## Run

```sh
python3 scripts/update_gtfs.py        # first time: fetch the static feed
docker compose up -d --build          # serves on :3000
```

## E-ink board

`eink/bus-board.liquid` is the recipe's "full" layout (Liquid). Black and white only: solid
fills, heavy weights, no grey. It pins LaraPaper's `.screen` wrapper to 960 x 672, since a
device without a matching Device Model gets the framework's 800 x 480. Setup is described
in the badge repo (`trmnl/README.md`).
