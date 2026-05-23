import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

let dockerPrefix: string[] | null = null;

/**
 * The docker CLI to use: `docker` when the daemon is reachable directly (CI runners, users in the
 * docker group), otherwise `sudo -n docker`. `CHAOS_DOCKER="sudo docker"` overrides the choice.
 */
export async function dockerCommand(): Promise<string[]> {
  if (dockerPrefix) return dockerPrefix;
  const override = process.env.CHAOS_DOCKER;
  if (override) return (dockerPrefix = override.split(/\s+/).filter(Boolean));
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
    dockerPrefix = ["docker"];
  } catch {
    await run("sudo", ["-n", "docker", "info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
    dockerPrefix = ["sudo", "-n", "docker"];
  }
  return dockerPrefix;
}

export async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  const [cmd, ...pre] = await dockerCommand();
  try {
    const { stdout } = await run(cmd!, [...pre, ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`docker ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`);
  }
}

export const COMPOSE_FILE = "docker-compose.chaos.yml";
export const COMPOSE_PROJECT = "fleet-chaos";

export const compose = (args: string[], timeoutMs = 600_000): Promise<string> =>
  docker(["compose", "-f", COMPOSE_FILE, "-p", COMPOSE_PROJECT, ...args], timeoutMs);

export type ServiceName = "mosquitto" | "postgres" | "toxiproxy" | "ingest";

/** Container id of a compose service (including stopped ones). */
export async function containerId(service: ServiceName): Promise<string> {
  const id = (await compose(["ps", "-a", "-q", service])).split("\n")[0];
  if (!id) throw new Error(`no container for service ${service}`);
  return id;
}

export async function containerState(service: ServiceName): Promise<{ running: boolean; exitCode: number }> {
  const out = await docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", await containerId(service)]);
  const [running, code] = out.split(" ");
  return { running: running === "true", exitCode: Number(code) };
}

export const kill = async (service: ServiceName, signal = "KILL"): Promise<void> => {
  await docker(["kill", "-s", signal, await containerId(service)]);
};
export const start = async (service: ServiceName): Promise<void> => {
  await docker(["start", await containerId(service)]);
};
export const stop = async (service: ServiceName, graceS = 20): Promise<void> => {
  await docker(["stop", "-t", String(graceS), await containerId(service)], (graceS + 30) * 1000);
};
export const restart = async (service: ServiceName, graceS = 10): Promise<void> => {
  await docker(["restart", "-t", String(graceS), await containerId(service)], (graceS + 60) * 1000);
};
export const logs = async (service: ServiceName, tail = 200): Promise<string> =>
  docker(["logs", "--tail", String(tail), await containerId(service)]).catch((e: Error) => e.message);
