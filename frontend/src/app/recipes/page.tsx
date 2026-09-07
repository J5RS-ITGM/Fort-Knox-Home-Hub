"use client";

import { useCallback, useEffect, useState } from "react";
import PageShell from "@/components/PageShell";
import { api } from "@/lib/api";
import { isKiosk, useMe } from "@/lib/auth";

interface Recipe {
  id: string; title: string; category: string; servings: string; prep_time: string;
  ingredients: string; steps: string; notes: string;
}
const BLANK = { title: "", category: "", servings: "", prep_time: "", ingredients: "", steps: "", notes: "" };

export default function RecipesPage() {
  const { me } = useMe();
  const canEdit = !isKiosk(me);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [open, setOpen] = useState<Recipe | null>(null);
  const [editing, setEditing] = useState<null | (typeof BLANK & { id?: string })>(null);

  const load = useCallback(async () => {
    const r = await api("/api/recipes"); setRecipes(r.ok ? await r.json() : []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (r: typeof BLANK & { id?: string }) => {
    if (!r.title.trim()) return;
    const path = r.id ? `/api/recipes/${r.id}` : "/api/recipes";
    await api(path, { method: r.id ? "PATCH" : "POST", body: JSON.stringify(r) });
    setEditing(null); await load();
  };
  const del = async (id: string) => {
    if (!window.confirm("Delete this recipe?")) return;
    await api(`/api/recipes/${id}`, { method: "DELETE" }); setOpen(null); await load();
  };

  const input = "rounded-md border border-line bg-panel-raised px-2.5 py-1.5 text-sm outline-none focus:border-lamp/60";
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  return (
    <PageShell title="Recipes" active="/recipes">
      {canEdit && (
        <button onClick={() => setEditing({ ...BLANK })}
          className="mb-4 rounded-md border border-lamp/60 bg-lamp/10 px-4 py-2 text-sm font-semibold text-lamp">+ Add recipe</button>
      )}
      {recipes.length === 0 && <p className="rounded-md border border-line bg-panel p-6 text-center text-sm text-ink-muted">No recipes yet.</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {recipes.map((r) => (
          <button key={r.id} onClick={() => setOpen(r)} className="rounded-xl border border-line bg-panel p-4 text-left hover:border-lamp/40">
            <div className="text-base font-semibold">{r.title}</div>
            <div className="mt-1 text-xs text-ink-muted">
              {[r.category, r.servings && `${r.servings} servings`, r.prep_time].filter(Boolean).join(" · ") || "Tap to view"}
            </div>
          </button>
        ))}
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
            <h3 className="mb-3 text-base font-semibold">{editing.id ? "Edit recipe" : "New recipe"}</h3>
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
