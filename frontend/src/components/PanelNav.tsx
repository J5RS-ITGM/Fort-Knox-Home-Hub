"use client";

/** PanelNav — a compact navigation overlay for the full-screen Panel and
 *  Security pages. Those surfaces are immersive WebGL with no header, so
 *  without this the only way out is the browser back button. Shows only
 *  when NOT in kiosk mode (kiosk gets the bottom tab bar instead). Floats
 *  top-left so it doesn't fight the board's own top-right controls. */

import { useState } from "react";
import { usePathname } from "next/navigation";
import { CalendarDays, ChevronLeft, Home, Images, LayoutGrid, ListChecks, Menu, Shield, X } from "lucide-react";
import { isKiosk, useMe } from "@/lib/auth";

const LINKS: [string, string, React.ComponentType<{ size?: number }>][] = [
  ["/", "Home", Home],
  ["/chores", "Chores", ListChecks],
  ["/calendar", "Calendar", CalendarDays],
  ["/gallery", "Gallery", Images],
  ["/panel", "Panel", LayoutGrid],
  ["/security", "Security", Shield],
];

export default function PanelNav() {
  const pathname = usePathname();
  const { me, loading } = useMe();
  const [open, setOpen] = useState(false);

  // Kiosk uses the bottom bar; hide until auth resolves to avoid a flash.
  if (loading || isKiosk(me)) return null;

  return (
    <div style={{ position: "fixed", top: "max(12px, env(safe-area-inset-top))", left: 12, zIndex: 45 }}>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          style={{
            display: "flex", alignItems: "center", gap: 7,
            background: "rgba(14,17,24,0.85)", backdropFilter: "blur(8px)",
            border: "1px solid var(--color-line)", borderRadius: 10,
            color: "var(--color-ink)", padding: "8px 12px", fontSize: 13, fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <Menu size={16} /> Menu
        </button>
      ) : (
        <div
          style={{
            background: "rgba(14,17,24,0.95)", backdropFilter: "blur(10px)",
            border: "1px solid var(--color-line)", borderRadius: 12, padding: 6,
            display: "flex", flexDirection: "column", gap: 2, minWidth: 180,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px 6px" }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--color-ink-muted)" }}>Go to</span>
            <button onClick={() => setOpen(false)} aria-label="Close menu"
                    style={{ background: "transparent", border: "none", color: "var(--color-ink-muted)", cursor: "pointer", display: "flex" }}>
              <X size={15} />
            </button>
          </div>
          {LINKS.map(([href, label, Icon]) => {
            const active = pathname === href;
            return (
              <a key={href} href={href}
                 style={{
                   display: "flex", alignItems: "center", gap: 10, textDecoration: "none",
                   padding: "9px 10px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                   color: active ? "var(--color-lamp)" : "var(--color-ink)",
                   background: active ? "color-mix(in srgb, var(--color-lamp) 12%, transparent)" : "transparent",
                 }}>
                <Icon size={16} /> {label}
              </a>
            );
          })}
          <a href="/" style={{
            display: "flex", alignItems: "center", gap: 8, textDecoration: "none",
            marginTop: 2, padding: "9px 10px", borderRadius: 8, fontSize: 12,
            color: "var(--color-ink-muted)", borderTop: "1px solid var(--color-line)",
          }}>
            <ChevronLeft size={15} /> Back to dashboard
          </a>
        </div>
      )}
    </div>
  );
}
