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
  const dpr = 2; cv.width = 360 * dpr; cv.height = 96 * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  // subtle rounded backing so labels stay legible over walls/floors
  if (!ghost) {
    ctx.fillStyle = "rgba(10,14,20,0.55)";
    const w = 340, h = 46, x = 10, yy = 25, r = 12;
    ctx.beginPath();
    ctx.moveTo(x + r, yy); ctx.arcTo(x + w, yy, x + w, yy + h, r);
    ctx.arcTo(x + w, yy + h, x, yy + h, r); ctx.arcTo(x, yy + h, x, yy, r);
    ctx.arcTo(x, yy, x + w, yy, r); ctx.closePath(); ctx.fill();
  }
  ctx.font = `${ghost ? "500 italic" : "700"} 32px 'DM Sans', system-ui, sans-serif`;
  ctx.fillStyle = ghost ? "rgba(150,164,182,0.85)" : "rgba(240,244,250,0.98)";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 6;
  ctx.fillText(text, 180, 48);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(3.4 * scale, 0.9 * scale, 1);
  return spr;
}

const WALL_H = 0.85; // taller than the old 0.55 stub for legibility

/** Build one floor of real house geometry from the plan JSON.
 *  Returns a THREE.Group positioned at height y. Labels are NOT included —
 *  they're an interactive layer owned by the caller. */
export function buildPlanFloor(plan, y, floorIndex = 0) {
  const g = new THREE.Group();
  const ext = gridRect({ x: 0, y: 0, w: plan.viewbox[0], h: plan.viewbox[1] });
  const upper = floorIndex > 0;

  // Ground floor gets a filled slab; upper floors get only a faint outline
  // frame (no opaque plane) so you can see the floor below through it.
  if (!upper) {
    const slab = new THREE.Mesh(
      new THREE.PlaneGeometry(ext.w, ext.d),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(PLAN_C.slab), roughness: 0.95 })
    );
    slab.rotation.x = -Math.PI / 2; slab.position.set(ext.cx, y, ext.cz); g.add(slab);
  }
  const slabEdge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(ext.w, ext.d)),
    new THREE.LineBasicMaterial({ color: new THREE.Color(PLAN_C.slabEdge), transparent: upper, opacity: upper ? 0.5 : 1 })
  );
  slabEdge.rotation.x = -Math.PI / 2; slabEdge.position.set(ext.cx, y + 0.001, ext.cz); g.add(slabEdge);

  // Room floor tiles: on upper floors make them lightly translucent so the
  // downstairs still reads through when viewing "all".
  const roomMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PLAN_C.room), roughness: 0.92,
    transparent: upper, opacity: upper ? 0.35 : 1,
  });
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

  // Walls: taller and more solid for legibility, with bright edge outlines.
  const wallMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PLAN_C.wall), roughness: 0.85, transparent: true, opacity: 0.55,
  });
  const wallEdgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(PLAN_C.wallEdge) });
  plan.walls.forEach((wall) => {
    const rr = gridRect(wall);
    const geo = new THREE.BoxGeometry(Math.max(rr.w, 0.07), WALL_H, Math.max(rr.d, 0.07));
    const m = new THREE.Mesh(geo, wallMat);
    m.position.set(rr.cx, y + WALL_H / 2, rr.cz);
    g.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), wallEdgeMat);
    e.position.copy(m.position);
    g.add(e);
  });

  // Door / window openings: draw two short frame posts at the edges of each
  // gap (and a threshold line) so the opening reads as a real doorway.
  const postMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PLAN_C.wallEdge) });
  (plan.doors ?? []).forEach((d) => {
    const c = gridRect({ x: d.cx - 2, y: d.cy - 2, w: 4, h: 4 });
    const gp = gridRect({ x: d.cx - d.half, y: d.cy - d.half, w: d.half * 2, h: d.half * 2 });
    const span = d.horiz ? Math.abs(gp.w) : Math.abs(gp.d);
    const postH = d.window ? WALL_H * 0.5 : WALL_H;
    const postY = d.window ? y + WALL_H * 0.55 : y + postH / 2;
    [-1, 1].forEach((side) => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, postH, 0.08), postMat);
      if (d.horiz) post.position.set(c.cx + side * (span / 2), postY, c.cz);
      else post.position.set(c.cx, postY, c.cz + side * (span / 2));
      g.add(post);
    });
    // header beam across the top of the opening
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(d.horiz ? span : 0.08, 0.08, d.horiz ? 0.08 : span), postMat
    );
    beam.position.set(c.cx, y + WALL_H, c.cz);
    g.add(beam);
  });

  // Typed features: doors, windows, and the garage door. Each is a rect in
  // plan coordinates sitting on a wall centerline (w>h = horizontal wall).
  // Feature meshes with an `entity` binding are exposed on g.userData so
  // the board's render loop can live-color them (green closed / red open)
  // and tilt the garage panel; unbound features keep these static colors.
  const featureMeshes = [];
  const FEAT_C = { door: 0x3fb98f, window: 0x5b9bd5, garage: 0x8a91a0 };
  (plan.features ?? []).forEach((f) => {
    const rr = gridRect(f);
    const horiz = rr.w >= rr.d;
    const span = horiz ? rr.w : rr.d;
    if (f.type === "window") {
      // half-height translucent pane set into the wall
      const pane = new THREE.Mesh(
        new THREE.BoxGeometry(horiz ? span : 0.1, WALL_H * 0.45, horiz ? 0.1 : span),
        new THREE.MeshStandardMaterial({ color: FEAT_C.window, transparent: true, opacity: 0.4,
          emissive: FEAT_C.window, emissiveIntensity: 0.3, roughness: 0.2 })
      );
      pane.position.set(rr.cx, y + WALL_H * 0.55, rr.cz);
      g.add(pane);
      featureMeshes.push({ id: f.id, type: f.type, entity: f.entity ?? "", mesh: pane });
    } else if (f.type === "garage_door") {
      // wide panel hinged at its top edge (geometry translated so rotation
      // tilts it up like a real sectional door)
      const geo = new THREE.BoxGeometry(horiz ? span : 0.09, WALL_H * 0.85, horiz ? 0.09 : span);
      geo.translate(0, -WALL_H * 0.425, 0);
      const panel = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: FEAT_C.garage, transparent: true, opacity: 0.85,
          emissive: FEAT_C.garage, emissiveIntensity: 0.2, roughness: 0.6 })
      );
      panel.position.set(rr.cx, y + WALL_H * 0.9, rr.cz);
      g.add(panel);
      // rail lines at the panel edges so the door reads as a door
      const railMat = new THREE.LineBasicMaterial({ color: new THREE.Color(PLAN_C.wallEdge) });
      const rail = new THREE.LineSegments(new THREE.EdgesGeometry(geo), railMat);
      rail.position.copy(panel.position);
      panel.userData.railEdge = rail;
      g.add(rail);
      featureMeshes.push({ id: f.id, type: f.type, entity: f.entity ?? "", mesh: panel });
    } else if (f.type === "slider") {
      // sliding door: two half-span panels, one nudged to the interior track
      const half = span / 2;
      [[-0.25, -0.06], [0.25, 0.06]].forEach(([along, off]) => {
        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(horiz ? half : 0.06, WALL_H * 0.75, horiz ? 0.06 : half),
          new THREE.MeshStandardMaterial({ color: FEAT_C.door, transparent: true, opacity: 0.75,
            emissive: FEAT_C.door, emissiveIntensity: 0.25, roughness: 0.4 })
        );
        if (horiz) panel.position.set(rr.cx + along * span, y + WALL_H * 0.375, rr.cz + off);
        else panel.position.set(rr.cx + off, y + WALL_H * 0.375, rr.cz + along * span);
        g.add(panel);
        featureMeshes.push({ id: f.id, type: f.type, entity: f.entity ?? "", mesh: panel });
      });
    } else {
      // hinged door: leaf set into the opening + swing arc etched on the floor
      const leaf = new THREE.Mesh(
        new THREE.BoxGeometry(horiz ? span : 0.08, WALL_H * 0.8, horiz ? 0.08 : span),
        new THREE.MeshStandardMaterial({ color: FEAT_C.door, transparent: true, opacity: 0.8,
          emissive: FEAT_C.door, emissiveIntensity: 0.25, roughness: 0.5 })
      );
      leaf.position.set(rr.cx, y + WALL_H * 0.4, rr.cz);
      g.add(leaf);
      const arcPts = [];
      const swingIn = (f.swing ?? "in") === "in";
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * (Math.PI / 2);
        const r = span;
        if (horiz) arcPts.push(new THREE.Vector3(rr.cx - span/2 + Math.cos(a)*r, y + 0.01, rr.cz + (swingIn ? -1 : 1) * Math.sin(a)*r));
        else arcPts.push(new THREE.Vector3(rr.cx + (swingIn ? -1 : 1) * Math.sin(a)*r, y + 0.01, rr.cz - span/2 + Math.cos(a)*r));
      }
      const arc = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(arcPts),
        new THREE.LineBasicMaterial({ color: FEAT_C.door, transparent: true, opacity: 0.35 })
      );
      g.add(arc);
      featureMeshes.push({ id: f.id, type: f.type, entity: f.entity ?? "", mesh: leaf });
    }
  });
  g.userData.featureMeshes = featureMeshes;
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
