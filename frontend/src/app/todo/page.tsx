"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PageShell from "@/components/PageShell";
import { api } from "@/lib/api";

interface Todo { id: string; title: string; done: boolean; member_id: string | null; priority: number; }
interface Member { id: string; name: string; emoji: string; color: string; }

export default function TodoPage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [title, setTitle] = useState("");
  const [memberId, setMemberId] = useState("");
  const [priority, setPriority] = useState(false);

  const load = useCallback(async () => {
    const [t, m] = await Promise.all([
      api("/api/todos").then((r) => (r.ok ? r.json() : [])),
      api("/api/family").then((r) => (r.ok ? r.json() : [])),
    ]);
    setTodos(t); setMembers(m);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const add = async () => {
    if (!title.trim()) return;
    await api("/api/todos", { method: "POST", body: JSON.stringify({ title, member_id: memberId || null, priority: priority ? 1 : 0 }) });
    setTitle(""); setPriority(false); await load();
  };
  const toggle = async (id: string) => { await api(`/api/todos/${id}/toggle`, { method: "POST" }); await load(); };
  const del = async (id: string) => { await api(`/api/todos/${id}`, { method: "DELETE" }); await load(); };
  const clearDone = async () => { await api("/api/todos/clear-done", { method: "POST" }); await load(); };

  const open = todos.filter((t) => !t.done);
  const done = todos.filter((t) => t.done);
  const input = "rounded-md border border-line bg-panel-raised px-2.5 py-2 text-sm outline-none focus:border-lamp/60";

  const row = (t: Todo) => {
    const m = t.member_id ? memberById.get(t.member_id) : null;
    return (
      <div key={t.id} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5">
        <button onClick={() => toggle(t.id)}
          className={`grid size-6 shrink-0 place-items-center rounded-full border-2 text-sm font-bold ${t.done ? "border-ok bg-ok text-field" : "border-line text-transparent"}`}>✓</button>
        {t.priority === 1 && !t.done && <span className="shrink-0 rounded bg-alert/20 px-1.5 py-0.5 text-[10px] font-semibold text-alert">HIGH</span>}
        <span className={`flex-1 text-sm ${t.done ? "text-ink-muted line-through" : ""}`}>{t.title}</span>
        {m && <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px]" style={{ background: `${m.color}22`, color: "var(--color-ink)" }}>{m.emoji} {m.name}</span>}
        <button onClick={() => del(t.id)} className="shrink-0 text-xs text-ink-muted hover:text-alert">✕</button>
      </div>
    );
  };

  return (
    <PageShell title="To-Do" active="/todo">
      <div className="mb-5 flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 sm:flex-row sm:items-center">
        <input className={`${input} flex-1`} placeholder="Add a task…" value={title}
          onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <select className={input} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
          <option value="">Anyone</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>)}
        </select>
        <label className="flex items-center gap-1.5 px-1 text-xs text-ink-muted">
          <input type="checkbox" checked={priority} onChange={(e) => setPriority(e.target.checked)} /> High
        </label>
        <button onClick={add} disabled={!title.trim()} className="rounded-md border border-lamp/60 bg-lamp/10 px-4 py-2 text-sm font-semibold text-lamp disabled:opacity-40">Add</button>
      </div>

      <div className="flex flex-col gap-2">
        {open.length === 0 && <p className="text-sm text-ink-muted">Nothing to do — nice.</p>}
        {open.map(row)}
      </div>

      {done.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Done ({done.length})</h2>
            <button onClick={clearDone} className="text-xs text-ink-muted underline hover:text-ink">Clear done</button>
          </div>
          <div className="flex flex-col gap-2">{done.map(row)}</div>
        </div>
      )}
    </PageShell>
  );
}
