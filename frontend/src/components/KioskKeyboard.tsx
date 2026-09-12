"use client";

/* KioskKeyboard — on-screen keyboard for the wall panel.
 *
 * Active only when the session is in kiosk mode. Listens for focus on any
 * text-like <input> or <textarea> (opt out with data-no-osk) and slides a
 * dark QWERTY keyboard up from the bottom. Keys write into the focused
 * element through the native value setter + an `input` event so React
 * controlled components update normally. "Done" (or tapping outside a
 * field) closes it.
 */

import { useEffect, useRef, useState } from "react";
import { useMe, isKiosk } from "@/lib/auth";

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
  const active = isKiosk(me);

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
      if (isTexty(el)) return;                       // moving between fields keeps it open
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

  const keyStyle = (alt = false): React.CSSProperties => ({
    background: alt ? C.keyAlt : C.key, border: `1px solid ${C.edge}`, color: alt ? C.sub : C.text,
    borderRadius: 8, padding: "13px 0", fontSize: 16, fontWeight: 500, cursor: "pointer",
    userSelect: "none", touchAction: "manipulation",
  });
  const rows = sym ? ROWS_SYM : ROWS_ABC;

  return (
    <div ref={kbRef}
      style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 120,
        background: C.bg, borderTop: `1px solid ${C.edge}`, padding: "8px 8px calc(8px + env(safe-area-inset-bottom))" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(10,1fr)", gap: 5 }}>
          {ROW_NUM.map((k) => (
            <button key={k} style={keyStyle()} onPointerDown={(e) => { e.preventDefault(); insert(k); }}>{k}</button>
          ))}
        </div>
        {rows.map((row, i) => (
          <div key={i} style={{ display: "grid",
            gridTemplateColumns: i === 2 && !sym ? `1.4fr repeat(${row.length},1fr) 1.4fr`
              : row.length < 10 ? `0.5fr repeat(${row.length},1fr) 0.5fr` : `repeat(${row.length},1fr)`, gap: 5 }}>
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
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 4.6fr 1fr 1.6fr", gap: 5 }}>
          <button style={keyStyle(true)} onPointerDown={(e) => { e.preventDefault(); setSym((v) => !v); setShift(false); }}>
            {sym ? "ABC" : "?123"}
          </button>
          <button style={{ ...keyStyle(), color: C.sub, fontSize: 13 }} aria-label="Space"
            onPointerDown={(e) => { e.preventDefault(); insert(" "); }}>space</button>
          <button style={keyStyle()} onPointerDown={(e) => { e.preventDefault(); insert("'"); }}>&apos;</button>
          <button style={{ ...keyStyle(), background: C.accent, border: `1px solid ${C.accent}`, color: "#0c0e13", fontWeight: 800, fontSize: 14 }}
            onPointerDown={(e) => { e.preventDefault(); done(); }}>Done</button>
        </div>
      </div>
    </div>
  );
}
