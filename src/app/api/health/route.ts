import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { redisFast } from "@/server/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, redisFast().ping()]);
  const ok = checks.every((c) => c.status === "fulfilled");
  return NextResponse.json(
    { status: ok ? "ok" : "degraded", database: checks[0].status === "fulfilled", redis: checks[1].status === "fulfilled" },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
