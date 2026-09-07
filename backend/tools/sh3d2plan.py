"""Convert a Sweet Home 3D .sh3d file straight into a plan JSON for the 3D
security board — no OBJ export step needed.

A .sh3d is a zip containing Home.xml, which defines walls (line segments
with thickness) and rooms (polygons) in centimeters. This reads that XML
and emits the SAME plan.json shape as obj2plan.py:

    { "viewbox": [W,H], "px_per_cm": s, "walls": [{x,y,w,h,height_cm}],
      "rooms": [{id,x,y,w,h,label}] }

Crucially it reuses the FIRST FLOOR's scale and origin (from
first_floor.plan.json) so the two floors line up when stacked in the 3D
view. If the first-floor plan is missing it falls back to its own extents.

    python3 sh3d2plan.py Home_Mockup_2nd_Floor.sh3d \\
        ../../frontend/public/floorplans/second_floor.plan.json
"""
import json
import sys
import xml.etree.ElementTree as ET
import zipfile

INFILE = sys.argv[1] if len(sys.argv) > 1 else "Home_Mockup_2nd_Floor.sh3d"
OUTFILE = sys.argv[2] if len(sys.argv) > 2 else "/tmp/second_floor.plan.json"
FIRST = "../../frontend/public/floorplans/first_floor.plan.json"

# --- read Home.xml out of the .sh3d zip -------------------------------------
with zipfile.ZipFile(INFILE) as z:
    xml = z.read("Home.xml")
root = ET.fromstring(xml)

walls_raw = []
for w in root.findall(".//wall"):
    walls_raw.append({
        "x1": float(w.get("xStart")), "y1": float(w.get("yStart")),
        "x2": float(w.get("xEnd")), "y2": float(w.get("yEnd")),
        "t": float(w.get("thickness", "7.62")),
        "h": float(w.get("height", root.get("wallHeight", "243.84"))),
    })

rooms_raw = []
for i, rm in enumerate(root.findall(".//room")):
    pts = [(float(p.get("x")), float(p.get("y"))) for p in rm.findall("point")]
    if not pts:
        continue
    rooms_raw.append({"name": rm.get("name") or "", "pts": pts, "idx": i})

# --- coordinate system: reuse first-floor scale + origin if available -------
all_x, all_y = [], []
for w in walls_raw:
    all_x += [w["x1"], w["x2"]]; all_y += [w["y1"], w["y2"]]
for r in rooms_raw:
    all_x += [p[0] for p in r["pts"]]; all_y += [p[1] for p in r["pts"]]
minx, maxx = min(all_x), max(all_x)
miny, maxy = min(all_y), max(all_y)

PAD = 40
try:
    first = json.load(open(FIRST))
    scale = first["px_per_cm"]
    vbW, vbH = first["viewbox"]
    # centre this floor inside the first floor's viewbox so they align
    span_w, span_h = (maxx - minx) * scale, (maxy - miny) * scale
    off_x = (vbW - span_w) / 2
    off_y = (vbH - span_h) / 2
except (FileNotFoundError, KeyError):
    W, H = maxx - minx, maxy - miny
    scale = (1000 - 2 * PAD) / max(W, H)
    vbW, vbH = 2 * PAD + W * scale, 2 * PAD + H * scale
    off_x = off_y = PAD


def px(x, y):
    return (off_x + (x - minx) * scale, off_y + (y - miny) * scale)


# --- walls: line segment + thickness -> axis-aligned rect -------------------
def _rect_for(w):
    x1, y1 = px(w["x1"], w["y1"])
    x2, y2 = px(w["x2"], w["y2"])
    th = max(w["t"] * scale, 2.0)
    lo_x, hi_x = min(x1, x2), max(x1, x2)
    lo_y, hi_y = min(y1, y2), max(y1, y2)
    rx, ry, rw, rh = lo_x, lo_y, hi_x - lo_x, hi_y - lo_y
    horiz = rw >= rh
    if horiz:
        ry -= th / 2; rh = th
    else:
        rx -= th / 2; rw = th
    return {"x": rx, "y": ry, "w": max(rw, th), "h": max(rh, th),
            "height_cm": w["h"], "horiz": horiz}


rects = [_rect_for(w) for w in walls_raw]

# Fill "chase" dead space: two parallel walls a small gap apart (HVAC /
# plumbing chase) leave a hollow slot between their faces. Detect such pairs
# and emit one solid block spanning from the outer face of one to the outer
# face of the other, so the wall reads as filled instead of a hollow slot.
CHASE_MAX_CM = 45          # only fill gaps up to this (a real chase, not a room)
CHASE_MIN_OVERLAP_CM = 40  # must run alongside each other for at least this
gap_px = CHASE_MAX_CM * scale
ov_px = CHASE_MIN_OVERLAP_CM * scale
fills = []
used = set()
for i in range(len(rects)):
    for j in range(i + 1, len(rects)):
        a, b = rects[i], rects[j]
        if a["horiz"] != b["horiz"]:
            continue
        if a["horiz"]:
            gap = abs(a["y"] - b["y"])
            overlap = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
            if 0 < gap <= gap_px and overlap >= ov_px:
                top = min(a["y"], b["y"]); bot = max(a["y"] + a["h"], b["y"] + b["h"])
                left = max(a["x"], b["x"]); right = min(a["x"] + a["w"], b["x"] + b["w"])
                fills.append({"x": round(left, 1), "y": round(top, 1),
                              "w": round(right - left, 1), "h": round(bot - top, 1),
                              "height_cm": round(max(a["height_cm"], b["height_cm"]), 1)})
        else:
            gap = abs(a["x"] - b["x"])
            overlap = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
            if 0 < gap <= gap_px and overlap >= ov_px:
                left = min(a["x"], b["x"]); right = max(a["x"] + a["w"], b["x"] + b["w"])
                top = max(a["y"], b["y"]); bot = min(a["y"] + a["h"], b["y"] + b["h"])
                fills.append({"x": round(left, 1), "y": round(top, 1),
                              "w": round(right - left, 1), "h": round(bot - top, 1),
                              "height_cm": round(max(a["height_cm"], b["height_cm"]), 1)})

plan_walls = []
for r in rects:
    plan_walls.append({"x": round(r["x"], 1), "y": round(r["y"], 1),
                       "w": round(r["w"], 1), "h": round(r["h"], 1),
                       "height_cm": round(r["height_cm"], 1)})
plan_walls.extend(fills)  # chase fills render on top, closing the dead space

# --- rooms: polygon -> bounding-box rect (matches 3D room-tile rendering) ---
plan_rooms = []
for r in rooms_raw:
    xs = [px(x, y)[0] for x, y in r["pts"]]
    ys = [px(x, y)[1] for x, y in r["pts"]]
    plan_rooms.append({
        "id": f"f2_room_{r['idx']}",
        "x": round(min(xs), 1), "y": round(min(ys), 1),
        "w": round(max(xs) - min(xs), 1), "h": round(max(ys) - min(ys), 1),
        "label": r["name"],   # usually empty; labelled in-app
    })

plan = {
    "source": INFILE.split("/")[-1],
    "viewbox": [round(vbW, 1), round(vbH, 1)],
    "px_per_cm": round(scale, 4),
    "walls": plan_walls,
    "rooms": plan_rooms,
}
with open(OUTFILE, "w") as f:
    json.dump(plan, f, indent=1)
print(f"2nd floor: {vbW:.0f}x{vbH:.0f}px, {len(rects)} walls "
      f"+ {len(fills)} chase fill(s), {len(plan_rooms)} rooms -> {OUTFILE}")
