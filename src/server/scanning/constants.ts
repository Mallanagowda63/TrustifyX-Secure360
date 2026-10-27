/** Shared between the app/worker and the isolated scanner process (which has no database access). */
export const SCAN_QUEUE = "vuln-scans";

/** Redis key the app sets to ask the scanner to stop a running scan. */
export const scanCancelKey = (scanId: string) => `scan:cancel:${scanId}`;
