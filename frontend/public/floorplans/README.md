# Floor plans

Top-down 2D floor plans for the security board, flattened from Sweet Home 3D
OBJ exports.

## Pipeline
1. Draw the floor in Sweet Home 3D, export as OBJ (File -> Export to OBJ).
2. Run the converter: `python3 backend/tools/obj2svg.py <export.obj> <out.svg>`
   (flattens walls + rooms to a top-down SVG, dropping the height axis).
3. Drop the SVG here and reference it from the security board's 2D view.

## Current
- `first_floor.svg` - from Home_Mockup_1st_Floor.obj (Sep 2026).
  Extent ~1682 x 1473 mm. 26 wall runs, 12 rooms.

## TODO (next session)
- Add a 2D top-down mode to the security board with a toggle vs the
  isometric view.
- Map the 12 seed placements onto this plan via drag-to-place; positions
  persist to sensor_placements (Postgres). Seed coords predate this plan,
  so every marker needs one manual drag to its real wall.
