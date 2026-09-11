"""Flatten a Sweet Home 3D OBJ export into a top-down 2D SVG floor plan.

Approach: for each 'wall_*' group, collect its vertices, project to the
X/Z ground plane (drop Y = height), and take the 2D bounding footprint of
that wall segment as a filled rectangle. Rooms give us floor tint; walls
give the black outline. This yields a clean architectural top-down plan,
which is what the security board renders under the sensor markers.
"""
import re
from collections import defaultdict

verts = []            # 1-indexed in OBJ
group_faces = defaultdict(list)   # group -> list of face vertex-index lists
cur = None

import sys
INFILE = sys.argv[1] if len(sys.argv) > 1 else "Home_Mockup_1st_Floor.obj"
OUTFILE = sys.argv[2] if len(sys.argv) > 2 else "/tmp/floorplan.svg"
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

def footprint(groups_pred):
    """Return list of (minx,minz,maxx,maxz) footprints for matching groups."""
    out = []
    for g, faces in group_faces.items():
        if not groups_pred(g):
            continue
        xs, zs = [], []
        for face in faces:
            for i in face:
                x, y, z = verts[i-1]
                xs.append(x); zs.append(z)
        if xs:
            out.append((min(xs), min(zs), max(xs), max(zs)))
    return out

walls = footprint(lambda g: g.startswith("wall_"))
rooms = footprint(lambda g: g.startswith("room_"))

# overall extent
allx = [c for w in walls+rooms for c in (w[0], w[2])]
allz = [c for w in walls+rooms for c in (w[1], w[3])]
minx, maxx = min(allx), max(allx)
minz, maxz = min(allz), max(allz)
W = maxx - minx
H = maxz - minz
print(f"extent: {W:.0f} x {H:.0f} sweet-home-units (mm); walls={len(walls)} rooms={len(rooms)}")

# emit SVG in a 0..1000 normalized viewBox, preserving aspect
PAD = 40
scale = (1000 - 2*PAD) / max(W, H)
def tx(x): return PAD + (x - minx) * scale
def tz(z): return PAD + (z - minz) * scale
vbW = 2*PAD + W*scale
vbH = 2*PAD + H*scale

parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vbW:.1f} {vbH:.1f}" preserveAspectRatio="xMidYMid meet">']
parts.append(f'<rect x="0" y="0" width="{vbW:.1f}" height="{vbH:.1f}" fill="#0f1117"/>')
# rooms (subtle floor)
for (x0,z0,x1,z1) in rooms:
    parts.append(f'<rect x="{tx(x0):.1f}" y="{tz(z0):.1f}" width="{(x1-x0)*scale:.1f}" height="{(z1-z0)*scale:.1f}" fill="#1a2130" opacity="0.5"/>')
# walls (solid)
for (x0,z0,x1,z1) in walls:
    w = max((x1-x0)*scale, 1.5); h = max((z1-z0)*scale, 1.5)
    parts.append(f'<rect x="{tx(x0):.1f}" y="{tz(z0):.1f}" width="{w:.1f}" height="{h:.1f}" fill="#3a4358"/>')
parts.append('</svg>')

svg = "\n".join(parts)
open(OUTFILE,"w").write(svg)
print(f"svg viewBox: {vbW:.0f} x {vbH:.0f}, bytes: {len(svg)}")
