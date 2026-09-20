"use client";

/** PinPad — the one touch-first numeric keypad, shared by the alarm control
 *  (arm/disarm) and every lock button. The PIN is verified server-side;
 *  this only collects digits and reports what the server said. */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export const PIN_C = { ink: "#e8ebf2", sub: "#8a91a0", line: "#2a3140", field: "#0f1116", alert: "#e0483d", ok: "#3fb98f" };

export default function PinPad({
  title, tone, error, busy, onSubmit, onCancel,
}: {
  title: string; tone: string; error: string; busy: boolean;
  onSubmit: (pin: string) => void; onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => { if (error) setPin(""); }, [error]);

  const press = (d: string) => setPin((p) => (p.length < 8 ? p + d : p));
  const back = () => setPin((p) => p.slice(0, -1));

  const key = (label: string, onClick: () => void, wide = false) => (
    <button
      key={label}
      onClick={onClick}
      disabled={busy}
      style={{
        gridColumn: wide ? "span 2" : undefined,
        padding: "clamp(14px, 3.5vmin, 22px) 0", fontSize: "clamp(20px, 4.5vmin, 26px)", fontWeight: 700,
        color: PIN_C.ink, background: "#1a2330", border: `1px solid ${PIN_C.line}`,
        borderRadius: 15, cursor: "pointer", touchAction: "manipulation",
      }}
    >
      {label}
    </button>
  );

  if (!mounted) return null;
  return createPortal(
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center",
        overflowY: "auto", padding: "max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))",
        background: "rgba(8,10,14,0.82)", backdropFilter: "blur(6px)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(100%, 340px)", boxSizing: "border-box", padding: "clamp(16px, 4vmin, 24px)", borderRadius: 20,
          background: PIN_C.field, border: `1px solid ${PIN_C.line}`,
          display: "flex", flexDirection: "column", gap: 14,
        }}
      >
        <div style={{ fontSize: "clamp(15px, 3.4vmin, 17px)", fontWeight: 600, color: tone, textAlign: "center", overflowWrap: "anywhere" }}>{title}</div>
        <div style={{ display: "flex", justifyContent: "center", gap: 12, minHeight: 16 }}>
          {Array.from({ length: Math.max(pin.length, 4) }).map((_, i) => (
            <span key={i} style={{
              width: 15, height: 15, borderRadius: 15,
              background: i < pin.length ? tone : "transparent",
              border: `2px solid ${i < pin.length ? tone : PIN_C.line}`,
            }} />
          ))}
        </div>
        <div style={{ minHeight: 16, fontSize: 12, color: PIN_C.alert, textAlign: "center", fontWeight: 600 }}>
          {error}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {["1","2","3","4","5","6","7","8","9"].map((d) => key(d, () => press(d)))}
          {key("⌫", back)}
          {key("0", () => press("0"))}
          {key("✕", onCancel)}
        </div>
        <button
          onClick={() => onSubmit(pin)}
          disabled={busy || pin.length < 4}
          style={{
            padding: "16px 0", fontSize: 16, fontWeight: 800, borderRadius: 14,
            background: pin.length >= 4 ? tone : "#161b26",
            color: pin.length >= 4 ? PIN_C.field : PIN_C.sub,
            border: `1px solid ${pin.length >= 4 ? tone : PIN_C.line}`,
            cursor: pin.length >= 4 ? "pointer" : "default", touchAction: "manipulation",
          }}
        >
          {busy ? "Checking…" : "Confirm"}
        </button>
      </div>
    </div>,
    document.body
  );
}
