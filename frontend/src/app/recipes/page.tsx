"use client";

/** Recipes — household recipe box.
 *  - AI photo import: snap/upload a photo of a recipe (card, cookbook page,
 *    screenshot); the backend parses it with Gemini (same encrypted-key
 *    vault as the schedule import) and returns an UNSAVED draft that opens
 *    in the editor for review. Nothing saves until Save is pressed.
 *  - Search (title, category, ingredients), category filter chips, sorting
 *    (title / newest / category), and a Select mode with bulk delete.
 *  Kiosk sessions can browse/search but not add, import, edit, or delete
 *  (server-enforced; the buttons are also hidden). */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Check, ChefHat, Search, Trash2, X } from "lucide-react";
import PageShell from "@/components/PageShell";
import { api, API_URL } from "@/lib/api";
import { isKiosk, useMe } from "@/lib/auth";

interface Recipe {
  id: string; title: string; category: string; servings: string; prep_time: string;
  ingredients: string; steps: string; notes: string; created_at?: string | null;
}
const BLANK = { title: "", category: "", servings: "", prep_time: "", ingredients: "", steps: "", notes: "" };
type Draft = typeof BLANK & { id?: string; fromPhoto?: boolean };
type SortKey = "title" | "newest" | "category";

export default function RecipesPage() {
  const { me } = useMe();
  const canEdit = !isKiosk(me);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [open, setOpen] = useState<Recipe | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);

  // toolbar state
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("");            // "" = all categories
  const [sort, setSort] = useState<SortKey>("title");

  // multiselect
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // photo import
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState("");

  const load = useCallback(async () => {
    const r = await api("/api/recipes"); setRecipes(r.ok ? await r.json() : []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (r: Draft) => {
    if (!r.title.trim()) return;
    const path = r.id ? `/api/recipes/${r.id}` : "/api/recipes";
    await api(path, { method: r.id ? "PATCH" : "POST", body: JSON.stringify(r) });
    setEditing(null); await load();
  };
  const del = async (id: string) => {
    if (!window.confirm("Delete this recipe?")) return;
    await api(`/api/recipes/${id}`, { method: "DELETE" }); setOpen(null); await load();
  };

  // ---- photo -> parsed draft ------------------------------------------------
  const importPhoto = async (file: File) => {
    setImporting(true); setImportErr("");
    try {
      const body = new FormData();
      body.append("file", file);
      // raw fetch: FormData must set its own multipart boundary (api() forces JSON)
      const r = await fetch(`${API_URL}/api/recipes/extract`, { method: "POST", credentials: "include", body });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(String(data?.detail ?? `Import failed (${r.status})`));
      setEditing({ ...BLANK, ...data.recipe, fromPhoto: true });
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // ---- search / filter / sort ----------------------------------------------
  const categories = useMemo(() => {
    const s = new Set<string>();
    recipes.forEach((r) => { const c = r.category.trim(); if (c) s.add(c); });
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [recipes]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = recipes.filter((r) => {
      if (cat && r.category.trim().toLowerCase() !== cat.toLowerCase()) return false;
      if (!q) return true;
      return r.title.toLowerCase().includes(q)
        || r.category.toLowerCase().includes(q)
        || r.ingredients.toLowerCase().includes(q);
    });
    list = [...list];
    if (sort === "newest") {
      list.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || a.title.localeCompare(b.title));
    } else if (sort === "category") {
      list.sort((a, b) => (a.category || "\uffff").localeCompare(b.category || "\uffff") || a.title.localeCompare(b.title));
    } else {
      list.sort((a, b) => a.title.localeCompare(b.title));
    }
    return list;
  }, [recipes, query, cat, sort]);

  // ---- multiselect ----------------------------------------------------------
  const togglePick = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const exitSelect = () => { setSelecting(false); setPicked(new Set()); };
  const bulkDelete = async () => {
    if (picked.size === 0) return;
    if (!window.confirm(`Delete ${picked.size} recipe${picked.size === 1 ? "" : "s"}? This can't be undone.`)) return;
    setBulkBusy(true);
    for (const id of picked) {
      await api(`/api/recipes/${id}`, { method: "DELETE" });
    }
    setBulkBusy(false);
    exitSelect(); await load();
  };

  const input = "rounded-md border border-line bg-panel-raised px-2.5 py-1.5 text-sm outline-none focus:border-lamp/60";
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs font-semibold ${active ? "border-lamp/70 bg-lamp/15 text-lamp" : "border-line text-ink-muted hover:text-ink"}`;
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  return (
    <PageShell title="Recipes" active="/recipes">
      {/* toolbar: actions */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {canEdit && !selecting && (<>
          <button onClick={() => setEditing({ ...BLANK })}
            className="rounded-md border border-lamp/60 bg-lamp/10 px-3.5 py-2 text-sm font-semibold text-lamp">+ Add recipe</button>
          <button onClick={() => fileRef.current?.click()} disabled={importing}
            className="flex items-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-semibold text-ink disabled:opacity-50">
            <Camera size={15} />{importing ? "Reading photo…" : "Import from photo"}
          </button>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importPhoto(f); }} />
        </>)}
        {canEdit && recipes.length > 0 && (
          selecting ? (<>
            <button onClick={bulkDelete} disabled={picked.size === 0 || bulkBusy}
              className="flex items-center gap-2 rounded-md border border-alert/60 bg-alert/10 px-3.5 py-2 text-sm font-semibold text-alert disabled:opacity-40">
              <Trash2 size={15} />{bulkBusy ? "Deleting…" : `Delete (${picked.size})`}
            </button>
            <button onClick={() => setPicked(new Set(shown.map((r) => r.id)))}
              className="rounded-md border border-line px-3 py-2 text-sm text-ink-muted hover:text-ink">Select all</button>
            <button onClick={exitSelect} className="rounded-md border border-line px-3 py-2 text-sm text-ink-muted hover:text-ink">Done</button>
          </>) : (
            <button onClick={() => setSelecting(true)}
              className="rounded-md border border-line px-3.5 py-2 text-sm font-semibold text-ink-muted hover:text-ink">Select</button>
          )
        )}
        <div className="ml-auto">
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort recipes" className={input}>
            <option value="title">Sort: Title A–Z</option>
            <option value="newest">Sort: Newest first</option>
            <option value="category">Sort: Category</option>
          </select>
        </div>
      </div>
      {importErr && (
        <p className="mb-3 rounded-md border border-alert/50 bg-alert/10 px-3 py-2 text-sm text-alert">
          {importErr}
          <button onClick={() => setImportErr("")} className="float-right text-alert/80"><X size={15} /></button>
        </p>
      )}

      {/* search + category filter */}
      <div className="mb-4 flex flex-col gap-2">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, category, or ingredients…"
            className={`${input} w-full py-2.5 pl-9`} />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"><X size={15} /></button>
          )}
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

      {recipes.length === 0 && (
        <p className="rounded-md border border-line bg-panel p-6 text-center text-sm text-ink-muted">
          No recipes yet.{canEdit && " Add one, or import a photo of a recipe card."}
        </p>
      )}
      {recipes.length > 0 && shown.length === 0 && (
        <p className="rounded-md border border-line bg-panel p-6 text-center text-sm text-ink-muted">Nothing matches that search.</p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((r) => {
          const isPicked = picked.has(r.id);
          return (
            <button key={r.id} onClick={() => (selecting ? togglePick(r.id) : setOpen(r))}
              className={`relative rounded-xl border p-4 text-left ${
                selecting && isPicked ? "border-lamp/70 bg-lamp/10" : "border-line bg-panel hover:border-lamp/40"}`}>
              {selecting && (
                <span className={`absolute right-3 top-3 grid size-5 place-items-center rounded-md border ${
                  isPicked ? "border-lamp bg-lamp text-panel" : "border-line text-transparent"}`}>
                  <Check size={13} strokeWidth={3} />
                </span>
              )}
              <div className="pr-6 text-base font-semibold">{r.title}</div>
              <div className="mt-1 text-xs text-ink-muted">
                {[r.category, r.servings && `${r.servings} servings`, r.prep_time].filter(Boolean).join(" · ") || "Tap to view"}
              </div>
            </button>
          );
        })}
      </div>

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
            <div className="mb-3 text-xs text-ink-muted">{[open.category, open.servings && `${open.servings} servings`, open.prep_time].filter(Boolean).join(" · ")}</div>
            {open.ingredients && <><h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Ingredients</h4>
              <ul className="mb-3 list-disc pl-5 text-sm">{lines(open.ingredients).map((l, i) => <li key={i}>{l}</li>)}</ul></>}
            {open.steps && <><h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Steps</h4>
              <ol className="mb-3 list-decimal pl-5 text-sm">{lines(open.steps).map((l, i) => <li key={i} className="mb-1">{l}</li>)}</ol></>}
            {open.notes && <p className="text-sm text-ink-muted">{open.notes}</p>}
            <button onClick={() => setOpen(null)} className="mt-3 w-full rounded-lg border border-line py-2 text-sm text-ink-muted">Close</button>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur" onClick={() => setEditing(null)}>
          <div className="my-auto w-full max-w-lg rounded-2xl border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 text-base font-semibold">
              {editing.id ? "Edit recipe" : editing.fromPhoto ? "Review parsed recipe" : "New recipe"}
            </h3>
            {editing.fromPhoto && !editing.id && (
              <p className="mb-3 flex items-center gap-2 rounded-md border border-lamp/40 bg-lamp/10 px-3 py-2 text-xs text-lamp">
                <ChefHat size={14} className="shrink-0" /> Parsed from your photo — check quantities and steps, then Save.
              </p>
            )}
            {!editing.fromPhoto && <div className="mb-2" />}
            <div className="flex flex-col gap-2">
              <input className={input} placeholder="Recipe title" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} autoFocus />
              <div className="flex gap-2">
                <input className={`${input} flex-1`} placeholder="Category" value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
                <input className={`${input} w-24`} placeholder="Serves" value={editing.servings} onChange={(e) => setEditing({ ...editing, servings: e.target.value })} />
                <input className={`${input} w-28`} placeholder="Prep time" value={editing.prep_time} onChange={(e) => setEditing({ ...editing, prep_time: e.target.value })} />
              </div>
              <textarea className={`${input} min-h-24`} placeholder="Ingredients (one per line)" value={editing.ingredients} onChange={(e) => setEditing({ ...editing, ingredients: e.target.value })} />
              <textarea className={`${input} min-h-28`} placeholder="Steps (one per line)" value={editing.steps} onChange={(e) => setEditing({ ...editing, steps: e.target.value })} />
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
