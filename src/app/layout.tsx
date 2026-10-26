import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TrustifyX Secure360",
  description: "AI-assisted website security monitoring by TrustifyX Private Limited",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
