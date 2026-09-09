import { readFileSync } from "node:fs";

/**
 * Minimal Kubernetes API client for the in-cluster e2e runner: authenticates with the pod's
 * service-account token (the CA is trusted through NODE_EXTRA_CA_CERTS).
 */
export class Kube {
  private readonly base: string;
  private readonly token: string;

  constructor(
    readonly namespace: string,
    saDir = "/var/run/secrets/kubernetes.io/serviceaccount",
  ) {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
    if (!host) throw new Error("not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST is unset)");
    this.base = `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
    this.token = readFileSync(`${saDir}/token`, "utf8").trim();
  }

  private async call<T>(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": contentType, accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Names of running (not terminating) pods matching a label selector. */
  async pods(selector: string): Promise<{ name: string; ready: boolean }[]> {
    const r = await this.call<{
      items: { metadata: { name: string; deletionTimestamp?: string }; status: { conditions?: { type: string; status: string }[] } }[];
    }>("GET", `/api/v1/namespaces/${this.namespace}/pods?labelSelector=${encodeURIComponent(selector)}`);
    return r.items
      .filter((p) => !p.metadata.deletionTimestamp)
      .map((p) => ({
        name: p.metadata.name,
        ready: (p.status.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
      }));
  }

  /** Deletes a pod; grace period 0 kills it at once (SIGKILL), undefined lets it shut down. */
  async deletePod(name: string, gracePeriodSeconds?: number): Promise<void> {
    await this.call(
      "DELETE",
      `/api/v1/namespaces/${this.namespace}/pods/${name}`,
      gracePeriodSeconds === undefined ? undefined : { gracePeriodSeconds },
    );
  }

  async scaleStatefulSet(name: string, replicas: number): Promise<void> {
    await this.call(
      "PATCH",
      `/apis/apps/v1/namespaces/${this.namespace}/statefulsets/${name}/scale`,
      { spec: { replicas } },
      "application/merge-patch+json",
    );
  }

  async statefulSet(name: string): Promise<{ replicas: number; readyReplicas: number }> {
    const r = await this.call<{ spec: { replicas: number }; status: { readyReplicas?: number } }>(
      "GET",
      `/apis/apps/v1/namespaces/${this.namespace}/statefulsets/${name}`,
    );
    return { replicas: r.spec.replicas, readyReplicas: r.status.readyReplicas ?? 0 };
  }
}
