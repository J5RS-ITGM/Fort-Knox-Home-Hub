"use client";

/** usePinGate — run a service call that the server may PIN-gate (locks,
 *  alarm). If the server answers pin_required / pin_invalid, a PinPad opens
 *  and the call is retried with the entered PIN. Usage:
 *
 *    const { run, pad } = usePinGate();
 *    await run("PIN to unlock · Front Door", (pin) => callService("lock", "unlock", id, pin ? { pin } : {}));
 *    ...render {pad} once in the component tree.
 */

import { useCallback, useRef, useState } from "react";
import PinPad, { PIN_C } from "@/components/PinPad";
import { ServiceError } from "@/lib/api";

type Job = { title: string; tone: string; fn: (pin?: string) => Promise<void>; resolve: (ok: boolean) => void };

export function usePinGate(tone: string = PIN_C.alert) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const jobRef = useRef<Job | null>(null);

  const run = useCallback((title: string, fn: (pin?: string) => Promise<void>, opts?: { requirePin?: boolean }): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      if (opts?.requirePin) {
        // Caller already knows a PIN is required (me.pin_set): open the pad
        // right away instead of a blind first call that would 403 anyway.
        const j: Job = { title, tone, fn, resolve };
        jobRef.current = j; setJob(j); setError("");
        return;
      }
      fn().then(() => resolve(true)).catch((e) => {
        if (e instanceof ServiceError && (e.detail === "pin_required" || e.detail === "pin_invalid")) {
          const j: Job = { title, tone, fn, resolve };
          jobRef.current = j; setJob(j); setError(e.detail === "pin_invalid" ? "Wrong PIN" : "");
        } else { console.error(e); resolve(false); }
      });
    });
  }, [tone]);

  const submit = async (pin: string) => {
    const j = jobRef.current; if (!j) return;
    setBusy(true);
    try {
      await j.fn(pin);
      setJob(null); jobRef.current = null; setError(""); j.resolve(true);
    } catch (e) {
      if (e instanceof ServiceError && e.detail === "pin_invalid") setError("Wrong PIN");
      else if (e instanceof ServiceError && e.status === 429) setError("Too many attempts — wait a bit");
      else { console.error(e); setJob(null); jobRef.current = null; j.resolve(false); }
    } finally { setBusy(false); }
  };
  const cancel = () => { const j = jobRef.current; setJob(null); jobRef.current = null; setError(""); j?.resolve(false); };

  const pad = job ? <PinPad title={job.title} tone={job.tone} error={error} busy={busy} onSubmit={(p) => void submit(p)} onCancel={cancel} /> : null;
  return { run, pad };
}
