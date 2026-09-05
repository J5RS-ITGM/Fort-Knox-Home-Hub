"use client";

/** Theme system — three presets (light / moderate / dark) plus an optional
 *  accent-color override. The presets live in globals.css under
 *  [data-theme]; this module flips that attribute and the --accent-user
 *  var, persists the choice, and exposes the resolved palette to the WebGL
 *  surfaces (which can't read Tailwind classes).
 *
 *  Source of truth order: server settings (Admin → Settings) → localStorage
 *  mirror → default "dark". Admin edits win and sync to every device. */

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

export type ThemeName = "light" | "moderate" | "dark";
export const THEMES: ThemeName[] = ["light", "moderate", "dark"];
const LS_THEME = "hh_theme";
const LS_ACCENT = "hh_accent";

export interface ThemeState { theme: ThemeName; accent: string | null; }

function isTheme(v: unknown): v is ThemeName {
  return v === "light" || v === "moderate" || v === "dark";
}
const validHex = (v: string | null | undefined): v is string => !!v && /^#[0-9a-fA-F]{6}$/.test(v);

/** Apply to the document immediately (no React needed — used pre-paint). */
export function applyTheme(theme: ThemeName, accent: string | null) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  if (validHex(accent)) root.style.setProperty("--accent-user", accent);
  else root.style.removeProperty("--accent-user");
}

/** Read the CURRENT resolved palette from CSS (post-theme) for WebGL use. */
export function resolvedPalette(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const g = (name: string, fb: string) => (s.getPropertyValue(name).trim() || fb);
  return {
    field: g("--color-field", "#0c1117"),
    panel: g("--color-panel", "#141b24"),
    panelRaised: g("--color-panel-raised", "#1a2330"),
    line: g("--color-line", "#243040"),
    ink: g("--color-ink", "#e8edf2"),
    inkMuted: g("--color-ink-muted", "#7e8c9c"),
    accent: g("--color-lamp", "#e8a33d"),
    ok: g("--color-ok", "#4caf7d"),
    alert: g("--color-alert", "#e05252"),
  };
}

/** Surface colors for the WebGL boards, resolved from the current theme.
 *  Status colors (secure/open/motion) stay fixed in the components; only
 *  the surfaces follow the theme so the 3D scene matches the 2D chrome.
 *  Every value is guaranteed a valid #rrggbb — CSS vars can resolve to
 *  "", "rgb(...)", or a whitespace-padded string depending on timing and
 *  browser, and THREE.Color throws on anything it can't parse, which would
 *  crash the whole WebGL mount. */
function toHex(raw: string, fallback: string): string {
  const v = (raw || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return "#" + v.slice(1).split("").map((c) => c + c).join("");
  }
  const m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (m) {
    const h = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, "0");
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }
  return fallback;
}

export function webglSurfaces(): Record<string, string> {
  const DEF = {
    bg0: "#0c1117", bg1: "#141b24", card: "#141b24", cardHi: "#1a2330",
    edge: "#243040", text: "#e8edf2", sub: "#7e8c9c", subDim: "#7e8c9c",
    floor: "#141b24", floorEdge: "#243040", roomFloor: "#1a2330", wall: "#525f82",
  };
  if (typeof window === "undefined") return { ...DEF };
  let p: Record<string, string>;
  try {
    p = resolvedPalette();
  } catch {
    return { ...DEF };
  }
  const field = toHex(p.field, DEF.bg0);
  const isLight = ["#e", "#f", "#d"].some((h) => field.toLowerCase().startsWith(h));
  return {
    bg0: field,
    bg1: toHex(p.panel, DEF.bg1),
    card: toHex(p.panel, DEF.card),
    cardHi: toHex(p.panelRaised, DEF.cardHi),
    edge: toHex(p.line, DEF.edge),
    text: toHex(p.ink, DEF.text),
    sub: toHex(p.inkMuted, DEF.sub),
    subDim: toHex(p.inkMuted, DEF.subDim),
    floor: isLight ? "#dbe2ec" : toHex(p.panel, DEF.floor),
    floorEdge: toHex(p.line, DEF.floorEdge),
    roomFloor: isLight ? "#e7edf4" : toHex(p.panelRaised, DEF.roomFloor),
    wall: isLight ? "#b8c2d0" : "#525f82",
  };
}

/** Blocking script (in <head>) that sets the theme before first paint so
 *  there's no flash of the default dark theme on a light-themed panel. */
export const themeBootScript = `
(function(){try{
  var t=localStorage.getItem("${LS_THEME}");
  var a=localStorage.getItem("${LS_ACCENT}");
  document.documentElement.setAttribute("data-theme",(t==="light"||t==="moderate"||t==="dark")?t:"dark");
  if(a&&/^#[0-9a-fA-F]{6}$/.test(a))document.documentElement.style.setProperty("--accent-user",a);
}catch(e){}})();
`;

/** App-wide hook: applies + persists theme, and pulls server settings once
 *  so an admin's choice propagates to all panels. Fire a `hh-theme` event
 *  so WebGL components re-read the palette without a prop drill. */
export function useTheme() {
  const [state, setState] = useState<ThemeState>({ theme: "dark", accent: null });

  useEffect(() => {
    // hydrate from localStorage first (already applied by boot script)
    let theme: ThemeName = "dark";
    let accent: string | null = null;
    try {
      const t = localStorage.getItem(LS_THEME);
      if (isTheme(t)) theme = t;
      const a = localStorage.getItem(LS_ACCENT);
      if (validHex(a)) accent = a;
    } catch { /* ignore */ }
    setState({ theme, accent });

    // then reconcile with server (admin-set, cross-device)
    fetch(`${API_URL}/api/ui-settings`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((v: Record<string, string>) => {
        const next: ThemeState = {
          theme: isTheme(v.theme_mode) ? v.theme_mode : theme,
          accent: validHex(v.theme_accent) ? v.theme_accent : accent,
        };
        set(next);
      })
      .catch(() => {});
  }, []);

  const set = (next: ThemeState) => {
    setState(next);
    applyTheme(next.theme, next.accent);
    try {
      localStorage.setItem(LS_THEME, next.theme);
      if (next.accent) localStorage.setItem(LS_ACCENT, next.accent);
      else localStorage.removeItem(LS_ACCENT);
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent("hh-theme"));
  };

  return { ...state, set };
}
