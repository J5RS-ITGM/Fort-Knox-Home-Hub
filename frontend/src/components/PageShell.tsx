"use client";

/** PageShell — shared header + AuthGate wrapper for the family module
 *  pages (Chores, Calendar, Gallery). Keeps the nav consistent with the
 *  dashboard and puts the arm/disarm control everywhere, per the design
 *  rule that the alarm is reachable from every page. */

import { ReactNode } from "react";
import AlarmControl from "@/components/AlarmControl";
import AuthGate from "@/components/AuthGate";
import BottomTabs, { BOTTOM_TABS_HEIGHT } from "@/components/BottomTabs";

const NAV: [string, string][] = [
  ["/", "Home"],
  ["/chores", "Chores"],
  ["/calendar", "Calendar"],
  ["/gallery", "Gallery"],
  ["/panel", "Wall panel"],
  ["/security", "Security"],
];

export default function PageShell({ title, active, children }: { title: string; active: string; children: ReactNode }) {
  return (
    <AuthGate>
      <div className="min-h-dvh">
        <header className="sticky top-0 z-10 border-b border-line bg-field/90 backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
            <h1 className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-wide">
              Home<span className="text-lamp">Hub</span>
            </h1>
            <nav className="flex flex-wrap items-center gap-2">
              {NAV.map(([href, label]) => (
                <a key={href} href={href}
                   className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                     href === active
                       ? "border-lamp/60 text-ink"
                       : "border-line text-ink-muted hover:border-lamp/50 hover:text-ink"
                   }`}>
                  {label}
                </a>
              ))}
            </nav>
            <div className="ml-auto"><AlarmControl variant="compact" /></div>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6" style={{ paddingBottom: BOTTOM_TABS_HEIGHT + 32 }}>
          <h2 className="mb-5 text-xl font-semibold">{title}</h2>
          {children}
        </main>
        <BottomTabs />
      </div>
    </AuthGate>
  );
}
