"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { login } from "@/lib/auth";
import { API_URL } from "@/lib/api";
import { isBigTouchScreen, markPanelDevice, usePanelDevice } from "@/lib/panelDevice";
import { closeOsk, openOsk } from "@/components/KioskKeyboard";

/** Keyboard glyph for the on-screen keyboard button (no icon font on the
 *  login screen, keep it self-contained). */
function KeyboardIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";

  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // On-screen keyboard for screens with no physical keyboard. A flagged
  // wall panel (?panel=1 launcher URL) opens it automatically on focus; any
  // big touchscreen gets a Keyboard button as a fallback so a brand-new
  // panel can still log in. Phones never see either (they have their own).
  const panel = usePanelDevice();
  const [bigTouch, setBigTouch] = useState(false);
  const [oskOpen, setOskOpen] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setBigTouch(isBigTouchScreen());
    const onState = (e: Event) => setOskOpen(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener("hh-osk-state", onState);
    return () => window.removeEventListener("hh-osk-state", onState);
  }, []);
  const showKeyboardButton = panel || bigTouch;
  const toggleKeyboard = () => {
    if (oskOpen) { closeOsk(); return; }
    markPanelDevice(false);                       // this session only
    openOsk(userRef.current);
  };

  useEffect(() => {
    fetch(`${API_URL}/api/auth/setup`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setNeedsSetup(!!d.needs_setup))
      .catch(() => setNeedsSetup(false));
  }, []);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (needsSetup) {
        const res = await fetch(`${API_URL}/api/auth/setup`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password, display_name: displayName }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? "Setup failed");
      } else {
        await login(username, password);
      }
      router.replace(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && username && password && !busy) submit();
  };

  const input =
    "w-full rounded-md border border-line bg-panel px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-muted/60 focus:border-lamp/60";

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center font-[family-name:var(--font-display)] text-2xl font-semibold tracking-wide">
          Home<span className="text-lamp">Hub</span>
        </h1>
        <p className="mb-8 text-center text-xs text-ink-muted">
          {needsSetup === null
            ? "…"
            : needsSetup
              ? "First run — create the admin account"
              : "Sign in to continue"}
        </p>

        <div className="flex flex-col gap-3" onKeyDown={onKey}>
          <input
            ref={userRef}
            className={input}
            placeholder="Username"
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          {needsSetup && (
            <input
              className={input}
              placeholder="Display name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}
          <input
            className={input}
            type="password"
            placeholder={needsSetup ? "Password (10+ characters)" : "Password"}
            autoComplete={needsSetup ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && <p className="text-xs text-alert">{error}</p>}

          <button
            onClick={submit}
            disabled={busy || !username || !password || needsSetup === null}
            className="mt-1 rounded-md bg-lamp px-3 py-2.5 text-sm font-semibold text-field transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "…" : needsSetup ? "Create admin account" : "Sign in"}
          </button>

          {showKeyboardButton && (
            <button
              type="button"
              onClick={toggleKeyboard}
              className="mt-2 flex h-12 items-center justify-center gap-2.5 rounded-md border border-line bg-panel text-sm font-medium text-ink"
            >
              <span className="text-lamp"><KeyboardIcon /></span>
              {oskOpen ? "Hide keyboard" : "Keyboard"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
