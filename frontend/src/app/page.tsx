"use client";

/** Dashboard shell — proves the full pipeline end to end:
 *  HA (or mock) -> FastAPI cache -> WebSocket -> this page, and back down
 *  via the allowlisted service-call API. The family-facing modules (security
 *  board, panels, Chore Quest) mount on top of this same data layer.
 */

import { useMemo, useState } from "react";
import { callService, Entity } from "@/lib/api";
import { useHomeHub } from "@/lib/useHomeHub";
import AppHeader from "@/components/AppHeader";
import { Lamp } from "@/components/Lamp";
import AlarmControl from "@/components/AlarmControl";
import { logout, useMe } from "@/lib/auth";
import AuthGate from "@/components/AuthGate";

// ---------- helpers ----------------------------------------------------------

// Curated dashboard: an entity renders ONLY if a group claims it. There is
// deliberately no "Other" catch-all — it inevitably filled with Z-Wave
// plumbing (automations, Identify/Ping buttons, AC-mains + battery
// diagnostics, legacy alarm CC entities). Everything remains in HA and in
// Admin → Devices; this page is the family view, not the registry.
const GROUPS: { key: string; label: string; match: (e: Entity) => boolean }[] = [
  {
    key: "security", label: "Security",
    match: (e) =>
      e.domain === "lock" || e.domain === "siren" ||
      ["door", "window", "motion", "occupancy", "smoke", "gas", "carbon_monoxide", "vibration"].includes(String(e.attributes.device_class)),
  },
  {
    key: "water", label: "Water",
    match: (e) => e.domain === "valve" || String(e.attributes.device_class) === "moisture" || e.entity_id.includes("sump"),
  },
  {
    key: "climate", label: "Climate",
    match: (e) =>
      e.domain === "climate" ||
      ["temperature", "humidity"].includes(String(e.attributes.device_class)) ||
      e.entity_id.includes("humidity"),
  },
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
      {/* Full names, never truncated: the entity_id is what gets typed
          into HA during pairing/automation work, so it must be readable
          end to end. Long values wrap instead of ellipsizing. */}
      <div className="flex items-start justify-between gap-2">
        <span className="break-words text-sm font-medium">{e.friendly_name}</span>
        <Lamp on={on || attention} alert={attention} />
      </div>
      <div className={`mt-1 text-lg font-semibold ${attention ? "text-alert" : "text-ink"}`}>{stateLabel(e)}</div>
      <div className="mt-2 flex items-start justify-between gap-2 font-[family-name:var(--font-mono)] text-[10px] text-ink-muted">
        <span className="break-all">{e.entity_id}</span>
        <span className="shrink-0">
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

function DashboardInner() {
  const { entities, linkUp, bridgeUp } = useHomeHub();
  const { me } = useMe();
  const list = useMemo(() => Array.from(entities.values()), [entities]);
  const alarm = entities.get("alarm_control_panel.homehub");

  const grouped = useMemo(() => {
    const used = new Set<string>();
    const rows = GROUPS.map((g) => {
      const items = list.filter((e) => e.domain !== "alarm_control_panel" && !used.has(e.entity_id) && g.match(e));
      items.forEach((e) => used.add(e.entity_id));
      return { ...g, items };
    });
    // No "Other" bucket: unmatched entities (automations, buttons,
    // diagnostics…) simply don't render here. See GROUPS comment.
    return rows.filter((r) => r.items.length > 0);
  }, [list]);

  return (
    <div className="min-h-dvh">
      <AppHeader />

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

export default function Dashboard() {
  return (
    <AuthGate>
      <DashboardInner />
    </AuthGate>
  );
}
