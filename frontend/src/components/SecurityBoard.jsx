"use client";

import React, { useRef, useState, useMemo, useEffect, useCallback } from "react";
import * as THREE from "three";
import { API_URL, callService } from "@/lib/api";
import { useHomeHub } from "@/lib/useHomeHub";

/* ------------------------------------------------------------------ *
 * Security Board — isometric 2.5D, live.
 * Ported from the Vite prototype. Data plumbing now real:
 *   - marker positions come from /api/placements (Postgres); first run
 *     seeds sensible defaults for the demo floor plan
 *   - sensor type derives from HA device_class, label from friendly_name
 *   - live state + armed come from useHomeHub; arm/disarm via services
 *   - Edit mode: drag markers on the floor plane, positions save back
 * Floor-plan geometry stays static until the Sweet Home 3D pipeline
 * replaces it; placements are already the coordinate source of truth.
 * ------------------------------------------------------------------ */

const C = {
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

// First-run defaults, keyed by real backend entity ids. Written to
// /api/placements once if the table is empty, then Postgres owns them.
const DEFAULT_PLACEMENTS = [
  { entity_id:"binary_sensor.front_door_contact",      floor:0, x:-2.2, y:-3.4, room:"Living Room" },
  { entity_id:"binary_sensor.basement_window_contact", floor:0, x:-3.6, y:-1.9, room:"Living Room" },
  { entity_id:"binary_sensor.kitchen_window_contact",  floor:0, x: 2.2, y:-1.9, room:"Kitchen" },
  { entity_id:"binary_sensor.back_door_contact",       floor:0, x: 2.2, y: 3.4, room:"Family Room" },
  { entity_id:"binary_sensor.garage_entry_contact",    floor:0, x:-2.6, y: 3.3, room:"Garage" },
  { entity_id:"binary_sensor.basement_motion",         floor:0, x: 1.3, y: 1.9, room:"Family Room" },
  { entity_id:"binary_sensor.driveway_person",         floor:0, x:-1.2, y:-3.4, room:"Living Room" },
  { entity_id:"binary_sensor.water_heater_leak",       floor:0, x:-3.2, y: 1.4, room:"Garage" },
  { entity_id:"binary_sensor.sump_pit_leak",           floor:0, x:-1.7, y: 1.4, room:"Garage" },
  { entity_id:"binary_sensor.hallway_motion",          floor:1, x: 1.3, y: 1.9, room:"Landing / Hall" },
  { entity_id:"binary_sensor.laundry_leak",            floor:1, x:-2.4, y: 1.9, room:"Bath" },
  { entity_id:"binary_sensor.smoke_co_bridge",         floor:1, x: 2.2, y:-1.9, room:"Bedroom 2" },
];

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
function ThreeScene({ sensors, liveStateRef, armedRef, selectedRef, editRef, floorView, onPick, onMoved, narrow }) {
  const mountRef = useRef();

  useEffect(() => {
    const mount = mountRef.current;
    let W = mount.clientWidth || 400, H = mount.clientHeight || 300;

    const scene = new THREE.Scene();
    const d = narrow ? 6.5 : 8;
    const aspect = W / H;
    const cam = new THREE.OrthographicCamera(-d*aspect, d*aspect, d, -d, 0.1, 100);
    cam.position.set(11, 12, 11);
    cam.lookAt(0, 1.4, 0);

    const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(W, H);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.8); key.position.set(8,14,6); scene.add(key);
    const fill = new THREE.DirectionalLight(0x6b7ce0, 0.25); fill.position.set(-6,8,-4); scene.add(fill);

    function makeLabel(text) {
      const cv = document.createElement("canvas");
      const dpr = 2; cv.width = 256*dpr; cv.height = 64*dpr;
      const ctx = cv.getContext("2d");
      ctx.scale(dpr,dpr);
      ctx.font = "600 22px 'DM Sans', system-ui, sans-serif";
      ctx.fillStyle = "rgba(232,235,242,0.92)";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 6;
      ctx.fillText(text, 128, 32);
      const tex = new THREE.CanvasTexture(cv);
      tex.minFilter = THREE.LinearFilter;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map:tex, transparent:true, depthTest:false }));
      spr.scale.set(2.2, 0.55, 1);
      return spr;
    }

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

      ROOMS[floorIdx].forEach(([cx,cz,,,label])=>{
        const spr = makeLabel(label);
        spr.position.set(cx, y+0.9, cz);
        g.add(spr);
      });
      return g;
    }
    const floor0 = buildFloor(0, 0);
    const floor1 = buildFloor(FLOOR_H, 1);
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

    // drag-to-place (edit mode)
    let dragging = null;
    const dragPlane = new THREE.Plane();
    const dragPoint = new THREE.Vector3();

    function onPointerDown(e) {
      setPtr(e.clientX, e.clientY);
      const m = hitMarker();
      if (editRef.current && m) {
        dragging = m;
        dragPlane.set(new THREE.Vector3(0,1,0), -(m.floor * FLOOR_H + 0.5));
        renderer.domElement.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    }
    function onPointerMove(e) {
      if (!dragging) return;
      setPtr(e.clientX, e.clientY);
      if (ray.ray.intersectPlane(dragPlane, dragPoint)) {
        dragging.grp.position.x = Math.max(-4.4, Math.min(4.4, dragPoint.x));
        dragging.grp.position.z = Math.max(-3.65, Math.min(3.65, dragPoint.z));
      }
    }
    function onPointerUp() {
      if (!dragging) return;
      onMoved(dragging.id, dragging.grp.position.x, dragging.grp.position.z);
      dragging = null;
    }
    function onClick(e){
      if (editRef.current) return; // edit mode: drags, not selection
      setPtr(e.clientX, e.clientY);
      const m = hitMarker();
      onPick(m ? m.id : null);
    }
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("click", onClick);

    let raf, t = 0;
    function animate() {
      t += 0.05;
      const live = liveStateRef.current;
      const armed = armedRef.current;
      const selected = selectedRef.current;
      const edit = editRef.current;

      floor0.visible = floorView === "all" || floorView === 0;
      floor1.visible = floorView === "all" || floorView === 1;

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

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.dispose();
      if (renderer.domElement.parentNode) mount.removeChild(renderer.domElement);
    };
  }, [floorView, narrow, sensors, liveStateRef, armedRef, selectedRef, editRef, onPick, onMoved]);

  return <div ref={mountRef} style={{ width:"100%", height:"100%" }} />;
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
const PLAN_URL = "/floorplans/first_floor.svg";
// The plan's SVG viewBox (from the converter): 0..1000 x 0..885.5
const PLAN_W = 1000, PLAN_H = 885.5;

// placement coords live in the isometric grid space (-4..4 x, -3.75..3.75 y).
// Map that onto the plan's pixel space for display, and invert on drag.
function planFromGrid(x, y) {
  return { px: ((x + 4) / 8) * PLAN_W, py: ((y + 3.75) / 7.5) * PLAN_H };
}
function gridFromPlan(px, py) {
  return { x: (px / PLAN_W) * 8 - 4, y: (py / PLAN_H) * 7.5 - 3.75 };
}

function FloorPlan2D({ sensors, liveState, armed, selected, edit, onPick, onMoved }) {
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

  return (
    <div style={{ width:"100%", height:"100%", display:"grid", placeItems:"center", position:"relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${PLAN_W} ${PLAN_H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width:"100%", height:"100%", touchAction:"none" }}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {/* floor plan backdrop */}
        <image href={PLAN_URL} x="0" y="0" width={PLAN_W} height={PLAN_H} />

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
  const { entities, linkUp, bridgeUp } = useHomeHub();
  const [viewMode, setViewMode] = useState("iso"); // "iso" | "plan"
  const [placements, setPlacements] = useState(null); // null = loading
  const [floorView, setFloorView] = useState("all");
  const [selected, setSelected] = useState(null);
  const [edit, setEdit] = useState(false);
  const [saveNote, setSaveNote] = useState("");
  const narrow = useIsNarrow();

  // load placements; seed defaults on first run
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/placements`);
        const rows = res.ok ? await res.json() : [];
        if (cancelled) return;
        if (rows.length > 0) { setPlacements(rows); return; }
        // empty table: seed the defaults so edit mode has rows to move
        for (const p of DEFAULT_PLACEMENTS) {
          await fetch(`${API_URL}/api/placements/${p.entity_id}`, {
            method:"PUT", headers:{ "Content-Type":"application/json" },
            body: JSON.stringify(p),
          }).catch(() => {});
        }
        if (!cancelled) setPlacements(DEFAULT_PLACEMENTS.map(p => ({ ...p, icon:null })));
      } catch {
        if (!cancelled) setPlacements(DEFAULT_PLACEMENTS.map(p => ({ ...p, icon:null }))); // offline fallback
      }
    })();
    return () => { cancelled = true; };
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
  const armed = alarm ? alarm.state.startsWith("armed") : false;

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
    try {
      await callService("alarm_control_panel", wantArmed ? "alarm_arm_away" : "alarm_disarm", alarm.entity_id);
    } catch (e) { console.error(e); }
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
      <button onClick={()=>setSelected(null)} style={{ marginTop:12, background:"transparent",
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
      </div>
      <div style={{display:"flex", gap:8}}>
        <Pill active={edit} onClick={()=>{ setEdit(e=>!e); setSelected(null); }} label={edit?"Done":"Edit"} tone={C.accent}/>
        <Pill active={armed} onClick={()=>setArm(true)}  label="Armed" tone={C.open}/>
        <Pill active={!armed} onClick={()=>setArm(false)} label="Disarmed" tone={C.secure}/>
      </div>
    </div>
  );

  const shell = {
    fontFamily:"'DM Sans', system-ui, sans-serif",
    background:`radial-gradient(1200px 800px at 70% -10%, ${C.bg1}, ${C.bg0})`,
    color:C.text, height:"100dvh", display:"flex", flexDirection:"column", overflow:"hidden",
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
    />
  ) : (
    <ThreeScene
      sensors={sensors}
      liveStateRef={liveStateRef} armedRef={armedRef} selectedRef={selectedRef} editRef={editRef}
      floorView={floorView} onPick={setSelected} onMoved={onMoved} narrow={narrow}
    />
  );

  // ---------------- MOBILE: stacked, scrollable ----------------
  if (narrow) {
    return (
      <div style={shell}>
        {header}
        <div style={{flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch"}}>
          <div style={{position:"relative", height:"46vh", minHeight:280}}>
            {scene}
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

function Pill({active,onClick,label,tone}) {
  return (
    <button onClick={onClick} style={{
      background: active ? tone : "transparent", color: active ? "#0f1116" : C.sub,
      border:`1px solid ${active?tone:C.floorEdge}`, borderRadius:20, padding:"7px 16px",
      fontSize:12, fontWeight:700, cursor:"pointer", transition:"all .15s" }}>{label}</button>
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
