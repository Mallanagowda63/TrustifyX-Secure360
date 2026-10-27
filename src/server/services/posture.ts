import type { Severity } from "@prisma/client";

/**
 * Security Posture Score: a configuration-hygiene indicator, NOT proof of security.
 *
 * Methodology (published in the portal):
 *   score = max(0, 100 − Σ weight(severity) for every OPEN or IN_PROGRESS finding)
 *   weights: Critical 40 · High 20 · Medium 10 · Low 4 · Info 1
 * Coverage: only the externally observable checks Secure360 performs: TLS certificate validity
 * and expiry, HTTPS redirect, HTTP security headers, cookie flags and DNS (CAA, SPF, DMARC).
 * Findings marked False Positive are excluded. No score is shown until at least one
 * configuration check has completed. It does not measure application vulnerabilities, malware,
 * server hardening or anything not observable from outside the website.
 */
export const POSTURE_WEIGHTS: Record<Severity, number> = { CRITICAL: 40, HIGH: 20, MEDIUM: 10, LOW: 4, INFO: 1 };

export const POSTURE_METHODOLOGY =
  "Starts at 100 and subtracts 40 per open Critical, 20 per High, 10 per Medium, 4 per Low and 1 per Info finding (minimum 0). " +
  "It covers only Secure360's external checks: TLS certificate, HTTPS redirect, HTTP security headers, cookie flags and DNS email/CAA records. " +
  "False positives are excluded. It is not proof that a website is secure or free of vulnerabilities.";

export interface PostureScore {
  score: number;
  grade: "Strong" | "Fair" | "Needs attention";
  deductions: Partial<Record<Severity, number>>;
}

export function postureScore(openSeverities: Severity[], configChecked: boolean): PostureScore | null {
  if (!configChecked) return null;
  const deductions: Partial<Record<Severity, number>> = {};
  let total = 0;
  for (const s of openSeverities) {
    total += POSTURE_WEIGHTS[s];
    deductions[s] = (deductions[s] ?? 0) + 1;
  }
  const score = Math.max(0, 100 - total);
  return { score, grade: score >= 90 ? "Strong" : score >= 70 ? "Fair" : "Needs attention", deductions };
}

/** Average across websites that have a score (equal weight per website). */
export function aggregatePosture(scores: Array<PostureScore | null>): PostureScore | null {
  const valid = scores.filter((s): s is PostureScore => s !== null);
  if (!valid.length) return null;
  const score = Math.round(valid.reduce((a, s) => a + s.score, 0) / valid.length);
  return { score, grade: score >= 90 ? "Strong" : score >= 70 ? "Fair" : "Needs attention", deductions: {} };
}
