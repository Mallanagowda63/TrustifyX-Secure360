import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { aiEnabled, aiProvider } from "@/server/ai/provider";
import { prisma } from "@/server/db";
import { getEntitlement } from "@/server/billing/entitlements";
import Link from "next/link";
import { AiPanel } from "@/components/AiPanel";
import { Notice, PageHeader, Section } from "@/components/ui";
import { Chat } from "./chat";

export default async function AssistantPage() {
  const s = await requirePageSession("website.read");
  const enabled = aiEnabled();
  const allowed = can(s.role, "ai.use");
  const sites = await prisma.website.findMany({ where: { orgId: s.org.id, status: "CONNECTED" }, select: { id: true, hostname: true } });
  const p = aiProvider();
  const ent = await getEntitlement(s.org.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI security assistant"
        subtitle="Answers are grounded only in your verified monitoring data. The assistant explains and recommends; it never makes changes to your infrastructure."
      />
      {!enabled ? (
        <Notice>
          The AI assistant is not configured on this server. An administrator can enable it by setting <code>AI_PROVIDER</code>,{" "}
          <code>AI_API_KEY</code> and optionally <code>AI_MODEL</code> in the environment.
        </Notice>
      ) : !ent.limits.aiAssistant ? (
        <Notice>
          AI security explanations are included in the Growth and Business plans.{" "}
          <Link className="font-semibold underline" href="/billing">
            Upgrade
          </Link>
        </Notice>
      ) : !allowed ? (
        <Notice>Your role (viewer) cannot use the AI assistant. Ask an organization admin for member access.</Notice>
      ) : (
        <>
          <Section title="Prioritised recommendations">
            <p className="mb-3 text-sm text-ink-muted">Ranks your open findings and incidents by evidence and severity, with concrete next steps.</p>
            <AiPanel endpoint="/api/ai/prioritize" label="Prioritise my risks" enabled />
          </Section>
          <Section title="Ask about your websites">
            <Chat sites={sites} />
          </Section>
          <p className="text-xs text-ink-faint">
            Provider: {p?.name} · model {p?.model}. Only sanitised monitoring observations (hostnames, findings, check results, configuration
            changes) are sent. Account details, credentials, emails and verification tokens are never included.
          </p>
        </>
      )}
    </div>
  );
}
