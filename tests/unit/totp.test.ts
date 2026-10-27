import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, hotp, matchTotp, normalizeTotpInput, otpauthUrl, totpCode, totpStep } from "@/server/auth/totp";

// RFC 6238 Appendix B (SHA-1 key "12345678901234567890"), truncated to 6 digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP (RFC 6238)", () => {
  it("encodes/decodes base32 like authenticator apps", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq").toString()).toBe("12345678901234567890");
    expect(() => base32Decode("not*base32")).toThrow();
  });

  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("matches the RFC test vector at T=%i", (t, code) => {
    expect(totpCode(RFC_SECRET, totpStep(t * 1000))).toBe(code);
    expect(matchTotp(RFC_SECRET, code, t * 1000)).toBe(totpStep(t * 1000));
  });

  it("matches the RFC 4226 HOTP vectors", () => {
    const key = Buffer.from("12345678901234567890");
    expect([0, 1, 2, 9].map((c) => hotp(key, c))).toEqual(["755224", "287082", "359152", "520489"]);
  });

  it("accepts ±1 step of clock drift and nothing further", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), now)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(normalizeTotpInput("123 456")).toBe("123456");
    for (const bad of ["12345", "1234567", "abcdef", "", "12345a"]) expect(matchTotp(RFC_SECRET, bad)).toBeNull();
  });

  it("generates 160-bit secrets and a standard otpauth URI", () => {
    const s = generateTotpSecret();
    expect(base32Decode(s)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(s);
    const uri = new URL(otpauthUrl(s, "asha@shop.example"));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe(s);
    expect(uri.searchParams.get("issuer")).toBe("TrustifyX Secure360");
    expect(decodeURIComponent(uri.pathname)).toContain("TrustifyX Secure360:asha@shop.example");
  });
});
