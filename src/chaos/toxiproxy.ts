/** Minimal client for the Toxiproxy HTTP API (https://github.com/Shopify/toxiproxy). */
export interface Toxic {
  name: string;
  type: "latency" | "timeout" | "bandwidth" | "slow_close" | "reset_peer" | "limit_data" | "slicer";
  stream: "upstream" | "downstream";
  toxicity?: number;
  attributes: Record<string, number>;
}

export class Toxiproxy {
  constructor(readonly url = process.env.TOXIPROXY_URL ?? "http://127.0.0.1:28474") {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`toxiproxy ${method} ${path}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Removes every toxic and re-enables every proxy. */
  reset(): Promise<unknown> {
    return this.call("POST", "/reset");
  }

  proxies(): Promise<Record<string, { enabled: boolean; listen: string; upstream: string }>> {
    return this.call("GET", "/proxies") as Promise<Record<string, { enabled: boolean; listen: string; upstream: string }>>;
  }

  addToxic(proxy: string, toxic: Toxic): Promise<unknown> {
    return this.call("POST", `/proxies/${proxy}/toxics`, { toxicity: 1, ...toxic });
  }

  removeToxic(proxy: string, name: string): Promise<unknown> {
    return this.call("DELETE", `/proxies/${proxy}/toxics/${name}`);
  }
}
