import Link from "next/link";
import { Logo } from "@/components/Logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,#14223f_0%,#060d1f_60%)] px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link href="/" className="inline-flex items-center gap-2 text-lg font-semibold">
            <Logo /> TrustifyX <span className="text-brand">Secure360</span>
          </Link>
          <p className="mt-1 text-sm text-ink-muted">Website security monitoring</p>
        </div>
        {children}
        <p className="mt-6 text-center text-xs text-ink-faint">© TrustifyX Private Limited</p>
      </div>
    </div>
  );
}
