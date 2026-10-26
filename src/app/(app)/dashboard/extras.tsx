"use client";

import { useRouter } from "next/navigation";

export function DashboardExtras() {
  const router = useRouter();
  return (
    <>
      <a className="btn btn-ghost" href="/api/reports/pdf?period=monthly">
        ⤓ PDF report
      </a>
      <button className="btn btn-ghost" onClick={() => router.refresh()}>
        ↻ Refresh
      </button>
    </>
  );
}
