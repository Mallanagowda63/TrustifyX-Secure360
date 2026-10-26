/**
 * Static illustration of the real Secure360 dashboard layout. Always labelled as example data:
 * no live or customer numbers are shown on the public site.
 */
export function ProductPreview() {
  const bars = [62, 58, 70, 64, 55, 72, 66, 61, 59, 68, 63, 57, 65, 60, 71, 62, 58, 66, 61, 64];
  return (
    <div className="relative">
      <div className="absolute -inset-4 rounded-[2rem] bg-gradient-to-tr from-royal-500/30 via-teal-400/20 to-transparent blur-2xl" aria-hidden />
      <figure className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0b1530] shadow-2xl" aria-label="Example Secure360 dashboard with sample data">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
          <span className="ml-3 text-xs text-slate-400">Secure360 · Security overview</span>
          <span className="ml-auto rounded bg-amber-400/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-200 uppercase">Example data</span>
        </div>
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
          {[
            ["Websites", "3"],
            ["Online", "3"],
            ["Open findings", "5"],
            ["Next TLS expiry", "41 days"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-white/10 bg-[#0f1b33] p-3">
              <div className="text-[10px] tracking-wide text-slate-400 uppercase">{k}</div>
              <div className="mt-1 text-lg font-semibold text-white">{v}</div>
            </div>
          ))}
        </div>
        <div className="grid gap-3 px-4 pb-4 sm:grid-cols-5">
          <div className="rounded-lg border border-white/10 bg-[#0f1b33] p-3 sm:col-span-3">
            <div className="text-xs text-slate-300">Response time (example)</div>
            <div className="mt-3 flex h-24 items-end gap-1">
              {bars.map((h, i) => (
                <div key={i} className="flex-1 rounded-t bg-gradient-to-t from-royal-600/60 to-royal-400" style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
          <div className="space-y-2 rounded-lg border border-white/10 bg-[#0f1b33] p-3 sm:col-span-2">
            <div className="text-xs text-slate-300">Findings (example)</div>
            {[
              ["Medium", "#fab219", "HSTS header missing"],
              ["Low", "#86b6ef", "CSP header missing"],
              ["Info", "#9fb0cc", "No CAA record"],
            ].map(([sev, color, title]) => (
              <div key={title} className="flex items-center gap-2 text-[11px]">
                <span className="rounded border px-1.5 py-0.5 font-semibold text-white" style={{ borderColor: color }}>
                  {sev}
                </span>
                <span className="truncate text-slate-300">{title}</span>
              </div>
            ))}
          </div>
        </div>
        <figcaption className="sr-only">Illustration with example values, not real monitoring results.</figcaption>
      </figure>
    </div>
  );
}
