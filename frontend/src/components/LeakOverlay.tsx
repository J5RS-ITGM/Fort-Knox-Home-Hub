"use client";

/** LeakOverlay — full-screen popup the moment any water/leak sensor reports
 *  wet. Names every wet sensor, stays up until acknowledged, and re-arms
 *  automatically if a sensor dries out and trips again (or a new one trips).
 *  Lives in the root alerts host, so it shows on every screen. */

import { useEffect, useMemo, useState } from "react";
import { Droplets } from "lucide-react";

export default function LeakOverlay({ entities }: { entities: Map<string, any> }) {
  const wet = useMemo(() => {
    const out: { id: string; name: string }[] = [];
    entities.forEach((e: any, id: string) => {
      if (!id.startsWith("binary_sensor.")) return;
      if (String(e?.attributes?.device_class ?? "") !== "moisture") return;
      if (e?.state === "on") out.push({ id, name: String(e?.attributes?.friendly_name ?? id).replace(/ water leak detected$/i, "") });
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [entities]);

  // acknowledged set: ids the user has dismissed. A sensor drops out of the
  // set when it dries, so it can alert again next time.
  const [acked, setAcked] = useState<Set<string>>(new Set());
  useEffect(() => {
    setAcked((prev) => {
      const wetIds = new Set(wet.map((w) => w.id));
      const next = new Set([...prev].filter((id) => wetIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [wet]);

  const showing = wet.filter((w) => !acked.has(w.id));
  if (showing.length === 0) return null;

  const P = { card: "#061a24", border: "#3aa0e6", ink: "#8fd0ff", btn: "#3aa0e6", btnInk: "#061a24", scrim: "rgba(6,18,30,0.55)", glow: "rgba(58,160,230,0.55)" };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 46, display: "flex", alignItems: "center", justifyContent: "center",
                  pointerEvents: "none", boxSizing: "border-box",
                  padding: "max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left))" }}>
      <div style={{ position: "absolute", inset: 0, background: P.scrim, pointerEvents: "none" }} />
      <div style={{ position: "relative", pointerEvents: "auto", width: "min(100%, 680px)", maxHeight: "100%", overflow: "hidden",
                    boxSizing: "border-box", borderRadius: 22, padding: "clamp(16px, 4vmin, 44px)", textAlign: "center",
                    background: P.card, border: `3px solid ${P.border}`,
                    animation: "hh-leakglow 1s ease-in-out infinite", ["--hh-glow" as string]: P.glow }}>
        <Droplets color={P.ink} style={{ marginBottom: 6, width: "clamp(28px, 7vmin, 46px)", height: "clamp(28px, 7vmin, 46px)" }} />
        <div style={{ fontSize: "clamp(14px, 3.4vmin, 26px)", fontWeight: 800, letterSpacing: 2, color: P.ink, opacity: .85 }}>WATER DETECTED</div>
        {showing.map((w) => (
          <div key={w.id} style={{ fontSize: showing.length > 1 ? "clamp(22px, 6.5vmin, 60px)" : "clamp(28px, 9.5vmin, 88px)",
                                   fontWeight: 900, lineHeight: 1.06, color: P.ink, margin: "6px 0 2px", textTransform: "uppercase",
                                   overflowWrap: "anywhere", wordBreak: "break-word" }}>{w.name}</div>
        ))}
        <div style={{ fontSize: "clamp(13px, 2.8vmin, 22px)", fontWeight: 700, color: P.ink, opacity: .8, marginTop: 4 }}>
          Check the sensor and shut off the water if needed
        </div>
        <button onClick={() => setAcked((s) => new Set([...s, ...showing.map((w) => w.id)]))}
          style={{ marginTop: "clamp(14px, 3vmin, 28px)", padding: "clamp(12px,2.6vmin,18px) clamp(28px,8vmin,64px)",
                   fontSize: "clamp(16px, 3vmin, 22px)", fontWeight: 800, borderRadius: 14, border: "none",
                   cursor: "pointer", background: P.btn, color: P.btnInk, touchAction: "manipulation" }}>
          Acknowledge
        </button>
      </div>
      <style>{`@keyframes hh-leakglow{0%,100%{box-shadow:0 0 0 0 var(--hh-glow),0 18px 60px rgba(0,0,0,.55)}50%{box-shadow:0 0 0 14px transparent,0 18px 60px rgba(0,0,0,.55);border-color:#fff}}`}</style>
    </div>
  );
}
