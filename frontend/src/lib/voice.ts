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
}

const initial: VoiceState = {
  status: "off", error: "", incoming: null, call: null, callTo: "",
  callState: "idle", muted: false, startedAt: null,
};

type Listener = (s: VoiceState) => void;

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
      dev.on("error", (e: Error) => this.set({ status: "error", error: e.message }));
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
    const call = await this.device.connect({ params: { To: to } });
    this.wire(call, label ?? to);
    this.set({ call, callTo: label ?? to, callState: "dialing", muted: false });
    void this.log(to, "dial");
  }

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
    call.on("accept", () => this.set({ callState: "active", startedAt: Date.now() }));
    call.on("ringing", () => this.set({ callState: "dialing" }));
    call.on("disconnect", () => { void this.log(label, "ended"); this.endCall(); });
    call.on("cancel", () => this.endCall());
    call.on("error", (e: Error) => { this.set({ error: e.message }); void this.log(label, "failed", e.message.slice(0, 120)); this.endCall(); });
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
