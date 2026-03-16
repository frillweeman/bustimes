import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StopConfig {
  stopId: string;
}

interface RouteConfig {
  routeId: string;
  directionId: number;
  stopsIds: string[];
}

interface TransitConfig {
  stops: StopConfig[];
  destinationCities: Array<{ routes: RouteConfig[] }>;
}

interface GtfsTripInfo {
  routeId: string;
  directionId: number;
  serviceId: string;
}

interface PreprocessedGtfs {
  trips: Record<string, GtfsTripInfo>;
  stopTimes: Record<string, Record<string, number>>;
  calendar: Record<string, { days: number[]; startDate: number; endDate: number }>;
  calendarAdded: Record<string, string[]>;
  calendarRemoved: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractZipEntry(zipPath: string, entryName: string): string {
  return execSync(`unzip -p "${zipPath}" "${entryName}"`, {
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf-8");
}

function extractStopTimesForStops(zipPath: string, stopIds: Set<string>): string {
  const conditions = Array.from(stopIds).map((id) => `$4=="${id}"`).join("||");
  return execSync(
    `unzip -p "${zipPath}" stop_times.txt | awk -F',' 'NR==1||${conditions}'`,
    { maxBuffer: 10 * 1024 * 1024 }
  ).toString("utf-8");
}

function parseCsvLines(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split("\n");
  const headers = lines[0].replace(/\r$/, "").split(",");
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line) rows.push(line.split(","));
  }
  return { headers, rows };
}

function col(headers: string[], name: string): number {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error(`GTFS column not found: ${name}`);
  return idx;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const cfgPath = path.resolve(__dirname, "../transit-config.json");
const zipPath = path.resolve(__dirname, "../google_transit.zip");
const outPath = path.resolve(__dirname, "../gtfs-preprocessed.json");

// ---------------------------------------------------------------------------
// Load config and collect relevant IDs
// ---------------------------------------------------------------------------
const config = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as TransitConfig;

const relevantRouteIds = new Set<string>();
const relevantStopIds = new Set<string>();
const routeDirections = new Map<string, Set<number>>();

for (const dest of config.destinationCities) {
  for (const route of dest.routes) {
    relevantRouteIds.add(route.routeId);
    for (const s of route.stopsIds) relevantStopIds.add(s);
    if (!routeDirections.has(route.routeId)) routeDirections.set(route.routeId, new Set());
    routeDirections.get(route.routeId)!.add(route.directionId);
  }
}

// ---------------------------------------------------------------------------
// trips.txt
// ---------------------------------------------------------------------------
const tripsText = extractZipEntry(zipPath, "trips.txt");
const { headers: th, rows: tripsRows } = parseCsvLines(tripsText);
const tRouteId = col(th, "route_id");
const tServiceId = col(th, "service_id");
const tTripId = col(th, "trip_id");
const tDirId = col(th, "direction_id");

const trips: Record<string, GtfsTripInfo> = {};
for (const row of tripsRows) {
  const routeId = row[tRouteId];
  if (!relevantRouteIds.has(routeId)) continue;
  const directionId = parseInt(row[tDirId] ?? "0", 10);
  if (!routeDirections.get(routeId)?.has(directionId)) continue;
  trips[row[tTripId]] = { routeId, directionId, serviceId: row[tServiceId] };
}

// ---------------------------------------------------------------------------
// stop_times.txt (pre-filtered via awk to our stop IDs)
// ---------------------------------------------------------------------------
const stText = extractStopTimesForStops(zipPath, relevantStopIds);
const { headers: sh, rows: stRows } = parseCsvLines(stText);
const sTripId = col(sh, "trip_id");
const sArrival = col(sh, "arrival_time");
const sStopId = col(sh, "stop_id");

const stopTimes: Record<string, Record<string, number>> = {};
for (const row of stRows) {
  const tripId = row[sTripId];
  if (!trips[tripId]) continue;
  const arrStr = row[sArrival];
  if (!arrStr || !arrStr.includes(":")) continue;
  const [h, m, s] = arrStr.split(":").map(Number);
  const secs = h * 3600 + m * 60 + (s || 0);
  if (!stopTimes[tripId]) stopTimes[tripId] = {};
  stopTimes[tripId][row[sStopId]] = secs;
}

// ---------------------------------------------------------------------------
// calendar.txt
// ---------------------------------------------------------------------------
const calText = extractZipEntry(zipPath, "calendar.txt");
const { headers: ch, rows: calRows } = parseCsvLines(calText);
const cSvcId = col(ch, "service_id");
const dayCols = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
  .map((d) => col(ch, d));
const cStart = col(ch, "start_date");
const cEnd = col(ch, "end_date");

const calendar: Record<string, { days: number[]; startDate: number; endDate: number }> = {};
for (const row of calRows) {
  if (!row[cSvcId]) continue;
  calendar[row[cSvcId]] = {
    days: dayCols.map((i) => Number(row[i])),
    startDate: parseInt(row[cStart], 10),
    endDate: parseInt(row[cEnd], 10),
  };
}

// ---------------------------------------------------------------------------
// calendar_dates.txt
// ---------------------------------------------------------------------------
const cdText = extractZipEntry(zipPath, "calendar_dates.txt");
const { headers: cdh, rows: cdRows } = parseCsvLines(cdText);
const cdSvcId = col(cdh, "service_id");
const cdDate = col(cdh, "date");
const cdExType = col(cdh, "exception_type");

const calendarAdded: Record<string, string[]> = {};
const calendarRemoved: Record<string, string[]> = {};
for (const row of cdRows) {
  const svcId = row[cdSvcId];
  const date = row[cdDate];
  if (!svcId || !date) continue;
  const exType = row[cdExType]?.trim();
  if (exType === "1") {
    if (!calendarAdded[date]) calendarAdded[date] = [];
    calendarAdded[date].push(svcId);
  } else if (exType === "2") {
    if (!calendarRemoved[date]) calendarRemoved[date] = [];
    calendarRemoved[date].push(svcId);
  }
}

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------
const output: PreprocessedGtfs = { trips, stopTimes, calendar, calendarAdded, calendarRemoved };
fs.writeFileSync(outPath, JSON.stringify(output));

const tripCount = Object.keys(trips).length;
const stopTimeCount = Object.keys(stopTimes).length;
console.log(
  `GTFS preprocessed: ${tripCount} relevant trips, ${stopTimeCount} with stop times → gtfs-preprocessed.json`
);
