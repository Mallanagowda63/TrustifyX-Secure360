import { authedRoute } from "@/server/api";
import { getScan } from "@/server/scanning/service";

export const GET = authedRoute<{ id: string }>("scan.read", async ({ ctx, params }) => {
  const scan = await getScan(ctx.org.id, params.id);
  // The stored authorization statement is shown; internal job stats are summarised only.
  return { scan };
});
