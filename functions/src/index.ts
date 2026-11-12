import express, { Response } from "express";
import axios from "axios";
import { transit_realtime } from "gtfs-realtime-bindings";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------
interface StopConfig {
  stopId: string;
  nickname: string;
  comfortableAccessTimeSeconds: { electric: number; bike: number };
}

interface RouteConfig {
  routeId: string;
  directionId: number;
  stopsIds: string[];
}

interface DestinationConfig {
  name: string;
  routes: RouteConfig[];
}

interface TransitConfig {
  tripUpdateUrl: string;
  pollFrequencySeconds: number;
  stops: StopConfig[];
  destinationCities: DestinationConfig[];
}

// ---------------------------------------------------------------------------
// GTFS types
// ---------------------------------------------------------------------------
interface GtfsTripInfo {
  routeId: string;
  directionId: number;
  serviceId: string;
}

interface GtfsCache {
  trips: Map<string, GtfsTripInfo>;
  stopTimes: Map<string, Map<string, number>>;
  calendar: Map<string, { days: number[]; startDate: number; endDate: number }>;
  calendarAdded: Map<string, Set<string>>;
  calendarRemoved: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------
export interface StopArrival {
  stopId: string;
  nickname: string;
  arrivalEpochSeconds: number;
  comfortableAccessTimeSeconds: { electric: number; bike: number };
  isRealtime: boolean;
}

export interface TripEntry {
  tripId: string;
  routeId: string;
  stops: StopArrival[];
  isRealtime: boolean;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------
function loadConfig(): TransitConfig {
  const cfgPath = path.resolve(__dirname, "../transit-config.json");
  return JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as TransitConfig;
}

function buildStopMap(stops: StopConfig[]): Map<string, StopConfig> {
  return new Map(stops.map((s) => [s.stopId, s]));
}

// ---------------------------------------------------------------------------
// GTFS static data — loaded once from preprocessed JSON at startup
// ---------------------------------------------------------------------------
function loadGtfsData(): GtfsCache {
  const p = path.resolve(__dirname, "../gtfs-preprocessed.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as {
    trips: Record<string, GtfsTripInfo>;
    stopTimes: Record<string, Record<string, number>>;
    calendar: Record<string, { days: number[]; startDate: number; endDate: number }>;
    calendarAdded: Record<string, string[]>;
    calendarRemoved: Record<string, string[]>;
  };

  const trips = new Map<string, GtfsTripInfo>(Object.entries(raw.trips));
  const stopTimes = new Map<string, Map<string, number>>(
    Object.entries(raw.stopTimes).map(([tripId, stops]) => [
      tripId,
      new Map(Object.entries(stops) as [string, number][]),
    ])
  );
  const calendar = new Map<string, { days: number[]; startDate: number; endDate: number }>(
    Object.entries(raw.calendar)
  );
  const calendarAdded = new Map<string, Set<string>>(
    Object.entries(raw.calendarAdded).map(([date, ids]) => [date, new Set(ids)])
  );
  const calendarRemoved = new Map<string, Set<string>>(
    Object.entries(raw.calendarRemoved).map(([date, ids]) => [date, new Set(ids)])
  );

  console.log(`GTFS loaded: ${trips.size} trips, ${stopTimes.size} with stop times`);
  return { trips, stopTimes, calendar, calendarAdded, calendarRemoved };
}

// ---------------------------------------------------------------------------
// Mountain Time helpers
// ---------------------------------------------------------------------------
interface MtDateInfo {
  dateStr: string;       // YYYYMMDD
  midnightEpochSec: number;
}

function getMtDateInfo(date: Date): MtDateInfo {
  const ymd = new Intl.DateTimeFormat("sv", { timeZone: "America/Denver" }).format(date);
  const dateStr = ymd.replace(/-/g, "");

  const noonUTC = new Date(`${ymd}T12:00:00Z`);
  const noonMtHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Denver",
      hour: "numeric",
      hour12: false,
    }).format(noonUTC)
  );
  const offsetHours = 12 - noonMtHour;
  const midnightUTC = new Date(`${ymd}T00:00:00Z`);
  midnightUTC.setTime(midnightUTC.getTime() + offsetHours * 3600 * 1000);

  return { dateStr, midnightEpochSec: Math.floor(midnightUTC.getTime() / 1000) };
}

function getActiveServiceIds(dateStr: string, gtfs: GtfsCache): Set<string> {
  const dateNum = parseInt(dateStr, 10);
  const y = parseInt(dateStr.slice(0, 4));
  const m = parseInt(dateStr.slice(4, 6)) - 1;
  const d = parseInt(dateStr.slice(6, 8));
  const dayOfWeek = new Date(y, m, d).getDay(); // 0=Sun…6=Sat

  const active = new Set<string>();
  for (const [svcId, cal] of gtfs.calendar.entries()) {
    if (dateNum >= cal.startDate && dateNum <= cal.endDate && cal.days[dayOfWeek] === 1) {
      active.add(svcId);
    }
  }
  const removed = gtfs.calendarRemoved.get(dateStr);
  if (removed) for (const s of removed) active.delete(s);
  const added = gtfs.calendarAdded.get(dateStr);
  if (added) for (const s of added) active.add(s);
  return active;
}

// ---------------------------------------------------------------------------
// Core poll: fetch GTFS-RT, merge with static schedule, build output
// ---------------------------------------------------------------------------
async function buildTransitData(
  config: TransitConfig,
  stopMap: Map<string, StopConfig>,
  gtfs: GtfsCache
): Promise<Record<string, TripEntry[]>> {
  const now = new Date();
  const nowEpochSec = now.getTime() / 1000;

  const today = getMtDateInfo(now);
  const yesterday = getMtDateInfo(new Date(now.getTime() - 86400 * 1000));
  const activeToday = getActiveServiceIds(today.dateStr, gtfs);
  const activeYesterday = getActiveServiceIds(yesterday.dateStr, gtfs);

  // ── Build scheduled arrivals ─────────────────────────────────────────────
  const scheduledArrivals = new Map<string, Map<string, number>>();

  for (const [tripId, tripInfo] of gtfs.trips.entries()) {
    const stopTimeCols = gtfs.stopTimes.get(tripId);
    if (!stopTimeCols || stopTimeCols.size === 0) continue;

    let midnightEpoch: number | null = null;
    if (activeToday.has(tripInfo.serviceId)) {
      midnightEpoch = today.midnightEpochSec;
    } else if (activeYesterday.has(tripInfo.serviceId)) {
      const hasCrossMidnight = Array.from(stopTimeCols.values()).some((s) => s >= 86400);
      if (hasCrossMidnight) midnightEpoch = yesterday.midnightEpochSec;
    }
    if (midnightEpoch === null) continue;

    const epochMap = new Map<string, number>();
    for (const [stopId, secsSinceMidnight] of stopTimeCols.entries()) {
      epochMap.set(stopId, midnightEpoch + secsSinceMidnight);
    }
    scheduledArrivals.set(tripId, epochMap);
  }

  // ── Fetch GTFS-RT ────────────────────────────────────────────────────────
  const rtArrivals = new Map<string, {
    stopTimes: Map<string, number>;
    routeId: string;
    directionId: number;
  }>();

  try {
    const response = await axios.get<ArrayBuffer>(config.tripUpdateUrl, {
      responseType: "arraybuffer",
      headers: { "User-Agent": "bus-thing/1.0 (personal transit dashboard)" },
      timeout: 15000,
    });
    const feed = transit_realtime.FeedMessage.decode(new Uint8Array(response.data));

    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu?.trip?.tripId) continue;
      const tripId = tu.trip.tripId;
      const stopTimesMap = new Map<string, number>();

      for (const stu of tu.stopTimeUpdate ?? []) {
        if (!stu.stopId) continue;
        const arrival = stu.arrival ?? stu.departure;
        if (!arrival?.time) continue;
        const t = arrival.time;
        const epochSec = typeof t === "number" ? t : (t as { toNumber(): number }).toNumber();
        stopTimesMap.set(stu.stopId, epochSec);
      }

      if (stopTimesMap.size > 0) {
        const staticInfo = gtfs.trips.get(tripId);
        rtArrivals.set(tripId, {
          stopTimes: stopTimesMap,
          routeId: tu.trip.routeId ?? staticInfo?.routeId ?? "",
          directionId: staticInfo?.directionId ?? (tu.trip.directionId ?? 0),
        });
      }
    }
  } catch (err) {
    console.warn("GTFS-RT fetch failed; using static schedule only", err);
  }

  // ── Merge static + RT ────────────────────────────────────────────────────
  const merged = new Map<string, {
    stopTimes: Map<string, number>;
    routeId: string;
    directionId: number;
    isRealtime: boolean;
  }>();

  for (const [tripId, epochMap] of scheduledArrivals.entries()) {
    const info = gtfs.trips.get(tripId)!;
    merged.set(tripId, {
      stopTimes: new Map(epochMap),
      routeId: info.routeId,
      directionId: info.directionId,
      isRealtime: false,
    });
  }

  for (const [tripId, rt] of rtArrivals.entries()) {
    if (merged.has(tripId)) {
      const entry = merged.get(tripId)!;
      for (const [stopId, epochSec] of rt.stopTimes.entries()) {
        entry.stopTimes.set(stopId, epochSec);
      }
      entry.isRealtime = true;
    } else {
      merged.set(tripId, { ...rt, isRealtime: true });
    }
  }

  // ── Build per-destination output ─────────────────────────────────────────
  const destinationsOutput: Record<string, TripEntry[]> = {};

  for (const dest of config.destinationCities) {
    const tripMap = new Map<string, TripEntry>();

    for (const route of dest.routes) {
      for (const [tripId, entry] of merged.entries()) {
        if (entry.routeId !== route.routeId || entry.directionId !== route.directionId) continue;

        const stops: StopArrival[] = [];
        for (const stopId of route.stopsIds) {
          const arrivalSec = entry.stopTimes.get(stopId);
          if (arrivalSec === undefined) continue;
          const stopCfg = stopMap.get(stopId);
          if (!stopCfg) continue;
          stops.push({
            stopId,
            nickname: stopCfg.nickname,
            arrivalEpochSeconds: arrivalSec,
            comfortableAccessTimeSeconds: stopCfg.comfortableAccessTimeSeconds,
            isRealtime: entry.isRealtime,
          });
        }
        if (stops.length === 0) continue;

        const key = `${route.routeId}:${tripId}`;
        if (!tripMap.has(key)) {
          tripMap.set(key, { tripId, routeId: route.routeId, stops, isRealtime: entry.isRealtime });
        }
      }
    }

    // A trip stays listed until its last configured stop has passed, so a bus that has
    // left the first stop still shows for the next one. Order by the first stop still ahead.
    const isAhead = (s: StopArrival) => s.arrivalEpochSeconds > nowEpochSec - 60;
    const nextArrival = (t: TripEntry) => (t.stops.find(isAhead) ?? t.stops[0]).arrivalEpochSeconds;
    destinationsOutput[dest.name] = Array.from(tripMap.values())
      .filter((t) => t.stops.some(isAhead))
      .sort((a, b) => nextArrival(a) - nextArrival(b));
  }

  return destinationsOutput;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const config = loadConfig();
const stopMap = buildStopMap(config.stops);
const gtfs = loadGtfsData();

const app = express();
const sseClients = new Set<Response>();
let lastResult: Record<string, TripEntry[]> | null = null;
let lastUpdatedAt: string | null = null;

app.use(express.static(path.resolve(__dirname, "../public")));

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  if (lastResult !== null) {
    res.write(`data: ${JSON.stringify({ destinations: forWebPage(lastResult), updatedAt: new Date().toISOString() })}\n\n`);
  }

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// Plain JSON for polling clients (e.g. a LaraPaper/TRMNL recipe). minutesAway and
// leaveInMinutes are precomputed so a Liquid template doesn't need date maths.
const clockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Denver",
  hour: "numeric",
  minute: "2-digit",
});
function clockTime(epochSeconds: number): string {
  // newer ICU puts a narrow no-break space before AM/PM
  return clockFormat.format(new Date(epochSeconds * 1000)).replace(/\u202f/g, " ");
}

app.get("/api/arrivals", (_req, res) => {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const destinations: Record<string, object[]> = {};
  for (const [name, trips] of Object.entries(lastResult ?? {})) {
    const decorated = trips.map((trip) => ({
      ...trip,
      stops: trip.stops.map((stop) => {
        const secondsAway = stop.arrivalEpochSeconds - nowEpochSeconds;
        const access = stop.comfortableAccessTimeSeconds;
        return {
          ...stop,
          minutesAway: Math.round(secondsAway / 60),
          arrivalTime: clockTime(stop.arrivalEpochSeconds),
          // Minutes until you must leave to reach the stop comfortably; negative = too late.
          leaveInMinutes: {
            electric: Math.floor((secondsAway - access.electric) / 60),
            bike: Math.floor((secondsAway - access.bike) / 60),
          },
        };
      }),
    }));
    // nextStop: first stop that hasn't passed; thenStop: the stop after it (if any).
    destinations[name] = decorated
      .map((trip) => {
        const i = trip.stops.findIndex((stop) => stop.minutesAway >= 0);
        return i < 0 ? null : { ...trip, nextStop: trip.stops[i], thenStop: trip.stops[i + 1] ?? null };
      })
      .filter((trip): trip is NonNullable<typeof trip> => trip !== null)
      .sort((a, b) => a.nextStop.arrivalEpochSeconds - b.nextStop.arrivalEpochSeconds);
  }
  res.setHeader("Cache-Control", "no-cache");
  res.json({ destinations, nowEpochSeconds, updatedAt: lastUpdatedAt });
});

// Last day the loaded static GTFS has service. Realtime trips are matched to it by trip_id,
// so once it expires (or RTD publishes a new feed) trips silently go missing.
const gtfsValidThrough = Math.max(0, ...Array.from(gtfs.calendar.values(), (c) => c.endDate));

app.get("/healthz", (_req, res) => {
  const today = parseInt(getMtDateInfo(new Date()).dateStr, 10);
  const scheduleExpired = gtfsValidThrough < today;
  res.status(lastResult === null ? 503 : 200).json({
    ok: lastResult !== null && !scheduleExpired,
    updatedAt: lastUpdatedAt,
    gtfsValidThrough: String(gtfsValidThrough),
    scheduleExpired,
  });
});

// The web page treats stops[0] as the primary stop, so it only gets trips whose first stop
// hasn't left yet (the original behaviour). /api/arrivals uses the full list instead.
function forWebPage(result: Record<string, TripEntry[]>): Record<string, TripEntry[]> {
  const cutoff = Date.now() / 1000 - 60;
  return Object.fromEntries(
    Object.entries(result).map(([name, trips]) => [name, trips.filter((t) => t.stops[0].arrivalEpochSeconds > cutoff)])
  );
}

function broadcast(payload: object): void {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

async function pollAndBroadcast(): Promise<void> {
  try {
    const destinations = await buildTransitData(config, stopMap, gtfs);
    lastResult = destinations;
    lastUpdatedAt = new Date().toISOString();
    if (gtfsValidThrough < parseInt(getMtDateInfo(new Date()).dateStr, 10)) {
      console.warn(`static GTFS expired (valid through ${gtfsValidThrough}); run scripts/update_gtfs.py`);
    }
    broadcast({ destinations: forWebPage(destinations), updatedAt: new Date().toISOString() });
    console.log(
      "poll ok:",
      Object.entries(destinations).map(([k, v]) => `${k}: ${v.length}`).join(", "),
      `| clients: ${sseClients.size}`
    );
  } catch (err) {
    console.error("pollAndBroadcast error:", err);
  }
}

const port = parseInt(process.env.PORT ?? "3000", 10);
const pollMs = (Number.isFinite(config.pollFrequencySeconds) && config.pollFrequencySeconds > 0
  ? config.pollFrequencySeconds
  : 30) * 1000;
app.listen(port, () => {
  console.log(`bus-thing listening on :${port}, polling every ${pollMs / 1000}s`);
  void pollAndBroadcast();
  setInterval(() => void pollAndBroadcast(), pollMs);
});

