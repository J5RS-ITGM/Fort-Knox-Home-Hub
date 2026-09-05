"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGate from "@/components/AuthGate";
import { api, API_URL, AuditRow, Entity, User } from "@/lib/api";
import { applyTheme, ThemeName } from "@/lib/theme";

interface AllowRule { id: string; domain: string; service: string; note: string }
interface Family { id: string; name: string; emoji: string; color: string; sort: number; user_id: string | null }
interface Placement { id: string; entity_id: string; room: string; floor: number; x: number; y: number; icon: string | null }
interface Setting { key: string; value: string }

const input =
  "rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-muted/60 focus:border-lamp/60";
const btn =
  "rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-muted transition-colors hover:border-lamp/50 hover:text-ink disabled:opacity-50";
const primary =
  "rounded-md bg-lamp px-3 py-2 text-xs font-semibold text-field transition-opacity hover:opacity-90 disabled:opacity-50";
const th = "px-3 py-2 font-medium text-left text-[11px] uppercase tracking-wider text-ink-muted";
const sectionTitle = "mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted";

const TABS = ["Users", "Family", "Devices", "Allowlist", "HA Bridge", "Settings", "Audit"] as const;
type Tab = (typeof TABS)[number];

function AdminInner() {
  const [tab, setTab] = useState<Tab>("Users");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [users, setUsers] = useState<User[]>([]);
  const [family, setFamily] = useState<Family[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [rules, setRules] = useState<AllowRule[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [audit, setAudit] = useState<AuditRow[]>([]);

  const refresh = useCallback(async () => {
    const j = (r: Response) => (r.ok ? r.json() : []);
    const [u, f, p, e, al, st, au] = await Promise.all([
      api("/api/admin/users").then(j),
      api("/api/admin/family").then(j),
      api("/api/placements").then(j),
      api("/api/entities").then(j),
      api("/api/admin/allowlist").then(j),
      api("/api/admin/settings").then(j),
      api("/api/admin/audit?limit=100").then(j),
    ]);
    setUsers(u); setFamily(f); setPlacements(p); setEntities(e); setRules(al); setAudit(au);
    setSettings(Object.fromEntries((st as Setting[]).map((s) => [s.key, s.value])));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const act = async (fn: () => Promise<Response>) => {
    setError(""); setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) setError((await res.json().catch(() => null))?.detail ?? `Failed (${res.status})`);
      await refresh();
      return res.ok;
    } finally { setBusy(false); }
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-5 flex items-center gap-3">
        <a href="/" className={btn}>← Dashboard</a>
        <h1 className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-wide">Admin</h1>
      </div>

      <div className="mb-6 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t ? "bg-panel-raised text-ink border border-lamp/40" : "border border-line text-ink-muted hover:text-ink"}`}>
            {t}
          </button>
        ))}
      </div>

      {error && <p className="mb-4 rounded-md border border-alert/40 bg-panel p-3 text-sm text-alert">{error}</p>}

      {tab === "Users" && <UsersTab {...{ users, busy, act }} />}
      {tab === "Family" && <FamilyTab {...{ family, users, busy, act }} />}
      {tab === "Devices" && <DevicesTab {...{ placements, entities, busy, act }} />}
      {tab === "Allowlist" && <AllowlistTab {...{ rules, busy, act }} />}
      {tab === "HA Bridge" && <HABridgeTab {...{ busy, act }} />}
      {tab === "Settings" && <SettingsTab {...{ settings, entities, busy, act }} />}
      {tab === "Audit" && <AuditTab audit={audit} />}
    </main>
  );
}

// ---------------------------------------------------------------- Users
function UsersTab({ users, busy, act }: { users: User[]; busy: boolean; act: (f: () => Promise<Response>) => Promise<boolean> }) {
  const [nu, setNu] = useState({ username: "", password: "", display_name: "", role: "member" });
  const patch = (id: string, body: Record<string, unknown>) =>
    act(() => api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }));
  return (
    <section>
      <h2 className={sectionTitle}>Login accounts</h2>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line"><th className={th}>User</th><th className={th}>Role</th><th className={th}>Status</th><th className={th}>Actions</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-line/60 last:border-0">
                <td className="px-3 py-2.5">
                  <div className="font-medium">{u.display_name || u.username}</div>
                  <div className="font-[family-name:var(--font-mono)] text-[11px] text-ink-muted">{u.username}</div>
                </td>
                <td className="px-3 py-2.5"><span className={u.role === "admin" ? "text-lamp" : "text-ink-muted"}>{u.role}</span></td>
                <td className="px-3 py-2.5"><span className={u.disabled ? "text-alert" : "text-ok"}>{u.disabled ? "disabled" : "active"}</span></td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    <select disabled={busy} className={`${btn} cursor-pointer`} value={u.role}
                            onChange={(e) => patch(u.id, { role: e.target.value })}>
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                    <button disabled={busy} className={btn} onClick={() => patch(u.id, { disabled: !u.disabled })}>
                      {u.disabled ? "Enable" : "Disable"}
                    </button>
                    <button disabled={busy} className={btn} onClick={() => { const pw = window.prompt(`New password for ${u.username} (10+ chars):`); if (pw) patch(u.id, { password: pw }); }}>
                      Reset password
                    </button>
                    <button disabled={busy} className={btn} onClick={() => {
                      const pin = window.prompt(`Arm/disarm PIN for ${u.username} (4-8 digits):`);
                      if (pin === null) return;
                      if (!/^\d{4,8}$/.test(pin)) { window.alert("PIN must be 4-8 digits"); return; }
                      patch(u.id, { pin });
                    }}>
                      {u.pin_set ? "Change PIN" : "Set PIN"}
                    </button>
                    {u.pin_set && (
                      <button disabled={busy} className={btn} onClick={() => {
                        if (window.confirm(`Remove ${u.username}'s alarm PIN? They will arm/disarm without one.`)) patch(u.id, { clear_pin: true });
                      }}>
                        Clear PIN
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input className={input} placeholder="Username" autoCapitalize="none" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
        <input className={input} placeholder="Display name" value={nu.display_name} onChange={(e) => setNu({ ...nu, display_name: e.target.value })} />
        <input className={input} type="password" placeholder="Password (10+)" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
        <select className={input} value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
          <option value="member">member</option><option value="admin">admin</option>
        </select>
        <button disabled={busy || !nu.username || !nu.password} className={primary}
          onClick={() => act(() => api("/api/admin/users", { method: "POST", body: JSON.stringify(nu) })).then((ok) => ok && setNu({ username: "", password: "", display_name: "", role: "member" }))}>
          Add user
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Family
function FamilyTab({ family, users, busy, act }: { family: Family[]; users: User[]; busy: boolean; act: (f: () => Promise<Response>) => Promise<boolean> }) {
  const [nf, setNf] = useState({ name: "", emoji: "🙂", color: "#6b8afd" });
  const patch = (m: Family, body: Partial<Family>) =>
    act(() => api(`/api/admin/family/${m.id}`, { method: "PATCH", body: JSON.stringify(body) }));
  return (
    <section>
      <h2 className={sectionTitle}>Household roster <span className="normal-case tracking-normal">(Chore Quest, panels — no login needed)</span></h2>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line"><th className={th}>Member</th><th className={th}>Color</th><th className={th}>Linked account</th><th className={th}>Actions</th></tr></thead>
          <tbody>
            {family.map((m) => (
              <tr key={m.id} className="border-b border-line/60 last:border-0">
                <td className="px-3 py-2.5"><span className="mr-2 text-lg">{m.emoji}</span><span className="font-medium">{m.name}</span></td>
                <td className="px-3 py-2.5">
                  <input type="color" value={m.color} disabled={busy} className="h-6 w-10 cursor-pointer rounded border border-line bg-transparent"
                    onChange={(e) => patch(m, { color: e.target.value })} />
                </td>
                <td className="px-3 py-2.5">
                  <select className={input} value={m.user_id ?? ""} disabled={busy}
                    onChange={(e) => patch(m, { user_id: e.target.value || null })}>
                    <option value="">— none —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex gap-1.5">
                    <button disabled={busy} className={btn} onClick={() => { const em = window.prompt("Emoji:", m.emoji); if (em) patch(m, { emoji: em }); }}>Emoji</button>
                    <button disabled={busy} className={btn} onClick={() => { if (window.confirm(`Remove ${m.name} from the roster?`)) act(() => api(`/api/admin/family/${m.id}`, { method: "DELETE" })); }}>Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input className={input} placeholder="Name" value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} />
        <input className={`${input} w-16 text-center`} value={nf.emoji} onChange={(e) => setNf({ ...nf, emoji: e.target.value })} />
        <input type="color" value={nf.color} className="h-9 w-12 cursor-pointer rounded-md border border-line bg-transparent" onChange={(e) => setNf({ ...nf, color: e.target.value })} />
        <button disabled={busy || !nf.name} className={primary}
          onClick={() => act(() => api("/api/admin/family", { method: "POST", body: JSON.stringify({ ...nf, sort: family.length }) })).then((ok) => ok && setNf({ name: "", emoji: "🙂", color: "#6b8afd" }))}>
          Add member
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Devices
function DevicesTab({ placements, entities, busy, act }: { placements: Placement[]; entities: Entity[]; busy: boolean; act: (f: () => Promise<Response>) => Promise<boolean> }) {
  const placed = new Set(placements.map((p) => p.entity_id));
  const unplaced = entities.filter((e) => e.domain === "binary_sensor" && !placed.has(e.entity_id));
  const [sel, setSel] = useState("");
  const save = (p: Placement, body: Partial<Placement>) =>
    act(() => api(`/api/placements/${p.entity_id}`, { method: "PUT", body: JSON.stringify({ ...p, ...body }) }));
  return (
    <section>
      <h2 className={sectionTitle}>Sensor placements <span className="normal-case tracking-normal">(drag mode also available on the Security board)</span></h2>
      <div className="mb-3">
        <a href={`${API_URL}/api/export/sensors.xlsx`} className={btn} download>
          Export sensors (.xlsx)
        </a>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line"><th className={th}>Entity</th><th className={th}>Room</th><th className={th}>Floor</th><th className={th}>X</th><th className={th}>Y</th><th className={th}>Live</th><th className={th}></th></tr></thead>
          <tbody>
            {placements.map((p) => {
              const ent = entities.find((e) => e.entity_id === p.entity_id);
              return (
                <tr key={p.id} className="border-b border-line/60 last:border-0">
                  <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-[11px]">{p.entity_id}</td>
                  <td className="px-3 py-2">
                    <input className={`${input} w-32 py-1`} defaultValue={p.room} onBlur={(e) => e.target.value !== p.room && save(p, { room: e.target.value })} />
                  </td>
                  <td className="px-3 py-2">
                    <select className={`${input} py-1`} value={p.floor} disabled={busy} onChange={(e) => save(p, { floor: Number(e.target.value) })}>
                      <option value={0}>Ground</option><option value={1}>Upstairs</option>
                    </select>
                  </td>
                  <td className="px-3 py-2"><input className={`${input} w-20 py-1`} type="number" step="0.1" defaultValue={p.x} onBlur={(e) => Number(e.target.value) !== p.x && save(p, { x: Number(e.target.value) })} /></td>
                  <td className="px-3 py-2"><input className={`${input} w-20 py-1`} type="number" step="0.1" defaultValue={p.y} onBlur={(e) => Number(e.target.value) !== p.y && save(p, { y: Number(e.target.value) })} /></td>
                  <td className="px-3 py-2">
                    {ent ? <span className={ent.state === "on" ? "text-alert" : "text-ok"}>{ent.state === "on" ? "active" : "clear"}</span>
                         : <span className="text-ink-muted">offline</span>}
                  </td>
                  <td className="px-3 py-2">
                    <button disabled={busy} className={btn} onClick={() => window.confirm(`Remove placement for ${p.entity_id}?`) && act(() => api(`/api/placements/${p.entity_id}`, { method: "DELETE" }))}>Remove</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select className={input} value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value="">Add unplaced sensor…</option>
          {unplaced.map((e) => <option key={e.entity_id} value={e.entity_id}>{e.friendly_name} ({e.entity_id})</option>)}
        </select>
        <button disabled={busy || !sel} className={primary}
          onClick={() => act(() => api(`/api/placements/${sel}`, { method: "PUT", body: JSON.stringify({ entity_id: sel, room: "", floor: 0, x: 0, y: 0 }) })).then((ok) => ok && setSel(""))}>
          Place at origin
        </button>
        <span className="text-xs text-ink-muted">then drag it into position on the Security board</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Allowlist
function AllowlistTab({ rules, busy, act }: { rules: AllowRule[]; busy: boolean; act: (f: () => Promise<Response>) => Promise<boolean> }) {
  const [nr, setNr] = useState({ domain: "", service: "", note: "" });
  return (
    <section>
      <h2 className={sectionTitle}>Service allowlist</h2>
      <p className="mb-4 max-w-2xl text-xs leading-relaxed text-ink-muted">
        The only HA services this app will ever forward. Treat additions like firewall rules: every one widens
        what a signed-in session can make the house do, takes effect immediately, and is audit-logged.
      </p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line"><th className={th}>Service</th><th className={th}>Note</th><th className={th}></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-b border-line/60 last:border-0">
                <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-[12px]">{r.domain}.{r.service}</td>
                <td className="px-3 py-2 text-ink-muted">{r.note}</td>
                <td className="px-3 py-2 text-right">
                  <button disabled={busy} className={btn}
                    onClick={() => window.confirm(`Remove ${r.domain}.${r.service}? Calls will 403 immediately.`) && act(() => api(`/api/admin/allowlist/${r.id}`, { method: "DELETE" }))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input className={input} placeholder="domain (e.g. cover)" value={nr.domain} onChange={(e) => setNr({ ...nr, domain: e.target.value })} />
        <input className={input} placeholder="service (e.g. open_cover)" value={nr.service} onChange={(e) => setNr({ ...nr, service: e.target.value })} />
        <input className={`${input} flex-1 min-w-40`} placeholder="Why is this needed?" value={nr.note} onChange={(e) => setNr({ ...nr, note: e.target.value })} />
        <button disabled={busy || !nr.domain || !nr.service || !nr.note} className={primary}
          onClick={() => act(() => api("/api/admin/allowlist", { method: "POST", body: JSON.stringify(nr) })).then((ok) => ok && setNr({ domain: "", service: "", note: "" }))}>
          Allow service
        </button>
      </div>
      <p className="mt-2 text-[11px] text-ink-muted">A note is required — future-you audits this list.</p>
    </section>
  );
}

// ---------------------------------------------------------------- HA Bridge
interface HASettings { ha_url: string; ha_mock: boolean; token_set: boolean; mode: string }
function HABridgeTab({ busy, act }: { busy: boolean; act: (f: () => Promise<Response>) => Promise<boolean> }) {
  const [cfg, setCfg] = useState<HASettings | null>(null);
  const [url, setUrl] = useState("");
  const [mock, setMock] = useState(true);
  const [token, setToken] = useState("");

  const load = useCallback(async () => {
    const res = await api("/api/admin/settings/ha");
    if (res.ok) {
      const d: HASettings = await res.json();
      setCfg(d); setUrl(d.ha_url); setMock(d.ha_mock);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = () =>
    act(() => api("/api/admin/settings/ha", {
      method: "PUT",
      body: JSON.stringify({ ha_url: url, ha_mock: mock, ...(token ? { ha_token: token } : {}) }),
    })).then((ok) => { if (ok) { setToken(""); load(); } });

  const restart = () =>
    act(() => api("/api/admin/bridge/restart", { method: "POST" })).then(() => load());

  if (!cfg) return <p className="text-sm text-ink-muted">…</p>;
  return (
    <section>
      <h2 className={sectionTitle}>Home Assistant bridge</h2>
      <div className="mb-5 flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3">
        <span className={`inline-block size-2 rounded-full ${cfg.mode === "live" ? "bg-ok" : "bg-lamp"} lamp-live`} />
        <span className="text-sm">
          Bridge mode: <span className="font-semibold">{cfg.mode}</span>
          {cfg.mode === "mock" && <span className="text-ink-muted"> — simulated devices, no HA needed</span>}
        </span>
      </div>
      <div className="flex max-w-md flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-muted">HA URL (across your WireGuard/Tailscale tunnel — never a port-forwarded HA)</span>
          <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://100.x.y.z:8123" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-muted">
            Long-lived access token {cfg.token_set && <span className="text-ok">(set — enter a value only to replace it)</span>}
          </span>
          <input className={input} type="password" value={token} onChange={(e) => setToken(e.target.value)}
            placeholder={cfg.token_set ? "••••••••  (write-only, never displayed)" : "paste HA long-lived token"} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} className="accent-[#e8a33d]" />
          Mock mode (simulated devices)
        </label>
        <div className="mt-1 flex gap-2">
          <button disabled={busy} className={primary} onClick={save}>Save</button>
          <button disabled={busy} className={btn} onClick={restart}>Restart bridge</button>
        </div>
        <p className="text-[11px] leading-relaxed text-ink-muted">
          Saving stores the token server-side; it is never returned by any API. Restart applies the new
          config without redeploying. To go live: tunnel up → URL + token here → uncheck mock → restart.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Settings
function SettingsTab({ settings, entities, busy, act }: { settings: Record<string, string>; entities: Entity[]; busy: boolean; act: (f: () => Promise<Response>) => Promise<boolean> }) {
  // Sensors that can raise an alert card: binary_sensors + locks (matches
  // SensorFlash.activeVerb). Includes Z-Wave diagnostics with no device
  // class so their AC-mains/tamper chatter can be silenced per-sensor.
  const alertable = entities
    .filter((e) => e.domain === "binary_sensor" || e.domain === "lock")
    .sort((a, b) => (a.friendly_name || a.entity_id).localeCompare(b.friendly_name || b.entity_id));
  type Rule = "all" | "armed_only" | "off";
  const parseRules = (raw: string | undefined): Record<string, Rule> => {
    try {
      const p0 = JSON.parse(raw || "{}");
      const out: Record<string, Rule> = {};
      for (const [k, v] of Object.entries(p0)) if (v === "all" || v === "armed_only" || v === "off") out[k] = v;
      return out;
    } catch { return {}; }
  };
  const [form, setForm] = useState<Record<string, string>>(settings);
  const [kioskPw, setKioskPw] = useState("");
  const [kioskSet, setKioskSet] = useState(false);
  useEffect(() => {
    api("/api/admin/kiosk-password").then((r) => (r.ok ? r.json() : { set: false })).then((d) => setKioskSet(!!d.set)).catch(() => {});
  }, []);
  useEffect(() => setForm(settings), [settings]);
  const fields: [string, string, string][] = [
    ["home_name", "Home name", "Fort Knox"],
    ["latitude", "Latitude", "for weather/radar"],
    ["longitude", "Longitude", "for weather/radar"],
    ["timezone", "Timezone", "America/New_York"],
  ];
  return (
    <section>
      <h2 className={sectionTitle}>App settings</h2>
      <div className="flex max-w-md flex-col gap-3">
        {fields.map(([key, label, ph]) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">{label}</span>
            <input className={input} placeholder={ph} value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
          </label>
        ))}

        <h3 className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Sensor alert cards</h3>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-ink-muted">Show alerts</span>
          <select className={input} value={form.alerts_mode ?? "all"} onChange={(e) => setForm({ ...form, alerts_mode: e.target.value })}>
            <option value="all">Always (amber when disarmed, alarm color when armed)</option>
            <option value="armed_only">Only while armed</option>
            <option value="off">Off</option>
          </select>
        </label>
        <div className="flex gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Disarmed color</span>
            <input type="color" className="h-9 w-16 cursor-pointer rounded border border-line bg-panel"
              value={form.alert_color_disarmed || "#e8a33d"} onChange={(e) => setForm({ ...form, alert_color_disarmed: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Armed color</span>
            <input type="color" className="h-9 w-16 cursor-pointer rounded border border-line bg-panel"
              value={form.alert_color_armed || "#e0483d"} onChange={(e) => setForm({ ...form, alert_color_armed: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Auto-dismiss (s, 0 = stay)</span>
            <input type="number" min={0} max={600} className={`${input} w-28`}
              value={form.alert_dismiss_secs ?? "10"} onChange={(e) => setForm({ ...form, alert_dismiss_secs: e.target.value })} />
          </label>
        </div>
        <p className="text-[11px] text-ink-muted">Armed alerts always stay until acknowledged. Changes reach open panels within a minute.</p>

        <h3 className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Kiosk mode</h3>
        <p className="-mt-1 text-[11px] text-ink-muted">
          Any signed-in screen can enter kiosk mode (family views only, big bottom tabs, no admin or deletes) with this
          password, and exit with the same one. Set it once here; it&apos;s stored hashed and never shown.
        </p>
        <div className="flex items-center gap-2">
          <input type="password" className={`${input} w-56`} placeholder={kioskSet ? "Change kiosk password" : "Set kiosk password"}
                 value={kioskPw} onChange={(e) => setKioskPw(e.target.value)} autoComplete="new-password" />
          <button disabled={busy || kioskPw.length < 4} className={btn}
                  onClick={() => act(() => api("/api/admin/kiosk-password", { method: "PUT", body: JSON.stringify({ password: kioskPw }) }))
                    .then((ok) => { if (ok) { setKioskPw(""); setKioskSet(true); } })}>
            Save
          </button>
          <span className="text-[11px] text-ink-muted">{kioskSet ? "Password set" : "Not set yet"}</span>
        </div>

        <h3 className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Appearance</h3>
        <div className="flex flex-col gap-2">
          <span className="text-xs text-ink-muted">Theme</span>
          <div className="flex gap-2">
            {(["light", "moderate", "dark"] as const).map((t) => (
              <button key={t}
                onClick={() => { setForm({ ...form, theme_mode: t }); applyTheme(t, form.theme_accent || null); }}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm capitalize transition-colors ${
                  (form.theme_mode || "dark") === t ? "border-lamp/70 text-ink" : "border-line text-ink-muted hover:text-ink"
                }`}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">Accent color</span>
            <input type="color" className="h-9 w-16 cursor-pointer rounded border border-line bg-panel"
              value={form.theme_accent || "#e8a33d"}
              onChange={(e) => { setForm({ ...form, theme_accent: e.target.value }); applyTheme((form.theme_mode as ThemeName) || "dark", e.target.value); }} />
          </label>
          <button
            onClick={() => { setForm({ ...form, theme_accent: "" }); applyTheme((form.theme_mode as ThemeName) || "dark", null); }}
            className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-muted hover:text-ink">
            Reset to theme default
          </button>
        </div>
        <p className="text-[11px] text-ink-muted">Preview applies live on this device; Save settings pushes it to every panel.</p>

        <h3 className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Per-sensor alert rules</h3>
        <p className="-mt-1 text-[11px] text-ink-muted">
          Override the global setting per sensor — e.g. set daytime-noisy motion sensors to &quot;Only while armed&quot;.
        </p>
        <div className="max-h-80 overflow-y-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <tbody>
              {alertable.length === 0 && (
                <tr><td className="px-3 py-3 text-xs text-ink-muted">No sensors visible — bridge offline?</td></tr>
              )}
              {alertable.map((e) => {
                const rules = parseRules(form.alert_rules);
                const cur = rules[e.entity_id] ?? "default";
                return (
                  <tr key={e.entity_id} className="border-b border-line/60 last:border-0">
                    <td className="px-3 py-2">
                      <div className="text-sm">{e.friendly_name || e.entity_id}</div>
                      <div className="font-[family-name:var(--font-mono)] text-[10px] text-ink-muted">{e.entity_id}</div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <select
                        className={`${input} py-1 text-xs`}
                        value={cur}
                        onChange={(ev) => {
                          const next = parseRules(form.alert_rules);
                          if (ev.target.value === "default") delete next[e.entity_id];
                          else next[e.entity_id] = ev.target.value as Rule;
                          setForm({ ...form, alert_rules: JSON.stringify(next) });
                        }}
                      >
                        <option value="default">Default</option>
                        <option value="all">Always</option>
                        <option value="armed_only">Only while armed</option>
                        <option value="off">Never</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button disabled={busy} className={`${primary} mt-1 self-start`}
          onClick={() => {
            // send ONLY known editable fields — never echo back whatever the
            // GET returned (defense in depth against key leakage)
            const keys = [...fields.map(([key]) => key), "alerts_mode", "alert_color_disarmed", "alert_color_armed", "alert_dismiss_secs", "alert_rules", "theme_mode", "theme_accent"];
            const values = Object.fromEntries(keys.map((key) => [key, form[key] ?? ""]));
            act(() => api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ values }) }));
          }}>
          Save settings
        </button>
        <p className="text-[11px] leading-relaxed text-ink-muted">
          Secrets never live here: the HA token, database credentials, and cookie settings are environment-only
          (server <span className="font-[family-name:var(--font-mono)]">.env</span>), by design.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Audit
function AuditTab({ audit }: { audit: AuditRow[] }) {
  return (
    <section>
      <h2 className={sectionTitle}>Audit log <span className="normal-case tracking-normal">(latest 100)</span></h2>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <tbody>
            {audit.map((r) => (
              <tr key={r.id} className="border-b border-line/60 last:border-0">
                <td className="whitespace-nowrap px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] text-ink-muted">{new Date(r.ts).toLocaleString()}</td>
                <td className="px-3 py-2 font-medium">{r.username}</td>
                <td className="px-3 py-2"><span className={r.action.includes("failed") ? "text-alert" : "text-ink"}>{r.action}</span></td>
                <td className="px-3 py-2 text-ink-muted">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function AdminPage() {
  return (
    <AuthGate adminOnly>
      <AdminInner />
    </AuthGate>
  );
}
