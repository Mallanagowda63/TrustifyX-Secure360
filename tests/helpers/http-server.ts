import http from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, base: string) => void;

/** Starts a throwaway HTTP server on 127.0.0.1 with a random port. */
export async function startServer(routes: Record<string, Handler>) {
  let base = "";
  const seen: Array<{ path: string; host: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    seen.push({ path, host: req.headers.host });
    const h = routes[path];
    if (h) h(req, res, base);
    else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  return {
    base,
    port: String(port),
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const redirect = (location: string, status = 302): Handler => (_req, res) => {
  res.statusCode = status;
  res.setHeader("Location", location);
  res.end();
};

export const text = (body: string, status = 200, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
};

/** Treats only the loopback test server as "public"; everything else falls back to real rules. */
export const loopbackOnlyPolicy = (ip: string) => ip === "127.0.0.1";
