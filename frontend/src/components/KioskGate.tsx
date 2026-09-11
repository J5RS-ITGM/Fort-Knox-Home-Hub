"use client";

/** KioskGate — password prompt for entering/exiting kiosk mode. The
 *  password is verified server-side (/api/kiosk/enter|exit); this just
 *  collects it. Touch-friendly since Exit is used at the wall panel. */

import { useEffect, useRef, useState } from "react";
import { toggleKiosk } from "@/lib/auth";

export default function KioskGate({ mode, onClose }: { mode: "enter" | "exit"; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const submit = async () => {
    if (!pw) return;
    setBusy(true); setErr("");
    const e = await toggleKiosk(mode === "enter", pw);
    if (e) { setErr(e); setPw(""); setBusy(false); }
    // success navigates away; no need to reset busy
  };

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/80 p-4 backdrop-blur" onClick={onClose}>
      <div className="w-full max-w-xs rounded-2xl border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-base font-semibold">{mode === "enter" ? "Enter kiosk mode" : "Exit kiosk mode"}</h3>
        <p className="mb-4 text-xs text-ink-muted">
          {mode === "enter"
            ? "Locks this screen to the family views. The same password exits."
            : "Returns this screen to the full app."}
        </p>
        <input
          ref={ref}
          type="password"
          inputMode="text"
          autoComplete="off"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          placeholder="Kiosk password"
          className="mb-2 w-full rounded-lg border border-line bg-panel-raised px-3 py-3 text-base outline-none focus:border-lamp/60"
        />
        <div className="mb-3 min-h-4 text-xs font-semibold text-alert">{err}</div>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-line py-3 text-sm text-ink-muted hover:text-ink">Cancel</button>
          <button onClick={() => void submit()} disabled={busy || !pw}
                  className="flex-1 rounded-lg border border-lamp/60 bg-lamp/10 py-3 text-sm font-semibold text-lamp disabled:opacity-40">
            {busy ? "Checking…" : mode === "enter" ? "Enter" : "Exit"}
          </button>
        </div>
      </div>
    </div>
  );
}
