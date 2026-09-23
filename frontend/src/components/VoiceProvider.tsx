"use client";

/** VoiceProvider — mounted once in the root layout.
 *
 *  Starts the phone line on WALL PANELS and KIOSK sessions only, and shows
 *  the incoming-call and active-call screens globally (every page). Phones
 *  and tablets that leave the house never register: their 911 is the
 *  phone's own dialer (registered E911 address = the house).
 *
 *  z-order: 95 — above the screensaver (40), alarm (45) and leak (46)
 *  popups so a live 911 call is never covered; below the keyboard (120).
 */

import { useEffect, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Volume2 } from "lucide-react";
import { isKiosk, useMe } from "@/lib/auth";
import { usePanelDevice, saverHold, saverWake } from "@/lib/panelDevice";
import { api } from "@/lib/api";
import { voice, useVoice } from "@/lib/voice";

const C = { bg: "#0c1117", card: "#141b24", line: "#243040", ink: "#e8edf2", sub: "#7e8c9c", ok: "#4caf7d", red: "#e0483d", amber: "#e8a33d" };

function fmt(s: number) { const m = Math.floor(s / 60), r = s % 60; return `${m}:${String(r).padStart(2, "0")}`; }

export function useIsPhoneDevice(): boolean {
  const { me } = useMe();
  const panel = usePanelDevice();
  return panel || isKiosk(me);
}

export default function VoiceProvider() {
  const { me } = useMe();
  const panel = usePanelDevice();
  const enabled = !!me && (panel || isKiosk(me));
  const v = useVoice();
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) { setConfigured(null); return; }
    let alive = true;
    api("/api/voice/config").then((r) => (r.ok ? r.json() : null)).then((c) => { if (alive) setConfigured(!!c?.configured); }).catch(() => { if (alive) setConfigured(false); });
    return () => { alive = false; };
  }, [enabled]);

  useEffect(() => {
    if (enabled && configured) void voice.start();
    if (!enabled) void voice.stop();
  }, [enabled, configured]);

  // a ringing or live call keeps the screensaver off and wakes it
  const busy = !!v.incoming || !!v.call;
  useEffect(() => { saverHold("voice", busy); if (busy) saverWake(); return () => saverHold("voice", false); }, [busy]);

  // call timer
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (v.callState !== "active") return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [v.callState]);
  void tick;
  const secs = v.startedAt ? Math.floor((Date.now() - v.startedAt) / 1000) : 0;

  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!busy) return;
    api("/api/voice/numbers").then((r) => (r.ok ? r.json() : [])).then((l: { number: string; name: string }[]) => {
      const m: Record<string, string> = {}; for (const n of l) m[n.number] = n.name; setNames(m);
    }).catch(() => {});
  }, [busy]);
  const who = (raw: string) => names[raw] ?? (raw === "911" ? "911 Emergency" : pretty(raw));

  if (!enabled) return null;

  if (v.incoming) {
    return (
      <Screen>
        <div style={{ fontSize: "clamp(12px, 2.6vmin, 16px)", letterSpacing: "0.2em", textTransform: "uppercase", color: C.sub }}>Incoming call</div>
        <Avatar label={who(v.callTo)} />
        <div style={{ fontSize: "clamp(22px, 6vmin, 34px)", fontWeight: 600, marginTop: 14 }}>{who(v.callTo)}</div>
        {names[v.callTo] && <div style={{ fontSize: "clamp(13px, 3vmin, 18px)", color: C.sub, marginTop: 4 }}>{pretty(v.callTo)}</div>}
        <div style={{ display: "flex", gap: "clamp(48px, 14vmin, 120px)", marginTop: "clamp(30px, 9vmin, 70px)" }}>
          <Round label="Decline" bg={C.red} onClick={() => voice.reject()}><PhoneOff size={36} color="#0c1117" /></Round>
          <Round label="Answer" bg={C.ok} onClick={() => voice.answer()}><Phone size={36} color="#0c1117" /></Round>
        </div>
      </Screen>
    );
  }

  if (v.call) {
    const is911 = v.callTo === "911";
    return (
      <Screen bg={is911 ? "#12090a" : C.bg}>
        {is911 && <div style={{ fontSize: "clamp(12px, 2.6vmin, 16px)", letterSpacing: "0.22em", textTransform: "uppercase", color: "#e8b3ad" }}>Emergency call</div>}
        <Avatar label={who(v.callTo)} />
        <div style={{ fontSize: "clamp(22px, 6vmin, 34px)", fontWeight: 600, marginTop: 14 }}>{who(v.callTo)}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: "clamp(14px, 3.2vmin, 18px)", color: v.callState === "active" ? C.ok : C.sub }}>
          <span style={{ width: 9, height: 9, borderRadius: 999, background: v.callState === "active" ? C.ok : C.sub }} />
          {v.callState === "active" ? fmt(secs) : "Calling…"}
        </div>
        {is911 && v.callState === "active" && (
          <div style={{ marginTop: 10, fontSize: "clamp(12px, 2.6vmin, 15px)", color: "#e8b3ad", maxWidth: 520 }}>
            Stay on the line. If the call drops, the dispatcher can call this panel back.
          </div>
        )}
        <div style={{ display: "flex", gap: "clamp(18px, 5vmin, 28px)", marginTop: "clamp(24px, 6vmin, 40px)" }}>
          <Round label={v.muted ? "Unmute" : "Mute"} bg={v.muted ? C.amber : "#1a2330"} border onClick={() => voice.mute(!v.muted)}>
            {v.muted ? <MicOff size={28} color="#0c1117" /> : <Mic size={28} color={C.ink} />}
          </Round>
          <Round label="Speaker" bg="#22301c" border onClick={() => {}} disabled><Volume2 size={28} color="#b6d99a" /></Round>
        </div>
        <Round label="End call" bg={C.red} size={88} onClick={() => voice.hangup()} style={{ marginTop: "clamp(24px, 6vmin, 44px)" }}>
          <PhoneOff size={34} color="#0c1117" />
        </Round>
      </Screen>
    );
  }
  return null;
}

// ---------------------------------------------------------------- bits
function pretty(raw: string) {
  const d = (raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return raw;
}

function Screen({ children, bg = C.bg }: { children: React.ReactNode; bg?: string }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 95, background: bg, color: C.ink, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center", textAlign: "center", boxSizing: "border-box",
                  padding: "max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))" }}>
      {children}
    </div>
  );
}

function Avatar({ label }: { label: string }) {
  return (
    <span style={{ width: "clamp(84px, 22vmin, 132px)", height: "clamp(84px, 22vmin, 132px)", borderRadius: 999, background: "#1f2b3a",
                   display: "grid", placeItems: "center", fontSize: "clamp(34px, 9vmin, 52px)", fontWeight: 700, color: C.amber, marginTop: 20 }}>
      {label === "911 Emergency" ? "911" : (label[0] ?? "?").toUpperCase()}
    </span>
  );
}

function Round({ children, label, bg, onClick, border, size = 76, disabled, style }:
  { children: React.ReactNode; label: string; bg: string; onClick: () => void; border?: boolean; size?: number; disabled?: boolean; style?: React.CSSProperties }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, ...style }}>
      <button type="button" onClick={onClick} disabled={disabled} aria-label={label}
        style={{ width: size, height: size, borderRadius: 999, border: border ? `1px solid ${C.line}` : "none", background: bg,
                 display: "grid", placeItems: "center", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.7 : 1, touchAction: "manipulation" }}>
        {children}
      </button>
      <span style={{ fontSize: 13, color: C.sub }}>{label}</span>
    </div>
  );
}
