import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  expectedTxtValue,
  txtRecordName,
  verificationInstructions,
  verifyDnsTxt,
  verifyHttpFile,
} from "@/server/websites/verification";
import { loopbackOnlyPolicy, redirect, startServer, text } from "../helpers/http-server";

const TOKEN = "tok_9f8e7d6c5b4a3210";

describe("DNS TXT verification", () => {
  it("uses a dedicated record name and prefixed value", () => {
    expect(txtRecordName("www.example.com")).toBe("_trustifyx-verify.www.example.com");
    expect(verificationInstructions("example.com", TOKEN).dns).toEqual({
      type: "TXT",
      name: "_trustifyx-verify.example.com",
      value: `trustifyx-site-verification=${TOKEN}`,
    });
  });

  it("succeeds when the exact value is published", async () => {
    let asked = "";
    const r = await verifyDnsTxt("example.com", TOKEN, async (name) => {
      asked = name;
      return [["v=spf1 -all"], [expectedTxtValue(TOKEN)]];
    });
    expect(r.ok).toBe(true);
    expect(asked).toBe("_trustifyx-verify.example.com");
  });

  it("joins split TXT chunks before comparing", async () => {
    const v = expectedTxtValue(TOKEN);
    const r = await verifyDnsTxt("example.com", TOKEN, async () => [[v.slice(0, 10), v.slice(10)]]);
    expect(r.ok).toBe(true);
  });

  it("fails for a different token, a partial match, or a token from another site", async () => {
    for (const records of [[[expectedTxtValue("other")]], [[`${expectedTxtValue(TOKEN)}extra`]], [[TOKEN]]]) {
      const r = await verifyDnsTxt("example.com", TOKEN, async () => records);
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/none matched/);
    }
  });

  it("explains a missing record", async () => {
    const r = await verifyDnsTxt("example.com", TOKEN, async () => {
      throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    });
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toMatch(/No TXT record found/);
  });
});

describe("HTTP file verification", () => {
  const PATH = "/.well-known/trustifyx-verification.txt";
  let srv: Awaited<ReturnType<typeof startServer>>;
  let opts: Parameters<typeof verifyHttpFile>[2];

  beforeAll(async () => {
    srv = await startServer({
      [PATH]: text(`# TrustifyX verification
${expectedTxtValue(TOKEN)}
`),
    });
    opts = { baseUrl: srv.base, allowHttp: true, addressPolicy: loopbackOnlyPolicy, allowedPorts: [srv.port] };
  });
  afterAll(() => srv.close());

  it("serves instructions at the well-known HTTPS path", () => {
    expect(verificationInstructions("example.com", TOKEN).file).toEqual({
      url: "https://example.com/.well-known/trustifyx-verification.txt",
      content: expectedTxtValue(TOKEN),
    });
  });

  it("succeeds when the file contains the token line", async () => {
    const r = await verifyHttpFile("example.com", TOKEN, opts);
    expect(r).toMatchObject({ ok: true });
  });

  it("fails when the file contains a different token", async () => {
    const r = await verifyHttpFile("example.com", "different-token", opts);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/did not contain/);
  });

  it("fails on non-200 responses", async () => {
    const local = await startServer({ [PATH]: text(expectedTxtValue(TOKEN), 404) });
    try {
      const r = await verifyHttpFile("example.com", TOKEN, { ...opts, baseUrl: local.base, allowedPorts: [local.port] });
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/HTTP 404/);
    } finally {
      await local.close();
    }
  });

  it("rejects redirects to another host (cannot borrow someone else's file)", async () => {
    const local = await startServer({
      [PATH]: redirect(`http://attacker-hosted.example${PATH}`),
    });
    try {
      const r = await verifyHttpFile("example.com", TOKEN, {
        ...opts,
        baseUrl: local.base,
        allowedPorts: [local.port],
        resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      });
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/another host/);
    } finally {
      await local.close();
    }
  });

  it("refuses to fetch private destinations under the default policy", async () => {
    const r = await verifyHttpFile("127.0.0.1", TOKEN);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not publicly routable/);
  });
});
