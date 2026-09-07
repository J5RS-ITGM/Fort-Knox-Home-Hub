"use client";

/** Control — manual control of household lights, switches, and fans. Reads
 *  live entities from the HA bridge; toggles and dims via the allowlisted
 *  service proxy. Grouped by type; dimmable lights get a brightness slider. */

import { useMemo, useState } from "react";
import PageShell from "@/components/PageShell";
import { callService, Entity } from "@/lib/api";
import { useHomeHub } from "@/lib/useHomeHub";

const isOn = (e: Entity) => e.state === "on";
const CONTROLLABLE = (e: Entity) => e.domain === "light" || e.domain === "switch" || e.domain === "fan";

function niceName(e: Entity) { return e.friendly_name || e.entity_id; }

export default function ControlPage() {
  const { entities, linkUp } = useHomeHub();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // optimistic brightness while dragging (entity_id -> 0..255)
  const [dragBri, setDragBri] = useState<Record<string, number>>({});

  const items = useMemo(
    () => Array.from(entities.values()).filter(CONTROLLABLE)
      .sort((a, b) => niceName(a).localeCompare(niceName(b))),
    [entities]
  );
  const groups = useMemo(() => ({
    light: items.filter((e) => e.domain === "light"),
    switch: items.filter((e) => e.domain === "switch"),
    fan: items.filter((e) => e.domain === "fan"),
  }), [items]);

  const mark = (id: string, on: boolean) =>
    setBusy((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });

  const toggle = async (e: Entity) => {
    mark(e.entity_id, true);
    try { await callService(e.domain, "toggle", e.entity_id); }
    catch (err) { console.error(err); }
    finally { setTimeout(() => mark(e.entity_id, false), 400); }
  };

  const setBrightness = async (e: Entity, pct: number) => {
    const val = Math.round((pct / 100) * 255);
    setDragBri((d) => ({ ...d, [e.entity_id]: val }));
    try { await callService("light", "turn_on", e.entity_id, { brightness: val }); }
    catch (err) { console.error(err); }
  };

  const dimmable = (e: Entity) => e.domain === "light" &&
    (Array.isArray(e.attributes?.supported_color_modes)
      ? e.attributes.supported_color_modes.some((m: string) => m !== "onoff")
      : e.attributes?.brightness != null);

  const briPct = (e: Entity) => {
    const v = dragBri[e.entity_id] ?? (e.attributes?.brightness as number | undefined);
    return v != null ? Math.round((v / 255) * 100) : (isOn(e) ? 100 : 0);
  };

  const card = (e: Entity) => {
    const on = isOn(e);
    const working = busy.has(e.entity_id);
    return (
      <div key={e.entity_id} className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{niceName(e)}</div>
            <div className="text-[11px] text-ink-muted">{on ? "On" : "Off"}</div>
          </div>
          <button
            onClick={() => toggle(e)}
            disabled={working}
            aria-label={on ? "Turn off" : "Turn on"}
            className="relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60"
            style={{ background: on ? "var(--color-ok)" : "var(--color-line)" }}
          >
            <span className="absolute top-1 size-5 rounded-full bg-white transition-all"
                  style={{ left: on ? 26 : 4 }} />
          </button>
        </div>
        {dimmable(e) && on && (
          <input type="range" min={1} max={100} value={briPct(e)}
            onChange={(ev) => setBrightness(e, Number(ev.target.value))}
            className="w-full accent-lamp" aria-label="Brightness" />
        )}
      </div>
    );
  };

  const section = (label: string, list: Entity[]) => list.length > 0 && (
    <section className="mb-8">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">{label}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map(card)}
      </div>
    </section>
  );

  return (
    <PageShell title="Control" active="/control">
      {!linkUp && (
        <p className="mb-6 rounded-md border border-alert/40 bg-panel p-3 text-sm text-ink-muted">
          Reconnecting to the HomeHub backend…
        </p>
      )}
      {section("Lights", groups.light)}
      {section("Switches", groups.switch)}
      {section("Fans", groups.fan)}
      {linkUp && items.length === 0 && (
        <p className="text-sm text-ink-muted">No controllable lights, switches, or fans found yet.</p>
      )}
    </PageShell>
  );
}
