import type { DnsInfo } from "./dns";
import type { HeaderInfo } from "./headers";
import type { HttpsEnforcementInfo } from "./https";
import type { TlsInfo } from "./tls";

export type ConfigCategory = "tls" | "headers" | "https" | "dns";

/** Everything one configuration check observed. A null section means that check failed (see `errors`). */
export interface ConfigObservation {
  tls: TlsInfo | null;
  headers: HeaderInfo | null;
  https: HttpsEnforcementInfo | null;
  dns: DnsInfo | null;
  errors: Partial<Record<ConfigCategory, string>>;
}
