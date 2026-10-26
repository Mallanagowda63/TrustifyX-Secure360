import { requirePageSession } from "@/server/auth/page";
import { listIntegrations } from "@/server/integrations/catalog";
import { PageHeader } from "@/components/ui";

export default async function IntegrationsPage() {
  const s = await requirePageSession("integration.read");
  const integrations = await listIntegrations(s.org.id);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Advanced integrations"
        subtitle="Optional data sources that go beyond external URL monitoring. Each is connected separately with your own credentials, and nothing is shown until real data is available."
      />
      <div className="grid gap-4 md:grid-cols-2">
        {integrations.map((i) => (
          <div key={i.type} className="card flex flex-col p-5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base font-semibold">{i.name}</h2>
              <span
                className={`rounded-md border px-2 py-0.5 text-xs whitespace-nowrap ${i.status === "CONNECTED" ? "border-emerald-500/50 text-emerald-200" : i.status === "ERROR" ? "border-red-500/50 text-red-200" : "border-slate-500/60 text-slate-300"}`}
              >
                {i.status === "CONNECTED" ? "Connected" : i.status === "ERROR" ? "Error" : "Not Connected"}
              </span>
            </div>
            <p className="mt-2 text-sm text-ink-muted">{i.summary}</p>
            <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">Would provide</div>
                <ul className="list-disc space-y-0.5 pl-4 text-ink-muted">
                  {i.provides.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">Requires</div>
                <ul className="list-disc space-y-0.5 pl-4 text-ink-muted">
                  {i.requires.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="mt-auto pt-5">
              <button className="btn btn-ghost" disabled title="This connector is planned and not yet available">
                Connector coming soon
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-faint">
        No security event counts are displayed for integrations that are not connected. Basic monitoring (availability, TLS, headers, DNS)
        works without any of these.
      </p>
    </div>
  );
}
