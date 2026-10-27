import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { build } from "esbuild";
import { buildZapPlan, DISABLED_ACTIVE_RULES, scopeRegex } from "@/server/scanning/zap-plan";
import { parseZapReport, stripHtml } from "@/server/scanning/zap-report";
import { startScopeProxy } from "@/scanner/scope-proxy";
import { runScan, ScanAbortedError } from "@/scanner/run";

const FAKE_ZAP = path.resolve("tests/fixtures/fake-zap.mjs");

describe("ZAP plan", () => {
  const base = { targetUrl: "https://shop.example/", proxyPort: 41234, reportDir: "/tmp/r", reportFile: "report", userAgent: "UA", maxMinutes: 20 };

  it("passive: spider + passive rules only, one context, forced through the scope proxy", () => {
    const plan = buildZapPlan({ ...base, type: "PASSIVE" });
    expect(plan.jobs.map((j) => j.type)).toEqual(["spider", "passiveScan-wait", "report"]);
    expect(plan.env.contexts).toEqual([{ name: "target", urls: ["https://shop.example/"], includePaths: [scopeRegex(base.targetUrl)], excludePaths: [] }]);
    expect(plan.env.proxy).toEqual({ hostname: "127.0.0.1", port: 41234 });
    expect(plan.env.parameters.maxDuration).toBe(1200);
    expect(plan.jobs[0].parameters).toMatchObject({ maxDuration: 5, threadCount: 2, postForm: false, processForm: false });
    expect(JSON.stringify(plan)).not.toContain("activeScan");
  });

  it("active: conservative limits and disruptive rules switched off", () => {
    const plan = buildZapPlan({ ...base, type: "ACTIVE" });
    const active = plan.jobs.find((j) => j.type === "activeScan")!;
    expect(active.parameters).toMatchObject({ delayInMs: 200, threadPerHost: 2, maxScanDurationInMins: 60 });
    expect((active.policyDefinition as { rules: Array<{ id: number; threshold: string }> }).rules).toEqual(DISABLED_ACTIVE_RULES.map((r) => ({ id: r.id, name: r.name, threshold: "Off" })));
  });

  it("scope regex matches only the authorized origin", () => {
    const re = new RegExp(scopeRegex("https://shop.example/"));
    expect(re.test("https://shop.example/")).toBe(true);
    expect(re.test("https://shop.example/a/b?c=1")).toBe(true);
    expect(re.test("https://shop.example.evil.net/")).toBe(false);
    expect(re.test("https://shopxexample/")).toBe(false);
    expect(re.test("http://shop.example/")).toBe(false);
  });
});

describe("ZAP report parsing (untrusted input)", () => {
  const report = {
    site: [
      {
        "@host": "shop.example",
        alerts: [
          { pluginid: "10038", alertRef: "10038-1", alert: "CSP Header Not Set", riskcode: "2", confidence: "3", desc: "<p>A &amp; B</p><p>C</p>", instances: [{ uri: "https://shop.example/", method: "GET" }, { uri: "https://evil.example/", method: "GET" }], count: "2", solution: "<p>Fix</p>", cweid: "693", wascid: "15" },
          { pluginid: "40012", alert: "XSS", riskcode: "3", confidence: "2", desc: "x", instances: [{ uri: "https://cdn.example/x", method: "GET" }] },
          { pluginid: "x", riskcode: "9", alert: "bad risk" },
        ],
      },
      { "@host": "third-party.example", alerts: [{ pluginid: "1", alert: "Not ours", riskcode: "3", confidence: "3", instances: [] }] },
    ],
  };

  it("keeps only alerts for the scanned host and normalises fields", () => {
    const alerts = parseZapReport(report, "shop.example");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ pluginId: "10038", risk: "MEDIUM", confidence: "HIGH", description: "A & B\nC", solution: "Fix", cweId: 693, instanceCount: 2 });
    expect(alerts[0].instances.map((i) => i.uri)).toEqual(["https://shop.example/"]);
  });

  it("rejects non-reports and strips markup", () => {
    expect(() => parseZapReport({ nope: true }, "x")).toThrow();
    expect(stripHtml("<script>alert(1)</script><b>hi</b>")).toBe("alert(1)hi");
  });
});

describe("scanner isolation", () => {
  it("the scanner bundle contains no database client or app secrets loader", async () => {
    const out = await build({
      entryPoints: ["src/scanner/index.ts"],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      packages: "external",
      tsconfig: "tsconfig.json",
      logLevel: "silent",
    });
    const inputs = Object.keys(out.metafile!.inputs);
    expect(inputs.some((i) => i.includes("src/server/db"))).toBe(false);
    const imports = Object.values(out.metafile!.outputs).flatMap((o) => o.imports.map((i) => i.path));
    expect(imports).not.toContain("@prisma/client");
    expect(inputs.some((i) => i.includes("src/server/auth") || i.includes("src/server/billing"))).toBe(false);
  });
});

describe("scope proxy (network-level scope enforcement)", () => {
  let target: http.Server;
  let port: number;
  beforeAll(async () => {
    target = http.createServer((req, res) => res.end(`ok ${req.url}`));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    port = (target.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => target.close(() => r())));

  const resolver = async (h: string) => (h === "scan-target.test" || h === "other.test" ? [{ address: "127.0.0.1", family: 4 }] : h === "meta.test" ? [{ address: "169.254.169.254", family: 4 }] : []);
  const through = (proxyPort: number, url: string) =>
    new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: proxyPort, path: url, headers: { host: new URL(url).host } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", () => resolve(0));
      req.end();
    });
  const connect = (proxyPort: number, hostPort: string) =>
    new Promise<string>((resolve) => {
      const s = net.connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
      s.once("data", (d) => {
        resolve(d.toString().split("\r\n")[0]);
        s.destroy();
      });
      s.on("error", () => resolve("error"));
    });

  it("allows only the target host; refuses other hosts, other ports and private addresses", async () => {
    const proxy = await startScopeProxy({ hostname: "scan-target.test", resolver, extraPorts: [port], addressPolicy: (ip) => ip === "127.0.0.1" });
    try {
      expect(await through(proxy.port, `http://scan-target.test:${port}/a`)).toBe(200);
      expect(await through(proxy.port, `http://other.test:${port}/a`)).toBe(403);
      expect(await through(proxy.port, `http://scan-target.test:22/`)).toBe(403);
      expect(await connect(proxy.port, `scan-target.test:${port}`)).toContain("200");
      expect(await connect(proxy.port, `other.test:${port}`)).toContain("403");
      expect(proxy.stats).toMatchObject({ allowed: 2, refused: 3 });
      expect(proxy.stats.refusedHosts).toContain("other.test");
    } finally {
      await proxy.close();
    }
  });

  it("survives clients that reset the connection while the destination is being vetted (regression)", async () => {
    const slow = async (h: string) => {
      await new Promise((r) => setTimeout(r, 200));
      return resolver(h);
    };
    const proxy = await startScopeProxy({ hostname: "scan-target.test", resolver: slow, extraPorts: [port], addressPolicy: (ip) => ip === "127.0.0.1" });
    try {
      for (let i = 0; i < 5; i++) {
        const s = net.connect(proxy.port, "127.0.0.1", () => {
          s.write(`CONNECT scan-target.test:${port} HTTP/1.1\r\n\r\n`);
          s.resetAndDestroy();
        });
        s.on("error", () => undefined);
        const h = net.connect(proxy.port, "127.0.0.1", () => {
          h.write(`GET http://scan-target.test:${port}/ HTTP/1.1\r\nHost: scan-target.test:${port}\r\n\r\n`);
          h.resetAndDestroy();
        });
        h.on("error", () => undefined);
      }
      await new Promise((r) => setTimeout(r, 600));
      expect(await through(proxy.port, `http://scan-target.test:${port}/still-alive`)).toBe(200);
    } finally {
      await proxy.close();
    }
  });

  it("with the production policy, a target resolving to a private/metadata address is refused", async () => {
    const proxy = await startScopeProxy({ hostname: "meta.test", resolver, extraPorts: [port] });
    try {
      expect(await through(proxy.port, `http://meta.test:${port}/latest/meta-data/`)).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it("runs a scan end to end with a fake ZAP: out-of-scope traffic refused, off-target alerts dropped", async () => {
    const progress: number[] = [];
    const result = await runScan(
      { scanId: "s1", targetUrl: `http://scan-target.test:${port}/`, type: "PASSIVE" },
      {
        zapCommand: process.execPath,
        zapArgs: [FAKE_ZAP],
        resolver,
        extraPorts: [port],
        addressPolicy: (ip) => ip === "127.0.0.1",
        isCancelled: async () => false,
        onProgress: (p) => void progress.push(p),
      },
    );
    expect(result.alerts.map((a) => a.pluginId)).toEqual(["10038", "10021"]);
    expect(result.alerts[0].instances.every((i) => i.uri.includes("scan-target.test"))).toBe(true);
    expect(result.stats.allowed).toBeGreaterThanOrEqual(1);
    expect(result.stats.refusedHosts).toContain("evil-cdn.example");
    expect(result.stats.zapExitCode).toBe(0);
    expect(progress).toEqual(expect.arrayContaining([5, 10, 40, 50, 92, 100]));
  });

  it("cancellation stops the scanner; a missing report fails the scan", async () => {
    const ctx = { zapCommand: process.execPath, zapArgs: [FAKE_ZAP], resolver, extraPorts: [port], addressPolicy: (ip: string) => ip === "127.0.0.1", onProgress: () => undefined };
    process.env.FAKE_ZAP_MODE = "hang";
    try {
      await expect(runScan({ scanId: "s2", targetUrl: `http://scan-target.test:${port}/`, type: "PASSIVE" }, { ...ctx, isCancelled: async () => true })).rejects.toBeInstanceOf(ScanAbortedError);
      process.env.FAKE_ZAP_MODE = "noreport";
      await expect(runScan({ scanId: "s3", targetUrl: `http://scan-target.test:${port}/`, type: "PASSIVE" }, { ...ctx, isCancelled: async () => false })).rejects.toThrow(/did not produce a JSON report/);
    } finally {
      delete process.env.FAKE_ZAP_MODE;
    }
  }, 30_000);

  it("active scans refuse to start outside their maintenance window", async () => {
    const ctx = { zapCommand: process.execPath, zapArgs: [FAKE_ZAP], isCancelled: async () => false, onProgress: () => undefined };
    const past = { windowStart: new Date(Date.now() - 7200_000).toISOString(), windowEnd: new Date(Date.now() - 3600_000).toISOString() };
    await expect(runScan({ scanId: "s4", targetUrl: "https://shop.example/", type: "ACTIVE", ...past }, ctx)).rejects.toBeInstanceOf(ScanAbortedError);
    await expect(runScan({ scanId: "s5", targetUrl: "https://shop.example/", type: "ACTIVE" }, ctx)).rejects.toBeInstanceOf(ScanAbortedError);
  });
});
