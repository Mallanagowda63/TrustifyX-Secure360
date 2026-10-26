import { safeFetch, SafeFetchError, type SafeFetchOptions } from "../security/safe-fetch";

export interface HttpsEnforcementInfo {
  /** Whether anything answered on plain HTTP port 80. */
  httpReachable: boolean;
  /** First response on http:// is a redirect to an https:// URL. */
  redirectsToHttps: boolean;
  /** After following redirects, we ended on https://. */
  finalIsHttps: boolean;
  firstStatus: number | null;
  firstLocation: string | null;
  finalUrl: string | null;
  error: string | null;
}

export async function checkHttpsEnforcement(
  hostname: string,
  opts: Partial<SafeFetchOptions> = {},
): Promise<HttpsEnforcementInfo> {
  try {
    const res = await safeFetch(`http://${hostname}/`, { allowHttp: true, maxBodyBytes: 16 * 1024, timeoutMs: 8000, ...opts });
    const first = res.redirects[0];
    return {
      httpReachable: true,
      redirectsToHttps: Boolean(first && first.location.startsWith("https://")),
      finalIsHttps: res.url.startsWith("https://"),
      firstStatus: first ? first.status : res.status,
      firstLocation: first ? first.location : null,
      finalUrl: res.url,
      error: null,
    };
  } catch (err) {
    if (err instanceof SafeFetchError && (err.code === "CONNECTION_ERROR" || err.code === "TIMEOUT")) {
      // Port 80 closed or filtered: plain HTTP is not served, which is acceptable.
      return {
        httpReachable: false,
        redirectsToHttps: false,
        finalIsHttps: false,
        firstStatus: null,
        firstLocation: null,
        finalUrl: null,
        error: err.message,
      };
    }
    throw err;
  }
}
