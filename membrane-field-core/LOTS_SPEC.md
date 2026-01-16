# Lots System Specification

> **Purpose:** Define lot data schema, region stamping, and scenario integration.
> **Non-goal:** Solver mechanics. Lots define *data + parameters*; FIELD_AUTHORITY defines evolution.

---

## Overview

Lots are physical zones (yards, staging areas, toll points) that define `RegionDef` parameters applied by the field solver. Each lot maps to a region with specific conductance, storage, capacity, and conversion behavior.

**Lots do not "apply friction" or "reduce velocity" directly.** They define RegionDef parameters; the solver consumes those parameters according to FIELD_AUTHORITY.

---

## Data Pipeline

```
KMZ file (Google Earth)
    ↓ scripts/convert_kmz_to_lots.py
lots.json (lat/lon polygons + KMZ comments)
    ↓ manual classification
lots.json (with region_id assignments)
    ↓ lotsLoader.js
microGeometry (cell masks / region stamping)
    ↓
overlay consumes compiled regionMap
```

---

## 1. Canonical `lots.json` Schema

Maps 1:1 to `RegionDef` + optional `ConversionRule` references.

```json
{
  "version": "1.0",
  "generated": "2025-12-17",
  "source_kmz": "reynosa_lots.kmz",

  "transform": {
    "origin_lat": 26.06669701044433,
    "origin_lon": -98.20517760083658,
    "meters_per_deg_lat": 111320,
    "meters_per_deg_lon": 99996.88,
    "notes": "PHARR POE is coordinate origin (0,0). Same as bundle transform."
  },

  "lots": [
    {
      "id": "lot_001",
      "name": "Original name from KMZ",
      "comment": "Original description from KMZ",

      "region_id": "tier3_scatter_001",
      "type": "tier3_scatter",

      "polygons": [
        {
          "coordinates": [
            [26.052, -98.210],
            [26.054, -98.210],
            [26.054, -98.208],
            [26.052, -98.208]
          ]
        }
      ],

      "region_params": {
        "base_conductance": 0.3,
        "allow_flow": true,
        "is_storage": true,
        "capacity_kg": null
      },

      "conversion_rule_ids": ["yard_transfer"],

      "priority": 10
    }
  ]
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique lot identifier |
| `region_id` | string | Maps to RegionDef.id |
| `type` | string | Lot type preset (see Section 2) |
| `polygons` | array | Array of polygon coordinate arrays |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | "" | Original KMZ name |
| `comment` | string | "" | Original KMZ description |
| `region_params` | object | from type preset | Override RegionDef params |
| `conversion_rule_ids` | string[] | from type preset | ConversionRules active in this lot |
| `priority` | number | 0 | Overlap precedence (higher wins) |

---

## 2. Lot Type Presets (RegionDef Parameter Sets)

| Type | base_conductance | allow_flow | is_storage | capacity_kg | conversion_rule_ids | Human Feel |
|------|------------------|------------|------------|-------------|---------------------|------------|
| `corridor` | 1.0 | true | false | null | [] | Open road |
| `tier3_scatter` | 0.3 | true | true | null | [] | Chaotic informal |
| `transfer_yard` | 0.6 | true | true | null | ["yard_transfer"] | Standard facility |
| `inovus_t1` | 0.85 | true | true | 500000 | ["yard_transfer"] | Efficient Tier-1 |
| `toll_bottleneck` | 0.5 | true | false | null | [] | Point friction |
| `storage` | 0.1 | true | true | 1000000 | [] | Long-term storage |
| `barrier` | 0.0 | false | false | null | [] | No flow |

**"Human Feel" is derived, not authoritative.** The solver uses `base_conductance` and `allow_flow`.

---

## 3. Overlap and Precedence Rules

When polygons overlap, conflicts are resolved deterministically:

1. **Priority field wins**: Higher `priority` value takes precedence
2. **Tie-breaker**: If equal priority, lower `base_conductance` wins (more restrictive)
3. **Final tie-breaker**: Lexicographic sort by `id`

```javascript
// Stamping order: sort by (priority DESC, base_conductance ASC, id ASC)
// Last stamp wins, so stamp in reverse priority order
sortedLots = lots.sort((a, b) => {
  if (a.priority !== b.priority) return a.priority - b.priority;  // low first
  if (a.base_conductance !== b.base_conductance) return b.base_conductance - a.base_conductance;
  return b.id.localeCompare(a.id);
});
// Stamp in order: lowest priority first, highest last (wins)
```

---

## 4. Polygon Stamping

### Algorithm: Point-in-polygon (ray casting)

```javascript
function stampLot(lot, regionMap, regionIdToU8) {
  const regionU8 = regionIdToU8[lot.region_id];

  for (const polygon of lot.polygons) {
    const worldCoords = polygon.coordinates.map(([lat, lon]) => latLonToWorld(lat, lon));
    const fieldPoly = worldCoords.map(p => ({
      x: worldToFieldX(p.x),
      y: worldToFieldY(p.y)
    }));

    // Bounding box
    const minX = Math.floor(Math.min(...fieldPoly.map(p => p.x)));
    const maxX = Math.ceil(Math.max(...fieldPoly.map(p => p.x)));
    const minY = Math.floor(Math.min(...fieldPoly.map(p => p.y)));
    const maxY = Math.ceil(Math.max(...fieldPoly.map(p => p.y)));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (x < 0 || x >= N || y < 0 || y >= N) continue;
        if (pointInPolygon(x + 0.5, y + 0.5, fieldPoly)) {
          regionMap[y * N + x] = regionU8;
        }
      }
    }
  }
}
```

### Small Polygon Handling

Lots smaller than 1 cell are stamped to the containing cell (minimum 1 cell coverage).

---

## 5. Region ID Mapping (Uint8 Packing)

`regionMap` is `Uint8Array` (max 255 region types). Stable mapping table:

| Uint8 | region_id | Notes |
|-------|-----------|-------|
| 0 | corridor | Default (unstamped cells) |
| 1 | yard_main | Legacy single yard |
| 2 | tier3_scatter | Informal lots |
| 3 | transfer_yard | Standard facilities |
| 4 | inovus_t1 | Efficient Tier-1 |
| 5 | toll_bottleneck | Toll/inspection points |
| 6 | storage | Long-term storage |
| 7 | barrier | No flow |
| 8-255 | reserved | Future use |

**Implementation detail:** The Uint8 encoding is for efficiency. Stable IDs ensure deterministic behavior across sessions.

---

## 6. Scenario Integration

Scenarios modify RegionDef parameters, not "velocity" or "friction" directly.

### Scenario Overrides (explicit, unit-safe)

```javascript
const scenarioOverrides = {
  yardFormalization: {
    // Reduce chaos in tier3 lots: conductance 0.3 → 0.5
    tier3_scatter: {
      base_conductance: (base, yardFormalization) => base + 0.2 * yardFormalization
    }
  },

  inovusEnabled: {
    // Enable/disable Inovus T1 lots
    inovus_t1: {
      allow_flow: (base, inovusEnabled) => inovusEnabled
    }
  }
};
```

### What scenarios can modify:

| Parameter | Modifiable | Notes |
|-----------|------------|-------|
| base_conductance | Yes | Must stay in [0, 1] |
| allow_flow | Yes | Boolean |
| is_storage | No | Fixed per lot type |
| capacity_kg | Yes | Can increase/decrease |
| conversion_rule_ids | Yes | Can enable/disable rules |

### What scenarios cannot do:

- Change lot geometry
- Add/remove lots dynamically (static lot set)
- Modify region_id assignments

---

## 7. QA Checklist

### Polygon Validity

- [ ] All polygons closed (first point = last point, or auto-close)
- [ ] No self-intersecting polygons
- [ ] All coordinates within ROI bounds
- [ ] No degenerate polygons (< 3 vertices)

### Region Coverage Stats

- [ ] Log: `stamped X cells across Y lots`
- [ ] Log: `region distribution: corridor=N, tier3=M, ...`
- [ ] Warn if any lot stamps 0 cells

### Overlap Diagnostics

- [ ] Count overlapping cells
- [ ] Log precedence decisions for overlaps
- [ ] Warn if >10% of lot cells overlap

### Deterministic Stamping

- [ ] Hash of regionMap after stamping (for regression testing)
- [ ] Same lots.json → same regionMap (deterministic)

### Orphan Detection

- [ ] No region_ids in lots.json missing from mapping table
- [ ] No Uint8 values in regionMap missing from mapping table

---

## 8. Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `scripts/convert_kmz_to_lots.py` | CREATE | KMZ → JSON converter |
| `lots.json` | CREATE | Lot polygon data |
| `overlay/lotsLoader.js` | CREATE | JSON loader + coordinate transform |
| `overlay/microGeometry.js` | MODIFY | stampAllLots(), regionMap stamping |
| `engine/classSystem.js` | MODIFY | Add new RegionDef presets |
| `FIELD_AUTHORITY.md` | UPDATE | Add region_id mapping table to Section J |

---

## 9. Conversion Script: `convert_kmz_to_lots.py`

### Behavior

1. Unzip KMZ → extract doc.kml
2. Parse KML Placemarks with Polygon geometry
3. Handle coordinate order: KML uses `lon,lat,alt` → output `[lat, lon]`
4. Extract name → `name` field
5. Extract description → `comment` field
6. Generate unique IDs: `lot_001`, `lot_002`, ...
7. Set `type: null` (manual classification required)
8. Output JSON with transform matching bundle

### Usage

```bash
python scripts/convert_kmz_to_lots.py input.kmz --output lots.json
```

---

## 10. Performance: Sparse Iteration

Graph flow iterates `roadCellIndices` (cells with K > K_THRESHOLD), not all N² cells.

**Implication:** Lots must have K > 0 to be included in the flow iteration.

### Off-Road Lots (Parking Areas, Yards)

Lots that are not on the main road network need **secondary road connections** with lower K:

```
Main road (K = 1.0) ───────────────────────
                          │
                     K = 0.3 (access road)
                          │
              ┌───────────┴───────────┐
              │   TIER3_SCATTER LOT   │
              │      K = 0.3          │
              │   regionMap = 2       │
              └───────────────────────┘
```

**Stamping order:**
1. Stamp main roads from bundle (K = 1.0)
2. Stamp lot polygons with lower K (e.g., K = 0.3 for yards)
3. Stamp access roads connecting lots to main network (same K as lot)

**Result:**
- Lot cells have K > 0 → included in `roadCellIndices`
- Lot cells have regionMap set → conductance lookup works
- Dijkstra reaches lot cells via access roads → nextHop valid
- Mass flows into/out of lots via access roads

### Sparse Index Rebuild

`roadCellIndices` must be rebuilt when:
- K tensor changes (geometry/scenario)
- Lots are stamped

```javascript
function rebuildRoadCellIndices() {
    roadCellIndices.length = 0;
    for (let idx = 0; idx < N2; idx++) {
        if (Kxx[idx] > K_THRESHOLD || Kyy[idx] > K_THRESHOLD) {
            roadCellIndices.push(idx);
        }
    }
    console.log(`[SPARSE] roadCellIndices: ${roadCellIndices.length} cells`);
}
```

**Performance:** O(roadCells) instead of O(N²) = ~25x speedup on graph flow hot path.

---

## Open Questions

### Data
- [ ] How many lots in KMZ?
- [ ] Size distribution of lots?
- [ ] Any multi-polygon lots?

### Classification
- [ ] Classification criteria for each lot type?
- [ ] Which lots need conversion rules?
- [ ] Default type for unclassified lots?

### Scenarios
- [ ] Full list of scenario toggles that affect lots?
- [ ] Parameter ranges for each toggle?

### Off-Road Lots
- [ ] Which lots need access roads drawn?
- [ ] Default K value for lot interiors? (0.3 suggested)
- [ ] Access road width (cells)?

---

## 11. Polygon Rendering

Lots must be drawn as visible polygons, not just as cell-based regions. This requires storing polygon vertices (not just rasterized cells).

### Data Flow

```
lots.json (lat/lon polygons)
    ↓ lotsLoader.js
{ cells: [...], polygons: [{worldCoords: [...], fieldCoords: [...]}] }
    ↓
drawLots(ctx, camera) renders polygons
```

### Modified `loadLots()` Return Value

```javascript
// Current (lossy):
return { lots: [{ id, name, cells }], totalCells }

// Required (preserves geometry):
return {
  lots: [{
    id: string,
    name: string,
    cells: number[],           // rasterized cells for physics
    polygons: [{
      worldCoords: {x, y}[],   // meters from PHARR origin
      fieldCoords: {x, y}[]    // field cell units (for viewport culling)
    }]
  }],
  totalCells: number
}
```

### Rendering Implementation

```javascript
// In reynosaOverlay.js
let _loadedLots = null;  // Store lot data for rendering

async function initLots() {
    const { lots, totalCells } = await loadLots(lotsJsonPath, roi, N);
    _loadedLots = lots;  // <-- preserve for rendering
    stampLots(lots, regionMap, REGION_LOT);
    lotCellIndices = buildLotCellIndices(regionMap, REGION_LOT, N2);
    // ...
}

function drawLots(ctx, camera) {
    if (!_loadedLots || !camera?.worldToScreen) return;

    ctx.save();
    ctx.strokeStyle = '#4A90D9';
    ctx.fillStyle = 'rgba(74, 144, 217, 0.15)';
    ctx.lineWidth = 1;

    for (const lot of _loadedLots) {
        for (const poly of lot.polygons) {
            // Viewport culling using fieldCoords bounding box
            // (skip if entirely outside viewport)

            ctx.beginPath();
            const first = camera.worldToScreen(poly.worldCoords[0].x, poly.worldCoords[0].y);
            ctx.moveTo(first.x, first.y);

            for (let i = 1; i < poly.worldCoords.length; i++) {
                const pt = camera.worldToScreen(poly.worldCoords[i].x, poly.worldCoords[i].y);
                ctx.lineTo(pt.x, pt.y);
            }

            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }
    }
    ctx.restore();
}
```

### Rendering Options

| Option | Value | Effect |
|--------|-------|--------|
| Fill color | `rgba(74, 144, 217, 0.15)` | Semi-transparent blue |
| Stroke color | `#4A90D9` | Blue outline |
| Line width | 1-2 px | Visible at all zoom levels |
| Viewport culling | Yes | Skip lots outside camera bounds |

### Call Site

```javascript
// In draw() or drawLocalField()
if (showLots && _loadedLots) {
    drawLots(ctx, camera);
}
```

---

## 12. Particle-Lot Interaction

Particles must visually "enter" lots and potentially change state or be absorbed. This creates visual correspondence between field physics (conversion in lots) and particle visualization.

### Interaction Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| **Pass-through** | Particles traverse lots normally | Lots as regions, no special behavior |
| **State change** | Particles change color in lot cells | Visualize "conversion" process |
| **Absorption** | Particles die when entering lot cells | Lots as secondary sinks |
| **Dwell** | Particles slow down and linger in lots | Visualize processing time |

### Recommended: State Change Mode

Particles change visual state (color) when entering lot cells, then continue to sink. This mirrors the field physics (rho_restricted → rho_cleared conversion).

```javascript
// In particle update loop
const idx = cellY * N + cellX;
const inLot = regionMap[idx] === REGION_LOT;

// State transition: first time entering a lot
if (inLot && !p.converted) {
    p.converted = true;
    // Particle is now "cleared" - visual feedback
}

// Draw with different colors based on state
function draw(ctx, camera) {
    for (const p of particles) {
        const color = p.converted ? '#00AA00' : '#AA0000';  // green vs red
        // ... draw particle with color
    }
}
```

### Alternative: Absorption Mode

Particles die when entering lot cells (lots act as secondary sinks). Simpler but less physically accurate.

```javascript
// In particle update loop
if (regionMap[idx] === REGION_LOT) {
    _lotDeaths++;
    p.life = -1;
    continue;
}
```

### Particle-Lot Death Tracking

Add `lotDeaths` to the particle death log for debugging:

```javascript
console.log(`[PARTICLE] ... deaths(sink=${_sinkDeaths} lot=${_lotDeaths} age=${_ageDeaths} ...)`);
```

### Pull Effect (Optional)

To make lots visually "pull" particles, modify nextHop routing to prefer paths through lots. This is complex and may not be needed if state-change mode provides sufficient visual feedback.

**NOT RECOMMENDED** for initial implementation - adds complexity without proportional benefit.

---

## 13. Implementation Checklist

### Phase 1: Polygon Rendering
- [ ] Modify `loadLots()` to return polygon vertices (worldCoords, fieldCoords)
- [ ] Store `_loadedLots` in reynosaOverlay.js
- [ ] Implement `drawLots(ctx, camera)` with viewport culling
- [ ] Add `showLots` toggle to UI/debug menu
- [ ] Verify polygons render at correct positions

### Phase 2: Particle State Change
- [ ] Add `converted: boolean` field to particle objects
- [ ] Check `regionMap[idx] === REGION_LOT` in particle update
- [ ] Set `p.converted = true` on first lot entry
- [ ] Modify particle draw to use different color for converted particles
- [ ] Add `lotDeaths` counter if using absorption mode

### Phase 3: Visual Polish
- [ ] Tune lot fill/stroke colors
- [ ] Add lot labels (optional)
- [ ] Animate particles during state change (optional)
- [ ] Add "conversion in progress" glow effect (optional)

---

## 14. Stochastic Conversion Model

Conversion from `rho_restricted` → `rho_cleared` in lots uses a **two-population stochastic model** rather than a deterministic rate. This produces realistic variance in throughput.

### Physical Interpretation

Cargo in lots consists of two implicit populations:
- **Perishables (50%)** - Fresh produce, time-sensitive goods. Clear faster.
- **General cargo (50%)** - Standard freight. Longer processing time.

Each population has an expected dwell time τ (tau), representing average time before customs clearance.

### Parameters

| Parameter | Symbol | Value | Units | Notes |
|-----------|--------|-------|-------|-------|
| Perishable fraction | `PERISHABLE_FRACTION` | 0.50 | dimensionless | 50/50 split |
| Perishable dwell time | `TAU_PERISHABLE_S` | 129,600 | seconds | 36 hours |
| General dwell time | `TAU_GENERAL_S` | 216,000 | seconds | 60 hours |

### Conversion Probability

Per timestep dt, the probability that a unit of mass converts is:

```
p = dt / τ
```

For dt = 1000s (typical sim tick) and τ = 129600s:
- p_perishable = 1000 / 129600 ≈ 0.0077 (0.77% per tick)
- p_general = 1000 / 216000 ≈ 0.0046 (0.46% per tick)

### Stochastic Sampling

Instead of converting exactly `M * p` mass each tick (deterministic), we sample from a **binomial distribution**. For efficiency, we use the **normal approximation to binomial**:

```
Binomial(M, p) ≈ Normal(μ = Mp, σ² = Mp(1-p))
```

This introduces realistic variance: some timesteps convert more, some less, but the expected value is the same as deterministic.

### Algorithm

```javascript
function applyConversions(dt) {
    const p_perishable = dt / TAU_PERISHABLE_S;
    const p_general = dt / TAU_GENERAL_S;

    for (const i of lotCellIndices) {
        const M = rho_restricted[i];
        if (M <= 0) continue;

        // Split into populations (implicit, not tracked separately)
        const M_perishable = M * PERISHABLE_FRACTION;
        const M_general = M * (1 - PERISHABLE_FRACTION);

        // Normal approximation to binomial: N(μ, σ²)
        const exp_p = M_perishable * p_perishable;
        const var_p = M_perishable * p_perishable * (1 - p_perishable);
        const exp_g = M_general * p_general;
        const var_g = M_general * p_general * (1 - p_general);

        // Sample from normal, clamp negative
        const converted_p = Math.max(0, exp_p + Math.sqrt(var_p) * randn());
        const converted_g = Math.max(0, exp_g + Math.sqrt(var_g) * randn());

        // Clamp to available mass (conservation invariant)
        const totalConverted = Math.min(converted_p + converted_g, M);

        rho_restricted[i] -= totalConverted;
        rho_cleared[i] += totalConverted;
    }
}
```

### PRNG Implementation

Reproducible stochastic behavior requires a seeded PRNG:

```javascript
// LCG (Linear Congruential Generator)
let _prngSeed = 12345;
function seededRandom() {
    _prngSeed = (_prngSeed * 1103515245 + 12345) & 0x7fffffff;
    return _prngSeed / 0x7fffffff;
}

// Box-Muller transform for N(0,1)
function randn() {
    const u1 = seededRandom();
    const u2 = seededRandom();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
```

### Invariants

| Invariant | How Enforced |
|-----------|--------------|
| Mass conservation | `totalConverted ≤ M` clamping |
| Non-negative mass | `Math.max(0, ...)` on sampled values |
| Reproducibility | Seeded PRNG with fixed seed |

### Expected Behavior

| Aspect | Deterministic Model | Stochastic Model |
|--------|---------------------|------------------|
| Per-tick conversion | Exactly M*p | Random, E[X] = M*p |
| Variance | 0 | M*p*(1-p) |
| Visual effect | Smooth drainage | Lumpy, realistic |
| Long-run throughput | Same | Same (by law of large numbers) |

### Tuning Guidelines

| To achieve... | Adjust... |
|---------------|-----------|
| Faster overall clearance | Decrease τ values |
| More variance (lumpier) | Increase M (more mass per cell) |
| Less variance | Increase τ (lower p, tighter normal) |
| Different cargo mix | Change PERISHABLE_FRACTION |

### Future Extensions

- **Track populations explicitly**: Separate `rho_perishable` and `rho_general` arrays
- **Different τ by lot type**: Inovus lots could have lower τ (faster processing)
- **Capacity-constrained conversion**: Max conversion rate per lot per tick
- **Queue priority**: Perishables get priority when capacity-constrained

---

## 15. Dual-Potential Routing Authority

Lots are sinks for restricted mass. This requires a **dual-potential system** where:
- `φ_pharr` routes **cleared** mass toward PHARR (export)
- `φ_lots` routes **restricted** mass toward lots (transfer dwell)

### Routing Invariants

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| A | Restricted mass routes to lots, not PHARR | `nextHop_lots` derived from `φ_lots` |
| B | Cleared mass routes to PHARR, not lots | `nextHop_pharr` derived from `φ_pharr` |
| C | Class determines routing table | `nh = (class=='restricted') ? nextHop_lots : nextHop_pharr` |
| D | Lots are traversable | K_LOT = 0.4 stamped on lot cells |
| E | Lots are reachable | Connector cells bridge lots to roads |
| F | Restricted dwells in lots | Particles stop moving when in lot cell |
| G | Only cleared drains at PHARR | `drainRestricted = !_yardEnabled` |
| H | Conversion flips class | `rho_restricted` → `rho_cleared` in lots |

### Class-Conditioned Routing

```javascript
function graphFlowClass(classId, rho, rhoNext) {
    // SELECT ROUTING TABLE
    const nh_table = (classId === 'restricted') ? nextHop_lots : nextHop_pharr;

    for (const idx of roadCellIndices) {
        const m = rho[idx];
        const nh = nh_table[idx];

        if (nh >= 0) {
            const out = m * FLOW_FRAC;
            rhoNext[nh] += out;
            rhoNext[idx] += (m - out);
        } else {
            rhoNext[idx] += m;  // At sink or dead-end
        }
    }
}
```

### Dual Potential Computation

```javascript
async function rebuildPhiBase() {
    // 1. PHARR potential (cleared → PHARR)
    await computePotentialToSinks(sinkCellIndices, phi_pharr, 'PHARR');

    // 2. Lot potential (restricted → lots)
    await computePotentialToSinks(lotCellIndices, phi_lots, 'LOTS');

    // 3. Build next-hop tables
    roadCellIndices = buildNextHopFromPhi(phi_pharr, nextHop_pharr, 'PHARR');
    buildNextHopFromPhi(phi_lots, nextHop_lots, 'LOTS');
}
```

---

## 16. Lot Connectivity and Traversability

### The Problem

Lots are geographic polygons from KMZ data. They may not overlap with road geometry:

```
Road cells (K=1.0) ═══════════════════════════
                            │
                       GAP (K=0)
                            │
                    ┌───────┴───────┐
                    │   LOT CELLS   │
                    │    (K=0?)     │
                    └───────────────┘
```

If lot cells have K=0:
- `isRoad(idx)` returns false → not in `roadCellIndices`
- `nextHop_lots[idx] = -1` → no valid routing
- Mass/particles can't reach lots

### Solution: K Stamping + Connectivity Bridging

**Step 1: Stamp K for lot cells**

```javascript
const K_LOT = 0.4;  // Reduced conductance (dwell zone)
for (const idx of lotCellIndices) {
    Kxx[idx] = K_LOT;
    Kyy[idx] = K_LOT;
}
```

**Step 2: Bridge disconnected lots to roads**

```javascript
const K_CONNECTOR = 0.2;

for (const lotIdx of lotCellIndices) {
    // Check if already adjacent to road (8-connected)
    if (hasRoadNeighbor(lotIdx)) continue;

    // BFS to find nearest road (no distance limit)
    // Track parent pointers for path reconstruction
    const parent = new Map();
    parent.set(lotIdx, -1);
    let frontier = [lotIdx];
    let foundCell = -1;

    while (foundCell < 0 && frontier.length > 0) {
        // BFS expansion...
        // When road found: foundCell = roadCellIdx
    }

    // Backtrack from road to lot, stamp only the shortest path
    if (foundCell >= 0) {
        let current = parent.get(foundCell);
        while (current >= 0 && current !== lotIdx) {
            if (regionMap[current] !== REGION_LOT) {
                Kxx[current] = K_CONNECTOR;
                Kyy[current] = K_CONNECTOR;
            }
            current = parent.get(current);
        }
    }
}
```

**Key:** Only the shortest path is stamped, not all explored cells.

### Resulting Connectivity

```
Road cells (K=1.0) ═══════════════════════════
                            │
                    Connector (K=0.2)
                            │
                    ┌───────┴───────┐
                    │   LOT CELLS   │
                    │    (K=0.4)    │
                    └───────────────┘
```

### Verification Logging

```
[LOTS] Stamped K=0.4 for 182 lot cells
[LOTS] Bridged 47 connector cells (K=0.2), max path length=12
[LOTS] Marked phi dirty - dual potentials will rebuild with lot sinks
[FIELD] Road connectivity: PHARR=25000/26000 LOTS=25500/26000
```

---

## 17. Particle Dwell Invariant

### The Problem

When a restricted particle reaches a lot cell:
- `nextHop_lots[lot_idx] = -1` (lot is a sink for φ_lots)
- The "neighbor snap" code might push the particle away
- Particle oscillates or dies at wrong location

### Solution: Explicit Dwell Rule

```javascript
// In particle update loop
const idx = cellY * N + cellX;
const pClass = p.classId || 'cleared';

// DWELL INVARIANT: Restricted particles in lots do NOT move
if (pClass === 'restricted' && regionMap[idx] === REGION_LOT) {
    // Dwell in lot - no movement, just age
    p.px = p.x;
    p.py = p.y;
    p.age += realDt;
    if (p.age >= p.life) {
        p.life = -1;  // Age death
    }
    continue;  // Skip all movement logic
}
```

### Behavior

1. Restricted particle spawns at corridor entry
2. Follows `nextHop_lots` toward nearest lot
3. Enters lot cell → **stops moving** (dwell)
4. Conversion flips `classId` to `'cleared'` (handled by mass conversion, not particle system)
5. Cleared particle follows `nextHop_pharr` toward PHARR
6. Dies at PHARR sink

### Visual Result

- Restricted particles (red) flow toward lots, accumulate visibly
- Cleared particles (green) flow from lots toward PHARR
- Lots appear as "collection points" where particles dwell

---

## 18. Initialization Timing

### The Challenge

`initLots()` is async. The dual potentials might be computed before lots finish loading.

### Sequence

```
Frame 0: onAttach()
├── bakeKTensor()           ← Roads stamped
├── stampPharrSink()        ← PHARR sink ready
└── initLots() [ASYNC]      ← Starts loading lots.json

Frame 1: updateMultiClassPhysics()
└── rebuildPhiBase()        ← phi_lots has empty sinks (OK - handled gracefully)

Frame N: initLots() resolves
├── stampLots()             ← regionMap updated
├── Stamp K_LOT             ← Lot cells traversable
├── Bridge to roads         ← Connectors stamped
└── phiBaseDirty = true     ← Trigger rebuild

Frame N+1: updateMultiClassPhysics()
└── rebuildPhiBase()        ← phi_lots now has lot sinks ✓
```

### Graceful Handling

```javascript
async function computePotentialToSinks(sinkIndices, phiOutput, label) {
    phiOutput.fill(PHI_LARGE);

    if (sinkIndices.length === 0) {
        console.log(`[DIJKSTRA ${label}] No sinks, skipping`);
        return { reachable: 0 };  // Graceful early return
    }
    // ... Dijkstra computation
}
```

---

## 19. Debug Logging

### Routing Stats (every ~2 seconds)

```
[ROUTING] restricted→lots: 12.5t moved, 0.3t stuck | cleared→pharr: 8.2t moved, 0.1t stuck
[LOTS] in_lots: 45.2t restricted (35% of total), 12.1t cleared | conversion: 2.3t/hr
[PARTICLES] 1200 restricted (62%), 450 in lots (38%), 720 cleared | total=1920
```

### Key Metrics

| Metric | Meaning | Healthy Range |
|--------|---------|---------------|
| `restricted→lots moved` | Restricted mass flowing toward lots | > 0 |
| `restricted→lots stuck` | Restricted mass at dead-ends | < 5% of moved |
| `in_lots restricted %` | Fraction of restricted mass in lots | Rising after injection |
| `particles in lots %` | Fraction of restricted particles dwelling | 30-50% at steady state |

### Failure Indicators

| Symptom | Likely Cause |
|---------|--------------|
| `in_lots: 0t restricted` | Lots not connected to road network |
| `restricted→lots stuck` high | Dead-ends in lot routing graph |
| `particles in lots: 0%` | Dwell invariant not working |
| `conversion: 0t/hr` | `_yardEnabled = false` |

---

## 20. Acceptance Tests

### T1: Eligibility Gating

**Setup:** Disable conversion, inject restricted mass
**Expect:** Restricted accumulates in lots, never drains at PHARR
**Verify:** `[DRAIN DEBUG] drainRestricted=false`

### T2: Lot Reachability

**Setup:** Inject restricted mass at corridor entry
**Expect:** `in_lots restricted %` rises over time
**Verify:** `[LOTS] in_lots: Xt restricted (Y% of total)` where Y > 0

### T3: Conversion Gate

**Setup:** Enable conversion, accumulate restricted in lots
**Expect:** `rho_cleared` in lots increases, `rho_restricted` decreases
**Verify:** `conversion: Zt/hr` where Z > 0

### T4: Post-Conversion Routing

**Setup:** Mass converts in lot
**Expect:** Cleared mass flows toward PHARR (exits lot)
**Verify:** `cleared→pharr moved` > 0

### T5: Particle Dwell

**Setup:** Inject particles, wait for lot arrival
**Expect:** Restricted particles stop in lot cells
**Verify:** `particles in lots (X%)` where X > 0

---

## 21. Lot Capacity System

### The Problem

Without capacity constraints, all restricted mass routes to the **nearest** lot (lowest φ_lots). This produces unrealistic concentration:

```
[LOTS CAPACITY] lot_001: 2500t (500% capacity) ← All mass here
[LOTS CAPACITY] lot_002: 0t (0% capacity)
[LOTS CAPACITY] lot_003: 0t (0% capacity)
```

Real yards have finite capacity. Once full, trucks must route to alternative locations.

### Solution: Dynamic Sink Exclusion

When a lot reaches capacity threshold (90%), exclude it from `φ_lots` computation. This makes other lots "closer" to incoming mass.

### Parameters

| Parameter | Symbol | Default | Units | Notes |
|-----------|--------|---------|-------|-------|
| Capacity density | `LOT_KG_PER_M2` | 50 | kg/m² | Adjustable via `setLotCapacity()` |
| Threshold | `LOT_CAPACITY_THRESHOLD` | 0.90 | ratio | 90% triggers "full" |
| Cell area | `CELL_M2` | N²/ROI² | m² | Computed from grid resolution |

### Capacity Calculation

```javascript
// Per lot
const lotCellCount = count(cells where cellToLotIndex[cell] === lotIdx);
const lotAreaM2 = lotCellCount * CELL_M2;
const lotCapacityKg = lotAreaM2 * LOT_KG_PER_M2;
```

### Data Structures

```javascript
// Cell → lot mapping
const cellToLotIndex = new Int16Array(N2);  // -1 = not a lot cell

// Per-lot arrays (indexed by lot number 0..N-1)
let lotCellCount = [];     // Cells per lot
let lotAreaM2 = [];        // Area in square meters
let lotCapacityKg = [];    // Max capacity in kg
let lotCurrentMassKg = []; // Current restricted mass
let lotIsFull = [];        // Boolean: at capacity?
```

### Utilization Update (each physics tick)

```javascript
function updateLotUtilization() {
    // Reset current mass counters
    lotCurrentMassKg.fill(0);

    // Sum restricted mass per lot
    for (const cellIdx of lotCellIndices) {
        const lotIdx = cellToLotIndex[cellIdx];
        if (lotIdx >= 0) {
            lotCurrentMassKg[lotIdx] += rho_restricted[cellIdx];
        }
    }

    // Check capacity and detect state changes
    let changed = false;
    for (let i = 0; i < lotCapacityKg.length; i++) {
        const util = lotCurrentMassKg[i] / lotCapacityKg[i];
        const wasFull = lotIsFull[i];
        lotIsFull[i] = util >= LOT_CAPACITY_THRESHOLD;

        if (lotIsFull[i] !== wasFull) changed = true;
    }

    return changed;  // True if any lot crossed threshold
}
```

### Dynamic Sink Set

```javascript
function getAvailableLotCells() {
    // Return only cells from lots that aren't full
    const available = [];
    for (const cellIdx of lotCellIndices) {
        const lotIdx = cellToLotIndex[cellIdx];
        if (lotIdx < 0 || !lotIsFull[lotIdx]) {
            available.push(cellIdx);
        }
    }
    return available;
}

// In rebuildPhiBase():
const availableLotCells = getAvailableLotCells();
await computePotentialToSinks(availableLotCells, phi_lots, 'LOTS');
```

### Phi Rebuild Trigger

When capacity state changes, trigger phi rebuild:

```javascript
function updateMultiClassPhysics(dt) {
    const capacityChanged = updateLotUtilization();
    if (capacityChanged) {
        phiBaseDirty = true;
        console.log(`[LOTS CAPACITY] Lot capacity state changed, triggering phi rebuild`);
    }
    // ... rest of physics
}
```

### Debug Logging

```
[LOTS CAPACITY] lot_001 "Yard Norte": 45.2t / 100.0t (45.2%)
[LOTS CAPACITY] lot_002 "Transfer Point": 89.5t / 100.0t (89.5%) ← near full
[LOTS CAPACITY] lot_003 "Scatter Yard": 95.1t / 100.0t (95.1%) FULL
[LOTS CAPACITY] 1/3 lots full, phi_lots will route to 2 available lots
```

### API Functions

```javascript
// Set capacity density (triggers recalculation)
setLotCapacity(kgPerM2);  // e.g., setLotCapacity(100) for 100 kg/m²

// Get current capacity density
getLotCapacity();  // Returns LOT_KG_PER_M2

// Get detailed lot stats
getLotStats();
// Returns: {
//   count: 85,
//   kgPerM2: 50,
//   fullCount: 12,
//   lots: [{
//     index: 0,
//     name: "Yard Norte",
//     cells: 24,
//     areaM2: 2400,
//     capacityKg: 120000,
//     currentKg: 45200,
//     utilization: 0.377,
//     isFull: false
//   }, ...]
// }
```

### Behavior Summary

| Lot State | Effect on φ_lots |
|-----------|------------------|
| Below 90% | Included as sink → attracts restricted mass |
| At/above 90% | Excluded from sinks → mass routes elsewhere |
| All lots full | φ_lots has no sinks → restricted mass stops at nearest point |

### Capacity Distribution

With capacity enabled, mass distributes across lots based on:
1. **Distance** - Closer lots fill first
2. **Capacity** - Larger lots (more cells) hold more mass
3. **Availability** - Full lots redirect flow to alternatives

### Tuning Guidelines

| To achieve... | Adjust... |
|---------------|-----------|
| Higher lot throughput | Increase `LOT_KG_PER_M2` |
| Faster road congestion buildup | Decrease `LOT_KG_PER_M2` |

### Flow-Level Capacity Gating (v2)

**Key Change:** Capacity is now enforced at the **flow level**, not by excluding full lots from φ_lots.

- **φ_lots is static** - all lot cells are always sinks
- **Acceptance multiplier** gates inflow: `accept = max(0, 1 - fill)`
- **Rejected mass stays upstream** on roads (creates congestion)

```javascript
// In graphFlowClass, when restricted mass → lot cell:
const accept = getLotAcceptance(nh);
const accepted = out * accept;
const rejected = out - accepted;
rhoNext[nh] += accepted;      // Accepted enters lot
rhoNext[idx] += rejected;     // Rejected stays in source cell
```

**Benefits:**
1. No expensive phi rebuilds when lots fill up
2. Routing direction is stable (mass always attracted to same lots)
3. Road congestion emerges naturally upstream of full lots

### Acceptance Test: T6 - Capacity Distribution

**Setup:** Set `LOT_KG_PER_M2 = 10` (low capacity), inject restricted mass
**Expect:** Nearest lot fills, then upstream roads congest
**Verify:**
- `[ROUTING] restricted→lots: Xt moved, Yt stuck, Zt rejected`
- rejected > 0 indicates capacity gating active
- Road cells upstream of full lots accumulate mass

---

## 22. Pre-Transfer Friction Model

### Survey Basis (N=242 drivers)

From empirical survey data:
- **46%** of transfer-required drivers perform **shoulder maneuver** (1-2 hours)
- **30%** have **coordination wait ≥ 1 hour** (total 1-4 hours)

These events happen **on roads before reaching lots** - short-term friction, not storage.

### "No Roadside Storage" Invariant

**Critical:** Pre-transfer friction is NOT storage. Clearing only happens in lots.

- Shoulder maneuver = exchange event (hours)
- Coordination wait = paperwork/calls (hours)
- Lot dwell = actual storage (1-3 days)

### Parameters

| Parameter | Symbol | Value | Units |
|-----------|--------|-------|-------|
| Shoulder probability | `P_SHOULDER` | 0.46 | - |
| Shoulder duration | `T_SHOULDER` | U(1h, 2h) | seconds |
| Long coordination probability | `P_COORD_1H` | 0.30 | - |
| Long coordination duration | `T_COORD_LONG` | U(1h, 4h) | seconds |
| Short coordination duration | `T_COORD_SHORT` | U(0h, 1h) | seconds |

### Particle Pre-Delay Sampling

At particle emission, restricted particles sample total pre-delay:

```javascript
function samplePreDelay(rng) {
    let delay = 0;

    // Shoulder maneuver: 46% do it, 1-2 hours
    if (rng() < P_SHOULDER) {
        delay += T_SHOULDER_MIN_S + rng() * (T_SHOULDER_MAX_S - T_SHOULDER_MIN_S);
    }

    // Coordination wait: 30% wait ≥1h, rest wait 0-1h
    if (rng() < P_COORD_1H) {
        delay += T_COORD_LONG_MIN_S + rng() * (T_COORD_LONG_MAX_S - T_COORD_LONG_MIN_S);
    } else {
        delay += T_COORD_SHORT_MIN_S + rng() * (T_COORD_SHORT_MAX_S - T_COORD_SHORT_MIN_S);
    }

    return delay;
}
```

### Particle State Machine

| State | Condition | Behavior |
|-------|-----------|----------|
| S0: ROUTE_TO_LOT | restricted, preDelay≤0, not in lot | Follow nextHop_lots |
| S1: PRE-FRICTION | restricted, preDelay>0, not in lot | **Stall** (no movement) |
| S2: LOT_DWELL | restricted, in lot | Dwell until conversion |
| S3: ROUTE_TO_PHARR | cleared | Follow nextHop_pharr |
| S4: DRAINED | cleared, at PHARR sink | Die |

### Stall Behavior

```javascript
// In particle update loop:
if (pClass === 'restricted' && region !== LOT && p.preDelayRemainingSec > 0) {
    p.preDelayRemainingSec -= dt;  // Sim time, not wall time
    // NO MOVEMENT - particle stalls in place
    continue;
}
```

### Emergent Congestion

Pre-delay stalls cause congestion to emerge naturally:
- 46% of restricted particles stall for 1-2 hours (shoulder)
- 30% stall for additional 1-4 hours (coordination)
- Combined: some particles stall up to 6 hours on roads

Congestion accumulates where:
1. Many particles enter simultaneously
2. Geometry creates chokepoints
3. Pre-delay stalls compound density

### Acceptance Test: T7 - Pre-Transfer Friction

**Setup:** Inject restricted particles, observe before lot arrival
**Expect:** 46% show 1-2h stalls, 30% show ≥1h coordination
**Verify:**
- `[PARTICLE] ... preDelayStalls=N` where N > 0
- Particles visibly stall at corridor entry points
- Mean pre-delay across population ≈ 1-2.5 hours
