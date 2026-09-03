"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { login } from "@/lib/auth";
import { API_URL } from "@/lib/api";

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
