import IORedis, { type Redis } from "ioredis";
import { env } from "./env";

const g = globalThis as unknown as { redisQueue?: Redis; redisFast?: Redis };

/** Connection for BullMQ (which requires maxRetriesPerRequest: null and waits for reconnects). */
export function redis(): Redis {
  if (!g.redisQueue) {
    g.redisQueue = new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
    g.redisQueue.on("error", (err) => console.error("[redis] queue connection error:", err.message));
  }
  return g.redisQueue;
}

/**
 * Fail-fast connection for request-path work (rate limiting, health checks): commands
 * error immediately while Redis is unreachable instead of queueing, so callers can fall back.
 */
export function redisFast(): Redis {
  if (!g.redisFast) {
    g.redisFast = new IORedis(env().REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      commandTimeout: 1000,
    });
    g.redisFast.on("error", () => undefined);
  }
  return g.redisFast;
}
