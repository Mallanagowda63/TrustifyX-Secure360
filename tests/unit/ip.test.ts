import { describe, expect, it } from "vitest";
import { isIpLiteral, isPublicAddress } from "@/server/security/ip";

describe("isPublicAddress", () => {
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"])("allows public %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback range"],
    ["0.0.0.0", "unspecified"],
    ["10.0.0.5", "RFC1918"],
    ["172.16.0.1", "RFC1918"],
    ["172.31.255.255", "RFC1918"],
    ["192.168.1.1", "RFC1918"],
    ["169.254.169.254", "cloud metadata / link-local"],
    ["169.254.170.2", "ECS metadata"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["100.100.100.200", "Alibaba metadata"],
    ["192.0.0.192", "Oracle metadata"],
    ["192.0.2.10", "documentation"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["240.0.0.1", "reserved"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 unique-local"],
    ["fd00:ec2::254", "AWS IMDS IPv6"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["64:ff9b::a9fe:a9fe", "NAT64-embedded metadata"],
    ["2002:a9fe:a9fe::1", "6to4-embedded metadata"],
    ["2001:db8::1", "IPv6 documentation"],
    ["not-an-ip", "garbage"],
  ])("blocks %s (%s)", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe("isIpLiteral", () => {
  it.each(["127.0.0.1", "[::1]", "::1", "2130706433", "0x7f000001", "017700000001"])("detects %s", (h) => {
    expect(isIpLiteral(h)).toBe(true);
  });
  it.each(["example.com", "1password.com", "a1.b2.example"])("does not flag %s", (h) => {
    expect(isIpLiteral(h)).toBe(false);
  });
});
