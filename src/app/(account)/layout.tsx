import Link from "next/link";
import { redirect } from "next/navigation";
import { getPageSession } from "@/server/auth/page";
import { Logo } from "@/components/Logo";
import { SignOutButton } from "@/components/SignOutButton";

export const dynamic = "force-dynamic";

/** Marketing-site account area: subscription, billing and the way into the Security Portal. */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const s = await getPageSession();
  if (!s) redirect("/login?next=/account");
  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,#14223f_0%,#060d1f_60%)]">
      <header className="border-b border-navy-700 bg-navy-950/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Logo /> <span className="hidden sm:inline">TrustifyX</span> <span className="text-brand">Secure360</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm" aria-label="Account">
            <Link href="/account" className="rounded-md px-3 py-2 text-ink-muted hover:bg-navy-800 hover:text-ink">Account</Link>
            <Link href="/account/billing" className="rounded-md px-3 py-2 text-ink-muted hover:bg-navy-800 hover:text-ink">Billing</Link>
            <a href="/sso/open?target=portal&next=%2Faccount-security" className="rounded-md px-3 py-2 text-ink-muted hover:bg-navy-800 hover:text-ink">Account Security</a>
            <a href="/sso/open?target=portal&next=%2F" className="btn btn-primary ml-1 py-1.5">Open Security Dashboard</a>
            <SignOutButton className="btn btn-ghost ml-1 py-1.5" redirectTo="/" />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <p className="mb-6 text-sm text-ink-muted">
          Signed in as <b className="text-ink">{s.user.email}</b>
          {s.org ? <> · {s.org.name}</> : null}
        </p>
        {children}
      </main>
    </div>
  );
}
