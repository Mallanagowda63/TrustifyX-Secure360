import type { ReactNode } from "react";

/** Layout for policy pages. Drafts carry a visible review notice until legal sign-off. */
export function LegalPage({ title, updated, draft = true, children }: { title: string; updated: string; draft?: boolean; children: ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="font-display text-4xl font-bold tracking-tight text-navy-950">{title}</h1>
      <p className="mt-2 text-sm text-slate-500">Last updated: {updated}</p>
      {draft && (
        <div role="note" className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>Draft for review.</strong> This document was prepared as a starting point and must be reviewed by a qualified legal and
          tax professional before TrustifyX Secure360 accepts live payments.
        </div>
      )}
      <div className="legal-body mt-10 space-y-6 text-[15px] leading-7 text-slate-700 [&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-navy-950 [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1.5 [&_a]:text-royal-700 [&_a]:underline">
        {children}
      </div>
    </article>
  );
}
