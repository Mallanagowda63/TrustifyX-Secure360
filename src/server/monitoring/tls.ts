import tls from "node:tls";
import { addressAllowed, resolvePublic, type SafeFetchOptions } from "../security/safe-fetch";
import { env } from "../env";

export interface TlsInfo {
  authorized: boolean;
  authorizationError: string | null;
  hostnameMatches: boolean;
  protocol: string | null;
  cipher: string | null;
  subjectCN: string | null;
  subjectAltNames: string[];
  issuer: string | null;
  validFrom: string;
  validTo: string;
  daysRemaining: number;
  expired: boolean;
  serialNumber: string;
  fingerprint256: string;
  remoteAddress: string;
}

function str(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? v.join(", ") : v;
}

export async function checkTls(
  hostname: string,
  opts: { timeoutMs?: number; port?: number } & Pick<SafeFetchOptions, "resolver" | "addressPolicy"> = {},
): Promise<TlsInfo> {
  const pinned = await resolvePublic(hostname, opts);
  const timeoutMs = opts.timeoutMs ?? env().MONITOR_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: pinned.address,
      port: opts.port ?? 443,
      servername: hostname,
      // Inspect the certificate even when invalid; validity is reported, not enforced here.
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TLS handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once("secureConnect", () => {
      clearTimeout(timer);
      try {
        const ra = socket.remoteAddress ?? pinned.address;
        if (!addressAllowed(opts, ra)) throw new Error("Connected to non-public address");
        const cert = socket.getPeerCertificate(false);
        if (!cert || !cert.valid_to) throw new Error("Server did not present a certificate");
        const identityError = tls.checkServerIdentity(hostname, cert);
        const validTo = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        const now = Date.now();
        const cipher = socket.getCipher();
        const issuer = str(cert.issuer?.O) ?? str(cert.issuer?.CN);
        resolve({
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          hostnameMatches: !identityError,
          protocol: socket.getProtocol(),
          cipher: cipher?.name ?? null,
          subjectCN: str(cert.subject?.CN),
          subjectAltNames: (cert.subjectaltname ?? "")
            .split(",")
            .map((s) => s.trim().replace(/^DNS:/, ""))
            .filter(Boolean)
            .slice(0, 100),
          issuer,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
          daysRemaining: Math.floor((validTo.getTime() - now) / 86_400_000),
          expired: validTo.getTime() <= now || validFrom.getTime() > now,
          serialNumber: cert.serialNumber,
          fingerprint256: cert.fingerprint256,
          remoteAddress: ra,
        });
      } catch (err) {
        reject(err);
      } finally {
        socket.end();
      }
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`TLS connection failed: ${(err as NodeJS.ErrnoException).code ?? err.message}`));
    });
  });
}
