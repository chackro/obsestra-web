# FIELD Authority

> **Purpose:** Declares ownership, invariants, and canonical truth.
> **Audience:** Developers touching the system.
> **Rule:** This document may arbitrate, but never explain. No rationale, no metaphors.

---

## A. Authority Model

### Doctrine

Single source of truth per concern. If a value, formula, or ownership claim appears in multiple places, exactly one is canonical.

### Dependency Direction

```
CIEN bundles (external)
        │
        ▼
    contracts/
        │
        ▼
     overlay/
        │
        ▼
     engine/
```

Lower layers never import from higher layers.

---

## A.2 Two-Layer Architecture

The physics separates into two orthogonal concerns:

### Layer 1 — TOPOLOGY (guarantees arrival)

Pure graph logic. No physics. **Dual-potential system for class-conditioned routing.**

```
φ_pharr ← Dijkstra(PHARR sink)      // cleared mass routing
φ_lots  ← Dijkstra(lot sinks)       // restricted mass routing

nextHop_pharr[idx] ← argmin(φ_pharr among road neighbors)
nextHop_lots[idx]  ← argmin(φ_lots among road neighbors)
```

| Property | Value |
|----------|-------|
| Computed from | K tensor (road geometry) + lot cell indices |
| Recomputed when | Geometry changes OR lots finish loading |
| Responds to density | **No** |
| Responds to lots | **Yes** (lots are sinks for φ_lots) |

This layer answers: **Where does mass go next, structurally, based on its class?**

- `restricted` mass → routes toward lots (via nextHop_lots)
- `cleared` mass → routes toward PHARR (via nextHop_pharr)

Guarantees:
- No stalling (every road cell has a path to its class sink)
- No missed sinks (shortest-path trees are complete)
- No geometry dependence in evolution (routing is pre-computed)
- Deterministic (same geometry + lots → same nextHop tables)
- Class-conditioned (routing table selected by mass class)

### Layer 2 — STATE (fluid behavior)

Mass transport and lot effects live **on top of** the graph, not instead of it.

```
outflow = mass[idx] × FLOW_FRAC × rate(regionMap[idx])
mass[nextHop[idx]] += outflow
```

| Property | Value |
|----------|-------|
| Direction | From Layer 1 (nextHop) |
| Rate | From RegionDef.base_conductance |
| Dwell time | From ConversionRule.dwell_time |
| Capacity | From RegionDef.capacity |

This layer answers:
- **How fast** mass moves (conductance)
- **How long** it waits (dwell time)
- **How much** piles up (capacity)
- **How lots affect throughput** (region modifiers)

### Separation Principle

| Concern | Owner | Never touches |
|---------|-------|---------------|
| **Routing** | Layer 1 (nextHop from φ) | Density, lots, scenarios |
| **Rate/residence** | Layer 2 (lots, regions) | Direction, topology |

**Lots are stateful modifiers, not routers.** They affect rate and residence time. They never decide direction.

#### Congestion Ownership
- Congestion is a **rate modifier** derived solely from field density ρ.
- Routing (Layer 1) is never altered by congestion.
- Particles/rendering never influence congestion; they only sample it.

---

## B. File Authority Map

### B.1 Engine Layer

| File | Owns |
|------|------|
| `engine/fieldUnits.js` | All physics constants with units |
| `engine/fieldPhysics.js` | ❌ DELETED - Physics moved to `overlay/reynosaOverlay.js` |
| `engine/geometryProvider.js` | GeometryProvider interface, validation |
| `engine/classSystem.js` | ClassDef, RegionDef, SinkDef, ConversionRule schemas; V1 class/region/sink/conversion configs |

### B.2 Overlay Layer

| File | Owns |
|------|------|
| `overlay/bundleConsumer.js` | lat/lon → meters transform, adapter factory |
| `overlay/scenarioPair.js` | Two-bundle state, interpolation |
| `overlay/alphaDriver.js` | α(t) computation, monotonic enforcement |
| `overlay/interpolatedAdapter.js` | Scenario/geometry adapters using α |
| `overlay/segmentWeights.js` | segment_load_kg_by_poe_hs2 → normalized weights |
| `overlay/microGeometry.js` | **Lot polygon stamping**, regionMap, friction zones |
| `overlay/lotsLoader.js` | lots.json loading, coordinate transform |
| `overlay/reynosaOverlay.js` | **ACTIVE PHYSICS** - K interpolation, physics evolution, rendering, particle visualization |
| `overlay/macroParticleLayer.js` | Extended particle system with class lifecycle |

### B.3 Contracts Layer

| File | Owns |
|------|------|
| `contracts/ReynosaOverlayBundle.js` | Bundle schema, locked constants, validation |
| `contracts/ScenarioPairContract.js` | Pair invariants, compatibility validation |

### B.4 Test Layer

| File | Owns |
|------|------|
| `test/mass_conservation.js` | Correctness oracle |
| `test/stubGeometryProvider.js` | Test geometry |

### B.5 Spec Layer

| File | Owns |
|------|------|
| `spec/renderer_interfaces.js` | Activation thresholds, overlay state enum |

---

## C. Canonical Field Definitions

| Field | Symbol | Type | Units | Meaning |
|-------|--------|------|-------|---------|
| Density (restricted) | ρ_restricted | Float32Array(N×N) | kg/cell | Mass requiring lot transfer |
| Density (cleared) | ρ_cleared | Float32Array(N×N) | kg/cell | Mass eligible for PHARR drain |
| Potential (PHARR) | φ_pharr | Float32Array(N×N) | meters | Geodesic distance to PHARR (cleared routing) |
| Potential (lots) | φ_lots | Float32Array(N×N) | meters | Geodesic distance to nearest lot (restricted routing) |
| Conductance XX | Kxx | Float32Array(N×N) | cells²/s | Tensor component |
| Conductance XY | Kxy | Float32Array(N×N) | cells²/s | Tensor component |
| Conductance YY | Kyy | Float32Array(N×N) | cells²/s | Tensor component |
| Source | S | Float32Array(N×N) | kg/s | Injection rate |
| Sink mask | G | Float32Array(N×N) | dimensionless | Spatial falloff at PHARR gate |
| **Next hop (PHARR)** | nextHop_pharr | Int32Array(N×N) | cell index | Neighbor with lower φ_pharr (cleared routing) |
| **Next hop (lots)** | nextHop_lots | Int32Array(N×N) | cell index | Neighbor with lower φ_lots (restricted routing) |
| Region map | regionMap | Uint8Array(N×N) | region ID | Per-cell region assignment (Layer 2) |
| Lot cell indices | lotCellIndices | number[] | cell index | Sparse list of cells inside lots |

### C.1.1 Deprecated Fields (Dead Code)

| Field | Symbol | Status | Notes |
|-------|--------|--------|-------|
| ~~Velocity X~~ | vx | ❌ DEAD | Was for semi-Lagrangian advection. Graph-flux uses nextHop. |
| ~~Velocity Y~~ | vy | ❌ DEAD | Was for semi-Lagrangian advection. Graph-flux uses nextHop. |

These fields may still exist in code for particle visualization but have no authority over physics.

Baseline K tensors: `K_baseline_xx`, `K_baseline_xy`, `K_baseline_yy`
Interserrana K tensors: `K_interserrana_xx`, `K_interserrana_xy`, `K_interserrana_yy`

### C.10 Derived Fields

| Field | Derived From | Computation |
|-------|--------------|-------------|
| nextHop[i] | φ_base, Kxx, Kyy | argmin(φ_base[n]) over road neighbors; -1 if sink or no lower neighbor |
| regionMap[i] | lots.json | Stamped from lot polygons via microGeometry |

### C.2 Class Definitions

```typescript
ClassDef {
  id: string                      // "restricted", "cleared"

  // Transport
  conductance_scale: number       // multiplier on K(x), default 1.0

  // Sink eligibility
  sink_eligibility: {
    [sink_id: string]: boolean    // false → G_{c,s} = 0
  }

  // Region access
  region_access: {
    [region_id: string]: {
      allowed: boolean            // false → K_c = 0 in region
      conductance_multiplier: number  // default 1.0
    }
  }
}
```

**v1 Classes:**

| Class | conductance_scale | sink_eligibility.pharr_main | Notes |
|-------|-------------------|----------------------------|-------|
| restricted | 1.0 | false | Cannot exit at Pharr |
| cleared | 1.0 | true | Can exit at Pharr |

### C.3 Region Definitions

```typescript
RegionDef {
  id: string                      // "corridor", "yard_main"
  type: "CORRIDOR" | "YARD" | "BARRIER"

  geometry: CellMask              // which cells belong to region

  // Transport
  base_conductance: number        // K multiplier for region
  allow_flow: boolean             // false → K = 0

  // Storage
  is_storage: boolean             // true for yards
  capacity: number | null         // max ρ (null = unlimited)

  // Conversion
  conversion_rules: ConversionRule[]
}
```

**v1 Regions:**

| Region | type | base_conductance | is_storage | conversion_rules |
|--------|------|------------------|------------|------------------|
| corridor | CORRIDOR | 1.0 | false | [] |
| yard_main | YARD | 0.3 | true | [restricted→cleared] |

### C.4 Sink Definitions

```typescript
SinkDef {
  id: string                      // "pharr_main"
  region_id: string               // where sink applies

  capacity_schedule: Record<0-23, number>  // kg/hour by hour
  enabled_schedule: Record<0-23, boolean>  // open/closed by hour
}
```

**v1 Sinks:**

| Sink | region_id | capacity_source |
|------|-----------|-----------------|
| pharr_main | pharr_gate | CIEN bundle capacity.hourly_kg |

### C.5 Conversion Rules

```typescript
ConversionRule {
  id: string                      // "yard_transfer"
  from_class: string              // "restricted"
  to_class: string                // "cleared"

  region_id: string               // only active in this region

  mode: "time" | "rate"
  dwell_time: number | null       // seconds (if mode=time)
  max_rate: number | null         // kg/s (if mode=rate)

  enabled: boolean
}
```

**v1 Conversions:**

| Rule | from | to | region | mode | dwell_time |
|------|------|----|--------|------|------------|
| yard_transfer | restricted | cleared | yard_main | time | 1800 (30 min) |

---

## D. Canonical Evolution Law

> **Transport Model:** Graph-flux. Mass moves along `nextHop` derived from `φ_base`.
>
> - **Layer 1 (TOPOLOGY):** φ_base, nextHop — static routing from geometry
> - **Layer 2 (STATE):** FLOW_FRAC × conductance — rate modulation from regions
>
> Semi-Lagrangian advection is **deprecated**. Velocity fields (vx, vy) are dead code.

### D.1 Per-Frame Update Order

```
1. computeAlpha(simTimeHours)           // if scenario pair loaded
2. rebakeKTensors()                     // if geometry threshold crossed
3. interpolateKTensor(α)                // K(α) = lerp(K_baseline, K_interserrana, α)
4. rebuildPhiBase()                     // Dijkstra from sink (if dirty)
5. buildNextHop()                       // nextHop[i] = argmin(φ[n]) over road neighbors
6. loadHourlyInflow(hour)               // S_c for each class
7. loadGateCapacity(hour)               // cap(h) from schedule
8. FOR EACH class c:
   8a. graphFlowClass(c)                // conservative flux via nextHop
   8b. injectSource(c)                  // add S_c × dt to source cells
9. applyConversions(dt)                 // T_{c→d} transfers (in YARD regions only)
10. FOR EACH sink s:
    10a. drainSink(s, dt)               // per-class eligibility
11. enforceNonNegative()
12. updateMetrics()
```

This order is invariant. Reordering invalidates the model.

### D.2 Multi-Class Evolution Equation

For each class c:

```
ρ_c[i](t+dt) = ρ_c[i](t) × (1 - FLOW_FRAC × rate[i])     // outflow
             + Σ_j ρ_c[j](t) × FLOW_FRAC × rate[j]       // inflow from neighbors where nextHop[j] = i
             + S_c[i] × dt                                // injection
             - G_{c,s}[i]                                 // sink drain
             + T_{d→c}[i] - T_{c→e}[i]                    // conversions
```

Where:
- `nextHop[i]` = neighbor with strictly lower φ_base (or -1 for sink/dead-end)
- `rate[i]` = region.base_conductance × class.conductance_scale (default 1.0)
- `G_{c,s}` = sink drain (zero if class not eligible)
- `T_{d→c}` = conversion into class c (YARD regions only)

### D.3 Dual Potential Formula (φ_pharr, φ_lots)

**PHARR potential (cleared mass routing):**
```
φ_pharr[i] = Dijkstra distance from PHARR sink cell(s) along road network
           = 0 at PHARR sink cells
           = edgeCost × hop_count to reach PHARR
           = PHI_LARGE (1e6) if unreachable
```

**Lot potential (restricted mass routing):**
```
φ_lots[i] = Dijkstra distance from lot cell(s) along road network
          = 0 at lot cells (lotCellIndices)
          = edgeCost × hop_count to reach nearest lot
          = PHI_LARGE (1e6) if unreachable
```

Both potentials are computed **once** after K tensor changes or lots finish loading, not per frame.

### D.4 Dual Next Hop Construction

For each potential field, build a corresponding next-hop table:

```
FOR EACH cell i with K[i] > K_THRESHOLD:
    // PHARR next-hop (cleared routing)
    IF φ_pharr[i] ≈ 0:    // PHARR sink cell
        nextHop_pharr[i] = -1
    ELSE:
        neighbors = [orthogonal + diagonal + knight moves] where K[n] > K_THRESHOLD
        best = argmin(φ_pharr[n]) over neighbors where φ_pharr[n] < φ_pharr[i]
        nextHop_pharr[i] = best   // or -1 if no lower neighbor

    // Lots next-hop (restricted routing)
    IF φ_lots[i] ≈ 0:     // lot cell
        nextHop_lots[i] = -1
    ELSE:
        best = argmin(φ_lots[n]) over neighbors where φ_lots[n] < φ_lots[i]
        nextHop_lots[i] = best    // or -1 if no lower neighbor
```

Invariants:
- φ_pharr[nextHop_pharr[i]] < φ_pharr[i] for all i where nextHop_pharr[i] ≥ 0
- φ_lots[nextHop_lots[i]] < φ_lots[i] for all i where nextHop_lots[i] ≥ 0

### D.5 Graph-Flux Transport (Class-Conditioned)

Conservative flux update with **class-conditioned routing**:

```
function graphFlowClass(classId, rho, rhoNext):
    // SELECT ROUTING TABLE BASED ON CLASS
    nh_table = (classId == 'restricted') ? nextHop_lots : nextHop_pharr

    rhoNext.fill(0)

    FOR EACH road cell i:
        m = rho[i]
        nh = nh_table[i]    // Class-appropriate next-hop
        rate = getRegionConductance(regionMap[i])

        IF nh >= 0:
            outflow = m × FLOW_FRAC × rate
            rhoNext[nh] += outflow
            rhoNext[i] += (m - outflow)
        ELSE:
            rhoNext[i] += m   // At sink (lot or PHARR) or dead-end

    rho = rhoNext
```

**Class routing behavior:**
- `restricted` → follows `nextHop_lots` → routes toward lots → dwells → converts to `cleared`
- `cleared` → follows `nextHop_pharr` → routes toward PHARR → drains

**Region conductance effect:** `rate = RegionDef.base_conductance` (0-1).
- Corridor (1.0): full flow rate
- Lot (0.4): 40% of FLOW_FRAC moves per tick (dwell zone)
- Connector (0.2): 20% of FLOW_FRAC (bridge cells)
- Barrier (0.0): no flow (mass stuck)

### D.5.1 Region Conductance Lookup

```
function getRegionConductance(regionU8) {
    return REGION_CONDUCTANCE[regionU8] ?? 1.0;
}

REGION_CONDUCTANCE = {
    0: 1.0,   // corridor
    1: 0.3,   // yard_main
    2: 0.3,   // tier3_scatter
    3: 0.6,   // transfer_yard
    4: 0.85,  // inovus_t1
    5: 0.5,   // toll_bottleneck
    6: 0.1,   // storage
    7: 0.0,   // barrier
};
```

### D.6 Conversion Formula

For conversion rule r (from_class → to_class) in region:

**Time-based:**

```
T_r = ρ_from[i] / dwell_time    // kg/s converted
ρ_from[i] -= T_r × dt
ρ_to[i] += T_r × dt
```

**Rate-based:**

```
T_r = min(ρ_from[i] / dt, max_rate)
ρ_from[i] -= T_r × dt
ρ_to[i] += T_r × dt
```

Conversion only applies where `region_id` matches cell's region.

### D.7 Sink Drain Formula (with eligibility)

For each sink s and class c:

```
if NOT class.sink_eligibility[s]:
    G_{c,s}[i] = 0
    continue

desired_c[i] = ρ_c[i] × G[i] × G_BASE_PER_S × dt
```

Aggregate across eligible classes:

```
total_desired = Σ_c Σ_i desired_c[i]
cap_this_tick = (cap_kg_per_hour / 3600) × dt
allowed = min(total_desired, cap_this_tick)

// Proportional removal
FOR EACH eligible class c:
    FOR EACH sink cell i:
        removed = allowed × (desired_c[i] / total_desired)
        ρ_c[i] -= removed
        ρ_c[i] = max(ρ_c[i], 0)
```

---

## E. Boundary Conditions

### E.1 Window Edges (Graph-Flux)

| Condition | Behavior |
|-----------|----------|
| Edge cells | No special treatment (graph neighbors don't exist beyond edges) |
| Off-road cells | nextHop = -1 (no flow) |
| Mass at edges | Stays in place (no leakage) |

Graph-flux uses neighbor existence naturally. Edges don't "leak" because off-grid neighbors don't exist in the neighbor list.

### E.2 Injection

Injection occurs at designated source cells (corridor entry points).

```
S[cell] = (hourly_kg / 3600) × injection_weight[cell]
Σ injection_weight = 1.0
```

Source cells must have `nextHop[cell] >= 0` (reachable to sink). Dead-end sources are logged as warnings.

### E.3 Drain

Drain occurs only at PHARR sink cells (G > 0, φ_base = 0).

```
drain ≤ cap_kg_per_hour / 3600 × dt
```

### E.4 Non-Negativity

```
ρ[i] ≥ 0   (enforced after drain)
```

### E.5 Reachability Requirement

All source cells must be reachable from the sink (φ_base < PHI_LARGE).
Fail if >5% of road cells have nextHop = -1 (excluding sinks).

---

## F. Scenario Pair System

### F.1 Pair Invariants (Must Match)

| Property | Tolerance |
|----------|-----------|
| PHARR lat/lon | ±0.0001° |
| Coordinate transform | Identical |
| Time basis | `typical_weekday` |
| avg_kg_per_truck | `9000` |
| Layer | `layer2_infra_queue` |
| Hour coverage | 0–23 |
| Geometry | Append-only |

### F.2 Pair Delta (May Differ)

| Property | Allowed difference |
|----------|-------------------|
| scenario_hash | Must differ |
| Geometry segments | Interserrana adds segments |
| hourly_kg (inflow) | Values change |
| hourly_kg (capacity) | Values change |
| Segment weights | Routing shifts |

### F.3 Validation Failure Conditions

- PHARR coordinates mismatch > tolerance
- Transform mismatch
- Time basis mismatch
- Unit semantics mismatch
- Geometry removal (non-append)
- scenario_hash identical

---

## G. Alpha Driver

### G.1 Invariants

```
α(t) ∈ [0, 1]              // clamped
α(t₁) ≤ α(t₂) if t₁ < t₂   // monotonic non-decreasing
α(input₁) = α(input₂) if input₁ = input₂   // deterministic
```

### G.2 Curves

| Curve | Formula |
|-------|---------|
| LINEAR | `α = (t - startHour) / (endHour - startHour)` |
| SMOOTHSTEP | `t_norm = (t - start) / (end - start); α = 3t² - 2t³` |
| PLATEAU_RAMP | `α = 0 if t < plateau; else linear from plateau` |

### G.3 Interpolation Formulas

```
inflow(α, h) = baseline.inflow[h] + α × (interserrana.inflow[h] - baseline.inflow[h])
capacity(α, h) = baseline.capacity[h] + α × (interserrana.capacity[h] - baseline.capacity[h])
geometry(α) = baseline.geometry ∪ (delta_segments if α ≥ 0.1)
```

---

## H. Conductance System

### H.1 Weight Extraction

```
segment_kg = bundle.segment_load_kg_by_poe_hs2[poe_id][hs2][segment_id]
raw_weights = { segment_id → segment_kg }
max_kg = max(raw_weights.values())
linear_weight = segment_kg / max_kg
normalized_weight[segment_id] = linear_weight ^ WEIGHT_EXPONENT   // ∈ [0, 1]
```

Note: WEIGHT_EXPONENT = 1.0 means linear (CIEN truth). No artificial exaggeration.

### H.2 Conductance Formula

```
K_segment = K_BASE + normalized_weight × K_DELTA
          = 0.05   + w              × 0.95
```

Low floor + wide span: weak segments become viscous, strong ones feel like highways.

### H.3 K Tensor Construction

For each road segment:
1. Compute tangent vector at each polyline point
2. Stamp tensor into grid cells along segment
3. Apply weight-scaled conductance

```
Kxx += K_segment × tx²
Kxy += K_segment × tx × ty
Kyy += K_segment × ty²
```

### H.4 K Tensor Interpolation (Per Frame)

```
Kxx[i] = K_baseline_xx[i] + α × (K_interserrana_xx[i] - K_baseline_xx[i])
Kxy[i] = K_baseline_xy[i] + α × (K_interserrana_xy[i] - K_baseline_xy[i])
Kyy[i] = K_baseline_yy[i] + α × (K_interserrana_yy[i] - K_baseline_yy[i])
```

---

## I. Contracts

### I.1 ReynosaOverlayBundle Schema

```typescript
{
  metadata: {
    scenario_hash: string
    layer: "layer2_infra_queue"
    time_basis: "typical_weekday"
    avg_kg_per_truck: 9000
    weekday_traffic_share: 0.85
    business_days_per_year: 264
  }
  inflow: {
    hourly_kg: Record<0-23, number>
  }
  capacity: {
    hourly_kg: Record<0-23, number>
    params: { s: number, mu: number, open_start: number, open_end: number }
  }
  geometry: {
    pharr_coords: { lat: number, lon: number }
    transform: {
      origin_lat: number
      origin_lon: number
      meters_per_deg_lat: number
      meters_per_deg_lon: number
    }
    segments_in_roi: Array<{
      segment_id: string
      geometry_coordinates: Array<[lon, lat]>
    }>
  }
  segment_load_kg_by_poe_hs2?: {
    [poe_id: string]: Record<HS2, Record<segment_id, kg>>
  }
}
```

### I.2 Pair Contract Schema

```typescript
{
  baseline: ReynosaOverlayBundle
  interserrana: ReynosaOverlayBundle
  validated: boolean
  geometry_delta: Array<segment_id>   // segments added in interserrana
}
```

---

## J. Locked Constants

### J.1 Grid and Timing

| Constant | Value | Units | Owner |
|----------|-------|-------|-------|
| ~~DT_S~~ | ~~0.016~~ | ~~seconds~~ | ❌ DEPRECATED - Physics receives Δt_sim from time authority (Section N.5) |
| DAY_VIDEO_SECONDS | 75 | seconds | reynosaOverlay.js |
| SIM_TIME_SCALE | 1152 | sim-s/real-s | reynosaOverlay.js (derived) |
| N | 2100 | cells | renderer_interfaces.js (COMPUTE_WINDOW.RESOLUTION) |
| ROI_SIZE | 80000 | meters | renderer_interfaces.js |

### J.2 Graph-Flux Transport

| Constant | Value | Units | Owner |
|----------|-------|-------|-------|
| FLOW_FRAC | 0.4 | dimensionless | reynosaOverlay.js |
| K_THRESHOLD | 0.01 | cells²/s | reynosaOverlay.js |
| PHI_LARGE | 1000000 | meters | reynosaOverlay.js |
| PHI_SINK | 0 | meters | reynosaOverlay.js |

### J.3 Conductance

| Constant | Value | Units | Owner |
|----------|-------|-------|-------|
| K_ROAD | 1.0 | cells²/s | fieldUnits.js |
| K_YARD | 0.3 | cells²/s | fieldUnits.js |
| K_LOT | 0.4 | cells²/s | reynosaOverlay.js (initLots) |
| K_CONNECTOR | 0.2 | cells²/s | reynosaOverlay.js (lot bridging) |
| K_BUFFER | 0.15 | cells²/s | reynosaOverlay.js (road dilation) |
| K_BASE | 0.05 | cells²/s | reynosaOverlay.js |
| K_DELTA | 0.95 | cells²/s | reynosaOverlay.js |
| K_ROAD_THRESHOLD | 0.01 | cells²/s | reynosaOverlay.js (isRoad check) |
| WEIGHT_EXPONENT | 1.0 | dimensionless | segmentWeights.js |

### J.4 Sink/Drain

| Constant | Value | Units | Owner |
|----------|-------|-------|-------|
| G_BASE_PER_S | 0.8 | 1/s | fieldUnits.js |

### J.5 Deprecated Constants (Dead Code)

All semi-Lagrangian advection constants are dead. Listed for removal tracking:

| Constant | Value | Units | Owner | Status |
|----------|-------|-------|-------|--------|
| V_MAX | 2.0 | cells/s | fieldUnits.js | ❌ DEAD (was velocity cap) |
| ADVECT_DT | 0.4 | seconds | reynosaOverlay.js | ❌ DEAD (was advection timestep) |
| STEEPEST_SPEED | 1.0 | cells/s | reynosaOverlay.js | ❌ DEAD (was gradient descent speed) |
| DENSITY_SPEED_ALPHA | — | dimensionless | reynosaOverlay.js | ❌ DEAD (was density slowdown) |
| northBias | 1.0 | dimensionless | fieldUnits.js | ❌ DEAD |
| gateAttract | 5.0 | dimensionless | fieldUnits.js | ❌ DEAD |
| backpressure | 0.001 | dimensionless | fieldUnits.js | ❌ DEAD |

**Action:** Remove from code when cleaning up dead code paths.

### J.6 Bundle/Contracts

| Constant | Value | Units | Owner |
|----------|-------|-------|-------|
| AVG_KG_PER_TRUCK | 9000 | kg | ReynosaOverlayBundle.js |
| WEEKDAY_TRAFFIC_SHARE | 0.85 | dimensionless | ReynosaOverlayBundle.js |
| BUSINESS_DAYS_PER_YEAR | 264 | days | ReynosaOverlayBundle.js |
| ALPHA_GEOM_THRESHOLD | 0.1 | dimensionless | alphaDriver.js |
| DWELL_TIME_YARD | 1800 | seconds | ConversionRule |
| TRANSFER_REQUIREMENT_FRACTION | 0.65 | dimensionless | reynosaOverlay.js |

**TRANSFER_REQUIREMENT_FRACTION:** Fraction of incoming mass requiring yard transfer before PHARR eligibility. 65% injects as `restricted` (must convert in yard), 35% as `cleared` (direct to bridge).

### J.7 Zoom/Activation

| Constant | Value | Units | Owner |
|----------|-------|-------|-------|
| Z_REYNOSA | 2.0 | dimensionless | renderer_interfaces.js |
| R_REYNOSA | 15000 | meters | renderer_interfaces.js |

### J.8 Class/Region/Sink IDs

| Constant | Value | Type | Owner |
|----------|-------|------|-------|
| CLASS_RESTRICTED | "restricted" | string | ClassDef |
| CLASS_CLEARED | "cleared" | string | ClassDef |
| REGION_CORRIDOR | 0 | uint8 | regionMap |
| REGION_YARD | 1 | uint8 | regionMap |
| REGION_TIER3_SCATTER | 2 | uint8 | regionMap |
| REGION_TRANSFER_YARD | 3 | uint8 | regionMap |
| REGION_INOVUS_T1 | 4 | uint8 | regionMap |
| REGION_TOLL_BOTTLENECK | 5 | uint8 | regionMap |
| REGION_STORAGE | 6 | uint8 | regionMap |
| REGION_BARRIER | 7 | uint8 | regionMap |
| SINK_PHARR | "pharr_main" | string | SinkDef |

### J.9 Lot Capacity

| Constant | Value | Units | Owner |
|----------|-------|-------|-------|
| LOT_KG_PER_M2 | 50 | kg/m² | reynosaOverlay.js |

**LOT_KG_PER_M2:** Capacity density for lot cells. Area × density = max mass per lot. Adjustable via `setLotCapacity()`.

**Capacity Model (v2):** Capacity is enforced at flow level via acceptance multiplier `accept = max(0, 1 - fill)`. Rejected mass stays upstream on roads. φ_lots is **static** - all lot cells are always sinks.

See LOTS_SPEC.md Section 21 for full capacity system documentation.

### J.10 Pre-Transfer Friction (Survey N=242)

| Constant | Value | Units | Owner |
|----------|-------|-------|-------|
| P_SHOULDER | 0.46 | probability | reynosaOverlay.js |
| T_SHOULDER_MIN_S | 3600 | seconds | reynosaOverlay.js |
| T_SHOULDER_MAX_S | 7200 | seconds | reynosaOverlay.js |
| P_COORD_1H | 0.30 | probability | reynosaOverlay.js |
| T_COORD_SHORT_MIN_S | 0 | seconds | reynosaOverlay.js |
| T_COORD_SHORT_MAX_S | 3600 | seconds | reynosaOverlay.js |
| T_COORD_LONG_MIN_S | 3600 | seconds | reynosaOverlay.js |
| T_COORD_LONG_MAX_S | 14400 | seconds | reynosaOverlay.js |

**Pre-Transfer Friction:** Short-term on-road delays (hours) before particles reach lots. NOT storage - clearing only happens in lots. Restricted particles sample pre-delay at emission and stall until timer expires.

See LOTS_SPEC.md Section 22 for full pre-friction model documentation.

### Change Protocol

Changing a locked constant requires:
1. Update value in owning file
2. Update this table
3. Re-run test/mass_conservation.js
4. Document reason in commit message

---

## K. Test Oracles

### K.1 Conservation Tests (mass_conservation.js)

| Test | Condition | Pass Criterion |
|------|-----------|----------------|
| Initial zero | No injection, no sinks | Σρ = 0 |
| Pure advection | Injection off, sinks off | |Σρ(t) - Σρ(0)| < 0.01 × Σρ(0) |
| Injection increase | S > 0, G = 0 | Σρ increases |
| Drain decrease | S = 0, G > 0, ρ > 0 | Σρ decreases |
| Non-negative | Any | ∀i: ρ[i] ≥ 0 |
| Steady state | S = drain rate | |dΣρ/dt| → 0 |

### K.2 Stability Tests

| Test | Condition | Pass Criterion |
|------|-----------|----------------|
| No oscillation | Normal operation | max(ρ) does not alternate up/down > 3 times |
| Monotonic alpha | Normal operation | α(t+dt) ≥ α(t) |
| ~~Bounded velocity~~ | ~~Normal operation~~ | ❌ REMOVED (no velocity field in graph-flux) |

### K.2.1 Graph-Flux Invariant Tests

| Test | Condition | Pass Criterion |
|------|-----------|----------------|
| Phi monotonicity | After buildNextHop | φ_base[nextHop[i]] < φ_base[i] for all i where nextHop[i] ≥ 0 |
| Reachability | After buildNextHop | <5% of road cells have nextHop=-1 (excluding sinks) |
| No orphan sources | After injection setup | All source cells have nextHop ≥ 0 |
| Dead-end count | After buildNextHop | Log warning if >100 dead-end road cells |

### K.3 Failure Conditions (Red Test)

- Σρ changes without injection/drain
- ρ goes negative
- α decreases
- Mass appears at non-injection cells
- Mass vanishes at non-sink cells
- **nextHop[i] points to cell j where φ_base[j] ≥ φ_base[i]** (monotonicity violation)
- **Source cell has nextHop = -1** (unreachable source)
- ~~v exceeds V_MAX after clamping~~ ❌ REMOVED (no velocity field)

### K.4 Class Conservation Tests

| Test | Condition | Pass Criterion |
|------|-----------|----------------|
| Restricted isolation | No conversion, cleared sink | ρ_restricted unchanged by sink drain |
| Cleared drains | Conversion off, cleared at sink | ρ_cleared decreases |
| Conversion transfers | Conversion on in yard | ρ_restricted ↓, ρ_cleared ↑, sum constant |
| Total conservation | Any | Σ_c ρ_c changes only by S - G |

### K.5 Conversion Tests

| Test | Condition | Pass Criterion |
|------|-----------|----------------|
| No conversion outside yard | restricted mass in corridor | ρ_restricted does not convert |
| Conversion in yard | restricted mass enters yard | ρ_cleared increases after dwell_time |
| Conversion rate | yard has restricted mass | T ≈ ρ_restricted / dwell_time |

---

## L. Drift Prevention Rules

### L.1 Changes That Require Updating This File

- Adding/removing a field
- Changing a locked constant
- Changing evolution order
- Changing formula
- Adding/removing file ownership
- Changing bundle schema
- Changing test oracle

### L.2 Changes That Must Not Touch This File

- UI changes
- Rendering changes
- Debug logging
- Comments
- Variable renaming (internal)

### L.3 Detecting Silent Divergence

Run quarterly:
1. Grep all constants in codebase
2. Compare against Section J
3. Flag any mismatch

---

## M. Operational Non-Goals

| Forbidden | Enforcement |
|-----------|-------------|
| **Dynamic re-routing** | No demand/congestion-based routing logic |
| Infer demand | No demand estimation functions |
| Individual vehicles (simulation) | No per-vehicle agents/particles used as state in `engine/` or as an evolution mechanism in `overlay/` |
| Prediction | No forecast functions |
| Southbound flow | No negative flow support |
| Runtime CIEN queries | No network calls after init |
| Continental extension | ROI_SIZE locked |
| Optimization | No objective functions |

### M.0.1 Allowed: Static Routing via φ_base/nextHop

**Static routing** derived from geometry is **allowed and required** for graph-flux transport:

- `φ_base` = Dijkstra distance from sink (computed once at init, recomputed on geometry change)
- `nextHop[i]` = neighbor with lower φ (shortest-path tree toward sink)

This is **not** dynamic routing. It is:
- Geometry-derived (from K tensor / road network)
- Computed once per geometry state (not per frame)
- Deterministic (same geometry → same nextHop)
- Does not respond to congestion/demand

**Forbidden:** Re-routing based on ρ (density), queue length, or simulation state.

### M.1 Allowed: Render-Only Particles (Visualization Traces)

Render-only particles are permitted if and only if all constraints hold:

- **No authority**: particles are visualization-only and do not affect any computed FIELD outputs.
- **No evolution role**: particles must not be used as a physical evolution mechanism (no particle-based advection, no agent interactions).
- **Derived only**: particles must be derived from authoritative aggregate data (CIEN segment weights and/or FIELD grids).
- **No per-truck semantics**: particles represent mass-flow traces, not discrete vehicles.
- **No branching**: particles do not change segments; no routing decisions.
- **Capped**: particle count must have a hard ceiling for performance.

### M.2 Lots/Regions Ownership

| Component | Owner | Consumes |
|-----------|-------|----------|
| lots.json | LOTS_SPEC.md | External data source |
| lotsLoader.js | overlay/ | lots.json |
| regionMap stamping | microGeometry.js | lotsLoader output |
| Region conductance | reynosaOverlay.js | regionMap |

**Lots/regions are solver-agnostic.** LOTS_SPEC defines data + parameters. FIELD_AUTHORITY Section D defines how the solver consumes them. Only Section D changes when swapping transport models.

### M.3 Solver Swap Contract

If transport model changes (e.g., back to semi-Lagrangian):

1. **Update Section D only** - evolution law, formulas, update order
2. **Do not change**: LOTS_SPEC, RegionDef schema, lots.json format
3. **Preserve interfaces**: regionMap, base_conductance, conversion_rule_ids
4. **Update Section J**: Add/deprecate constants as needed
5. **Update Section K**: Adjust test criteria for new model

This prevents "two competing truths" across docs.

---

## N. Renderer Time Authority

### N.1 Separation Principle

Physics and rendering operate on different time concerns:

| Layer | Concern | Owner |
|-------|---------|-------|
| **Physics** | Mass rates (kg/s), capacity (kg/hr) | Bundle data, unchanged |
| **Renderer** | How fast wall-clock time maps to sim-time | reynosaOverlay.js |

**Invariant:** Changing renderer time scale does not change mass flow rates. Physics runs real daily values. Renderer compresses observation.

### N.2 Time Constants

| Constant | Value | Units | Owner |
|----------|-------|-------|-------|
| DAY_VIDEO_SECONDS | 75 | seconds | reynosaOverlay.js |
| SIM_SECONDS_PER_DAY | 86400 | sim-seconds | derived |
| SIM_TIME_SCALE | 1152 | sim-s/real-s | derived |

```
SIM_TIME_SCALE = SIM_SECONDS_PER_DAY / DAY_VIDEO_SECONDS
              = 86400 / 75
              = 1152
```

### N.3 Two Renderer Modes (Future)

Same physics state may be observed through different lenses:

| Mode | Purpose | Time Feel |
|------|---------|-----------|
| **Daily Pain** | Show wait, chaos, jam, congestion | Slower, intuitive causality |
| **Strategic Mass** | Show volume, gravity, scale | Faster, monthly patterns |

Neither mode changes physics. Both observe the same ρ, φ, queues.

### N.4 What Time Compression Affects

| Affected | Not Affected |
|----------|--------------|
| Hour cycling rate | Injection kg/s |
| Particle visual speed | Capacity kg/hr |
| Particle aging | Queue buildup math |
| Animation pacing | Mass conservation |

**Rule:** If changing DAY_VIDEO_SECONDS changes how mass flows, the architecture is broken.

### N.5 Time Authority Invariant — NON-NEGOTIABLE

Physics does not decide how much time passes. Physics only answers the question: **given Δt_sim, what is the new state?**

```
Time Authority (mode selector)
        │
        ▼
  Δt_sim = realDelta × SIM_TIME_SCALE
        │
        └──► Physics.integrate(Δt_sim) ──► new state
```

**Core Rules:**

1. **Physics is a pure integrator.** It accepts an explicit Δt_sim and applies its equations exactly once for that interval.

2. **Physics must not assume:**
   - Frame rate
   - Step counts
   - "60fps reality"
   - There is no such thing as a "physics frame." There is only simulated time.

3. **Time authority is the only place** where narrative intent (daily, monthly, yearly) exists. It lives outside physics.

4. **Daily mode and yearly mode are not different physics.** They are different time compression lenses applied to the same physics. Rates, capacities, flow fractions, and conservation laws remain unchanged across modes.

5. **Particles and render instruments** derive behavior from the same Δt_sim that physics advanced. They may never advance faster than physics. They may never advance based on wall-clock time alone.

**Violation Conditions:**

| If this happens... | ...the invariant is violated |
|--------------------|------------------------------|
| Changing mode (daily→yearly) requires touching physics constants, injection rates, capacities, or conservation logic | ✗ |
| Changing FPS changes how much simulated time passes per second | ✗ |
| Particles "feel right" while physics has not advanced the corresponding simulated time | ✗ |
| Physics loops multiple sub-steps to "catch up" to wall-clock time | ✗ |
| DT_S or similar constants encode implicit framerate assumptions | ✗ |

**The only valid lever for narrative speed** is the scalar that maps real seconds to simulated seconds. That scalar lives outside physics. Physics remains truth. Everything else observes it.

```
FPS = how smooth the movie is
Sim time = the truth of the world
```

---

## O. Lot Connectivity and Initialization

### O.1 Initialization Sequence

Lots are loaded asynchronously. The initialization order is critical:

```
1. onAttach()
   ├── bakeKTensor(geometry)         // Stamp roads with K values
   ├── stampPharrSink(pharr)         // Mark PHARR sink cells
   └── initLots() [ASYNC]            // Load lots.json
           ├── loadLots()            // Parse polygons, rasterize to cells
           ├── stampLots()           // Mark regionMap with REGION_LOT
           ├── Stamp K_LOT           // Lot cells become traversable
           ├── Bridge to roads       // BFS dilation to connect lots
           └── phiBaseDirty = true   // Trigger phi rebuild

2. First frame (before lots loaded)
   └── rebuildPhiBase()
       ├── computePotentialToSinks(sinkCellIndices, phi_pharr)  // OK
       └── computePotentialToSinks(lotCellIndices, phi_lots)    // Empty sinks - skipped

3. initLots() completes
   └── phiBaseDirty = true           // Marks for rebuild

4. Next frame (lots now loaded)
   └── rebuildPhiBase()
       ├── computePotentialToSinks(sinkCellIndices, phi_pharr)  // OK
       └── computePotentialToSinks(lotCellIndices, phi_lots)    // Now has lot sinks
```

### O.2 Lot Traversability Requirement

Lots must have K > K_ROAD_THRESHOLD (0.01) to be included in:
- `roadCellIndices` (sparse iteration)
- `nextHop_lots` / `nextHop_pharr` (routing tables)
- Graph-flux mass flow

**Implementation:** `initLots()` stamps K_LOT (0.4) on all lot cells after `stampLots()`.

### O.3 Lot-Road Connectivity Bridging

Lots may not be physically adjacent to road cells. To ensure routing connectivity:

```
FOR EACH lot cell:
    IF lot cell is adjacent to road cell (8-connected):
        SKIP (already connected)
    ELSE:
        BFS from lot cell until road cell found (no distance limit)
        Backtrack to reconstruct shortest path
        Stamp K_CONNECTOR (0.2) on path cells only
```

**Algorithm:** BFS with parent pointers. Only the shortest path to the nearest road is stamped, not all explored cells.

**Parameters:**
| Constant | Value | Purpose |
|----------|-------|---------|
| K_LOT | 0.4 | Lot interior conductance |
| K_CONNECTOR | 0.2 | Bridge cell conductance |
| K_ROAD_CHECK | 0.1 | Threshold to detect existing road |

**Log output:**
```
[LOTS] Stamped K=0.4 for N lot cells
[LOTS] Bridged M connector cells (K=0.2), max path length=P
```

If `M = 0`, all lots were already adjacent to roads.

### O.4 Particle Dwell Invariant

Particles follow class-conditioned routing. When a restricted particle reaches a lot cell:

```
IF particle.classId == 'restricted' AND regionMap[idx] == REGION_LOT:
    // DWELL - do not move
    // Conversion will flip classId to 'cleared'
    // Then particle routes to PHARR via nextHop_pharr
    CONTINUE (skip movement)
```

This prevents sink/neighbor-snap weirdness and makes dwell visible.

### O.5 Seedable PRNG

All randomness uses a seedable PRNG for reproducibility:

```javascript
function rng()           // Returns [0, 1) from xorshift128+
function seedRng(seed)   // Seeds PRNG state
```

Uses:
- Particle class assignment at emission (`restricted` vs `cleared`)
- Particle position jitter
- Stochastic conversion (if enabled)

---

## Appendix: Reading This Document

This document is the Authority. It declares ownership and canonical truth. It answers:

- Which file owns what?
- What are the exact formulas?
- What constants are locked?
- What makes a test fail?

For identity, intent, and rationale, see **FIELD_ARCHITECTURE.md**.

If this document changes, FIELD's maintenance rules have changed.
If FIELD_ARCHITECTURE.md changes, FIELD's identity has changed.

One governs. One persuades.
