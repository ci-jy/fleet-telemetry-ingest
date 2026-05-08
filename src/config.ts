import { DEFAULT_TRIP_CONFIG, type TripConfig } from "./domain/tripStateMachine.js";

export interface AppConfig {
  mqttUrl: string;
  mqttTopic: string;
  databaseUrl: string;
  httpHost: string;
  httpPort: number;
  trip: TripConfig;
  reorderWindowMs: number;
  batchMaxSize: number;
  batchMaxDelayMs: number;
  staleFlushMs: number;
  webDist: string | null;
}

const num = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got ${v}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    mqttUrl: env.MQTT_URL ?? "mqtt://127.0.0.1:21883",
    mqttTopic: env.MQTT_TOPIC ?? "fleet/+/telemetry",
    databaseUrl: env.DATABASE_URL ?? "postgres://fleet:fleet@127.0.0.1:25432/fleet",
    httpHost: env.HOST ?? "127.0.0.1",
    httpPort: num(env, "PORT", 23000),
    trip: {
      movingKph: num(env, "TRIP_MOVING_KPH", DEFAULT_TRIP_CONFIG.movingKph),
      gapMs: num(env, "TRIP_GAP_MS", DEFAULT_TRIP_CONFIG.gapMs),
      minIdleMs: num(env, "TRIP_MIN_IDLE_MS", DEFAULT_TRIP_CONFIG.minIdleMs),
      maxIdleMs: num(env, "TRIP_MAX_IDLE_MS", DEFAULT_TRIP_CONFIG.maxIdleMs),
    },
    reorderWindowMs: num(env, "REORDER_WINDOW_MS", 30_000),
    batchMaxSize: num(env, "BATCH_MAX_SIZE", 1000),
    batchMaxDelayMs: num(env, "BATCH_MAX_DELAY_MS", 20),
    staleFlushMs: num(env, "STALE_FLUSH_MS", 15_000),
    webDist: env.WEB_DIST === "" ? null : (env.WEB_DIST ?? "web/dist"),
  };
}
