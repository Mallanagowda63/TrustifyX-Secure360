import { authedRoute } from "@/server/api";
import { protectionOverview } from "@/server/protection/service";

export const GET = authedRoute("protection.read", async ({ ctx }) => protectionOverview(ctx.org.id));
