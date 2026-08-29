"use client";

/** Dashboard shell — proves the full pipeline end to end:
 *  HA (or mock) -> FastAPI cache -> WebSocket -> this page, and back down
 *  via the allowlisted service-call API. The family-facing modules (security
 *  board, panels, Chore Quest) mount on top of this same data layer.
 */

import { useMemo, useState } from "react";
import { callService, Entity } from "@/lib/api";
import { useHomeHub } from "@/lib/useHomeHub";

// ---------- helpers ----------------------------------------------------------

const GROUPS: { key: string; label: string; match: (e: Entity) => boolean }[] = [
  { key: "security", label: "Security", match: (e) => e.domain === "alarm_control_panel" || e.domain === "lock" || ["door", "window", "motion", "occupancy", "smoke"].includes(String(e.attributes.device_class)) },
  { key: "water", label: "Water", match: (e) => e.domain === "valve" || String(e.attributes.device_class) === "moisture" || e.entity_id.includes("sump") },
  { key: "climate", label: "Climate", match: (e) => e.domain === "climate" || e.entity_id.includes("humidity") },
  { key: "power", label: "Power & Lighting", match: (e) => e.domain === "switch" || e.domain === "light" },
];

function isAttention(e: Entity): boolean {
  if (e.domain === "lock") return e.state === "unlocked";
  if (e.domain === "valve") return e.state === "open";
  if (e.domain === "binary_sensor") return e.state === "on";
  return false;
}

function stateLabel(e: Entity): string {
  const dc = String(e.attributes.device_class ?? "");
  if (e.domain === "binary_sensor") {
    if (dc === "door" || dc === "window") return e.state === "on" ? "Open" : "Closed";
    if (dc === "motion" || dc === "occupancy") return e.state === "on" ? "Motion" : "Clear";
    if (dc === "moisture") return e.state === "on" ? "WET" : "Dry";
    if (dc === "smoke") return e.state === "on" ? "ALARM" : "Clear";
  }
  if (e.domain === "sensor") {
    const unit = e.attributes.unit_of_measurement ?? "";
    return `${e.state}${unit}`;
  }
  if (e.domain === "climate") {
    const cur = e.attributes.current_temperature;
    return cur != null ? `${cur}°` : e.state;
  }
  return e.state.replace(/_/g, " ");
}

// ---------- small components -------------------------------------------------

function Lamp({ on, alert }: { on: boolean; alert?: boolean }) {
  const color = alert ? "bg-alert" : on ? "bg-ok" : "bg-line";
  return <span className={`inline-block size-2 rounded-full ${color} ${on && !alert ? "lamp-live" : ""}`} />;
}

function StatusRail({ linkUp, bridgeUp, alarm }: { linkUp: boolean; bridgeUp: boolean; alarm?: Entity }) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-field/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
        <h1 className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-wide">
          Home<span className="text-lamp">Hub</span>
        </h1>
        <a href="/panel" className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-muted transition-colors hover:border-lamp/50 hover:text-ink">
          Wall panel
        </a>
        <div className="flex items-center gap-4 text-xs text-ink-muted">
          <span className="flex items-center gap-1.5"><Lamp on={linkUp} alert={!linkUp} /> App link</span>
          <span className="flex items-center gap-1.5"><Lamp on={bridgeUp} alert={!bridgeUp} /> HA bridge</span>
        </div>
        {alarm && <AlarmChip alarm={alarm} />}
      </div>
    </header>
  );
}

function AlarmChip({ alarm }: { alarm: Entity }) {
  const [busy, setBusy] = useState(false);
  const armed = alarm.state.startsWith("armed");
  const label = alarm.state === "armed_away" ? "Armed · Away" : alarm.state === "armed_home" ? "Armed · Home" : "Disarmed";

  const set = async (service: string) => {
    setBusy(true);
    try {
      await callService("alarm_control_panel", service, alarm.entity_id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ml-auto flex items-center gap-2">
      <span className={`rounded-full border px-3 py-1 text-xs font-medium ${armed ? "border-lamp text-lamp" : "border-line text-ink-muted"}`}>
        {label}
      </span>
      <div className="flex overflow-hidden rounded-md border border-line text-xs">
        {[
          ["alarm_disarm", "Off"],
          ["alarm_arm_home", "Home"],
          ["alarm_arm_away", "Away"],
        ].map(([service, text]) => (
          <button
            key={service}
            disabled={busy}
            onClick={() => set(service)}
            className="px-2.5 py-1 text-ink-muted transition-colors hover:bg-panel-raised hover:text-ink focus-visible:outline focus-visible:outline-lamp disabled:opacity-50"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function EntityCard({ e }: { e: Entity }) {
  const [busy, setBusy] = useState(false);
  const attention = isAttention(e);

  const action = useMemo(() => {
    if (e.domain === "light" || e.domain === "switch") return { domain: e.domain, service: "toggle" };
    if (e.domain === "lock") return { domain: "lock", service: e.state === "locked" ? "unlock" : "lock" };
    if (e.domain === "valve") return { domain: "valve", service: e.state === "open" ? "close_valve" : "open_valve" };
    return null;
  }, [e.domain, e.state]);

  const activate = async () => {
    if (!action) return;
    setBusy(true);
    try {
      await callService(action.domain, action.service, e.entity_id);
    } finally {
      setBusy(false);
    }
  };

  const battery = e.attributes.battery as number | undefined;
  const power = e.attributes.power_w as number | undefined;
  const on = e.state === "on" || e.state === "locked";

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{e.friendly_name}</span>
        <Lamp on={on || attention} alert={attention} />
      </div>
      <div className={`mt-1 text-lg font-semibold ${attention ? "text-alert" : "text-ink"}`}>{stateLabel(e)}</div>
      <div className="mt-2 flex items-center justify-between font-[family-name:var(--font-mono)] text-[10px] text-ink-muted">
        <span className="truncate">{e.entity_id}</span>
        <span>
          {battery != null && `${battery}%`}
          {power != null && ` ${power}W`}
        </span>
      </div>
    </>
  );

  const base = "rounded-lg border border-line bg-panel p-3 text-left transition-colors";
  return action ? (
    <button
      onClick={activate}
      disabled={busy}
      className={`${base} w-full hover:border-lamp/50 hover:bg-panel-raised focus-visible:outline focus-visible:outline-lamp disabled:opacity-60`}
    >
      {body}
    </button>
  ) : (
    <div className={base}>{body}</div>
  );
}

// ---------- page -------------------------------------------------------------

export default function Dashboard() {
  const { entities, linkUp, bridgeUp } = useHomeHub();
  const list = useMemo(() => Array.from(entities.values()), [entities]);
  const alarm = entities.get("alarm_control_panel.homehub");

  const grouped = useMemo(() => {
    const used = new Set<string>();
    const rows = GROUPS.map((g) => {
      const items = list.filter((e) => e.domain !== "alarm_control_panel" && !used.has(e.entity_id) && g.match(e));
      items.forEach((e) => used.add(e.entity_id));
      return { ...g, items };
    });
    const rest = list.filter((e) => e.domain !== "alarm_control_panel" && !used.has(e.entity_id));
    if (rest.length) rows.push({ key: "other", label: "Other", match: () => true, items: rest });
    return rows.filter((r) => r.items.length > 0);
  }, [list]);

  return (
    <div className="min-h-dvh">
      <StatusRail linkUp={linkUp} bridgeUp={bridgeUp} alarm={alarm} />

      <main className="mx-auto max-w-5xl px-4 py-6">
        {!linkUp && (
          <p className="mb-6 rounded-md border border-alert/40 bg-panel p-3 text-sm text-ink-muted">
            Reconnecting to the HomeHub backend…
          </p>
        )}

        {grouped.map((group) => (
          <section key={group.key} className="mb-8">
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              {group.label}
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {group.items.map((e) => (
                <EntityCard key={e.entity_id} e={e} />
              ))}
            </div>
          </section>
        ))}

        {linkUp && list.length === 0 && (
          <p className="text-sm text-ink-muted">No entities yet. Waiting for the bridge to load states.</p>
        )}
      </main>
    </div>
  );
}
