# GEOMETRY & CAPACITY GROUNDING AUDIT

**Date:** 2025-12-19
**Scope:** Read-only analysis of `reynosaOverlay.js` and supporting modules
**Status:** Complete — no fixes, no recommendations

---

## EXECUTIVE SUMMARY

1. The simulation domain is **80km × 80km** discretized into a **1800 × 1800** grid yielding **~44.4m cells** with **~1,975 m² per cell**.

2. There are **98 conversion lots** (layer="lots") and **39 industrial parks** (layer="industrialParks") defined in SIG.json.

3. Lot capacity is computed as `cellCount × cellArea × LOT_KG_PER_M2` where **LOT_KG_PER_M2 = 1** (default), meaning a 10-cell lot has capacity of ~19,750 kg (≈2.2 trucks).

4. **Critical mismatch**: One truck = 9,000 kg, but even a moderately sized lot (50 cells ≈ 100,000 m²) has capacity of only 100,000 kg (≈11 trucks). Small lots (8-10 cells) can only hold 1-2 trucks by construction.

5. `depositToParkWaitZone()` bypasses all capacity checks entirely, depositing directly into `rho_restricted_lot` without gating.

6. The invariant **"utilization% > 100% must be physically impossible by construction"** is **NOT enforced**. Capacity is advisory/gating, not hard-capped.

7. There is no physical derivation linking `LOT_KG_PER_M2` to real-world truck parking density. The value appears to be a dimensionless tuning constant.

---

## PHASE 1: CELL GEOMETRY (Atomic Unit)

### 1.1 Total Simulated Domain Size

| Property | Value | Source |
|----------|-------|--------|
| Physical width | 80,000 m (80 km) | `COMPUTE_WINDOW.SIZE_M` in `renderer_interfaces.js:140` |
| Physical height | 80,000 m (80 km) | Same (square domain) |
| Source of truth | `COMPUTE_WINDOW.SIZE_M` constant | Single constant, read-only |

### 1.2 Grid Resolution

| Property | Value | Source |
|----------|-------|--------|
| N × N | 1800 × 1800 | `COMPUTE_WINDOW.RESOLUTION` in `renderer_interfaces.js:141` |
| Total cells | 3,240,000 | `N2 = N * N` |
| Meters per cell (edge) | 44.44 m | `SIZE_M / RESOLUTION = 80000/1800` |
| Square meters per cell | **1,975.31 m²** | `cellSizeM²` |

### 1.3 Cell Semantic Types

| Region Code | Meaning | Assignment Logic |
|-------------|---------|------------------|
| `REGION_CORRIDOR = 0` | Default/off-road | Initial fill of `regionMap` |
| `REGION_LOT = 1` | Conversion lot | Stamped by `stampLots()` for layer="lots" |
| (Industrial parks) | Not stamped | `industrialParks` are NOT marked in `regionMap`; physics differs |

**Cell Type Counts** (at runtime):

| Type | How Identified | Expected Count |
|------|----------------|----------------|
| Road cells | `roadCellIndices` (K > threshold) | Variable, depends on road network |
| Lot cells | `lotCellIndices` (regionMap = REGION_LOT) | Sum of lot.cells across 98 lots |
| Source cells | `sourceCellIndices` (S > 0) | Variable, based on injection stamp |
| Sink cells | `sinkCellIndices` (G > 0) | PHARR POE cells |

---

## PHASE 2: LOT GEOMETRY (Spatial Containers)

### 2.1 Lot Counts by Layer (from SIG.json)

| Layer | Count | Physics Role |
|-------|-------|--------------|
| `lots` | 98 | Conversion zones (FIFO queue, capacity tracking) |
| `industrialParks` | 39 | Injection sources (park local dwell), no capacity |
| `phases` | 10 | Render-only, not physics |
| `urbanFootprint` | 57 | Render-only (renderOnly=true) |
| `electricity` | 80 | Disabled (enabled=false) |

### 2.2 Per-Lot Geometry Computation

For each conversion lot, the code computes:

```javascript
// reynosaOverlay.js:2707-2712
const area = cells.length * cellAreaM2;     // m²
const capacity = area * LOT_KG_PER_M2;      // kg
lotCellCount.push(cells.length);
lotAreaM2.push(area);
lotCapacityKg.push(capacity);
```

### 2.3 Lot Area Distribution (Derived)

Given `cellAreaM2 ≈ 1,975 m²`:

| Cells per Lot | Area (m²) | Capacity (kg) @ LOT_KG_PER_M2=1 | Trucks @ 9000 kg/truck |
|---------------|-----------|----------------------------------|------------------------|
| 1 | 1,975 | 1,975 | **0.22** |
| 5 | 9,876 | 9,876 | **1.10** |
| 10 | 19,753 | 19,753 | **2.19** |
| 50 | 98,766 | 98,766 | **10.97** |
| 100 | 197,531 | 197,531 | **21.95** |

**Observation**: Most lots cannot hold even one truck at current LOT_KG_PER_M2=1.

### 2.4 Contiguity and Overlap

- **Contiguity**: Not explicitly enforced. Polygons rasterized independently.
- **Road overlap**: Detected and logged with warning (`lotRoadOverlapCount`)
- **Lot-to-cell mapping**: Bidirectional via `cellToLotIndex` and `lotToCellIndices`

---

## PHASE 3: IMPLICIT PHYSICAL ASSUMPTIONS

### 3.1 Mass and Density Constants

| Variable | Value | Unit | Location | Description |
|----------|-------|------|----------|-------------|
| `TRUCK_KG` | 9,000 | kg | `:185` | Mass per truck quantum |
| `PARTICLE_MASS_KG` | 9,000 | kg | `:424` | Mass per particle (should equal TRUCK_KG) |
| `LOT_KG_PER_M2` | 1 | kg/m² | `:1355` | Capacity density (adjustable via `setLotCapacity`) |
| `RHO_CONGESTION_0` | 50,000 | kg | `:251` | Density at congestion onset (~5.6 trucks/cell) |

### 3.2 Capacity and Threshold Constants

| Variable | Value | Unit | Location | Description |
|----------|-------|------|----------|-------------|
| `LOT_CAPACITY_THRESHOLD` | 0.90 | fraction | `:1396` | 90% utilization = "full" |
| `SOFT_CAPACITY_ALPHA` | 20.0 | unitless | `:1407` | Penalty multiplier for routing |
| `SOFT_CAPACITY_BETA` | 4.0 | unitless | `:1408` | Exponent for penalty curve |
| `CREW_RATE_KG_PER_SIM_S` | 2.6 | kg/sim-s | `:1420` | Service throughput per lot |

### 3.3 Variables That Depend on Cell Area (Silently)

| Variable | Dependency | Issue |
|----------|------------|-------|
| `lotCapacityKg[i]` | `lotAreaM2[i] * LOT_KG_PER_M2` | Area derives from cell count × cell area |
| `lotCurrentMassKg[i]` | Sum of `rho_restricted_lot + rho_cleared` over lot cells | Mass per cell implicitly in kg/cell |
| `utilization` | `lotCurrentMassKg[i] / lotCapacityKg[i]` | Dimensionless but depends on LOT_KG_PER_M2 |
| `rho_*` arrays | Float32Array, indexed by cell | Implicitly kg per cell (not kg/m²) |

### 3.4 Functions With Hidden Unit Assumptions

| Function | Assumption | Location |
|----------|------------|----------|
| `depositToParkWaitZone()` | kg deposited directly, no capacity check | `:1551-1570` |
| `rebuildLotMassLiveFromRho()` | Sums `rho_restricted_lot + rho_cleared` per lot | `:1694-1721` |
| `getLotAcceptance()` | Returns 0 at 90% fill, soft decay below | `:1790-1816` |
| `updateLotUtilization()` | Computes utilization = mass/capacity | `:1637-1688` |

---

## PHASE 4: CAPACITY DERIVATION REQUIREMENTS

### 4.1 Current Capacity Formula

```
lotCapacityKg[i] = lotAreaM2[i] × LOT_KG_PER_M2
                 = (cellCount × cellAreaM2) × LOT_KG_PER_M2
```

### 4.2 Required Physical Assumptions for Geometry-Only Derivation

If capacity were to be computed purely from geometry, the following would be needed:

| Assumption | Symbol | Unit | Current Status |
|------------|--------|------|----------------|
| Truck footprint (parked) | `A_truck` | m² | **NOT DEFINED** |
| Stacking allowed | boolean | — | **NOT DEFINED** (implicitly no) |
| Dwell mode | enum | — | **NOT DEFINED** (parking vs queued) |
| Circulation factor | `η_circ` | fraction | **NOT DEFINED** (drive aisles, etc.) |
| Maximum trucks per m² | `ρ_max` | trucks/m² | **NOT DEFINED** |

### 4.3 Example: Realistic Derivation

```
Given:
  - Truck footprint: 15m × 3m = 45 m² (parked)
  - Circulation factor: 0.5 (half of lot is drive aisles)
  - Net parking area: lotAreaM2 × 0.5

Then:
  maxTrucks = (lotAreaM2 × 0.5) / 45
  capacityKg = maxTrucks × TRUCK_KG
             = (lotAreaM2 × 0.5 / 45) × 9000
             = lotAreaM2 × 100 kg/m²
```

**Implication**: A realistic LOT_KG_PER_M2 would be ~100, not 1.

---

## PHASE 5: INVARIANT CHECKPOINTS

### 5.1 Invariant: Mass per cell interpretable as kg/m²

| Status | Location | Notes |
|--------|----------|-------|
| **NOT ENFORCED** | All `rho_*` arrays | Values are raw kg per cell, not kg/m². To get kg/m², divide by cellAreaM2. |

### 5.2 Invariant: Lot capacity derivable from lot area

| Status | Location | Notes |
|--------|----------|-------|
| **PARTIALLY ENFORCED** | `:2707-2712` | Capacity = area × LOT_KG_PER_M2, but LOT_KG_PER_M2 has no physical derivation |

### 5.3 Invariant: Utilization% > 100% must be physically impossible

| Status | Location | Notes |
|--------|----------|-------|
| **NOT ENFORCED** | Multiple | Capacity is advisory. `depositToParkWaitZone()` bypasses gating entirely. Even gated entry can exceed capacity via timing windows. |

Evidence:
- `:1566` — `rho_restricted_lot[cellIdx] += kgPerCell` with no capacity check
- `:4421` — `rho_restricted_lot[cIdx] += perCell` with reservation but no hard clamp
- Reservation tracks `lotAcceptRemainingKgLive` but race conditions exist between substeps

### 5.4 Invariant: Conversion must free physical space

| Status | Location | Notes |
|--------|----------|-------|
| **PARTIALLY ENFORCED** | `:4744-4749` | `convertTruckFromLot()` withdraws from `rho_restricted_lot` and adds to `rho_cleared`. Total mass unchanged. |

Issue: Cleared mass still occupies the lot until it exits. Utilization includes both:
```javascript
// :1652-1655
lotCurrentMassKg[lotIdx] +=
    rho_restricted_lot[cellIdx] +
    rho_cleared[cellIdx];
```

### 5.5 Summary Table: Invariant Enforcement

| Invariant | Enforced? | Where Enforcement Should Live |
|-----------|-----------|-------------------------------|
| Mass units consistent (kg/m² or kg/cell) | NO | All rho arrays or unit conversion layer |
| Capacity from geometry | PARTIAL | `initLots()` + LOT_KG_PER_M2 derivation |
| Utilization ≤ 100% | NO | All deposit functions, especially `depositToParkWaitZone()` |
| Conversion frees space | PARTIAL | `applyConversions()` + exit handling |

---

## TABLES

### Table A: Geometric Constants

| Constant | Value | Unit | Source |
|----------|-------|------|--------|
| Domain size | 80,000 | m | `COMPUTE_WINDOW.SIZE_M` |
| Grid resolution | 1,800 | cells/edge | `COMPUTE_WINDOW.RESOLUTION` |
| Cell edge | 44.44 | m | Derived |
| Cell area | 1,975.31 | m² | Derived |
| Total cells | 3,240,000 | — | N² |

### Table B: Lot Layer Summary

| Layer | Count | In regionMap | Has Capacity |
|-------|-------|--------------|--------------|
| lots | 98 | Yes (REGION_LOT) | Yes |
| industrialParks | 39 | No | No |
| phases | 10 | No | No |
| urbanFootprint | 57 | No (renderOnly) | No |
| electricity | 80 | No (disabled) | No |

### Table C: Hidden Assumptions

| Variable | Implicit Unit | Explicit Unit | Gap |
|----------|---------------|---------------|-----|
| `rho_restricted` | kg/cell | none stated | Should document |
| `LOT_KG_PER_M2` | kg/m² | stated | No physical derivation |
| `RHO_CONGESTION_0` | kg/cell | stated as kg | Comment says "~5-6 trucks" |
| `CREW_RATE_KG_PER_SIM_S` | kg/sim-s/lot | stated | No physical basis |

### Table D: Missing Invariants

| Invariant | Current State | Required Action |
|-----------|---------------|-----------------|
| Hard capacity ceiling | Not enforced | Clamp all deposits |
| Park capacity | None | Define or inherit |
| Unit consistency | Implicit kg/cell | Document or convert |
| Space freed on exit | Partial | Track pending exits |

---

## APPENDIX: Code Location Index

| Concept | File | Lines |
|---------|------|-------|
| Grid constants | `renderer_interfaces.js` | 139-142 |
| Transform | `ReynosaOverlayBundle.js` | 141-146 |
| rho arrays | `reynosaOverlay.js` | 1196-1199 |
| Capacity system | `reynosaOverlay.js` | 1351-1396 |
| Park wait zones | `reynosaOverlay.js` | 1426-1630 |
| Lot initialization | `reynosaOverlay.js` | 2677-2754 |
| Capacity gating | `reynosaOverlay.js` | 4358-4458 |
| Deposit (no check) | `reynosaOverlay.js` | 1551-1570 |

---

*This report serves as the geometry contract for all future capacity logic decisions.*
