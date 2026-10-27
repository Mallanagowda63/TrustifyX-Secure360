import { z } from "zod";

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "true" || v === "1"));

const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(min));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Website 1: marketing, signup, pricing, checkout and billing management.
  APP_URL: z.string().url().default("http://localhost:3000"),
  // Website 2: login-only customer security portal (same accounts, database and backend).
  PORTAL_URL: z.string().url().default("http://portal.localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ENCRYPTION_KEY: z.string().optional(),
  SESSION_TTL_HOURS: int(168, 1),
  // Lifetime of sessions created without "remember me" (browser-session cookie).
  SESSION_SHORT_TTL_HOURS: int(12, 1),
  // Waiting period before a self-service two-factor reset (lost authenticator + recovery codes) takes effect.
  MFA_RESET_DELAY_HOURS: int(72, 1),
  ALLOW_SIGNUP: bool(true),
  // Set true only when running behind a reverse proxy (nginx) that sets X-Forwarded-For.
  TRUST_PROXY: bool(false),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587, 1),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default("TrustifyX Secure360 <alerts@localhost>"),

  MONITOR_CONCURRENCY: int(10, 1),
  MONITOR_CONFIG_CONCURRENCY: int(3, 1),
  MONITOR_TIMEOUT_MS: int(10000, 1000),
  MONITOR_MAX_REDIRECTS: int(5, 0),
  MONITOR_DOWN_THRESHOLD: int(2, 1),
  MONITOR_MANUAL_SCAN_COOLDOWN_SEC: int(120, 0),
  MONITOR_MIN_INTERVAL_SEC: int(60, 30),
  MAX_WEBSITES_PER_ORG: int(25, 1),
  DNS_SERVERS: z.string().optional(),
  // Only for local development/testing against non-public targets. Never enable in production.
  MONITOR_ALLOW_PRIVATE_TARGETS: bool(false),

  // ─── Billing (Razorpay) ───
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // recurring = Razorpay Subscriptions (auto-renew); prepaid = one-time Orders, renewed manually.
  BILLING_MODE: z.enum(["recurring", "prepaid"]).default("recurring"),
  BILLING_ANNUAL_ENABLED: bool(false),
  // GST in basis points (1800 = 18%). Displayed prices exclude tax unless BILLING_PRICES_INCLUDE_TAX.
  BILLING_TAX_RATE_BP: int(1800, 0),
  BILLING_PRICES_INCLUDE_TAX: bool(false),
  BILLING_GRACE_DAYS: int(7, 0),
  BILLING_PENDING_EXPIRY_HOURS: int(24, 1),
  BILLING_SELLER_NAME: z.string().default("TrustifyX Private Limited"),
  BILLING_SELLER_ADDRESS: z.string().optional(),
  BILLING_SELLER_GSTIN: z.string().optional(),
  SUPPORT_EMAIL: z.string().default("support@trustifyx.com"),
  SECURITY_EMAIL: z.string().default("security@trustifyx.com"),

  // Tests/local fakes only; ignored in production, where api.cloudflare.com is always used.
  CLOUDFLARE_API_BASE: z.string().url().optional(),
  // Imported Cloudflare security events older than this are deleted.
  SECURITY_EVENT_RETENTION_DAYS: int(90, 1),

  // ─── Server security (TrustifyX-operated Wazuh manager; keep its API and indexer on a private network) ───
  WAZUH_API_URL: z.string().url().optional(), // e.g. https://10.0.0.5:55000
  WAZUH_API_USER: z.string().optional(),
  WAZUH_API_PASSWORD: z.string().optional(),
  WAZUH_INDEXER_URL: z.string().url().optional(), // e.g. https://10.0.0.5:9200
  WAZUH_INDEXER_USER: z.string().optional(),
  WAZUH_INDEXER_PASSWORD: z.string().optional(),
  // PEM file of the CA that signed the manager/indexer certificates (TLS is always verified).
  WAZUH_CA_FILE: z.string().optional(),
  // Public address agents connect to (port 1514/TCP).
  WAZUH_MANAGER_ADDRESS: z.string().optional(),
  WAZUH_ALERTS_INDEX: z.string().default("wazuh-alerts-*"),

  AI_PROVIDER: z.enum(["anthropic", "openai", "none"]).default("none"),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated environment. Parsed lazily so `next build` does not need runtime secrets. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment configuration: ${issues}`);
    }
    if (parsed.data.NODE_ENV === "production" && parsed.data.MONITOR_ALLOW_PRIVATE_TARGETS) {
      throw new Error("MONITOR_ALLOW_PRIVATE_TARGETS must not be enabled in production");
    }
    // Both websites share one session-cookie policy (secure flag derives from APP_URL) and are told apart by host.
    const marketing = new URL(parsed.data.APP_URL);
    const portal = new URL(parsed.data.PORTAL_URL);
    if (marketing.host === portal.host) throw new Error("APP_URL and PORTAL_URL must use different hostnames");
    if (marketing.protocol !== portal.protocol) throw new Error("APP_URL and PORTAL_URL must both use https (or both http locally)");
    cached = parsed.data;
  }
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
