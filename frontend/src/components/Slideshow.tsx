"use client";

/** Frame mode — fullscreen shuffled slideshow of the family gallery,
 *  Aura-frame style. Used from the Gallery page and straight from the
 *  wall panel. The next image is preloaded and crossfaded over the
 *  current one; tapping anywhere (or Esc) exits. While open it requests
 *  a screen wake lock so a wall panel doesn't sleep mid-show. */

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

export interface SlidePhoto { id: string; original?: string; }

const SLIDE_MS = 9000;  // time each photo holds
const FADE_MS = 1200;   // crossfade duration

export default function Slideshow({ photos, onClose }: { photos: SlidePhoto[]; onClose: () => void }) {
  const [order] = useState<SlidePhoto[]>(() => {
    const a = [...photos];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  });
  const [idx, setIdx] = useState(0);
  const url = (p: SlidePhoto) => `${API_URL}/api/photos/${p.id}/file`;

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
      {order.length === 0 && (
        <p className="absolute inset-0 grid place-items-center text-sm text-white/60">
          No photos in the gallery yet — add some from the Gallery page, then hit Play.
        </p>
      )}
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
