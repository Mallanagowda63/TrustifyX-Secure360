import type { Finding, Incident, Website } from "@prisma/client";
import { portalUrl } from "../sites";
import { renderEmail } from "./mailer";
import { dispatchAlert } from "./notify";

type Site = Pick<Website, "id" | "orgId" | "displayName" | "hostname" | "url">;

// Alert emails link into the customer Security Portal.
const link = (path: string) => portalUrl(path);

export async function alertDowntime(site: Site, incident: Incident, lastError: string | null) {
  const subject = `[DOWN] ${site.displayName} (${site.hostname}) is not responding`;
  const lines = [
    `Downtime was confirmed for ${site.url} at ${incident.startedAt.toISOString()} after consecutive failed checks.`,
    `Last error: ${lastError ?? "unknown"}`,
    "We will notify you when the website recovers.",
  ];
  return dispatchAlert({
    orgId: site.orgId,
    websiteId: site.id,
    type: "DOWNTIME",
    kind: "downtime",
    dedupeKey: `down:${incident.id}`,
    subject,
    text: lines.join("\n\n"),
    html: renderEmail(subject, lines, { label: "Open website status", url: link(`/websites/${site.id}`) }),
  });
}

export async function alertRecovery(site: Site, incident: Incident) {
  const minutes = incident.resolvedAt
    ? Math.max(1, Math.round((incident.resolvedAt.getTime() - incident.startedAt.getTime()) / 60000))
    : null;
  const subject = `[RECOVERED] ${site.displayName} (${site.hostname}) is back online`;
  const lines = [
    `${site.url} is responding normally again${minutes ? ` after approximately ${minutes} minute(s) of confirmed downtime` : ""}.`,
    `Outage started: ${incident.startedAt.toISOString()}. Recovered: ${incident.resolvedAt?.toISOString() ?? "now"}.`,
  ];
  return dispatchAlert({
    orgId: site.orgId,
    websiteId: site.id,
    type: "RECOVERY",
    kind: "downtime",
    dedupeKey: `recovery:${incident.id}`,
    subject,
    text: lines.join("\n\n"),
    html: renderEmail(subject, lines, { label: "View incident history", url: link("/incidents") }),
  });
}

export const TLS_THRESHOLDS = [30, 14, 7, 3, 1, 0] as const;

/** Smallest threshold that `daysRemaining` has reached, or null if more than 30 days remain. */
export function tlsThreshold(daysRemaining: number): number | null {
  let hit: number | null = null;
  for (const t of TLS_THRESHOLDS) if (daysRemaining <= t) hit = t;
  return hit;
}

export async function alertTlsExpiry(site: Site, cert: { validTo: string; daysRemaining: number; fingerprint256: string; issuer: string | null }) {
  const threshold = tlsThreshold(cert.daysRemaining);
  if (threshold === null) return null;
  const expired = cert.daysRemaining < 0;
  const subject = expired
    ? `[TLS EXPIRED] Certificate for ${site.hostname} has expired`
    : `[TLS] Certificate for ${site.hostname} expires in ${cert.daysRemaining} day(s)`;
  const lines = [
    `The TLS certificate served by ${site.hostname} ${expired ? "expired" : "expires"} on ${cert.validTo} (issuer: ${cert.issuer ?? "unknown"}).`,
    expired
      ? "Visitors now see a browser security warning. Renew and install a new certificate as soon as possible."
      : "Renew the certificate or confirm that automatic renewal is working before this date to avoid browser warnings.",
  ];
  return dispatchAlert({
    orgId: site.orgId,
    websiteId: site.id,
    type: "TLS_EXPIRY",
    kind: "tls",
    // One alert per certificate per threshold: a renewed certificate (new fingerprint) starts fresh.
    dedupeKey: `tls:${site.id}:${cert.fingerprint256}:${threshold}`,
    subject,
    text: lines.join("\n\n"),
    html: renderEmail(subject, lines, { label: "View certificate details", url: link(`/websites/${site.id}`) }),
  });
}

export async function alertFindingOpened(site: Site, f: Finding, reopened: boolean) {
  const subject = `[${f.severity}] ${reopened ? "Reopened" : "New"} finding on ${site.hostname}: ${f.title}`;
  const lines = [
    `${reopened ? "A previously resolved finding was observed again" : "A new security finding was observed"} on ${site.url}.`,
    `Finding: ${f.title} (severity ${f.severity}).`,
    f.description,
    `Recommended fix: ${f.remediation}`,
  ];
  return dispatchAlert({
    orgId: site.orgId,
    websiteId: site.id,
    type: "FINDING_NEW",
    kind: "findings",
    severity: f.severity,
    dedupeKey: `finding-open:${f.id}:${f.firstSeenAt.getTime()}:${f.lastSeenAt.getTime()}`,
    subject,
    text: lines.join("\n\n"),
    html: renderEmail(subject, lines, { label: "Review finding", url: link(`/findings?id=${f.id}`) }),
  });
}

export async function alertFindingResolved(site: Site, f: Finding) {
  const subject = `[RESOLVED] ${f.title} on ${site.hostname}`;
  const lines = [
    `The finding "${f.title}" is no longer observed on ${site.url} and was marked resolved at ${f.resolvedAt?.toISOString() ?? "now"}.`,
  ];
  return dispatchAlert({
    orgId: site.orgId,
    websiteId: site.id,
    type: "FINDING_RESOLVED",
    kind: "findings",
    severity: f.severity,
    dedupeKey: `finding-resolved:${f.id}:${f.resolvedAt?.getTime() ?? 0}`,
    subject,
    text: lines.join("\n\n"),
    html: renderEmail(subject, lines, { label: "View findings", url: link("/findings") }),
  });
}
