"use client";

/** Family gallery v1 — photos stored on the server (Docker volume),
 *  indexed in Postgres, served through the authed API. Upload from any
 *  signed-in device; groundwork for a wall-panel slideshow later. */

import { useCallback, useEffect, useRef, useState } from "react";
import PageShell from "@/components/PageShell";
import { api, API_URL } from "@/lib/api";
import { useMe } from "@/lib/auth";

interface Photo { id: string; original: string; uploaded_by: string; created_at: string; }

export default function GalleryPage() {
  const { me } = useMe();
  const canDelete = me?.role !== "kiosk";
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploading, setUploading] = useState(0); // count in flight
  const [view, setView] = useState<Photo | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await api("/api/photos");
    setPhotos(r.ok ? await r.json() : []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(files.length);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file);
        // multipart: don't set Content-Type (browser adds the boundary)
        await fetch(`${API_URL}/api/photos`, { method: "POST", credentials: "include", body });
        setUploading((u) => u - 1);
      }
      await load();
    } finally { setUploading(0); }
  };

  const remove = async (p: Photo) => {
    if (!window.confirm("Delete this photo?")) return;
    await api(`/api/photos/${p.id}`, { method: "DELETE" });
    setView(null);
    await load();
  };

  return (
    <PageShell title="Gallery" active="/gallery">
      <div className="mb-4 flex items-center gap-3">
        <button onClick={() => fileRef.current?.click()}
                className="rounded-md border border-lamp/60 bg-lamp/10 px-4 py-2 text-sm font-semibold text-lamp">
          {uploading ? `Uploading ${uploading}…` : "＋ Add photos"}
        </button>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden
               onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
        <span className="text-xs text-ink-muted">{photos.length} photo{photos.length === 1 ? "" : "s"} · JPEG/PNG/WebP/GIF, 20MB max</span>
      </div>

      {photos.length === 0 && !uploading && (
        <p className="rounded-md border border-line bg-panel p-6 text-center text-sm text-ink-muted">
          No photos yet — add the first one.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {photos.map((p) => (
          // eslint-disable-next-line @next/next/no-img-element
          <button key={p.id} onClick={() => setView(p)} className="group relative aspect-square overflow-hidden rounded-lg border border-line bg-panel">
            <img src={`${API_URL}/api/photos/${p.id}/file`} alt={p.original}
                 loading="lazy" className="size-full object-cover transition-transform group-hover:scale-105" />
          </button>
        ))}
      </div>

      {view && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4 backdrop-blur" onClick={() => setView(null)}>
          <div className="flex max-h-full max-w-4xl flex-col gap-3" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${API_URL}/api/photos/${view.id}/file`} alt={view.original}
                 className="max-h-[78vh] rounded-xl object-contain" />
            <div className="flex items-center gap-3 text-xs text-ink-muted">
              <span className="flex-1 truncate">{view.original || "Photo"} · {view.uploaded_by} · {new Date(view.created_at).toLocaleDateString()}</span>
              {canDelete && (
                <button onClick={() => remove(view)} className="rounded-md border border-alert/50 px-3 py-1.5 font-semibold text-alert">Delete</button>
              )}
              <button onClick={() => setView(null)} className="rounded-md border border-line px-3 py-1.5 text-ink">Close</button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
