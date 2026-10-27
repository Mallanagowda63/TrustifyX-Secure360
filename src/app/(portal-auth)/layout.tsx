import type { Metadata } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import { BrandMark } from "@/components/marketing/BrandMark";
import { SecurityIllustration } from "@/components/portal/SecurityIllustration";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta", weight: ["600", "700", "800"], display: "swap" });

export const metadata: Metadata = {
  title: "Sign in · TrustifyX Secure360 Portal",
  robots: { index: false, follow: false },
};

export default function PortalAuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${inter.variable} ${jakarta.variable} portal-font grid min-h-screen bg-[#050b1a] lg:grid-cols-[1.1fr_1fr]`}>
      <aside className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_20%,rgba(37,99,235,0.35),transparent_55%),radial-gradient(ellipse_at_80%_80%,rgba(20,184,166,0.25),transparent_55%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:44px_44px]" />
        <div className="relative flex items-center gap-2 font-display text-lg font-bold text-white">
          <BrandMark className="h-8 w-8" /> TrustifyX <span className="text-royal-400">Secure360</span>
          <span className="ml-2 rounded-md border border-white/15 px-2 py-0.5 text-[11px] font-medium tracking-wide text-slate-300 uppercase">Security Portal</span>
        </div>
        <div className="relative mx-auto w-full max-w-lg">
          <SecurityIllustration />
        </div>
        <ul className="relative grid grid-cols-3 gap-4 text-xs text-slate-400">
          <li><span className="block font-semibold text-slate-200">Availability</span>Checks every 5 minutes</li>
          <li><span className="block font-semibold text-slate-200">SSL/TLS & headers</span>Configuration tracked over time</li>
          <li><span className="block font-semibold text-slate-200">Verified owners</span>Only your verified websites</li>
        </ul>
      </aside>
      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-2 font-display text-lg font-bold text-white lg:hidden">
            <BrandMark className="h-8 w-8" /> TrustifyX <span className="text-royal-400">Secure360</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
