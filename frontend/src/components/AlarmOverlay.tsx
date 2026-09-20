"use client";

/** AlarmOverlay — a large centered alert card that covers the panel when the
 *  alarm is arming, in entry delay, or triggered. Sized to be read across a
 *  dark room at night: the countdown (pending) or the tripped door name
 *  (triggered) is nearly as large as the card. A light scrim keeps the panel
 *  visible behind it and — crucially — pointer-events stay off the scrim, so
 *  every button around the card (nav, arm/disarm) is still usable. Only the
 *  card itself is interactive.
 *
 *  Shows for ANY arm mode (away / home / night): the states it keys off are
 *  the alarm panel's, not the mode.
 *    arming   -> yellow, exit countdown
 *    pending  -> yellow, entry-delay countdown + which door opened
 *    triggered-> red,   ALARM + the tripped sensor named huge
 *  Steady armed_* and disarmed render nothing (the panel shows normally).
 *
 *  The tripped sensor is read from the alarm entity's `changed_by`
 *  attribute; if HA doesn't populate it, we fall back to the most recently
 *  changed OPEN perimeter contact. `onDisarm` routes through the same PIN
 *  flow as the main control (passed in by the panel). */

import { useEffect, useMemo, useRef, useState } from "react";
import { Moon, DoorOpen, TriangleAlert } from "lucide-react";

const PERIMETER_CLASSES = new Set(["door", "window", "garage_door", "opening"]);

// Delay-length hints so the card can show a live countdown even before HA
// exposes a remaining-seconds attribute. Overridden by the entity's own
// delay attributes when present.
const DEFAULT_EXIT = 30;
const DEFAULT_ENTRY = 10;

function prettyName(entity: string | undefined, entitiesById: Map<string, any>) {
  if (!entity) return "Sensor";
  const e = entitiesById.get(entity);
  return (e?.attributes?.friendly_name) || entity.replace(/^binary_sensor\./, "").replace(/_/g, " ");
}

/** Pick the door/window that set off the alarm. Prefer the alarm entity's
 *  changed_by; else the most-recently-changed open perimeter contact. */
function trippedSensorName(alarm: any, entities: Map<string, any>): string {
  const byId = new Map();
  for (const e of entities.values()) byId.set(e.entity_id, e);

  const cb = alarm?.attributes?.changed_by;
  if (cb && typeof cb === "string" && cb.includes(".")) {
    return prettyName(cb, byId);
  }
  // fallback: newest open perimeter contact
  let best = null;
  for (const e of entities.values()) {
    if (!e.entity_id.startsWith("binary_sensor.")) continue;
    const cls = e.attributes?.device_class;
    if (!PERIMETER_CLASSES.has(cls)) continue;
    if (e.state !== "on" && e.state !== "open") continue;
    const t = e.last_changed || e.last_updated || "";
    if (!best || t > best.t) best = { name: e.attributes?.friendly_name || e.entity_id, t };
  }
  return best?.name || "A sensor";
}

export default function AlarmOverlay({ alarm, entities, onDisarm }: {
  alarm: any; entities: Map<string, any>; onDisarm?: () => void;
}) {
  const state = alarm?.state ?? "disarmed";
  const active = state === "arming" || state === "pending" || state === "triggered";

  // Local countdown. Seed from the entity if it exposes remaining seconds,
  // else from our default for the phase; tick down while active.
  const [remain, setRemain] = useState(0);
  const phaseRef = useRef(state);
  useEffect(() => {
    if (!active) { phaseRef.current = state; return; }
    // (re)seed only when the phase changes, so the tick isn't reset each render
    if (phaseRef.current !== state) {
      phaseRef.current = state;
      const attrRemain = Number(
        alarm?.attributes?.remaining ?? alarm?.attributes?.delay ?? NaN
      );
      if (!Number.isNaN(attrRemain) && attrRemain > 0) setRemain(Math.round(attrRemain));
      else setRemain(state === "arming" ? DEFAULT_EXIT : state === "pending" ? DEFAULT_ENTRY : 0);
    }
  }, [state, active, alarm]);

  useEffect(() => {
    if (state !== "arming" && state !== "pending") return;
    const t = setInterval(() => setRemain((r) => (r > 0 ? r - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [state]);

  const doorName = useMemo(
    () => (state === "pending" || state === "triggered") ? trippedSensorName(alarm, entities) : "",
    [state, alarm, entities]);

  if (!active) return null;

  const red = state === "triggered";
  const P = red
    ? { card: "#1e0908", border: "#e0483d", ink: "#f0997b", btn: "#e0483d", btnInk: "#1e0908", scrim: "rgba(30,6,6,0.5)" }
    : { card: "#1c1406", border: "#e8a33d", ink: "#e8a33d", btn: "#e8a33d", btnInk: "#1c1406", scrim: "rgba(6,8,12,0.45)" };
  const pulse = red ? "hh-alarmpulse .7s ease-in-out infinite" : "hh-alarmpulse 1s ease-in-out infinite";

  const Icon = red ? TriangleAlert : state === "pending" ? DoorOpen : Moon;
  const headline = red ? "ALARM" : state === "pending" ? "ENTRY DELAY" : "ARMING";

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex",
                  alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
      {/* scrim: non-interactive, so buttons around the card still work */}
      <div style={{ position: "absolute", inset: 0, background: P.scrim, pointerEvents: "none" }} />

      {/* the card: the only interactive thing in the overlay */}
      <div style={{ position: "relative", pointerEvents: "auto", width: "min(62%, 620px)",
                    boxSizing: "border-box", borderRadius: 22, padding: "clamp(20px, 4vw, 44px)",
                    textAlign: "center", background: P.card, border: `3px solid ${P.border}`,
                    animation: pulse }}>
        <Icon size={red ? 46 : 40} color={P.ink} style={{ marginBottom: 6 }} />

        {red ? (
          // TRIGGERED: the tripped door fills the card, headline small above it
          <>
            <div style={{ fontSize: "clamp(15px, 3.2vw, 26px)", fontWeight: 800, letterSpacing: 2,
                          color: P.ink, opacity: 0.85 }}>{headline}</div>
            <div style={{ fontSize: "clamp(34px, 9vw, 92px)", fontWeight: 900, lineHeight: 1.02,
                          color: P.ink, margin: "6px 0 2px", textTransform: "uppercase",
                          overflowWrap: "anywhere" }}>{doorName}</div>
            <div style={{ fontSize: "clamp(14px, 2.4vw, 22px)", fontWeight: 800, letterSpacing: 3,
                          color: P.ink, opacity: 0.8 }}>INTRUSION</div>
          </>
        ) : (
          // ARMING / ENTRY DELAY: big countdown, door named on entry delay
          <>
            <div style={{ fontSize: "clamp(15px, 3vw, 26px)", fontWeight: 800, letterSpacing: 2,
                          color: P.ink }}>{headline}</div>
            <div style={{ fontSize: "clamp(56px, 15vw, 150px)", fontWeight: 900, lineHeight: 1,
                          fontVariantNumeric: "tabular-nums", color: P.ink }}>{remain}</div>
            <div style={{ fontSize: "clamp(14px, 2.6vw, 22px)", fontWeight: 600, color: P.ink,
                          marginTop: 2, overflowWrap: "anywhere" }}>
              {state === "pending"
                ? <><b style={{ textTransform: "uppercase" }}>{doorName}</b> opened — disarm now</>
                : "Exit now — leaving the house"}
            </div>
          </>
        )}

        {onDisarm && (
          <button onClick={onDisarm}
            style={{ marginTop: "clamp(16px, 3vw, 28px)", padding: "clamp(12px,2.4vw,18px) clamp(28px,7vw,64px)",
                     fontSize: "clamp(16px, 2.6vw, 22px)", fontWeight: 800, borderRadius: 14, border: "none",
                     cursor: "pointer", background: P.btn, color: P.btnInk, touchAction: "manipulation" }}>
            {state === "arming" ? "Cancel" : "Disarm"}
          </button>
        )}
      </div>

      <style>{`@keyframes hh-alarmpulse{0%,100%{opacity:1}50%{opacity:.42}}`}</style>
    </div>
  );
}
