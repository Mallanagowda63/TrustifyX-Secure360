import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePublic, safeFetch, SafeFetchError, type SafeFetchOptions } from "@/server/security/safe-fetch";
import { loopbackOnlyPolicy, redirect, startServer, text } from "../helpers/http-server";

async function expectCode(p: Promise<unknown>, code: SafeFetchError["code"]) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(SafeFetchError);
  expect((err as SafeFetchError).code).toBe(code);
  return err as SafeFetchError;
}

describe("SSRF protection: default policy (no test hooks)", () => {
  it.each([
    "http://127.0.0.1/",
    "https://127.0.0.1/",
    "https://10.1.2.3/",
    "https://192.168.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://[fd00:ec2::254]/",
    "https://[::ffff:127.0.0.1]/",
  ])("blocks private/loopback/metadata IP literal %s", async (url) => {
    await expectCode(safeFetch(url, { allowHttp: true }), "SSRF_BLOCKED");
  });

  it("blocks non-http(s) protocols", async () => {
    await expectCode(safeFetch("file:///etc/passwd"), "SSRF_BLOCKED");
    await expectCode(safeFetch("gopher://example.com/"), "SSRF_BLOCKED");
    await expectCode(safeFetch("ftp://example.com/"), "SSRF_BLOCKED");
  });

  it("blocks plain http unless explicitly allowed", async () => {
    await expectCode(safeFetch("http://example.com/"), "SSRF_BLOCKED");
  });

  it("blocks non-standard ports", async () => {
    await expectCode(safeFetch("https://example.com:6379/"), "SSRF_BLOCKED");
    await expectCode(safeFetch("https://example.com:22/"), "SSRF_BLOCKED");
  });

  it("blocks credentials in URLs and single-label hosts", async () => {
    await expectCode(safeFetch("https://user:pw@example.com/"), "SSRF_BLOCKED");
    await expectCode(safeFetch("https://localhost/"), "SSRF_BLOCKED");
    await expectCode(safeFetch("https://metadata/"), "SSRF_BLOCKED");
  });

  it("blocks hostnames whose DNS answer is private (DNS-based SSRF)", async () => {
    const resolver = async () => [{ address: "10.0.0.8", family: 4 }];
    await expectCode(safeFetch("https://internal.attacker.example/", { resolver }), "SSRF_BLOCKED");
  });

  it("blocks when ANY address in a mixed answer set is private", async () => {
    const resolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    await expectCode(resolvePublic("mixed.attacker.example", { resolver }), "SSRF_BLOCKED");
  });

  it("blocks IPv6 answers that embed private IPv4", async () => {
    const resolver = async () => [{ address: "::ffff:10.0.0.1", family: 6 }];
    await expectCode(resolvePublic("v6.attacker.example", { resolver }), "SSRF_BLOCKED");
  });

  it("reports DNS failures distinctly", async () => {
    const resolver = async () => {
      throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    };
    await expectCode(safeFetch("https://nx.example.com/", { resolver }), "DNS_FAILURE");
  });
});

describe("SSRF protection: redirects and DNS rebinding (local test server)", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let opts: SafeFetchOptions;

  beforeAll(async () => {
    srv = await startServer({
      "/ok": text("hello", 200, { "X-Test": "1" }),
      "/to-ok": (req, res, base) => redirect(`${base}/ok`)(req, res, base),
      "/to-metadata": redirect("http://169.254.169.254/latest/meta-data/iam/security-credentials/"),
      "/to-private": redirect("http://10.0.0.5/admin"),
      "/to-ipv6-loopback": redirect("http://[::1]/"),
      "/to-redis-port": redirect("http://127.0.0.1:6379/"),
      "/to-file": redirect("file:///etc/passwd"),
      "/to-localhost": redirect("http://localhost/"),
      "/loop": redirect("/loop"),
      "/to-other-host": (req, res, base) => redirect(`http://other.attacker.example:${base.split(":").pop()}/ok`)(req, res, base),
      "/big": text("x".repeat(100_000)),
      "/slow": () => undefined, // never responds
    });
    opts = { allowHttp: true, addressPolicy: loopbackOnlyPolicy, allowedPorts: [srv.port], timeoutMs: 3000 };
  });
  afterAll(() => srv.close());

  it("fetches an allowed destination and follows a safe redirect", async () => {
    const res = await safeFetch(`${srv.base}/to-ok`, opts);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("hello");
    expect(res.redirects).toHaveLength(1);
    expect(res.url).toBe(`${srv.base}/ok`);
  });

  it.each([
    ["/to-metadata", "cloud metadata IP"],
    ["/to-private", "RFC1918 IP"],
    ["/to-ipv6-loopback", "IPv6 loopback"],
    ["/to-redis-port", "internal service port"],
    ["/to-file", "file:// scheme"],
    ["/to-localhost", "single-label localhost"],
  ])("blocks redirect %s (%s)", async (path) => {
    const err = await expectCode(safeFetch(`${srv.base}${path}`, opts), "REDIRECT_BLOCKED");
    expect(err.message).toMatch(/Unsafe redirect blocked/);
  });

  it("enforces the redirect hop limit", async () => {
    await expectCode(safeFetch(`${srv.base}/loop`, { ...opts, maxRedirects: 3 }), "TOO_MANY_REDIRECTS");
  });

  it("refuses cross-host redirects when sameHostOnly is set", async () => {
    await expect(safeFetch(`${srv.base}/to-ok`, { ...opts, sameHostOnly: true })).resolves.toMatchObject({ status: 200 });
    const resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    const err = await expectCode(
      safeFetch(`${srv.base}/to-other-host`, { ...opts, sameHostOnly: true, resolver }),
      "REDIRECT_BLOCKED",
    );
    expect(err.message).toMatch(/another host/);
  });

  it("caps the response body size", async () => {
    const res = await safeFetch(`${srv.base}/big`, { ...opts, maxBodyBytes: 1000 });
    expect(res.body.length).toBe(1000);
    expect(res.bodyTruncated).toBe(true);
  });

  it("times out slow servers", async () => {
    await expectCode(safeFetch(`${srv.base}/slow`, { ...opts, timeoutMs: 500 }), "TIMEOUT");
  });

  it("connects to the vetted (pinned) IP, not a second DNS answer (rebinding)", async () => {
    let calls = 0;
    // First (vetted) answer is the allowed server. Any later lookup would return metadata;
    // the request must never perform it.
    const resolver = async () => {
      calls++;
      return calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "169.254.169.254", family: 4 }];
    };
    const res = await safeFetch(`http://rebind.attacker.example:${srv.port}/ok`, { ...opts, resolver });
    expect(res.status).toBe(200);
    expect(res.remoteAddress).toBe("127.0.0.1");
    expect(calls).toBe(1);
    expect(srv.seen.at(-1)?.host).toBe(`rebind.attacker.example:${srv.port}`);
  });

  it("re-resolves and re-vets every redirect hop", async () => {
    const resolver = async (h: string) =>
      h === "start.attacker.example" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.9.9.9", family: 4 }];
    const local = await startServer({ "/": redirect("http://evil-internal.attacker.example/") });
    try {
      await expectCode(
        safeFetch(`http://start.attacker.example:${local.port}/`, { ...opts, allowedPorts: [local.port], resolver }),
        "SSRF_BLOCKED",
      );
    } finally {
      await local.close();
    }
  });
});
