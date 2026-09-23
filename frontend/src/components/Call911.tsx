"use client";

/** Call911 — full-screen press-and-hold 911 screen for wall panels.
 *
 *  The call is placed ONLY after a person holds the button for the full
 *  hold duration (Admin → Phone & 911, default 2 s). Release early = cancel,
 *  nothing dialled. No PIN: a kid or a guest must be able to call.
 *
 *  On mount the mic permission is warmed so the call connects without a
 *  browser prompt in the way. On phones (not a panel device) this
 *  component is never used — AlarmOverlay shows a tel:911 link instead.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { voice, useVoice, warmMic } from "@/lib/voice";

const RING_R = 138;
const CIRC = 2 * Math.PI * RING_R;

export default function Call911({ onClose }: { onClose: () => void }) {
  const v = useVoice();
  const [cfg, setCfg] = useState<{ number_pretty: string; e911_address: string; hold_secs: number } | null>(null);
  const [pct, setPct] = useState(0);
  const [phase, setPhase] = useState<"idle" | "holding" | "calling" | "error">("idle");
  const [err, setErr] = useState("");
  const t0 = useRef(0);
  const iv = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api("/api/voice/config").then((r) => (r.ok ? r.json() : null)).then((c) => c && setCfg(c)).catch(() => {});
    void warmMic();
    if (v.status === "off") void voice.start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const holdMs = (cfg?.hold_secs ?? 2) * 1000;

  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    if (phase === "calling") return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setPhase("holding"); setErr("");
    t0.current = Date.now();
    void voice.log("911", "hold_start");
    iv.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0.current) / holdMs);
      setPct(p);
      if (p >= 1) { if (iv.current) clearInterval(iv.current); fire(); }
    }, 50);
  };
  const stop = () => {
    if (phase !== "holding") return;
    if (iv.current) clearInterval(iv.current);
    setPct(0); setPhase("idle");
    void voice.log("911", "hold_cancel");
  };
  const fire = async () => {
    setPhase("calling");
    try {
      if (v.status !== "ready") await voice.start();
      await voice.dial("911", "911");
    } catch (e) {
      setPhase("error"); setPct(0);
      setErr(e instanceof Error ? e.message : "Could not place the call");
    }
  };
  useEffect(() => () => { if (iv.current) clearInterval(iv.current); }, []);

  // once the call is live, the ActiveCall overlay (VoiceProvider) takes over
  useEffect(() => { if (v.call && phase === "calling") onClose(); }, [v.call, phase, onClose]);

  const hint = phase === "calling" ? "Connecting…" : phase === "holding" ? "Keep holding…" : phase === "error" ? "Try again" : "Hold to call";
  const bg = phase === "calling" ? "#b3271d" : phase === "holding" ? "#d13b30" : "#e0483d";
  const notReady = v.status !== "ready";

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 96, background: "#12090a", color: "#e8edf2",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  padding: "max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))", boxSizing: "border-box", textAlign: "center" }}>
      <div style={{ fontSize: "clamp(12px, 2.4vmin, 16px)", letterSpacing: "0.22em", textTransform: "uppercase", color: "#e8b3ad" }}>Emergency call</div>
      {cfg?.e911_address && (
        <>
          <div style={{ fontSize: "clamp(14px, 3vmin, 20px)", color: "#cdd4de", marginTop: 8 }}>Registered to</div>
          <div style={{ fontSize: "clamp(16px, 3.6vmin, 24px)", fontWeight: 600 }}>{cfg.e911_address}</div>
        </>
      )}
      {cfg?.number_pretty && <div style={{ fontSize: "clamp(12px, 2.4vmin, 15px)", color: "#7e8c9c", marginTop: 2 }}>Callback: {cfg.number_pretty}</div>}

      <div style={{ position: "relative", width: "min(60vmin, 300px)", height: "min(60vmin, 300px)", marginTop: "clamp(14px, 4vmin, 30px)" }}>
        <svg viewBox="0 0 300 300" width="100%" height="100%" aria-hidden="true">
          <circle cx="150" cy="150" r={RING_R} fill="none" stroke="#3a1414" strokeWidth="12" />
          <circle cx="150" cy="150" r={RING_R} fill="none" stroke="#ff6a5e" strokeWidth="12" strokeLinecap="round"
                  strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - pct)}
                  style={{ transform: "rotate(-90deg)", transformOrigin: "center", transition: "stroke-dashoffset 0.05s linear" }} />
        </svg>
        <button type="button"
          onPointerDown={start} onPointerUp={stop} onPointerCancel={stop} onPointerLeave={stop}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={`Press and hold for ${cfg?.hold_secs ?? 2} seconds to call 911`}
          style={{ position: "absolute", inset: "9%", borderRadius: 999, border: "none", background: bg, color: "#fff",
                   display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4,
                   cursor: "pointer", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}>
          <span style={{ fontSize: "clamp(30px, 9vmin, 46px)", fontWeight: 800, lineHeight: 1 }}>911</span>
          <span style={{ fontSize: "clamp(12px, 3vmin, 17px)", fontWeight: 600, color: "#ffd9d4" }}>{hint}</span>
        </button>
      </div>

      <div style={{ marginTop: "clamp(12px, 3vmin, 24px)", fontSize: "clamp(12px, 2.6vmin, 15px)", color: err ? "#ff8a7f" : "#9aa4b2", maxWidth: 520 }}>
        {err || (notReady ? (v.status === "error" ? `Phone line problem: ${v.error}` : "Connecting to the phone line…")
                          : "Press and hold the button. Release to cancel.")}
      </div>
      <button type="button" onClick={onClose}
        style={{ marginTop: 18, background: "none", border: "none", color: "#9aa4b2", textDecoration: "underline", fontSize: "clamp(13px, 2.6vmin, 15px)", cursor: "pointer", padding: 12 }}>
        Cancel
      </button>
    </div>
  );
}
