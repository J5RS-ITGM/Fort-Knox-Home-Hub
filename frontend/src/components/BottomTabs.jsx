"use client";

/** BottomTabs — the wall-panel navigation bar. Large touch targets pinned
 *  to the bottom of the screen (thumb/kiosk-friendly), safe-area aware,
 *  shared by the wall panel and the family module pages so every screen
 *  can reach every function without hunting for header links. */

import { usePathname } from "next/navigation";
import { CalendarDays, Home, Images, LayoutGrid, ListChecks, Shield } from "lucide-react";
import { useMe } from "@/lib/auth";

const TABS = [
  { href: "/panel", label: "Panel", Icon: LayoutGrid },
  { href: "/security", label: "Security", Icon: Shield },
  { href: "/chores", label: "Chores", Icon: ListChecks },
  { href: "/calendar", label: "Calendar", Icon: CalendarDays },
  { href: "/gallery", label: "Gallery", Icon: Images },
  { href: "/", label: "Home", Icon: Home },
];

export const BOTTOM_TABS_HEIGHT = 64; // px, excluding safe-area inset

export default function BottomTabs() {
  const pathname = usePathname();
  const { me } = useMe();
  // Kiosk sessions live inside the five family screens: no dashboard tab
  // (and PageShell/pages hide sign-out + admin + deletes for them too).
  const tabs = me?.role === "kiosk" ? TABS.filter((t) => t.href !== "/") : TABS;
  return (
    <nav
      aria-label="Panel navigation"
      style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 40,
        display: "flex", alignItems: "stretch", justifyContent: "space-around",
        height: `calc(${BOTTOM_TABS_HEIGHT}px + env(safe-area-inset-bottom))`,
        paddingBottom: "env(safe-area-inset-bottom)",
        background: "rgba(14,17,24,0.92)", backdropFilter: "blur(10px)",
        borderTop: "1px solid #262c3b",
      }}
    >
      {tabs.map(({ href, label, Icon }) => {
        const active = pathname === href;
        return (
          <a
            key={href}
            href={href}
            style={{
              flex: 1, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 3,
              textDecoration: "none",
              color: active ? "#e8a33d" : "#8a91a0",
              fontSize: 11, fontWeight: 700,
              borderTop: active ? "2px solid #e8a33d" : "2px solid transparent",
              transition: "color .15s",
              touchAction: "manipulation",
            }}
          >
            <Icon size={22} strokeWidth={active ? 2.4 : 2} />
            {label}
          </a>
        );
      })}
    </nav>
  );
}
