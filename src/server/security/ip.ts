import ipaddr from "ipaddr.js";

/**
 * Explicit deny-list on top of the range classification below. Most of these are
 * already non-"unicast", but listing cloud metadata endpoints keeps intent obvious.
 */
const EXPLICIT_DENY_CIDRS: Array<[string, number]> = [
  ["169.254.169.254", 32], // AWS / GCP / Azure / OpenStack metadata
  ["169.254.170.2", 32], // AWS ECS task metadata
  ["100.100.100.200", 32], // Alibaba Cloud metadata
  ["192.0.0.192", 32], // Oracle Cloud metadata
  ["fd00:ec2::254", 128], // AWS IMDS IPv6
];

const denyParsed = EXPLICIT_DENY_CIDRS.map(([addr, bits]) => [ipaddr.parse(addr), bits] as const);

/**
 * True only for globally routable unicast addresses. Rejects private (RFC1918),
 * loopback, link-local, CGNAT, unique-local, multicast, reserved, documentation,
 * IPv4-mapped/translated forms that could smuggle an internal IPv4, and metadata IPs.
 */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);

  if (ip.kind() === "ipv6") {
    const v6 = ip as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) ip = v6.toIPv4Address();
  }

  for (const [deny, bits] of denyParsed) {
    if (deny.kind() === ip.kind() && ip.match(deny, bits)) return false;
  }

  // ipaddr.js classifies everything special-purpose (private, loopback, linkLocal,
  // carrierGradeNat, uniqueLocal, multicast, reserved, rfc6052, 6to4, teredo, ...)
  // as something other than "unicast".
  return ip.range() === "unicast";
}

export function isIpLiteral(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return ipaddr.isValid(h) || /^[0-9.]+$/.test(h) || /^0x[0-9a-f]+$/i.test(h);
}
