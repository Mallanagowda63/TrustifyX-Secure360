import Link from "next/link";
import { BrandMark } from "./BrandMark";

export function Footer({ supportEmail, securityEmail }: { supportEmail: string; securityEmail: string }) {
  const year = new Date().getFullYear();
  return (
    <footer className="bg-navy-950 text-slate-300">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <div className="flex items-center gap-2 font-display text-lg font-bold text-white">
            <BrandMark className="h-8 w-8" /> TrustifyX Secure360
          </div>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-slate-400">
            External website security monitoring with AI-assisted explanations, built by TrustifyX Private Limited for businesses that
            want clear, verified insight into their websites.
          </p>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">Product</h2>
          <ul className="mt-4 space-y-2 text-sm">
            <li><a href="/#features" className="hover:text-white">Features</a></li>
            <li><a href="/#pricing" className="hover:text-white">Pricing</a></li>
            <li><a href="/#how-it-works" className="hover:text-white">How it works</a></li>
            <li><Link href="/login" className="hover:text-white">Customer login</Link></li>
          </ul>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">Company</h2>
          <ul className="mt-4 space-y-2 text-sm">
            <li><Link href="/about" className="hover:text-white">About TrustifyX</Link></li>
            <li><Link href="/contact" className="hover:text-white">Contact</Link></li>
            <li><Link href="/security-disclosure" className="hover:text-white">Security disclosure</Link></li>
          </ul>
        </div>
        <div>
          <h2 className="text-sm font-semibold text-white">Legal</h2>
          <ul className="mt-4 space-y-2 text-sm">
            <li><Link href="/legal/privacy" className="hover:text-white">Privacy Policy</Link></li>
            <li><Link href="/legal/terms" className="hover:text-white">Terms of Service</Link></li>
            <li><Link href="/legal/refunds" className="hover:text-white">Refund &amp; Cancellation Policy</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-xs text-slate-500 sm:flex-row sm:justify-between sm:px-6">
          <p>© {year} TrustifyX Private Limited. All rights reserved.</p>
          <p>
            Support: <a className="hover:text-white" href={`mailto:${supportEmail}`}>{supportEmail}</a> · Security:{" "}
            <a className="hover:text-white" href={`mailto:${securityEmail}`}>{securityEmail}</a>
          </p>
        </div>
      </div>
    </footer>
  );
}
