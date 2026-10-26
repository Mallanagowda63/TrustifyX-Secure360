import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createWebsite, verifyWebsite } from "@/server/services/websites";
import { reverifyWebsite, REVERIFY_FAILURE_LIMIT } from "@/server/websites/reverify";
import { expectedTxtValue } from "@/server/websites/verification";
import { hasTestDb, makeOrg, migrateTestDb, resetDb } from "../helpers/db";

const pass = async () => ({ ok: true, detail: "matched" });
const fail = async () => ({ ok: false, detail: "No TXT record found" });

describe.skipIf(!hasTestDb)("website onboarding and domain verification", () => {
  beforeAll(migrateTestDb);
  beforeEach(resetDb);

  it("creates a pending website with a unique random token", async () => {
    const { actor } = await makeOrg("Owner");
    const a = await createWebsite(actor, { url: "https://Shop.Example.com/" });
    const b = await createWebsite(actor, { url: "https://blog.example.com" });
    expect(a).toMatchObject({ status: "PENDING_VERIFICATION", hostname: "shop.example.com", url: "https://shop.example.com/" });
    const rows = await prisma.website.findMany();
    expect(rows[0].verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows[0].verificationToken).not.toBe(rows[1].verificationToken);
    expect(a.verification.dns.value).toBe(expectedTxtValue(rows.find((r) => r.id === a.id)!.verificationToken));
    expect(b.status).toBe("PENDING_VERIFICATION");
  });

  it("rejects duplicates within an org but lets another org add (and separately verify) the same domain", async () => {
    const one = await makeOrg("One");
    const two = await makeOrg("Two");
    await createWebsite(one.actor, { url: "example.com" });
    await expect(createWebsite(one.actor, { url: "https://example.com/" })).rejects.toMatchObject({ status: 409 });
    const other = await createWebsite(two.actor, { url: "example.com" });
    expect(other.status).toBe("PENDING_VERIFICATION");
  });

  it("requires explicit authorization confirmation", async () => {
    const { actor } = await makeOrg("Auth");
    const w = await createWebsite(actor, { url: "example.com" });
    await expect(verifyWebsite(actor, w.id, { method: "DNS_TXT", authorizationConfirmed: false }, { dns: pass })).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect((await prisma.website.findUniqueOrThrow({ where: { id: w.id } })).status).toBe("PENDING_VERIFICATION");
  });

  it("marks verification failed with the reason, then connects on success and queues the first scan", async () => {
    const { actor, user } = await makeOrg("Verify");
    const w = await createWebsite(actor, { url: "example.com" });
    const failed = await verifyWebsite(actor, w.id, { method: "DNS_TXT", authorizationConfirmed: true }, { dns: fail });
    expect(failed).toMatchObject({ verified: false, website: { status: "VERIFICATION_FAILED", lastVerificationError: "No TXT record found" } });

    const queued: string[] = [];
    const ok = await verifyWebsite(actor, w.id, { method: "DNS_TXT", authorizationConfirmed: true }, { dns: pass, enqueue: async (id) => void queued.push(id) });
    expect(ok.verified).toBe(true);
    const row = await prisma.website.findUniqueOrThrow({ where: { id: w.id } });
    expect(row).toMatchObject({ status: "CONNECTED", verificationMethod: "DNS_TXT", authorizedById: user.id });
    expect(row.verifiedAt).not.toBeNull();
    expect(row.authorizationConfirmedAt).not.toBeNull();
    expect(queued).toEqual([w.id]);

    const logs = await prisma.auditLog.findMany({ where: { targetId: w.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["website.create", "website.verify_failed", "website.verified"]);
  });

  it("uses the selected verification method", async () => {
    const { actor } = await makeOrg("File");
    const w = await createWebsite(actor, { url: "example.com" });
    let used = "";
    await verifyWebsite(actor, w.id, { method: "HTTP_FILE", authorizationConfirmed: true }, {
      dns: async () => ((used = "dns"), { ok: true, detail: "" }),
      file: async () => ((used = "file"), { ok: true, detail: "" }),
      enqueue: async () => undefined,
    });
    expect(used).toBe("file");
  });

  it("viewers cannot verify", async () => {
    const owner = await makeOrg("O");
    const w = await createWebsite(owner.actor, { url: "example.com" });
    await expect(verifyWebsite({ ...owner.actor, role: "VIEWER" }, w.id, { method: "DNS_TXT", authorizationConfirmed: true }, { dns: pass })).rejects.toMatchObject({ status: 403 });
  });

  it(`stops monitoring after ${REVERIFY_FAILURE_LIMIT} consecutive failed ownership re-checks`, async () => {
    const { actor } = await makeOrg("Re");
    const w = await createWebsite(actor, { url: "example.com" });
    await verifyWebsite(actor, w.id, { method: "DNS_TXT", authorizationConfirmed: true }, { dns: pass, enqueue: async () => undefined });
    // The real DNS lookup for _trustifyx-verify.example.com will not contain this random token.
    for (let i = 1; i <= REVERIFY_FAILURE_LIMIT; i++) {
      const site = await prisma.website.findUniqueOrThrow({ where: { id: w.id } });
      await reverifyWebsite(site);
      const after = await prisma.website.findUniqueOrThrow({ where: { id: w.id } });
      expect(after.reverifyFailures).toBe(i);
      expect(after.status).toBe(i < REVERIFY_FAILURE_LIMIT ? "CONNECTED" : "VERIFICATION_FAILED");
    }
  });
});
