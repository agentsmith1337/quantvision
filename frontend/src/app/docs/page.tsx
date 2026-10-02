"use client";

import Link from "next/link";
import { SdkReference } from "@/components/scripts/sdk-reference";

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
        <span className="text-muted">Write strategies in the Studio or the Trading Dashboard&apos;s Script tab.</span>
        <Link href="/backtest/" className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg">
          Open Studio
        </Link>
      </div>
      <SdkReference />
    </div>
  );
}
