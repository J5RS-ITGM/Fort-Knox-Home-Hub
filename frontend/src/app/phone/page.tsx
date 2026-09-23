"use client";

/** /phone — the house phone.
 *
 *  Wall panels & kiosk: a keypad plus the allowed contacts, calling over the
 *  Twilio line. The keypad can dial anything, but the BACKEND only connects
 *  numbers on the allow-list (plus 911/933), so an off-list number gets a
 *  spoken refusal — the enforcement is server-side, never just hidden UI.
 *
 *  Phones/tablets: the same contacts as tel: links into the phone's own
 *  dialer, and no VOIP (the E911 address is the house, not the phone).
 */

import { useEffect, useState } from "react";
import { Delete, Phone, PhoneCall, ShieldAlert } from "lucide-react";
import PageShell from "@/components/PageShell";
import Call911 from "@/components/Call911";
import { useIsPhoneDevice } from "@/components/VoiceProvider";
import { hasNativeDialer } from "@/lib/panelDevice";
import { api } from "@/lib/api";
import { voice, useVoice } from "@/lib/voice";

interface Num { id: string; name: string; number: string; pretty: string; }
interface Cfg { number_pretty: string; e911_address: string; hold_secs: number; configured: boolean; }

const KEYS: [string, string][] = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", "+"], ["#", ""]];

function fmtDial(d: string) {
  const x = d.replace(/\D/g, "");
  if (x.length <= 3) return d;
  if (x.length <= 7) return `${x.slice(0, 3)}-${x.slice(3)}`;
  if (x.length <= 10) return `(${x.slice(0, 3)}) ${x.slice(3, 6)}-${x.slice(6)}`;
  return d;
}

function PhoneInner() {
  const isPanel = useIsPhoneDevice();
  const v = useVoice();
  const [nums, setNums] = useState<Num[]>([]);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [dial, setDial] = useState("");
  const [err, setErr] = useState("");
  const [show911, setShow911] = useState(false);
  const [dialer, setDialer] = useState(false);   // phone/tablet: tel: links; desktop: text only
  useEffect(() => { setDialer(hasNativeDialer()); }, []);

  useEffect(() => {
    api("/api/voice/numbers").then((r) => (r.ok ? r.json() : [])).then(setNums).catch(() => {});
    api("/api/voice/config").then((r) => (r.ok ? r.json() : null)).then((c) => c && setCfg(c)).catch(() => {});
  }, []);

  const call = async (to: string, label?: string) => {
    setErr("");
    try { await voice.dial(to, label); } catch (e) { setErr(e instanceof Error ? e.message : "Could not call"); }
  };

  const lineState = !cfg ? "" : !cfg.configured ? "Phone line not set up (Admin → Phone & 911)"
    : v.status === "ready" ? "Line ready" : v.status === "error" ? `Line error: ${v.error}` : "Connecting…";
  const lineOk = cfg?.configured && v.status === "ready";

  // ---- phones / tablets: hand off to the native dialer; desktops: list only
  if (!isPanel) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-ink-muted">
          {dialer ? "On a phone, calls go through your phone's own dialer."
                  : "This computer isn't a phone. Calls are placed from the wall panel (or from a phone, through its own dialer)."}
        </p>
        {nums.map((n) => dialer ? (
          <a key={n.id} href={`tel:${n.number}`} className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-panel-raised text-base font-bold text-lamp">{n.name[0]?.toUpperCase()}</span>
            <span className="flex-1"><span className="block font-semibold">{n.name}</span><span className="block text-xs text-ink-muted">{n.pretty}</span></span>
            <Phone size={20} className="text-ok" />
          </a>
        ) : (
          <div key={n.id} className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-panel-raised text-base font-bold text-lamp">{n.name[0]?.toUpperCase()}</span>
            <span className="flex-1"><span className="block font-semibold">{n.name}</span><span className="block text-xs text-ink-muted">{n.pretty}</span></span>
          </div>
        ))}
        {nums.length === 0 && <p className="text-sm text-ink-muted">No numbers on the allowed list yet.</p>}
        {dialer && (
          <a href="tel:911" className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-alert px-4 py-4 text-lg font-extrabold text-white">
            <ShieldAlert size={22} /> Call 911
          </a>
        )}
      </div>
    );
  }

  // ---- wall panel / kiosk: VOIP ------------------------------------------
  return (
    <>
      {show911 && <Call911 onClose={() => setShow911(false)} />}
      <div className="flex flex-col gap-5 tb:flex-row">
        <div className="flex w-full flex-col gap-3 tb:w-[420px] tb:shrink-0">
          <div className="flex h-16 items-center justify-between rounded-xl border border-line bg-panel px-4 text-2xl tracking-wider">
            <span className="min-w-0 flex-1 truncate">{dial ? fmtDial(dial) : <span className="text-base text-ink-muted">Enter a number</span>}</span>
            {dial && (
              <button type="button" aria-label="Backspace" onClick={() => setDial((d) => d.slice(0, -1))}
                className="ml-2 grid h-10 w-10 place-items-center rounded-lg text-ink-muted hover:text-ink"><Delete size={22} /></button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            {KEYS.map(([d, s]) => (
              <button key={d} type="button" onClick={() => setDial((x) => (x + d).slice(0, 15))}
                className="h-[72px] rounded-2xl border border-line bg-panel-raised text-2xl font-semibold text-ink">
                {d}<span className="mt-0.5 block text-[10px] tracking-[0.2em] text-ink-muted">{s || " "}</span>
              </button>
            ))}
          </div>
          <button type="button" disabled={!lineOk || !dial || !!v.call} onClick={() => void call(dial)}
            className="flex h-16 items-center justify-center gap-2 rounded-2xl bg-ok text-xl font-bold text-field disabled:opacity-40">
            <PhoneCall size={22} /> Call
          </button>
          <div className={`text-xs ${lineOk ? "text-ok" : "text-ink-muted"}`}>{lineState}</div>
          {err && <div className="text-xs font-semibold text-alert">{err}</div>}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-muted">Allowed contacts</div>
          {nums.map((n) => (
            <button key={n.id} type="button" disabled={!lineOk || !!v.call} onClick={() => void call(n.number, n.name)}
              className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-left disabled:opacity-50">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-panel-raised text-base font-bold text-lamp">{n.name[0]?.toUpperCase()}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-base font-semibold">{n.name}</span><span className="block text-xs text-ink-muted">{n.pretty}</span></span>
              <Phone size={22} className="shrink-0 text-ok" />
            </button>
          ))}
          {nums.length === 0 && <p className="text-sm text-ink-muted">No numbers on the allowed list yet. An admin adds them in Admin → Phone &amp; 911.</p>}

          <button type="button" onClick={() => setShow911(true)}
            className="mt-auto flex items-center justify-center gap-2 rounded-xl border border-alert/60 bg-alert/15 px-4 py-4 text-lg font-extrabold text-alert">
            <ShieldAlert size={22} /> Emergency · Call 911
          </button>
          <p className="text-[11px] leading-relaxed text-ink-muted">
            The panel only calls numbers on the allowed list and only rings for calls from them. 911 is always allowed.
            {cfg?.e911_address ? ` 911 calls from this panel are registered to ${cfg.e911_address}.` : ""}
          </p>
        </div>
      </div>
    </>
  );
}

export default function PhonePage() {
  return (
    <PageShell title="Phone" active="/phone">
      <PhoneInner />
    </PageShell>
  );
}
