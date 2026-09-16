"use client";

/** Family gallery — photos stored on the server (Docker volume), indexed
 *  in Postgres, served through the authed API. Upload from any signed-in
 *  device. Play starts the frame mode: fullscreen shuffled slideshow that
 *  crossfades through the gallery like an Aura frame (tap to exit; holds a
 *  screen wake lock so the kiosk display stays on). */

import { useCallback, useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import PageShell from "@/components/PageShell";
import { api, API_URL } from "@/lib/api";
import { useMe , isKiosk } from "@/lib/auth";

interface Photo { id: string; original: string; uploaded_by: string; created_at: string; }

export default function GalleryPage() {
  const { me } = useMe();
  const canDelete = !isKiosk(me);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploading, setUploading] = useState(0); // count in flight
  const [view, setView] = useState<Photo | null>(null);
  const [playing, setPlaying] = useState(false);
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
        <button onClick={() => setPlaying(true)} disabled={photos.length === 0}
                className="flex items-center gap-2 rounded-md border border-lamp/60 bg-lamp/10 px-4 py-2 text-sm font-semibold text-lamp disabled:opacity-40">
          <Play size={15} /> Play
        </button>
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

      {playing && <Slideshow photos={photos} onClose={() => setPlaying(false)} />}
    </PageShell>
  );
}

const SLIDE_MS = 9000;  // time each photo holds
const FADE_MS = 1200;   // crossfade duration

/** Frame mode: fullscreen shuffled slideshow, Aura-frame style. The next
 *  image is preloaded and crossfaded over the current one; tapping
 *  anywhere (or Esc) exits. While open it requests a screen wake lock so
 *  a wall panel doesn't sleep mid-show. */
function Slideshow({ photos, onClose }: { photos: Photo[]; onClose: () => void }) {
  const [order] = useState<Photo[]>(() => {
    const a = [...photos];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  });
  const [idx, setIdx] = useState(0);
  const url = (p: Photo) => `${API_URL}/api/photos/${p.id}/file`;

  // advance on a timer
  useEffect(() => {
    if (order.length < 2) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % order.length), SLIDE_MS);
    return () => clearInterval(t);
  }, [order.length]);

  // preload the image after next so the crossfade never pops in raw
  useEffect(() => {
    const nxt = order[(idx + 2) % order.length];
    if (nxt) { const im = new window.Image(); im.src = url(nxt); }
  }, [idx, order]);

  // Esc exits
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // keep the display awake while the frame runs (best-effort)
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => { lock = l; }).catch(() => {});
    return () => { void lock?.release().catch(() => {}); };
  }, []);

  const cur = order[idx];
  const nxt = order[(idx + 1) % order.length];
  return (
    <div className="fixed inset-0 z-[90] cursor-pointer bg-black" onClick={onClose} role="button" aria-label="Exit slideshow">
      {/* two stacked layers: the incoming photo fades in over the current one */}
      {nxt && order.length > 1 && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url(nxt)} alt="" className="absolute inset-0 size-full object-contain" />
      )}
      {cur && (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={cur.id + String(idx)} src={url(cur)} alt=""
             className="absolute inset-0 size-full object-contain"
             style={order.length > 1 ? { animation: `hh-slidehold ${SLIDE_MS}ms linear forwards` } : undefined} />
      )}
      <style>{`@keyframes hh-slidehold{0%{opacity:1}${Math.round(((SLIDE_MS - FADE_MS) / SLIDE_MS) * 100)}%{opacity:1}100%{opacity:0}}`}</style>
    </div>
  );
}
