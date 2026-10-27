import { useId } from "react";

export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  // Unique per instance: a gradient defined inside a display:none copy would not render for the others.
  const gradientId = `tx-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2563eb" />
          <stop offset="1" stopColor="#14b8a6" />
        </linearGradient>
      </defs>
      <path d="M16 2.5 5 6.7v8.1c0 6.9 4.7 12.6 11 14.7 6.3-2.1 11-7.8 11-14.7V6.7L16 2.5Z" fill={`url(#${gradientId})`} />
      <path d="m11 16.2 3.4 3.4L21.5 12" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
