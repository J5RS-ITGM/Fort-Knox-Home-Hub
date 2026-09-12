"use client";

/** MobileNav — the phone navigation, mounted globally so it persists on
 *  every page. Two parts, both hidden on sm+ (desktop uses AppHeader):
 *   - a compact TOP bar: brand + live status dots + arm/disarm control
 *   - a persistent BOTTOM bar: Panel · Calendar · To-Do · More
 *  "More" opens a sheet with the rest of the destinations + account actions.
 *  No horizontal scrolling anywhere. */

import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  Activity, CalendarDays, ChefHat, Images, LayoutGrid, ListChecks, ListTodo,
  LogOut, MonitorSmartphone, MoreHorizontal, Settings, Shield, SlidersHorizontal, X,
} from "lucide-react";
import AlarmControl from "@/components/AlarmControl";
import KioskGate from "@/components/KioskGate";
import { Lamp } from "@/components/Lamp";
import { isKiosk, logout, useMe } from "@/lib/auth";
import { useHomeHub } from "@/lib/useHomeHub";

export const MOBILE_TOP_H = 56;
export const MOBILE_BOTTOM_H = 62;

const PRIMARY: [string, string, React.ComponentType<{ size?: number }>][] = [
  ["/panel", "Panel", LayoutGrid],
  ["/calendar", "Calendar", CalendarDays],
  ["/todo", "To-Do", ListTodo],
];
const MORE: [string, string, React.ComponentType<{ size?: number }>][] = [
  ["/control", "Control", SlidersHorizontal],
  ["/security", "Security", Shield],
  ["/gallery", "Gallery", Images],
  ["/chores", "Tasks", ListChecks],
  ["/recipes", "Recipes", ChefHat],
  ["/sensors", "Sensors", Activity],
];

export default function MobileNav() {
  const pathname = usePathname();
  const { me, loading } = useMe();
  const { linkUp, bridgeUp } = useHomeHub();
  const [more, setMore] = useState(false);
  const [gate, setGate] = useState(false);

  // Hide on auth screens and until we know who's here.
  if (loading || pathname === "/login" || pathname === "/setup") return null;

  const isAdmin = me?.role === "admin";
  const kiosk = isKiosk(me);
  const moreActive = MORE.some(([href]) => href === pathname);

  const tab = (href: string, label: string, Icon: React.ComponentType<{ size?: number }>, active: boolean, onClick?: () => void) => {
    const inner = (
      <>
        <Icon size={21} />
        <span style={{ fontSize: 10, fontWeight: 700 }}>{label}</span>
      </>
    );
    const style: React.CSSProperties = {
      flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 3, textDecoration: "none", background: "transparent", border: "none",
      borderTop: `2px solid ${active ? "var(--color-lamp)" : "transparent"}`,
      color: active ? "var(--color-lamp)" : "var(--color-ink-muted)", cursor: "pointer",
      touchAction: "manipulation", fontFamily: "inherit",
    };
    return onClick
      ? <button key={label} onClick={onClick} style={style} aria-label={label}>{inner}</button>
      : <a key={label} href={href} style={style}>{inner}</a>;
  };

  return (
    <div className="sm:hidden">
      {/* Top bar: brand + status + alarm */}
      <header
        style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 40,
          height: `calc(${MOBILE_TOP_H}px + env(safe-area-inset-top))`,
          paddingTop: "env(safe-area-inset-top)",
          display: "flex", alignItems: "center", gap: 10, padding: "0 12px",
          background: "var(--color-field)",
          borderBottom: "1px solid var(--color-line)",
        }}
      >
        <span className="font-[family-name:var(--font-display)] text-base font-semibold">Home<span className="text-lamp">Hub</span></span>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Lamp on={linkUp} alert={!linkUp} /><Lamp on={bridgeUp} alert={!bridgeUp} />
        </span>
        <div style={{ marginLeft: "auto" }}>
          <AlarmControl variant="compact" />
        </div>
      </header>

      {/* Bottom bar: 4 tabs */}
      <nav
        aria-label="Primary"
        style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 40,
          height: `calc(${MOBILE_BOTTOM_H}px + env(safe-area-inset-bottom))`,
          paddingBottom: "env(safe-area-inset-bottom)",
          display: "flex", alignItems: "stretch",
          background: "var(--color-field)",
          borderTop: "1px solid var(--color-line)",
        }}
      >
        {PRIMARY.map(([href, label, Icon]) => tab(href, label, Icon, pathname === href))}
        {tab("", "More", MoreHorizontal, more || moreActive, () => setMore(true))}
      </nav>

      {/* More sheet */}
      {more && (
        <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.6)" }} onClick={() => setMore(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute", left: 0, right: 0, bottom: 0,
              background: "var(--color-field)", borderTop: "1px solid var(--color-line)",
              borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16,
              paddingBottom: "calc(16px + env(safe-area-inset-bottom))",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>More</span>
              <button onClick={() => setMore(false)} aria-label="Close" style={{ background: "none", border: "none", color: "var(--color-ink-muted)" }}><X size={20} /></button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
              {MORE.map(([href, label, Icon]) => (
                <a key={href} href={href}
                   style={{
                     display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                     padding: "16px 8px", borderRadius: 12, textDecoration: "none",
                     border: "1px solid var(--color-line)",
                     background: pathname === href ? "var(--color-panel-raised)" : "var(--color-panel)",
                     color: pathname === href ? "var(--color-lamp)" : "var(--color-ink)",
                   }}>
                  <Icon size={22} /><span style={{ fontSize: 12, fontWeight: 500 }}>{label}</span>
                </a>
              ))}
            </div>
            <div style={{ marginTop: 14, borderTop: "1px solid var(--color-line)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
              {isAdmin && <a href="/admin" style={{ padding: "12px 8px", borderRadius: 10, textDecoration: "none", color: "var(--color-ink-muted)", fontSize: 14 }}>Admin</a>}
              {!kiosk && <button onClick={() => { setMore(false); setGate(true); }} style={{ textAlign: "left", padding: "12px 8px", borderRadius: 10, background: "none", border: "none", color: "var(--color-ink-muted)", fontSize: 14 }}>Enter kiosk mode</button>}
              {!kiosk && <button onClick={() => logout()} style={{ textAlign: "left", padding: "12px 8px", borderRadius: 10, background: "none", border: "none", color: "var(--color-ink-muted)", fontSize: 14 }}>Sign out</button>}
            </div>
          </div>
        </div>
      )}
      {gate && <KioskGate mode="enter" onClose={() => setGate(false)} />}
    </div>
  );
}
