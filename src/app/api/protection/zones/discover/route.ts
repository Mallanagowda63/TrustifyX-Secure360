import { actorOf, authedRoute } from "@/server/api";
import { discoverZones } from "@/server/protection/service";

export const GET = authedRoute("protection.read", async ({ ctx }) => discoverZones(actorOf(ctx)));
