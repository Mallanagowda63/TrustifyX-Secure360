import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { setWazuhTransport } from "@/server/integrations/wazuh/client";
import { categoryFor, installFor, installInstructions, registerServer, removeServer, serverOverview, severityFor, syncServers } from "@/server/servers/service";
import { grantPlan, hasTestDb, makeOrg, migrateTestDb, resetDb } from "../helpers/db";
import { makeFakeWazuh, WAZUH_TEST_ENV } from "../fixtures/fake-wazuh";

function configure(on: boolean) {
  for (const [k, v] of Object.entries(WAZUH_TEST_ENV)) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
  resetEnvCache();
}

describe("Wazuh helpers", () => {
  it("maps rule levels and groups conservatively", () => {
    expect([0, 3, 4, 7, 10, 12, 13, 15].map(severityFor)).toEqual(["INFO", "INFO", "LOW", "MEDIUM", "HIGH", "HIGH", "CRITICAL", "CRITICAL"]);
    expect(categoryFor(["ossec", "syscheck", "syscheck_entry_modified"])).toBe("FILE_INTEGRITY");
    expect(categoryFor(["rootcheck"])).toBe("ROOTKIT");
    expect(categoryFor(["virustotal"])).toBe("MALWARE");
    expect(categoryFor(["syslog", "sshd", "authentication_failed"])).toBe("AUTHENTICATION");
    expect(categoryFor(["web", "accesslog"])).toBe("SECURITY_LOG");
  });

  it("install steps use the official package and import the TrustifyX key", () => {
    const deb = installInstructions("LINUX_DEB", "agents.example", "KEY123");
    expect(deb.steps.map((s) => s.command).join("\n")).toContain('WAZUH_MANAGER="agents.example" apt-get install wazuh-agent');
    expect(deb.steps.map((s) => s.command).join("\n")).toContain("/var/ossec/bin/manage_agents -i KEY123");
    expect(installInstructions("WINDOWS", "m", "K").steps.map((s) => s.command).join("\n")).toContain('/q WAZUH_MANAGER="m"');
  });
});

describe.skipIf(!hasTestDb)("server security (Wazuh, against a test fixture)", () => {
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    configure(true);
  });
  afterAll(() => {
    configure(false);
    setWazuhTransport(null);
  });

  async function biz() {
    return makeOrg("Biz", "OWNER", { plan: "BUSINESS" });
  }

  it("reports 'awaiting live configuration' instead of pretending to connect", async () => {
    configure(false);
    const o = await biz();
    await expect(registerServer(o.actor, { displayName: "web-01", environment: "VPS", os: "LINUX_DEB" })).rejects.toMatchObject({ code: "wazuh_not_configured" });
    expect((await serverOverview(o.org.id)).access.configured).toBe(false);
  });

  it("shared hosting is recorded as not compatible; nothing is registered with Wazuh", async () => {
    const fake = makeFakeWazuh();
    setWazuhTransport(fake.transport);
    const o = await biz();
    const r = await registerServer(o.actor, { displayName: "shop on shared host", environment: "SHARED_HOSTING", os: "LINUX_DEB" });
    expect(r.compatible).toBe(false);
    expect(r.server.status).toBe("NOT_COMPATIBLE");
    expect(fake.agents.size).toBe(0);
  });

  it("plan and role gates are enforced server-side", async () => {
    setWazuhTransport(makeFakeWazuh().transport);
    const growth = await makeOrg("Growth", "OWNER", { plan: "GROWTH" });
    await expect(registerServer(growth.actor, { displayName: "a", environment: "VPS", os: "LINUX_DEB" })).rejects.toMatchObject({ code: "plan_limit" });
    await grantPlan(growth.org.id, "PROTECT");
    await expect(registerServer(growth.actor, { displayName: "a", environment: "VPS", os: "LINUX_DEB" })).resolves.toMatchObject({ compatible: true });
    const member = await makeOrg("Team", "MEMBER", { plan: "BUSINESS" });
    await expect(registerServer(member.actor, { displayName: "a", environment: "VPS", os: "LINUX_DEB" })).rejects.toMatchObject({ status: 403 });
  });

  it("enrollment: pre-registered agent, encrypted key shown until first connect, active only when data flows", async () => {
    const fake = makeFakeWazuh();
    setWazuhTransport(fake.transport);
    const o = await biz();
    const r = await registerServer(o.actor, { displayName: "web-01", environment: "VPS", os: "LINUX_DEB" });
    expect(r.compatible).toBe(true);
    const agentId = r.server.wazuhAgentId!;
    const key = fake.agents.get(agentId)!.key;
    expect(r.server.keyEnc).toMatch(/^v1\./);
    expect(r.server.keyEnc).not.toContain(key);
    expect(JSON.stringify(r.install)).toContain(key);
    expect(JSON.stringify(await installFor(o.actor, r.server.id))).toContain(key);

    // Not installed yet: no claim of monitoring.
    await syncServers();
    let ov = await serverOverview(o.org.id);
    expect(ov.servers[0]).toMatchObject({ status: "PENDING_INSTALL", sendingData: false, installAvailable: true });
    expect(JSON.stringify(ov)).not.toContain(key);

    // Agent connects and reports.
    Object.assign(fake.agents.get(agentId)!, { status: "active", lastKeepAlive: new Date().toISOString(), version: "Wazuh v4.14.9", os: { name: "Ubuntu", version: "24.04" } });
    // Alerts arrive after the agent was registered.
    const t = (n: number) => new Date(Date.now() + (6 - n) * 1000).toISOString();
    fake.alerts.push(
      { id: "1700000000.1", timestamp: t(5), rule: { id: "550", level: 7, description: "Integrity checksum changed.", groups: ["ossec", "syscheck", "syscheck_entry_modified"] }, agent: { id: agentId, name: "x" }, syscheck: { path: "/etc/passwd", event: "modified" }, full_log: "File '/etc/passwd' modified" },
      { id: "1700000000.2", timestamp: t(4), rule: { id: "510", level: 7, description: "Host-based anomaly detection event (rootcheck).", groups: ["ossec", "rootcheck"] }, agent: { id: agentId, name: "x" } },
      { id: "1700000000.3", timestamp: t(3), rule: { id: "5712", level: 10, description: "sshd: brute force trying to get access to the system.", groups: ["syslog", "sshd", "authentication_failures"] }, agent: { id: "999", name: "someone else" } },
    );
    expect(await syncServers()).toMatchObject({ agents: 1, imported: 2 });
    expect(await syncServers()).toMatchObject({ imported: 0 }); // de-duplicated / cursor
    ov = await serverOverview(o.org.id);
    expect(ov.servers[0]).toMatchObject({ status: "ACTIVE", sendingData: true, installAvailable: false, osName: "Ubuntu 24.04" });
    expect(ov.events.map((e) => e.category).sort()).toEqual(["FILE_INTEGRITY", "ROOTKIT"]);
    await expect(installFor(o.actor, r.server.id)).rejects.toMatchObject({ code: "key_consumed" });
    // Every indexer search was restricted to this organization's agent IDs.
    expect(fake.searches.every((q) => JSON.stringify(q).includes(`"agent.id":["${agentId}"]`))).toBe(true);
  });

  it("disconnected agents and tenant isolation", async () => {
    const fake = makeFakeWazuh();
    setWazuhTransport(fake.transport);
    const a = await biz();
    const b = await makeOrg("Other", "OWNER", { plan: "BUSINESS" });
    const ra = await registerServer(a.actor, { displayName: "a-01", environment: "VPS", os: "LINUX_RPM" });
    Object.assign(fake.agents.get(ra.server.wazuhAgentId!)!, { status: "disconnected", lastKeepAlive: new Date(Date.now() - 3600_000).toISOString() });
    await syncServers();
    expect((await serverOverview(a.org.id)).servers[0].status).toBe("DISCONNECTED");
    expect((await serverOverview(b.org.id)).servers).toEqual([]);
    await expect(removeServer(b.actor, ra.server.id)).rejects.toMatchObject({ status: 404 });
    await expect(installFor(b.actor, ra.server.id)).rejects.toMatchObject({ status: 404 });
  });

  it("removal unregisters the agent and deletes its alerts; nothing on the server is changed", async () => {
    const fake = makeFakeWazuh();
    setWazuhTransport(fake.transport);
    const o = await biz();
    const r = await registerServer(o.actor, { displayName: "web-01", environment: "CLOUD_VM", os: "WINDOWS" });
    const res = await removeServer(o.actor, r.server.id);
    expect(res.uninstallHint).toContain("Uninstall");
    expect(fake.agents.size).toBe(0);
    expect(await prisma.serverAgent.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: { in: ["server.registered", "server.removed"] } } })).toBe(2);
  });
});
