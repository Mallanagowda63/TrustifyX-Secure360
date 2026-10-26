import { describe, expect, it } from "vitest";
import { normalizeWebsiteUrl, UrlValidationError } from "@/server/security/url";

describe("normalizeWebsiteUrl", () => {
  it("normalizes a bare domain to https with a trailing slash", () => {
    expect(normalizeWebsiteUrl("Example.COM")).toEqual({
      url: "https://example.com/",
      hostname: "example.com",
      registrableDomain: "example.com",
    });
  });

  it("keeps the path but drops query, fragment and default port", () => {
    expect(normalizeWebsiteUrl("https://www.example.co.uk:443/shop?x=1#top").url).toBe("https://www.example.co.uk/shop");
  });

  it("strips the trailing dot of a fully-qualified name", () => {
    expect(normalizeWebsiteUrl("https://example.org./").hostname).toBe("example.org");
  });

  it("converts internationalized domains to punycode", () => {
    expect(normalizeWebsiteUrl("https://münchen.de").hostname).toBe("xn--mnchen-3ya.de");
  });

  it.each([
    ["http://example.com", /Only https/],
    ["ftp://example.com", /Only https/],
    ["javascript:alert(1)", /valid URL|Only https/],
    ["https://user:pass@example.com", /credentials/],
    ["https://example.com:8443", /port/],
    ["https://127.0.0.1", /IP addresses/],
    ["https://[::1]", /IP addresses/],
    ["https://169.254.169.254/latest/meta-data", /IP addresses/],
    ["https://2130706433", /IP addresses/], // decimal-encoded 127.0.0.1
    ["https://0x7f000001", /IP addresses/],
    ["https://localhost", /valid public domain|reserved/],
    ["https://app.localhost", /reserved/],
    ["https://printer.local", /reserved/],
    ["https://db.internal", /reserved/],
    ["https://metadata.google.internal", /reserved/],
    ["https://site.test", /reserved/],
    ["https://foo.home.arpa", /reserved/],
    ["https://intranet", /valid public domain/],
    ["https://exa_mple.com", /valid public domain/],
    ["https://-bad-.com", /valid public domain/],
    ["https://example.notarealtld", /public domain suffix/],
    ["", /required/],
  ])("rejects %s", (input, message) => {
    expect(() => normalizeWebsiteUrl(input)).toThrow(UrlValidationError);
    expect(() => normalizeWebsiteUrl(input)).toThrow(message);
  });
});
