import type { Severity } from "@prisma/client";
import type { ConfigCategory, ConfigObservation } from "../monitoring/types";

/**
 * Each rule turns a VERIFIED external observation into a finding. Rules only describe
 * what was observed (configuration), never infer attacks, compromise or CVEs.
 */
export interface Observation {
  ruleId: string;
  category: ConfigCategory;
  title: string;
  severity: Severity;
  evidence: Record<string, unknown>;
  description: string;
  remediation: string;
}

const HARDENING_NOTE =
  "This is a configuration hardening observation. It is not evidence that the website has been attacked or compromised.";

const SIX_MONTHS = 15_552_000;

/** A "null MX" (`0 .`, RFC 7505) explicitly declares that the domain accepts no email. */
export function receivesMail(mx: string[]): boolean {
  return mx.some((m) => !/^\d+ \.?$/.test(m.trim()));
}

export function evaluateRules(o: ConfigObservation, hostname: string, observedAt: Date = new Date()): Observation[] {
  const out: Observation[] = [];
  const at = observedAt.toISOString();

  // ─── TLS ───
  if (o.tls) {
    const t = o.tls;
    const certEvidence = {
      observedAt: at,
      subject: t.subjectCN,
      issuer: t.issuer,
      validFrom: t.validFrom,
      validTo: t.validTo,
      daysRemaining: t.daysRemaining,
      serialNumber: t.serialNumber,
      fingerprint256: t.fingerprint256,
    };
    if (t.expired) {
      out.push({
        ruleId: "tls.expired",
        category: "tls",
        title: "TLS certificate is expired or not yet valid",
        severity: "CRITICAL",
        evidence: certEvidence,
        description:
          "Browsers show a full-page security warning for this website and most visitors cannot proceed. Automated clients (APIs, payment callbacks, crawlers) will refuse to connect.",
        remediation:
          "Renew the certificate with your certificate authority or hosting provider and install it on the server or CDN. Enable automatic renewal (for example Let's Encrypt with certbot or your CDN's managed certificates) so it does not lapse again.",
      });
    } else if (t.daysRemaining <= 30) {
      out.push({
        ruleId: "tls.expiring",
        category: "tls",
        title: `TLS certificate expires in ${t.daysRemaining} day${t.daysRemaining === 1 ? "" : "s"}`,
        severity: t.daysRemaining <= 7 ? "HIGH" : "MEDIUM",
        evidence: certEvidence,
        description:
          "When the certificate expires, browsers will block visitors with a security warning. Renewing ahead of time avoids an outage.",
        remediation:
          "Renew the certificate before the expiry date, or verify that automatic renewal is configured and working (check the renewal job's logs).",
      });
    }
    if (!t.expired && (!t.authorized || !t.hostnameMatches)) {
      out.push({
        ruleId: "tls.untrusted",
        category: "tls",
        title: t.hostnameMatches ? "TLS certificate is not trusted" : "TLS certificate does not match the hostname",
        severity: "HIGH",
        evidence: {
          ...certEvidence,
          authorizationError: t.authorizationError,
          hostnameMatches: t.hostnameMatches,
          subjectAltNames: t.subjectAltNames.slice(0, 20),
        },
        description:
          "Browsers cannot confirm this certificate was issued for this website by a trusted authority, so visitors see a security warning. Common causes are a self-signed certificate, a missing intermediate certificate, or a certificate issued for a different name.",
        remediation:
          "Install a certificate from a publicly trusted CA that covers this exact hostname, and configure the server to send the full certificate chain (leaf plus intermediates).",
      });
    }
    if (t.protocol === "TLSv1" || t.protocol === "TLSv1.1") {
      out.push({
        ruleId: "tls.legacy_protocol",
        category: "tls",
        title: `Server negotiated legacy protocol ${t.protocol}`,
        severity: "MEDIUM",
        evidence: { observedAt: at, protocol: t.protocol, cipher: t.cipher },
        description: "TLS 1.0 and 1.1 are deprecated (RFC 8996) and have known cryptographic weaknesses.",
        remediation: "Disable TLS 1.0/1.1 and allow only TLS 1.2 and TLS 1.3 in the server or CDN configuration.",
      });
    }
  }

  // ─── HTTPS enforcement ───
  if (o.https && o.https.httpReachable && !o.https.redirectsToHttps) {
    out.push({
      ruleId: "https.not_enforced",
      category: "https",
      title: "Plain HTTP is served without redirecting to HTTPS",
      severity: "MEDIUM",
      evidence: {
        observedAt: at,
        requested: `http://${hostname}/`,
        firstStatus: o.https.firstStatus,
        firstLocation: o.https.firstLocation,
        finalUrl: o.https.finalUrl,
      },
      description:
        "Visitors who type the address without https:// or follow an old link load the site unencrypted. On untrusted networks that traffic can be read or modified. " +
        HARDENING_NOTE,
      remediation:
        "Configure the web server or CDN to answer every http:// request with a 301 redirect to the same https:// URL (e.g. nginx: `return 301 https://$host$request_uri;`), then enable HSTS.",
    });
  }

  // ─── HTTP security headers (hardening only) ───
  if (o.headers) {
    const h = o.headers;
    const base = { observedAt: at, url: h.url, statusCode: h.statusCode };

    if (!h.hsts.present) {
      out.push({
        ruleId: "headers.hsts_missing",
        category: "headers",
        title: "Strict-Transport-Security (HSTS) header is missing",
        severity: "MEDIUM",
        evidence: { ...base, header: "Strict-Transport-Security", observed: null },
        description:
          "Without HSTS, browsers may make an initial unencrypted request, which allows SSL-stripping on hostile networks. " +
          HARDENING_NOTE,
        remediation:
          "Send `Strict-Transport-Security: max-age=31536000; includeSubDomains` on HTTPS responses once every subdomain supports HTTPS. Start with a short max-age while testing.",
      });
    } else if ((h.hsts.maxAge ?? 0) < SIX_MONTHS) {
      out.push({
        ruleId: "headers.hsts_short",
        category: "headers",
        title: "HSTS max-age is shorter than 6 months",
        severity: "LOW",
        evidence: { ...base, header: "Strict-Transport-Security", observed: h.hsts.raw, maxAge: h.hsts.maxAge },
        description: "A short HSTS lifetime gives less protection to returning visitors. " + HARDENING_NOTE,
        remediation: "Increase max-age to at least 15552000 (180 days); 31536000 (1 year) is common.",
      });
    }

    if (!h.csp.present) {
      out.push({
        ruleId: "headers.csp_missing",
        category: "headers",
        title: "Content-Security-Policy header is missing",
        severity: "LOW",
        evidence: { ...base, header: "Content-Security-Policy", observed: null },
        description:
          "A Content Security Policy limits where scripts and other resources can load from, which reduces the impact of cross-site scripting (XSS) bugs if one exists. " +
          HARDENING_NOTE,
        remediation:
          "Introduce a policy in report-only mode first (`Content-Security-Policy-Report-Only`), review reports, then enforce it. A starting point: `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`.",
      });
    } else if (h.csp.reportOnly) {
      out.push({
        ruleId: "headers.csp_report_only",
        category: "headers",
        title: "Content-Security-Policy is in report-only mode",
        severity: "INFO",
        evidence: { ...base, header: "Content-Security-Policy-Report-Only", observed: h.csp.raw },
        description: "A report-only policy is not enforced by browsers. " + HARDENING_NOTE,
        remediation: "Once reports show no legitimate violations, send the same policy as `Content-Security-Policy`.",
      });
    } else if (h.csp.scriptUnsafeInline || h.csp.scriptUnsafeEval) {
      out.push({
        ruleId: "headers.csp_unsafe_script",
        category: "headers",
        title: "Content-Security-Policy allows unsafe inline or eval scripts",
        severity: "LOW",
        evidence: {
          ...base,
          header: "Content-Security-Policy",
          observed: h.csp.raw,
          unsafeInline: h.csp.scriptUnsafeInline,
          unsafeEval: h.csp.scriptUnsafeEval,
        },
        description:
          "'unsafe-inline' and 'unsafe-eval' in script-src weaken the protection a CSP gives against XSS. " + HARDENING_NOTE,
        remediation: "Replace inline scripts with external files or nonces/hashes, and remove 'unsafe-eval' where possible.",
      });
    }

    if ((h.xContentTypeOptions ?? "").trim().toLowerCase() !== "nosniff") {
      out.push({
        ruleId: "headers.xcto_missing",
        category: "headers",
        title: "X-Content-Type-Options is not set to nosniff",
        severity: "LOW",
        evidence: { ...base, header: "X-Content-Type-Options", observed: h.xContentTypeOptions },
        description:
          "Without `nosniff`, some browsers may interpret files as a different content type than declared (MIME sniffing). " +
          HARDENING_NOTE,
        remediation: "Send `X-Content-Type-Options: nosniff` on all responses.",
      });
    }

    const rp = (h.referrerPolicy ?? "").toLowerCase();
    if (!rp) {
      out.push({
        ruleId: "headers.referrer_policy_missing",
        category: "headers",
        title: "Referrer-Policy header is missing",
        severity: "INFO",
        evidence: { ...base, header: "Referrer-Policy", observed: null },
        description:
          "Modern browsers default to `strict-origin-when-cross-origin`, but an explicit policy makes behaviour consistent across browsers and prevents full URLs (which may contain identifiers) leaking to other sites. " +
          HARDENING_NOTE,
        remediation: "Send `Referrer-Policy: strict-origin-when-cross-origin` (or stricter).",
      });
    } else if (rp.includes("unsafe-url") || rp === "no-referrer-when-downgrade") {
      out.push({
        ruleId: "headers.referrer_policy_weak",
        category: "headers",
        title: "Referrer-Policy sends full URLs to other sites",
        severity: "LOW",
        evidence: { ...base, header: "Referrer-Policy", observed: h.referrerPolicy },
        description: "Full page URLs, including paths and query strings, are sent to third-party sites. " + HARDENING_NOTE,
        remediation: "Use `strict-origin-when-cross-origin` or `no-referrer`.",
      });
    }

    if (!h.xFrameOptions && !h.csp.hasFrameAncestors) {
      out.push({
        ruleId: "headers.framing_unrestricted",
        category: "headers",
        title: "No clickjacking protection (X-Frame-Options / frame-ancestors)",
        severity: "LOW",
        evidence: { ...base, header: "X-Frame-Options", observed: null, cspFrameAncestors: false },
        description:
          "Other websites can embed these pages in a frame, which can be used to trick users into clicking hidden buttons (clickjacking). " +
          HARDENING_NOTE,
        remediation: "Add `frame-ancestors 'self'` to your CSP, or send `X-Frame-Options: SAMEORIGIN`.",
      });
    }

    const versionDisclosure = [h.server, h.xPoweredBy].filter((v): v is string => Boolean(v && /\d/.test(v)));
    if (versionDisclosure.length) {
      out.push({
        ruleId: "headers.version_disclosure",
        category: "headers",
        title: "Server software version is disclosed in response headers",
        severity: "INFO",
        evidence: { ...base, server: h.server, xPoweredBy: h.xPoweredBy },
        description:
          "Publishing exact software versions makes it easier to match the server against public vulnerability lists. It does not mean the version is vulnerable. " +
          HARDENING_NOTE,
        remediation: "Remove version details (nginx: `server_tokens off;`, PHP: `expose_php = Off`, Express: `app.disable('x-powered-by')`).",
      });
    }

    const insecureCookies = h.cookies.filter((c) => !c.secure).map((c) => c.name);
    if (insecureCookies.length) {
      out.push({
        ruleId: "headers.cookie_not_secure",
        category: "headers",
        title: "Cookies set without the Secure attribute",
        severity: "LOW",
        evidence: { ...base, cookieNames: insecureCookies.slice(0, 20) },
        description:
          "Cookies without `Secure` can be sent over unencrypted HTTP if a visitor ever loads an http:// URL. Cookie values were not collected. " +
          HARDENING_NOTE,
        remediation: "Add `Secure` (and `HttpOnly` and `SameSite=Lax` for session cookies) to every Set-Cookie header.",
      });
    }
  }

  // ─── DNS ───
  if (o.dns) {
    const d = o.dns;
    if (d.CAA.length === 0) {
      out.push({
        ruleId: "dns.caa_missing",
        category: "dns",
        title: "No CAA record restricts which CAs may issue certificates",
        severity: "INFO",
        evidence: { observedAt: at, domain: d.registrableDomain, CAA: [] },
        description: "A CAA record lists the certificate authorities allowed to issue certificates for your domain. " + HARDENING_NOTE,
        remediation: `Add a CAA record for ${d.registrableDomain}, e.g. \`0 issue "letsencrypt.org"\`, naming the CA(s) you actually use.`,
      });
    }
    if (receivesMail(d.MX) && !d.dmarc) {
      out.push({
        ruleId: "dns.dmarc_missing",
        category: "dns",
        title: "Domain receives email but has no DMARC policy",
        severity: "LOW",
        evidence: { observedAt: at, domain: d.registrableDomain, MX: d.MX.slice(0, 5), dmarc: null },
        description:
          "Without DMARC, receiving mail servers have no published instruction for handling messages that fail SPF/DKIM checks, which makes it easier to send email that pretends to be from your domain. " +
          HARDENING_NOTE,
        remediation: `Publish a TXT record at _dmarc.${d.registrableDomain}, starting with \`v=DMARC1; p=none; rua=mailto:you@${d.registrableDomain}\` and tighten to p=quarantine/reject after reviewing reports.`,
      });
    }
    if (receivesMail(d.MX) && !d.spf) {
      out.push({
        ruleId: "dns.spf_missing",
        category: "dns",
        title: "Domain receives email but has no SPF record",
        severity: "LOW",
        evidence: { observedAt: at, domain: d.registrableDomain, MX: d.MX.slice(0, 5), spf: null },
        description: "SPF lists the servers allowed to send email for your domain. " + HARDENING_NOTE,
        remediation: `Publish a TXT record on ${d.registrableDomain} such as \`v=spf1 include:<your-mail-provider> -all\`.`,
      });
    }
  }

  return out;
}

/** Categories whose rules ran (data was collected), so absent findings there can be auto-resolved. */
export function evaluatedCategories(o: ConfigObservation): ConfigCategory[] {
  return (["tls", "headers", "https", "dns"] as const).filter((c) => o[c] !== null);
}
