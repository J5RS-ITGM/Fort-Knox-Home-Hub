"use client";

/** Home Maintenance — recurring upkeep jobs with an AI-parsed how-to and a
 *  schedule. Create a task ("Mr Cool Mini Split Service"), import the steps
 *  from a photo of the manual (Gemini, same vault as recipes) or type them,
 *  set a frequency (monthly / quarterly / biannual / annual / custom) and an
 *  optional anchor month+day it should land near. The app computes the next
 *  due date and rolls it forward each time you mark the job done; anything
 *  due surfaces on the wall panel.
 *
 *  Search, category filter, sort (due date / name / category), and a Select
 *  mode with bulk delete. Kiosk sessions can browse and mark done, but not
 *  add / import / edit / delete (server-enforced; buttons hidden too). */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Check, CheckCircle2, Search, Trash2, Wrench, X } from "lucide-react";
import PageShell from "@/components/PageShell";
import { api, API_URL } from "@/lib/api";
import { isKiosk, useMe } from "@/lib/auth";

interface Task {
  id: string; title: string; category: string; equipment: string;
  steps: string; supplies: string; notes: string;
  frequency: string; interval_months: number;
  anchor_month: number | null; anchor_day: number | null;
  last_done: string | null; next_due: string | null; active: boolean;
  created_at?: string | null;
}
const BLANK = {
  title: "", category: "", equipment: "", steps: "", supplies: "", notes: "",
  frequency: "annual", interval_months: 12,
  anchor_month: null as number | null, anchor_day: null as number | null,
  last_done: null as string | null, active: true,
};
type Draft = typeof BLANK & { id?: string; fromPhoto?: boolean };
type SortKey = "due" | "title" | "category";

const FREQS: [string, string][] = [
  ["monthly", "Monthly"], ["quarterly", "Quarterly"],
  ["biannual", "Every 6 months"], ["annual", "Annually"], ["custom", "Custom"],
];
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const freqLabel = (f: string) => (FREQS.find(([k]) => k === f)?.[1] ?? f);

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDue = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const dueBucket = (iso: string | null): "overdue" | "soon" | "ok" | "none" => {
  if (!iso) return "none";
  const days = Math.round((new Date(iso + "T00:00:00").getTime() - new Date(todayISO() + "T00:00:00").getTime()) / 86400000);
  if (days < 0) return "overdue";
  if (days <= 30) return "soon";
  return "ok";
};

export default function MaintenancePage() {
  const { me } = useMe();
  const canEdit = !isKiosk(me);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [open, setOpen] = useState<Task | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);

  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("");
  const [sort, setSort] = useState<SortKey>("due");

  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState("");

  const load = useCallback(async () => {
    const r = await api("/api/maintenance"); setTasks(r.ok ? await r.json() : []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (t: Draft) => {
    if (!t.title.trim()) return;
    const path = t.id ? `/api/maintenance/${t.id}` : "/api/maintenance";
    await api(path, { method: t.id ? "PATCH" : "POST", body: JSON.stringify(t) });
    setEditing(null); await load();
  };
  const del = async (id: string) => {
    if (!window.confirm("Delete this maintenance task?")) return;
    await api(`/api/maintenance/${id}`, { method: "DELETE" }); setOpen(null); await load();
  };
  const markDone = async (t: Task) => {
    await api(`/api/maintenance/${t.id}/done`, { method: "POST", body: JSON.stringify({ date: todayISO() }) });
    setOpen(null); await load();
  };

  const importPhoto = async (file: File) => {
    setImporting(true); setImportErr("");
    try {
      const body = new FormData();
      body.append("file", file);
      const r = await fetch(`${API_URL}/api/maintenance/extract`, { method: "POST", credentials: "include", body });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(String(data?.detail ?? `Import failed (${r.status})`));
      setEditing({ ...BLANK, ...data.task, fromPhoto: true });
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const categories = useMemo(() => {
    const s = new Set<string>();
    tasks.forEach((t) => { const c = t.category.trim(); if (c) s.add(c); });
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [tasks]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = tasks.filter((t) => {
      if (cat && t.category.trim().toLowerCase() !== cat.toLowerCase()) return false;
      if (!q) return true;
      return t.title.toLowerCase().includes(q)
        || t.category.toLowerCase().includes(q)
        || t.equipment.toLowerCase().includes(q)
        || t.supplies.toLowerCase().includes(q);
    });
    list = [...list];
    if (sort === "title") list.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "category") list.sort((a, b) => (a.category || "\uffff").localeCompare(b.category || "\uffff") || a.title.localeCompare(b.title));
    else list.sort((a, b) => (a.next_due ?? "9999").localeCompare(b.next_due ?? "9999") || a.title.localeCompare(b.title));
    return list;
  }, [tasks, query, cat, sort]);

  const dueSoon = useMemo(
    () => tasks.filter((t) => t.active && (dueBucket(t.next_due) === "overdue" || dueBucket(t.next_due) === "soon"))
               .sort((a, b) => (a.next_due ?? "").localeCompare(b.next_due ?? "")),
    [tasks]);

  const togglePick = (id: string) => setPicked((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const exitSelect = () => { setSelecting(false); setPicked(new Set()); };
  const bulkDelete = async () => {
    if (picked.size === 0) return;
    if (!window.confirm(`Delete ${picked.size} task${picked.size === 1 ? "" : "s"}? This can't be undone.`)) return;
    setBulkBusy(true);
    for (const id of picked) await api(`/api/maintenance/${id}`, { method: "DELETE" });
    setBulkBusy(false); exitSelect(); await load();
  };

  const input = "rounded-md border border-line bg-panel-raised px-2.5 py-1.5 text-sm outline-none focus:border-lamp/60";
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs font-semibold ${active ? "border-lamp/70 bg-lamp/15 text-lamp" : "border-line text-ink-muted hover:text-ink"}`;
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const bucketColor = (b: string) => b === "overdue" ? "text-alert" : b === "soon" ? "text-lamp" : "text-ink-muted";

  return (
    <PageShell title="Maintenance" active="/maintenance">
      {/* due-soon banner */}
      {dueSoon.length > 0 && (
        <div className="mb-4 rounded-xl border border-lamp/40 bg-lamp/10 p-3">
          <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-lamp">
            <Wrench size={13} /> Due soon
          </div>
          <div className="flex flex-col gap-1">
            {dueSoon.slice(0, 5).map((t) => (
              <button key={t.id} onClick={() => setOpen(t)} className="flex items-center gap-2 text-left text-sm">
                <span className={`font-semibold ${bucketColor(dueBucket(t.next_due))}`}>{fmtDue(t.next_due)}</span>
                <span className="text-ink">{t.title}</span>
                {dueBucket(t.next_due) === "overdue" && <span className="text-xs font-bold text-alert">OVERDUE</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* actions */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {canEdit && !selecting && (<>
          <button onClick={() => setEditing({ ...BLANK })}
            className="rounded-md border border-lamp/60 bg-lamp/10 px-3.5 py-2 text-sm font-semibold text-lamp">+ Add task</button>
          <button onClick={() => fileRef.current?.click()} disabled={importing}
            className="flex items-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-semibold text-ink disabled:opacity-50">
            <Camera size={15} />{importing ? "Reading photo…" : "Import from photo"}
          </button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importPhoto(f); }} />
        </>)}
        {canEdit && tasks.length > 0 && (
          selecting ? (<>
            <button onClick={bulkDelete} disabled={picked.size === 0 || bulkBusy}
              className="flex items-center gap-2 rounded-md border border-alert/60 bg-alert/10 px-3.5 py-2 text-sm font-semibold text-alert disabled:opacity-40">
              <Trash2 size={15} />{bulkBusy ? "Deleting…" : `Delete (${picked.size})`}
            </button>
            <button onClick={() => setPicked(new Set(shown.map((t) => t.id)))}
              className="rounded-md border border-line px-3 py-2 text-sm text-ink-muted hover:text-ink">Select all</button>
            <button onClick={exitSelect} className="rounded-md border border-line px-3 py-2 text-sm text-ink-muted hover:text-ink">Done</button>
          </>) : (
            <button onClick={() => setSelecting(true)}
              className="rounded-md border border-line px-3.5 py-2 text-sm font-semibold text-ink-muted hover:text-ink">Select</button>
          )
        )}
        <div className="ml-auto">
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort tasks" className={input}>
            <option value="due">Sort: Due date</option>
            <option value="title">Sort: Name A–Z</option>
            <option value="category">Sort: Category</option>
          </select>
        </div>
      </div>
      {importErr && (
        <p className="mb-3 rounded-md border border-alert/50 bg-alert/10 px-3 py-2 text-sm text-alert">
          {importErr}<button onClick={() => setImportErr("")} className="float-right text-alert/80"><X size={15} /></button>
        </p>
      )}

      {/* search + category filter */}
      <div className="mb-4 flex flex-col gap-2">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks, equipment, or supplies…"
            className={`${input} w-full py-2.5 pl-9`} />
          {query && <button onClick={() => setQuery("")} aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"><X size={15} /></button>}
        </div>
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setCat("")} className={chip(cat === "")}>All</button>
            {categories.map((c) => (
              <button key={c} onClick={() => setCat(cat === c ? "" : c)} className={chip(cat.toLowerCase() === c.toLowerCase())}>{c}</button>
            ))}
          </div>
        )}
      </div>

      {tasks.length === 0 && (
        <p className="rounded-md border border-line bg-panel p-6 text-center text-sm text-ink-muted">
          No maintenance tasks yet.{canEdit && " Add one, or import a photo of an equipment manual."}
        </p>
      )}
      {tasks.length > 0 && shown.length === 0 && (
        <p className="rounded-md border border-line bg-panel p-6 text-center text-sm text-ink-muted">Nothing matches that search.</p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((t) => {
          const isPicked = picked.has(t.id);
          const b = dueBucket(t.next_due);
          return (
            <button key={t.id} onClick={() => (selecting ? togglePick(t.id) : setOpen(t))}
              className={`relative rounded-xl border p-4 text-left ${
                selecting && isPicked ? "border-lamp/70 bg-lamp/10" : "border-line bg-panel hover:border-lamp/40"}`}>
              {selecting && (
                <span className={`absolute right-3 top-3 grid size-5 place-items-center rounded-md border ${
                  isPicked ? "border-lamp bg-lamp text-panel" : "border-line text-transparent"}`}>
                  <Check size={13} strokeWidth={3} />
                </span>
              )}
              <div className="pr-6 text-base font-semibold">{t.title}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
                <span className={`font-semibold ${bucketColor(b)}`}>
                  {b === "overdue" ? "Overdue · " : "Due "}{fmtDue(t.next_due)}
                </span>
                <span className="text-ink-muted">· {freqLabel(t.frequency)}</span>
              </div>
              {(t.category || t.equipment) && (
                <div className="mt-1 truncate text-xs text-ink-muted">{[t.category, t.equipment].filter(Boolean).join(" · ")}</div>
              )}
            </button>
          );
        })}
      </div>

      {/* detail */}
      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur" onClick={() => setOpen(null)}>
          <div className="my-auto w-full max-w-lg rounded-2xl border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 flex items-start justify-between gap-3">
              <h3 className="text-lg font-semibold">{open.title}</h3>
              {canEdit && <div className="flex shrink-0 gap-2">
                <button onClick={() => { setEditing({ ...open }); setOpen(null); }} className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-muted hover:text-ink">Edit</button>
                <button onClick={() => del(open.id)} className="rounded-md border border-alert/50 px-2.5 py-1 text-xs text-alert">Delete</button>
              </div>}
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-x-2 text-xs">
              <span className={`font-semibold ${bucketColor(dueBucket(open.next_due))}`}>
                {dueBucket(open.next_due) === "overdue" ? "Overdue · " : "Next due "}{fmtDue(open.next_due)}
              </span>
              <span className="text-ink-muted">· {freqLabel(open.frequency)}
                {open.anchor_month ? ` · around ${MONTHS[open.anchor_month]}${open.anchor_day ? " " + open.anchor_day : ""}` : ""}
                {open.last_done ? ` · last done ${fmtDue(open.last_done)}` : " · never done"}</span>
            </div>
            {(open.category || open.equipment) && <div className="mb-3 text-xs text-ink-muted">{[open.category, open.equipment].filter(Boolean).join(" · ")}</div>}
            {open.supplies && <><h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Supplies</h4>
              <ul className="mb-3 list-disc pl-5 text-sm">{lines(open.supplies).map((l, i) => <li key={i}>{l}</li>)}</ul></>}
            {open.steps && <><h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">How-to</h4>
              <ol className="mb-3 list-decimal pl-5 text-sm">{lines(open.steps).map((l, i) => <li key={i} className="mb-1">{l}</li>)}</ol></>}
            {open.notes && <p className="mb-3 text-sm text-ink-muted">{open.notes}</p>}
            <div className="flex gap-2">
              <button onClick={() => markDone(open)}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-ok/50 bg-ok/10 py-2.5 text-sm font-semibold text-ok">
                <CheckCircle2 size={16} /> Mark done today
              </button>
              <button onClick={() => setOpen(null)} className="rounded-lg border border-line px-4 py-2 text-sm text-ink-muted">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* editor */}
      {editing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur" onClick={() => setEditing(null)}>
          <div className="my-auto w-full max-w-lg rounded-2xl border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 text-base font-semibold">
              {editing.id ? "Edit task" : editing.fromPhoto ? "Review parsed task" : "New maintenance task"}
            </h3>
            {editing.fromPhoto && !editing.id && (
              <p className="mb-3 flex items-center gap-2 rounded-md border border-lamp/40 bg-lamp/10 px-3 py-2 text-xs text-lamp">
                <Wrench size={14} className="shrink-0" /> Parsed from your photo — check the steps and schedule, then Save.
              </p>
            )}
            <div className="flex flex-col gap-2">
              <input className={input} placeholder="Task title (e.g. Mr Cool Mini Split Service)" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} autoFocus />
              <div className="flex gap-2">
                <input className={`${input} flex-1`} placeholder="Category (HVAC, Plumbing…)" value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
                <input className={`${input} flex-1`} placeholder="Equipment/model" value={editing.equipment} onChange={(e) => setEditing({ ...editing, equipment: e.target.value })} />
              </div>

              {/* schedule */}
              <div className="rounded-lg border border-line p-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Schedule</div>
                <div className="flex flex-wrap items-center gap-2">
                  <select className={input} value={editing.frequency} onChange={(e) => setEditing({ ...editing, frequency: e.target.value })}>
                    {FREQS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  {editing.frequency === "custom" && (
                    <span className="flex items-center gap-1.5 text-sm text-ink-muted">every
                      <input type="number" min={1} max={120} className={`${input} w-16`} value={editing.interval_months}
                        onChange={(e) => setEditing({ ...editing, interval_months: Math.max(1, Number(e.target.value) || 1) })} />
                      months</span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                  <span>Around</span>
                  <select className={input} value={editing.anchor_month ?? ""}
                    onChange={(e) => setEditing({ ...editing, anchor_month: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">Any month</option>
                    {MONTHS.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                  {editing.anchor_month && (
                    <select className={input} value={editing.anchor_day ?? ""}
                      onChange={(e) => setEditing({ ...editing, anchor_day: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">Any day</option>
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                  <span>Last done</span>
                  <input type="date" className={input} value={editing.last_done ?? ""}
                    onChange={(e) => setEditing({ ...editing, last_done: e.target.value || null })} />
                  {editing.last_done && <button onClick={() => setEditing({ ...editing, last_done: null })} className="text-xs text-ink-muted hover:text-ink">clear</button>}
                </div>
              </div>

              <textarea className={`${input} min-h-16`} placeholder="Supplies (one per line — filters, sealant…)" value={editing.supplies} onChange={(e) => setEditing({ ...editing, supplies: e.target.value })} />
              <textarea className={`${input} min-h-28`} placeholder="How-to steps (one per line)" value={editing.steps} onChange={(e) => setEditing({ ...editing, steps: e.target.value })} />
              <textarea className={`${input} min-h-16`} placeholder="Notes (optional)" value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="rounded-lg border border-line px-4 py-2 text-sm text-ink-muted hover:text-ink">Cancel</button>
              <button onClick={() => save(editing)} disabled={!editing.title.trim()} className="rounded-lg border border-lamp/60 bg-lamp/10 px-4 py-2 text-sm font-semibold text-lamp disabled:opacity-40">Save</button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
