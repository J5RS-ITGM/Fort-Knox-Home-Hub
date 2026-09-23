"use client";

/* KioskKeyboard — on-screen keyboard for the wall panel.
 *
 * Active when the session is in kiosk mode, OR when this device is flagged
 * as a wall panel (lib/panelDevice — set by the launcher URL ?panel=1 or by
 * the Keyboard button on the login screen). The device flag is what makes
 * the keyboard available on the LOGIN screen and the kiosk-password prompt,
 * where there is no kiosk session yet. Listens for focus on any
 * text-like <input> or <textarea> (opt out with data-no-osk) and slides a
 * dark QWERTY keyboard up from the bottom. Keys write into the focused
 * element through the native value setter + an `input` event so React
 * controlled components update normally. "Done" (or tapping outside a
 * field) closes it.
 */

import { useEffect, useRef, useState } from "react";
import { useMe, isKiosk } from "@/lib/auth";
import { usePanelDevice, saverHold, adoptPanelParam } from "@/lib/panelDevice";

/** Ask the keyboard to open on an element (login screen Keyboard button).
 *  Also flips the keyboard active for this session even on an unflagged
 *  device, so a brand-new panel can log in. */
export function openOsk(el: HTMLElement | null): void {
  window.dispatchEvent(new CustomEvent("hh-osk-open", { detail: el }));
}
export function closeOsk(): void {
  window.dispatchEvent(new CustomEvent("hh-osk-open", { detail: null }));
}

const C = {
  bg: "#161a24", key: "#20242f", keyAlt: "#262b38", edge: "#2a3040",
  text: "#e8ebf4", sub: "#8b93a7", accent: "#6b8afd",
};

const ROW_NUM = ["1","2","3","4","5","6","7","8","9","0"];
const ROWS_ABC = [["q","w","e","r","t","y","u","i","o","p"],["a","s","d","f","g","h","j","k","l"],["z","x","c","v","b","n","m"]];
const ROWS_SYM = [["!","@","#","$","%","&","*","(",")","-"],["_","+","=","/",":",";","\"","'","?"],[",",".","~","|","\\","[","]"]];

const TEXTY = new Set(["text","search","email","url","tel","password","number",""]);

function isTexty(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if ((el as HTMLElement).dataset?.noOsk !== undefined) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return TEXTY.has(((el as HTMLInputElement).type || "").toLowerCase());
}

function writeValue(el: HTMLInputElement | HTMLTextAreaElement, next: string) {
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export default function KioskKeyboard() {
  const { me } = useMe();
  const [target, setTarget] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [shift, setShift] = useState(false);
  const [sym, setSym] = useState(false);
  const kbRef = useRef<HTMLDivElement>(null);
  const panel = usePanelDevice();
  const [forced, setForced] = useState(false);   // login-screen Keyboard button
  const active = isKiosk(me) || panel || forced;

  // While OUR keyboard is up the field must not also pop the OS keyboard
  // (Windows touch keyboard on the kiosk PC): inputmode=none tells the
  // browser to keep it closed. Restored when the field loses the target.
  const prevInputMode = useRef<string | null>(null);
  useEffect(() => {
    if (!target) return;
    const el = target;
    prevInputMode.current = el.getAttribute("inputmode");
    el.setAttribute("inputmode", "none");
    return () => {
      // "none" is only ever ours (set on pointerdown above), so drop it too
      if (prevInputMode.current === null || prevInputMode.current === "none") el.removeAttribute("inputmode");
      else el.setAttribute("inputmode", prevInputMode.current);
    };
  }, [target]);

  // Tell the screensaver not to start mid-typing, and let the login screen
  // relabel its button ("Keyboard" / "Hide keyboard").
  useEffect(() => {
    saverHold("osk", !!target);
    window.dispatchEvent(new CustomEvent("hh-osk-state", { detail: !!target }));
    return () => saverHold("osk", false);
  }, [target]);

  // ?panel=1 on the launcher URL flags this device once, before any login.
  useEffect(() => { adoptPanelParam(); }, []);

  // Explicit open/close requests (login Keyboard button, KioskGate).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const el = (e as CustomEvent<HTMLElement | null>).detail;
      if (!el) { setTarget(null); return; }
      setForced(true);
      if (isTexty(el)) {
        el.setAttribute("inputmode", "none");   // before focus, so the OS keyboard never appears
        setTarget(el); setSym(false);
        el.focus();
      }
    };
    window.addEventListener("hh-osk-open", onOpen);
    return () => window.removeEventListener("hh-osk-open", onOpen);
  }, []);

  useEffect(() => {
    if (!active) return;
    const onFocus = (e: FocusEvent) => {
      const el = e.target as Element;
      if (isTexty(el)) {
        setTarget(el);
        setSym(false);
        setTimeout(() => (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" }), 120);
      }
    };
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element;
      if (kbRef.current?.contains(el)) return;      // taps on the keyboard keep focus
      if (isTexty(el)) {                             // moving between fields keeps it open;
        el.setAttribute("inputmode", "none");        // pre-empt the OS keyboard on the new field
        return;
      }
      setTarget(null);
    };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [active]);

  if (!active || !target) return null;

  const insert = (ch: string) => {
    const el = target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    writeValue(el, el.value.slice(0, start) + ch + el.value.slice(end));
    const pos = start + ch.length;
    try { el.setSelectionRange(pos, pos); } catch { /* number inputs */ }
    el.focus();
    if (shift) setShift(false);
  };
  const backspace = () => {
    const el = target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const from = start === end ? Math.max(0, start - 1) : start;
    writeValue(el, el.value.slice(0, from) + el.value.slice(end));
    try { el.setSelectionRange(from, from); } catch { /* number inputs */ }
    el.focus();
  };
  const done = () => {
    const el = target;
    setTarget(null);
    el.blur();
    // let forms react to Enter-like completion
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };

  // Kid-sized keys: the panel keyboard is used by small fingers, so the
  // board runs nearly full width with tall keys and large glyphs.
  const keyStyle = (alt = false): React.CSSProperties => ({
    background: alt ? C.keyAlt : C.key, border: `1px solid ${C.edge}`, color: alt ? C.sub : C.text,
    borderRadius: 10, padding: "22px 0", fontSize: 24, fontWeight: 600, cursor: "pointer",
    userSelect: "none", touchAction: "manipulation",
  });
  const rows = sym ? ROWS_SYM : ROWS_ABC;

  return (
    <div ref={kbRef}
      style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 120,
        background: C.bg, borderTop: `1px solid ${C.edge}`, padding: "10px 12px calc(10px + env(safe-area-inset-bottom))" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(10,1fr)", gap: 8 }}>
          {ROW_NUM.map((k) => (
            <button key={k} style={keyStyle()} onPointerDown={(e) => { e.preventDefault(); insert(k); }}>{k}</button>
          ))}
        </div>
        {rows.map((row, i) => (
          <div key={i} style={{ display: "grid",
            gridTemplateColumns: i === 2 && !sym ? `1.4fr repeat(${row.length},1fr) 1.4fr`
              : row.length < 10 ? `0.5fr repeat(${row.length},1fr) 0.5fr` : `repeat(${row.length},1fr)`, gap: 8 }}>
            {i === 2 && !sym && (
              <button style={{ ...keyStyle(true), background: shift ? C.accent : C.keyAlt, color: shift ? "#0c0e13" : C.sub }}
                aria-label="Shift" onPointerDown={(e) => { e.preventDefault(); setShift((v) => !v); }}>⇧</button>
            )}
            {row.length < 10 && !(i === 2 && !sym) && <span />}
            {row.map((k) => (
              <button key={k} style={keyStyle()}
                onPointerDown={(e) => { e.preventDefault(); insert(shift && !sym ? k.toUpperCase() : k); }}>
                {shift && !sym ? k.toUpperCase() : k}
              </button>
            ))}
            {i === 2 && !sym && (
              <button style={keyStyle(true)} aria-label="Backspace"
                onPointerDown={(e) => { e.preventDefault(); backspace(); }}>⌫</button>
            )}
            {row.length < 10 && !(i === 2 && !sym) && (i === 2 && sym ? (
              <button style={keyStyle(true)} aria-label="Backspace"
                onPointerDown={(e) => { e.preventDefault(); backspace(); }}>⌫</button>
            ) : <span />)}
          </div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 4.6fr 1fr 1.6fr", gap: 8 }}>
          <button style={keyStyle(true)} onPointerDown={(e) => { e.preventDefault(); setSym((v) => !v); setShift(false); }}>
            {sym ? "ABC" : "?123"}
          </button>
          <button style={{ ...keyStyle(), color: C.sub, fontSize: 18 }} aria-label="Space"
            onPointerDown={(e) => { e.preventDefault(); insert(" "); }}>space</button>
          <button style={keyStyle()} onPointerDown={(e) => { e.preventDefault(); insert("'"); }}>&apos;</button>
          <button style={{ ...keyStyle(), background: C.accent, border: `1px solid ${C.accent}`, color: "#0c0e13", fontWeight: 800, fontSize: 20 }}
            onPointerDown={(e) => { e.preventDefault(); done(); }}>Done</button>
        </div>
      </div>
    </div>
  );
}
