"use client";

/** SensorFlash — full-screen sensor-name takeover, mounted globally.
 *
 * Watches live entity state via useHomeHub. When a security sensor
 * transitions into its "active" state (door/window opens, motion detected,
 * leak wet, smoke alarm), it flashes the sensor's plain name across the
 * whole screen:
 *   - disarmed  -> amber flash  ("someone opened the back door")
 *   - armed     -> red flash    (intrusion)
 * Mounted once in the root layout, so it appears on every page and over
 * the wall panel. Auto-dismisses; newest event wins.
 */

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Entity } from "@/lib/api";
import { useHomeHub } from "@/lib/useHomeHub";

const AMBER = "#e8a33d";
const RED = "#e0483d";

interface FlashEvent {
  id: number;
  name: string;
  verb: string;
  color: string;
  armed: boolean;
}

function deviceClass(e: Entity): string {
  return String(e.attributes?.device_class ?? "");
}

// Is this entity a security sensor we should flash on, and is it "active"?
function activeVerb(e: Entity): string | null {
  if (e.domain === "binary_sensor") {
    const dc = deviceClass(e);
    const on = e.state === "on";
    if (!on) return null;
    if (dc === "door" || dc === "window" || dc === "opening" || dc === "garage_door") return "Opened";
    if (dc === "motion" || dc === "occupancy" || dc === "presence") return "Motion";
    if (dc === "moisture") return "Leak";
    if (dc === "smoke") return "Smoke";
    if (dc === "gas" || dc === "carbon_monoxide") return "Alarm";
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
  const [visible, setVisible] = useState(false);

  const prev = useRef<Map<string, string>>(new Map()); // entity_id -> last state
  const seeded = useRef(false);
  const counter = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const alarm = entities.get("alarm_control_panel.homehub");
  const armed = alarm ? alarm.state.startsWith("armed") || alarm.state === "pending" || alarm.state === "triggered" : false;
  const armedRef = useRef(armed);
  useEffect(() => { armedRef.current = armed; }, [armed]);

  useEffect(() => {
    // First snapshot: record states without flashing (don't fire on load).
    if (!seeded.current) {
      for (const e of entities.values()) prev.current.set(e.entity_id, e.state);
      seeded.current = true;
      return;
    }

    let latest: FlashEvent | null = null;
    for (const e of entities.values()) {
      const before = prev.current.get(e.entity_id);
      prev.current.set(e.entity_id, e.state);
      if (before === e.state) continue; // no change
      const verb = activeVerb(e);
      if (!verb) continue; // not an active-transition we flash on
      // fire on the transition into active
      latest = {
        id: ++counter.current,
        name: e.friendly_name || e.entity_id,
        verb,
        color: armedRef.current ? RED : AMBER,
        armed: armedRef.current,
      };
    }

    if (latest) {
      setEvent(latest);
      setVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setVisible(false), 4500);
    }
  }, [entities]);

  if (!event) return null;
  if (pathname === "/login" || pathname === "/setup") return null;

  const color = event.color;
  return (
    <div
      aria-live="assertive"
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", textAlign: "center",
        background: color,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transition: "opacity .25s ease",
        animation: visible ? `hh-flash-${event.armed ? "red" : "amber"} .5s steps(1) 3` : "none",
      }}
      onClick={() => setVisible(false)}
    >
      <div style={{
        fontSize: "clamp(13px, 3vw, 20px)", letterSpacing: 3, textTransform: "uppercase",
        fontWeight: 700, color: "#0f1117", marginBottom: "2vh",
      }}>
        {event.armed ? "⚠ Alarm · " : ""}{event.verb}
      </div>
      <div style={{
        fontSize: "clamp(32px, 9vw, 96px)", fontWeight: 800, color: "#0f1117",
        padding: "0 4vw", lineHeight: 1.05,
      }}>
        {event.name}
      </div>
      <div style={{
        fontSize: "clamp(11px, 2vw, 15px)", color: "#0f1117bb", marginTop: "3vh",
      }}>
        tap to dismiss
      </div>
    </div>
  );
}
