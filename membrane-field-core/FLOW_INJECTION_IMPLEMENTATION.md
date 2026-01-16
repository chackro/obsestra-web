# Flow-Based Injection - IMPLEMENTED

## Problem (Solved)

Segment geometry matching failed because:
- Upstream segments (Monterrey, Saltillo) aren't in `segments_in_roi`
- Even ROI segments may not pass within 500m of injection points
- Result: 472B kg unmatched, only 5.7B kg matched (1.2% capture rate)

## Solution

Use **flow totals by POE** instead of segment geometry matching.

## Implementation

### 1. Bundle Contract (`contracts/ReynosaOverlayBundle.js`)

Added `flow_kg_by_poe` field:
```javascript
/**
 * @typedef {Record<string, number>} FlowKgByPoe
 * @example { "hidalgo_pharr": 478000000000 }
 */
```

### 2. CIEN Export (`run_corridor_batch.py`)

Added flow totals export:
```python
if poe_tonnage:
    bundle['flow_kg_by_poe'] = poe_tonnage
```

### 3. Bundle Consumer (`overlay/bundleConsumer.js`)

Added getters:
```javascript
export function getFlowKgByPoe(poe) { ... }
export function hasFlowTotals() { ... }
```

### 4. Injection Logic (`overlay/reynosaOverlay.js`)

Rewrote `computeInjectionWeightsFromBundle()`:

```javascript
// Check for flow totals (preferred path)
const pharrFlowKg = bundle.flow_kg_by_poe?.hidalgo_pharr;
if (pharrFlowKg && pharrFlowKg > 0) {
    // Use equal split for entry points
    _injectionPointRatios = new Map([
        ['ENTRY_EAST', 0.5],
        ['ENTRY_WEST', 0.5],
    ]);
    return;
}

// Fallback: legacy segment geometry matching
```

## Key Points

1. **Total mass is correct** - comes from `bundle.inflow.hourly_kg`, not from flow totals
2. **Flow totals are for verification** - confirm CIEN's total matches what we inject
3. **Entry point split is equal** - 50/50 since flows don't carry corridor info
4. **Legacy path preserved** - old bundles without `flow_kg_by_poe` fall back to segment matching

## Expected Log Output

With new bundle:
```
[INJECTION] Using flow totals: hidalgo_pharr = 478.00B kg/year
[INJECTION] Using equal split: { ENTRY_EAST: 0.5, ENTRY_WEST: 0.5 }
```

Without flow totals (old bundle):
```
[INJECTION] No flow_kg_by_poe in bundle, falling back to segment geometry matching
[INJECTION WEIGHTS] Legacy matching: 3 matched, 992 unmatched
```

## Next Steps (Optional)

If corridor-level split is needed:
1. Add `flow_kg_by_poe_by_corridor` to bundle (from CIEN's corridor analysis)
2. Use those ratios instead of equal split
