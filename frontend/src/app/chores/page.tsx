"use client";

/** Chore Quest v1 — daily chores per family member, tap to complete,
 *  weekly star tally. Data is app-owned (Postgres via /api/chores).
 *  Admins add/remove chores; anyone (kids at the wall panel) completes. */

import { useCallback, useEffect, useMemo, useState } from "react";
import PageShell from "@/components/PageShell";
import { api } from "@/lib/api";
import { useMe } from "@/lib/auth";

interface Member { id: string; name: string; emoji: string; color: string; }
interface Chore { id: string; title: string; emoji: string; points: number; member_id: string; done: boolean; }
interface Completion { chore_id: string; date: string; }

const dstr = (d: Date) => d.toISOString().slice(0, 10);
function weekRange(): [string, string] {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // Monday = 0
  const mon = new Date(now); mon.setDate(now.getDate() - day);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return [dstr(mon), dstr(sun)];
}

export default function ChoresPage() {
  const { me } = useMe();
  const today = dstr(new Date());
  const [members, setMembers] = useState<Member[]>([]);
  const [chores, setChores] = useState<Chore[]>([]);
  const [week, setWeek] = useState<Completion[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: "", emoji: "⭐", points: 1, member_id: "" });

  const load = useCallback(async () => {
    const [start, end] = weekRange();
    const [m, c, w] = await Promise.all([
      api("/api/family").then((r) => (r.ok ? r.json() : [])),
      api(`/api/chores?date=${today}`).then((r) => (r.ok ? r.json() : [])),
      api(`/api/chores/completions?start=${start}&end=${end}`).then((r) => (r.ok ? r.json() : [])),
    ]);
    setMembers(m); setChores(c); setWeek(w);
  }, [today]);
  useEffect(() => { void load(); }, [load]);

  const pointsByChore = useMemo(() => new Map(chores.map((c) => [c.id, c.points])), [chores]);
  const memberByChore = useMemo(() => new Map(chores.map((c) => [c.id, c.member_id])), [chores]);
  const weeklyStars = useMemo(() => {
    const tally = new Map<string, number>();
    week.forEach((w) => {
      const mid = memberByChore.get(w.chore_id);
      if (mid) tally.set(mid, (tally.get(mid) ?? 0) + (pointsByChore.get(w.chore_id) ?? 1));
    });
    return tally;
  }, [week, memberByChore, pointsByChore]);

  const toggle = async (id: string) => {
    setBusy(true);
    try {
      await api(`/api/chores/${id}/toggle`, { method: "POST", body: JSON.stringify({ date: today }) });
      await load();
    } finally { setBusy(false); }
  };

  const addChore = async () => {
    if (!form.title.trim() || !form.member_id) return;
    setBusy(true);
    try {
      await api("/api/chores", { method: "POST", body: JSON.stringify(form) });
      setForm({ title: "", emoji: "⭐", points: 1, member_id: form.member_id });
      await load();
    } finally { setBusy(false); }
  };

  const removeChore = async (id: string) => {
    if (!window.confirm("Remove this chore?")) return;
    await api(`/api/chores/${id}`, { method: "DELETE" });
    await load();
  };

  const isAdmin = me?.role === "admin";
  const input = "rounded-md border border-line bg-panel px-2.5 py-1.5 text-sm outline-none focus:border-lamp/60";

  return (
    <PageShell title="Chore Quest" active="/chores">
      {members.length === 0 && (
        <p className="rounded-md border border-line bg-panel p-4 text-sm text-ink-muted">
          No family members yet — add the roster in Admin → Family, then chores appear here.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {members.map((m) => {
          const mine = chores.filter((c) => c.member_id === m.id);
          const doneCount = mine.filter((c) => c.done).length;
          return (
            <section key={m.id} className="rounded-xl border border-line bg-panel p-4">
              <div className="mb-3 flex items-center gap-3">
                <span className="grid size-11 place-items-center rounded-full text-2xl"
                      style={{ background: `${m.color}26`, border: `2px solid ${m.color}` }}>
                  {m.emoji}
                </span>
                <div>
                  <div className="text-base font-semibold">{m.name}</div>
                  <div className="text-xs text-ink-muted">
                    {doneCount}/{mine.length} today · <span className="text-lamp">★ {weeklyStars.get(m.id) ?? 0}</span> this week
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                {mine.length === 0 && <div className="text-sm text-ink-muted">No chores assigned.</div>}
                {mine.map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <button
                      onClick={() => toggle(c.id)}
                      disabled={busy}
                      className={`flex flex-1 items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                        c.done ? "border-ok/50 bg-ok/10" : "border-line bg-panel-raised hover:border-lamp/40"
                      }`}
                    >
                      <span className={`grid size-8 shrink-0 place-items-center rounded-full border-2 text-base font-bold ${
                        c.done ? "border-ok bg-ok text-field" : "border-line text-transparent"
                      }`}>✓</span>
                      <span className="text-lg">{c.emoji}</span>
                      <span className={`flex-1 text-sm font-medium ${c.done ? "line-through opacity-60" : ""}`}>{c.title}</span>
                      <span className="shrink-0 text-xs font-bold text-lamp">★{c.points}</span>
                    </button>
                    {isAdmin && (
                      <button onClick={() => removeChore(c.id)} className="shrink-0 rounded-md border border-line px-2 py-2 text-xs text-ink-muted hover:border-alert/50 hover:text-alert">✕</button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {isAdmin && members.length > 0 && (
        <section className="mt-6 rounded-xl border border-line bg-panel p-4">
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Add a chore</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${input} w-16`} value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} aria-label="Emoji" />
            <input className={`${input} flex-1 min-w-40`} placeholder="Chore (e.g. Feed the dog)" value={form.title}
                   onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <select className={input} value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}>
              <option value="">Who?</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <label className="flex items-center gap-1 text-xs text-ink-muted">
              ★<input type="number" min={1} max={10} className={`${input} w-16`} value={form.points}
                      onChange={(e) => setForm({ ...form, points: Number(e.target.value) })} />
            </label>
            <button onClick={addChore} disabled={busy || !form.title.trim() || !form.member_id}
                    className="rounded-md border border-lamp/60 bg-lamp/10 px-4 py-1.5 text-sm font-semibold text-lamp disabled:opacity-40">
              Add
            </button>
          </div>
        </section>
      )}
    </PageShell>
  );
}
