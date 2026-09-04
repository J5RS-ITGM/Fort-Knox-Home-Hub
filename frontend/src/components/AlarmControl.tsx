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
import { callService, Entity } from "@/lib/api";
import { useHomeHub } from "@/lib/useHomeHub";

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
  const alarm = entities.get(ALARM_ENTITY) as Entity | undefined;
  const state = alarm ? alarm.state : "unknown";
  const armed = state.startsWith("armed");

  const [command, setCommand] = useState<Cmd>(null);

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

  const send = async (wantArmed: boolean) => {
    if (!alarm) return;
    setCommand(wantArmed ? "arm" : "disarm");
    try {
      await callService(
        "alarm_control_panel",
        wantArmed ? "alarm_arm_away" : "alarm_disarm",
        alarm.entity_id,
      );
    } catch (e) {
      console.error(e);
      setCommand(null);
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
