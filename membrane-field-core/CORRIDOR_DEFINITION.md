# Corridor Definition

## What CIEN Actually Provides (The Bundle)

The bundle is created by `reynosa_overlay_export.py` in `run_corridor_batch.py`. It contains:

### Bundle Structure

```python
bundle = {
    "metadata": {
        "scenario_hash": "...",
        "layer": "layer2_infra_queue",
        "time_basis": "typical_weekday",
        "avg_kg_per_truck": 9000,
        "weekday_traffic_share": 0.85,
        "business_days_per_year": 264,
    },
    "inflow": {
        "hourly_kg": {0: 447907, 1: ..., 23: ...},  # hour → kg (total)
        "hourly_kg_by_hs2": {...},                   # optional: hour → hs2 → kg
    },
    "capacity": {
        "hourly_kg": {0: 0, 6: 712800, ..., 23: 712800},  # 0 when closed
        "params": {"s": 4, "mu": 0.33, "open_start": 6, "open_end": 24},
    },
    "geometry": {
        "pharr_coords": {"lat": 26.066, "lon": -98.205},
        "transform": {...},
        "segments_in_roi": [...],
    },
    "segment_load_kg_by_poe_hs2": {...},  # optional: added from analysis results
}
```

### Key Points

1. **CIEN gives TOTAL inflow** - not split by corridor
2. **Optional HS2 breakdown** - by product code (07=vegetables, 84=machinery, etc.)
3. **Segments with flow weights** - from CIEN routing (`segment_load_kg_by_poe_hs2`)
4. **No geographic corridor split** - MTY/VICTORIA/INTERIOR is NOT in the bundle

---

## The MTY/VICTORIA/INTERIOR Thing

This is **overlay-side only** - a visualization convenience, not CIEN data.

### Where It's Defined

```javascript
// contracts/ReynosaOverlayBundle.js:234
export const CORRIDOR_MAP = Object.freeze({
    "Nuevo Leon": "MTY",
    "Tamaulipas": "VICTORIA",
    // Everything else → "INTERIOR"
});
```

### Where It's Used

The overlay places **three injection points** as a visual approximation:

```javascript
// bundleConsumer.js:234-238
{ x: pharr.x - 3000, y: southY },  // "MTY corridor" (west)
{ x: pharr.x, y: southY },          // "Victoria corridor" (center)
{ x: pharr.x + 3000, y: southY },   // "Interior corridor" (east)
```

**This is NOT authoritative.** CIEN doesn't tell us which geographic corridor trucks use.

---

## What CIEN Actually Knows

CIEN's absorption engine knows:

1. **Origin state** - where the cargo starts (Nuevo León, Tamaulipas, etc.)
2. **Destination** - always PHARR in this simulation
3. **Product (HS2)** - what commodity is being shipped
4. **Route segments** - which road segments the truck takes
5. **Segment weights** - kg per segment (from routing model)

The `segment_load_kg_by_poe_hs2` in the bundle IS authoritative - it tells you exactly which segments carry how much weight by POE and product.

---

## Summary

| Source | Data | Authoritative? |
|--------|------|----------------|
| CIEN bundle | `hourly_kg` (total) | YES |
| CIEN bundle | `hourly_kg_by_hs2` (by product) | YES |
| CIEN bundle | `segment_load_kg_by_poe_hs2` | YES |
| Overlay | MTY/VICTORIA/INTERIOR split | NO - visual approximation |
| Overlay | Three injection points | NO - hardcoded convenience |

**If you need corridor-level breakdown, CIEN would need to add `hourly_kg_by_corridor` to the bundle.** Currently it doesn't exist.
