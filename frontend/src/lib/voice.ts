"use client";

/** voice — the panel's phone line, on the Twilio Voice JS SDK.
 *
 *  One Device per browser, registered under a per-DEVICE identity so every
 *  wall panel rings on an inbound call. Tokens come from /api/voice/token
 *  (session-gated); all call routing and the allow-list are enforced by the
 *  BACKEND's TwiML webhooks — this file only asks, it never decides.
 *
 *  Who gets a phone: wall panels and kiosk sessions. Phones/tablets that
 *  leave the house do NOT register (see VoiceProvider): their 911 goes to
 *  the phone's own dialer, because the registered E911 address is the
 *  house, not wherever the phone happens to be.
 *
 *  911 is never dialled by code on its own. `dial("911")` is only ever
 *  called from the hold-to-call button after a person held it for the full
 *  duration (Call911.tsx).
 */

import { useEffect, useState } from "react";
import type { Call, Device } from "@twilio/voice-sdk";
import { api } from "@/lib/api";
import { getDeviceId } from "@/lib/deviceId";

export type VoiceStatus = "off" | "connecting" | "ready" | "error";
export interface VoiceState {
  status: VoiceStatus;
  error: string;
  incoming: Call | null;        // ringing, not yet answered
  call: Call | null;            // active or dialling
  callTo: string;               // number/name we dialled (or caller for inbound)
  callState: "idle" | "dialing" | "ringing" | "active" | "ended";
  muted: boolean;
  startedAt: number | null;
  failure: { message: string; code?: number; to: string } | null;   // shown until dismissed
}

const initial: VoiceState = {
  status: "off", error: "", incoming: null, call: null, callTo: "",
  callState: "idle", muted: false, startedAt: null, failure: null,
};

type Listener = (s: VoiceState) => void;

/** Plain-English reasons for the Twilio Voice SDK errors we can hit. */
function explain(code: number | undefined, fallback: string): string {
  switch (code) {
    case 31401: case 31402: case 31208: case 31201:
      return "No microphone available. Plug in the speakerphone and allow the microphone for this site.";
    case 31005: case 31009: case 53000: case 53405:
      return "Couldn't reach the phone service. Check the internet connection.";
    case 31204: case 31205: case 20101: case 20104:
      return "The phone line's login expired or is invalid. Check the Twilio settings in Admin → Phone & 911.";
    case 31000: case 31002: case 31003:
      return "The call was rejected by the phone service. Check the Twilio TwiML App and webhook URLs.";
    case 11200: case 11205: case 11210:
      return "The phone service couldn't reach Fort Knox's call handler (webhook).";
    default:
      return fallback || "The call failed.";
  }
}

class VoiceClient {
  private device: Device | null = null;
  private state: VoiceState = { ...initial };
  private listeners = new Set<Listener>();
  private starting = false;

  get snapshot(): VoiceState { return this.state; }
  subscribe(fn: Listener): () => void { this.listeners.add(fn); fn(this.state); return () => { this.listeners.delete(fn); }; }
  private set(patch: Partial<VoiceState>) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(this.state); }

  private async token(): Promise<string> {
    const r = await api("/api/voice/token", { method: "POST", body: JSON.stringify({ device_id: getDeviceId() }) });
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `token failed (${r.status})`);
    return (await r.json()).token as string;
  }

  /** Register this device with Twilio (idempotent). */
  async start(): Promise<void> {
    if (this.device || this.starting) return;
    this.starting = true;
    this.set({ status: "connecting", error: "" });
    try {
      const { Device } = await import("@twilio/voice-sdk");
      const tok = await this.token();
      const dev = new Device(tok, { closeProtection: true, logLevel: "error" });
      dev.on("registered", () => this.set({ status: "ready" }));
      dev.on("unregistered", () => this.set({ status: "connecting" }));
      dev.on("error", (e: { code?: number; message?: string }) => {
        const msg = explain(e.code, e.message ?? "");
        this.set({ status: "error", error: msg });
        // an error while a call is being placed is that call's failure
        if (this.state.call && this.state.callState !== "active") this.fail(this.state.callTo, msg, e.code);
      });
      dev.on("tokenWillExpire", async () => { try { dev.updateToken(await this.token()); } catch { /* next expiry retries */ } });
      dev.on("incoming", (call: Call) => {
        // Only one call at a time on a wall panel.
        if (this.state.call) { call.reject(); return; }
        const from = call.parameters?.From ?? "";
        this.set({ incoming: call, callTo: from, callState: "ringing" });
        call.on("cancel", () => this.set({ incoming: null, callTo: "", callState: "idle" }));
        call.on("disconnect", () => this.endCall());
        call.on("reject", () => this.set({ incoming: null, callTo: "", callState: "idle" }));
      });
      await dev.register();
      this.device = dev;
    } catch (e) {
      this.set({ status: "error", error: e instanceof Error ? e.message : "failed to start" });
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    try { this.device?.destroy(); } catch { /* ignore */ }
    this.device = null;
    this.set({ ...initial });
  }

  /** Place a call. The backend's TwiML decides whether it connects. */
  async dial(to: string, label?: string): Promise<void> {
    if (!this.device) throw new Error("phone not ready");
    if (this.state.call || this.state.incoming) throw new Error("already on a call");
    const name = label ?? to;
    this.set({ failure: null });
    // Fail loudly and early if there is no microphone: otherwise the SDK
    // tears the call down in a blink and the screen just flashes.
    if (!(await warmMic())) {
      this.fail(name, "No microphone available. Plug in the speakerphone and allow the microphone for this site.", 31402);
      return;
    }
    try {
      const call = await this.device.connect({ params: { To: to } });
      this.wire(call, name);
      this.set({ call, callTo: name, callState: "dialing", muted: false });
      void this.log(to, "dial");
    } catch (e) {
      const err = e as { code?: number; message?: string };
      this.fail(name, explain(err.code, err.message ?? ""), err.code);
    }
  }

  /** A failed call stays on screen (with the reason) until dismissed. */
  private fail(to: string, message: string, code?: number) {
    this.set({ call: null, incoming: null, callState: "idle", muted: false, startedAt: null,
               failure: { message, code, to } });
    void this.log(to, "failed", `${code ?? ""} ${message}`.trim().slice(0, 190));
  }
  dismissFailure(): void { this.set({ failure: null }); }

  answer(): void {
    const c = this.state.incoming;
    if (!c) return;
    c.accept();
    this.wire(c, this.state.callTo);
    this.set({ incoming: null, call: c, callState: "active", startedAt: Date.now(), muted: false });
    void this.log(this.state.callTo, "connected", "answered");
  }

  reject(): void { this.state.incoming?.reject(); this.set({ incoming: null, callTo: "", callState: "idle" }); }
  hangup(): void { this.state.call?.disconnect(); this.state.incoming?.reject(); this.endCall(); }
  mute(on: boolean): void { this.state.call?.mute(on); this.set({ muted: on }); }
  digits(d: string): void { this.state.call?.sendDigits(d); }

  private wire(call: Call, label: string) {
    let connected = false;
    let failed = false;
    call.on("accept", () => { connected = true; this.set({ callState: "active", startedAt: Date.now() }); });
    call.on("ringing", () => this.set({ callState: "dialing" }));
    call.on("error", (e: { code?: number; message?: string }) => {
      failed = true;
      this.fail(label, explain(e.code, e.message ?? ""), e.code);
    });
    call.on("disconnect", () => {
      if (failed) return;
      if (!connected && this.state.callState !== "active") {
        // Dropped before anyone answered: Twilio refused or couldn't route it.
        this.fail(label, "The call ended before it connected. Check Admin → Audit for voice_outbound_* entries, and the Twilio Console call log for an error code.");
        return;
      }
      void this.log(label, "ended");
      this.endCall();
    });
    call.on("cancel", () => this.endCall());
  }

  private endCall() { this.set({ call: null, incoming: null, callTo: "", callState: "idle", muted: false, startedAt: null }); }

  async log(to: string, kind: string, detail = ""): Promise<void> {
    try { await api("/api/voice/log", { method: "POST", body: JSON.stringify({ to, kind, detail }) }); } catch { /* best effort */ }
  }
}

export const voice = new VoiceClient();

export function useVoice(): VoiceState {
  const [s, setS] = useState<VoiceState>(voice.snapshot);
  useEffect(() => voice.subscribe(setS), []);
  return s;
}

/** Warm the microphone permission so a 911 call connects without a
 *  permission prompt in the way. Stops the tracks immediately. */
export async function warmMic(): Promise<boolean> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of s.getTracks()) t.stop();
    return true;
  } catch { return false; }
}
