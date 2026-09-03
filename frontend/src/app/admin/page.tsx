"use client";

import { useCallback, useEffect, useState } from "react";
import AuthGate from "@/components/AuthGate";
import { api, AuditRow, User } from "@/lib/api";

const input =
  "rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-muted/60 focus:border-lamp/60";
const btn =
  "rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-muted transition-colors hover:border-lamp/50 hover:text-ink disabled:opacity-50";

function AdminInner() {
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [error, setError] = useState("");

  const [nu, setNu] = useState({ username: "", password: "", display_name: "", role: "member" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [u, a] = await Promise.all([
      api("/api/admin/users").then((r) => (r.ok ? r.json() : [])),
      api("/api/admin/audit?limit=100").then((r) => (r.ok ? r.json() : [])),
    ]);
    setUsers(u);
    setAudit(a);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = async (fn: () => Promise<Response>) => {
    setError("");
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) setError((await res.json().catch(() => null))?.detail ?? `Failed (${res.status})`);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const createUser = () =>
    act(() => api("/api/admin/users", { method: "POST", body: JSON.stringify(nu) })).then(() =>
      setNu({ username: "", password: "", display_name: "", role: "member" }),
    );

  const patch = (id: string, body: Record<string, unknown>) =>
    act(() => api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }));

  const resetPassword = (u: User) => {
    const pw = window.prompt(`New password for ${u.username} (10+ chars):`);
    if (pw) patch(u.id, { password: pw });
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-6 flex items-center gap-3">
        <a href="/" className={btn}>← Dashboard</a>
        <h1 className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-wide">Admin</h1>
      </div>

      {error && <p className="mb-4 rounded-md border border-alert/40 bg-panel p-3 text-sm text-alert">{error}</p>}

      <section className="mb-10">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Users</h2>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-muted">
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-line/60 last:border-0">
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{u.display_name || u.username}</div>
                    <div className="font-[family-name:var(--font-mono)] text-[11px] text-ink-muted">{u.username}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={u.role === "admin" ? "text-lamp" : "text-ink-muted"}>{u.role}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={u.disabled ? "text-alert" : "text-ok"}>{u.disabled ? "disabled" : "active"}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      <button disabled={busy} className={btn}
                        onClick={() => patch(u.id, { role: u.role === "admin" ? "member" : "admin" })}>
                        {u.role === "admin" ? "Make member" : "Make admin"}
                      </button>
                      <button disabled={busy} className={btn}
                        onClick={() => patch(u.id, { disabled: !u.disabled })}>
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                      <button disabled={busy} className={btn} onClick={() => resetPassword(u)}>
                        Reset password
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input className={input} placeholder="Username" autoCapitalize="none"
            value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} />
          <input className={input} placeholder="Display name"
            value={nu.display_name} onChange={(e) => setNu({ ...nu, display_name: e.target.value })} />
          <input className={input} type="password" placeholder="Password (10+)"
            value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
          <select className={input} value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button disabled={busy || !nu.username || !nu.password} onClick={createUser}
            className="rounded-md bg-lamp px-3 py-2 text-xs font-semibold text-field transition-opacity hover:opacity-90 disabled:opacity-50">
            Add user
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
          Audit log <span className="normal-case tracking-normal">(latest 100)</span>
        </h2>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <tbody>
              {audit.map((r) => (
                <tr key={r.id} className="border-b border-line/60 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 font-[family-name:var(--font-mono)] text-[11px] text-ink-muted">
                    {new Date(r.ts).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-medium">{r.username}</td>
                  <td className="px-3 py-2">
                    <span className={r.action.includes("failed") ? "text-alert" : "text-ink"}>{r.action}</span>
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

export default function AdminPage() {
  return (
    <AuthGate adminOnly>
      <AdminInner />
    </AuthGate>
  );
}
