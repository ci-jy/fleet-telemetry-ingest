import type { Db } from "./db.js";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  device_id      text PRIMARY KEY,
  state          text NOT NULL,
  last_seq       bigint,
  last_ts        timestamptz,
  last_lat       double precision,
  last_lon       double precision,
  last_speed_kph real,
  last_ignition  boolean,
  open_trip      jsonb,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Raw track. (device_id, seq) is the idempotency key: redelivered messages are ignored.
CREATE TABLE IF NOT EXISTS points (
  device_id   text NOT NULL,
  seq         bigint NOT NULL,
  ts          timestamptz NOT NULL,
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  speed_kph   real NOT NULL,
  ignition    boolean NOT NULL,
  -- true when the message arrived after the reorder buffer had moved past it,
  -- so it is part of the track but was not applied to the state machine
  late        boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL,
  stored_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (device_id, seq)
);
CREATE INDEX IF NOT EXISTS points_device_ts_idx ON points (device_id, ts);

CREATE TABLE IF NOT EXISTS trips (
  id            bigserial PRIMARY KEY,
  device_id     text NOT NULL,
  start_seq     bigint NOT NULL,
  end_seq       bigint NOT NULL,
  start_ts      timestamptz NOT NULL,
  end_ts        timestamptz NOT NULL,
  start_lat     double precision NOT NULL,
  start_lon     double precision NOT NULL,
  end_lat       double precision NOT NULL,
  end_lon       double precision NOT NULL,
  distance_m    double precision NOT NULL,
  duration_s    double precision NOT NULL,
  idle_s        double precision NOT NULL,
  point_count   integer NOT NULL,
  max_speed_kph real NOT NULL,
  end_reason    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, start_seq)
);
CREATE INDEX IF NOT EXISTS trips_device_start_idx ON trips (device_id, start_ts DESC);

CREATE TABLE IF NOT EXISTS idle_segments (
  id         bigserial PRIMARY KEY,
  trip_id    bigint NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  device_id  text NOT NULL,
  start_seq  bigint NOT NULL,
  start_ts   timestamptz NOT NULL,
  end_ts     timestamptz NOT NULL,
  duration_s double precision NOT NULL,
  UNIQUE (device_id, start_seq)
);
CREATE INDEX IF NOT EXISTS idle_segments_trip_idx ON idle_segments (trip_id);
`;

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA_SQL);
}
