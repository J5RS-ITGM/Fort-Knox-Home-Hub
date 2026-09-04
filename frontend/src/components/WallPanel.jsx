"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  Lock, Unlock, Sun, Cloud, Droplets, CheckSquare, Lightbulb, Zap, Wifi,
  Play, Moon, Radar, X, Settings2, Eye, EyeOff, RotateCcw, Pause,
} from "lucide-react";
import { API_URL, callService } from "@/lib/api";
import AlarmControl from "@/components/AlarmControl";
import { useHomeHub } from "@/lib/useHomeHub";

/* ------------------------------------------------------------------ *
 * Home Hub — WALL PANEL (live)
 * Ported from the Vite prototype. Identical UI; the data plumbing is
 * now real:
 *   - sensors/devices/climate come from useHomeHub (backend WebSocket)
 *   - arm/disarm + device toggles go through the allowlisted service API
 *   - tile layout loads from / saves to /api/layouts/wallpanel
 *     (localStorage kept as instant/offline fallback)
 * Weather, calendar, and tasks tiles remain local placeholders until
 * their modules land (NWS/RainViewer, calendar, Chore Quest API).
 * ------------------------------------------------------------------ */

const C = {
  secure:"#3fb98f", open:"#e0483d", motion:"#f0a838", amber:"#d9a441", offline:"#7a7f8a",
  accent:"#6b8afd", accent2:"#8b6bfd",
  bg0:"#0c0e13", bg1:"#12151f", card:"#171b27", cardHi:"#1f2432",
  edge:"#262c3b", text:"#eef1f6", sub:"#9199a8", subDim:"#5a616f",
  floor:"#1a1f2d", floorEdge:"#2a3042", roomFloor:"#212838", wall:"#323a4e",
};
const hx = (h) => new THREE.Color(h);

// ================= SECURITY BOARD =====================
// Board placements keyed by REAL backend entity_ids. Positions are static
// here for now; next step is loading them from /api/placements so they're
// editable and shared with the full SecurityBoard module.
const SENSORS = [
  { id:"binary_sensor.front_door_contact",     type:"contact", floor:0, room:0, pos:[-2.2,0,-3.4], label:"Front Door" },
  { id:"binary_sensor.basement_window_contact",type:"contact", floor:0, room:0, pos:[-3.6,0,-1.9], label:"Basement Window" },
  { id:"binary_sensor.kitchen_window_contact", type:"contact", floor:0, room:1, pos:[ 2.2,0,-1.9], label:"Kitchen Window" },
  { id:"binary_sensor.back_door_contact",      type:"contact", floor:0, room:3, pos:[ 1.3,0, 3.4], label:"Back Door" },
  { id:"binary_sensor.garage_entry_contact",   type:"contact", floor:0, room:2, pos:[-2.6,0, 3.0], label:"Garage Entry" },
  { id:"binary_sensor.basement_motion",        type:"motion",  floor:0, room:3, pos:[ 0.9,0, 1.6], label:"Basement Motion" },
  { id:"binary_sensor.driveway_person",        type:"motion",  floor:0, room:0, pos:[-1.2,0,-3.4], label:"Driveway Person" },
  { id:"binary_sensor.water_heater_leak",      type:"leak",    floor:0, room:2, pos:[-3.2,0, 1.4], label:"Water Heater" },
  { id:"binary_sensor.sump_pit_leak",          type:"leak",    floor:0, room:2, pos:[-1.6,0, 1.4], label:"Sump Pit" },
  { id:"binary_sensor.hallway_motion",         type:"motion",  floor:1, room:3, pos:[ 1.3,0, 1.9], label:"Hallway Motion" },
  { id:"binary_sensor.laundry_leak",           type:"leak",    floor:1, room:2, pos:[-2.4,0, 1.9], label:"Laundry" },
  { id:"binary_sensor.smoke_co_bridge",        type:"smoke",   floor:1, room:1, pos:[ 2.2,0,-1.9], label:"Smoke/CO" },
];
const ROOMS = {
  0: [[-2.35,-1.95,3.9,3.3,"Living Room"],[2.35,-1.95,3.9,3.3,"Kitchen"],[-2.35,1.95,3.9,3.3,"Garage"],[2.35,1.95,3.9,3.3,"Family Room"]],
  1: [[-2.35,-1.95,3.9,3.3,"Master Bed"],[2.35,-1.95,3.9,3.3,"Bedroom 2"],[-2.35,1.95,3.9,3.3,"Bath"],[2.35,1.95,3.9,3.3,"Landing"]],
};

/** Map a live HA entity onto the board's visual states. */
function boardStateFor(sensor, entity) {
  if (!entity) return undefined; // offline / not yet loaded
  const on = entity.state === "on";
  let state = "secure";
  if (sensor.type === "motion") state = on ? "motion" : "secure";
  else if (sensor.type === "smoke") state = on ? "triggered" : "secure";
  else state = on ? "open" : "secure"; // contact + leak: on == open/WET
  const battery = typeof entity.attributes?.battery === "number" ? entity.attributes.battery : 100;
  return { state, battery };
}

function colorFor(type, live, armed) {
  if (!live) return C.offline;
  if (live.battery <= 15) return C.amber;
  if (live.state === "open" || live.state === "triggered") return C.open;
  if (live.state === "motion") return armed ? C.open : C.motion;
  return C.secure;
}

function Board({ liveStateRef, armedRef, floorView }) {
  const mountRef = useRef();
  useEffect(() => {
    const mount = mountRef.current;
    let W = mount.clientWidth, H = mount.clientHeight;
    if (W === 0 || H === 0) { W = 400; H = 300; }
    const scene = new THREE.Scene();
    const d = 7.2, aspect = W/H;
    const cam = new THREE.OrthographicCamera(-d*aspect, d*aspect, d, -d, 0.1, 100);
    cam.position.set(11,12,11); cam.lookAt(0,1.4,0);
    const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.setSize(W,H); mount.appendChild(renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff,0.6));
    const key = new THREE.DirectionalLight(0xffffff,0.75); key.position.set(8,14,6); scene.add(key);
    const fill = new THREE.DirectionalLight(0x6b7ce0,0.25); fill.position.set(-6,8,-4); scene.add(fill);

    function makeLabel(text) {
      const cv = document.createElement("canvas"); const dpr=2; cv.width=256*dpr; cv.height=64*dpr;
      const ctx = cv.getContext("2d"); ctx.scale(dpr,dpr);
      ctx.font = "600 21px 'DM Sans', system-ui, sans-serif";
      ctx.fillStyle = "rgba(238,241,246,0.82)"; ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.shadowColor="rgba(0,0,0,0.7)"; ctx.shadowBlur=6; ctx.fillText(text,128,32);
      const tex = new THREE.CanvasTexture(cv); tex.minFilter=THREE.LinearFilter;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map:tex, transparent:true, depthTest:false }));
      spr.scale.set(2.1,0.52,1); return spr;
    }
    function buildRoom(cx, cz, w, dp, y, text) {
      const g = new THREE.Group();
      const floorMat = new THREE.MeshStandardMaterial({ color:hx(C.roomFloor), roughness:0.9 });
      const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, dp), floorMat);
      slab.position.set(cx, y, cz); g.add(slab);
      const rim = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.12, dp)),
        new THREE.LineBasicMaterial({ color:hx(C.floorEdge) })
      );
      rim.position.set(cx, y, cz); g.add(rim);
      const wallMat = new THREE.MeshStandardMaterial({ color:hx(C.wall), roughness:1, transparent:true, opacity:0.45 });
      const t = 0.08, wy = y + 0.32;
      const segs = [[cx,cz-dp/2,w,t],[cx,cz+dp/2,w,t],[cx-w/2,cz,t,dp],[cx+w/2,cz,t,dp]];
      segs.forEach(s=>{ const m=new THREE.Mesh(new THREE.BoxGeometry(s[2],0.55,s[3]),wallMat); m.position.set(s[0],wy,s[1]); g.add(m); });
      const spr = makeLabel(text); spr.position.set(cx, y+0.95, cz); g.add(spr);
      return g;
    }
    const floorGroups = { 0:new THREE.Group(), 1:new THREE.Group() };
    [0,1].forEach(fi => {
      const y = fi*2.4;
      ROOMS[fi].forEach(([cx,cz,w,dp,label]) => floorGroups[fi].add(buildRoom(cx,cz,w,dp,y,label)));
      scene.add(floorGroups[fi]);
    });

    const markers = [];
    SENSORS.forEach(s => {
      const y = s.floor*2.4 + 0.55; const grp = new THREE.Group(); grp.position.set(s.pos[0],y,s.pos[2]);
      const drop = new THREE.Mesh(new THREE.CylinderGeometry(0.015,0.015,0.5,6), new THREE.MeshBasicMaterial({ color:hx(C.secure), transparent:true, opacity:0.5 }));
      drop.position.y=-0.25; grp.add(drop);
      const sph = new THREE.Mesh(new THREE.SphereGeometry(0.26,20,20), new THREE.MeshStandardMaterial({ color:hx(C.secure), emissive:hx(C.secure), emissiveIntensity:0.5, roughness:0.3 }));
      grp.add(sph);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.36,0.46,32), new THREE.MeshBasicMaterial({ color:hx(C.open), transparent:true, opacity:0.55, side:THREE.DoubleSide }));
      ring.rotation.x=-Math.PI/2; ring.position.y=-0.22; ring.visible=false; grp.add(ring);
      scene.add(grp); markers.push({ id:s.id, floor:s.floor, type:s.type, grp, sph, drop, ring });
    });

    let raf, t=0;
    function animate() {
      t+=0.05; const live=liveStateRef.current, armed=armedRef.current;
      floorGroups[0].visible = floorView==="all"||floorView===0;
      floorGroups[1].visible = floorView==="all"||floorView===1;
      markers.forEach(m=>{
        const vis = floorView==="all"||floorView===m.floor; m.grp.visible=vis; if(!vis)return;
        const l=live[m.id]; const chex=colorFor(m.type,l,armed); const col=hx(chex); const alert=chex===C.open;
        m.sph.material.color.copy(col); m.sph.material.emissive.copy(col); m.sph.material.emissiveIntensity=alert?1.4:0.5;
        m.drop.material.color.copy(col); m.sph.scale.setScalar(alert?1+Math.sin(t*4)*0.18:1);
        m.ring.visible=alert; if(alert) m.ring.material.color.copy(col);
      });
      renderer.render(scene,cam); raf=requestAnimationFrame(animate);
    }
    animate();
    function onResize(){ W=mount.clientWidth||W; H=mount.clientHeight||H; const a=W/H; cam.left=-d*a; cam.right=d*a; cam.top=d; cam.bottom=-d; cam.updateProjectionMatrix(); renderer.setSize(W,H); }
    const ro=new ResizeObserver(onResize); ro.observe(mount);
    return ()=>{ cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); if(renderer.domElement.parentNode) mount.removeChild(renderer.domElement); };
  }, [floorView, liveStateRef, armedRef]);
  return <div ref={mountRef} style={{ width:"100%", height:"100%" }} />;
}

// ================= RADAR (placeholder until RainViewer module) =====================
const FRAME_COUNT = 13;
function MockRadar({ onClose }) {
  const canvasRef = useRef();
  const [idx, setIdx] = useState(FRAME_COUNT - 4);
  const [playing, setPlaying] = useState(true);

  const cells = useMemo(() => {
    const rng = (s) => { let x = Math.sin(s) * 10000; return x - Math.floor(x); };
    return Array.from({ length: 7 }, (_, i) => ({
      x0: rng(i * 3.1) * 0.5 - 0.1,
      y: 0.2 + rng(i * 7.7) * 0.6,
      r: 40 + rng(i * 2.3) * 90,
      intensity: 0.5 + rng(i * 5.5) * 0.5,
      speed: 0.018 + rng(i * 1.9) * 0.02,
    }));
  }, []);

  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const draw = () => {
      const W = cv.clientWidth, H = cv.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.fillStyle = "#0f1622"; ctx.fillRect(0,0,W,H);
      ctx.strokeStyle = "rgba(107,138,253,0.10)"; ctx.lineWidth = 1;
      for (let gx=0; gx<W; gx+=48){ ctx.beginPath(); ctx.moveTo(gx,0); ctx.lineTo(gx,H); ctx.stroke(); }
      for (let gy=0; gy<H; gy+=48){ ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(W,gy); ctx.stroke(); }
      ctx.strokeStyle = "rgba(145,153,168,0.18)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0,H*0.55); ctx.bezierCurveTo(W*0.3,H*0.5,W*0.6,H*0.62,W,H*0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W*0.5,0); ctx.lineTo(W*0.52,H); ctx.stroke();
      const hx0 = W*0.5, hy0 = H*0.5;
      ctx.fillStyle = "#6b8afd"; ctx.beginPath(); ctx.arc(hx0,hy0,5,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle = "rgba(107,138,253,0.5)"; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(hx0,hy0,14,0,Math.PI*2); ctx.stroke();

      const grad = (r,g,b,a)=>`rgba(${r},${g},${b},${a})`;
      cells.forEach(c => {
        const cx = (c.x0 + c.speed * idx) * W;
        const cy = c.y * H + Math.sin(idx*0.3 + c.y*6)*10;
        if (cx < -c.r || cx > W + c.r) return;
        const layers = [
          [70,130,255,0.28, 1.0],
          [60,200,140,0.34, 0.72],
          [240,200,70,0.40, 0.46],
          [224,72,61,0.46, 0.24],
        ];
        layers.forEach(([r,g,b,a,scale]) => {
          const rad = c.r * scale * c.intensity;
          const rg = ctx.createRadialGradient(cx,cy,0,cx,cy,rad);
          rg.addColorStop(0, grad(r,g,b,a));
          rg.addColorStop(1, grad(r,g,b,0));
          ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(cx,cy,rad,0,Math.PI*2); ctx.fill();
        });
      });
    };
    draw();
    const ro = new ResizeObserver(draw); ro.observe(cv);
    return () => ro.disconnect();
  }, [idx, cells]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setIdx(i => (i + 1) % FRAME_COUNT), 550);
    return () => clearInterval(t);
  }, [playing]);

  const minsAgo = (FRAME_COUNT - 1 - idx) * 5;
  const stamp = idx >= FRAME_COUNT - 3
    ? (idx === FRAME_COUNT - 3 ? "now" : `+${(idx-(FRAME_COUNT-3))*5} min`)
    : `${minsAgo} min ago`;
  const isForecast = idx >= FRAME_COUNT - 2;

  return (
    <div style={{ position:"fixed", inset:0, zIndex:1000, background:C.bg0, display:"flex", flexDirection:"column" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 20px", borderBottom:`1px solid ${C.edge}` }}>
        <div style={{display:"flex", alignItems:"center", gap:12}}>
          <Radar size={22} color={C.accent}/>
          <span style={{fontSize:20, fontWeight:800}}>Weather Radar</span>
          <span style={{fontSize:13, color: isForecast?C.motion:C.sub, fontWeight:600}}>{isForecast?"forecast":"observed"} · {stamp}</span>
          <span style={{fontSize:11, color:C.subDim, marginLeft:4}}>(placeholder)</span>
        </div>
        <button onClick={onClose} style={{ display:"flex", alignItems:"center", gap:8, background:C.cardHi, color:C.text, border:`1px solid ${C.edge}`, borderRadius:12, padding:"10px 18px", fontSize:14, fontWeight:700, cursor:"pointer" }}>
          <X size={18}/>Close
        </button>
      </div>

      <div style={{ flex:1, position:"relative", minHeight:0 }}>
        <canvas ref={canvasRef} style={{ position:"absolute", inset:0, width:"100%", height:"100%" }}/>
        <div style={{ position:"absolute", right:16, top:16, background:"rgba(12,14,19,0.8)", border:`1px solid ${C.edge}`, borderRadius:10, padding:"10px 12px", display:"flex", flexDirection:"column", gap:6 }}>
          <span style={{fontSize:10, color:C.sub, fontWeight:700, letterSpacing:1, textTransform:"uppercase"}}>Intensity</span>
          {[["#4682ff","Light"],["#3cc88c","Moderate"],["#f0c846","Heavy"],["#e0483d","Intense"]].map(([c,l])=>(
            <div key={l} style={{display:"flex", alignItems:"center", gap:8, fontSize:11, color:C.sub}}>
              <span style={{width:12,height:12,borderRadius:3,background:c}}/>{l}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display:"flex", alignItems:"center", gap:14, padding:"14px 20px", borderTop:`1px solid ${C.edge}` }}>
        <button onClick={()=>setPlaying(p=>!p)} style={{...rBtn, background:C.accent, color:C.bg0, borderColor:C.accent}}>{playing? <Pause size={18}/> : <Play size={18}/>}</button>
        <input type="range" min={0} max={FRAME_COUNT-1} value={idx}
          onChange={(e)=>{ setPlaying(false); setIdx(+e.target.value); }}
          style={{ flex:1, accentColor:C.accent }}/>
        <span style={{fontSize:12, color:C.sub, minWidth:96, textAlign:"right", fontVariantNumeric:"tabular-nums"}}>{idx+1} / {FRAME_COUNT}</span>
      </div>
    </div>
  );
}
const rBtn = { width:42, height:42, borderRadius:11, background:C.cardHi, color:C.text, border:`1px solid ${C.edge}`, cursor:"pointer", display:"grid", placeItems:"center" };

// ================= STATIC TILE CONTENT (pending modules) =====================
const SCENES = [ ["Morning",Sun], ["Movie",Play], ["Away",Lock], ["Night",Moon] ];
const EVENTS = [ ["7:30a","School drop-off"], ["1:00p","Dentist — Maya"], ["6:30p","Soccer practice"] ];
const TASKS0 = [ ["Replace garage sensor battery","Eric",false], ["Order pool chlorine","Eric",false], ["Permission slip","Sam",true], ["Recycling","Kids",false] ];
const FORECAST = [ ["Now","72°",Sun], ["1p","75°",Sun], ["2p","76°",Sun], ["3p","74°",Cloud], ["4p","71°",Cloud], ["5p","68°",Droplets] ];

// ================= LAYOUT =====================
const GRID_COLS = 12;
const DEFAULT_LAYOUT = {
  board:   { x:0, y:0, w:6, h:4, visible:true },
  weather: { x:6, y:0, w:3, h:2, visible:true },
  radar:   { x:9, y:0, w:3, h:2, visible:true },
  climate: { x:6, y:2, w:3, h:2, visible:true },
  calendar:{ x:9, y:2, w:3, h:2, visible:true },
  devices: { x:0, y:4, w:6, h:2, visible:true },
  tasks:   { x:6, y:4, w:6, h:2, visible:true },
};
const TILE_META = {
  board:{label:"Home Map"}, weather:{label:"Weather"}, radar:{label:"Radar"},
  climate:{label:"Climate"}, calendar:{label:"Today"}, devices:{label:"Devices"}, tasks:{label:"Tasks"},
};
const LS_KEY = "homehub.wallpanel.layout.v2";
const PANEL_KEY = "wallpanel";

// ================= TILE SHELL =====================
function Tile({ title, children, edit, onToggleVisible, style }) {
  return (
    <div style={{ background:C.card, border:`1px solid ${C.edge}`, borderRadius:16, padding:16,
      display:"flex", flexDirection:"column", minHeight:0, height:"100%", overflow:"hidden",
      position:"relative", ...style }}>
      {title && (
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10}}>
          <span style={{fontSize:11, fontWeight:700, letterSpacing:1.3, textTransform:"uppercase", color:C.sub}}>{title}</span>
          {edit && <button onClick={onToggleVisible} style={{background:"none", border:"none", color:C.sub, cursor:"pointer", padding:2}}><EyeOff size={15}/></button>}
        </div>
      )}
      <div style={{flex:1, minHeight:0, overflow:"hidden"}}>{children}</div>
    </div>
  );
}

export default function WallPanel() {
  // ---- LIVE DATA -----------------------------------------------------------
  const { entities, linkUp, bridgeUp } = useHomeHub();

  const alarm = entities.get("alarm_control_panel.homehub");
  const armed = alarm ? alarm.state.startsWith("armed") : false;

  // board sensor states derived from live entities
  const liveState = useMemo(() => {
    const s = {};
    SENSORS.forEach(x => { s[x.id] = boardStateFor(x, entities.get(x.id)); });
    return s;
  }, [entities]);

  // devices tile from live light/switch domains (+ sump monitor)
  const devices = useMemo(() => {
    const list = [];
    for (const e of entities.values()) {
      if (e.domain === "light" || e.domain === "switch") {
        list.push({ entity_id: e.entity_id, name: e.friendly_name, on: e.state === "on", kind: e.domain });
      }
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    const sump = entities.get("sensor.sump_pump_current");
    if (sump) list.push({ entity_id: sump.entity_id, name: `Sump ${sump.state}A`, on: true, kind: "monitor" });
    return list;
  }, [entities]);

  const climateRows = useMemo(() => {
    const rows = [];
    const main = entities.get("climate.main_floor");
    if (main) rows.push(["Central", `${main.attributes.current_temperature ?? "–"}°`,
      `→ ${main.attributes.target_temp_low ?? "?"}–${main.attributes.target_temp_high ?? "?"}°`]);
    const mini = entities.get("climate.garage_minisplit");
    if (mini) rows.push(["Mini-split", `${mini.attributes.current_temperature ?? "–"}°`,
      `→ ${mini.attributes.temperature ?? "?"}°`]);
    return rows;
  }, [entities]);

  const [floorView, setFloorView] = useState("all");
  const [tasks, setTasks] = useState(TASKS0);
  const [showRadar, setShowRadar] = useState(false);
  const [edit, setEdit] = useState(false);

  // ---- layout: server-backed with localStorage fallback --------------------
  const [layout, setLayout] = useState(() => {
    if (typeof window !== "undefined") {
      try { const s = localStorage.getItem(LS_KEY); if (s) return JSON.parse(s); } catch {}
    }
    return DEFAULT_LAYOUT;
  });
  const layoutLoaded = useRef(false);
  useEffect(() => {
    fetch(`${API_URL}/api/layouts/${PANEL_KEY}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.layout_json) {
          const parsed = JSON.parse(d.layout_json);
          if (parsed && parsed.board) setLayout(parsed);
        }
      })
      .catch(() => {})
      .finally(() => { layoutLoaded.current = true; });
  }, []);
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(layout)); } catch {}
    if (!layoutLoaded.current) return;
    const t = setTimeout(() => {
      fetch(`${API_URL}/api/layouts/${PANEL_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout_json: JSON.stringify(layout) }),
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [layout]);

  const liveStateRef = useRef(liveState); const armedRef = useRef(armed);
  useEffect(()=>{ liveStateRef.current = liveState; },[liveState]);
  useEffect(()=>{ armedRef.current = armed; },[armed]);

  useEffect(()=>{
    const prev = { o:document.body.style.overflow, ob:document.body.style.overscrollBehavior, m:document.body.style.margin };
    document.body.style.overflow="hidden"; document.body.style.overscrollBehavior="none"; document.body.style.margin="0";
    return ()=>{ document.body.style.overflow=prev.o; document.body.style.overscrollBehavior=prev.ob; document.body.style.margin=prev.m; };
  },[]);

  const summary = useMemo(()=>{
    let open=0,motion=0,low=0,offline=0;
    SENSORS.forEach(s=>{
      const l=liveState[s.id];
      if(!l){ offline++; return; }
      if(l.state==="open"||l.state==="triggered")open++;
      if(l.state==="motion")motion++;
      if(l.battery<=15)low++;
    });
    return {open,motion,low,offline};
  },[liveState]);
  const allSecure = summary.open===0;

  // ---- actions → backend service API --------------------------------------
  const [busy, setBusy] = useState(false);
  const toggleDevice = async (d) => {
    if (d.kind === "monitor") return;
    try { await callService(d.kind, "toggle", d.entity_id); } catch (e) { console.error(e); }
  };
  const toggleTask = i => setTasks(t=>t.map((x,j)=> j===i?[x[0],x[1],!x[2]]:x));

  // ---- grid geometry ----
  const gridRef = useRef();
  const [gridSize, setGridSize] = useState({ w:1200, h:700 });
  useEffect(() => {
    const el = gridRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setGridSize({ w:el.clientWidth, h:el.clientHeight }));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const ROWS = 6;
  const cellW = gridSize.w / GRID_COLS;
  const cellH = gridSize.h / ROWS;
  const GAP = 12;

  const tileStyle = (l) => ({
    position:"absolute",
    left: l.x*cellW + GAP/2, top: l.y*cellH + GAP/2,
    width: l.w*cellW - GAP, height: l.h*cellH - GAP,
    transition: dragId.current ? "none" : "left .18s, top .18s, width .18s, height .18s",
  });

  // ---- drag + resize ----
  const dragId = useRef(null);
  const mode = useRef(null);
  const start = useRef({});
  const onPointerDown = (e, id, m) => {
    if (!edit) return;
    e.preventDefault(); e.stopPropagation();
    dragId.current = id; mode.current = m;
    const l = layout[id];
    start.current = { mx:e.clientX, my:e.clientY, x:l.x, y:l.y, w:l.w, h:l.h };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };
  const onPointerMove = (e) => {
    const id = dragId.current; if (!id) return;
    const dx = Math.round((e.clientX - start.current.mx) / cellW);
    const dy = Math.round((e.clientY - start.current.my) / cellH);
    setLayout(prev => {
      const l = { ...prev[id] };
      if (mode.current === "move") {
        l.x = Math.max(0, Math.min(GRID_COLS - l.w, start.current.x + dx));
        l.y = Math.max(0, Math.min(ROWS - l.h, start.current.y + dy));
      } else {
        l.w = Math.max(2, Math.min(GRID_COLS - l.x, start.current.w + dx));
        l.h = Math.max(1, Math.min(ROWS - l.y, start.current.h + dy));
      }
      return { ...prev, [id]: l };
    });
  };
  const onPointerUp = () => {
    dragId.current = null; mode.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  const setVisible = (id, v) => setLayout(prev => ({ ...prev, [id]: { ...prev[id], visible:v } }));
  const resetLayout = () => setLayout(DEFAULT_LAYOUT);

  // ---- tile content ----
  const tileContent = {
    board: (
      <Tile title="Home Map" edit={edit} onToggleVisible={()=>setVisible("board",false)} style={{padding:0}}>
        <div style={{position:"absolute", inset:0}}><Board liveStateRef={liveStateRef} armedRef={armedRef} floorView={floorView}/></div>
        <div style={{position:"absolute", top:12, left:14, fontSize:11, fontWeight:700, letterSpacing:1.3, textTransform:"uppercase", color:C.sub}}>Home Map</div>
        {!edit && (
          <div style={{position:"absolute", left:12, bottom:12, display:"flex", gap:6}}>
            {[["all","All"],[1,"Up"],[0,"Ground"]].map(([v,l])=>(
              <button key={String(v)} onClick={()=>setFloorView(v)} style={{ background: floorView===v?C.cardHi:"rgba(18,21,31,0.8)", color: floorView===v?C.text:C.sub, border:`1px solid ${C.edge}`, borderRadius:9, padding:"8px 14px", fontSize:12, cursor:"pointer", fontWeight:600, backdropFilter:"blur(6px)" }}>{l}</button>
            ))}
          </div>
        )}
        <div style={{position:"absolute", right:12, bottom:12, display:"flex", gap:12, background:"rgba(18,21,31,0.8)", padding:"7px 12px", borderRadius:10}}>
          {[[C.open,summary.open,"open"],[C.motion,summary.motion,"motion"],[C.amber,summary.low,"low"]].map(([c,n,l])=>(
            <div key={l} style={{display:"flex", alignItems:"center", gap:5}}>
              <span style={{width:8,height:8,borderRadius:8,background:c}}/><span style={{fontSize:13, fontWeight:800}}>{n}</span><span style={{fontSize:10, color:C.sub}}>{l}</span>
            </div>
          ))}
        </div>
      </Tile>
    ),
    weather: (
      <Tile title="Weather" edit={edit} onToggleVisible={()=>setVisible("weather",false)}>
        <div style={{display:"flex", alignItems:"center", gap:12}}>
          <Sun size={40} color={C.motion}/>
          <div><div style={{fontSize:34, fontWeight:800, lineHeight:1}}>72°</div><div style={{fontSize:12, color:C.sub}}>Sunny · H76/L61</div></div>
        </div>
        <div style={{display:"flex", justifyContent:"space-between", marginTop:12, gap:2}}>
          {FORECAST.map(([t,tp,Ic],i)=>(
            <div key={i} style={{display:"flex", flexDirection:"column", alignItems:"center", gap:4}}>
              <span style={{fontSize:10, color:C.sub}}>{t}</span><Ic size={15} color={i>3?C.sub:C.motion}/><span style={{fontSize:12, fontWeight:700}}>{tp}</span>
            </div>
          ))}
        </div>
      </Tile>
    ),
    radar: (
      <Tile title="Radar" edit={edit} onToggleVisible={()=>setVisible("radar",false)}>
        <button onClick={()=>!edit && setShowRadar(true)} style={{ width:"100%", height:"100%", background:"linear-gradient(135deg,#16233a,#101725)", border:`1px solid ${C.edge}`, borderRadius:12, cursor: edit?"default":"pointer", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8, color:C.text, position:"relative", overflow:"hidden" }}>
          <div style={{position:"absolute", inset:0, opacity:0.25, background:"repeating-radial-gradient(circle at 50% 50%, #6b8afd 0, #6b8afd 1px, transparent 2px, transparent 16px)"}}/>
          <Radar size={30} color={C.accent}/>
          <span style={{fontSize:13, fontWeight:700}}>Open Radar</span>
          <span style={{fontSize:10, color:C.sub}}>live precipitation</span>
        </button>
      </Tile>
    ),
    climate: (
      <Tile title="Climate" edit={edit} onToggleVisible={()=>setVisible("climate",false)}>
        <div style={{display:"flex", flexDirection:"column", gap:10, justifyContent:"center", height:"100%"}}>
          {climateRows.length === 0 && <span style={{fontSize:12, color:C.sub}}>Waiting for climate entities…</span>}
          {climateRows.map(([room,temp,tgt])=>(
            <div key={room} style={{display:"flex", alignItems:"baseline", justifyContent:"space-between"}}>
              <div><div style={{fontSize:28, fontWeight:800, lineHeight:1}}>{temp}</div><div style={{fontSize:11, color:C.sub, marginTop:2}}>{room}</div></div>
              <div style={{fontSize:12, color:C.accent, fontWeight:600}}>{tgt}</div>
            </div>
          ))}
        </div>
      </Tile>
    ),
    calendar: (
      <Tile title="Today" edit={edit} onToggleVisible={()=>setVisible("calendar",false)}>
        <div style={{display:"flex", flexDirection:"column", gap:1, justifyContent:"center", height:"100%"}}>
          {EVENTS.map(([t,l])=>(
            <div key={l} style={{display:"flex", gap:10, padding:"6px 0", alignItems:"center"}}>
              <span style={{color:C.accent, fontWeight:800, minWidth:48, fontSize:13}}>{t}</span><span style={{fontSize:14}}>{l}</span>
            </div>
          ))}
        </div>
      </Tile>
    ),
    devices: (
      <Tile title="Devices" edit={edit} onToggleVisible={()=>setVisible("devices",false)}>
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:7, marginBottom:8}}>
          {devices.map((d)=>(
            <button key={d.entity_id} onClick={()=>!edit && toggleDevice(d)} style={{ display:"flex", alignItems:"center", gap:7, background: d.on&&d.kind!=="monitor"?"rgba(107,138,253,0.15)":C.cardHi, border:`1px solid ${d.on&&d.kind!=="monitor"?C.accent:C.edge}`, borderRadius:10, padding:"8px 9px", cursor: d.kind==="monitor"||edit?"default":"pointer", color:C.text, textAlign:"left" }}>
              {d.kind==="light" && <Lightbulb size={15} color={d.on?C.motion:C.subDim}/>}
              {d.kind==="switch" && <Zap size={15} color={d.on?C.secure:C.subDim}/>}
              {d.kind==="monitor" && <Wifi size={15} color={C.secure}/>}
              <span style={{fontSize:11, fontWeight:600, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{d.name}</span>
            </button>
          ))}
        </div>
        <div style={{display:"flex", gap:6}}>
          {SCENES.map(([n,Ic])=>(
            <button key={n} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4, background:C.cardHi, border:`1px solid ${C.edge}`, borderRadius:10, padding:"9px 4px", cursor:"pointer", color:C.text }}>
              <Ic size={15} color={C.accent}/><span style={{fontSize:10}}>{n}</span>
            </button>
          ))}
        </div>
      </Tile>
    ),
    tasks: (
      <Tile title="Tasks" edit={edit} onToggleVisible={()=>setVisible("tasks",false)}>
        <div style={{display:"flex", flexDirection:"column", gap:1, justifyContent:"center", height:"100%"}}>
          {tasks.map(([t,who,done],i)=>(
            <div key={t} onClick={()=>!edit && toggleTask(i)} style={{display:"flex", alignItems:"center", gap:9, padding:"6px 0", cursor: edit?"default":"pointer"}}>
              <div style={{width:19,height:19,borderRadius:6, border:`2px solid ${done?C.secure:C.subDim}`, background:done?C.secure:"transparent", display:"grid", placeItems:"center", flexShrink:0}}>{done && <CheckSquare size={11} color="#0c0e13"/>}</div>
              <span style={{flex:1, fontSize:13, textDecoration:done?"line-through":"none", color:done?C.sub:C.text}}>{t}</span>
              <span style={{fontSize:10, color:C.sub, background:C.cardHi, padding:"2px 8px", borderRadius:9}}>{who}</span>
            </div>
          ))}
        </div>
      </Tile>
    ),
  };

  const hiddenTiles = Object.keys(layout).filter(id => !layout[id].visible);

  return (
    <div style={{ fontFamily:"'DM Sans', system-ui, sans-serif", height:"100dvh", width:"100vw", overflow:"hidden",
      background:`radial-gradient(1400px 900px at 75% -15%, ${C.bg1}, ${C.bg0})`, color:C.text,
      display:"flex", flexDirection:"column",
      paddingTop:"max(12px, env(safe-area-inset-top))", paddingBottom:"max(12px, env(safe-area-inset-bottom))",
      paddingLeft:"max(12px, env(safe-area-inset-left))", paddingRight:"max(12px, env(safe-area-inset-right))",
      boxSizing:"border-box" }}>

      {/* header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        background:C.card, border:`1px solid ${allSecure?C.edge:C.open}`, borderRadius:16, padding:"12px 18px", marginBottom:12, flexShrink:0 }}>
        <div style={{display:"flex", alignItems:"center", gap:14}}>
          <span style={{width:11,height:11,borderRadius:11, background: allSecure?C.secure:C.open, boxShadow:`0 0 10px ${allSecure?C.secure:C.open}`}}/>
          <span style={{fontSize:20, fontWeight:800}}>{allSecure?"All Secure":`${summary.open} Open`}</span>
          <span style={{fontSize:13, color:C.sub}}>
            {alarm ? (alarm.state === "armed_away" ? "Armed — Away" : alarm.state === "armed_home" ? "Armed — Home" : "Disarmed") : "Alarm offline"}
            {" · "}{summary.low} low battery
            {summary.offline > 0 && ` · ${summary.offline} offline`}
          </span>
          <span title={linkUp ? (bridgeUp ? "Backend + HA bridge up" : "Backend up, HA bridge down") : "Backend link down"}
            style={{display:"flex", alignItems:"center", gap:5, fontSize:11, color: linkUp && bridgeUp ? C.sub : C.open}}>
            <Wifi size={13}/>{linkUp ? (bridgeUp ? "live" : "no bridge") : "offline"}
          </span>
        </div>
        <div style={{display:"flex", alignItems:"center", gap:8}}>
          <button onClick={()=>setEdit(e=>!e)} style={{ display:"flex", alignItems:"center", gap:8, background: edit?C.accent:C.cardHi, color: edit?C.bg0:C.sub, border:`1px solid ${edit?C.accent:C.edge}`, borderRadius:12, padding:"11px 16px", fontSize:14, fontWeight:700, cursor:"pointer" }}>
            <Settings2 size={17}/>{edit?"Done":"Edit"}
          </button>
          <AlarmControl variant="compact" />
        </div>
      </div>

      {/* edit toolbar */}
      {edit && (
        <div style={{ display:"flex", alignItems:"center", gap:10, background:C.cardHi, border:`1px solid ${C.edge}`, borderRadius:12, padding:"10px 14px", marginBottom:12, flexWrap:"wrap", flexShrink:0 }}>
          <span style={{fontSize:12, color:C.sub, fontWeight:600}}>Drag tiles to move · drag corner to resize ·</span>
          {hiddenTiles.length > 0 && <span style={{fontSize:12, color:C.sub}}>Hidden:</span>}
          {hiddenTiles.map(id => (
            <button key={id} onClick={()=>setVisible(id,true)} style={{ display:"flex", alignItems:"center", gap:6, background:C.card, border:`1px solid ${C.edge}`, borderRadius:9, padding:"6px 11px", fontSize:12, color:C.text, cursor:"pointer" }}>
              <Eye size={13}/>{TILE_META[id].label}
            </button>
          ))}
          <button onClick={resetLayout} style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:6, background:C.card, border:`1px solid ${C.edge}`, borderRadius:9, padding:"6px 11px", fontSize:12, color:C.sub, cursor:"pointer" }}>
            <RotateCcw size={13}/>Reset layout
          </button>
        </div>
      )}

      {/* grid */}
      <div ref={gridRef} style={{ position:"relative", flex:1, minHeight:0,
        background: edit ? `repeating-linear-gradient(0deg, transparent, transparent ${cellH-1}px, rgba(107,138,253,0.06) ${cellH}px), repeating-linear-gradient(90deg, transparent, transparent ${cellW-1}px, rgba(107,138,253,0.06) ${cellW}px)` : "none",
        borderRadius:12 }}>
        {Object.keys(layout).filter(id => layout[id].visible).map(id => {
          const l = layout[id];
          return (
            <div key={id} style={tileStyle(l)}>
              <div
                onPointerDown={(e)=>onPointerDown(e, id, "move")}
                style={{ height:"100%", cursor: edit?"grab":"default", position:"relative",
                  outline: edit ? `1.5px dashed ${C.accent}` : "none", outlineOffset:2, borderRadius:16 }}>
                {tileContent[id]}
                {edit && (
                  <div onPointerDown={(e)=>onPointerDown(e, id, "resize")} style={{ position:"absolute", right:0, bottom:0, width:26, height:26, cursor:"nwse-resize", display:"grid", placeItems:"center" }}>
                    <div style={{ width:12, height:12, borderRight:`2.5px solid ${C.accent}`, borderBottom:`2.5px solid ${C.accent}`, borderBottomRightRadius:3 }}/>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showRadar && <MockRadar onClose={()=>setShowRadar(false)}/>}
    </div>
  );
}
