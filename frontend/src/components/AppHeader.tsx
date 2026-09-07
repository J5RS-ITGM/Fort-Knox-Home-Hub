"use client";

/** AppHeader — the two-row header used across the browser-facing pages
 *  (dashboard + family modules). Row 1: brand, live status dots, the
 *  arm/disarm segmented control, and admin/sign-out icon buttons. Row 2:
 *  the nav as one equal-width pill strip (flex:1 tabs, active tab filled).
 *  Kiosk sessions get a trimmed set (no Home, Admin, or Sign out). */

import { useState } from "react";
import { usePathname } from "next/navigation";
import { LogOut, Menu, MonitorSmartphone, Settings, X } from "lucide-react";
import KioskGate from "@/components/KioskGate";
import AlarmControl from "@/components/AlarmControl";
import { Lamp } from "@/components/Lamp";
import { logout, useMe , isKiosk } from "@/lib/auth";
import { useHomeHub } from "@/lib/useHomeHub";

const NAV: [string, string][] = [
  ["/panel", "Panel"],
  ["/security", "Security"],
  ["/calendar", "Calendar"],
  ["/gallery", "Gallery"],
  ["/chores", "Chores"],
  ["/todo", "To-Do"],
  ["/recipes", "Recipes"],
  ["/sensors", "Sensors"],
];

export default function AppHeader() {
  const pathname = usePathname();
  const { linkUp, bridgeUp } = useHomeHub();
  const { me, loading } = useMe();
  const [gate, setGate] = useState(false);
  const [menu, setMenu] = useState(false);

  // Kiosk navigates via the bottom tab bar, not this header — both is
  // redundant. Hide until auth resolves to avoid a flash, skip for kiosk.
  if (loading || isKiosk(me)) return null;

  const isAdmin = me?.role === "admin";
  const nav = NAV;

  return (
    <header className="sticky top-0 z-20 hidden border-b border-line bg-field/90 backdrop-blur sm:block">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-3">
        {/* Row 1 — brand · status · alarm · account */}
        <div className="flex items-center gap-2 sm:gap-4">
          {/* mobile menu button */}
          <button onClick={() => setMenu(true)} aria-label="Menu"
                  className="grid size-9 shrink-0 place-items-center rounded-lg border border-line text-ink-muted sm:hidden">
            <Menu size={18} />
          </button>

          <h1 className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-wide">
            Home<span className="text-lamp">Hub</span>
          </h1>

          {/* status dots — labels hidden on mobile to save room */}
          <div className="ml-auto flex items-center gap-2 text-[11px] text-ink-muted sm:gap-3">
            <span className="flex items-center gap-1.5"><Lamp on={linkUp} alert={!linkUp} /><span className="hidden sm:inline">App</span></span>
            <span className="flex items-center gap-1.5"><Lamp on={bridgeUp} alert={!bridgeUp} /><span className="hidden sm:inline">Bridge</span></span>
          </div>

          <div className="hidden h-5 w-px bg-line sm:block" />

          <AlarmControl variant="bar" />

          {/* account icons — hidden on mobile (they live in the drawer) */}
          {isAdmin && (
            <a href="/admin" aria-label="Admin"
               className="hidden size-9 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:border-lamp/50 hover:text-ink sm:grid">
              <Settings size={17} />
            </a>
          )}
          <button onClick={() => setGate(true)} aria-label="Enter kiosk mode" title="Enter kiosk mode"
                  className="hidden size-9 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:border-lamp/50 hover:text-ink sm:grid">
            <MonitorSmartphone size={17} />
          </button>
          <button onClick={() => logout()} aria-label="Sign out"
                  className="hidden size-9 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:border-alert/50 hover:text-ink sm:grid">
            <LogOut size={17} />
          </button>
          {gate && <KioskGate mode="enter" onClose={() => setGate(false)} />}
        </div>

        {/* Row 2 — full nav strip, DESKTOP ONLY (mobile uses the drawer) */}
        <nav className="hidden gap-1 rounded-xl border border-line bg-panel p-1 sm:flex">
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

      {/* Mobile nav drawer */}
      {menu && (
        <div className="fixed inset-0 z-[60] bg-black/60 sm:hidden" onClick={() => setMenu(false)}>
          <div className="absolute left-0 top-0 flex h-full w-64 flex-col gap-1 border-r border-line bg-field p-3" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="font-[family-name:var(--font-display)] text-lg font-semibold">Home<span className="text-lamp">Hub</span></span>
              <button onClick={() => setMenu(false)} aria-label="Close" className="text-ink-muted"><X size={20} /></button>
            </div>
            {nav.map(([href, label]) => (
              <a key={href} href={href}
                 className={`rounded-lg px-3 py-3 text-sm font-medium ${pathname === href ? "bg-panel-raised text-ink" : "text-ink-muted"}`}>
                {label}
              </a>
            ))}
            <div className="mt-2 border-t border-line pt-2">
              {isAdmin && <a href="/admin" className="block rounded-lg px-3 py-3 text-sm text-ink-muted">Admin</a>}
              <button onClick={() => { setMenu(false); setGate(true); }} className="block w-full rounded-lg px-3 py-3 text-left text-sm text-ink-muted">Enter kiosk mode</button>
              <button onClick={() => logout()} className="block w-full rounded-lg px-3 py-3 text-left text-sm text-ink-muted">Sign out</button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
