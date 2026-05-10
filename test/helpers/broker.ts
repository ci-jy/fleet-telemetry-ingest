import { createServer, type Server } from "node:net";
import { Aedes } from "aedes";

/** In-process MQTT broker for tests, listening on a port in 20000–29999. */
export async function startBroker(): Promise<{ url: string; close: () => Promise<void> }> {
  const broker = await Aedes.createBroker();
  const server: Server = createServer(broker.handle);
  let port = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 20000 + Math.floor(Math.random() * 10000);
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error("no free port for test broker");
  return {
    url: `mqtt://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        broker.close(() => server.close(() => resolve()));
      }),
  };
}
