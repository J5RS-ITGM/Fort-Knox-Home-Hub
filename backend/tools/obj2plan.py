"""Convert a Sweet Home 3D OBJ export into a plan JSON for the 3D security board.

Companion to obj2svg.py and uses the IDENTICAL projection (same PAD, same
scale, same viewBox) so the JSON geometry, the SVG backdrop, and the saved
sensor placements all live in one coordinate system. Regenerate both files
together whenever the Sweet Home model changes:

    python3 obj2plan.py Home_Mockup_1st_Floor.obj ../../frontend/public/floorplans/first_floor.plan.json
    python3 obj2svg.py  Home_Mockup_1st_Floor.obj ../../frontend/public/floorplans/first_floor.svg

Differences from the SVG pass:
  - walls are merged by their logical Sweet Home id (group "wall_12_68"
    -> wall "wall_12"), giving one clean box per wall instead of one per
    exported face-mesh; the box carries its real height (OBJ units, cm)
  - rooms are merged the same way and keep their id so labels can be
    attached in the "labels" map below (room names don't survive OBJ
    export, so they're hand-edited here or in the emitted JSON directly)
"""
import json
import re
import sys
from collections import defaultdict

INFILE = sys.argv[1] if len(sys.argv) > 1 else "Home_Mockup_1st_Floor.obj"
OUTFILE = sys.argv[2] if len(sys.argv) > 2 else "/tmp/first_floor.plan.json"

# Optional room labels, keyed by merged room id. Edit freely; unknown ids
# are ignored and unlisted rooms render without a label.
LABELS: dict[str, str] = {}

verts: list[tuple[float, float, float]] = []
group_faces: dict[str, list[list[int]]] = defaultdict(list)
cur = None
with open(INFILE) as f:
    for line in f:
        if line.startswith("v "):
            _, x, y, z = line.split()[:4]
            verts.append((float(x), float(y), float(z)))
        elif line.startswith("g "):
            cur = line[2:].strip()
        elif line.startswith("f "):
            idxs = [int(p.split("/")[0]) for p in line.split()[1:]]
            group_faces[cur].append(idxs)


def merge_key(group: str) -> str | None:
    """wall_12_68 -> wall_12 ; room_28_159 -> room_28 ; else None."""
    m = re.match(r"^(wall|room)_(\d+)(?:_\d+)?$", group)
    return f"{m.group(1)}_{m.group(2)}" if m else None


merged: dict[str, dict[str, float]] = {}
for g, faces in group_faces.items():
    key = merge_key(g)
    if key is None:
        continue
    xs, ys, zs = [], [], []
    for face in faces:
        for i in face:
            x, y, z = verts[i - 1]
            xs.append(x); ys.append(y); zs.append(z)
    if not xs:
        continue
    b = merged.setdefault(key, {"minx": xs[0], "maxx": xs[0], "miny": ys[0],
                                "maxy": ys[0], "minz": zs[0], "maxz": zs[0]})
    b["minx"] = min(b["minx"], *xs); b["maxx"] = max(b["maxx"], *xs)
    b["miny"] = min(b["miny"], *ys); b["maxy"] = max(b["maxy"], *ys)
    b["minz"] = min(b["minz"], *zs); b["maxz"] = max(b["maxz"], *zs)

walls = {k: v for k, v in merged.items() if k.startswith("wall_")}
rooms = {k: v for k, v in merged.items() if k.startswith("room_")}

# -- identical projection to obj2svg.py --------------------------------------
allx = [c for b in merged.values() for c in (b["minx"], b["maxx"])]
allz = [c for b in merged.values() for c in (b["minz"], b["maxz"])]
minx, maxx = min(allx), max(allx)
minz, maxz = min(allz), max(allz)
W, H = maxx - minx, maxz - minz
PAD = 40
scale = (1000 - 2 * PAD) / max(W, H)          # plan px per OBJ unit (cm)
vbW = 2 * PAD + W * scale
vbH = 2 * PAD + H * scale


def rect(b: dict[str, float]) -> dict[str, float]:
    return {
        "x": round(PAD + (b["minx"] - minx) * scale, 1),
        "y": round(PAD + (b["minz"] - minz) * scale, 1),
        "w": round((b["maxx"] - b["minx"]) * scale, 1),
        "h": round((b["maxz"] - b["minz"]) * scale, 1),
    }


plan = {
    "source": INFILE.split("/")[-1],
    "viewbox": [round(vbW, 1), round(vbH, 1)],
    "px_per_cm": round(scale, 4),
    "walls": [
        {**rect(b), "height_cm": round(b["maxy"] - b["miny"], 1)}
        for _, b in sorted(walls.items())
    ],
    "rooms": [
        {"id": k, **rect(b), "label": LABELS.get(k, "")}
        for k, b in sorted(rooms.items())
    ],
}

with open(OUTFILE, "w") as f:
    json.dump(plan, f, indent=1)
print(f"plan: {vbW:.0f} x {vbH:.0f} px, {len(plan['walls'])} walls, "
      f"{len(plan['rooms'])} rooms -> {OUTFILE}")
