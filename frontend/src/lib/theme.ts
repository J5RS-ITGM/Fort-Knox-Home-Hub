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
 *  Call on mount and on the `hh-theme` event. */
export function webglSurfaces(): Record<string, string> {
  const p = resolvedPalette();
  const field = p.field.toLowerCase();
  const isLight = ["#e", "#f", "#d"].some((h) => field.startsWith(h));
  return {
    bg0: p.field,
    bg1: p.panel,
    card: p.panel,
    cardHi: p.panelRaised,
    edge: p.line,
    text: p.ink,
    sub: p.inkMuted,
    subDim: p.inkMuted,
    floor: isLight ? "#dbe2ec" : p.panel,
    floorEdge: p.line,
    roomFloor: isLight ? "#e7edf4" : p.panelRaised,
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
    fetch(`/api/ui-settings`, { credentials: "include" })
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
