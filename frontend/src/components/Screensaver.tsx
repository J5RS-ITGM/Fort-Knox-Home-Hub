"use client";

/** Screensaver — wall panels in kiosk mode only.
 *
 *  The kiosk PC's display never sleeps, so without this the panel glows in
 *  the kitchen all night and its static tiles burn in. After N idle
 *  minutes (Admin → Settings → Screensaver) the panel shows the family
 *  slideshow with a big clock (daytime) or a dim clock on black (quiet
 *  hours), and the first tap ONLY wakes it — it never reaches whatever
 *  button is underneath, so a kid can't wake it and unlock a door in one
 *  touch.
 *
 *  It never starts while a PIN pad, the on-screen keyboard or grid editing
 *  is open (saverHold), and it always wakes for an alarm state (arming /
 *  entry delay / triggered), a water leak, or a task reminder — those
 *  overlays also sit ABOVE it in z-order, so an alert can never be hidden.
 *
 *  z-order: 40 — under the sensor corner card (44), AlarmOverlay (45),
 *  LeakOverlay (46), PIN pad (80) and the keyboard (120); over everything
 *  that is just a page.
 *
 *  Settings are household-wide (all kiosk panels). Per-panel overrides can
 *  come with the bedroom panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { isKiosk, useMe } from "@/lib/auth";
import { useHomeHub } from "@/lib/useHomeHub";
import { saverHeld } from "@/lib/panelDevice";
import Slideshow, { SlidePhoto } from "@/components/Slideshow";

export interface SaverConfig {
  enabled: boolean;
  idleMin: number;          // 1..30
  mode: "photos" | "clock";
  photoSecs: number;        // 10..60
  showAlarm: boolean;
  night: boolean;
  nightStart: string;       // "22:00"
  nightEnd: string;         // "06:00"
  nightBrightness: number;  // 10..100
}

export const SAVER_DEFAULTS: SaverConfig = {
  enabled: true, idleMin: 5, mode: "photos", photoSecs: 20, showAlarm: true,
  night: true, nightStart: "22:00", nightEnd: "06:00", nightBrightness: 30,
};

const num = (v: string | undefined, fb: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fb;
};
const hhmm = (v: string | undefined, fb: string) => (v && /^\d{2}:\d{2}$/.test(v) ? v : fb);
const flag = (v: string | undefined, fb: boolean) => (v === "1" ? true : v === "0" ? false : fb);

export function parseSaverConfig(v: Record<string, string>): SaverConfig {
  return {
    enabled: flag(v.saver_enabled, SAVER_DEFAULTS.enabled),
    idleMin: num(v.saver_idle_min, SAVER_DEFAULTS.idleMin, 1, 30),
    mode: v.saver_mode === "clock" ? "clock" : "photos",
    photoSecs: num(v.saver_photo_secs, SAVER_DEFAULTS.photoSecs, 5, 300),
    showAlarm: flag(v.saver_show_alarm, SAVER_DEFAULTS.showAlarm),
    night: flag(v.saver_night, SAVER_DEFAULTS.night),
    nightStart: hhmm(v.saver_night_start, SAVER_DEFAULTS.nightStart),
    nightEnd: hhmm(v.saver_night_end, SAVER_DEFAULTS.nightEnd),
    nightBrightness: num(v.saver_night_brightness, SAVER_DEFAULTS.nightBrightness, 10, 100),
  };
}

/** True when `now` falls inside [start, end), wrapping past midnight. */
export function inQuietHours(now: Date, start: string, end: string): boolean {
  const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const s = toMin(start), e = toMin(end), n = now.getHours() * 60 + now.getMinutes();
  if (s === e) return false;
  return s < e ? n >= s && n < e : n >= s || n < e;
}

function alarmLabel(state: string | undefined): { text: string; armed: boolean } | null {
  switch (state) {
    case "armed_away": return { text: "Armed · Away", armed: true };
    case "armed_home": return { text: "Armed · Home", armed: true };
    case "armed_night": return { text: "Armed · Night", armed: true };
    case "disarmed": return { text: "Disarmed", armed: false };
    default: return null;   // arming/pending/triggered wake the screen anyway
  }
}

const WAKE_STATES = new Set(["arming", "pending", "triggered"]);

export default function Screensaver() {
  const { me } = useMe();
  const kiosk = isKiosk(me);
  const { entities } = useHomeHub();
  const [cfg, setCfg] = useState<SaverConfig>(SAVER_DEFAULTS);
  const cfgRef = useRef(cfg);
  useEffect(() => { cfgRef.current = cfg; }, [cfg]);

  // settings: poll like SensorFlash so Admin edits land within a minute
  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/api/ui-settings")
        .then((r) => (r.ok ? r.json() : {}))
        .then((v) => { if (alive) setCfg(parseSaverConfig(v)); })
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const [on, setOn] = useState(false);
  const [preview, setPreview] = useState<SaverConfig | null>(null);   // Admin preview uses the unsaved form
  const lastActivity = useRef(Date.now());
  const wake = useCallback(() => { setOn(false); setPreview(null); lastActivity.current = Date.now(); }, []);

  // idle timer — kiosk only (a preview from Admin is the one exception)
  useEffect(() => {
    if (!kiosk) return;
    const bump = () => { lastActivity.current = Date.now(); };
    const evs: (keyof DocumentEventMap)[] = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel"];
    for (const ev of evs) document.addEventListener(ev, bump, { passive: true, capture: true });
    const tick = setInterval(() => {
      const c = cfgRef.current;
      if (!c.enabled) return;
      if (Date.now() - lastActivity.current < c.idleMin * 60_000) return;
      if (saverHeld()) { lastActivity.current = Date.now() - c.idleMin * 60_000 + 30_000; return; } // re-check in 30 s
      setOn((v) => {
        if (!v) { (document.activeElement as HTMLElement | null)?.blur?.(); }
        return true;
      });
    }, 5_000);
    return () => {
      for (const ev of evs) document.removeEventListener(ev, bump, { capture: true });
      clearInterval(tick);
    };
  }, [kiosk]);

  // explicit wake (task reminder popped) and Admin preview
  useEffect(() => {
    const onWake = () => wake();
    const onPreview = (e: Event) => {
      const v = (e as CustomEvent<Record<string, string> | null>).detail;
      setPreview(v ? parseSaverConfig(v) : cfgRef.current);
      setOn(true);
    };
    window.addEventListener("hh-saver-wake", onWake);
    window.addEventListener("hh-saver-preview", onPreview);
    return () => { window.removeEventListener("hh-saver-wake", onWake); window.removeEventListener("hh-saver-preview", onPreview); };
  }, [wake]);

  // auto-wake on alarm activity or a leak — never hide an alert
  const alarm = entities.get("alarm_control_panel.homehub");
  const alarmState = alarm?.state;
  const leak = useMemo(() => {
    for (const e of entities.values()) {
      if (e.domain === "binary_sensor" && String(e.attributes?.device_class ?? "") === "moisture" && e.state === "on") return true;
    }
    return false;
  }, [entities]);
  useEffect(() => {
    if (on && ((alarmState && WAKE_STATES.has(alarmState)) || leak)) wake();
  }, [on, alarmState, leak, wake]);

  // photos (only fetched while the saver is up, refreshed when it starts)
  const [photos, setPhotos] = useState<SlidePhoto[]>([]);
  const mode = (preview ?? cfg).mode;
  useEffect(() => {
    if (!on || mode !== "photos") return;
    let alive = true;
    api("/api/photos").then((r) => (r.ok ? r.json() : [])).then((list) => {
      if (alive && Array.isArray(list)) setPhotos(list.map((p: { id: string; original?: string }) => ({ id: p.id, original: p.original })));
    }).catch(() => {});
    return () => { alive = false; };
  }, [on, mode]);

  // clock + quiet-hours check, and a slow pixel drift against burn-in
  const [now, setNow] = useState(() => new Date());
  const [drift, setDrift] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!on) return;
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 10_000);
    const d = setInterval(() => setDrift({ x: Math.round((Math.random() - 0.5) * 40), y: Math.round((Math.random() - 0.5) * 30) }), 60_000);
    return () => { clearInterval(t); clearInterval(d); };
  }, [on]);

  if (!on) return null;
  const c = preview ?? cfg;
  const night = c.night && inQuietHours(now, c.nightStart, c.nightEnd);
  const usePhotos = !night && c.mode === "photos" && photos.length > 0;
  const status = c.showAlarm ? alarmLabel(alarmState) : null;

  const hh = now.getHours() % 12 || 12;
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ampm = now.getHours() < 12 ? "AM" : "PM";
  const date = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  // The wake tap is swallowed here, on capture, before anything beneath
  // can see it. pointerdown + click both cancelled so no button fires.
  const swallow = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); wake(); };

  const nightInk = `rgba(232, 237, 242, ${(0.12 + 0.88 * (c.nightBrightness / 100)).toFixed(2)})`;
  const nightAmber = `rgba(232, 163, 61, ${(0.12 + 0.88 * (c.nightBrightness / 100)).toFixed(2)})`;

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden"
      style={{ zIndex: 40, background: "#000", cursor: "default", touchAction: "none" }}
      onPointerDownCapture={swallow}
      onClickCapture={swallow}
      onKeyDownCapture={swallow}
      role="presentation"
      aria-label="Screensaver, tap to wake"
    >
      {usePhotos && <Slideshow photos={photos} onClose={wake} embedded slideMs={c.photoSecs * 1000} />}

      {night ? (
        <div className="absolute inset-0 grid place-items-center"
             style={{ transform: `translate(${drift.x}px, ${drift.y}px)`, transition: "transform 2s ease-in-out" }}>
          <div className="flex flex-col items-center gap-2" style={{ color: nightInk }}>
            <div className="flex items-baseline gap-3">
              <span className="font-[family-name:var(--font-display)] leading-none" style={{ fontSize: "min(24vw, 42vh)", fontWeight: 400, letterSpacing: "-0.02em" }}>{hh}:{mm}</span>
              <span className="font-[family-name:var(--font-display)]" style={{ fontSize: "min(5vw, 8vh)" }}>{ampm}</span>
            </div>
            <div style={{ fontSize: "min(3.6vw, 6vh)" }}>{date}</div>
            {status && (
              <div className="mt-4 flex items-center gap-3" style={{ fontSize: "min(3vw, 5vh)", color: status.armed ? nightAmber : nightInk }}>
                <span className="rounded-full" style={{ width: "0.5em", height: "0.5em", background: status.armed ? nightAmber : nightInk }} />
                {status.text}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {!usePhotos && <div className="absolute inset-0" style={{ background: "#0c1117" }} />}
          {status && (
            <div className="absolute flex items-center gap-2.5 rounded-full"
                 style={{ top: 28, right: 28, padding: "10px 18px", background: "rgba(12,17,23,0.72)",
                          border: `1px solid ${status.armed ? "rgba(232,163,61,0.5)" : "rgba(76,175,125,0.5)"}`, color: "#e8edf2" }}>
              <span className="rounded-full" style={{ width: 12, height: 12, background: status.armed ? "#e8a33d" : "#4caf7d" }} />
              <span style={{ fontSize: 17, fontWeight: 600 }}>{status.text}</span>
            </div>
          )}
          <div className="absolute flex flex-col"
               style={{ left: 36 + drift.x, bottom: 36 + drift.y, padding: "18px 28px 22px", borderRadius: 16,
                        background: "rgba(12,17,23,0.66)", color: "#e8edf2", transition: "left 2s ease-in-out, bottom 2s ease-in-out" }}>
            <div className="flex items-baseline gap-2.5">
              <span className="font-[family-name:var(--font-display)] leading-none" style={{ fontSize: "min(9vw, 16vh)", fontWeight: 500, letterSpacing: "-0.02em", color: "#fff" }}>{hh}:{mm}</span>
              <span className="font-[family-name:var(--font-display)]" style={{ fontSize: "min(2.6vw, 4.7vh)", fontWeight: 500 }}>{ampm}</span>
            </div>
            <div style={{ fontSize: "min(1.9vw, 3.3vh)", marginTop: 2 }}>{date}</div>
          </div>
          <div className="absolute rounded-full" style={{ right: 32, bottom: 32, padding: "8px 14px", background: "rgba(12,17,23,0.6)", color: "#e8edf2", fontSize: 15 }}>
            {preview ? "Preview — tap to close" : "Tap anywhere to wake"}
          </div>
        </>
      )}
    </div>
  );
}
