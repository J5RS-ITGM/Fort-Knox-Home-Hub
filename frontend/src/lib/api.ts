/** Types + REST client. The frontend only ever talks to the FastAPI
 *  backend — never to Home Assistant. The HA token lives server-side only.
 *
 *  URLs: in production the app sits behind one reverse-proxied origin
 *  (/ -> Next, /api + /ws -> FastAPI), so defaults are same-origin.
 *  Dev overrides via NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL.
 */

export interface Entity {
  entity_id: string;
  domain: string;
  state: string;
  friendly_name: string;
  attributes: Record<string, unknown>;
  last_changed: string;
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "member" | "kiosk";
  disabled: boolean;
  pin_set: boolean;
  created_at: string;
}

export interface AuditRow {
  id: number;
  ts: string;
  username: string;
  action: string;
  detail: string;
}

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export function wsUrl(): string {
  const env = process.env.NEXT_PUBLIC_WS_URL;
  if (env) return env;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

/** fetch wrapper: cookies on, 401 -> /login (except on auth pages). */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (res.status === 401 && typeof window !== "undefined") {
    const p = window.location.pathname;
    if (p !== "/login" && p !== "/setup") {
      window.location.href = `/login?next=${encodeURIComponent(p)}`;
    }
  }
  return res;
}

/** Error from the service proxy, carrying the backend's `detail` string
 *  (e.g. "pin_required", "pin_invalid") so UI can react specifically. */
export class ServiceError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`Service call failed (${status}): ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

export async function callService(
  domain: string,
  service: string,
  entityId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const res = await api(`/api/services/${domain}/${service}`, {
    method: "POST",
    body: JSON.stringify({ entity_id: entityId, data }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ServiceError(res.status, String(body?.detail ?? res.statusText));
  }
}
