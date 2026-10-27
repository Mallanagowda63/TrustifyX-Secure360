/**
 * Protection features Secure360 can configure on a customer's Cloudflare zone, with the plan
 * limits Cloudflare documents. Pure definitions (no I/O) so they can be unit tested.
 *
 * Sources (checked 2026-10):
 *  - Custom rules per plan (Free 5, Pro 20, Business 100, Enterprise 1,000); "log" action Enterprise only:
 *    https://developers.cloudflare.com/waf/custom-rules/
 *  - Managed rulesets per plan (Free Managed Ruleset: all plans; Cloudflare Managed and OWASP Core: Pro+):
 *    https://developers.cloudflare.com/waf/managed-rules/
 *  - Bot Fight Mode (free product for Free plans): https://developers.cloudflare.com/bots/get-started/bot-fight-mode/
 *  - HTTP DDoS protection is always enabled on all plans for proxied traffic:
 *    https://developers.cloudflare.com/ddos-protection/managed-rulesets/http/
 */

export type CfPlan = "free" | "pro" | "business" | "enterprise" | "unknown";

export function normalizePlan(legacyId?: string | null, name?: string | null): CfPlan {
  const v = (legacyId ?? name ?? "").toLowerCase();
  if (v.includes("enterprise")) return "enterprise";
  if (v.includes("business")) return "business";
  if (v.includes("pro")) return "pro";
  if (v.includes("free")) return "free";
  return "unknown";
}

const PLAN_RANK: Record<CfPlan, number> = { unknown: -1, free: 0, pro: 1, business: 2, enterprise: 3 };
export const planAtLeast = (plan: CfPlan, min: CfPlan) => PLAN_RANK[plan] >= PLAN_RANK[min];

export const CUSTOM_RULE_LIMIT: Record<CfPlan, number> = { free: 5, pro: 20, business: 100, enterprise: 1000, unknown: 5 };

export const PHASE_CUSTOM = "http_request_firewall_custom";
export const PHASE_MANAGED = "http_request_firewall_managed";
export const MANAGED_RULESET_NAME = "Cloudflare Managed Ruleset";
/** Published ID of the Cloudflare Managed Ruleset (https://developers.cloudflare.com/waf/managed-rules/deploy-api/). */
export const MANAGED_RULESET_ID = "efb7b8c949ac4650a09736fc376e9aee";
/** Every TrustifyX-created rule starts with this, so customers can recognise it in Cloudflare. */
export const RULE_PREFIX = "[TrustifyX Secure360]";

export type Capability = "settings" | "bots" | "waf" | "managed";

interface Base {
  key: string;
  label: string;
  description: string;
  /** Minimum Cloudflare plan. */
  minPlan: CfPlan;
  /** Only offered on these plans (e.g. Bot Fight Mode on Free; Pro+ use Super Bot Fight Mode instead). */
  onlyPlans?: CfPlan[];
  /** Token permission needed to apply it. */
  permission: string;
  capability: Capability;
  /** Possible side effects the customer should know before applying. */
  caution?: string;
}

export interface SettingFeature extends Base {
  kind: "setting";
  settingId: string;
  value: string;
  /** Whether an observed value already satisfies the feature. */
  satisfied: (value: unknown) => boolean;
}

export interface BotFeature extends Base {
  kind: "bot_fight_mode";
}

export interface ManagedFeature extends Base {
  kind: "managed_ruleset";
}

export interface RuleFeature extends Base {
  kind: "custom_rule";
  action: "block" | "managed_challenge";
  expression: string;
}

export type ProtectionFeature = SettingFeature | BotFeature | ManagedFeature | RuleFeature;

const TLS_ORDER = ["1.0", "1.1", "1.2", "1.3"];

export const FEATURES: ProtectionFeature[] = [
  {
    key: "always_use_https",
    kind: "setting",
    settingId: "always_use_https",
    value: "on",
    satisfied: (v) => v === "on",
    label: "Always Use HTTPS",
    description: "Cloudflare redirects every http:// request to https://.",
    minPlan: "free",
    permission: "Zone Settings Edit",
    capability: "settings",
  },
  {
    key: "min_tls_1_2",
    kind: "setting",
    settingId: "min_tls_version",
    value: "1.2",
    satisfied: (v) => typeof v === "string" && TLS_ORDER.indexOf(v) >= TLS_ORDER.indexOf("1.2"),
    label: "Minimum TLS 1.2",
    description: "Visitors must connect with TLS 1.2 or newer (TLS 1.0/1.1 are obsolete).",
    caution: "Very old browsers and devices that only support TLS 1.0/1.1 will no longer connect.",
    minPlan: "free",
    permission: "Zone Settings Edit",
    capability: "settings",
  },
  {
    key: "bot_fight_mode",
    kind: "bot_fight_mode",
    label: "Bot Fight Mode",
    description: "Cloudflare challenges requests that match known bot patterns.",
    caution: "Cannot be bypassed with WAF rules, so it may also challenge legitimate automated tools (monitoring, payment callbacks, APIs). Check integrations before enabling.",
    minPlan: "free",
    onlyPlans: ["free"],
    permission: "Bot Management Edit",
    capability: "bots",
  },
  {
    key: "managed_waf",
    kind: "managed_ruleset",
    label: "Cloudflare Managed Ruleset (WAF)",
    description: "Deploys Cloudflare's managed WAF rules against common web attacks and known vulnerabilities.",
    caution: "Managed rules can occasionally block legitimate requests. Review Security Events after enabling.",
    minPlan: "pro",
    permission: "Zone WAF Edit",
    capability: "managed",
  },
  {
    key: "rule:sensitive_files",
    kind: "custom_rule",
    action: "block",
    expression:
      '(http.request.uri.path contains "/.env") or (http.request.uri.path contains "/.git/") or (ends_with(http.request.uri.path, ".sql")) or (ends_with(http.request.uri.path, ".bak"))',
    label: "Block access to sensitive files",
    description: "Blocks requests for .env files, .git folders and database/backup files, which should never be public.",
    minPlan: "free",
    permission: "Zone WAF Edit",
    capability: "waf",
  },
  {
    key: "rule:wp_xmlrpc",
    kind: "custom_rule",
    action: "block",
    expression: '(http.request.uri.path eq "/xmlrpc.php")',
    label: "Block WordPress xmlrpc.php",
    description: "Blocks the legacy XML-RPC endpoint often used for password guessing. WordPress sites only.",
    caution: "Some apps and plugins (e.g. Jetpack, the WordPress mobile app) use XML-RPC.",
    minPlan: "free",
    permission: "Zone WAF Edit",
    capability: "waf",
  },
  {
    key: "rule:wp_login_challenge",
    kind: "custom_rule",
    action: "managed_challenge",
    expression: '(http.request.uri.path eq "/wp-login.php")',
    label: "Challenge WordPress login page",
    description: "Visitors to /wp-login.php must pass a Cloudflare Managed Challenge, slowing automated password guessing. WordPress sites only.",
    minPlan: "free",
    permission: "Zone WAF Edit",
    capability: "waf",
  },
];

export const featureByKey = (key: string) => FEATURES.find((f) => f.key === key);

export function ruleDescription(f: RuleFeature | ManagedFeature) {
  return `${RULE_PREFIX} ${f.label}`;
}

/** Plan-based availability (permissions are checked separately against the connected token). */
export function planAvailability(f: ProtectionFeature, plan: CfPlan): { available: boolean; reason?: string } {
  if (plan === "unknown") return { available: false, reason: "The Cloudflare plan of this zone could not be determined." };
  if (f.onlyPlans && !f.onlyPlans.includes(plan)) {
    return { available: false, reason: `Offered on Cloudflare ${f.onlyPlans.join("/")} plans only. Your plan uses Cloudflare's own bot settings.` };
  }
  if (!planAtLeast(plan, f.minPlan)) return { available: false, reason: `Requires the Cloudflare ${f.minPlan[0].toUpperCase()}${f.minPlan.slice(1)} plan or higher.` };
  return { available: true };
}
