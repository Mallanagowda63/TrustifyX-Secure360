import { authedRoute } from "@/server/api";
import { aiProvider } from "@/server/ai/provider";

export const GET = authedRoute(null, async () => {
  const p = aiProvider();
  return { enabled: Boolean(p), provider: p?.name ?? null, model: p?.model ?? null };
});
