import { useCallback, useEffect, useState } from "react";
import { fetchDevices, fetchTripTrack, fetchTrips, type Device, type TrackPoint, type Trip } from "./api";

const fmtDuration = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${sec}s`;
};
const fmtTime = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "–");

export function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [track, setTrack] = useState<TrackPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadDevices = useCallback(() => {
    fetchDevices()
      .then((d) => {
        setDevices(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    loadDevices();
    const t = setInterval(loadDevices, 5000);
    return () => clearInterval(t);
  }, [loadDevices]);

  useEffect(() => {
    setTrip(null);
    setTrack([]);
    if (!selected) return;
    fetchTrips(selected)
      .then(setTrips)
      .catch((e: Error) => setError(e.message));
  }, [selected]);

  useEffect(() => {
    if (!trip) return;
    fetchTripTrack(trip.id)
      .then(setTrack)
      .catch((e: Error) => setError(e.message));
  }, [trip]);

  return (
    <main>
      <header>
        <h1>Fleet telemetry</h1>
        <span className="muted">{devices.length} devices · refreshes every 5 s</span>
      </header>
      {error && <p className="error">{error}</p>}
      <div className="layout">
        <section>
          <h2>Devices</h2>
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>State</th>
                <th>Last seen</th>
                <th className="num">Trips</th>
                <th className="num">km</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr
                  key={d.deviceId}
                  className={d.deviceId === selected ? "selected" : undefined}
                  onClick={() => setSelected(d.deviceId)}
                >
                  <td>{d.deviceId}</td>
                  <td>
                    <span className={`badge ${d.state}`}>{d.state.replace("_", " ")}</span>
                  </td>
                  <td>{fmtTime(d.lastTs)}</td>
                  <td className="num">{d.tripCount}</td>
                  <td className="num">{d.totalDistanceKm.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h2>{selected ? `Trips of ${selected}` : "Select a device"}</h2>
          {selected && (
            <table>
              <thead>
                <tr>
                  <th>Start</th>
                  <th className="num">km</th>
                  <th className="num">Duration</th>
                  <th className="num">Idle</th>
                  <th className="num">Avg km/h</th>
                  <th>End</th>
                </tr>
              </thead>
              <tbody>
                {trips.map((t) => (
                  <tr key={t.id} className={trip?.id === t.id ? "selected" : undefined} onClick={() => setTrip(t)}>
                    <td>{fmtTime(t.startTs)}</td>
                    <td className="num">{t.distanceKm.toFixed(2)}</td>
                    <td className="num">{fmtDuration(t.durationS)}</td>
                    <td className="num">{fmtDuration(t.idleS)}</td>
                    <td className="num">{t.avgSpeedKph}</td>
                    <td>{t.endReason.replace("_", " ")}</td>
                  </tr>
                ))}
                {trips.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No completed trips yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {trip && <TrackView points={track} />}
        </section>
      </div>
    </main>
  );
}

/** Plain SVG plot of the trip's raw track (equirectangular, no map tiles). */
function TrackView({ points }: { points: TrackPoint[] }) {
  if (points.length < 2) return <p className="muted">Loading track…</p>;
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const w = Math.max((maxLon - minLon) * kx, 1e-9);
  const h = Math.max(maxLat - minLat, 1e-9);
  const scale = 380 / Math.max(w, h);
  const xy = (p: TrackPoint) => [10 + (p.lon - minLon) * kx * scale, 10 + (maxLat - p.lat) * scale] as const;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${xy(p)[0].toFixed(1)},${xy(p)[1].toFixed(1)}`).join(" ");
  const [sx, sy] = xy(points[0]!);
  const [ex, ey] = xy(points[points.length - 1]!);
  return (
    <figure>
      <svg viewBox={`0 0 ${w * scale + 20} ${h * scale + 20}`} className="track">
        <path d={path} fill="none" stroke="#2563eb" strokeWidth={2} />
        {points
          .filter((p) => p.speedKph < 3)
          .map((p) => {
            const [x, y] = xy(p);
            return <circle key={p.seq} cx={x} cy={y} r={2.5} fill="#f59e0b" />;
          })}
        <circle cx={sx} cy={sy} r={5} fill="#16a34a" />
        <circle cx={ex} cy={ey} r={5} fill="#dc2626" />
      </svg>
      <figcaption className="muted">
        {points.length} points · green start, red end, amber stationary
      </figcaption>
    </figure>
  );
}
