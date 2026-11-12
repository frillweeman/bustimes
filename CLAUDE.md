# Bus Thing: notes for Claude

Node 24 / TypeScript / Express, about 1,100 lines. Read `README.md` first for behaviour and
endpoints. Source is `functions/src/index.ts` (server) and `functions/src/preprocess-gtfs.ts`
(build-time GTFS reduction).

## Deployment (this is the real setup)

- Runs on the plex host `plex@192.168.0.17` in `~/bustimes`, port 3000, via `docker compose`.
  `plex` is not in the docker group but has passwordless `sudo`.
- Deploy: `git push origin master`, then
  `ssh plex@192.168.0.17 'cd ~/bustimes && git pull --ff-only && sudo docker compose up -d --build'`.
- `google_transit.zip` is untracked. A `git pull` that removes it is expected; run
  `python3 scripts/update_gtfs.py --rebuild` on the host to fetch it. A daily cron (plex's
  crontab, 10:30 UTC) already does this.
- LaraPaper (the TRMNL server) is `~/larapaper` on the same host, port 4567. It is not part
  of this repo. Its recipe markup (`render_markup`, Liquid, the "full" layout) is a copy of
  `eink/bus-board.liquid`; after editing the template, update it:
  `base64 < eink/bus-board.liquid` into `php artisan tinker` via
  `sudo docker compose exec -T app php artisan tinker --execute=...`
  (`Plugin::where('id',1)->update(['render_markup' => base64_decode('...')])`), and compare
  md5s. The recipe's `data_stale_minutes` is 0 on purpose (UI minimum is 1).
- The host runs in UTC. Server-side time formatting uses `America/Denver` explicitly.

## Things that have bitten before

- **Stale static GTFS is silent.** Symptom: one destination empty, or all trips marked
  direction 0. Check `/healthz` (`scheduleExpired`) and
  `python3 scripts/update_gtfs.py --check`. The old zip expired 2026-06-06 and nothing
  complained.
- `functions/transit-config.json` and `functions/google_transit.zip` are symlinks to `../`;
  Docker `COPY` must use the root files (it does).
- Python 3.10 on the host: `urllib` doesn't follow HTTP 308 (RTD's URL does); the updater
  has a handler for it. Don't use 3.11-only stdlib features in `scripts/`.
- zsh: `$var:e` in a command is a history modifier; write `${var}:path`.
- macOS `sed -i` needs `-i ''`; prefer a small Python edit.

## Previewing the e-ink template without LaraPaper

`pip install python-liquid` in a venv, render `eink/bus-board.liquid` with a `data` dict
shaped like `/api/arrivals`, wrap it in `<div class=screen>`, and screenshot with a
Chromium (`--headless --window-size=960,672 --screenshot=out.png`). Note python-liquid
rejects `cols` as a variable name (tablerow keyword); LaraPaper's engine may differ, so
confirm against the real render: fetch `/api/display` from LaraPaper as the badge does and
decode the BMP (see the badge repo's `trmnl/tests/test_bmp.py`).

## Conventions

- Keep time maths on the server at request time, from absolute epoch seconds. Don't cache
  relative values.
- Don't change `/events` semantics (the web page depends on `stops[0]` being the primary
  stop); put new behaviour on `/api/arrivals`.
- Type-check before deploying: `cd functions && npx tsc --noEmit`.
