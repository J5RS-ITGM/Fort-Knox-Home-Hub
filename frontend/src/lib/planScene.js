"use client";

/** planScene — the ONE place house geometry gets built.
 *
 * WallPanel's mini board and SecurityBoard's full board both render the
 * floor plan through these helpers, so the two views cannot drift apart
 * again. Everything here operates in the shared coordinate system:
 *
 *   plan space  : the converter's viewBox, 0..1000 x 0..885.5 px
 *                 (backend/tools/obj2plan.py + obj2svg.py, identical
 *                 projection — regenerate both together)
 *   grid space  : the isometric world, x -4..4, z -3.75..3.75 — also the
 *                 space sensor placements are stored in (/api/placements)
 *
 * Contrast: three distinct tones with bright edge lines — slab (darkest),
 * room floors (mid, outlined), walls (light, solid with glowing top edges)
 * — tuned for the dark control-room field where the earlier flat slates
 * were unreadable.
 */
import * as THREE from "three";

export const PLAN_URL = "/floorplans/first_floor.svg";
export const PLAN_JSON_URL = "/floorplans/first_floor.plan.json";
export const PLAN_W = 1000;
export const PLAN_H = 885.5;

export function planFromGrid(x, y) {
  return { px: ((x + 4) / 8) * PLAN_W, py: ((y + 3.75) / 7.5) * PLAN_H };
}
export function gridFromPlan(px, py) {
  return { x: (px / PLAN_W) * 8 - 4, y: (py / PLAN_H) * 7.5 - 3.75 };
}
/** Plan-space rect {x,y,w,h} -> grid-space center + size. */
export function gridRect(r) {
  const a = gridFromPlan(r.x, r.y), b = gridFromPlan(r.x + r.w, r.y + r.h);
  return { cx: (a.x + b.x) / 2, cz: (a.y + b.y) / 2, w: b.x - a.x, d: b.y - a.y };
}

export async function fetchPlan() {
  try {
    const r = await fetch(PLAN_JSON_URL);
    if (!r.ok) return null;
    const p = await r.json();
    return p?.walls && p?.rooms && p?.viewbox ? p : null;
  } catch {
    return null;
  }
}

// High-contrast palette for plan geometry (see header).
export const PLAN_C = {
  slab: "#10141c",
  slabEdge: "#2b3956",
  room: "#222a3c",
  roomEdge: "#3d4c74",
  wall: "#525f82",
  wallEdge: "#8194c4",
};

export function makeTextSprite(text, { ghost = false, scale = 1 } = {}) {
  const cv = document.createElement("canvas");
  const dpr = 2; cv.width = 320 * dpr; cv.height = 80 * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.font = `${ghost ? "500 italic" : "600"} 26px 'DM Sans', system-ui, sans-serif`;
  ctx.fillStyle = ghost ? "rgba(126,140,156,0.85)" : "rgba(236,240,247,0.96)";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 7;
  ctx.fillText(text, 160, 40);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(2.75 * scale, 0.69 * scale, 1);
  return spr;
}

const WALL_STUB_H = 0.55;

/** Build one floor of real house geometry from the plan JSON.
 *  Returns a THREE.Group positioned at height y. Labels are NOT included —
 *  they're an interactive layer owned by the caller. */
export function buildPlanFloor(plan, y) {
  const g = new THREE.Group();
  const ext = gridRect({ x: 0, y: 0, w: plan.viewbox[0], h: plan.viewbox[1] });

  const slab = new THREE.Mesh(
    new THREE.PlaneGeometry(ext.w, ext.d),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(PLAN_C.slab), roughness: 0.95 })
  );
  slab.rotation.x = -Math.PI / 2; slab.position.set(ext.cx, y, ext.cz); g.add(slab);
  const slabEdge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(ext.w, ext.d)),
    new THREE.LineBasicMaterial({ color: new THREE.Color(PLAN_C.slabEdge) })
  );
  slabEdge.rotation.x = -Math.PI / 2; slabEdge.position.set(ext.cx, y + 0.001, ext.cz); g.add(slabEdge);

  const roomMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PLAN_C.room), roughness: 0.92 });
  const roomEdgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(PLAN_C.roomEdge) });
  plan.rooms.forEach((r) => {
    const rr = gridRect(r);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(rr.w, rr.d), roomMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(rr.cx, y + 0.004, rr.cz);
    g.add(floor);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(rr.w, rr.d)), roomEdgeMat);
    edge.rotation.x = -Math.PI / 2;
    edge.position.set(rr.cx, y + 0.006, rr.cz);
    g.add(edge);
  });

  // Walls: near-solid, with bright edge outlines that read from the iso
  // camera — this is what makes the footprint legible.
  const wallMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PLAN_C.wall), roughness: 0.85, transparent: true, opacity: 0.92,
  });
  const wallEdgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(PLAN_C.wallEdge) });
  plan.walls.forEach((wall) => {
    const rr = gridRect(wall);
    const geo = new THREE.BoxGeometry(Math.max(rr.w, 0.07), WALL_STUB_H, Math.max(rr.d, 0.07));
    const m = new THREE.Mesh(geo, wallMat);
    m.position.set(rr.cx, y + WALL_STUB_H / 2, rr.cz);
    g.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), wallEdgeMat);
    e.position.copy(m.position);
    g.add(e);
  });
  return g;
}

/** Default label records: plan rooms (floor 0) at their centers + a
 *  generic-rooms table for floors without a plan yet. Overrides (from the
 *  saved board state) merge by id, so plan regeneration keeps names. */
export function defaultLabels(plan, genericRooms, overrides = {}) {
  const defaults = [];
  if (plan) {
    plan.rooms.forEach((r) => {
      const rr = gridRect(r);
      defaults.push({ id: r.id, text: r.label || "", floor: 0, x: rr.cx, z: rr.cz });
    });
  } else {
    (genericRooms[0] ?? []).forEach(([cx, cz, , , label], i) =>
      defaults.push({ id: `gen0_${i}`, text: label, floor: 0, x: cx, z: cz }));
  }
  (genericRooms[1] ?? []).forEach(([cx, cz, , , label], i) =>
    defaults.push({ id: `gen1_${i}`, text: label, floor: 1, x: cx, z: cz }));
  return defaults.map((d) => ({ ...d, ...(overrides?.[d.id] ?? {}) }));
}

/** Fetch the saved security-board state (labels + view). Shared so the
 *  wall panel shows the same room names the board editor sets. */
export async function fetchBoardState(apiUrl) {
  try {
    const res = await fetch(`${apiUrl}/api/layouts/securityboard`, { credentials: "include" });
    if (!res.ok) return { labels: {}, view: null };
    const row = await res.json();
    const parsed = JSON.parse(row.layout_json || "{}");
    return { labels: parsed.labels ?? {}, view: parsed.view ?? null };
  } catch {
    return { labels: {}, view: null };
  }
}
