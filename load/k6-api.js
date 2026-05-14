// k6 load test for the REST API.
//   k6 run load/k6-api.js                     (defaults: 200 req/s for 30 s)
//   k6 run -e BASE_URL=http://127.0.0.1:23000 -e RATE=400 -e DURATION=60s load/k6-api.js
// Writes a JSON summary to results/k6-api-summary.json.
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:23000";
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || "30s";
const OUT = __ENV.SUMMARY_OUT || "results/k6-api-summary.json";

export const options = {
  discardResponseBodies: false,
  scenarios: {
    api_mix: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<250"],
    "http_req_duration{endpoint:device_trips}": ["p(95)<250"],
    "http_req_duration{endpoint:trip}": ["p(95)<250"],
  },
};

export function setup() {
  const devices = http.get(`${BASE}/api/devices`).json();
  const trips = http.get(`${BASE}/api/trips?limit=1000`).json();
  if (!devices.length || !trips.length) throw new Error("no data: run the simulator first");
  return { deviceIds: devices.map((d) => d.deviceId), tripIds: trips.map((t) => t.id) };
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export default function (data) {
  const r = Math.random();
  let res;
  if (r < 0.1) {
    res = http.get(`${BASE}/api/devices`, { tags: { endpoint: "devices" } });
  } else if (r < 0.5) {
    res = http.get(`${BASE}/api/devices/${pick(data.deviceIds)}/trips?limit=50`, { tags: { endpoint: "device_trips" } });
  } else if (r < 0.8) {
    res = http.get(`${BASE}/api/trips/${pick(data.tripIds)}`, { tags: { endpoint: "trip" } });
  } else if (r < 0.95) {
    res = http.get(`${BASE}/api/trips/${pick(data.tripIds)}/track`, { tags: { endpoint: "trip_track" } });
  } else {
    res = http.get(`${BASE}/api/devices/${pick(data.deviceIds)}`, { tags: { endpoint: "device" } });
  }
  check(res, { "status 200": (x) => x.status === 200 });
}

export function handleSummary(data) {
  const m = data.metrics;
  const summary = {
    measuredAt: new Date().toISOString(),
    baseUrl: BASE,
    offeredRate: RATE,
    duration: DURATION,
    requests: m.http_reqs.values.count,
    throughputRps: m.http_reqs.values.rate,
    failedRate: m.http_req_failed.values.rate,
    latencyMs: {
      avg: m.http_req_duration.values.avg,
      med: m.http_req_duration.values.med,
      p90: m.http_req_duration.values["p(90)"],
      p95: m.http_req_duration.values["p(95)"],
      max: m.http_req_duration.values.max,
    },
    thresholdsPassed: Object.values(m).every((x) => !x.thresholds || Object.values(x.thresholds).every((t) => t.ok)),
  };
  return {
    [OUT]: JSON.stringify(summary, null, 2) + "\n",
    stdout: `\nAPI load: ${summary.requests} requests, ${summary.throughputRps.toFixed(1)} req/s, ` +
      `p95 ${summary.latencyMs.p95.toFixed(1)} ms, failed ${(summary.failedRate * 100).toFixed(2)}%\n`,
  };
}
