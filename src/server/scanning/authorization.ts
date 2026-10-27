/**
 * Authorization statements shown to the customer and stored verbatim with each scan.
 * Pure module: the portal renders exactly the text the server records.
 */
export const AUTH_VERSION = "v1";

export function passiveAuthorizationText(host: string) {
  return `[${AUTH_VERSION}] I confirm that I own ${host} or am authorized by its owner to have it tested, and I authorize TrustifyX to run a passive baseline scan of https://${host}/ only: crawling publicly reachable pages and analysing the responses, without attack payloads, form submissions or login attempts.`;
}

export function activeAuthorizationText(host: string, start: Date, end: Date) {
  return `[${AUTH_VERSION}] I confirm that I own ${host} or am authorized by its owner to have it tested, and I authorize TrustifyX to run an ACTIVE vulnerability scan of https://${host}/ only, between ${start.toISOString()} and ${end.toISOString()} (UTC). I understand that an active scan sends test inputs to the website, may create test data, trigger security alerts or slow the site down, that destructive, brute-force and denial-of-service tests are not performed, and that I have a current backup.`;
}
