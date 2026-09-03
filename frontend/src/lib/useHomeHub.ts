"use client";

/** useHomeHub — one WebSocket, the whole house.
 *
 * Connects to the backend's /ws endpoint, takes the initial snapshot, then
 * applies live state pushes. Reconnects with capped backoff so a backend
 * restart heals itself; `linkUp` reflects the browser<->backend socket and
 * `bridgeUp` reflects the backend<->HA bridge, which the UI shows separately.
 */

import { useEffect, useRef, useState } from "react";
import { Entity, wsUrl } from "./api";

type ServerMessage =
  | { type: "snapshot"; connected: boolean; entities: Entity[] }
  | { type: "state"; entity: Entity }
  | { type: "bridge"; connected: boolean }
  | { type: "pong" };

export interface HomeHubState {
  entities: Map<string, Entity>;
  linkUp: boolean; // this browser <-> backend
  bridgeUp: boolean; // backend <-> Home Assistant (or mock)
}

export function useHomeHub(): HomeHubState {
  const [entities, setEntities] = useState<Map<string, Entity>>(new Map());
  const [linkUp, setLinkUp] = useState(false);
  const [bridgeUp, setBridgeUp] = useState(false);
  const backoff = useRef(1000);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl());

      ws.onopen = () => {
        setLinkUp(true);
        backoff.current = 1000;
      };

      ws.onmessage = (event) => {
        const msg: ServerMessage = JSON.parse(event.data);
        if (msg.type === "snapshot") {
          setBridgeUp(msg.connected);
          setEntities(new Map(msg.entities.map((e) => [e.entity_id, e])));
        } else if (msg.type === "state") {
          setEntities((prev) => {
            const next = new Map(prev);
            next.set(msg.entity.entity_id, msg.entity);
            return next;
          });
        } else if (msg.type === "bridge") {
          setBridgeUp(msg.connected);
        }
      };

      ws.onclose = () => {
        setLinkUp(false);
        setBridgeUp(false);
        if (!closed) {
          retryTimer = setTimeout(connect, backoff.current);
          backoff.current = Math.min(backoff.current * 2, 15000);
        }
      };

      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  return { entities, linkUp, bridgeUp };
}
