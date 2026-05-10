export interface Device {
  deviceId: string;
  state: "parked" | "moving" | "idle" | "trip_ended";
  lastTs: string | null;
  lastPosition: { lat: number; lon: number } | null;
  lastSpeedKph: number | null;
  ignition: boolean | null;
  openTrip: { startTs: string; distanceM: number } | null;
  tripCount: number;
  totalDistanceKm: number;
}

export interface Trip {
  id: number;
  deviceId: string;
  startTs: string;
  endTs: string;
  distanceKm: number;
  durationS: number;
  idleS: number;
  movingS: number;
  avgSpeedKph: number;
  maxSpeedKph: number;
  pointCount: number;
  endReason: string;
}

export interface TrackPoint {
  seq: number;
  lat: number;
  lon: number;
  speedKph: number;
  late: boolean;
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export const fetchDevices = () => get<Device[]>("/api/devices");
export const fetchTrips = (deviceId: string) => get<Trip[]>(`/api/devices/${encodeURIComponent(deviceId)}/trips?limit=200`);
export const fetchTripTrack = (tripId: number) => get<TrackPoint[]>(`/api/trips/${tripId}/track?includeLate=false`);
