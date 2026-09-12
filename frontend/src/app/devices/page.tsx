"use client";

/* Devices Manager — the single control center for every HA entity the app
 * can show: switches, lights, sensors, locks, and covers.
 *
 * Per entity, from one table:
 *   - Panel: whether it appears in the wall panel's Devices tile
 *     (shared server config, so the kiosk and every phone agree)
 *   - Board: place on / remove from the security board & Home Map,
 *     with room + floor
 *   - Fixtures: for lights/switches, how many physical fixtures the circuit
 *     drives (one marker per fixture on the boards)
 *   - Icon: ceiling light or wall sconce (exterior), for lights
 *   - Live state at a glance
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import AuthGate from "@/components/AuthGate";
import { api, API_URL, Entity } from "@/lib/api";

interface Placement { id: string; entity_id: string; room: string; floor: number; x: number; y: number; icon: string | null }
interface DeviceCfg { hidden: string[]; icons: Record<string, string> }

const input =
  "rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-muted/60 focus:border-lamp/60";
const btn =
  "rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-muted transition-colors hover:border-lamp/50 hover:text-ink disabled:opacity-50";
const th = "px-3 py-2 font-medium text-left text-[11px] uppercase tracking-wider text-ink-muted";

const DOMAINS = ["all", "light", "switch", "binary_sensor", "lock", "cover"] as const;
type DomainTab = (typeof DOMAINS)[number];

const baseId = (id: string) => id.replace(/#\d+$/, "");

function DevicesInner() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [cfg, setCfg] = useState<DeviceCfg>({ hidden: [], icons: {} });
  const [filter, setFilter] = useState("");
  const [domain, setDomain] = useState<DomainTab>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const j = (r: Response) => (r.ok ? r.json() : null);
    const [e, p, c] = await Promise.all([
      fetch(`${API_URL}/api/entities`, { credentials: "include" }).then(j),
      fetch(`${API_URL}/api/placements`, { credentials: "include" }).then(j),
      fetch(`${API_URL}/api/device-config`, { credentials: "include" }).then(j),
    ]);
    if (e) setEntities(e);
    if (p) setPlacements(p);
    if (c) setCfg(c);
  }, []);
  useEffect(() => { refresh(); const iv = setInterval(refresh, 15000); return () => clearInterval(iv); }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "request failed"); }
    finally { setBusy(false); }
  };

  const putCfg = (next: DeviceCfg) =>
    act(() => fetch(`${API_URL}/api/device-config`, {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
    }));

  const placedBy = useMemo(() => {
    const m = new Map<string, Placement>();
    placements.forEach((p) => { if (!/#\d+$/.test(p.entity_id)) m.set(p.entity_id, p); });
    return m;
  }, [placements]);
  const fixturesOf = (id: string) => 1 + placements.filter((q) => q.entity_id.startsWith(`${id}#`)).length;

  const rows = useMemo(() => {
    const wanted = new Set(["light", "switch", "binary_sensor", "lock", "cover"]);
    const q = filter.trim().toLowerCase();
    return entities
      .filter((e) => wanted.has(e.domain))
      .filter((e) => domain === "all" || e.domain === domain)
      .filter((e) => !q || e.entity_id.toLowerCase().includes(q) || (e.friendly_name ?? "").toLowerCase().includes(q))
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.entity_id.localeCompare(b.entity_id));
  }, [entities, filter, domain]);

  const isLightish = (e: Entity) => e.domain === "light" || e.domain === "switch";
  const panelable = (e: Entity) => e.domain === "light" || e.domain === "switch"; // Devices tile shows these
  const hiddenSet = useMemo(() => new Set(cfg.hidden), [cfg.hidden]);

  const togglePanel = (id: string) => {
    const next = new Set(cfg.hidden);
    next.has(id) ? next.delete(id) : next.add(id);
    putCfg({ ...cfg, hidden: [...next] });
  };
  const setIcon = (id: string, icon: string) => putCfg({ ...cfg, icons: { ...cfg.icons, [id]: icon } });

  const place = (e: Entity) =>
    act(() => api(`/api/placements/${encodeURIComponent(e.entity_id)}`, {
      method: "PUT",
      body: JSON.stringify({ entity_id: e.entity_id, room: "", floor: 0, x: 0, y: 0, icon: null }),
    }));
  const unplace = (id: string) =>
    act(async () => {
      for (const q of placements.filter((q) => q.entity_id === id || q.entity_id.startsWith(`${id}#`))) {
        await api(`/api/placements/${encodeURIComponent(q.entity_id)}`, { method: "DELETE" });
      }
      return new Response(null, { status: 204 });
    });
  const patchPlacement = (p: Placement, patch: Partial<Placement>) =>
    act(() => api(`/api/placements/${encodeURIComponent(p.entity_id)}`, {
      method: "PUT",
      body: JSON.stringify({ entity_id: p.entity_id, room: patch.room ?? p.room, floor: patch.floor ?? p.floor, x: p.x, y: p.y, icon: p.icon }),
    }));
  const setFixtures = (p: Placement, n: number) =>
    act(async () => {
      const want = Math.max(1, Math.min(8, n));
      for (let i = 2; i <= 8; i++) {
        const fid = `${p.entity_id}#${i}`;
        const exists = placements.some((q) => q.entity_id === fid);
        if (i <= want && !exists) {
          await api(`/api/placements/${encodeURIComponent(fid)}`, { method: "PUT", body: JSON.stringify({
            entity_id: fid, room: p.room, floor: p.floor, x: (p.x ?? 0) + 0.6 * (i - 1), y: p.y ?? 0, icon: null }) });
        } else if (i > want && exists) {
          await api(`/api/placements/${encodeURIComponent(fid)}`, { method: "DELETE" });
        }
      }
      return new Response(null, { status: 204 });
    });

  const liveBadge = (e: Entity) => {
    const st = e.state;
    const active = st === "on" || st === "open" || st === "unlocked";
    const off = st === "unavailable" || st === "unknown";
    const color = off ? "text-ink-muted" : active ? "text-alert" : "text-ok";
    const label = off ? "offline" : e.domain === "lock" ? st : active ? "active" : st === "closed" || st === "off" || st === "locked" ? "clear" : st;
    return <span className={`text-xs font-semibold ${color}`}>{label}</span>;
  };

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-6">
      <div className="mb-1 flex items-center gap-3">
        <a href="/admin" className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-muted hover:text-ink">← Admin</a>
        <h1 className="text-xl font-bold">Devices</h1>
      </div>
      <p className="mb-4 text-sm text-ink-muted">
        Control what every device shows: on the wall panel&apos;s Devices tile, on the security board and Home Map,
        how many fixtures a light circuit drives, and which icon it uses. Changes apply everywhere, instantly.
      </p>
      {error && <div className="mb-3 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">{error}</div>}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {DOMAINS.map((d) => (
          <button key={d} onClick={() => setDomain(d)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${domain === d ? "border-lamp bg-lamp/15 text-ink" : "border-line text-ink-muted hover:text-ink"}`}>
            {d === "all" ? "All" : d === "binary_sensor" ? "Sensors" : d[0].toUpperCase() + d.slice(1) + "s"}
          </button>
        ))}
        <input className={`${input} ml-auto w-64`} placeholder="Filter by name or entity id…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-line bg-panel/60">
            <tr>
              <th className={th}>Device</th>
              <th className={th}>Panel tile</th>
              <th className={th}>Board</th>
              <th className={th}>Room / Floor</th>
              <th className={th}>Fixtures</th>
              <th className={th}>Icon</th>
              <th className={th}>Live</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const p = placedBy.get(e.entity_id);
              const lightish = isLightish(e);
              return (
                <tr key={e.entity_id} className="border-b border-line/60 align-middle last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium">{e.friendly_name || e.entity_id}</div>
                    <div className="font-[family-name:var(--font-mono)] text-[11px] text-ink-muted break-all">{e.entity_id}</div>
                  </td>
                  <td className="px-3 py-2">
                    {panelable(e) ? (
                      <button disabled={busy} onClick={() => togglePanel(e.entity_id)}
                        className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${hiddenSet.has(e.entity_id) ? "border-line text-ink-muted" : "border-ok/60 bg-ok/10 text-ok"}`}>
                        {hiddenSet.has(e.entity_id) ? "Hidden" : "Shown"}
                      </button>
                    ) : <span className="text-xs text-ink-muted">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {p ? (
                      <button disabled={busy} className={btn}
                        onClick={() => window.confirm(`Remove ${e.entity_id} from the board?`) && unplace(e.entity_id)}>
                        Remove
                      </button>
                    ) : (
                      <button disabled={busy} className={btn} onClick={() => place(e)}>Place</button>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {p ? (
                      <span className="flex items-center gap-2">
                        <input className={`${input} w-32 py-1`} defaultValue={p.room}
                          onBlur={(ev) => ev.target.value !== p.room && patchPlacement(p, { room: ev.target.value })} />
                        <select className={`${input} py-1`} value={p.floor}
                          onChange={(ev) => patchPlacement(p, { floor: Number(ev.target.value) })}>
                          <option value={0}>Ground</option><option value={1}>Second</option>
                        </select>
                      </span>
                    ) : <span className="text-xs text-ink-muted">drag on the Security board after placing</span>}
                  </td>
                  <td className="px-3 py-2">
                    {p && lightish ? (
                      <input className={`${input} w-16 py-1`} type="number" min={1} max={8}
                        key={`${e.entity_id}-${fixturesOf(e.entity_id)}`}
                        defaultValue={fixturesOf(e.entity_id)}
                        onBlur={(ev) => Number(ev.target.value) !== fixturesOf(e.entity_id) && setFixtures(p, Number(ev.target.value))} />
                    ) : <span className="text-xs text-ink-muted">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {lightish ? (
                      <select className={`${input} py-1`} disabled={busy}
                        value={cfg.icons[e.entity_id] ?? "ceiling"}
                        onChange={(ev) => setIcon(e.entity_id, ev.target.value)}>
                        <option value="ceiling">Ceiling light</option>
                        <option value="sconce">Wall sconce (exterior)</option>
                      </select>
                    ) : <span className="text-xs text-ink-muted">—</span>}
                  </td>
                  <td className="px-3 py-2">{liveBadge(e)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-ink-muted">No devices match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-ink-muted">
        Fixture markers and board positions are placed here at the origin — drag them into position on the Security board (Edit mode).
        Hidden devices disappear from the wall panel&apos;s Devices tile on every screen within a minute.
      </p>
    </div>
  );
}

export default function DevicesPage() {
  return (
    <AuthGate adminOnly>
      <DevicesInner />
    </AuthGate>
  );
}
