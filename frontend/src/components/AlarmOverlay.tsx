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
import { api, callService } from "@/lib/api";
import { usePinGate } from "@/lib/pinGate";
import { useMe } from "@/lib/auth";

const ALARM_ENTITY = "alarm_control_panel.homehub";

const PERIMETER_CLASSES = new Set(["door", "window", "garage_door", "opening"]);

// HA's manual alarm panel never reports seconds-remaining, so the countdown
// is computed here: (configured delay for this mode) minus (time since HA
// entered the phase, from the entity's last_changed). The per-mode delays
// come from Admin -> Settings -> Alarm countdowns and must mirror
// arming_time / delay_time in configuration.yaml. Defaults match the
// shipped HA config.
type Mode = "away" | "home" | "night";
type Delays = Record<Mode, { exit: number; entry: number }>;
const DEFAULT_DELAYS: Delays = {
  away:  { exit: 30, entry: 30 },
  home:  { exit: 0,  entry: 30 },
  night: { exit: 30, entry: 10 },
};

function modeOf(armedState: unknown): Mode | null {
  const s = String(armedState ?? "");
  if (s === "armed_away") return "away";
  if (s === "armed_home") return "home";
  if (s === "armed_night") return "night";
  return null;
}

/** Which mode this phase belongs to. Arming -> the mode we're arming INTO
 *  (next_state). Pending -> the mode we WERE armed in (previous_state).
 *  Handles both current and legacy attribute names on the manual panel. */
function phaseMode(alarm: any, state: string): Mode | null {
  const a = alarm?.attributes ?? {};
  if (state === "arming") return modeOf(a.next_state ?? a.post_pending_state);
  if (state === "pending") return modeOf(a.previous_state ?? a.pre_pending_state);
  return null;
}

function parseDelays(v: Record<string, string>): Delays {
  const num = (k: string, fb: number) => {
    const n = Number(v[k]);
    return v[k] !== undefined && v[k] !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n) : fb;
  };
  return {
    away:  { exit: num("alarm_exit_away",  DEFAULT_DELAYS.away.exit),  entry: num("alarm_entry_away",  DEFAULT_DELAYS.away.entry) },
    home:  { exit: num("alarm_exit_home",  DEFAULT_DELAYS.home.exit),  entry: num("alarm_entry_home",  DEFAULT_DELAYS.home.entry) },
    night: { exit: num("alarm_exit_night", DEFAULT_DELAYS.night.exit), entry: num("alarm_entry_night", DEFAULT_DELAYS.night.entry) },
  };
}

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

  // Disarm is handled HERE (PIN pad + service call) rather than by signalling
  // some other component: the overlay is global, and on phones/tablets/other
  // pages there is no alarm tile mounted to receive a signal.
  const { me } = useMe();
  const { run: runPin, pad: disarmPad } = usePinGate();
  const [disarming, setDisarming] = useState(false);
  const [disarmErr, setDisarmErr] = useState("");
  const disarm = async () => {
    if (disarming) return;
    setDisarming(true); setDisarmErr("");
    try {
      const ok = await runPin(
        "PIN to disarm",
        (pin) => callService("alarm_control_panel", "alarm_disarm", ALARM_ENTITY, pin ? { pin } : {}).then(() => undefined),
        { requirePin: Boolean(me?.pin_set) },
      );
      if (ok) onDisarm?.();
      else if (!me?.pin_set) setDisarmErr("Couldn't reach the alarm — try the Disarm tile");
    } catch (e) {
      console.error(e);
      setDisarmErr("Couldn't reach the alarm — try the Disarm tile");
    } finally { setDisarming(false); }
  };

  // Per-mode delay table from Admin settings (falls back to defaults).
  const [delays, setDelays] = useState<Delays>(DEFAULT_DELAYS);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/api/ui-settings")
        .then((r) => (r.ok ? r.json() : {}))
        .then((v) => { if (alive) setDelays(parseDelays(v)); })
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Total length of the current phase, for the mode it belongs to. If HA
  // ever exposes seconds-remaining, prefer that.
  const phaseTotal = useMemo(() => {
    const attrRemain = Number(alarm?.attributes?.remaining ?? alarm?.attributes?.delay ?? NaN);
    if (!Number.isNaN(attrRemain) && attrRemain > 0) return Math.round(attrRemain);
    const m = phaseMode(alarm, state) ?? "away";
    if (state === "arming") return delays[m].exit;
    if (state === "pending") return delays[m].entry;
    return 0;
  }, [alarm, state, delays]);

  // Countdown anchored to when HA actually entered this phase (last_changed),
  // so it's correct even if the panel loaded mid-countdown, and it never
  // drifts from HA's own timer.
  const [remain, setRemain] = useState(0);
  useEffect(() => {
    if (state !== "arming" && state !== "pending") { setRemain(0); return; }
    const started = Date.parse(alarm?.last_changed ?? "") || Date.now();
    const tick = () => setRemain(Math.max(0, phaseTotal - Math.floor((Date.now() - started) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [state, alarm?.last_changed, phaseTotal]);

  const doorName = useMemo(
    () => (state === "pending" || state === "triggered") ? trippedSensorName(alarm, entities) : "",
    [state, alarm, entities]);

  if (!active) return null;

  const red = state === "triggered";
  const P = red
    ? { card: "#1e0908", border: "#e0483d", ink: "#f0997b", btn: "#e0483d", btnInk: "#1e0908", scrim: "rgba(30,6,6,0.45)", glow: "rgba(224,72,61,0.55)" }
    : { card: "#1c1406", border: "#e8a33d", ink: "#e8a33d", btn: "#e8a33d", btnInk: "#1c1406", scrim: "rgba(6,8,12,0.40)", glow: "rgba(232,163,61,0.45)" };
  // Pulse the BORDER/GLOW only. The card body stays solid so the screen
  // never strobes between solid and see-through (which was hard to read).
  const pulse = red ? "hh-alarmglow .7s ease-in-out infinite" : "hh-alarmglow 1.1s ease-in-out infinite";

  const Icon = red ? TriangleAlert : state === "pending" ? DoorOpen : Moon;
  const headline = red ? "ALARM" : state === "pending" ? "ENTRY DELAY" : "ARMING";

  // All type is sized in vmin (the SMALLER viewport edge), so it is as big as
  // the screen allows in either orientation and can never run off-screen:
  // phone portrait, tablet either way, and the 18.5" wall panel all fit.
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 45, display: "flex",
                  alignItems: "center", justifyContent: "center", pointerEvents: "none",
                  padding: "max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left))",
                  boxSizing: "border-box" }}>
      {/* scrim: non-interactive, so buttons around the card still work */}
      <div style={{ position: "absolute", inset: 0, background: P.scrim, pointerEvents: "none" }} />

      {/* the card: the only interactive thing in the overlay */}
      <div style={{ position: "relative", pointerEvents: "auto",
                    width: "min(100%, 680px)", maxHeight: "100%", overflow: "hidden",
                    boxSizing: "border-box", borderRadius: 22, padding: "clamp(16px, 4vmin, 44px)",
                    textAlign: "center", background: P.card, border: `3px solid ${P.border}`,
                    animation: pulse, ["--hh-glow" as string]: P.glow }}>
        <Icon size={red ? 44 : 38} color={P.ink} style={{ marginBottom: 6, width: "clamp(28px, 7vmin, 46px)", height: "clamp(28px, 7vmin, 46px)" }} />

        {red ? (
          // TRIGGERED: the tripped door fills the card, headline small above it
          <>
            <div style={{ fontSize: "clamp(14px, 3.4vmin, 26px)", fontWeight: 800, letterSpacing: 2,
                          color: P.ink, opacity: 0.85 }}>{headline}</div>
            <div style={{ fontSize: "clamp(28px, 9.5vmin, 88px)", fontWeight: 900, lineHeight: 1.04,
                          color: P.ink, margin: "6px 0 2px", textTransform: "uppercase",
                          overflowWrap: "anywhere", wordBreak: "break-word" }}>{doorName}</div>
            <div style={{ fontSize: "clamp(13px, 2.8vmin, 22px)", fontWeight: 800, letterSpacing: 3,
                          color: P.ink, opacity: 0.8 }}>INTRUSION</div>
          </>
        ) : (
          // ARMING / ENTRY DELAY: big countdown, door named on entry delay
          <>
            <div style={{ fontSize: "clamp(14px, 3.2vmin, 26px)", fontWeight: 800, letterSpacing: 2,
                          color: P.ink }}>{headline}</div>
            <div style={{ fontSize: "clamp(56px, 20vmin, 150px)", fontWeight: 900, lineHeight: 1,
                          fontVariantNumeric: "tabular-nums", color: P.ink }}>{remain}</div>
            <div style={{ fontSize: "clamp(14px, 3vmin, 22px)", fontWeight: 600, color: P.ink,
                          marginTop: 2, overflowWrap: "anywhere", wordBreak: "break-word" }}>
              {state === "pending"
                ? <><b style={{ textTransform: "uppercase" }}>{doorName}</b> opened — disarm now</>
                : "Exit now — leaving the house"}
            </div>
          </>
        )}

        {disarmPad}
        {(
          <button onClick={() => void disarm()} disabled={disarming}
            style={{ marginTop: "clamp(14px, 3vmin, 28px)", padding: "clamp(12px,2.6vmin,18px) clamp(28px,8vmin,64px)",
                     fontSize: "clamp(16px, 3vmin, 22px)", fontWeight: 800, borderRadius: 14, border: "none",
                     cursor: "pointer", background: P.btn, color: P.btnInk, touchAction: "manipulation" }}>
            {disarming ? "…" : state === "arming" ? "Cancel" : "Disarm"}
          </button>
        )}
        {disarmErr && <div style={{ marginTop: 8, fontSize: "clamp(12px, 2.6vmin, 16px)", fontWeight: 700, color: P.ink }}>{disarmErr}</div>}
      </div>

      <style>{`@keyframes hh-alarmglow{0%,100%{box-shadow:0 0 0 0 var(--hh-glow),0 18px 60px rgba(0,0,0,.55)}50%{box-shadow:0 0 0 14px transparent,0 18px 60px rgba(0,0,0,.55);border-color:#fff}}`}</style>
    </div>
  );
}
