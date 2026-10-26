import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import type { OrgRole } from "@prisma/client";
import { env } from "./env";
import { can, type Permission } from "./auth/rbac";
import { resolveSession, sessionCookieName, type SessionContext } from "./auth/session";
import { safeEqual } from "./security/crypto";
import { rateLimit } from "./security/rate-limit";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new ApiError(404, `${what} not found`, "not_found");
export const forbidden = () => new ApiError(403, "You do not have permission to perform this action", "forbidden");

export function clientIp(req: NextRequest): string {
  if (env().TRUST_PROXY) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim().slice(0, 64);
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim().slice(0, 64);
  }
  return "direct";
}

export interface AuthedContext extends SessionContext {
  org: NonNullable<SessionContext["org"]>;
  role: OrgRole;
  ip: string;
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readJson<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new ApiError(413, "Request body too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, "Request body too large");
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(400, "Malformed JSON body");
    }
  }
  return schema.parse(data);
}

function isSafeMethod(method: string) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/** Origin check for state-changing requests (OWASP CSRF cheat sheet: verify origin). */
function checkOrigin(req: NextRequest) {
  const expected = new URL(env().APP_URL).origin;
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (origin) {
    if (origin !== expected) throw new ApiError(403, "Cross-origin request blocked", "csrf");
    return;
  }
  if (fetchSite && fetchSite !== "same-origin") throw new ApiError(403, "Cross-site request blocked", "csrf");
  if (!fetchSite) {
    // Neither Origin nor Fetch Metadata: only accept when the custom CSRF header is present (checked later).
    if (!req.headers.get("x-csrf-token")) throw new ApiError(403, "Missing origin", "csrf");
  }
}

type RouteParams = Record<string, string>;

interface PublicArgs<P> {
  req: NextRequest;
  params: P;
  ip: string;
  session: SessionContext | null;
}
interface AuthedArgs<P> {
  req: NextRequest;
  params: P;
  ctx: AuthedContext;
}

function toResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  return NextResponse.json(result ?? { ok: true });
}

function handleError(err: unknown): Response {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: "Validation failed",
        code: "validation",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }
  console.error("[api] unhandled error", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

function withNoStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** Route that may be called without a session (login, signup, invitation accept). */
export function publicRoute<P extends RouteParams = RouteParams>(
  fn: (args: PublicArgs<P>) => Promise<unknown>,
  opts: { rateLimit?: { key: string; limit: number; windowSec: number } } = {},
) {
  return async (req: NextRequest, routeCtx: { params: Promise<P> }) => {
    try {
      if (!isSafeMethod(req.method)) checkOrigin(req);
      const ip = clientIp(req);
      if (opts.rateLimit) {
        const rl = await rateLimit(`${opts.rateLimit.key}:ip:${ip}`, opts.rateLimit.limit, opts.rateLimit.windowSec);
        if (!rl.allowed) {
          return withNoStore(
            NextResponse.json(
              { error: "Too many requests. Please try again later.", code: "rate_limited" },
              { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
            ),
          );
        }
      }
      const session = await resolveSession(req.cookies.get(sessionCookieName())?.value);
      const params = (await routeCtx?.params) ?? ({} as P);
      return withNoStore(toResponse(await fn({ req, params, ip, session })));
    } catch (err) {
      return withNoStore(handleError(err));
    }
  };
}

/** Authenticated, org-scoped route. `permission` is checked against the caller's role in the active org. */
export function authedRoute<P extends RouteParams = RouteParams>(
  permission: Permission | null,
  fn: (args: AuthedArgs<P>) => Promise<unknown>,
) {
  return async (req: NextRequest, routeCtx: { params: Promise<P> }) => {
    try {
      const unsafe = !isSafeMethod(req.method);
      if (unsafe) checkOrigin(req);
      const s = await resolveSession(req.cookies.get(sessionCookieName())?.value);
      if (!s) throw new ApiError(401, "Authentication required", "unauthenticated");
      if (unsafe) {
        const header = req.headers.get("x-csrf-token") ?? "";
        if (!header || !safeEqual(header, s.session.csrfToken)) {
          throw new ApiError(403, "Invalid CSRF token", "csrf");
        }
      }
      if (!s.org || !s.role) throw new ApiError(403, "You are not a member of any organization", "no_org");
      if (permission && !can(s.role, permission)) throw forbidden();
      const ctx: AuthedContext = { ...s, org: s.org, role: s.role, ip: clientIp(req) };
      const params = (await routeCtx?.params) ?? ({} as P);
      return withNoStore(toResponse(await fn({ req, params, ctx })));
    } catch (err) {
      return withNoStore(handleError(err));
    }
  };
}

/** Converts the request context into the service-layer actor (tenant + role come only from the session). */
export function actorOf(ctx: AuthedContext) {
  return { userId: ctx.user.id, orgId: ctx.org.id, role: ctx.role, ip: ctx.ip };
}

/**
 * TrustifyX platform-operator route: requires a signed-in user with isPlatformAdmin and the
 * same CSRF/origin protections as other state-changing routes.
 */
export function adminRoute<P extends RouteParams = RouteParams>(fn: (args: { req: NextRequest; params: P; ctx: SessionContext & { ip: string } }) => Promise<unknown>) {
  return async (req: NextRequest, routeCtx: { params: Promise<P> }) => {
    try {
      const unsafe = !isSafeMethod(req.method);
      if (unsafe) checkOrigin(req);
      const s = await resolveSession(req.cookies.get(sessionCookieName())?.value);
      if (!s) throw new ApiError(401, "Authentication required", "unauthenticated");
      if (unsafe) {
        const header = req.headers.get("x-csrf-token") ?? "";
        if (!header || !safeEqual(header, s.session.csrfToken)) throw new ApiError(403, "Invalid CSRF token", "csrf");
      }
      if (!s.user.isPlatformAdmin) throw new ApiError(403, "Platform administrator access required", "forbidden");
      const params = (await routeCtx?.params) ?? ({} as P);
      return withNoStore(toResponse(await fn({ req, params, ctx: { ...s, ip: clientIp(req) } })));
    } catch (err) {
      return withNoStore(handleError(err));
    }
  };
}
