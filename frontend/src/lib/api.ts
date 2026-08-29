/** Types mirrored from the backend schemas + a tiny REST client.
 *  The frontend only ever talks to the FastAPI backend — never to Home
 *  Assistant directly. The HA token lives server-side only.
 */

export interface Entity {
  entity_id: string;
  domain: string;
  state: string;
  friendly_name: string;
  attributes: Record<string, unknown>;
  last_changed: string;
}

export interface Health {
  status: string;
  mode: "mock" | "live";
  ha_connected: boolean;
  entity_count: number;
}

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws";

export async function callService(
  domain: string,
  service: string,
  entityId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const res = await fetch(`${API_URL}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity_id: entityId, data }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Service call failed (${res.status}): ${detail}`);
  }
}
