"use client";

/** AlarmControl — the one arm/disarm surface, used on every page.
 *
 * Self-contained: reads the alarm entity from useHomeHub, sends commands
 * through the allowlisted service API, and shows real feedback:
 *   - instant press animation (scale + glow) so a tap is acknowledged
 *   - an in-flight spinner ("Arming…"/"Disarming…") until HA confirms
 *   - a live status badge reflecting the actual HA state
 *     (disarmed / arming / entry-delay / armed / TRIGGERED)
 * The command clears only when HA echoes the matching state back, so the
 * buttons never lie about what the house is actually doing.
 *
 * Variants:
 *   "bar"     full labeled control (dashboard, security board)
 *   "compact" tighter, for the wall panel header
 */

import { useEffect, useMemo, useState } from "react";
import { callService, Entity, ServiceError } from "@/lib/api";
import { useHomeHub } from "@/lib/useHomeHub";
import { useMe } from "@/lib/auth";

const ALARM_ENTITY = "alarm_control_panel.homehub";

const C = {
  ok: "#3fb98f",
  warn: "#f0a838",
  alert: "#e0483d",
  ink: "#e8ebf2",
  sub: "#8a91a0",
  line: "#2a3140",
  field: "#0f1116",
};

const STATUS: Record<string, [string, string]> = {
  disarmed:   [C.ok,    "Disarmed"],
  arming:     [C.warn,  "Arming…"],
  pending:    [C.warn,  "Entry delay"],
  armed_away: [C.alert, "Armed · Away"],
  armed_home: [C.alert, "Armed · Home"],
  armed_night:[C.alert, "Armed · Night"],
  triggered:  [C.alert, "⚠ TRIGGERED"],
  unknown:    [C.sub,   "—"],
};

type Cmd = "arm" | "disarm" | null;

export default function AlarmControl({
  variant = "bar",
}: {
  variant?: "bar" | "compact";
}) {
  const { entities } = useHomeHub();
  const { me } = useMe();
  const alarm = entities.get(ALARM_ENTITY) as Entity | undefined;
  const state = alarm ? alarm.state : "unknown";
  const armed = state.startsWith("armed");

  const [command, setCommand] = useState<Cmd>(null);
  // PIN keypad: non-null while waiting for digits for a pending arm/disarm
  const [pinFor, setPinFor] = useState<null | { wantArmed: boolean }>(null);
  const [pinError, setPinError] = useState("");

  // clear the pending command once HA reflects it (or after a failsafe timeout)
  useEffect(() => {
    if (!command) return;
    const settled =
      (command === "arm" && (state.startsWith("armed") || state === "arming" || state === "pending")) ||
      (command === "disarm" && state === "disarmed");
    if (settled) setCommand(null);
    const t = setTimeout(() => setCommand(null), 8000);
    return () => clearTimeout(t);
  }, [command, state]);

  const dispatch = async (wantArmed: boolean, pin?: string) => {
    if (!alarm) return;
    setCommand(wantArmed ? "arm" : "disarm");
    try {
      await callService(
        "alarm_control_panel",
        wantArmed ? "alarm_arm_away" : "alarm_disarm",
        alarm.entity_id,
        pin ? { pin } : {},
      );
      setPinFor(null);
      setPinError("");
    } catch (e) {
      setCommand(null);
      if (e instanceof ServiceError && e.detail === "pin_required") {
        // Server says this account is PIN-gated (covers a stale `me`)
        setPinFor({ wantArmed });
        setPinError("");
      } else if (e instanceof ServiceError && e.detail === "pin_invalid") {
        setPinFor({ wantArmed });
        setPinError("Wrong PIN");
      } else if (e instanceof ServiceError && e.status === 429) {
        setPinFor({ wantArmed });
        setPinError("Too many attempts — wait a bit");
      } else {
        console.error(e);
        setPinFor(null);
      }
    }
  };

  const send = (wantArmed: boolean) => {
    if (me?.pin_set) {
      setPinError("");
      setPinFor({ wantArmed });
    } else {
      void dispatch(wantArmed);
    }
  };

  const [color, text] = STATUS[state] ?? [C.sub, state];
  const pulse = state === "triggered" || state === "pending" || state === "arming" || !!command;

  const badge = (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontSize: 11, fontWeight: 700, color, whiteSpace: "nowrap",
        padding: "3px 9px", borderRadius: 20,
        border: `1px solid ${color}55`, background: `${color}15`,
      }}
    >
      <span
        style={{
          width: 7, height: 7, borderRadius: 7, background: color,
          boxShadow: `0 0 8px ${color}`,
          animation: pulse ? "hh-blink 1s ease-in-out infinite" : "none",
        }}
      />
      {text}
    </span>
  );

  if (!alarm) {
    return (
      <span style={{ fontSize: 11, color: C.sub, whiteSpace: "nowrap" }}>
        Alarm offline
      </span>
    );
  }

  const gap = variant === "compact" ? 6 : 8;
  return (
    <div style={{ display: "flex", alignItems: "center", gap }}>
      {variant === "bar" && badge}
      <FBtn
        label={command === "arm" ? "Arming…" : "Arm"}
        tone={C.alert}
        active={armed}
        busy={command === "arm"}
        onClick={() => send(true)}
        compact={variant === "compact"}
      />
      <FBtn
        label={command === "disarm" ? "Disarming…" : "Disarm"}
        tone={C.ok}
        active={!armed && state === "disarmed"}
        busy={command === "disarm"}
        onClick={() => send(false)}
        compact={variant === "compact"}
      />
      {variant === "compact" && badge}
      {pinFor && (
        <PinPad
          title={pinFor.wantArmed ? "PIN to arm" : "PIN to disarm"}
          tone={pinFor.wantArmed ? C.alert : C.ok}
          error={pinError}
          busy={!!command}
          onSubmit={(pin) => void dispatch(pinFor.wantArmed, pin)}
          onCancel={() => { setPinFor(null); setPinError(""); setCommand(null); }}
        />
      )}
    </div>
  );
}

/** Touch-first numeric keypad overlay (wall-panel friendly). The PIN is
 *  verified server-side; this only collects digits. */
function PinPad({
  title, tone, error, busy, onSubmit, onCancel,
}: {
  title: string; tone: string; error: string; busy: boolean;
  onSubmit: (pin: string) => void; onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
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
        padding: "16px 0", fontSize: 20, fontWeight: 700,
        color: C.ink, background: "#161b26", border: `1px solid ${C.line}`,
        borderRadius: 12, cursor: "pointer", touchAction: "manipulation",
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 60, display: "grid", placeItems: "center",
        background: "rgba(8,10,14,0.82)", backdropFilter: "blur(6px)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 280, padding: 18, borderRadius: 16,
          background: C.field, border: `1px solid ${C.line}`,
          display: "flex", flexDirection: "column", gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: tone, textAlign: "center" }}>{title}</div>
        <div style={{ display: "flex", justifyContent: "center", gap: 10, minHeight: 14 }}>
          {Array.from({ length: Math.max(pin.length, 4) }).map((_, i) => (
            <span key={i} style={{
              width: 12, height: 12, borderRadius: 12,
              background: i < pin.length ? tone : "transparent",
              border: `1.5px solid ${i < pin.length ? tone : C.line}`,
            }} />
          ))}
        </div>
        <div style={{ minHeight: 16, fontSize: 12, color: C.alert, textAlign: "center", fontWeight: 600 }}>
          {error}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {["1","2","3","4","5","6","7","8","9"].map((d) => key(d, () => press(d)))}
          {key("⌫", back)}
          {key("0", () => press("0"))}
          {key("✕", onCancel)}
        </div>
        <button
          onClick={() => onSubmit(pin)}
          disabled={busy || pin.length < 4}
          style={{
            padding: "13px 0", fontSize: 15, fontWeight: 800, borderRadius: 12,
            background: pin.length >= 4 ? tone : "#161b26",
            color: pin.length >= 4 ? C.field : C.sub,
            border: `1px solid ${pin.length >= 4 ? tone : C.line}`,
            cursor: pin.length >= 4 ? "pointer" : "default", touchAction: "manipulation",
          }}
        >
          {busy ? "Checking…" : "Confirm"}
        </button>
      </div>
    </div>
  );
}

function FBtn({
  label, tone, active, busy, onClick, compact,
}: {
  label: string; tone: string; active: boolean; busy: boolean;
  onClick: () => void; compact: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onClick={onClick}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      disabled={busy}
      style={{
        display: "flex", alignItems: "center", gap: 7,
        background: active || busy ? tone : "transparent",
        color: active || busy ? C.field : C.sub,
        border: `1px solid ${active || busy ? tone : C.line}`,
        borderRadius: 20,
        padding: compact ? "6px 13px" : "8px 18px",
        fontSize: compact ? 12 : 13, fontWeight: 700,
        cursor: busy ? "default" : "pointer",
        transform: pressed ? "scale(0.94)" : "scale(1)",
        opacity: busy ? 0.85 : 1,
        transition: "transform .08s, background .15s, color .15s, border-color .15s",
        boxShadow: pressed ? `0 0 0 3px ${tone}55` : "none",
      }}
    >
      {busy && (
        <span
          style={{
            width: 11, height: 11, border: `2px solid ${C.field}`,
            borderTopColor: "transparent", borderRadius: "50%",
            display: "inline-block", animation: "hh-spin .7s linear infinite",
          }}
        />
      )}
      {label}
    </button>
  );
}
