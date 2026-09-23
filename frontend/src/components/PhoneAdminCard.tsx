"use client";

/** PhoneAdminCard — Admin → Phone & 911.
 *  Twilio credentials (write-only, encrypted), the number + E911 address,
 *  a live registration check, the 911 button settings, and the allowed
 *  numbers list (the only numbers the panel will call or ring for). */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Status {
  twilio_account_sid: boolean; twilio_auth_token: boolean; twilio_api_key_sid: boolean;
  twilio_api_key_secret: boolean; twilio_twiml_app_sid: boolean;
  number: string; number_pretty: string; e911_address: string; hold_secs: number; auto_show_911: boolean; configured: boolean;
}
interface Num { id: string; name: string; number: string; pretty: string; }

const input = "w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink outline-none focus:border-lamp/60";
const btn = "rounded-md border border-line px-3 py-1.5 text-xs text-ink-muted hover:text-ink disabled:opacity-40";
const primary = "rounded-md bg-lamp px-3 py-1.5 text-xs font-semibold text-field disabled:opacity-40";

export default function PhoneAdminCard() {
  const [st, setSt] = useState<Status | null>(null);
  const [nums, setNums] = useState<Num[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([api("/api/admin/voice/status"), api("/api/admin/voice/numbers")]);
    if (a.ok) setSt(await a.json());
    if (b.ok) setNums(await b.json());
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (f: () => Promise<Response>, ok: string) => {
    setBusy(true); setMsg("");
    try {
      const r = await f();
      if (!r.ok) { setMsg((await r.json().catch(() => null))?.detail ?? `Failed (${r.status})`); return false; }
      setMsg(ok); await load(); return true;
    } finally { setBusy(false); }
  };

  // credentials (write-only)
  const [c, setC] = useState({ account_sid: "", auth_token: "", api_key_sid: "", api_key_secret: "", twiml_app_sid: "" });
  const anyCred = Object.values(c).some((v) => v.trim());

  // number / address / button
  const [num, setNum] = useState(""); const [addr, setAddr] = useState("");
  const [hold, setHold] = useState(2); const [auto, setAuto] = useState(true);
  useEffect(() => { if (st) { setNum(st.number_pretty); setAddr(st.e911_address); setHold(st.hold_secs); setAuto(st.auto_show_911); } }, [st]);

  const [e911, setE911] = useState<Record<string, unknown> | null>(null);

  // allowed numbers
  const [nn, setNn] = useState({ name: "", number: "" });
  const [editing, setEditing] = useState<Num | null>(null);

  const Tick = ({ on }: { on: boolean }) => <span className={`ml-2 text-[11px] ${on ? "text-ok" : "text-ink-muted"}`}>{on ? "set" : "not set"}</span>;

  return (
    <div className="flex flex-col gap-4">
      {/* Twilio credentials */}
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-1 text-sm font-semibold">Twilio account</div>
        <p className="mb-3 text-[11px] text-ink-muted">Stored encrypted; set here and never shown again. Blank fields keep their current value.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {([["account_sid", "Account SID", st?.twilio_account_sid], ["auth_token", "Auth token", st?.twilio_auth_token],
             ["api_key_sid", "API Key SID", st?.twilio_api_key_sid], ["api_key_secret", "API Key Secret", st?.twilio_api_key_secret],
             ["twiml_app_sid", "TwiML App SID", st?.twilio_twiml_app_sid]] as [keyof typeof c, string, boolean | undefined][]).map(([k, label, on]) => (
            <label key={k} className="flex flex-col gap-1">
              <span className="text-xs text-ink-muted">{label}<Tick on={!!on} /></span>
              <input className={input} type={k.includes("secret") || k.includes("token") ? "password" : "text"} autoComplete="off"
                     value={c[k]} onChange={(e) => setC({ ...c, [k]: e.target.value })} placeholder={on ? "••••••••" : ""} />
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button className={primary} disabled={busy || !anyCred}
            onClick={() => act(() => api("/api/admin/voice/credentials", { method: "PUT", body: JSON.stringify(c) }), "Credentials saved").then((ok) => ok && setC({ account_sid: "", auth_token: "", api_key_sid: "", api_key_secret: "", twiml_app_sid: "" }))}>
            Save credentials
          </button>
          <button className={btn} disabled={busy} onClick={() => { if (window.confirm("Clear all Twilio credentials? The phone line stops working until they are re-entered.")) void act(() => api("/api/admin/voice/credentials/clear", { method: "POST" }), "Credentials cleared"); }}>
            Clear
          </button>
          <span className={`text-[11px] ${st?.configured ? "text-ok" : "text-ink-muted"}`}>{st?.configured ? "Phone line configured" : "Not configured yet"}</span>
        </div>
      </div>

      {/* number + E911 */}
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-3 text-sm font-semibold">Phone number &amp; emergency address</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1"><span className="text-xs text-ink-muted">Twilio number (caller ID + 911 callback)</span>
            <input className={input} value={num} onChange={(e) => setNum(e.target.value)} placeholder="(630) 555-0148" /></label>
          <label className="flex flex-col gap-1"><span className="text-xs text-ink-muted">Registered 911 address (as shown on the panel)</span>
            <input className={input} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="388 Twin Creeks Drive, Bolingbrook, IL 60440" /></label>
        </div>
        <p className="mt-2 text-[11px] text-ink-muted">The address itself is registered in the Twilio Console on the number (Phone Numbers → Active numbers → the number → Add Emergency Address). This field is only what the 911 screen displays.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className={primary} disabled={busy} onClick={() => act(() => api("/api/admin/voice/settings", { method: "PUT", body: JSON.stringify({ number: num, e911_address: addr }) }), "Saved")}>Save</button>
          <button className={btn} disabled={busy || !st?.configured}
            onClick={async () => { setBusy(true); try { const r = await api("/api/admin/voice/emergency-status"); setE911(await r.json()); } finally { setBusy(false); } }}>
            Check E911 registration with Twilio
          </button>
        </div>
        {e911 && (
          <div className={`mt-2 rounded-md border px-3 py-2 text-xs ${e911.ok && e911.emergency_address_status === "registered" ? "border-ok/50 text-ok" : "border-alert/50 text-alert"}`}>
            {e911.ok
              ? `Address status: ${String(e911.emergency_address_status ?? "none")} · emergency calling: ${String(e911.emergency_status ?? "unknown")}${e911.emergency_address_status !== "registered" ? " — 911 will route to a national relay and cost $75 per call until an address is registered on this number." : ""}`
              : `Check failed: ${String(e911.error)}`}
          </div>
        )}
      </div>

      {/* 911 button */}
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-3 text-sm font-semibold">911 button</div>
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-3">
            <span className="text-xs text-ink-muted">Hold to call</span>
            <div className="flex gap-1 rounded-lg border border-line bg-field p-1">
              {[1, 2, 3].map((s) => (
                <button key={s} type="button" onClick={() => setHold(s)}
                  className={`min-w-10 rounded-md px-3 py-1.5 text-sm ${hold === s ? "bg-lamp font-semibold text-field" : "text-ink-muted hover:text-ink"}`}>{s}s</button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-[var(--color-lamp)]" />
            Show Call 911 on the alarm popup when triggered
          </label>
          <button className={primary} disabled={busy} onClick={() => act(() => api("/api/admin/voice/settings", { method: "PUT", body: JSON.stringify({ hold_secs: hold, auto_show_911: auto }) }), "Saved")}>Save</button>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-ink-muted">
          The panel never dials 911 on its own; a call happens only when a person holds the button. No PIN is required for 911 or to answer a call.
          VOIP 911 needs power and internet: keep the panel and router on a UPS and treat cell phones as the primary path.
        </p>
      </div>

      {/* allowed numbers */}
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-1 text-sm font-semibold">Allowed numbers</div>
        <p className="mb-3 text-[11px] text-ink-muted">
          The panel can only call these numbers and only rings for calls from them. 911 is always allowed and never listed.
          After a 911 call, any number can ring the panel for 30 minutes so a dispatcher callback gets through.
        </p>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1"><span className="text-xs text-ink-muted">Name</span>
            <input className={`${input} w-44`} value={nn.name} onChange={(e) => setNn({ ...nn, name: e.target.value })} placeholder="Jessica" /></label>
          <label className="flex flex-col gap-1"><span className="text-xs text-ink-muted">Number</span>
            <input className={`${input} w-44`} value={nn.number} onChange={(e) => setNn({ ...nn, number: e.target.value })} placeholder="(630) 555-0172" inputMode="tel" /></label>
          <button className={primary} disabled={busy || !nn.name.trim() || !nn.number.trim()}
            onClick={() => act(() => api("/api/admin/voice/numbers", { method: "POST", body: JSON.stringify(nn) }), "Number added").then((ok) => ok && setNn({ name: "", number: "" }))}>
            Add
          </button>
        </div>
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-sm">
            <tbody>
              {nums.length === 0 && <tr><td className="px-3 py-3 text-xs text-ink-muted">No numbers yet. The panel can only call 911 until you add some.</td></tr>}
              {nums.map((n) => (
                <tr key={n.id} className="border-b border-line/60 last:border-0">
                  {editing?.id === n.id ? (
                    <>
                      <td className="px-3 py-2"><input className={input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></td>
                      <td className="px-3 py-2"><input className={input} value={editing.number} onChange={(e) => setEditing({ ...editing, number: e.target.value })} /></td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <button className={primary} disabled={busy} onClick={() => act(() => api(`/api/admin/voice/numbers/${n.id}`, { method: "PUT", body: JSON.stringify({ name: editing.name, number: editing.number }) }), "Saved").then((ok) => ok && setEditing(null))}>Save</button>
                        <button className={`${btn} ml-2`} onClick={() => setEditing(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 font-medium">{n.name}</td>
                      <td className="px-3 py-2 font-[family-name:var(--font-mono)] text-xs text-ink-muted">{n.pretty}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <button className={btn} onClick={() => setEditing({ ...n, number: n.pretty })}>Edit</button>
                        <button className={`${btn} ml-2 text-alert`} disabled={busy}
                          onClick={() => { if (window.confirm(`Remove ${n.name}?`)) void act(() => api(`/api/admin/voice/numbers/${n.id}`, { method: "DELETE" }), "Removed"); }}>Remove</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {msg && <div className="text-xs text-ink-muted">{msg}</div>}
    </div>
  );
}
