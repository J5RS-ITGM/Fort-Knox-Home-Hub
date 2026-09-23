"use client";

/** panelDevice — "this screen is a wall panel" flag, per DEVICE (browser),
 *  independent of any login or session.
 *
 *  Why it exists: the on-screen keyboard used to switch on only once the
 *  SESSION was in kiosk mode. On the login screen there is no session, so
 *  a logged-out panel could not be logged back in without a USB keyboard.
 *
 *  How a device becomes a panel:
 *    1. The kiosk launcher opens the app at  /?panel=1  (Edge kiosk command
 *       on the Windows PC, same URL on the Pi later). Seen once, the flag is
 *       stored and survives logouts, expired sessions and reboots.
 *    2. Entering kiosk mode also sets it (belt and braces).
 *    3. The Keyboard button on the login screen sets it for the session only.
 *
 *  Security: the flag ONLY decides whether the on-screen keyboard shows. It
 *  grants nothing — login still needs an account, kiosk mode still needs the
 *  kiosk password (checked server-side). Anyone adding ?panel=1 on a phone
 *  just gets a keyboard.
 */

import { useEffect, useState } from "react";

const KEY = "hh_panel_device";
const EVT = "hh-panel-device";

export function isPanelDevice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (localStorage.getItem(KEY) === "1") return true;
    if (sessionStorage.getItem(KEY) === "1") return true;
  } catch { /* storage blocked */ }
  return false;
}

/** Persistent (launcher URL / kiosk mode) or session-only (login button). */
export function markPanelDevice(persist = true): void {
  try {
    (persist ? localStorage : sessionStorage).setItem(KEY, "1");
  } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(EVT));
}

export function clearPanelDevice(): void {
  try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVT));
}

/** Read ?panel=1 off the URL on first load and remember it. Called once from
 *  the root layout so it runs before any login. */
export function adoptPanelParam(): void {
  if (typeof window === "undefined") return;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("panel") === "1") markPanelDevice(true);
  } catch { /* ignore */ }
}

/** A big touchscreen: coarse pointer AND landscape-tablet-or-wider. Phones
 *  never match (they have their own keyboard); tablets and panels do. */
export function isBigTouchScreen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia("(any-pointer: coarse)").matches && window.innerWidth >= 900;
  } catch { return false; }
}

export function usePanelDevice(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(isPanelDevice());
    sync();
    window.addEventListener(EVT, sync);
    return () => window.removeEventListener(EVT, sync);
  }, []);
  return on;
}

// ---------------------------------------------------------------- saver bus
// Tiny event bus so the screensaver knows when NOT to start (a PIN pad,
// the keyboard or grid editing is open) and when it must wake (a task
// reminder popped). Components hold/release by key; the saver checks the
// set before engaging and wakes on any "hh-saver-wake".

const HOLDS = "__hhSaverHolds";
type W = Window & { [HOLDS]?: Set<string> };

export function saverHold(key: string, on: boolean): void {
  if (typeof window === "undefined") return;
  const w = window as W;
  const set = (w[HOLDS] ??= new Set<string>());
  if (on) set.add(key); else set.delete(key);
}

export function saverHeld(): boolean {
  if (typeof window === "undefined") return false;
  const set = (window as W)[HOLDS];
  return !!set && set.size > 0;
}

export function saverWake(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("hh-saver-wake"));
}

/** Show the screensaver now (Admin preview). `values` = the raw settings
 *  form, so unsaved edits preview as they will look. */
export function saverPreview(values?: Record<string, string>): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("hh-saver-preview", { detail: values ?? null }));
}
