"use client";

/** AppHeader — the two-row header used across the browser-facing pages
 *  (dashboard + family modules). Row 1: brand, live status dots, the
 *  arm/disarm segmented control, and admin/sign-out icon buttons. Row 2:
 *  the nav as one equal-width pill strip (flex:1 tabs, active tab filled).
 *  Kiosk sessions get a trimmed set (no Home, Admin, or Sign out). */

import { usePathname } from "next/navigation";
import { LayoutGrid, LogOut, Settings } from "lucide-react";
import AlarmControl from "@/components/AlarmControl";
import { Lamp } from "@/components/Lamp";
import { logout, useMe } from "@/lib/auth";
import { useHomeHub } from "@/lib/useHomeHub";

const NAV: [string, string][] = [
  ["/", "Home"],
  ["/chores", "Chores"],
  ["/calendar", "Calendar"],
  ["/gallery", "Gallery"],
  ["/panel", "Panel"],
  ["/security", "Security"],
];

export default function AppHeader() {
  const pathname = usePathname();
  const { linkUp, bridgeUp } = useHomeHub();
  const { me, loading } = useMe();

  // Kiosk navigates via the bottom tab bar, not this header — both is
  // redundant. Hide until auth resolves to avoid a flash, skip for kiosk.
  if (loading || me?.role === "kiosk") return null;

  const isAdmin = me?.role === "admin";
  const nav = NAV;

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-field/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-3">
        {/* Row 1 — brand · status · alarm · account */}
        <div className="flex items-center gap-4">
          <h1 className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-wide">
            Home<span className="text-lamp">Hub</span>
          </h1>

          <div className="ml-auto flex items-center gap-3 text-[11px] text-ink-muted">
            <span className="flex items-center gap-1.5"><Lamp on={linkUp} alert={!linkUp} /> App</span>
            <span className="flex items-center gap-1.5"><Lamp on={bridgeUp} alert={!bridgeUp} /> Bridge</span>
          </div>

          <div className="h-5 w-px bg-line" />

          <AlarmControl variant="bar" />

          {isAdmin && (
            <a href="/admin" aria-label="Admin"
               className="grid size-9 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:border-lamp/50 hover:text-ink">
              <Settings size={17} />
            </a>
          )}
          <button onClick={() => logout()} aria-label="Sign out"
                  className="grid size-9 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:border-alert/50 hover:text-ink">
            <LogOut size={17} />
          </button>
        </div>

        {/* Row 2 — equal-width nav strip */}
        <nav className="flex gap-1 rounded-xl border border-line bg-panel p-1">
          {nav.map(([href, label]) => {
            const active = pathname === href;
            return (
              <a key={href} href={href}
                 className={`flex-1 rounded-lg py-2 text-center text-xs font-medium transition-colors ${
                   active ? "bg-panel-raised text-ink" : "text-ink-muted hover:text-ink"
                 }`}>
                {label}
              </a>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
