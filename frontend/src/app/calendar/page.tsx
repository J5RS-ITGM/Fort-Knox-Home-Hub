"use client";

/** Family calendar — the hub for a household of six. Month and week views,
 *  per-member color identity, event categories, filtering by person and
 *  category, recurring events, and iCal import/export. Google Calendar
 *  live sync is a separate feature layered on top of the same model. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageShell from "@/components/PageShell";
import { api, API_URL } from "@/lib/api";
import { isKiosk, useMe } from "@/lib/auth";

interface Member { id: string; name: string; emoji: string; color: string; }
interface Ev {
  id: string; title: string; date: string; time: string | null; end_time: string | null;
  member_id: string | null; category: string; location: string; notes: string;
  recur: string; source: string;
}

const CATS: { key: string; label: string; color: string }[] = [
  { key: "school", label: "School", color: "#4f83f0" },
  { key: "sports", label: "Sports", color: "#3fb98f" },
  { key: "activity", label: "Activity", color: "#c77dff" },
  { key: "appointment", label: "Appt", color: "#e0574d" },
  { key: "birthday", label: "Birthday", color: "#f0a838" },
  { key: "holiday", label: "Holiday", color: "#e879b9" },
  { key: "chore", label: "Chore", color: "#8a91a0" },
  { key: "work", label: "Work", color: "#6b8afd" },
  { key: "general", label: "General", color: "#9199a8" },
];
const catColor = (k: string) => CATS.find((c) => c.key === k)?.color ?? "#9199a8";
const dstr = (d: Date) => d.toISOString().slice(0, 10);
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function CalendarPage() {
  const { me } = useMe();
  const canEdit = !isKiosk(me);
  const [view, setView] = useState<"month" | "week">("month");
  const [anchor, setAnchor] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [weekAnchor, setWeekAnchor] = useState(() => new Date());
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [memberFilter, setMemberFilter] = useState<Set<string>>(new Set());
  const [catFilter, setCatFilter] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Ev | null>(null);
  const [creatingOn, setCreatingOn] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [pinPrompt, setPinPrompt] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [rangeStart, rangeEnd] = useMemo(() => {
    if (view === "week") {
      const mon = new Date(weekAnchor); mon.setDate(weekAnchor.getDate() - ((weekAnchor.getDay() + 6) % 7));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return [dstr(mon), dstr(sun)];
    }
    const first = new Date(anchor);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(first); start.setDate(first.getDate() - lead);
    const end = new Date(start); end.setDate(start.getDate() + 41);
    return [dstr(start), dstr(end)];
  }, [view, anchor, weekAnchor]);

  const load = useCallback(async () => {
    const [m, e] = await Promise.all([
      api("/api/family").then((r) => (r.ok ? r.json() : [])),
      api(`/api/events?start=${rangeStart}&end=${rangeEnd}`).then((r) => (r.ok ? r.json() : [])),
    ]);
    setMembers(m); setEvents(e);
  }, [rangeStart, rangeEnd]);
  useEffect(() => { void load(); }, [load]);
  // Sync is gated by the user's PIN (same credential as arm/disarm). The
  // backend is the source of truth: a 409 means Google isn't connected, a
  // 403 pin_required/pin_invalid drives the keypad. No client-side flags.
  const runSync = async (pin?: string) => {
    setSyncing(true); setSyncMsg("Syncing…");
    const r = await api("/api/google/sync", { method: "POST", body: JSON.stringify(pin ? { pin } : {}) });
    setSyncing(false);
    if (r.ok) {
      const d = await r.json();
      setPinPrompt(false);
      setSyncMsg(`Synced: ${d.pulled} in, ${d.pushed} out${d.recolored ? `, ${d.recolored} recolored` : ""}.`);
      await load();
    } else if (r.status === 403) {
      const d = await r.json().catch(() => null);
      if (d?.detail === "pin_required" || d?.detail === "pin_invalid") {
        setPinPrompt(true);
        setSyncMsg(d.detail === "pin_invalid" ? "Wrong PIN." : "");
        return;
      }
      setSyncMsg("Not allowed.");
    } else if (r.status === 409) {
      setSyncMsg("Google not connected (set it up in Admin → Settings).");
    } else {
      setSyncMsg("Sync failed.");
    }
    if (!pinPrompt) window.setTimeout(() => setSyncMsg(""), 6000);
  };

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const visible = useMemo(() => events.filter((e) =>
    (memberFilter.size === 0 || (e.member_id != null && memberFilter.has(e.member_id))) &&
    (catFilter.size === 0 || catFilter.has(e.category))
  ), [events, memberFilter, catFilter]);
  const byDate = useMemo(() => {
    const m = new Map<string, Ev[]>();
    visible.forEach((e) => m.set(e.date, [...(m.get(e.date) ?? []), e]));
    for (const list of m.values()) list.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    return m;
  }, [visible]);

  const toggle = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set); next.has(key) ? next.delete(key) : next.add(key); setter(next);
  };

  const importIcs = async (files: FileList | null) => {
    if (!files?.length) return;
    const body = new FormData(); body.append("file", files[0]);
    const r = await fetch(`${API_URL}/api/events/import.ics`, { method: "POST", credentials: "include", body });
    if (r.ok) { const d = await r.json(); window.alert(`Imported ${d.added} new, updated ${d.updated}.`); await load(); }
    else window.alert("Import failed.");
  };

  const monthCells = useMemo(() => {
    const first = new Date(anchor);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(first); start.setDate(first.getDate() - lead);
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, [anchor]);
  const weekDays = useMemo(() => {
    const mon = new Date(weekAnchor); mon.setDate(weekAnchor.getDate() - ((weekAnchor.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
  }, [weekAnchor]);

  const today = dstr(new Date());
  const title = view === "week"
    ? `Week of ${weekDays[0].toLocaleDateString([], { month: "short", day: "numeric" })}`
    : anchor.toLocaleDateString([], { month: "long", year: "numeric" });

  const step = (dir: number) => {
    if (view === "week") { const d = new Date(weekAnchor); d.setDate(d.getDate() + dir * 7); setWeekAnchor(d); }
    else setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
  };

  const dot = (e: Ev) => {
    const mem = e.member_id ? memberById.get(e.member_id) : null;
    return mem?.color ?? catColor(e.category);
  };

  return (
    <PageShell title="Family Calendar" active="/calendar" wide>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line p-0.5">
          {(["month", "week"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`rounded-md px-3 py-1 text-xs font-medium capitalize ${view === v ? "bg-panel-raised text-ink" : "text-ink-muted"}`}>{v}</button>
          ))}
        </div>
        <button className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-muted hover:text-ink" onClick={() => step(-1)}>&larr;</button>
        <span className="min-w-40 text-center text-sm font-semibold">{title}</span>
        <button className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-muted hover:text-ink" onClick={() => step(1)}>&rarr;</button>
        <button className="rounded-md border border-line px-3 py-1 text-xs text-ink-muted hover:text-ink"
          onClick={() => { setAnchor(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); setWeekAnchor(new Date()); }}>Today</button>

        <div className="ml-auto flex items-center gap-2">
          {canEdit && (
            <button onClick={() => runSync()} disabled={syncing}
              className="rounded-md border border-lamp/60 bg-lamp/10 px-3 py-1.5 text-xs font-semibold text-lamp disabled:opacity-50">
              {syncing ? "Syncing…" : "↻ Sync Google"}
            </button>
          )}
          <a href={`${API_URL}/api/events/export.ics`} download className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-muted hover:text-ink">Export .ics</a>
          {canEdit && <>
            <button onClick={() => fileRef.current?.click()} className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-muted hover:text-ink">Import .ics</button>
            <input ref={fileRef} type="file" accept=".ics,text/calendar" hidden onChange={(e) => { void importIcs(e.target.files); e.target.value = ""; }} />
            <button onClick={() => setCreatingOn(today)} className="rounded-md border border-lamp/60 bg-lamp/10 px-3 py-1.5 text-xs font-semibold text-lamp">+ Event</button>
          </>}
        </div>
      </div>
      {syncMsg && <div className="mb-2 text-xs text-ink-muted">{syncMsg}</div>}

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {members.map((m) => {
          const on = memberFilter.has(m.id);
          return (
            <button key={m.id} onClick={() => toggle(memberFilter, m.id, setMemberFilter)}
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
              style={{ borderColor: on ? m.color : "var(--color-line)", background: on ? `${m.color}22` : "transparent", color: on ? "var(--color-ink)" : "var(--color-ink-muted)" }}>
              <span className="size-2 rounded-full" style={{ background: m.color }} /> {m.emoji} {m.name}
            </button>
          );
        })}
        <span className="mx-1 h-4 w-px bg-line" />
        {CATS.filter((c) => c.key !== "general").map((c) => {
          const on = catFilter.has(c.key);
          return (
            <button key={c.key} onClick={() => toggle(catFilter, c.key, setCatFilter)}
              className="rounded-full border px-2.5 py-1 text-xs transition-colors"
              style={{ borderColor: on ? c.color : "var(--color-line)", background: on ? `${c.color}22` : "transparent", color: on ? "var(--color-ink)" : "var(--color-ink-muted)" }}>
              {c.label}
            </button>
          );
        })}
        {(memberFilter.size > 0 || catFilter.size > 0) && (
          <button onClick={() => { setMemberFilter(new Set()); setCatFilter(new Set()); }} className="ml-1 text-xs text-ink-muted underline">clear</button>
        )}
      </div>

      {view === "month" ? (
        <div>
          <div className="mb-1 grid grid-cols-7 text-center text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
            {WD.map((d) => <div key={d} className="py-1">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {monthCells.map((d) => {
              const ds = dstr(d);
              const inMonth = d.getMonth() === anchor.getMonth();
              const evs = byDate.get(ds) ?? [];
              return (
                <div key={ds}
                  className={`min-h-28 lg:min-h-36 rounded-lg border p-2 ${ds === today ? "border-ok/50" : "border-line"} ${inMonth ? "bg-panel" : "bg-panel/40"}`}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className={`text-xs font-semibold ${inMonth ? "" : "text-ink-muted"}`}>{d.getDate()}</span>
                    {canEdit && <button onClick={() => setCreatingOn(ds)} className="text-xs leading-none text-ink-muted hover:text-lamp">+</button>}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {evs.slice(0, 6).map((e) => (
                      <button key={e.id + e.date} onClick={() => canEdit && setEditing(e)}
                        className="flex items-center gap-1 truncate rounded px-1.5 py-1 text-left text-xs"
                        style={{ background: `${dot(e)}22`, color: "var(--color-ink)" }}>
                        <span className="size-1.5 shrink-0 rounded-full" style={{ background: dot(e) }} />
                        {e.time && <span className="shrink-0 text-ink-muted">{e.time}</span>}
                        <span className="truncate">{e.title}</span>
                      </button>
                    ))}
                    {evs.length > 6 && <span className="pl-1 text-[10px] text-ink-muted">+{evs.length - 6} more</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {weekDays.map((d) => {
            const ds = dstr(d);
            const evs = byDate.get(ds) ?? [];
            return (
              <div key={ds} className={`min-h-[72vh] rounded-lg border p-2 ${ds === today ? "border-ok/50" : "border-line"} bg-panel`}>
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <div className="text-[11px] uppercase text-ink-muted">{WD[(d.getDay() + 6) % 7]}</div>
                    <div className="text-sm font-semibold">{d.getDate()}</div>
                  </div>
                  {canEdit && <button onClick={() => setCreatingOn(ds)} className="text-ink-muted hover:text-lamp">+</button>}
                </div>
                <div className="flex flex-col gap-1">
                  {evs.map((e) => (
                    <button key={e.id + e.date} onClick={() => canEdit && setEditing(e)}
                      className="rounded-md border-l-2 bg-panel-raised px-2 py-1 text-left"
                      style={{ borderColor: dot(e) }}>
                      <div className="text-[11px] font-medium">{e.time ?? "All day"}</div>
                      <div className="truncate text-xs">{e.title}</div>
                      {e.member_id && <div className="truncate text-[10px] text-ink-muted">{memberById.get(e.member_id)?.name}</div>}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pinPrompt && (
        <SyncPinPrompt busy={syncing} error={syncMsg === "Wrong PIN." ? syncMsg : ""}
          onSubmit={(pin) => runSync(pin)} onClose={() => { setPinPrompt(false); setSyncMsg(""); }} />
      )}

      {(editing || creatingOn) && (
        <EventEditor
          members={members}
          initial={editing}
          date={creatingOn ?? editing?.date ?? today}
          onClose={() => { setEditing(null); setCreatingOn(null); }}
          onSaved={async () => { setEditing(null); setCreatingOn(null); await load(); }}
        />
      )}
    </PageShell>
  );
}

function EventEditor({ members, initial, date, onClose, onSaved }: {
  members: Member[]; initial: Ev | null; date: string; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    title: initial?.title ?? "", date: initial?.date ?? date, time: initial?.time ?? "",
    end_time: initial?.end_time ?? "", member_id: initial?.member_id ?? "",
    category: initial?.category ?? "general", location: initial?.location ?? "", notes: initial?.notes ?? "",
    recur: initial?.recur ?? "none", recur_days: "", recur_until: "",
  });
  const [busy, setBusy] = useState(false);
  const input = "rounded-md border border-line bg-panel-raised px-2.5 py-1.5 text-sm outline-none focus:border-lamp/60";

  const save = async () => {
    if (!f.title.trim()) return;
    setBusy(true);
    const payload = { ...f, time: f.time || null, end_time: f.end_time || null, member_id: f.member_id || null, recur_until: f.recur_until || null };
    const path = initial ? `/api/events/${initial.id}` : "/api/events";
    const method = initial ? "PATCH" : "POST";
    await api(path, { method, body: JSON.stringify(payload) });
    setBusy(false); onSaved();
  };
  const del = async () => {
    if (!initial || !window.confirm("Delete this event?")) return;
    await api(`/api/events/${initial.id}`, { method: "DELETE" }); onSaved();
  };

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/80 p-4 backdrop-blur" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-base font-semibold">{initial ? "Edit event" : "New event"}</h3>
        <div className="flex flex-col gap-2">
          <input className={input} placeholder="What's happening?" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus />
          <div className="flex gap-2">
            <input type="date" className={`${input} flex-1`} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            <input type="time" className={`${input} w-28`} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
            <input type="time" className={`${input} w-28`} value={f.end_time} onChange={(e) => setF({ ...f, end_time: e.target.value })} />
          </div>
          <div className="flex gap-2">
            <select className={`${input} flex-1`} value={f.member_id} onChange={(e) => setF({ ...f, member_id: e.target.value })}>
              <option value="">Whole family</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>)}
            </select>
            <select className={`${input} flex-1`} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {CATS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <input className={input} placeholder="Location (optional)" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
          <div className="flex gap-2">
            <select className={`${input} flex-1`} value={f.recur} onChange={(e) => setF({ ...f, recur: e.target.value })}>
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every 2 weeks</option>
              <option value="monthly">Monthly</option>
            </select>
            {f.recur !== "none" && (
              <input type="date" className={`${input} flex-1`} title="Repeat until" value={f.recur_until} onChange={(e) => setF({ ...f, recur_until: e.target.value })} />
            )}
          </div>
          {(f.recur === "weekly" || f.recur === "biweekly") && (
            <div className="flex gap-1">
              {WD.map((d, i) => {
                const days = f.recur_days.split(",").filter(Boolean);
                const on = days.includes(String(i));
                return (
                  <button key={d} onClick={() => {
                    const next = on ? days.filter((x) => x !== String(i)) : [...days, String(i)];
                    setF({ ...f, recur_days: next.join(",") });
                  }} className={`flex-1 rounded-md border py-1 text-xs ${on ? "border-lamp/60 bg-lamp/10 text-lamp" : "border-line text-ink-muted"}`}>{d[0]}</button>
                );
              })}
            </div>
          )}
          <textarea className={`${input} min-h-16`} placeholder="Notes (optional)" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </div>
        <div className="mt-4 flex items-center gap-2">
          {initial && <button onClick={del} className="rounded-lg border border-alert/50 px-3 py-2 text-sm font-semibold text-alert">Delete</button>}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm text-ink-muted hover:text-ink">Cancel</button>
            <button onClick={save} disabled={busy || !f.title.trim()} className="rounded-lg border border-lamp/60 bg-lamp/10 px-4 py-2 text-sm font-semibold text-lamp disabled:opacity-40">{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SyncPinPrompt({ busy, error, onSubmit, onClose }: {
  busy: boolean; error: string; onSubmit: (pin: string) => void; onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const press = (d: string) => setPin((p) => (p.length < 8 ? p + d : p));
  const key = (label: string, onClick: () => void) => (
    <button key={label} onClick={onClick} disabled={busy}
      className="rounded-xl border border-line bg-panel-raised py-4 text-xl font-bold">{label}</button>
  );
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/80 p-4 backdrop-blur" onClick={onClose}>
      <div className="w-72 rounded-2xl border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-center text-sm font-semibold text-lamp">PIN to sync</div>
        <p className="mb-3 text-center text-[11px] text-ink-muted">Enter your arm/disarm PIN.</p>
        <div className="mb-2 flex justify-center gap-2" style={{ minHeight: 14 }}>
          {Array.from({ length: Math.max(pin.length, 4) }).map((_, i) => (
            <span key={i} className="size-3 rounded-full" style={{ background: i < pin.length ? "var(--color-lamp)" : "transparent", border: `1.5px solid ${i < pin.length ? "var(--color-lamp)" : "var(--color-line)"}` }} />
          ))}
        </div>
        <div className="mb-3 min-h-4 text-center text-xs font-semibold text-alert">{error}</div>
        <div className="grid grid-cols-3 gap-2">
          {["1","2","3","4","5","6","7","8","9"].map((d) => key(d, () => press(d)))}
          {key("⌫", () => setPin((p) => p.slice(0, -1)))}
          {key("0", () => press("0"))}
          {key("✕", onClose)}
        </div>
        <button onClick={() => onSubmit(pin)} disabled={busy || pin.length < 4}
          className="mt-3 w-full rounded-xl border border-lamp/60 bg-lamp/10 py-3 text-sm font-semibold text-lamp disabled:opacity-40">
          {busy ? "Checking…" : "Sync"}
        </button>
      </div>
    </div>
  );
}
