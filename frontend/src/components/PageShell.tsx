"use client";

/** PageShell — shared header + AuthGate wrapper for the family module
 *  pages (Chores, Calendar, Gallery). Keeps the nav consistent with the
 *  dashboard and puts the arm/disarm control everywhere, per the design
 *  rule that the alarm is reachable from every page. */

import { ReactNode } from "react";
import AuthGate from "@/components/AuthGate";
import AppHeader from "@/components/AppHeader";
import BottomTabs, { BOTTOM_TABS_HEIGHT } from "@/components/BottomTabs";
import ErrorBoundary from "@/components/ErrorBoundary";

export default function PageShell({ title, active, children }: { title: string; active: string; children: ReactNode }) {
  return (
    <AuthGate>
      <div className="min-h-dvh">
        <ErrorBoundary><AppHeader /></ErrorBoundary>

        <main className="mx-auto max-w-5xl px-4 py-6" style={{ paddingBottom: BOTTOM_TABS_HEIGHT + 32 }}>
          <h2 className="mb-5 text-xl font-semibold">{title}</h2>
          {children}
        </main>
        <BottomTabs />
      </div>
    </AuthGate>
  );
}
