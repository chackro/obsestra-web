# Audit: Lot Capacity vs. Dwell/Service Timing

> **Date:** 2025-12-19
> **Files reviewed:** `overlay/reynosaOverlay.js`, `LOTS_SPEC.md`, `spec/renderer_interfaces.js`, `test/bundle_baseline.json`
> **Goal:** Determine whether current configuration implies inconsistent or unstable behavior.

---

## 1. How is lotCapacityKg computed?

### Formula

```javascript
lotCapacityKg[i] = lotAreaM2[i] * LOT_KG_PER_M2
lotAreaM2[i] = cells.length * cellAreaM2
cellAreaM2 = (roi.sizeM / N)² = (80000 / 1800)² = 44.44² ≈ 1975 m²
```

### Constants

| Constant | Value | Source |
|----------|-------|--------|
| `LOT_KG_PER_M2` | 1 | `reynosaOverlay.js:971` |
| `COMPUTE_WINDOW.SIZE_M` | 80,000 m | `renderer_interfaces.js:140` |
| `COMPUTE_WINDOW.RESOLUTION` | 1,800 | `renderer_interfaces.js:141` |
| Cell size | 44.44 m | derived |
| Cell area | 1,975 m² | derived |

### Typical capacity per lot

| Lot size (cells) | Area (m²) | Capacity @ 1 kg/m² | Capacity in trucks |
|------------------|-----------|--------------------|--------------------|
| 1 cell | 1,975 | 1,975 kg | 0.22 trucks |
| 10 cells | 19,750 | 19,750 kg | 2.2 trucks |
| 100 cells | 197,500 | 197,500 kg | 22 trucks |

**Log output format:** `[LOTS] Capacity: N lots, 1 kg/m², total=X.XMt, range=Y-Zt`

---

## 2. What is the effective service model?

### Architecture

**GLOBAL** service budget, not per-lot.

### How "36–72 hours" is enforced

| Parameter | Value | Role |
|-----------|-------|------|
| `MIN_CLEAR_WAIT_S` | 36 × 3600 = 129,600 s | **Hard minimum** (eligibility gate) |
| `MAX_CLEAR_WAIT_S` | 72 × 3600 = 259,200 s | Calibration target only, not enforced |
| `TARGET_DWELL_S` | 54 × 3600 = 194,400 s | Used to derive service RATE |
| `TRUCK_KG` | 9,000 kg | Quantum of conversion |

### Service rate formula

```javascript
// reynosaOverlay.js:3415
globalServiceRateKgPerSimS = queuedKg / TARGET_DWELL_S
_globalServiceBudgetKg += globalServiceRateKgPerSimS * dt
```

### What frees space in a lot

1. When `_globalServiceBudgetKg >= TRUCK_KG` (9,000 kg), pop one token from FIFO queue
2. Token must be eligible (waited ≥ 36h)
3. `convertTruckFromLot(lotIdx)` removes 9,000 kg from `rho_restricted_lot[cells]` → adds to `rho_cleared[cells]`
4. Cleared mass routes to PHARR sink

**Key point:** There is a **minimum dwell of 36 hours**, not just an average. Service cannot clear mass that arrived less than 36 hours ago.

---

## 3. Implied steady-state throughput

Service is **GLOBAL**, so:

```
throughput_global = queuedKg / TARGET_DWELL_S
```

At **steady state**, queue depth Q (trucks) must satisfy:

```
inflow_restricted = service_rate
inflow_restricted = Q × TRUCK_KG / TARGET_DWELL_S
```

### From bundle data

- Average hourly inflow ≈ 1,200,000 kg/hour
- Restricted fraction = 65% (`TRANSFER_REQUIREMENT_FRACTION`)
- **Restricted inflow ≈ 780,000 kg/hour = 86.7 trucks/hour**

### Solving for steady-state queue

```
86.7 trucks/hr = Q × 9000 / 194400 × 3600 / 9000
86.7 = Q × (3600 / 194400)
86.7 = Q × 0.0185
Q = 4,686 trucks
```

| Metric | Value |
|--------|-------|
| Steady-state queue depth | 4,686 trucks |
| Steady-state queue mass | **42.2 Mt** |

---

## 4. Actual injected inflow

From `bundle_baseline.json`:

| Period | Inflow (kg/hr) | Trucks/hr | Restricted trucks/hr (65%) |
|--------|----------------|-----------|----------------------------|
| Peak (hr 7-8, 14) | 2,240,000 | 249 | 162 |
| Day average | ~1,500,000 | 167 | 108 |
| Night (hr 0-4, 19-23) | 448,000 | 50 | 32 |
| **Daily average** | ~1,200,000 | 133 | **86.7** |

**Injection is hourly-variable** (not constant): bursty during business hours (6–18), low overnight.

---

## 5. Inflow vs. implied throughput comparison

At **steady state**, by definition:

```
inflow ≈ throughput (queue stabilizes)
```

But the question is: **can the lots physically hold the steady-state queue?**

### Lot capacity at default `LOT_KG_PER_M2 = 1`

| Parameter | Value |
|-----------|-------|
| Assumed total lot area | 500,000 m² (~85 lots) |
| Total capacity | 500,000 × 1 = **0.5 Mt** |
| Capacity in trucks | **~56 trucks** |

### Queue requirement

| Parameter | Value |
|-----------|-------|
| Steady-state queue | **42.2 Mt = 4,686 trucks** |

### Ratio

```
Lots can hold ~1.2% of required queue
```

**Conclusion: inflow >> lot capacity.** Lots fill almost instantly.

---

## 6. Identified mismatches

### Mismatch A: Lot capacity is ~84× too small

| Parameter | Needed | Actual @ 1 kg/m² | Ratio |
|-----------|--------|------------------|-------|
| Steady-state queue | 42.2 Mt | ~0.5 Mt | **84:1** |

### Mismatch B: LOTS_SPEC says 50 kg/m², code uses 1 kg/m²

From `LOTS_SPEC.md` Section 21:

> | Capacity density | `LOT_KG_PER_M2` | **50** | kg/m² |

But `reynosaOverlay.js:971`:

```javascript
let LOT_KG_PER_M2 = 1;  // Default: 1 kg/m²
```

**50× discrepancy** between spec and implementation.

### Mismatch C: Capacity gates entry, not storage

The capacity system **rejects inflow** when lots hit 90% full (`LOT_CAPACITY_THRESHOLD = 0.90`). This doesn't prevent the queue from forming—it just prevents mass from entering lots. Rejected mass accumulates on roads instead.

### Mismatch D: Service rate depends on queue depth

```javascript
globalServiceRateKgPerSimS = queuedKg / TARGET_DWELL_S
```

If queue is small (because lots reject entry), service rate drops. This creates a feedback loop:

- Small queue → slow service → lots stay full → more rejection

---

## 7. Hypothesis: Fill/unfill oscillation is mathematically implied

**Yes.** The oscillation is structurally inevitable given:

1. **Tiny lot capacity** (0.5 Mt at 1 kg/m²) vs **massive required queue** (42.2 Mt)
2. **90% threshold** triggers rejection
3. **Service rate ∝ queue depth** (feedback loop)

### The oscillation loop

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Restricted mass flows into lots (initially empty)           │
│                           ↓                                     │
│  2. Lots fill to 90% threshold VERY QUICKLY                     │
│     (capacity ≈ 56 trucks, inflow ≈ 87 trucks/hr)               │
│     → fills in ~40 minutes                                      │
│                           ↓                                     │
│  3. Entry rejection triggers → mass backs up on roads           │
│                           ↓                                     │
│  4. Queue tokens age; after 36h, service becomes eligible       │
│                           ↓                                     │
│  5. Service budget clears one truck (9,000 kg) from lot         │
│                           ↓                                     │
│  6. Lot utilization drops briefly below 90%                     │
│                           ↓                                     │
│  7. Inflow rushes in (86.7 trucks/hr waiting)                   │
│     → lot instantly refills                                     │
│                           ↓                                     │
│  8. Return to step 3                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Oscillation period estimate

```
Service rate = queuedKg / TARGET_DWELL_S
With ~56 trucks queued: rate = 56 × 9000 / 194400 = 2.6 kg/sim-s
Time to clear one truck = 9000 / 2.6 = 3,462 sim-seconds ≈ 1 hour
```

**Gate oscillates roughly once per hour** as single trucks clear and immediately get replaced.

---

## Summary

| Question | Answer |
|----------|--------|
| Lot capacity formula | `cells × cellArea × LOT_KG_PER_M2` |
| Default `LOT_KG_PER_M2` | **1** (spec says 50) |
| Service model | Global FIFO with 36h minimum wait |
| Steady-state queue needed | 4,686 trucks (42.2 Mt) |
| Lot capacity @ 1 kg/m² | ~56 trucks (0.5 Mt) |
| Capacity vs queue ratio | **84× undersized** |
| Oscillation cause | Tiny capacity + threshold rejection + rate ∝ queue |

---

## Recommendation

| `LOT_KG_PER_M2` | Total capacity | Trucks | % of equilibrium | Stability |
|-----------------|----------------|--------|------------------|-----------|
| 1 (current) | 0.5 Mt | 56 | 1.2% | Oscillates |
| 50 (per spec) | 25 Mt | 2,800 | 60% | Marginal |
| 100 | 50 Mt | 5,600 | 120% | Stable |

**Immediate fix:** Set `LOT_KG_PER_M2 = 50` (per LOTS_SPEC) or higher via `setLotCapacity(50)`.

At 50 kg/m², lots could hold ~2,800 trucks—still undersized but functional.
At 100 kg/m², lots could hold ~5,600 trucks—near equilibrium, stable operation.

---

# Part 2: Pre-Lot Road Holding Mechanisms

> **Goal:** Identify all mechanisms where restricted mass or particles are intentionally delayed before entering lots.

---

## Mechanism Inventory

Six distinct mechanisms exist for delaying restricted mass/particles before lot entry:

| # | Mechanism | Applies To | Type | Capacity-Limited? |
|---|-----------|------------|------|-------------------|
| 1 | Pre-Transfer Friction | Particles only | Stochastic | No (temporal) |
| 2 | Dwell-Time Modulation | Particles only | Deterministic | No (density-based) |
| 3 | Lot Capacity Gating (Hard) | Field + Particles | Deterministic | Yes (90% threshold) |
| 4 | Soft Capacity Bias | Field routing | Deterministic | Yes (edge penalty) |
| 5 | Graph Flow Fraction | Field mass | Deterministic | No (numerical) |
| 6 | Lot Conductance Reduction | Field mass | Deterministic | No (geometric) |

---

## Mechanism 1: Pre-Transfer Friction (Particles Only)

### Code Location

| File | Lines | Function/Constant |
|------|-------|-------------------|
| `reynosaOverlay.js` | 196–208 | Constants: `P_SHOULDER`, `P_COORD_1H`, `T_*` |
| `reynosaOverlay.js` | 227–241 | `samplePreDelay(rng)` |
| `reynosaOverlay.js` | 399–420 | Particle emission with `preDelayRemainingSec` |
| `reynosaOverlay.js` | 541–557 | Stall loop: decrement timer, freeze position |

### Parameters

| Parameter | Value | Meaning |
|-----------|-------|---------|
| `P_SHOULDER` | 0.46 | 46% of restricted particles do shoulder maneuver |
| `T_SHOULDER_MIN_S` | 3,600 s | 1 hour minimum |
| `T_SHOULDER_MAX_S` | 7,200 s | 2 hour maximum |
| `P_COORD_1H` | 0.30 | 30% have coordination wait ≥ 1 hour |
| `T_COORD_SHORT` | U(0, 3600) s | Short coordination: 0–1 hour |
| `T_COORD_LONG` | U(3600, 14400) s | Long coordination: 1–4 hours |

### Behavior

```javascript
// On particle emission (line 404):
const preDelayRemainingSec = (classId === 'restricted') ? samplePreDelay(rng) : 0;

// In particle update loop (line 547):
if (pClass === 'restricted' && regionMap[idx] !== REGION_LOT && p.preDelayRemainingSec > 0) {
    p.preDelayRemainingSec -= dt;  // Sim time, not real time
    _preDelayStalls++;
    // NO MOVEMENT - particle stalls in place
    continue;
}
```

### Characteristics

| Property | Value |
|----------|-------|
| Applies to | **Particles only** (not field mass) |
| Stochastic? | **Yes** (seeded RNG) |
| Capacity-limited? | **No** (purely temporal) |
| Expected delay | ~1.5–2.5 hours average |
| Maximum delay | ~6 hours (shoulder + long coordination) |

### Interaction with other systems

| System | Interaction |
|--------|-------------|
| Lot capacity gating | **None** — stall happens before particle reaches lot |
| Global FIFO queue | **None** — particle not yet in lot, no token minted |
| Routing (phi_lots) | **Indirect** — stalled particles don't move, so they don't consume phi_lots routing |

---

## Mechanism 2: Dwell-Time Modulation (Particles Only)

### Code Location

| File | Lines | Function/Constant |
|------|-------|-------------------|
| `reynosaOverlay.js` | 697–708 | Speed calculation with `dwellFactor` |

### Formula

```javascript
// Line 697-699:
const localRho = rho_restricted[idx] + rho_cleared[idx];
const DWELL_K = 0.00005;  // Inverse kg scale
const dwellFactor = 1 / (1 + localRho * DWELL_K);

// Line 707-708:
const baseSpeed = cellSizeM * 15.0 * realDt;
const speed = Math.min(maxDisplacement, baseSpeed * dwellFactor);
```

### Behavior

| Local density (kg) | dwellFactor | Speed reduction |
|--------------------|-------------|-----------------|
| 0 | 1.0 | 0% |
| 10,000 | 0.67 | 33% |
| 20,000 | 0.50 | 50% |
| 100,000 | 0.17 | 83% |

### Characteristics

| Property | Value |
|----------|-------|
| Applies to | **Particles only** |
| Stochastic? | **No** (deterministic from density) |
| Capacity-limited? | **No** (density-dependent, not capacity-dependent) |

### Interaction with other systems

| System | Interaction |
|--------|-------------|
| Lot capacity gating | **Indirect** — rejected mass on roads increases density → slows particles |
| Global FIFO queue | **None** — visual effect only |
| Routing (phi_lots) | **None** — affects speed, not direction |

---

## Mechanism 3: Lot Capacity Gating — Hard (Field + Particles)

### Code Location

| File | Lines | Function/Constant |
|------|-------|-------------------|
| `reynosaOverlay.js` | 1012 | `LOT_CAPACITY_THRESHOLD = 0.90` |
| `reynosaOverlay.js` | 1256–1278 | `getLotAcceptance(cellIdx)` |
| `reynosaOverlay.js` | 3216–3268 | Field flow gating in `graphFlowClass()` |
| `reynosaOverlay.js` | 636–668 | Particle-level lot gate with detour logic |

### Formula

```javascript
// getLotAcceptance() — line 1271:
if (fill >= (LOT_CAPACITY_THRESHOLD - FULL_EPS)) {
    return 0.0;  // REJECT
}

// graphFlowClass() — line 3223-3226:
const acceptMultiplier = getLotAcceptance(nh);
const desired = out * acceptMultiplier;
const accepted = Math.min(desired, Math.max(0, remaining));
const rejected = out - accepted;
rhoNext[idx] += (m - out) + rejected;  // Rejected stays on road
```

### Behavior

- When lot utilization ≥ 90%, `getLotAcceptance()` returns 0
- Field mass: rejected mass stays in source cell (road)
- Particles: attempt local detour; if none available, stall on road

### Characteristics

| Property | Value |
|----------|-------|
| Applies to | **Both field mass and particles** |
| Stochastic? | **No** (deterministic threshold) |
| Capacity-limited? | **Yes** (90% of `lotCapacityKg`) |

### Interaction with other systems

| System | Interaction |
|--------|-------------|
| Global FIFO queue | **Critical** — rejected mass never enters lot → never mints token → service rate drops |
| Routing (phi_lots) | **None** — phi_lots is static; gating happens at flow level |
| Pre-transfer friction | **None** — mechanisms are independent |

---

## Mechanism 4: Soft Capacity Bias in phi_lots (Field Routing)

### Code Location

| File | Lines | Function/Constant |
|------|-------|-------------------|
| `reynosaOverlay.js` | 1079–1080 | `SOFT_CAPACITY_ALPHA = 20.0`, `SOFT_CAPACITY_BETA = 4.0` |
| `reynosaOverlay.js` | 2577–2590 | Edge cost penalty in Dijkstra |

### Formula

```javascript
// Line 2582-2587:
const currIsLot = regionMap[idx] === REGION_LOT;
const neighborIsLot = regionMap[ni] === REGION_LOT;
if (!currIsLot && neighborIsLot) {
    const util = getLotUtilization(ni);
    capacityPenalty = 1.0 + SOFT_CAPACITY_ALPHA * Math.pow(util, SOFT_CAPACITY_BETA);
}
const newCost = cost + edgeCost * costMult * roadTypeCost * capacityPenalty;
```

### Behavior

| Lot utilization | Penalty multiplier |
|-----------------|-------------------|
| 0% | 1.0× |
| 50% | 1.0 + 20 × 0.5⁴ = 1.0 + 1.25 = 2.25× |
| 75% | 1.0 + 20 × 0.75⁴ = 1.0 + 6.3 = 7.3× |
| 90% | 1.0 + 20 × 0.9⁴ = 1.0 + 13.1 = 14.1× |

### Characteristics

| Property | Value |
|----------|-------|
| Applies to | **Field mass routing** (phi_lots computation) |
| Stochastic? | **No** (deterministic from utilization) |
| Capacity-limited? | **Yes** (penalizes high-utilization lots) |

### Interaction with other systems

| System | Interaction |
|--------|-------------|
| Lot capacity gating | **Complementary** — soft bias steers mass away before hard gate triggers |
| Global FIFO queue | **Indirect** — spreads load across lots, potentially distributing queue tokens |
| Pre-transfer friction | **None** — orthogonal systems |

---

## Mechanism 5: Graph Flow Fraction Throttle (Field Mass)

### Code Location

| File | Lines | Function/Constant |
|------|-------|-------------------|
| `reynosaOverlay.js` | 3155 | `const FLOW_FRAC = 0.4` |

### Formula

```javascript
// Line 3213:
const out = m * FLOW_FRAC;  // 40% of mass moves per tick
```

### Characteristics

| Property | Value |
|----------|-------|
| Applies to | **Field mass only** |
| Stochastic? | **No** |
| Capacity-limited? | **No** (numerical stability, not congestion model) |

### Interaction with other systems

| System | Interaction |
|--------|-------------|
| All | **None significant** — this is numerical damping, not a congestion mechanism |

---

## Mechanism 6: Lot Conductance Reduction (Field Mass)

### Code Location

| File | Lines | Function/Constant |
|------|-------|-------------------|
| `reynosaOverlay.js` | 1827 | `const K_LOT = 0.4` |
| `reynosaOverlay.js` | 305–307 | `K_BASE = 0.05`, `K_DELTA = 0.95` |

### Behavior

- Lot cells stamped with `K = 0.4` (vs highway `K ≈ 1.0`)
- Lower K = slower diffusion through lot cells
- Does NOT affect nextHop routing (Dijkstra uses edge cost, not K directly)

### Characteristics

| Property | Value |
|----------|-------|
| Applies to | **Field mass** (diffusion rate) |
| Stochastic? | **No** |
| Capacity-limited? | **No** (geometric property) |

### Interaction with other systems

| System | Interaction |
|--------|-------------|
| All | **Minimal** — this affects internal lot flow, not entry gating |

---

## Summary: Pre-Lot Holding Mechanisms

### Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         INJECTION (source cells)                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  MECHANISM 1: Pre-Transfer Friction (PARTICLES ONLY)                    │
│  • 46% shoulder maneuver (1-2h)                                         │
│  • 30% long coordination (1-4h), 70% short (0-1h)                       │
│  • Expected delay: ~1.5-2.5 hours                                       │
│  • Stochastic, purely temporal                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  MECHANISM 2: Dwell-Time Modulation (PARTICLES ONLY)                    │
│  • Speed = baseSpeed / (1 + localRho × DWELL_K)                         │
│  • Deterministic, density-based slowdown                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  MECHANISM 4: Soft Capacity Bias (FIELD ROUTING)                        │
│  • Dijkstra edge penalty: 1 + 20 × util^4                               │
│  • Steers mass toward less-full lots                                    │
│  • Deterministic, capacity-aware                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  MECHANISM 3: Lot Capacity Gating - Hard (FIELD + PARTICLES)            │
│  • At 90% utilization → reject all new entry                            │
│  • Rejected mass stays on road                                          │
│  • Deterministic, capacity-limited                                      │
│  ⚠️ THIS IS THE OSCILLATION TRIGGER                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         LOT STORAGE (rho_restricted_lot)                 │
│                         Token minted → FIFO queue                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         GLOBAL SERVICE (36h min wait)                    │
│                         service_rate = queuedKg / TARGET_DWELL_S         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Final Judgment

### Can pre-transfer friction be promoted to primary congestion layer?

**No.** Pre-transfer friction is:

1. **Particles-only** — field mass (the authoritative physics) ignores it entirely
2. **Purely temporal** — independent of capacity, density, or queue state
3. **Front-loaded** — delays happen at injection, not at lot boundary
4. **Non-blocking** — doesn't create backpressure; particles just wait then proceed

To promote it would require:
- Extending to field mass (add `rho_restricted_predelay` storage class?)
- Coupling to capacity or queue state
- Moving the delay to the lot boundary (which would conflict with FIFO queue)

### Is it redundant/conflicting with the global-queue model?

**Partially redundant, not conflicting:**

| Aspect | Pre-Transfer Friction | Global FIFO Queue |
|--------|----------------------|-------------------|
| Where delay occurs | On roads (before lot) | In lots (after entry) |
| Duration | 1-6 hours | 36-72 hours |
| What triggers clearing | Timer expires | Service budget + eligibility |
| Capacity coupling | None | Indirect (queue depth → service rate) |

**Redundancy:** Both add delay to restricted trucks. The total delay is additive:
```
Total delay = pre-transfer (1-6h) + lot dwell (36-72h) = 37-78 hours
```

**Not conflicting:** The mechanisms are sequential, not competitive. Pre-transfer friction delays entry; FIFO queue delays exit. They don't fight over the same resource.

### Architectural assessment

| Mechanism | Role | Verdict |
|-----------|------|---------|
| Pre-Transfer Friction | Visual flavor (particle stalls) | Keep for visualization; not authoritative |
| Dwell-Time Modulation | Visual flavor (density slowdown) | Keep for visualization; not authoritative |
| Soft Capacity Bias | Load balancing | Keep; complements hard gating |
| **Hard Capacity Gating** | **Primary bottleneck** | **Root cause of oscillation** |
| Flow Fraction | Numerical stability | Keep; not a congestion model |
| Lot Conductance | Internal lot physics | Keep; minor effect |

**The oscillation is caused by Mechanism 3 (hard capacity gating) in the presence of undersized lot capacity, not by pre-transfer friction.**
