"use client";

import React, { useRef, useState, useMemo, useEffect, useCallback } from "react";
import * as THREE from "three";
import { API_URL, callService } from "@/lib/api";
import { useHomeHub } from "@/lib/useHomeHub";
import { BOTTOM_TABS_HEIGHT } from "@/components/BottomTabs";
import { webglSurfaces } from "@/lib/theme";
import {
  PLAN_URL, PLAN_JSON_URL, PLAN_W, PLAN_H,
  planFromGrid, gridFromPlan, gridRect,
  buildPlanFloor, makeTextSprite, defaultLabels, fetchBoardState,
} from "@/lib/planScene";

/* ------------------------------------------------------------------ *
 * Security Board — isometric 2.5D, live.
 * Ported from the Vite prototype. Data plumbing now real:
 *   - marker positions come from /api/placements (Postgres); first run
 *     seeds sensible defaults for the demo floor plan
 *   - sensor type derives from HA device_class, label from friendly_name
 *   - live state + armed come from useHomeHub; arm/disarm via services
 *   - Edit mode: drag markers on the floor plane, positions save back
 *   - Ground-floor 3D geometry comes from the Sweet Home 3D pipeline:
 *     backend/tools/obj2plan.py emits first_floor.plan.json in the SAME
 *     viewBox transform as the 2D SVG, so 3D walls/rooms, the 2D plan,
 *     and saved placements share one coordinate system. If the JSON is
 *     missing, the generic demo geometry renders as a fallback.
 * ------------------------------------------------------------------ */

let C = {
  secure:"#3fb98f", open:"#e0483d", motion:"#f0a838", offline:"#7a7f8a",
  lowbat:"#d9a441", floor:"#20242e", floorEdge:"#2c3140", wall:"#2a2f3b",
  bg0:"#0f1116", bg1:"#161922", text:"#e8ebf2", sub:"#8a91a0", accent:"#6b8afd",
};
const hx = (h) => new THREE.Color(h);
const FLOOR_H = 2.2;

const TYPE_LABEL = { contact:"Contact", motion:"Motion", leak:"Leak", smoke:"Smoke/CO" };


// rooms: [centerX, centerZ, width, depth, label] per floor (static demo plan)
const ROOMS = {
  0: [
    [-2.25,-1.9, 4.5, 3.7, "Living Room"],
    [ 2.25,-1.9, 4.5, 3.7, "Kitchen"],
    [-2.6, 1.85, 3.8, 3.8, "Garage"],
    [ 1.3, 1.85, 4.4, 3.8, "Family Room"],
  ],
  1: [
    [-2.25,-1.9, 4.5, 3.7, "Master Bedroom"],
    [ 2.25,-1.9, 4.5, 3.7, "Bedroom 2"],
    [-2.6, 1.85, 3.8, 3.8, "Bath"],
    [ 1.3, 1.85, 4.4, 3.8, "Landing / Hall"],
  ],
};


function typeFor(entity) {
  const dc = String(entity?.attributes?.device_class ?? "");
  if (dc === "motion" || dc === "occupancy") return "motion";
  if (dc === "moisture") return "leak";
  if (dc === "smoke" || dc === "gas" || dc === "carbon_monoxide") return "smoke";
  return "contact";
}
function labelFor(entity, placement) {
  if (entity?.friendly_name) return entity.friendly_name;
  return placement.entity_id.split(".").pop().replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
function liveFor(type, entity) {
  if (!entity) return undefined; // offline / unknown to HA
  const on = entity.state === "on";
  let state = "secure";
  if (type === "motion") state = on ? "motion" : "secure";
  else if (type === "smoke") state = on ? "triggered" : "secure";
  else state = on ? "open" : "secure";
  const battery = typeof entity.attributes?.battery === "number" ? entity.attributes.battery : 100;
  return { state, battery, lastChanged: entity.last_changed };
}
function colorFor(type, live, armed) {
  if (!live) return C.offline;
  if (live.battery <= 15) return C.lowbat;
  if (live.state === "open" || live.state === "triggered") return C.open;
  if (live.state === "motion") return armed ? C.open : C.motion;
  return C.secure;
}
function relTime(iso) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function useIsNarrow(bp = 760) {
  const [narrow, setNarrow] = useState(
    typeof window !== "undefined" ? window.innerWidth < bp : false
  );
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < bp);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [bp]);
  return narrow;
}

// ------------------------------------------------------------------
// Three.js scene
// ------------------------------------------------------------------
// labels: [{id, text, floor, x, z}] — draggable in edit mode, dbl-tap to
// rename. view: {zoom, tx, tz} initial camera state. onView fires
// (debounced upstream) so zoom/pan persist per panel.
function ThreeScene({ sensors, plan, labels, view, liveStateRef, armedRef, selectedRef, editRef, floorView, onPick, onMoved, onLabelMoved, onLabelRename, onView, narrow }) {
  const mountRef = useRef();
  const zoomApi = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    let W = mount.clientWidth || 400, H = mount.clientHeight || 300;

    const scene = new THREE.Scene();
    const d = narrow ? 6.5 : 8;
    const aspect = W / H;
    const cam = new THREE.OrthographicCamera(-d*aspect, d*aspect, d, -d, 0.1, 100);

    // Camera rig: iso offset from a pannable ground target, with ortho
    // zoom. Restored from the saved view; changes report up via onView.
    const target = new THREE.Vector3(view?.tx ?? 0, 1.4, view?.tz ?? 0);
    let zoom = Math.min(4, Math.max(0.5, view?.zoom ?? (narrow ? 1.15 : 1.35)));
    function applyCam() {
      cam.zoom = zoom;
      cam.position.set(target.x + 11, 12, target.z + 11);
      cam.lookAt(target.x, 1.4, target.z);
      cam.updateProjectionMatrix();
    }
    applyCam();
    const reportView = () => onView?.({ zoom, tx: target.x, tz: target.z });
    function setZoom(z, silent) {
      zoom = Math.min(4, Math.max(0.5, z));
      applyCam();
      if (!silent) reportView();
    }
    // Screen-space pan axes projected onto the ground plane (constant for
    // a fixed iso heading): screen-right and screen-up in XZ.
    const panRight = new THREE.Vector3(1, 0, -1).normalize();
    const panUp = new THREE.Vector3(-1, 0, -1).normalize();
    function panBy(dxPx, dyPx) {
      const worldPerPx = (cam.right - cam.left) / cam.zoom / W;
      target.addScaledVector(panRight, -dxPx * worldPerPx);
      target.addScaledVector(panUp, dyPx * worldPerPx * 1.35); // iso foreshortening on the screen-Y axis
      target.x = Math.max(-6, Math.min(6, target.x));
      target.z = Math.max(-6, Math.min(6, target.z));
      applyCam();
    }

    const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.8); key.position.set(8,14,6); scene.add(key);
    const fill = new THREE.DirectionalLight(0x6b7ce0, 0.25); fill.position.set(-6,8,-4); scene.add(fill);

    const makeLabel = (text, ghost = false) => makeTextSprite(text, { ghost });

    function buildFloor(y, floorIdx) {
      const g = new THREE.Group();
      const slab = new THREE.Mesh(
        new THREE.PlaneGeometry(9, 7.5),
        new THREE.MeshStandardMaterial({ color:hx(C.floor), roughness:0.95 })
      );
      slab.rotation.x = -Math.PI/2; slab.position.y = y; g.add(slab);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(9,7.5)),
        new THREE.LineBasicMaterial({ color:hx(C.floorEdge) })
      );
      edges.rotation.x = -Math.PI/2; edges.position.y = y + 0.001; g.add(edges);

      const wallMat = new THREE.MeshStandardMaterial({ color:hx(C.wall), roughness:1, transparent:true, opacity:0.5 });
      const perim = [[0,-3.75,9,0.12],[0,3.75,9,0.12],[-4.5,0,0.12,7.5],[4.5,0,0.12,7.5]];
      const inner = [[0,0,0.1,7.5],[0,0,9,0.1]];
      [...perim, ...inner].forEach(w=>{
        const m = new THREE.Mesh(new THREE.BoxGeometry(w[2],0.6,w[3]), wallMat);
        m.position.set(w[0], y+0.3, w[1]); g.add(m);
      });

      ROOMS[floorIdx].forEach(()=>{ /* labels now render from the labels layer */ });
      return g;
    }

    const floor0 = plan ? buildPlanFloor(plan, 0) : buildFloor(0, 0);
    const floor1 = buildFloor(FLOOR_H, 1); // generic until a 2nd-floor OBJ exists
    scene.add(floor0, floor1);

    const markerMeshes = [];
    sensors.forEach(s => {
      const y = s.floor * FLOOR_H + 0.5;
      const grp = new THREE.Group();
      grp.position.set(s.x, y, s.z);
      const rad = narrow ? 0.30 : 0.22;

      const drop = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015,0.015,0.5,6),
        new THREE.MeshBasicMaterial({ color:hx(C.secure), transparent:true, opacity:0.5 })
      );
      drop.position.y = -0.25; grp.add(drop);

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(rad, 20, 20),
        new THREE.MeshStandardMaterial({ color:hx(C.secure), emissive:hx(C.secure), emissiveIntensity:0.5, roughness:0.3 })
      );
      sphere.userData.sensorId = s.entity_id;
      grp.add(sphere);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(rad+0.10, rad+0.20, 32),
        new THREE.MeshBasicMaterial({ color:hx(C.open), transparent:true, opacity:0.55, side:THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI/2; ring.position.y = -0.22; ring.visible = false;
      grp.add(ring);

      scene.add(grp);
      markerMeshes.push({ id:s.entity_id, floor:s.floor, type:s.type, grp, sphere, drop, ring });
    });

    // Draggable room labels. Empty-text labels appear only in edit mode as
    // ghost placeholders ("tap to name") so unnamed rooms are discoverable.
    const labelMeshes = [];
    (labels ?? []).forEach((l) => {
      const ghost = !l.text;
      const spr = makeLabel(ghost ? "· · name · ·" : l.text, ghost);
      spr.position.set(l.x, l.floor * FLOOR_H + 0.9, l.z);
      spr.userData.labelId = l.id;
      scene.add(spr);
      labelMeshes.push({ id: l.id, floor: l.floor, ghost, spr });
    });

    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    const setPtr = (clientX, clientY) => {
      const r = renderer.domElement.getBoundingClientRect();
      ptr.x = ((clientX - r.left)/r.width)*2 - 1;
      ptr.y = -((clientY - r.top)/r.height)*2 + 1;
      ray.setFromCamera(ptr, cam);
    };
    const hitMarker = () => {
      const spheres = markerMeshes.filter(m=>m.grp.visible).map(m=>m.sphere);
      const hit = ray.intersectObjects(spheres, false)[0];
      return hit ? markerMeshes.find(m => m.sphere === hit.object) : null;
    };
    // Labels are hit-tested in SCREEN space (project the sprite center,
    // compare pixel distance) — deterministic across three.js versions,
    // with touch-friendly padding. Sprite raycasting proved unreliable
    // here: misses sent the pointer through to camera panning, which is
    // exactly the "can't drag labels" symptom.
    const _pv = new THREE.Vector3();
    function hitLabelAt(clientX, clientY) {
      const r = renderer.domElement.getBoundingClientRect();
      const px = clientX - r.left, py = clientY - r.top;
      let best = null, bestD = Infinity;
      labelMeshes.forEach((lm) => {
        if (!lm.spr.visible) return;
        _pv.copy(lm.spr.position).project(cam);
        const sx = (_pv.x + 1) / 2 * r.width;
        const sy = (1 - _pv.y) / 2 * r.height;
        const pxPerWorld = r.width / ((cam.right - cam.left) / cam.zoom);
        const hw = (lm.spr.scale.x / 2) * pxPerWorld + 12;
        const hh = (lm.spr.scale.y / 2) * pxPerWorld + 12;
        const d = Math.hypot(px - sx, py - sy);
        if (Math.abs(px - sx) <= hw && Math.abs(py - sy) <= hh && d < bestD) { best = lm; bestD = d; }
      });
      return best;
    }

    // drag-to-place (edit mode: markers AND labels), drag-to-pan otherwise,
    // pinch-to-zoom with two pointers.
    let dragging = null;        // marker being moved
    let draggingLabel = null;   // label being moved
    let labelMoved = false;     // did the label drag exceed the tap threshold
    let downAt = { x: 0, y: 0 };
    let lastTap = { id: null, t: 0 };  // double-tap rename bookkeeping
    let panning = null;         // {x,y} last pointer for pan
    const dragPlane = new THREE.Plane();
    const dragPoint = new THREE.Vector3();
    const pointers = new Map(); // pointerId -> {x,y} for pinch
    let pinchDist = 0;

    function onPointerDown(e) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        dragging = null; draggingLabel = null; panning = null;
        return;
      }
      setPtr(e.clientX, e.clientY);
      const lm = editRef.current ? hitLabelAt(e.clientX, e.clientY) : null;
      const m = editRef.current && !lm ? hitMarker() : null;
      if (lm) {
        draggingLabel = lm;
        labelMoved = false;
        downAt = { x: e.clientX, y: e.clientY };
        dragPlane.set(new THREE.Vector3(0,1,0), -(lm.floor * FLOOR_H + 0.9));
        renderer.domElement.setPointerCapture(e.pointerId);
        e.preventDefault();
      } else if (m) {
        dragging = m;
        dragPlane.set(new THREE.Vector3(0,1,0), -(m.floor * FLOOR_H + 0.5));
        renderer.domElement.setPointerCapture(e.pointerId);
        e.preventDefault();
      } else {
        panning = { x: e.clientX, y: e.clientY };
        renderer.domElement.setPointerCapture(e.pointerId);
      }
    }
    function onPointerMove(e) {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) setZoom(zoom * (dist / pinchDist), true);
        pinchDist = dist;
        return;
      }
      if (draggingLabel) {
        if (!labelMoved && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) return;
        labelMoved = true;
        setPtr(e.clientX, e.clientY);
        if (ray.ray.intersectPlane(dragPlane, dragPoint)) {
          draggingLabel.spr.position.x = Math.max(-6, Math.min(6, dragPoint.x));
          draggingLabel.spr.position.z = Math.max(-6, Math.min(6, dragPoint.z));
        }
        return;
      }
      if (dragging) {
        setPtr(e.clientX, e.clientY);
        if (ray.ray.intersectPlane(dragPlane, dragPoint)) {
          dragging.grp.position.x = Math.max(-4.4, Math.min(4.4, dragPoint.x));
          dragging.grp.position.z = Math.max(-3.65, Math.min(3.65, dragPoint.z));
        }
        return;
      }
      if (panning) {
        panBy(e.clientX - panning.x, e.clientY - panning.y);
        panning = { x: e.clientX, y: e.clientY };
      }
    }
    function onPointerUp(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (draggingLabel) {
        if (labelMoved) {
          onLabelMoved?.(draggingLabel.id, draggingLabel.spr.position.x, draggingLabel.spr.position.z);
        } else {
          // a tap: second tap on the same label within 400ms renames it
          const now = performance.now();
          if (lastTap.id === draggingLabel.id && now - lastTap.t < 400) {
            lastTap = { id: null, t: 0 };
            onLabelRename?.(draggingLabel.id);
          } else {
            lastTap = { id: draggingLabel.id, t: now };
          }
        }
        draggingLabel = null;
        return;
      }
      if (dragging) {
        onMoved(dragging.id, dragging.grp.position.x, dragging.grp.position.z);
        dragging = null;
        return;
      }
      if (panning) {
        panning = null;
        reportView();
      }
    }
    function onClick(e){
      setPtr(e.clientX, e.clientY);
      if (editRef.current) return; // edit mode: drags, not selection
      const m = hitMarker();
      onPick(m ? m.id : null);
    }
    function onWheel(e) {
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.0012));
    }
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    renderer.domElement.style.touchAction = "none";

    let raf, t = 0;
    function animate() {
      t += 0.05;
      const live = liveStateRef.current;
      const armed = armedRef.current;
      const selected = selectedRef.current;
      const edit = editRef.current;

      floor0.visible = floorView === "all" || floorView === 0;
      floor1.visible = floorView === "all" || floorView === 1;

      labelMeshes.forEach(lm => {
        const floorOk = floorView === "all" || floorView === lm.floor;
        lm.spr.visible = floorOk && (!lm.ghost || edit); // ghosts only while editing
      });

      markerMeshes.forEach(m => {
        const vis = floorView === "all" || floorView === m.floor;
        m.grp.visible = vis;
        if (!vis) return;
        const l = live[m.id];
        const colHex = colorFor(m.type, l, armed);
        const col = hx(colHex);
        const alert = colHex === C.open;

        m.sphere.material.color.copy(col);
        m.sphere.material.emissive.copy(col);
        m.sphere.material.emissiveIntensity = alert ? 1.4 : edit ? 0.9 : 0.5;
        m.drop.material.color.copy(col);

        const pulse = alert ? 1 + Math.sin(t*4)*0.18 : edit ? 1 + Math.sin(t*2)*0.06 : 1;
        m.sphere.scale.setScalar(pulse);

        const showRing = alert || selected === m.id;
        m.ring.visible = showRing;
        if (showRing) m.ring.material.color.copy(col);
      });

      renderer.render(scene, cam);
      raf = requestAnimationFrame(animate);
    }
    animate();

    function onResize() {
      W = mount.clientWidth || W; H = mount.clientHeight || H;
      const a = W / H;
      cam.left = -d*a; cam.right = d*a; cam.top = d; cam.bottom = -d;
      cam.updateProjectionMatrix();
      renderer.setSize(W, H);
    }
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    // Expose zoom controls to the overlay buttons rendered below.
    zoomApi.current = {
      in: () => setZoom(zoom * 1.25),
      out: () => setZoom(zoom / 1.25),
      reset: () => { target.set(0, 1.4, 0); setZoom(narrow ? 1.15 : 1.35, true); reportView(); },
    };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      zoomApi.current = null;
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.dispose();
      if (renderer.domElement.parentNode) mount.removeChild(renderer.domElement);
    };
  }, [floorView, narrow, sensors, plan, labels, liveStateRef, armedRef, selectedRef, editRef, onPick, onMoved, onLabelMoved, onLabelRename, onView, themeTick]);

  const zbtn = {
    width: 40, height: 40, display: "grid", placeItems: "center",
    background: "rgba(15,17,22,0.85)", color: C.text, fontSize: 19, fontWeight: 700,
    border: `1px solid ${C.floorEdge}`, borderRadius: 10, cursor: "pointer",
    touchAction: "manipulation", backdropFilter: "blur(6px)",
  };
  return (
    <div style={{ width:"100%", height:"100%", position:"relative" }}>
      <div ref={mountRef} style={{ width:"100%", height:"100%" }} />
      <div style={{ position:"absolute", right:12, bottom:12, display:"flex", flexDirection:"column", gap:8, zIndex:4 }}>
        <button style={zbtn} aria-label="Zoom in" onClick={() => zoomApi.current?.in()}>+</button>
        <button style={zbtn} aria-label="Zoom out" onClick={() => zoomApi.current?.out()}>−</button>
        <button style={{ ...zbtn, fontSize: 14 }} aria-label="Reset view" onClick={() => zoomApi.current?.reset()}>⤾</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// UI shell
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// 2D top-down floor plan renderer
// Loads the SVG floor plan as a backdrop and places sensor markers by
// their normalized placement coords. Same drag-to-place + onMoved
// persistence as the isometric view, so positions set here save to
// sensor_placements. Ground-floor placements only (floor 0); the plan
// is the first floor.
// ------------------------------------------------------------------
function FloorPlan2D({ sensors, liveState, armed, selected, edit, onPick, onMoved, pendingPlace, onPlaceAt }) {
  const svgRef = useRef();
  const dragging = useRef(null);

  const toPlanPoint = (e) => {
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    // map client px -> viewBox coords (viewBox is PLAN_W x PLAN_H, letterboxed)
    const scale = Math.min(rect.width / PLAN_W, rect.height / PLAN_H);
    const offx = (rect.width - PLAN_W * scale) / 2;
    const offy = (rect.height - PLAN_H * scale) / 2;
    const px = (e.clientX - rect.left - offx) / scale;
    const py = (e.clientY - rect.top - offy) / scale;
    return { px: Math.max(0, Math.min(PLAN_W, px)), py: Math.max(0, Math.min(PLAN_H, py)) };
  };

  const onDown = (e, id) => {
    if (!edit) { onPick(id); return; }
    e.preventDefault();
    dragging.current = id;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging.current) return;
    const { px, py } = toPlanPoint(e);
    const { x, y } = gridFromPlan(px, py);
    onMoved(dragging.current, x, y, /*live*/ true); // live=true: update local only
  };
  const onUp = (e) => {
    if (!dragging.current) return;
    const { px, py } = toPlanPoint(e);
    const { x, y } = gridFromPlan(px, py);
    onMoved(dragging.current, x, y, /*live*/ false); // persist
    dragging.current = null;
  };

  // tap on the plan while a tray sensor is pending -> drop it there
  const onPlanClick = (e) => {
    if (!pendingPlace) return;
    const { px, py } = toPlanPoint(e);
    const { x, y } = gridFromPlan(px, py);
    onPlaceAt(pendingPlace, x, y);
  };

  return (
    <div style={{ width:"100%", height:"100%", display:"grid", placeItems:"center", position:"relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${PLAN_W} ${PLAN_H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width:"100%", height:"100%", touchAction:"none", cursor: pendingPlace ? "crosshair" : "default" }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onClick={onPlanClick}
      >
        {/* floor plan backdrop */}
        <image href={PLAN_URL} x="0" y="0" width={PLAN_W} height={PLAN_H} />

        {pendingPlace && (
          <text x={PLAN_W/2} y={28} fill={C.accent} fontSize="20" textAnchor="middle" fontWeight="700"
                style={{ paintOrder:"stroke", stroke:"#000", strokeWidth:4 }}>
            Tap where “{pendingPlace.label}” goes
          </text>
        )}

        {sensors.filter(s => s.floor === 0).map(s => {
          const { px, py } = planFromGrid(s.x, s.z);
          const live = liveState[s.entity_id];
          const col = colorFor(s.type, live, armed);
          const alert = col === C.open;
          const isSel = selected === s.entity_id;
          return (
            <g key={s.entity_id}
               style={{ cursor: edit ? "grab" : "pointer" }}
               onPointerDown={(e)=>onDown(e, s.entity_id)}>
              {(alert || isSel) && (
                <circle cx={px} cy={py} r={22} fill={col} opacity={alert ? 0.28 : 0.15}>
                  {alert && <animate attributeName="r" values="18;26;18" dur="1.4s" repeatCount="indefinite"/>}
                </circle>
              )}
              <circle cx={px} cy={py} r={12} fill={col} opacity={0.25}/>
              <circle cx={px} cy={py} r={7} fill={col} stroke={isSel ? C.text : "none"} strokeWidth={isSel ? 2 : 0}/>
              {(edit || isSel) && (
                <text x={px} y={py - 16} fill={C.text} fontSize="14" textAnchor="middle"
                      style={{ paintOrder:"stroke", stroke:"#000", strokeWidth:3, pointerEvents:"none" }}>
                  {s.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function SecurityBoard() {
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const apply = () => { C = { ...C, ...webglSurfaces() }; setThemeTick((t) => t + 1); };
    apply();
    window.addEventListener("hh-theme", apply);
    return () => window.removeEventListener("hh-theme", apply);
  }, []);

  const { entities, linkUp, bridgeUp } = useHomeHub();
  const [viewMode, setViewMode] = useState("iso"); // "iso" | "plan"
  const [placements, setPlacements] = useState(null); // null = loading
  const [floorView, setFloorView] = useState("all");
  const [selected, setSelected] = useState(null);
  const [edit, setEdit] = useState(false);
  const [pendingPlace, setPendingPlace] = useState(null); // {entity_id,label,type} awaiting a tap on the plan
  const [saveNote, setSaveNote] = useState("");
  const narrow = useIsNarrow();

  // load placements (no auto-seed: real sensors get placed via the tray)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/placements`);
        const rows = res.ok ? await res.json() : [];
        if (!cancelled) setPlacements(rows);
      } catch {
        if (!cancelled) setPlacements([]); // offline: empty, tray will populate from entities
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // load the ground-floor 3D geometry (static asset from the Sweet Home 3D
  // pipeline). null -> ThreeScene falls back to the generic demo geometry.
  const [plan, setPlan] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(PLAN_JSON_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => { if (!cancelled && p?.walls && p?.rooms && p?.viewbox) setPlan(p); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // --- room labels + camera view: server-persisted board state ------------
  // One layout row (panel_key "securityboard") holds {labels, view}.
  // localStorage mirrors it for instant paint / offline. Label defaults
  // come from the plan's rooms (floor 0) and the generic ROOMS (floor 1);
  // overrides are keyed by label id so regenerating the plan JSON keeps
  // your names and positions.
  const LS_KEY = "hh_securityboard_state";
  const [boardState, setBoardState] = useState(() => {
    if (typeof window === "undefined") return { labels: {}, view: null };
    try { return JSON.parse(localStorage.getItem(LS_KEY)) ?? { labels: {}, view: null }; }
    catch { return { labels: {}, view: null }; }
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/layouts/securityboard`, { credentials: "include" });
        if (res.ok) {
          const row = await res.json();
          const parsed = JSON.parse(row.layout_json || "{}");
          if (!cancelled && (parsed.labels || parsed.view)) {
            setBoardState({ labels: parsed.labels ?? {}, view: parsed.view ?? null });
          }
        }
      } catch { /* offline: localStorage state stands */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const saveTimer = useRef(null);
  const persistBoard = useCallback((next) => {
    setBoardState(next);
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch(`${API_URL}/api/layouts/securityboard`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout_json: JSON.stringify(next) }),
      }).catch(() => {});
    }, 600);
  }, []);

  // default label set: plan rooms at their centers + generic upstairs
  const labels = useMemo(() => {
    const defaults = [];
    if (plan) {
      plan.rooms.forEach((r) => {
        const rr = gridRect(r);
        defaults.push({ id: r.id, text: r.label || "", floor: 0, x: rr.cx, z: rr.cz });
      });
    } else {
      ROOMS[0].forEach(([cx, cz, , , label], i) => defaults.push({ id: `gen0_${i}`, text: label, floor: 0, x: cx, z: cz }));
    }
    ROOMS[1].forEach(([cx, cz, , , label], i) => defaults.push({ id: `gen1_${i}`, text: label, floor: 1, x: cx, z: cz }));
    return defaults.map((d) => ({ ...d, ...(boardState.labels?.[d.id] ?? {}) }));
  }, [plan, boardState.labels]);

  // Callbacks read live state through refs and keep a stable identity, so
  // camera saves (frequent) never retrigger the ThreeScene build effect.
  const boardStateRef = useRef(boardState);
  boardStateRef.current = boardState;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const onLabelMoved = useCallback((id, x, z) => {
    const bs = boardStateRef.current;
    const cur = labelsRef.current.find((l) => l.id === id);
    persistBoard({
      ...bs,
      labels: { ...bs.labels, [id]: { ...(bs.labels?.[id] ?? {}), text: cur?.text ?? "", x, z } },
    });
  }, [persistBoard]);

  const onLabelRename = useCallback((id) => {
    const bs = boardStateRef.current;
    const cur = labelsRef.current.find((l) => l.id === id);
    const text = window.prompt("Room name (blank to hide):", cur?.text ?? "");
    if (text === null) return;
    persistBoard({
      ...bs,
      labels: { ...bs.labels, [id]: { ...(bs.labels?.[id] ?? {}), text: text.trim(), x: cur?.x, z: cur?.z } },
    });
  }, [persistBoard]);

  const onView = useCallback((view) => {
    persistBoard({ ...boardStateRef.current, view });
  }, [persistBoard]);

  // security-relevant HA entities that could go on the board
  const isSecuritySensor = (e) => {
    if (e.domain === "binary_sensor") {
      const dc = String(e.attributes?.device_class ?? "");
      return ["door","window","motion","occupancy","moisture","smoke","gas","carbon_monoxide","vibration","tamper"].includes(dc) || dc === "";
    }
    if (e.domain === "lock") return true;
    return false;
  };

  // placed entity ids
  const placedIds = useMemo(
    () => new Set((placements ?? []).map(p => p.entity_id)),
    [placements]
  );

  // sensors HA reports that have no placement yet -> the tray
  const unplaced = useMemo(() => {
    const out = [];
    for (const e of entities.values()) {
      if (isSecuritySensor(e) && !placedIds.has(e.entity_id)) {
        out.push({ entity_id: e.entity_id, label: e.friendly_name || e.entity_id, type: typeFor(e) });
      }
    }
    out.sort((a,b) => a.label.localeCompare(b.label));
    return out;
  }, [entities, placedIds]);

  // create a placement for a tray sensor at a given plan position
  const placeSensor = useCallback((entityId, x, y, floor = 0) => {
    const e = entities.get(entityId);
    const row = { entity_id: entityId, room: "", floor, x, y, icon: null };
    setPlacements(prev => [...(prev ?? []), row]);
    fetch(`${API_URL}/api/placements/${entityId}`, {
      method:"PUT", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(row),
    })
      .then(r => setSaveNote(r.ok ? `Placed ${e?.friendly_name ?? entityId}` : "Place failed"))
      .catch(() => setSaveNote("Place failed — offline?"));
    setTimeout(() => setSaveNote(""), 2500);
  }, [entities]);

  // remove a placement (send sensor back to the tray)
  const unplaceSensor = useCallback((entityId) => {
    setPlacements(prev => (prev ?? []).filter(p => p.entity_id !== entityId));
    fetch(`${API_URL}/api/placements/${entityId}`, { method:"DELETE" }).catch(() => {});
    setSelected(null);
  }, []);

  // join placements with live entities: board model
  const sensors = useMemo(() => {
    if (!placements) return [];
    return placements.map(p => {
      const e = entities.get(p.entity_id);
      return {
        entity_id: p.entity_id,
        floor: p.floor,
        x: p.x,
        z: p.y, // placement y == plan depth == scene z
        type: typeFor(e),
        label: labelFor(e, p),
        room: p.room,
      };
    });
  }, [placements, entities]);

  const liveState = useMemo(() => {
    const s = {};
    sensors.forEach(x => { s[x.entity_id] = liveFor(x.type, entities.get(x.entity_id)); });
    return s;
  }, [sensors, entities]);

  const alarm = entities.get("alarm_control_panel.homehub");
  const alarmState = alarm ? alarm.state : "unknown"; // disarmed|arming|armed_away|armed_home|pending|triggered
  const armed = alarm ? alarm.state.startsWith("armed") : false;

  // Command feedback: when the user presses arm/disarm we record what we
  // asked for; it clears once HA's echoed state matches (or after a timeout).
  // This is what gives the button a visible acknowledgment.
  const [command, setCommand] = useState(null); // "arm" | "disarm" | null
  useEffect(() => {
    if (!command) return;
    const settled =
      (command === "arm" && (alarmState.startsWith("armed") || alarmState === "arming" || alarmState === "pending")) ||
      (command === "disarm" && alarmState === "disarmed");
    if (settled) setCommand(null);
    const t = setTimeout(() => setCommand(null), 8000); // failsafe: never stick
    return () => clearTimeout(t);
  }, [command, alarmState]);

  const liveStateRef = useRef(liveState);
  const armedRef = useRef(armed);
  const selectedRef = useRef(selected);
  const editRef = useRef(edit);
  useEffect(()=>{ liveStateRef.current = liveState; }, [liveState]);
  useEffect(()=>{ armedRef.current = armed; }, [armed]);
  useEffect(()=>{ selectedRef.current = selected; }, [selected]);
  useEffect(()=>{ editRef.current = edit; }, [edit]);

  const setArm = async (wantArmed) => {
    if (!alarm) return;
    setCommand(wantArmed ? "arm" : "disarm"); // instant visual ack
    try {
      await callService("alarm_control_panel", wantArmed ? "alarm_arm_away" : "alarm_disarm", alarm.entity_id);
    } catch (e) {
      console.error(e);
      setCommand(null); // failed: drop the pending state
    }
  };

  // marker drag → update local always; persist only on drop (live === false).
  // The isometric ThreeScene calls onMoved(id, x, z) with 3 args (persist);
  // the 2D view calls with a 4th `live` flag to stream during drag.
  const onMoved = useCallback((entityId, x, z, live = false) => {
    setPlacements(prev => prev?.map(p => p.entity_id === entityId ? { ...p, x, y: z } : p) ?? prev);
    if (live) return; // mid-drag: update local only, don't hit the API on every frame
    const p = placements?.find(q => q.entity_id === entityId);
    fetch(`${API_URL}/api/placements/${entityId}`, {
      method:"PUT", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ entity_id: entityId, room: p?.room ?? "", floor: p?.floor ?? 0, x, y: z, icon: p?.icon ?? null }),
    })
      .then(r => setSaveNote(r.ok ? "Position saved" : "Save failed"))
      .catch(() => setSaveNote("Save failed — offline?"));
    setTimeout(() => setSaveNote(""), 2500);
  }, [placements]);

  const summary = useMemo(() => {
    let open=0, motion=0, low=0, off=0;
    sensors.forEach(s=>{
      const l = liveState[s.entity_id];
      if (!l) { off++; return; }
      if (l.state==="open"||l.state==="triggered") open++;
      if (l.state==="motion") motion++;
      if (l.battery<=15) low++;
    });
    return { open, motion, low, off };
  }, [sensors, liveState]);

  const allSecure = summary.open===0 && summary.off===0;
  const sel = selected ? sensors.find(s=>s.entity_id===selected) : null;
  const selLive = sel ? liveState[sel.entity_id] : null;

  const floorToggle = (
    <div style={{display:"flex", gap:6}}>
      {viewMode === "iso" && [["all","All"],[1,"Upstairs"],[0,"Ground"]].map(([v,l])=>(
        <button key={String(v)} onClick={()=>setFloorView(v)} style={{
          background: floorView===v ? C.floorEdge : "rgba(20,23,31,0.7)",
          color: floorView===v ? C.text : C.sub,
          border:`1px solid ${C.floorEdge}`, borderRadius:8,
          padding:"7px 14px", fontSize:12, cursor:"pointer", fontWeight:600,
          backdropFilter:"blur(6px)",
        }}>{l}</button>
      ))}
    </div>
  );

  const viewToggle = (
    <div style={{display:"flex", gap:6, background:"rgba(20,23,31,0.7)", borderRadius:9, padding:3, backdropFilter:"blur(6px)"}}>
      {[["plan","Floor plan"],["iso","3D"]].map(([v,l])=>(
        <button key={v} onClick={()=>{ setViewMode(v); setSelected(null); }} style={{
          background: viewMode===v ? C.accent : "transparent",
          color: viewMode===v ? "#0f1116" : C.sub,
          border:"none", borderRadius:7, padding:"6px 13px", fontSize:12,
          cursor:"pointer", fontWeight:700,
        }}>{l}</button>
      ))}
    </div>
  );

  const legend = (
    <div style={{display:"flex", flexWrap:"wrap", gap:"6px 14px",
      background:"rgba(20,23,31,0.7)", padding:"10px 12px", borderRadius:10, backdropFilter:"blur(6px)"}}>
      {[[C.secure,"Secure"],[C.open,"Open / Triggered"],[C.motion,"Motion"],[C.lowbat,"Low battery"],[C.offline,"Offline"]].map(([c,l])=>(
        <div key={l} style={{display:"flex", alignItems:"center", gap:8, fontSize:11, color:C.sub}}>
          <span style={{width:9,height:9,borderRadius:9,background:c, boxShadow:`0 0 8px ${c}`}}/>{l}
        </div>
      ))}
    </div>
  );

  const stats = (
    <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
      <Stat n={summary.open}   l="Open"        tone={summary.open?C.open:C.sub}/>
      <Stat n={summary.motion} l="Motion"      tone={summary.motion?C.motion:C.sub}/>
      <Stat n={summary.low}    l="Low battery" tone={summary.low?C.lowbat:C.sub}/>
      <Stat n={summary.off}    l="Offline"     tone={summary.off?C.offline:C.sub}/>
    </div>
  );

  const detail = sel ? (
    <div>
      <div style={{fontSize:11, color:C.sub, textTransform:"uppercase", letterSpacing:1}}>
        {TYPE_LABEL[sel.type]} · {sel.floor?"Upstairs":"Ground"}{sel.room ? ` · ${sel.room}` : ""}
      </div>
      <div style={{fontSize:18, fontWeight:700, margin:"4px 0 10px"}}>{sel.label}</div>
      <Row k="State" v={selLive ? selLive.state : "offline"} vc={colorFor(sel.type, selLive, armed)}/>
      <Row k="Battery" v={selLive ? `${selLive.battery}%` : "—"} vc={selLive && selLive.battery<=15?C.lowbat:C.text}/>
      <Row k="Entity" v={sel.entity_id} small/>
      <Row k="Last changed" v={selLive ? relTime(selLive.lastChanged) : "—"}/>
      {edit && (
        <button onClick={()=>unplaceSensor(sel.entity_id)} style={{ marginTop:10, background:"transparent",
          color:C.open, border:`1px solid ${C.open}55`, borderRadius:8, padding:"9px 0",
          width:"100%", cursor:"pointer", fontSize:12 }}>Remove from plan (back to tray)</button>
      )}
      <button onClick={()=>setSelected(null)} style={{ marginTop:8, background:"transparent",
        color:C.sub, border:`1px solid ${C.floorEdge}`, borderRadius:8, padding:"9px 0",
        width:"100%", cursor:"pointer", fontSize:12 }}>Clear selection</button>
    </div>
  ) : (
    <div style={{color:C.sub, fontSize:13, lineHeight:1.6}}>
      {edit
        ? "Drag any marker to reposition it. Positions save to the server as you drop them."
        : "Tap a sensor to inspect it. Markers stream live state — armed mode escalates motion to an alert."}
    </div>
  );

  const header = (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
      padding:"14px 18px", borderBottom:`1px solid ${C.floorEdge}`, flexShrink:0, gap:10 }}>
      <div style={{display:"flex", alignItems:"baseline", gap:12, minWidth:0}}>
        <span style={{fontWeight:700, letterSpacing:0.3, fontSize:18}}>Perimeter</span>
        <span style={{ fontSize:12, color: allSecure?C.secure:C.open, fontWeight:600,
          textTransform:"uppercase", letterSpacing:1.2, whiteSpace:"nowrap" }}>
          {allSecure ? "All Secure" : summary.open ? `${summary.open} Open` : `${summary.off} Offline`}
        </span>
        {(!linkUp || !bridgeUp) && (
          <span style={{fontSize:11, color:C.open, whiteSpace:"nowrap"}}>
            {linkUp ? "HA bridge down" : "backend offline"}
          </span>
        )}
        {saveNote && <span style={{fontSize:11, color:C.accent, whiteSpace:"nowrap"}}>{saveNote}</span>}
        <AlarmStatus state={alarmState} command={command}/>
      </div>
      <div style={{display:"flex", gap:8}}>
        <Pill active={edit} onClick={()=>{ setEdit(e=>!e); setSelected(null); }} label={edit?"Done":"Edit"} tone={C.accent}/>
        <Pill active={armed} busy={command==="arm"} onClick={()=>setArm(true)}  label={command==="arm" ? "Arming…" : "Arm"} tone={C.open}/>
        <Pill active={!armed && alarmState==="disarmed"} busy={command==="disarm"} onClick={()=>setArm(false)} label={command==="disarm" ? "Disarming…" : "Disarm"} tone={C.secure}/>
      </div>
    </div>
  );

  const shell = {
    fontFamily:"'DM Sans', system-ui, sans-serif",
    background:`radial-gradient(1200px 800px at 70% -10%, ${C.bg1}, ${C.bg0})`,
    color:C.text, height:`calc(100dvh - ${BOTTOM_TABS_HEIGHT}px - env(safe-area-inset-bottom))`, display:"flex", flexDirection:"column", overflow:"hidden",
  };

  const loading = placements === null;
  const scene = loading ? (
    <div style={{display:"grid", placeItems:"center", height:"100%", color:C.sub, fontSize:13}}>
      Loading placements…
    </div>
  ) : viewMode === "plan" ? (
    <FloorPlan2D
      sensors={sensors} liveState={liveState} armed={armed}
      selected={selected} edit={edit} onPick={setSelected} onMoved={onMoved}
      pendingPlace={pendingPlace}
      onPlaceAt={(sensor, x, y) => { placeSensor(sensor.entity_id, x, y, 0); setPendingPlace(null); }}
    />
  ) : (
    <ThreeScene
      sensors={sensors} plan={plan} labels={labels} view={boardState.view}
      liveStateRef={liveStateRef} armedRef={armedRef} selectedRef={selectedRef} editRef={editRef}
      floorView={floorView} onPick={setSelected} onMoved={onMoved}
      onLabelMoved={onLabelMoved} onLabelRename={onLabelRename} onView={onView} narrow={narrow}
    />
  );

  // Placement tray: unplaced sensors, shown in edit mode on the 2D plan.
  // Tap one to arm it, then tap the plan to drop it. Works on touch.
  const tray = edit && viewMode === "plan" ? (
    <div style={{
      position:"absolute", right:12, top:12, width:210, maxHeight:"70%", overflowY:"auto",
      background:"rgba(15,17,22,0.92)", border:`1px solid ${C.floorEdge}`, borderRadius:12,
      padding:12, backdropFilter:"blur(8px)", zIndex:5,
    }}>
      <div style={{fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:1, color:C.sub, marginBottom:8}}>
        Unplaced sensors {unplaced.length ? `(${unplaced.length})` : ""}
      </div>
      {unplaced.length === 0 && (
        <div style={{fontSize:12, color:C.sub, lineHeight:1.5}}>
          All paired sensors are placed. Pair a sensor in Home Assistant and it appears here.
        </div>
      )}
      {unplaced.map(s => {
        const c = { contact:C.secure, motion:C.motion, leak:C.accent, smoke:C.open }[s.type] || C.sub;
        const armedForPlace = pendingPlace?.entity_id === s.entity_id;
        return (
          <button key={s.entity_id}
            onClick={() => setPendingPlace(armedForPlace ? null : s)}
            style={{
              display:"flex", alignItems:"center", gap:8, width:"100%", textAlign:"left",
              background: armedForPlace ? C.accent : "rgba(255,255,255,0.03)",
              color: armedForPlace ? "#0f1116" : C.text,
              border:`1px solid ${armedForPlace ? C.accent : C.floorEdge}`, borderRadius:9,
              padding:"8px 10px", marginBottom:6, cursor:"pointer", fontSize:12,
            }}>
            <span style={{width:9, height:9, borderRadius:9, background:c, flexShrink:0, boxShadow:`0 0 6px ${c}`}}/>
            <span style={{overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{s.label}</span>
          </button>
        );
      })}
      {pendingPlace && (
        <div style={{fontSize:11, color:C.accent, marginTop:4}}>Tap the plan to place, or tap again to cancel.</div>
      )}
    </div>
  ) : null;

  // ---------------- MOBILE: stacked, scrollable ----------------
  if (narrow) {
    return (
      <div style={shell}>
        {header}
        <div style={{flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch"}}>
          <div style={{position:"relative", height:"46vh", minHeight:280}}>
            {scene}
          {tray}
            {tray}
            <div style={{position:"absolute", left:12, top:12}}>{viewToggle}</div>
            <div style={{position:"absolute", left:12, bottom:12}}>{floorToggle}</div>
          </div>
          <div style={{padding:"16px 16px 24px", display:"flex", flexDirection:"column", gap:14}}>
            {legend}
            {stats}
            <div style={{height:1, background:C.floorEdge}}/>
            {detail}
          </div>
        </div>
      </div>
    );
  }

  // ---------------- WIDE: side-by-side kitchen panel ----------------
  return (
    <div style={shell}>
      {header}
      <div style={{flex:1, display:"flex", minHeight:0}}>
        <div style={{flex:1, position:"relative", minWidth:0}}>
          {scene}
          <div style={{position:"absolute", left:16, top:16}}>{viewToggle}</div>
          <div style={{position:"absolute", left:16, bottom:16}}>{floorToggle}</div>
          <div style={{position:"absolute", right:16, top:16, maxWidth:200}}>{legend}</div>
        </div>
        <div style={{ width:300, borderLeft:`1px solid ${C.floorEdge}`, padding:18,
          display:"flex", flexDirection:"column", gap:14, background:"rgba(15,17,22,0.5)", overflowY:"auto" }}>
          {stats}
          <div style={{height:1, background:C.floorEdge}}/>
          {detail}
          <div style={{flex:1}}/>
        </div>
      </div>
    </div>
  );
}

function Pill({active,onClick,label,tone,busy}) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onClick={onClick}
      onPointerDown={()=>setPressed(true)}
      onPointerUp={()=>setPressed(false)}
      onPointerLeave={()=>setPressed(false)}
      disabled={busy}
      style={{
        display:"flex", alignItems:"center", gap:7,
        background: busy ? tone : active ? tone : "transparent",
        color: (active||busy) ? "#0f1116" : C.sub,
        border:`1px solid ${(active||busy)?tone:C.floorEdge}`, borderRadius:20, padding:"7px 16px",
        fontSize:12, fontWeight:700, cursor: busy ? "default" : "pointer",
        transform: pressed ? "scale(0.94)" : "scale(1)",
        opacity: busy ? 0.85 : 1,
        transition:"transform .08s, background .15s, color .15s, border-color .15s",
        boxShadow: pressed ? `0 0 0 3px ${tone}55` : "none",
      }}>
      {busy && (
        <span style={{
          width:11, height:11, border:`2px solid #0f1116`, borderTopColor:"transparent",
          borderRadius:"50%", display:"inline-block", animation:"hh-spin .7s linear infinite",
        }}/>
      )}
      {label}
    </button>
  );
}

// live alarm-state badge: shows exactly what HA reports, color-coded
function AlarmStatus({ state, command }) {
  const map = {
    disarmed:   [C.secure, "Disarmed"],
    arming:     [C.motion, "Arming…"],
    pending:    [C.motion, "Entry delay"],
    armed_away: [C.open,   "Armed · Away"],
    armed_home: [C.open,   "Armed · Home"],
    triggered:  [C.open,   "⚠ TRIGGERED"],
    unknown:    [C.sub,    "—"],
  };
  const [color, text] = map[state] || [C.sub, state];
  const pulse = state === "triggered" || state === "pending" || state === "arming" || !!command;
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:6, fontSize:11, fontWeight:700,
      color, whiteSpace:"nowrap", padding:"3px 9px", borderRadius:20,
      border:`1px solid ${color}55`, background:`${color}15`,
    }}>
      <span style={{ width:7, height:7, borderRadius:7, background:color,
        boxShadow:`0 0 8px ${color}`,
        animation: pulse ? "hh-blink 1s ease-in-out infinite" : "none" }}/>
      {text}
    </span>
  );
}

function Stat({n,l,tone}) {
  return (
    <div style={{background:"rgba(255,255,255,0.03)", borderRadius:10, padding:"12px 14px"}}>
      <div style={{fontSize:26, fontWeight:800, color:tone, lineHeight:1}}>{n}</div>
      <div style={{fontSize:11, color:C.sub, marginTop:3}}>{l}</div>
    </div>
  );
}
function Row({k,v,vc,small}) {
  return (
    <div style={{display:"flex", justifyContent:"space-between", padding:"6px 0", fontSize:small?11:13, gap:8}}>
      <span style={{color:C.sub, flexShrink:0}}>{k}</span>
      <span style={{color:vc||C.text, fontWeight:600, fontFamily: small?"monospace":"inherit",
        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{v}</span>
    </div>
  );
}
