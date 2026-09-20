"use client";

/** Frame mode — fullscreen shuffled slideshow of the family gallery,
 *  Aura-frame style. Used from the Gallery page and straight from the
 *  wall panel. Tapping anywhere (or Esc) exits. While open it requests a
 *  screen wake lock so a wall panel doesn't sleep mid-show.
 *
 *  Layout rule (on a landscape screen): a LANDSCAPE photo gets the whole
 *  screen; PORTRAIT photos are shown TWO at a time, side by side, so they
 *  aren't tiny pillars with black either side. On a portrait screen (a
 *  phone) everything shows one at a time. Orientation is read from each
 *  image's natural size as it's preloaded, so nothing pops in raw. */

import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/api";

export interface SlidePhoto { id: string; original?: string; }
type Orient = "l" | "p";
type Slide = SlidePhoto[]; // 1 photo (landscape / lone portrait) or 2 (portrait pair)

const SLIDE_MS = 9000;  // time each slide holds
const FADE_MS = 1200;   // crossfade duration
const LOOKAHEAD = 6;    // how far to search the deck for a portrait partner

function shuffle<T>(src: T[]): T[] {
  const a = [...src];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export default function Slideshow({ photos, onClose }: { photos: SlidePhoto[]; onClose: () => void }) {
  const url = (p: SlidePhoto) => `${API_URL}/api/photos/${p.id}/file`;

  // working deck (reshuffled when exhausted) + orientation cache
  const deck = useRef<SlidePhoto[]>(shuffle(photos));
  const orient = useRef<Map<string, Orient>>(new Map());
  const [cur, setCur] = useState<Slide | null>(null);
  const [nxt, setNxt] = useState<Slide | null>(null);
  const [tick, setTick] = useState(0);
  const [wide, setWide] = useState(true);

  // pair portraits only when the SCREEN is landscape
  useEffect(() => {
    const check = () => setWide(window.innerWidth >= window.innerHeight);
    check(); window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const probe = useCallback((p: SlidePhoto) => new Promise<Orient>((resolve) => {
    const c = orient.current.get(p.id);
    if (c) { resolve(c); return; }
    const im = new window.Image();
    im.onload = () => { const o: Orient = im.naturalHeight > im.naturalWidth ? "p" : "l"; orient.current.set(p.id, o); resolve(o); };
    im.onerror = () => { orient.current.set(p.id, "l"); resolve("l"); };
    im.src = url(p);
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const draw = useCallback((): SlidePhoto | undefined => {
    if (deck.current.length === 0) deck.current = shuffle(photos);
    return deck.current.shift();
  }, [photos]);

  /** Compose the next slide: landscape alone; portrait + the next portrait
   *  found within LOOKAHEAD (searched in deck order so the shuffle holds). */
  const buildSlide = useCallback(async (): Promise<Slide | null> => {
    if (photos.length === 0) return null;
    const a = draw(); if (!a) return null;
    const oa = await probe(a);
    if (oa === "l" || !wide) return [a];
    const n = Math.min(LOOKAHEAD, deck.current.length);
    for (let i = 0; i < n; i++) {
      const b = deck.current[i];
      if ((await probe(b)) === "p") { deck.current.splice(i, 1); return [a, b]; }
    }
    return [a];
  }, [photos.length, draw, probe, wide]);

  // seed the first two slides
  useEffect(() => {
    let alive = true;
    (async () => {
      const first = await buildSlide(); if (!alive) return; setCur(first);
      const second = await buildSlide(); if (!alive) return; setNxt(second);
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // advance on a timer: promote next -> current, compose a fresh next
  useEffect(() => {
    if (photos.length < 2) return;
    const t = setInterval(() => setTick((n) => n + 1), SLIDE_MS);
    return () => clearInterval(t);
  }, [photos.length]);
  useEffect(() => {
    if (tick === 0) return;
    let alive = true;
    setCur((c) => (nxt ?? c));
    (async () => { const s = await buildSlide(); if (alive) setNxt(s); })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

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

  const Layer = ({ slide, hold }: { slide: Slide; hold: boolean }) => (
    <div className="absolute inset-0 flex items-stretch justify-center"
         style={hold && photos.length > 1 ? { animation: `hh-slidehold ${SLIDE_MS}ms linear forwards` } : undefined}>
      {slide.map((p) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={p.id} src={url(p)} alt=""
             className="h-full object-contain"
             style={{ width: slide.length === 2 ? "50%" : "100%", flex: "0 0 auto" }} />
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[90] cursor-pointer bg-black" onClick={onClose} role="button" aria-label="Exit slideshow">
      {photos.length === 0 && (
        <p className="absolute inset-0 grid place-items-center text-sm text-white/60">
          No photos in the gallery yet — add some from the Gallery page, then hit Play.
        </p>
      )}
      {/* two stacked layers: the incoming slide sits underneath, the current one fades out over it */}
      {nxt && photos.length > 1 && <Layer slide={nxt} hold={false} />}
      {cur && <Layer key={cur.map((p) => p.id).join("+") + String(tick)} slide={cur} hold />}
      <style>{`@keyframes hh-slidehold{0%{opacity:1}${Math.round(((SLIDE_MS - FADE_MS) / SLIDE_MS) * 100)}%{opacity:1}100%{opacity:0}}`}</style>
    </div>
  );
}
