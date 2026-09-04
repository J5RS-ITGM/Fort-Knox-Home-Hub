"use client";

/** SensorFlash — corner alert card, mounted globally.
 *
 *   - disarmed -> amber card, auto-dismisses after 10s
 *   - armed    -> red card, stays until acknowledged
 * Mounted once in the root layout; shows on every page and over the wall
 * panel. Seeds on first snapshot so it never fires on load. An unacked
 * armed alert takes precedence over later amber events.
 */

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Entity } from "@/lib/api";
import { useHomeHub } from "@/lib/useHomeHub";

// Defaults; overridden by Admin -> Settings (alerts_mode, colors, timer).
const AMBER = "#e8a33d";
const RED = "#e0483d";
const AMBER_MS = 10000;

type AlertMode = "all" | "armed_only" | "off";
interface AlertConfig { mode: AlertMode; colorDisarmed: string; colorArmed: string; dismissMs: number; rules: Record<string, AlertMode>; }
const DEFAULT_CFG: AlertConfig = { mode: "all", colorDisarmed: AMBER, colorArmed: RED, dismissMs: AMBER_MS, rules: {} };

function parseCfg(v: Record<string, string>): AlertConfig {
  const mode = v.alerts_mode === "off" || v.alerts_mode === "armed_only" ? v.alerts_mode : "all";
  const hex = (x: string | undefined, fb: string) => (x && /^#[0-9a-fA-F]{6}$/.test(x) ? x : fb);
  const secs = Number(v.alert_dismiss_secs);
  let rules: Record<string, AlertMode> = {};
  try {
    const parsed = JSON.parse(v.alert_rules || "{}");
    for (const [k, r] of Object.entries(parsed)) {
      if (r === "all" || r === "armed_only" || r === "off") rules[k] = r;
    }
  } catch { rules = {}; }
  return {
    mode,
    colorDisarmed: hex(v.alert_color_disarmed, AMBER),
    colorArmed: hex(v.alert_color_armed, RED),
    dismissMs: Number.isFinite(secs) && secs >= 0 ? secs * 1000 : AMBER_MS,
    rules,
  };
}

interface FlashEvent { id: number; name: string; verb: string; armed: boolean; }

function deviceClass(e: Entity): string { return String(e.attributes?.device_class ?? ""); }

function activeVerb(e: Entity): string | null {
  if (e.domain === "binary_sensor") {
    const dc = deviceClass(e);
    if (e.state !== "on") return null;
    if (dc === "door" || dc === "window" || dc === "opening" || dc === "garage_door") return "Opened";
    if (dc === "motion" || dc === "occupancy" || dc === "presence") return "Motion";
    if (dc === "moisture") return "Leak";
    if (dc === "smoke") return "Smoke";
    if (dc === "gas" || dc === "carbon_monoxide") return "Gas / CO";
    if (dc === "vibration") return "Vibration";
    if (dc === "" || dc === "safety") return "Triggered";
  }
  if (e.domain === "lock" && e.state === "unlocked") return "Unlocked";
  return null;
}

export default function SensorFlash() {
  const pathname = usePathname();
  const { entities } = useHomeHub();
  const [event, setEvent] = useState<FlashEvent | null>(null);
  const [cfg, setCfg] = useState<AlertConfig>(DEFAULT_CFG);
  const cfgRef = useRef(cfg);
  useEffect(() => { cfgRef.current = cfg; }, [cfg]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/ui-settings`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : {}))
        .then((v) => { if (alive) setCfg(parseCfg(v)); })
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000); // settings edits apply within a minute
    return () => { alive = false; clearInterval(t); };
  }, []);

  const prev = useRef<Map<string, string>>(new Map());
  const seeded = useRef(false);
  const counter = useRef(0);
  const amberTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventRef = useRef<FlashEvent | null>(null);
  useEffect(() => { eventRef.current = event; }, [event]);

  const alarm = entities.get("alarm_control_panel.homehub");
  const armed = alarm
    ? alarm.state.startsWith("armed") || alarm.state === "pending" || alarm.state === "triggered"
    : false;
  const armedRef = useRef(armed);
  useEffect(() => { armedRef.current = armed; }, [armed]);

  useEffect(() => {
    if (!seeded.current) {
      for (const e of entities.values()) prev.current.set(e.entity_id, e.state);
      seeded.current = true;
      return;
    }
    let latest: FlashEvent | null = null;
    for (const e of entities.values()) {
      const before = prev.current.get(e.entity_id);
      prev.current.set(e.entity_id, e.state);
      if (before === e.state) continue;
      const verb = activeVerb(e);
      if (!verb) continue;
      // Effective mode for THIS sensor: its rule, else the global default.
      const c0 = cfgRef.current;
      const eff = c0.rules[e.entity_id] ?? c0.mode;
      if (eff === "off") continue;
      if (eff === "armed_only" && !armedRef.current) continue;
      latest = { id: ++counter.current, name: e.friendly_name || e.entity_id, verb, armed: armedRef.current };
    }
    if (!latest) return;
    const c = cfgRef.current;
    const cur = eventRef.current;
    if (cur && cur.armed && !latest.armed) return; // don't bury an unacked armed alert
    setEvent(latest);
    if (amberTimer.current) { clearTimeout(amberTimer.current); amberTimer.current = null; }
    if (!latest.armed && c.dismissMs > 0) amberTimer.current = setTimeout(() => setEvent(null), c.dismissMs);
  }, [entities]);

  if (!event) return null;
  if (pathname === "/login" || pathname === "/setup") return null;

  const color = event.armed ? cfg.colorArmed : cfg.colorDisarmed;
  const dismiss = () => {
    if (amberTimer.current) { clearTimeout(amberTimer.current); amberTimer.current = null; }
    setEvent(null);
  };

  return (
    <div
      aria-live="assertive"
      style={{
        position: "fixed",
        right: "max(16px, env(safe-area-inset-right))",
        bottom: "max(16px, env(safe-area-inset-bottom))",
        zIndex: 9999,
        width: "min(360px, calc(100vw - 32px))",
        borderRadius: 16,
        background: color,
        color: "#0f1117",
        boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        padding: "16px 18px",
        animation: event.armed ? "hh-card-red 0.9s ease-in-out infinite" : "hh-card-in 0.25s ease-out",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase" }}>
        {event.armed ? "\u26A0 Alarm" : event.verb}
      </div>
      <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, margin: "6px 0 2px" }}>
        {event.name}
      </div>
      {event.armed && (
        <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.85 }}>{event.verb} while armed</div>
      )}
      <button
        onClick={dismiss}
        style={{
          marginTop: 12, width: "100%",
          background: "#0f1117", color: color,
          border: "none", borderRadius: 10, padding: "11px 0",
          fontSize: 14, fontWeight: 800, cursor: "pointer",
        }}
      >
        {event.armed ? "Acknowledge" : "Dismiss"}
      </button>
    </div>
  );
}
