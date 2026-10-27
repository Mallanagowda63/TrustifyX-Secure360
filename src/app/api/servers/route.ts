import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { registerServer, serverOverview } from "@/server/servers/service";

export const GET = authedRoute("server.read", async ({ ctx }) => serverOverview(ctx.org.id));

const body = z.object({
  displayName: z.string().min(1).max(80),
  environment: z.enum(["VPS", "DEDICATED", "CLOUD_VM", "SHARED_HOSTING"]),
  os: z.enum(["LINUX_DEB", "LINUX_RPM", "WINDOWS", "MACOS"]),
});

/** Registers a server with the TrustifyX Wazuh manager and returns the install steps (key shown until first connect). */
export const POST = authedRoute("server.manage", async ({ req, ctx }) => {
  const input = await readJson(req, body);
  const r = await registerServer(actorOf(ctx), input);
  return { server: { id: r.server.id, status: r.server.status }, compatible: r.compatible, install: "install" in r ? r.install : null };
});
