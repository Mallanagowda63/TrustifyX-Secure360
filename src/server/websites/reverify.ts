import type { Website } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import { verifyDnsTxt, verifyHttpFile } from "./verification";
import { closeOpenDowntime } from "../monitoring/incidents";

/** Consecutive daily failures tolerated before monitoring is stopped. */
export const REVERIFY_FAILURE_LIMIT = 3;

/**
 * Confirms the customer still controls the domain using the method they verified with.
 * Monitoring stops (status VERIFICATION_FAILED) after REVERIFY_FAILURE_LIMIT consecutive
 * failures, so we never keep scanning a domain that changed hands.
 */
export async function reverifyWebsite(site: Website): Promise<{ ok: boolean; detail: string }> {
  if (site.status !== "CONNECTED" || !site.verificationMethod) return { ok: true, detail: "not applicable" };
  const result =
    site.verificationMethod === "DNS_TXT"
      ? await verifyDnsTxt(site.hostname, site.verificationToken)
      : await verifyHttpFile(site.hostname, site.verificationToken);
  const now = new Date();

  if (result.ok) {
    await prisma.website.update({
      where: { id: site.id },
      data: { lastReverifiedAt: now, reverifyFailures: 0, lastVerificationError: null },
    });
    return result;
  }

  const failures = site.reverifyFailures + 1;
  const stop = failures >= REVERIFY_FAILURE_LIMIT;
  await prisma.website.update({
    where: { id: site.id },
    data: {
      lastReverifiedAt: now,
      reverifyFailures: failures,
      lastVerificationError: `Ownership re-check failed (${failures}/${REVERIFY_FAILURE_LIMIT}): ${result.detail}`,
      ...(stop ? { status: "VERIFICATION_FAILED", state: "UNKNOWN" } : {}),
    },
  });
  if (stop) {
    await closeOpenDowntime(site.id, "ownership verification lost");
    await audit({
      orgId: site.orgId,
      action: "website.verification_lost",
      targetType: "website",
      targetId: site.id,
      metadata: { hostname: site.hostname, detail: result.detail },
    });
  }
  return result;
}
