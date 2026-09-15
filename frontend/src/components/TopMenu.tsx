"use client";

/** TopMenu — the permanent top-level menu for the immersive Panel and
 *  Security pages (replaces the old floating PanelNav popover).
 *
 *  Rules:
 *   - ALWAYS visible for browser/admin sessions on desktop widths.
 *   - NEVER rendered in kiosk mode (server-verified session flag via
 *     /api/auth/me — a kiosk device can't get it back with a refresh;
 *     kiosk navigates with the bottom tab bar instead).
 *   - Not rendered under 640px: phones already have the global MobileNav
 *     top bar + bottom tabs.
 *
 *  While mounted it publishes its height as --fk-menu-h on <html> so the
 *  full-height panel/security shells can subtract it and keep fitting the
 *  viewport exactly. Unmount (kiosk enter, resize to phone) resets it. */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Activity, CalendarDays, ChefHat, Images, LayoutGrid, ListChecks, ListTodo, Shield, SlidersHorizontal } from "lucide-react";
import { isKiosk, useMe } from "@/lib/auth";

export const TOP_MENU_H = 46; // px

const LINKS: [string, string, React.ComponentType<{ size?: number }>][] = [
  ["/panel", "Panel", LayoutGrid],
  ["/security", "Security", Shield],
  ["/calendar", "Calendar", CalendarDays],
  ["/gallery", "Gallery", Images],
  ["/chores", "Tasks", ListChecks],
  ["/todo", "To-Do", ListTodo],
  ["/control", "Control", SlidersHorizontal],
  ["/recipes", "Recipes", ChefHat],
  ["/sensors", "Sensors", Activity],
];

function MenuHeightVar() {
  // separate component so the effect only exists while the bar is shown
  useEffect(() => {
    document.documentElement.style.setProperty("--fk-menu-h", `${TOP_MENU_H}px`);
    return () => { document.documentElement.style.setProperty("--fk-menu-h", "0px"); };
  }, []);
  return null;
}

export default function TopMenu() {
  const pathname = usePathname();
  const { me, loading } = useMe();
  const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.innerWidth >= 640);
  useEffect(() => {
    const check = () => setDesktop(window.innerWidth >= 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Kiosk sessions never see this menu; hide until auth resolves so a
  // kiosk panel never flashes it for a frame.
  if (loading || isKiosk(me) || !desktop) return null;

  return (
    <nav
      aria-label="Main menu"
      style={{
        height: TOP_MENU_H, flexShrink: 0, display: "flex", alignItems: "stretch", gap: 2,
        padding: "0 10px", overflow: "hidden",
        background: "var(--color-field, #0e1118)",
        borderBottom: "1px solid var(--color-line, #262c3b)",
      }}
    >
      <MenuHeightVar />
      <span style={{ display: "flex", alignItems: "center", paddingRight: 12, fontSize: 14, fontWeight: 700, whiteSpace: "nowrap" }}
        className="font-[family-name:var(--font-display)]">
        Home<span style={{ color: "var(--color-lamp, #e8a33d)" }}>Hub</span>
      </span>
      {LINKS.map(([href, label, Icon]) => {
        const active = pathname === href;
        return (
          <a key={href} href={href}
            style={{
              display: "flex", alignItems: "center", gap: 7, textDecoration: "none",
              padding: "0 13px", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap",
              color: active ? "var(--color-lamp, #e8a33d)" : "var(--color-ink-muted, #9199a8)",
              borderBottom: active ? "2px solid var(--color-lamp, #e8a33d)" : "2px solid transparent",
              borderTop: "2px solid transparent", // keeps text vertically centered
              transition: "color .15s",
            }}>
            <Icon size={15} /> {label}
          </a>
        );
      })}
    </nav>
  );
}
