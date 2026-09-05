"use client";

/** Family calendar v1 — month grid backed by /api/events (app-owned data).
 *  Tap a day to see/add events; events can be tagged to a family member
 *  and pick up their color. */

import { useCallback, useEffect, useMemo, useState } from "react";
import PageShell from "@/components/PageShell";
import { api } from "@/lib/api";
import { useMe , isKiosk } from "@/lib/auth";

interface Member { id: string; name: string; emoji: string; color: string; }
interface Ev { id: string; title: string; date: string; time: string | null; member_id: string | null; notes: string; }

const dstr = (d: Date) => d.toISOString().slice(0, 10);

export default function CalendarPage() {
  const { me } = useMe();
  const canDelete = !isKiosk(me);
  const [anchor, setAnchor] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [selected, setSelected] = useState<string>(dstr(new Date()));
  const [form, setForm] = useState({ title: "", time: "", member_id: "" });
  const [busy, setBusy] = useState(false);

  const monthStart = dstr(anchor);
  const monthEnd = dstr(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0));

  const load = useCallback(async () => {
    const [m, e] = await Promise.all([
      api("/api/family").then((r) => (r.ok ? r.json() : [])),
      api(`/api/events?start=${monthStart}&end=${monthEnd}`).then((r) => (r.ok ? r.json() : [])),
    ]);
    setMembers(m); setEvents(e);
  }, [monthStart, monthEnd]);
  useEffect(() => { void load(); }, [load]);

  const byDate = useMemo(() => {
    const m = new Map<string, Ev[]>();
    events.forEach((e) => m.set(e.date, [...(m.get(e.date) ?? []), e]));
    return m;
  }, [events]);
  const colorOf = (id: string | null) => members.find((m) => m.id === id)?.color ?? "#7e8c9c";

  // month grid: weeks starting Monday
  const cells = useMemo(() => {
    const first = new Date(anchor);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(first); start.setDate(first.getDate() - lead);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i);
      return d;
    });
  }, [anchor]);

  const addEvent = async () => {
    if (!form.title.trim()) return;
    setBusy(true);
    try {
      await api("/api/events", {
        method: "POST",
        body: JSON.stringify({ title: form.title, date: selected, time: form.time || null, member_id: form.member_id || null }),
      });
      setForm({ title: "", time: "", member_id: form.member_id });
      await load();
    } finally { setBusy(false); }
  };
  const removeEvent = async (id: string) => {
    await api(`/api/events/${id}`, { method: "DELETE" });
    await load();
  };

  const monthName = anchor.toLocaleDateString([], { month: "long", year: "numeric" });
  const today = dstr(new Date());
  const dayEvents = byDate.get(selected) ?? [];
  const input = "rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm outline-none focus:border-lamp/60";

  return (
    <PageShell title="Calendar" active="/calendar">
      <div className="mb-4 flex items-center gap-3">
        <button className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}>←</button>
        <span className="min-w-44 text-center text-base font-semibold">{monthName}</span>
        <button className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}>→</button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="mb-1 grid grid-cols-7 text-center text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
            {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => <div key={d} className="py-1">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d) => {
              const ds = dstr(d);
              const inMonth = d.getMonth() === anchor.getMonth();
              const evs = byDate.get(ds) ?? [];
              return (
                <button key={ds} onClick={() => setSelected(ds)}
                  className={`min-h-16 rounded-lg border p-1.5 text-left align-top transition-colors ${
                    ds === selected ? "border-lamp/70 bg-panel-raised" :
                    ds === today ? "border-ok/50 bg-panel" :
                    "border-line bg-panel hover:border-lamp/40"
                  } ${inMonth ? "" : "opacity-35"}`}>
                  <div className="text-xs font-semibold">{d.getDate()}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {evs.slice(0, 4).map((e) => (
                      <span key={e.id} className="size-2 rounded-full" style={{ background: colorOf(e.member_id) }} />
                    ))}
                    {evs.length > 4 && <span className="text-[10px] text-ink-muted">+{evs.length - 4}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <aside className="rounded-xl border border-line bg-panel p-4">
          <h3 className="mb-3 text-sm font-semibold">
            {new Date(selected + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          </h3>
          <div className="mb-4 flex flex-col gap-2">
            {dayEvents.length === 0 && <div className="text-sm text-ink-muted">Nothing scheduled.</div>}
            {dayEvents.map((e) => (
              <div key={e.id} className="flex items-center gap-2 rounded-lg border border-line bg-panel-raised p-2.5">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(e.member_id) }} />
                <div className="flex-1">
                  <div className="text-sm font-medium">{e.title}</div>
                  <div className="text-[11px] text-ink-muted">
                    {e.time ?? "All day"}
                    {e.member_id && ` · ${members.find((m) => m.id === e.member_id)?.name ?? ""}`}
                  </div>
                </div>
                {canDelete && <button onClick={() => removeEvent(e.id)} className="text-xs text-ink-muted hover:text-alert">✕</button>}
              </div>
            ))}
          </div>

          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Add event</h4>
          <div className="flex flex-col gap-2">
            <input className={input} placeholder="What's happening?" value={form.title}
                   onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <div className="flex gap-2">
              <input type="time" className={`${input} flex-1`} value={form.time}
                     onChange={(e) => setForm({ ...form, time: e.target.value })} />
              <select className={`${input} flex-1`} value={form.member_id}
                      onChange={(e) => setForm({ ...form, member_id: e.target.value })}>
                <option value="">Everyone</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <button onClick={addEvent} disabled={busy || !form.title.trim()}
                    className="rounded-md border border-lamp/60 bg-lamp/10 px-4 py-1.5 text-sm font-semibold text-lamp disabled:opacity-40">
              Add to {new Date(selected + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" })}
            </button>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}
