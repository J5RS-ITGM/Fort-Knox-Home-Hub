"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  Lock, Unlock, Sun, Cloud, Droplets, CheckSquare, Lightbulb, Zap, Wifi,
  Play, Moon, Radar, X, Settings2, Eye, EyeOff, RotateCcw, Pause,
} from "lucide-react";
import { API_URL, callService } from "@/lib/api";
import { buildPlanFloor, makeTextSprite, defaultLabels, fetchPlan, fetchBoardState } from "@/lib/planScene";
import BottomTabs, { BOTTOM_TABS_HEIGHT } from "@/components/BottomTabs";
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
// (hardcoded SENSORS list retired — markers come from /api/placements,
//  the same source the Security board uses)
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

function Board({ plan, placements, labels, liveStateRef, armedRef, floorView }) {
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
    // Floors: identical geometry to the Security board (shared builder).
    // Ground floor comes from the Sweet Home 3D plan when present; the
    // generic room boxes remain the fallback and the upstairs placeholder.
    const FLOOR_H_P = 2.4;
    const floorGroups = { 0:new THREE.Group(), 1:new THREE.Group() };
    if (plan) {
      floorGroups[0].add(buildPlanFloor(plan, 0));
    } else {
      ROOMS[0].forEach(([cx,cz,w,dp,label]) => floorGroups[0].add(buildRoom(cx,cz,w,dp,0,label)));
    }
    ROOMS[1].forEach(([cx,cz,w,dp,label]) => floorGroups[1].add(buildRoom(cx,cz,w,dp,FLOOR_H_P, plan ? "" : label)));
    scene.add(floorGroups[0]);
    scene.add(floorGroups[1]);

    // Room labels: the same records the Security board editor maintains.
    (labels ?? []).forEach((l) => {
      if (!l.text) return;
      const spr = makeTextSprite(l.text, { scale: 0.9 });
      spr.position.set(l.x, l.floor * FLOOR_H_P + 0.9, l.z);
      floorGroups[l.floor]?.add(spr);
    });

    // Markers: live placements (grid coords, y->z), same as the board.
    const markers = [];
    (placements ?? []).forEach(s => {
      const y = s.floor*2.4 + 0.55; const grp = new THREE.Group(); grp.position.set(s.x,y,s.y);
      const drop = new THREE.Mesh(new THREE.CylinderGeometry(0.015,0.015,0.5,6), new THREE.MeshBasicMaterial({ color:hx(C.secure), transparent:true, opacity:0.5 }));
      drop.position.y=-0.25; grp.add(drop);
      const sph = new THREE.Mesh(new THREE.SphereGeometry(0.26,20,20), new THREE.MeshStandardMaterial({ color:hx(C.secure), emissive:hx(C.secure), emissiveIntensity:0.5, roughness:0.3 }));
      grp.add(sph);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.36,0.46,32), new THREE.MeshBasicMaterial({ color:hx(C.open), transparent:true, opacity:0.55, side:THREE.DoubleSide }));
      ring.rotation.x=-Math.PI/2; ring.position.y=-0.22; ring.visible=false; grp.add(ring);
      scene.add(grp); markers.push({ id:s.entity_id, floor:s.floor, type:s.type, grp, sph, drop, ring });
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
  }, [floorView, plan, placements, labels, liveStateRef, armedRef]);
  return <div ref={mountRef} style={{ width:"100%", height:"100%" }} />;
}

// ================= RADAR (live — RainViewer via backend proxy) ================
// A radar "scope": RainViewer precipitation tiles composited on a dark
// field, centered on the home coordinates from Admin -> Settings, with
// range rings instead of a third-party basemap (keeps egress to the one
// approved service, proxied server-side so panels stay local-only).
// Local geographic context (frontend/public/geo/us-overlay.json — bundled
// public-domain Natural Earth / Census outlines): state lines, Great Lakes
// filled, major-city markers. Drawn locally so the radar needs NO basemap
// service — panels stay on approved-egress-only.
const CITIES = [
  ["Chicago",41.878,-87.630],["Milwaukee",43.039,-87.906],["Rockford",42.271,-89.094],
  ["Madison",43.073,-89.401],["Green Bay",44.513,-88.013],["Grand Rapids",42.963,-85.668],
  ["South Bend",41.676,-86.252],["Fort Wayne",41.079,-85.139],["Indianapolis",39.768,-86.158],
  ["Champaign",40.116,-88.243],["Springfield IL",39.782,-89.651],["Peoria",40.694,-89.589],
  ["Davenport",41.524,-90.578],["Cedar Rapids",41.978,-91.665],["Des Moines",41.587,-93.625],
  ["St. Louis",38.627,-90.199],["Kansas City",39.100,-94.578],["Minneapolis",44.978,-93.265],
  ["Detroit",42.331,-83.046],["Toledo",41.654,-83.536],["Cleveland",41.499,-81.694],
  ["Columbus",39.961,-82.999],["Cincinnati",39.103,-84.512],["Louisville",38.253,-85.758],
  ["Nashville",36.163,-86.781],["Memphis",35.150,-90.049],["Omaha",41.257,-95.995],
  ["Denver",39.739,-104.990],["Dallas",32.777,-96.797],["Houston",29.760,-95.370],
  ["Atlanta",33.749,-84.388],["Charlotte",35.227,-80.843],["Washington DC",38.907,-77.037],
  ["Philadelphia",39.953,-75.165],["New York",40.713,-74.006],["Boston",42.360,-71.059],
  ["Pittsburgh",40.441,-79.996],["Buffalo",42.887,-78.878],["Phoenix",33.448,-112.074],
  ["Seattle",47.606,-122.332],["Portland",45.515,-122.679],["San Francisco",37.775,-122.419],
  ["Los Angeles",34.052,-118.244],["San Diego",32.716,-117.161],["Miami",25.762,-80.192],
  ["Tampa",27.951,-82.457],["New Orleans",29.951,-90.072],["Salt Lake City",40.761,-111.891],
];
function LiveRadar({ onClose }) {
  const canvasRef = useRef();
  const [meta, setMeta] = useState(null);   // {frames, lat, lon} | {error}
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [zoom, setZoom] = useState(7);      // slippy zoom, 5 (region) .. 9 (metro)
  const [tick, setTick] = useState(0);      // bumped when tiles finish loading
  const imgCache = useRef(new Map());       // "path/z/x/y" -> HTMLImageElement
  const geoRef = useRef(null);              // bundled states/lakes overlay
  useEffect(() => {
    fetch("/geo/us-overlay.json").then((r) => r.ok ? r.json() : null)
      .then((g) => { geoRef.current = g; setTick((t) => t + 1); }).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => fetch(`${API_URL}/api/radar/meta`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`radar meta ${r.status}`)))
      .then((m) => { if (alive) { setMeta(m); setIdx(Math.max(0, m.frames.length - m.frames.filter(f=>f.nowcast).length - 1)); } })
      .catch((e) => { if (alive) setMeta({ error: String(e.message || e) }); });
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!playing || !meta?.frames?.length) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % meta.frames.length), 550);
    return () => clearInterval(t);
  }, [playing, meta]);

  useEffect(() => {
    const cv = canvasRef.current; if (!cv || !meta) return;
    const ctx = cv.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0d1420"; ctx.fillRect(0, 0, W, H);

    const centerMsg = (msg) => {
      ctx.fillStyle = C.sub; ctx.font = "600 14px system-ui"; ctx.textAlign = "center";
      ctx.fillText(msg, W / 2, H / 2);
    };
    if (meta.error) return centerMsg("Radar unavailable — backend can't reach RainViewer");
    if (meta.lat == null || meta.lon == null)
      return centerMsg("Set Latitude/Longitude in Admin → Settings to enable radar");
    const frame = meta.frames[idx]; if (!frame) return;

    // slippy-map math, home at canvas center
    const n = 2 ** zoom;
    const xt = ((meta.lon + 180) / 360) * n;
    const latR = (meta.lat * Math.PI) / 180;
    const yt = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
    const TILE = 256;
    const originX = W / 2 - xt * TILE, originY = H / 2 - yt * TILE;
    const toPx = (lat, lon) => {
      const fx = ((lon + 180) / 360) * n;
      const lr = (lat * Math.PI) / 180;
      const fy = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n;
      return [originX + fx * TILE, originY + fy * TILE];
    };

    // ---- geography UNDER the radar: lakes filled, state lines, cities ----
    const geo = geoRef.current;
    if (geo) {
      const drawRings = (rings, close) => {
        rings.forEach((ring) => {
          ctx.beginPath();
          let started = false;
          for (const [lon, lat] of ring) {
            const [px2, py2] = toPx(lat, lon);
            if (px2 < -200 || px2 > W + 200 || py2 < -200 || py2 > H + 200) {
              if (!started) continue;
            }
            if (!started) { ctx.moveTo(px2, py2); started = true; }
            else ctx.lineTo(px2, py2);
          }
          if (started && close) ctx.closePath();
          if (started) close ? (ctx.fill(), ctx.stroke()) : ctx.stroke();
        });
      };
      ctx.fillStyle = "#16233c"; ctx.strokeStyle = "#2c3f63"; ctx.lineWidth = 1;
      drawRings(geo.lakes, true);
      ctx.strokeStyle = "rgba(120,136,175,0.55)"; ctx.lineWidth = 1.2;
      drawRings(geo.states, false);
    }
    ctx.font = "600 11px system-ui"; ctx.textAlign = "left";
    CITIES.forEach(([name, clat, clon]) => {
      const [px2, py2] = toPx(clat, clon);
      if (px2 < 8 || px2 > W - 8 || py2 < 8 || py2 > H - 8) return;
      ctx.fillStyle = "rgba(200,210,228,0.9)";
      ctx.beginPath(); ctx.arc(px2, py2, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(200,210,228,0.75)";
      ctx.fillText(name, px2 + 6, py2 + 4);
    });

    const x0 = Math.floor(xt - W / 2 / TILE), x1 = Math.floor(xt + W / 2 / TILE);
    const y0 = Math.floor(yt - H / 2 / TILE), y1 = Math.floor(yt + H / 2 / TILE);
    let pending = 0;
    for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      const key = `${frame.path}/${zoom}/${wx}/${ty}`;
      let img = imgCache.current.get(key);
      if (!img) {
        img = new Image();
        img.src = `${API_URL}/api/radar/tile/${zoom}/${wx}/${ty}?path=${encodeURIComponent(frame.path)}`;
        imgCache.current.set(key, img);
        if (imgCache.current.size > 600) imgCache.current.delete(imgCache.current.keys().next().value);
      }
      if (img.complete && img.naturalWidth) {
        ctx.globalAlpha = 0.78; // geography reads through
        ctx.drawImage(img, originX + tx * TILE, originY + ty * TILE, TILE, TILE);
        ctx.globalAlpha = 1;
      } else { pending++; img.onload = () => setTick((t) => t + 1); }
    }

    // range rings: km per pixel at this latitude/zoom
    const mPerPx = (156543.03392 * Math.cos(latR)) / n;
    ctx.strokeStyle = "rgba(107,138,253,0.35)"; ctx.fillStyle = "rgba(145,153,168,0.9)";
    ctx.lineWidth = 1; ctx.font = "600 11px system-ui"; ctx.textAlign = "left";
    [25, 50, 100].forEach((mi) => {
      const rp = (mi * 1609.34) / mPerPx;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, rp, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(`${mi} mi`, W / 2 + rp * 0.7071 + 4, H / 2 - rp * 0.7071 - 4);
    });
    ctx.fillStyle = "#6b8afd"; ctx.beginPath(); ctx.arc(W / 2, H / 2, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(107,138,253,0.6)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 12, 0, Math.PI * 2); ctx.stroke();

    // frame time badge
    const dt = new Date(frame.ts * 1000);
    const label = `${frame.nowcast ? "FORECAST " : ""}${dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    ctx.fillStyle = frame.nowcast ? "#f0a838" : C.text;
    ctx.font = "700 13px system-ui"; ctx.textAlign = "left";
    ctx.fillText(label, 14, H - 14);
    if (pending) { ctx.fillStyle = C.sub; ctx.font = "600 11px system-ui"; ctx.fillText("loading tiles…", 14, 20); }
  }, [meta, idx, tick, zoom]);

  const frames = meta?.frames ?? [];
  return (
    <div style={{ position:"fixed", inset:0, zIndex:50, background:"rgba(8,10,14,0.9)", backdropFilter:"blur(8px)", display:"flex", flexDirection:"column" }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 18px" }}>
        <Radar size={22} color={C.accent}/>
        <span style={{fontSize:20, fontWeight:800, color:C.text}}>Weather Radar</span>
        <span style={{fontSize:12, color:C.sub}}>RainViewer · updates every 5 min</span>
        <div style={{flex:1}}/>
        <button onClick={()=>setZoom(z=>Math.max(5,z-1))} style={{ background:"transparent", color:C.text, border:`1px solid ${C.edge}`, borderRadius:10, padding:"8px 13px", fontSize:15, fontWeight:800, cursor:"pointer" }}>−</button>
        <button onClick={()=>setZoom(z=>Math.min(9,z+1))} style={{ background:"transparent", color:C.text, border:`1px solid ${C.edge}`, borderRadius:10, padding:"8px 13px", fontSize:15, fontWeight:800, cursor:"pointer" }}>+</button>
        <button onClick={()=>setPlaying(p=>!p)} style={{ display:"flex", alignItems:"center", gap:6, background:"transparent", color:C.text, border:`1px solid ${C.edge}`, borderRadius:10, padding:"8px 14px", fontSize:13, fontWeight:700, cursor:"pointer" }}>
          {playing ? <Pause size={15}/> : <Play size={15}/>}{playing ? "Pause" : "Play"}
        </button>
        <button onClick={onClose} style={{ background:"transparent", color:C.text, border:`1px solid ${C.edge}`, borderRadius:10, padding:"8px 12px", cursor:"pointer" }}><X size={16}/></button>
      </div>
      <div style={{ flex:1, margin:"0 18px 8px", borderRadius:14, overflow:"hidden", border:`1px solid ${C.edge}` }}>
        <canvas ref={canvasRef} style={{ width:"100%", height:"100%", display:"block" }}/>
      </div>
      <input type="range" min={0} max={Math.max(0, frames.length-1)} value={idx}
        onChange={(e)=>{ setPlaying(false); setIdx(Number(e.target.value)); }}
        style={{ margin:"0 18px 16px", accentColor:C.accent }}/>
    </div>
  );
}
const rBtn = { width:42, height:42, borderRadius:11, background:C.cardHi, color:C.text, border:`1px solid ${C.edge}`, cursor:"pointer", display:"grid", placeItems:"center" };

// ================= STATIC TILE CONTENT (pending modules) =====================
const SCENES = [ ["Morning",Sun], ["Movie",Play], ["Away",Lock], ["Night",Moon] ];
const EVENTS = [ ["7:30a","School drop-off"], ["1:00p","Dentist — Maya"], ["6:30p","Soccer practice"] ];
const TASKS0 = [ ["Replace garage sensor battery","Eric",false], ["Order pool chlorine","Eric",false], ["Permission slip","Sam",true], ["Recycling","Kids",false] ];
const FORECAST = [ ["Now","72°",Sun], ["1p","75°",Sun], ["2p","76°",Sun], ["3p","74°",Cloud], ["4p","71°",Cloud], ["5p","68°",Droplets] ];

// ================= CLOCK =====================
function ClockStrip() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const secs = now.toLocaleTimeString([], { second: "2-digit" }).padStart(2, "0");
  const date = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  return (
    <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", gap:16, padding:"0 18px",
                  background:C.card, border:`1px solid ${C.edge}`, borderRadius:12 }}>
      <span style={{ fontSize:34, fontWeight:800, color:C.text, fontVariantNumeric:"tabular-nums", lineHeight:1 }}>{time}</span>
      <span style={{ fontSize:15, fontWeight:700, color:C.subDim, fontVariantNumeric:"tabular-nums" }}>:{secs}</span>
      <span style={{ fontSize:16, fontWeight:600, color:C.sub }}>{date}</span>
    </div>
  );
}

// ================= LAYOUT =====================
const GRID_COLS = 12;
const DEFAULT_LAYOUT = {
  clock:   { x:0, y:0, w:12, h:1, visible:true },
  board:   { x:0, y:1, w:6, h:4, visible:true },
  weather: { x:6, y:1, w:3, h:2, visible:true },
  radar:   { x:9, y:1, w:3, h:2, visible:true },
  climate: { x:6, y:3, w:3, h:2, visible:true },
  calendar:{ x:9, y:3, w:3, h:2, visible:true },
  devices: { x:0, y:5, w:6, h:2, visible:true },
  tasks:   { x:6, y:5, w:6, h:2, visible:true },
};
const TILE_META = {
  clock:{label:"Clock"}, board:{label:"Home Map"}, weather:{label:"Weather"}, radar:{label:"Radar"},
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
  // Plan geometry + placements + room labels: the same sources the
  // Security board renders from, so the two views always match.
  const [plan, setPlan] = useState(null);
  const [placementRows, setPlacementRows] = useState([]);
  const [boardLabels, setBoardLabels] = useState({});
  useEffect(() => {
    let cancelled = false;
    fetchPlan().then((p) => { if (!cancelled) setPlan(p); });
    fetch(`${API_URL}/api/placements`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => { if (!cancelled) setPlacementRows(rows); })
      .catch(() => {});
    fetchBoardState(API_URL).then((bs) => { if (!cancelled) setBoardLabels(bs.labels ?? {}); });
    return () => { cancelled = true; };
  }, []);

  const typeOf = (entity) => {
    const dc = String(entity?.attributes?.device_class ?? "");
    if (dc === "motion" || dc === "occupancy") return "motion";
    if (dc === "moisture") return "leak";
    if (dc === "smoke" || dc === "gas" || dc === "carbon_monoxide") return "smoke";
    return "contact";
  };
  const placements = useMemo(
    () => placementRows.map((p) => ({ ...p, type: typeOf(entities.get(p.entity_id)) })),
    [placementRows, entities]
  );
  const labels = useMemo(() => defaultLabels(plan, ROOMS, boardLabels), [plan, boardLabels]);

  const liveState = useMemo(() => {
    const s = {};
    placements.forEach(x => { s[x.entity_id] = boardStateFor(x, entities.get(x.entity_id)); });
    return s;
  }, [placements, entities]);

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
  // Saved layouts predate newly shipped tiles (e.g. clock): merge defaults
  // underneath so new tiles appear without wiping user arrangements.
  const withNewTiles = (saved) => ({ ...DEFAULT_LAYOUT, ...saved });
  const [layout, setLayout] = useState(() => {
    if (typeof window !== "undefined") {
      try { const s = localStorage.getItem(LS_KEY); if (s) return withNewTiles(JSON.parse(s)); } catch {}
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
          if (parsed && parsed.board) setLayout(withNewTiles(parsed));
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
    placements.forEach(s=>{
      const l=liveState[s.entity_id];
      if(!l){ offline++; return; }
      if(l.state==="open"||l.state==="triggered")open++;
      if(l.state==="motion")motion++;
      if(l.battery<=15)low++;
    });
    return {open,motion,low,offline};
  },[liveState,placements]);
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
    clock: (
      <Tile title="Clock" edit={edit} onToggleVisible={()=>setVisible("clock",false)} style={{padding:0}}>
        <ClockStrip/>
      </Tile>
    ),
    board: (
      <Tile title="Home Map" edit={edit} onToggleVisible={()=>setVisible("board",false)} style={{padding:0}}>
        <div style={{position:"absolute", inset:0}}><Board plan={plan} placements={placements} labels={labels} liveStateRef={liveStateRef} armedRef={armedRef} floorView={floorView}/></div>
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
      paddingTop:"max(12px, env(safe-area-inset-top))",
      paddingBottom:`calc(${BOTTOM_TABS_HEIGHT}px + max(12px, env(safe-area-inset-bottom)))`,
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

      {showRadar && <LiveRadar onClose={()=>setShowRadar(false)}/>}
      <BottomTabs/>
    </div>
  );
}
