"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { BrandMark } from "./BrandMark";

const LINKS = [
  { href: "/#home", label: "Home" },
  { href: "/#features", label: "Features" },
  { href: "/#how-it-works", label: "How It Works" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#why-trustifyx", label: "Why TrustifyX" },
  { href: "/#faqs", label: "FAQs" },
];

export function MarketingNav({ loggedIn }: { loggedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`sticky top-0 z-50 transition-colors ${scrolled || open ? "border-b border-slate-200 bg-white/95 shadow-sm backdrop-blur" : "bg-white/80 backdrop-blur"}`}>
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6" aria-label="Main">
        <Link href="/" className="flex items-center gap-2 font-display text-lg font-bold text-navy-950" onClick={() => setOpen(false)}>
          <BrandMark className="h-8 w-8" />
          <span>
            TrustifyX <span className="text-royal-600">Secure360</span>
          </span>
        </Link>

        <ul className="hidden items-center gap-1 lg:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-navy-950">
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="hidden items-center gap-2 lg:flex">
          {loggedIn ? (
            <Link href="/dashboard" className="mk-btn mk-btn-primary">
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="mk-btn mk-btn-ghost">
                Login
              </Link>
              <a href="/#pricing" className="mk-btn mk-btn-primary">
                Get Started
              </a>
            </>
          )}
        </div>

        <button
          className="rounded-md p-2 text-navy-950 hover:bg-slate-100 lg:hidden"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={open ? "x" : "menu"} className="h-6 w-6" />
        </button>
      </nav>

      {open && (
        <div id="mobile-menu" className="border-t border-slate-200 bg-white px-4 pb-6 lg:hidden">
          <ul className="space-y-1 pt-3">
            {LINKS.map((l) => (
              <li key={l.href}>
                <a href={l.href} onClick={() => setOpen(false)} className="block rounded-md px-3 py-2.5 text-base font-medium text-slate-700 hover:bg-slate-100">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-4 grid gap-2">
            {loggedIn ? (
              <Link href="/dashboard" className="mk-btn mk-btn-primary w-full">
                Go to dashboard
              </Link>
            ) : (
              <>
                <Link href="/login" className="mk-btn mk-btn-ghost w-full">
                  Login
                </Link>
                <a href="/#pricing" onClick={() => setOpen(false)} className="mk-btn mk-btn-primary w-full">
                  Get Started
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
