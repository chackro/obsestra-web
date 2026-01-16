# Injection Point Matching Issue - DIAGNOSED

## Root Cause: Coordinate System Mismatch

The segments in `segment_load_kg_by_poe_hs2` use **raw CIEN coordinates** converted via `latLonToWorld()`:
```
x: -1,210,727 m
y: -214,187 m
```

But `CORRIDOR_ENTRY_COORDS` use a **different origin** (picked from the bake/field coordinate system):
```
ENTRY_EAST: x = -5,150 m
ENTRY_WEST: x = -39,274 m
```

**Difference: ~1.2 million meters.** That's why matching fails.

---

## The Two Coordinate Systems

### 1. `latLonToWorld()` in segmentWeights matching

Uses `RENDERER_TRANSFORM`:
```javascript
origin_lat: 26.066...  (PHARR)
origin_lon: -98.205... (PHARR)
```

So for a segment at lat=24.0, lon=-99.0:
```
x = (-99.0 - (-98.205)) * 101234 = -80,490 m
y = (24.0 - 26.066) * 111320 = -229,930 m
```

### 2. `CORRIDOR_ENTRY_COORDS` (field system)

These were picked via coordinate picker on the **baked field**, which uses:
- ROI center offset
- Different origin point
- Field cell scaling

---

## Fix Options

### Option A: Convert injection points to CIEN system

Transform `CORRIDOR_ENTRY_COORDS` from field coords back to the same system `latLonToWorld()` produces.

Need to find: what transform was used when baking segments in the field.

### Option B: Convert segment coords to field system

In `computeInjectionWeightsFromBundle()`, use the same transform the bake process uses, not `latLonToWorld()`.

The bake process likely applies:
1. `latLonToWorld()`
2. Then shifts by ROI center

### Option C: Match in lat/lon space

Don't convert to world coords at all. Work in raw lat/lon:
- Convert injection point coords back to lat/lon
- Match segment lat/lon directly

---

## Next Step

Find how the bake process transforms segment coordinates. Look for the ROI center offset or secondary transform that makes:
```
-1,210,727 → -5,150  (shift of ~1.2M meters)
```

This shift is: `1,205,577 m` ≈ `10.86° longitude`

Hmm. That's suspicious. Let me check if `segments_in_roi` has lat/lon in a different format.

---

## Actually...

Wait. The segment in the bake debug shows:
```
firstPoint: { x: -1210727, y: -214187 }
```

But the injection point is:
```
ENTRY_EAST: { x: -5150, y: -30067 }
```

These are BOTH in "world meters" but with different origins!

The bake process uses segments from `getVisibleSegments()` which come from the scenario pair. Let me check if those segments already have world coords applied with a DIFFERENT transform than `RENDERER_TRANSFORM`.

**Likely culprit**: The bundle exporter (Python) might pre-transform segment coordinates with its own origin, which doesn't match the JavaScript `RENDERER_TRANSFORM`.
