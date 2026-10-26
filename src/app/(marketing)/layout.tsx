import type { Metadata } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import { getPageSession } from "@/server/auth/page";
import { env } from "@/server/env";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { Footer } from "@/components/marketing/Footer";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta", weight: ["600", "700", "800"], display: "swap" });

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const base = env().APP_URL;
  return {
    metadataBase: new URL(base),
    title: { default: "TrustifyX Secure360: AI-assisted website security monitoring", template: "%s · TrustifyX Secure360" },
    description:
      "Monitor website availability, SSL/TLS certificates, HTTP security headers and DNS changes from one AI-assisted cybersecurity dashboard. Plans from ₹999/month.",
    openGraph: {
      type: "website",
      siteName: "TrustifyX Secure360",
      title: "Secure your website. Protect your business. Powered by AI.",
      description: "Automated website security monitoring with clear findings and AI-assisted recommendations.",
      url: base,
    },
    robots: { index: true, follow: true },
  };
}

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const session = await getPageSession();
  const e = env();
  return (
    <div className={`marketing ${inter.variable} ${jakarta.variable} min-h-screen`}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow">
        Skip to content
      </a>
      <MarketingNav loggedIn={Boolean(session)} />
      <main id="main">{children}</main>
      <Footer supportEmail={e.SUPPORT_EMAIL} securityEmail={e.SECURITY_EMAIL} />
    </div>
  );
}
