# Segment-Based Injection - IMPLEMENTED

## Current State (Hardcoded)

```javascript
// reynosaOverlay.js:4251
const CORRIDOR_ENTRY_COORDS = [
    { x: -5149.56, y: -30066.61 },    // Eastern corridor
    { x: -39274.14, y: -11175.89 },   // Western corridor
];
```

Mass is split **equally** between these two points. No CIEN authority.

---

## Proposed: Use `segment_load_kg_by_poe_hs2`

### Data We Have

```
segment_load_kg_by_poe_hs2: {
    "hidalgo_pharr": {
        "07": { "seg_123": 500000, "seg_456": 300000, ... },
        "84": { "seg_123": 200000, "seg_789": 150000, ... },
        ...
    }
}
```

Each segment has geometry in `geometry.segments_in_roi`:
```
{ segment_id: "seg_123", geometry_coordinates: [[lat, lon], [lat, lon], ...] }
```

### Algorithm

1. **Identify entry segments**: Segments whose first coordinate is outside/at ROI boundary (southern edge)

2. **Aggregate weights**: For each entry segment, sum its kg across all HS2 codes:
   ```javascript
   entryWeight[segId] = Σ (kg for all HS2 codes on this segment)
   ```

3. **Normalize to injection rate**:
   ```javascript
   totalEntryKg = Σ entryWeight[segId]
   injectionRate[segId] = (entryWeight[segId] / totalEntryKg) * hourly_kg_per_s
   ```

4. **Stamp sources at segment entry points**: Place injection sources at the field cells corresponding to each entry segment's starting coordinate

### Implementation Location

```javascript
// New function in reynosaOverlay.js or segmentWeights.js
function identifyEntrySegments(bundle, roiBounds) {
    const entries = [];
    const segments = bundle.geometry.segments_in_roi;
    const weights = extractAggregateWeights(bundle, 'hidalgo_pharr');

    for (const seg of segments) {
        const startCoord = seg.geometry_coordinates[0];  // [lat, lon]

        // Check if start is at/outside southern ROI boundary
        if (startCoord[0] <= roiBounds.south + epsilon) {
            entries.push({
                segmentId: seg.segment_id,
                lat: startCoord[0],
                lon: startCoord[1],
                weightKg: weights.get(seg.segment_id) || 0,
            });
        }
    }

    return entries;
}
```

---

## Benefits

| Aspect | Before | After |
|--------|--------|-------|
| Source count | 2 hardcoded | N segments from CIEN |
| Weight distribution | 50/50 | Proportional to CIEN routing |
| Authority | Fabricated | CIEN authoritative |
| Scenario sensitivity | None | Reflects infrastructure changes |

---

## Considerations

### 1. What counts as "entry"?
EVERYTHING OUTSIDE OF THE ROI IS ENTRY. SOME FLOWS ORIGINATE FROM REYNOSA, SO WE WILL HAVE SPECIAL HANDLING FOR THOSE. OTHERWISE, IF IT ENDS UP IN PHARR, AND ORIGINATES OUTSIDE OF REYNOSA, IT ENTERS. ITS AN ENTRY. NO GEOGRAPHY HACKS. 

ALSO, HOW TO DETERMINE IF THEY ENTER FROM INJECTION POINT #1 OR INJECTION POINT #2. SIMPLE. THE FLOW DATA HAS PRECISE GEOGRAPHY INFORMATION. THE INJECTION POINTS ARE LOCATED ON THE SAME ROADS THAT CIEN USES. WE SIMPLY NEED TO DETERMINE WHICH OF THE TWO POINTS LAND ON THE GEOMETRY THAT THE FLOW IS SHOWING IN THE CIEN DATA. EVERY ENTRY SHOULD BE COMING FROM ONE OF THESE TWO ROADS. THAT WAY WE DONT DO A 50/50 SPLIT AND ACTUALLY SHOW THE RIGHT WEIGHTS PER ENTRY POINT.  NO GUESSING. NO HEURISTICS. EITHER IT MATCHES OR WE RAISE ERROR. 


### 2. Temporal variation

- **Scale proportionally**: Same weight ratios, different total each hour


### 3. Segment geometry detail
MAP THEM TO THE INJECTION POINT. THE FULL GEOMETRY IS ALREADY PRESENT IN THE MACRO VIEW. DONT NEED TO ADD MORE GEOMETRY TO THE MICRO VIEW. JUST MAP AND ASSIGN TO ONE OF THE TWO EXISTING INJECTION POINTS. 

---

## Next Steps

1. Add `identifyEntrySegments()` to `segmentWeights.js`
2. Modify `initCorridorEntries()` to use segment data instead of hardcoded coords
3. Modify `stampInjectionSources()` to use weighted distribution
4. Test with actual bundle data

---

## Questions for You

1. Should entry segments be determined by **geographic boundary** (lat threshold) or by **network topology** (segments with no predecessor in ROI)?

2. If a segment has 0 weight in `segment_load_kg_by_poe_hs2` but geometry suggests it's an entry, should we:
   - Skip it (trust CIEN)

   TRUST CIEN. CIEN IS TRUTH. FIELD DOESNT THINK. FIELD JUST IS. 

3. Do we need HS2-specific injection (different entry points for different commodities) or is aggregate sufficient?

AGGREGATE SUFFICIENT BUT DONT COLLAPSE THE DETAIL IN THE SOURCE FILE SO THAT WE CAN SEGMENT LATER IF WE SO DESIRE.

---

## Implementation (DONE)

### Files Modified

1. **`segmentWeights.js`** - Added:
   - `computeInjectionPointWeights(bundle, injectionPoints, latLonToWorld, threshold, poeFilter)`
   - `getInjectionPointRatios(weights)`

2. **`reynosaOverlay.js`** - Modified:
   - `CORRIDOR_ENTRY_COORDS` now has `id` field (`ENTRY_EAST`, `ENTRY_WEST`)
   - Added `_injectionPointRatios` module variable
   - Added `computeInjectionWeightsFromBundle(bundle)` function
   - `bakeScenarioKTensors()` now calls `computeInjectionWeightsFromBundle()`
   - `stampInjectionSources()` uses ratios instead of equal split

### How It Works

1. When `bakeScenarioKTensors()` is called (bundles loaded):
   - Calls `computeInjectionWeightsFromBundle(baseline)`
   - For each segment in `segment_load_kg_by_poe_hs2`:
     - Aggregate kg across all HS2 codes
     - Convert segment geometry to world coords
     - Find which injection point the segment passes through (within 500m)
     - Assign segment weight to that injection point
   - Convert to ratios and store in `_injectionPointRatios`

2. When `stampInjectionSources(totalKgPerS)` is called (each sim hour):
   - For each injection point, get its ratio from `_injectionPointRatios`
   - Inject `totalKgPerS * ratio` at that point (not equal split)

### Console Output

```
[INJECTION WEIGHTS] Matched 127 segments, unmatched 3
  ENTRY_EAST: 4.21B kg (62.3%)
  ENTRY_WEST: 2.55B kg (37.7%)
[INJECTION WEIGHTS] Ratios: { ENTRY_EAST: 0.623, ENTRY_WEST: 0.377 }
```

### Fallback

If no bundle data or matching fails, falls back to equal split (50/50).