# reynosaOverlay_v2.js Export Audit

## REQUIRED EXPORTS

### Currently Available
| Function | Purpose | Status |
|----------|---------|--------|
| `getMetrics()` | Returns truckHoursLost, truckHoursLostRate, etc. | OK |
| `getParticleCount()` | Returns active particle count | OK |
| `setTwinSpanCapacityMultiplier(mult)` | Twin Span capacity toggle (1.0-2.0) | OK |
| `setInterserranaScenario(scenario)` | Interserrana corridor toggle | OK |
| `togglePhasesAsLots()` | Inovus lot phases toggle | OK |

### NOT EXPORTED (but needed)
| Function | Line | Purpose |
|----------|------|---------|
| `step(dt)` | 1592 | Pure physics step |
| `reset()` | 2794 | State reset |

## RENDER-ONLY FUNCTIONS (ignore for headless)
- `draw(ctx, camera)`
- `drawPhiBaseDebug(ctx, camera)`
- `setWebGLRenderer(renderer)`
- `toggleDarkMode()` / `isDarkMode()`
- `toggleCongestionHeatmap()` / `isShowingCongestionHeatmap()`
- `toggleCommuterDebug()` / `isShowingCommuterDebug()`
- `toggleParticleDebugClassColors()` / `isParticleDebugColors()`
- `toggleParticleSourceColors()` / `isParticleSourceColors()`
- `cycleParticleColorMode()` / `getParticleColorMode()` / `getParticleColorModeName()`

## ISSUES FOUND

### 1. Render dependency in step() (line 1594)
```javascript
function step(dt) {
    _particlesDirty = true;  // RENDER FLAG in physics
```
**Impact:** `_particlesDirty` is only used by render code. Harmless in headless but shouldn't be in physics.

### 2. update() requires camera parameter
```javascript
export function update(realDt, camera) {  // camera unused but required
```
**Impact:** Caller must pass camera even for headless. Should be optional.

### 3. ~~Metrics are counts, not kg~~ RESOLVED
```javascript
const metrics = {
    injected: 0,  // ALREADY kg (incremented by TRUCK_KG)
    exited: 0,    // ALREADY kg (incremented by TRUCK_KG)
```
**Status:** Agent M verified metrics.injected/exited increment by TRUCK_KG, so they ARE already in kg.
**Solution:** Use `getMetricsPhase1()` which exposes `injectedKg` and `exitedKg` directly.

### 4. getState() returns wrong thing
```javascript
export function getState() {
    return state;  // Returns OverlayState (ON/OFF), NOT particle state
}
```
**Impact:** For active particles, use `getParticleCount()` instead.

### 5. ~~No direct step() or reset() export~~ RESOLVED
**Status:** `step(dt)` and `reset()` are now exported.

## VALIDATION CHECKLIST (PHASE 1)

| Metric | Accessible? | How |
|--------|-------------|-----|
| truckHoursLost | YES | `getMetricsPhase1().truckHoursLost` |
| stallTonHours | YES | `getMetricsPhase1().stallTonHours` |
| injectedKg | YES | `getMetricsPhase1().injectedKg` (already kg, no multiplication) |
| exitedKg | YES | `getMetricsPhase1().exitedKg` (already kg, no multiplication) |
| activeParticles | YES | `getMetricsPhase1().activeParticles` |
| Mass invariant | YES | `assertMassInvariantPhase1()` |
| Inovus toggle | YES | `togglePhasesAsLots()` |
| Twin Span toggle | YES | `setTwinSpanCapacityMultiplier(mult)` |
| Interserrana toggle | YES | `setInterserranaScenario(scenario)` |

## HEADLESS EXPORTS (IMPLEMENTED)

```javascript
export function step(dt)                    // Pure physics, no render deps
export function reset()                     // Full state reset
export function getMetricsPhase1()          // {injectedKg, exitedKg, activeParticles, truckHoursLost, stallTonHours}
export function assertMassInvariantPhase1() // Throws if mass conservation violated
```

---

## METRICS & TRACKERS INVENTORY

### 1. metrics.injected
- **Variable name:** `metrics.injected`
- **Units:** kg
- **Monotonic:** yes (within sim)
- **Reset:** per sim (line 2825)
- **Updated where:** `injectParticle()` ~line 1121
- **Depends on:** TRUCK_KG constant (9000)
- **Meaning:** Cumulative mass injected into the simulation from all sources

### 2. metrics.moved
- **Variable name:** `metrics.moved`
- **Units:** kg
- **Monotonic:** yes (within sim)
- **Reset:** per sim (line 2826)
- **Updated where:** `applyTransfer()` ~line 2349
- **Depends on:** TRUCK_KG, successful cell transfers
- **Meaning:** Cumulative mass that completed road-to-road cell transitions

### 3. metrics.enteredLots
- **Variable name:** `metrics.enteredLots`
- **Units:** kg
- **Monotonic:** yes (within sim)
- **Reset:** per sim (line 2827)
- **Updated where:** `applyTransfer()` ~line 2283
- **Depends on:** TRUCK_KG, lot admission
- **Meaning:** Cumulative mass that entered lot storage for conversion

### 4. metrics.enteredParks
- **Variable name:** `metrics.enteredParks`
- **Units:** kg
- **Monotonic:** yes (within sim)
- **Reset:** per sim (line 2828)
- **Updated where:** `applyTransfer()` ~line 2318
- **Depends on:** TRUCK_KG, park admission
- **Meaning:** Cumulative mass that entered park waiting zones

### 5. metrics.releasedFromParks
- **Variable name:** `metrics.releasedFromParks`
- **Units:** kg
- **Monotonic:** yes (within sim)
- **Reset:** per sim (line 2829)
- **Updated where:** `releasePark()` ~line 1230
- **Depends on:** TRUCK_KG, dwell time completion
- **Meaning:** Cumulative mass released from park zones after dwell

### 6. metrics.converted
- **Variable name:** `metrics.converted`
- **Units:** kg
- **Monotonic:** yes (within sim)
- **Reset:** per sim (line 2830)
- **Updated where:** `convertParticle()` ~line 1205
- **Depends on:** TRUCK_KG, DWELL_S elapsed
- **Meaning:** Cumulative mass converted from restricted to cleared state

### 7. metrics.exited
- **Variable name:** `metrics.exited`
- **Units:** kg
- **Monotonic:** yes (within sim)
- **Reset:** per sim (line 2831)
- **Updated where:** `stepCBPCompletion()` ~line 1731
- **Depends on:** TRUCK_KG, CBP lane service completion
- **Meaning:** Cumulative mass that exited through PHARR (authoritative throughput)

### 8. metrics.violations
- **Variable name:** `metrics.violations`
- **Units:** count
- **Monotonic:** yes (within sim)
- **Reset:** per sim (line 2832)
- **Updated where:** invariant assertion functions ~lines 1061, 1070, 1080, 1100, 2231
- **Depends on:** invariant failures
- **Meaning:** Count of physics/accounting invariant violations detected

### 9. _stalledMassKg
- **Variable name:** `_stalledMassKg`
- **Units:** kg
- **Monotonic:** no
- **Reset:** per tick (line 1597)
- **Updated where:** `stepDriftAndTransferInner()` ~line 2130
- **Depends on:** congestionFactor < STALL_CUTOFF, TRUCK_KG
- **Meaning:** Instantaneous mass slowed below stall threshold this frame

### 10. _stallTonHours
- **Variable name:** `_stallTonHours`
- **Units:** ton-hours
- **Monotonic:** yes
- **Reset:** never (explicit in comment, line 1474)
- **Updated where:** `step()` ~line 1631
- **Depends on:** _stalledMassKg + queue lengths, dt
- **Meaning:** Cumulative delay-weighted mass including queues (stall-ton-hours)

### 11. _truckHoursLost
- **Variable name:** `_truckHoursLost`
- **Units:** truck-hours
- **Monotonic:** yes (enforced with invariant check line 1638)
- **Reset:** per sim (line 2838)
- **Updated where:** `step()` ~line 1635
- **Depends on:** _truckHoursLostThisTick, dt
- **Meaning:** Cumulative delay vs free-flow (1 truck at c=0 for 1hr = 1 truck-hour lost)

### 12. _truckHoursLostThisTick
- **Variable name:** `_truckHoursLostThisTick`
- **Units:** dimensionless (truck count x loss factor)
- **Monotonic:** no
- **Reset:** per tick (line 1598)
- **Updated where:** `stepDriftAndTransferInner()` ~line 2140
- **Depends on:** (1 - congestionFactor) per particle
- **Meaning:** Per-tick accumulator for truck-hours lost calculation

### 13. _truckHoursLostRate
- **Variable name:** `_truckHoursLostRate`
- **Units:** truck-hours per sim-hour
- **Monotonic:** no
- **Reset:** per sim (line 2840)
- **Updated where:** `step()` ~lines 1643-1658
- **Depends on:** _truckHoursLost delta over 60 sim-seconds
- **Meaning:** Current rate of delay accumulation (smoothed over 60s window)

### 14. _inRateKtMin
- **Variable name:** `_inRateKtMin`
- **Units:** kt/min (kilotons per sim-minute)
- **Monotonic:** no
- **Reset:** implicitly per sim
- **Updated where:** `drawMetricsPanel()` ~line 3274
- **Depends on:** metrics.injected delta over 60 sim-seconds
- **Meaning:** Current injection rate displayed in HUD

### 15. _outRateKtMin
- **Variable name:** `_outRateKtMin`
- **Units:** kt/min (kilotons per sim-minute)
- **Monotonic:** no
- **Reset:** implicitly per sim
- **Updated where:** `drawMetricsPanel()` ~line 3275
- **Depends on:** metrics.exited delta over 60 sim-seconds
- **Meaning:** Current exit rate displayed in HUD (throughput rate)

### 16. _activeParticleCount
- **Variable name:** `_activeParticleCount`
- **Units:** count (particles)
- **Monotonic:** no
- **Reset:** per sim (line 2795)
- **Updated where:** `addToActiveParticles()` ~line 780, `removeFromActiveParticles()` ~line 786
- **Depends on:** inject/exit events
- **Meaning:** Current number of particles in simulation (trucks in system)

### 17. sinkQueue.length
- **Variable name:** `sinkQueue.length`
- **Units:** count (particles)
- **Monotonic:** no
- **Reset:** per sim (line 2814)
- **Updated where:** `applyTransfer()` ~line 2250, `stepCBPAssignment()` ~line 1694
- **Depends on:** particles reaching sink, CBP lane availability
- **Meaning:** Particles queued at PHARR waiting for CBP lane

### 18. conversionQueue.length
- **Variable name:** `conversionQueue.length`
- **Units:** count (particles)
- **Monotonic:** no
- **Reset:** per sim (line 2813)
- **Updated where:** `applyTransfer()` ~line 2282, `stepConversion()` ~line 2388
- **Depends on:** lot entry, dwell time completion
- **Meaning:** Particles in lots waiting for conversion completion

### 19. sinkCapKgPerHour
- **Variable name:** `sinkCapKgPerHour`
- **Units:** kg/hr
- **Monotonic:** no
- **Reset:** never (scenario-driven)
- **Updated where:** `loadGateCapacity()` ~line 1803
- **Depends on:** scenario hourly capacity, _twinSpanCapMult
- **Meaning:** Current PHARR bridge throughput capacity (from scenario)

### 20. inflowKgPerHour
- **Variable name:** `inflowKgPerHour`
- **Units:** kg/hr
- **Monotonic:** no
- **Reset:** never (scenario-driven)
- **Updated where:** `loadHourlyInflow()` ~lines 1855-1857
- **Depends on:** scenario hourly inflow, _scenarioAlpha interpolation
- **Meaning:** Current corridor inflow rate (from CIEN bundle)

### 21. dailyTotalKg
- **Variable name:** `dailyTotalKg`
- **Units:** kg
- **Monotonic:** no
- **Reset:** per scenario load
- **Updated where:** `loadHourlyInflow()` ~lines 1838-1841
- **Depends on:** sum of 24 hourly scenario values
- **Meaning:** Total daily throughput used for industrial shift calculation

---

## Redundancies / Overlaps

- `_stalledMassKg` and `_truckHoursLostThisTick` — both measure congestion impact per tick but with different semantics (mass vs delay)
- `_stallTonHours` and `_truckHoursLost` — both are cumulative delay metrics; `_stallTonHours` includes explicit queues, `_truckHoursLost` is pure congestion-based
- `metrics.injected` and `_inRateKtMin` — integral vs rate of same underlying quantity
- `metrics.exited` and `_outRateKtMin` — integral vs rate of same underlying quantity
- `sinkQueue.length * TRUCK_KG` and portion of `_stallTonHours` — queue mass is folded into stall calculation

---

## Rate Metrics

- `_inRateKtMin` — injection rate
- `_outRateKtMin` — exit rate (throughput rate)
- `_truckHoursLostRate` — delay accumulation rate

---

## Derivable But Not Stored

- **roadMass** — sum of cellMass[i] for i in roadCellIndices (computed in HUD cache)
- **lotMassTotal** — sum of lotMass[] (computed in HUD cache)
- **totalMass** — roadMass + lotMassTotal + metrics.exited (computed in HUD)
- **peakCellMass** — max(cellMass[i]) for road cells (computed in HUD cache)
- **lotsOccupied** — count of lots with lotMass > 0 (computed in HUD cache)
- **maxLotUtil** — max(lotMass[i]/lotCapacity[i]) (computed in HUD cache)
- **sinkQueueKg** — sinkQueue.length * TRUCK_KG (computed in getMetrics)
- **lotQueueKg** — conversionQueue.length * TRUCK_KG (computed in getMetrics)
- **cbpLanesInUse** — count of CBP_LANES where particle !== null (computed in step)
- **particleCount per state** — countable from _activeParticles by p.state

# MASTER TRACKER v0 — MVP SPEC

**Build time:** 5 hours
**Delivers:** Headless A/B comparison with invariant checking

---

## SCOPE: WHAT'S IN / WHAT'S OUT

| IN (v0) | OUT (v1+) |
|---------|-----------|
| Headless sim wrapper | CLI interface |
| Single run | Parameter sweeps |
| A/B comparison | Equilibrium detection |
| 5 core metrics | Full metric registry |
| 3 critical invariants | Full invariant suite |
| JSON output | CSV, reports |
| Console logging | Fancy visualization |

---

## FILE STRUCTURE

```
tracker/
├── headlessSim.js      # 1.5 hrs — Strip render, expose physics
├── masterTracker.js    # 2.0 hrs — Run harness + comparison
├── runComparison.js    # 0.5 hrs — Entry point script
└── results/            # Output directory
```

---

## FILE 1: headlessSim.js (1.5 hrs)

```javascript
/**
 * Headless simulation wrapper.
 * Strips all render dependencies, exposes pure physics.
 */

// Import physics only (no render imports)
import {
    // You'll need to identify which exports are physics-only
    // This is the main work: untangling render from physics
} from '../overlay/reynosaOverlay_v2.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
    inovusEnabled: false,
    twinSpanEnabled: false,
    interserranaEnabled: false,
};

// ═══════════════════════════════════════════════════════════════════════════
// HEADLESS SIM CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class HeadlessSim {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.simTime = 0;
        this.metrics = {
            truckHoursLost: 0,
            truckHoursLostRate: 0,
            injectedKg: 0,
            exitedKg: 0,
            activeParticles: 0,
        };
    }

    /**
     * Initialize simulation state.
     * Call once before running.
     */
    async init() {
        // Initialize overlay in headless mode
        // This is where you call onAttach() equivalent without canvas
        
        // Apply config toggles
        if (this.config.inovusEnabled) {
            // Enable Inovus lot
        }
        if (this.config.twinSpanEnabled) {
            // setTwinSpanCapacityMultiplier(2);
        }
        
        console.log('[HEADLESS] Initialized with config:', this.config);
    }

    /**
     * Advance simulation by dt seconds.
     */
    step(dt) {
        // Call the physics step function
        // step(dt) from reynosaOverlay_v2.js
        
        this.simTime += dt;
        this._updateMetrics();
    }

    /**
     * Run simulation for duration seconds.
     * @param {number} duration - Total sim time in seconds
     * @param {number} dt - Time step (default 0.1s)
     * @param {function} onTick - Optional callback per step
     */
    run(duration, dt = 0.1, onTick = null) {
        const startWall = Date.now();
        let lastLog = 0;
        
        while (this.simTime < duration) {
            this.step(dt);
            
            if (onTick) onTick(this.simTime, this.metrics);
            
            // Progress log every 10%
            const pct = Math.floor(this.simTime / duration * 10);
            if (pct > lastLog) {
                lastLog = pct;
                console.log(`[HEADLESS] ${pct * 10}% (${(this.simTime / 3600).toFixed(1)}h)`);
            }
        }
        
        const wallTime = (Date.now() - startWall) / 1000;
        console.log(`[HEADLESS] Done. ${(duration / 3600).toFixed(1)}h sim in ${wallTime.toFixed(1)}s wall`);
        
        return this.metrics;
    }

    /**
     * Pull current metrics from physics state.
     */
    _updateMetrics() {
        const m = getMetrics();  // From reynosaOverlay_v2.js
        const s = getState();    // From reynosaOverlay_v2.js
        
        this.metrics = {
            truckHoursLost: m.truckHoursLost || 0,
            truckHoursLostRate: m.truckHoursLostRate || 0,
            injectedKg: m.injected || 0,
            exitedKg: m.exited || 0,
            activeParticles: s.activeParticles || 0,
        };
    }

    /**
     * Get current metrics snapshot.
     */
    getMetrics() {
        return { ...this.metrics, simTime: this.simTime };
    }

    /**
     * Reset simulation to initial state.
     */
    reset() {
        // Call reset() from reynosaOverlay_v2.js
        this.simTime = 0;
        this._updateMetrics();
    }
}
```

### Critical Task: Identify Physics-Only Exports

Search `reynosaOverlay_v2.js` for what's needed:

```bash
grep -n "^export" reynosaOverlay_v2.js
```

**Need:**
- `step(dt)` or equivalent physics tick
- `getMetrics()`
- `getState()`
- `reset()`
- Lot toggle (for Inovus)
- `setTwinSpanCapacityMultiplier()`

**Don't need:**
- `drawRoads()`
- `renderParticles()`
- Any `ctx` or canvas references

If physics and render are entangled, you may need to:
1. Add a `headless` flag that skips render calls, or
2. Create stub canvas/ctx that no-ops

---

## FILE 2: masterTracker.js (2.0 hrs)

```javascript
/**
 * Master Tracker — Headless run harness with invariant checking.
 */

import { HeadlessSim } from './headlessSim.js';
import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════

const SCENARIOS = {
    baseline: {
        name: 'Baseline',
        config: {
            inovusEnabled: false,
            twinSpanEnabled: false,
        },
    },
    inovus: {
        name: 'Inovus Enabled',
        config: {
            inovusEnabled: true,
            twinSpanEnabled: false,
        },
    },
    twin_span: {
        name: 'Twin Span',
        config: {
            inovusEnabled: false,
            twinSpanEnabled: true,
        },
    },
    full: {
        name: 'Full Infrastructure',
        config: {
            inovusEnabled: true,
            twinSpanEnabled: true,
        },
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANTS (Critical 3 only)
// ═══════════════════════════════════════════════════════════════════════════

const INVARIANTS = {
    monotonicity: {
        name: 'truckHoursLost monotonic',
        check: (prev, curr) => curr.truckHoursLost >= prev.truckHoursLost - 1e-6,
    },
    rateBound: {
        name: 'Rate ≤ active particles',
        check: (prev, curr) => curr.truckHoursLostRate <= curr.activeParticles + 1,
    },
    massConservation: {
        name: 'Mass conservation',
        check: (prev, curr) => {
            const inSystem = curr.activeParticles * 9000;  // TRUCK_KG
            const expected = curr.injectedKg - curr.exitedKg;
            return Math.abs(inSystem - expected) < 10000;  // 10 ton tolerance
        },
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// SINGLE RUN
// ═══════════════════════════════════════════════════════════════════════════

export async function runScenario(scenarioName, options = {}) {
    const {
        duration = 24 * 3600,       // 24 hours default
        warmup = 2 * 3600,          // 2 hour warmup
        sampleInterval = 60,        // Sample every 60s
        dt = 0.1,                   // Physics timestep
        checkInvariants = true,
    } = options;

    const scenario = SCENARIOS[scenarioName];
    if (!scenario) throw new Error(`Unknown scenario: ${scenarioName}`);

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`RUNNING: ${scenario.name}`);
    console.log(`Duration: ${duration / 3600}h, Warmup: ${warmup / 3600}h`);
    console.log(`${'═'.repeat(60)}\n`);

    const sim = new HeadlessSim(scenario.config);
    await sim.init();

    const timeSeries = [];
    const violations = [];
    let prevMetrics = sim.getMetrics();
    let lastSample = 0;

    const startWall = Date.now();

    // Run simulation
    sim.run(duration, dt, (simTime, metrics) => {
        // Sample metrics
        if (simTime - lastSample >= sampleInterval) {
            const snapshot = { t: simTime, ...sim.getMetrics() };
            timeSeries.push(snapshot);
            lastSample = simTime;

            // Check invariants
            if (checkInvariants && simTime > warmup) {
                for (const [key, inv] of Object.entries(INVARIANTS)) {
                    if (!inv.check(prevMetrics, snapshot)) {
                        violations.push({
                            t: simTime,
                            invariant: key,
                            name: inv.name,
                            prev: prevMetrics,
                            curr: snapshot,
                        });
                        console.warn(`[INVARIANT] ${inv.name} violated at t=${simTime.toFixed(0)}s`);
                    }
                }
            }

            prevMetrics = snapshot;
        }
    });

    const wallTime = (Date.now() - startWall) / 1000;

    // Compute summary (post-warmup only)
    const postWarmup = timeSeries.filter(s => s.t >= warmup);
    const finalMetrics = postWarmup[postWarmup.length - 1] || sim.getMetrics();
    
    const summary = {
        truckHoursLost: finalMetrics.truckHoursLost,
        truckHoursLostRate_final: finalMetrics.truckHoursLostRate,
        truckHoursLostRate_mean: mean(postWarmup.map(s => s.truckHoursLostRate)),
        throughput_total: finalMetrics.exitedKg,
        throughput_rate: finalMetrics.exitedKg / ((duration - warmup) / 3600),
    };

    const result = {
        meta: {
            scenario: scenarioName,
            name: scenario.name,
            config: scenario.config,
            duration,
            warmup,
            wallTime,
            timestamp: new Date().toISOString(),
        },
        summary,
        invariants: {
            passed: violations.length === 0,
            violations,
        },
        timeSeries,
    };

    console.log(`\n[RESULT] ${scenario.name}`);
    console.log(`  truckHoursLost: ${summary.truckHoursLost.toFixed(1)}`);
    console.log(`  truckHoursLostRate (final): ${summary.truckHoursLostRate_final.toFixed(2)}`);
    console.log(`  truckHoursLostRate (mean): ${summary.truckHoursLostRate_mean.toFixed(2)}`);
    console.log(`  Invariants: ${violations.length === 0 ? '✅ PASSED' : `❌ ${violations.length} VIOLATIONS`}`);

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// A/B COMPARISON
// ═══════════════════════════════════════════════════════════════════════════

export async function compare(baselineScenario, treatmentScenario, options = {}) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`A/B COMPARISON: ${baselineScenario} vs ${treatmentScenario}`);
    console.log(`${'═'.repeat(60)}\n`);

    const baseline = await runScenario(baselineScenario, options);
    const treatment = await runScenario(treatmentScenario, options);

    const delta = {
        truckHoursLost: treatment.summary.truckHoursLost - baseline.summary.truckHoursLost,
        truckHoursLost_pct: pctChange(baseline.summary.truckHoursLost, treatment.summary.truckHoursLost),
        
        truckHoursLostRate_final: treatment.summary.truckHoursLostRate_final - baseline.summary.truckHoursLostRate_final,
        truckHoursLostRate_final_pct: pctChange(baseline.summary.truckHoursLostRate_final, treatment.summary.truckHoursLostRate_final),
        
        throughput_rate: treatment.summary.throughput_rate - baseline.summary.throughput_rate,
        throughput_rate_pct: pctChange(baseline.summary.throughput_rate, treatment.summary.throughput_rate),
    };

    const result = {
        baseline,
        treatment,
        delta,
        headline: formatHeadline(treatmentScenario, delta),
    };

    console.log(`\n${'═'.repeat(60)}`);
    console.log('COMPARISON RESULT');
    console.log(`${'═'.repeat(60)}`);
    console.log(`\n${result.headline}\n`);
    console.log('Delta:');
    console.log(`  truckHoursLost: ${delta.truckHoursLost.toFixed(1)} (${delta.truckHoursLost_pct.toFixed(1)}%)`);
    console.log(`  truckHoursLostRate: ${delta.truckHoursLostRate_final.toFixed(2)} (${delta.truckHoursLostRate_final_pct.toFixed(1)}%)`);
    console.log(`  throughput: ${delta.throughput_rate.toFixed(0)} kg/h (${delta.throughput_rate_pct.toFixed(1)}%)`);

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

export function saveResult(result, filename) {
    const dir = './tracker/results';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, JSON.stringify(result, null, 2));
    console.log(`[SAVED] ${filepath}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pctChange(baseline, treatment) {
    if (baseline === 0) return treatment === 0 ? 0 : Infinity;
    return ((treatment - baseline) / baseline) * 100;
}

function formatHeadline(scenario, delta) {
    const direction = delta.truckHoursLostRate_final_pct < 0 ? 'reduced' : 'increased';
    const pct = Math.abs(delta.truckHoursLostRate_final_pct).toFixed(1);
    return `${SCENARIOS[scenario]?.name || scenario} ${direction} truck-hours lost by ${pct}%`;
}
```

---

## FILE 3: runComparison.js (0.5 hrs)

```javascript
/**
 * Entry point — Run Inovus A/B comparison.
 * 
 * Usage: node tracker/runComparison.js
 */

import { compare, saveResult } from './masterTracker.js';

async function main() {
    const options = {
        duration: 48 * 3600,    // 48 hours
        warmup: 4 * 3600,       // 4 hour warmup
        sampleInterval: 60,     // Every minute
        checkInvariants: true,
    };

    try {
        const result = await compare('baseline', 'inovus', options);
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        saveResult(result, `comparison_baseline_vs_inovus_${timestamp}.json`);
        
        // Exit with error code if invariants failed
        const anyViolations = 
            result.baseline.invariants.violations.length > 0 ||
            result.treatment.invariants.violations.length > 0;
        
        if (anyViolations) {
            console.error('\n❌ INVARIANT VIOLATIONS DETECTED');
            process.exit(1);
        }
        
        console.log('\n✅ Run complete, no violations');
        process.exit(0);
        
    } catch (err) {
        console.error('Run failed:', err);
        process.exit(1);
    }
}

main();
```

---

## CRITICAL INTEGRATION TASK (1 hr within headlessSim.js time)

The hardest part: making `reynosaOverlay_v2.js` run without canvas.

### Option A: Add Headless Flag (Cleanest)

```javascript
// In reynosaOverlay_v2.js, near top
let _headlessMode = false;

export function setHeadlessMode(enabled) {
    _headlessMode = enabled;
}

// Then wrap all render calls:
function drawRoads(ctx) {
    if (_headlessMode) return;
    // ... existing render code
}

function renderParticles(ctx) {
    if (_headlessMode) return;
    // ... existing render code
}
```

### Option B: Stub Canvas (Faster Hack)

```javascript
// In headlessSim.js, before importing overlay
globalThis.document = {
    createElement: () => ({
        getContext: () => ({
            fillRect: () => {},
            strokeRect: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            stroke: () => {},
            fill: () => {},
            save: () => {},
            restore: () => {},
            translate: () => {},
            scale: () => {},
            rotate: () => {},
            setTransform: () => {},
            createLinearGradient: () => ({ addColorStop: () => {} }),
            measureText: () => ({ width: 0 }),
        }),
        width: 1,
        height: 1,
    }),
};

globalThis.Path2D = class { 
    moveTo() {} 
    lineTo() {} 
};

// Now import overlay
import { ... } from '../overlay/reynosaOverlay_v2.js';
```

---

## 5-HOUR TIMELINE

| Hour | Task |
|------|------|
| 0-1 | Identify physics exports, test overlay imports headlessly |
| 1-2 | Implement `HeadlessSim` class with stubs |
| 2-3 | Wire up `step()`, `getMetrics()`, `reset()` |
| 3-4 | Implement `masterTracker.js` — single run + comparison |
| 4-5 | Test end-to-end, fix bugs, save first result |

---

## SUCCESS CRITERIA

At hour 5, you can run:

```bash
node tracker/runComparison.js
```

And get:

```
═══════════════════════════════════════════════════════════
A/B COMPARISON: baseline vs inovus
═══════════════════════════════════════════════════════════

RUNNING: Baseline
Duration: 48h, Warmup: 4h
[HEADLESS] 10% (4.8h)
[HEADLESS] 20% (9.6h)
...
[HEADLESS] Done. 48h sim in 23.4s wall

[RESULT] Baseline
  truckHoursLost: 892.3
  truckHoursLostRate (final): 18.7
  Invariants: ✅ PASSED

RUNNING: Inovus Enabled
...

═══════════════════════════════════════════════════════════
COMPARISON RESULT
═══════════════════════════════════════════════════════════

Inovus Enabled reduced truck-hours lost by 14.2%

Delta:
  truckHoursLost: -126.7 (-14.2%)
  truckHoursLostRate: -2.65 (-14.2%)
  throughput: 1200 kg/h (+2.8%)

[SAVED] tracker/results/comparison_baseline_vs_inovus_2025-12-21T...json

✅ Run complete, no violations
```

---

## WHAT YOU DEFER TO v1

- CLI argument parsing (hardcode scenarios for now)
- CSV output (JSON is enough)
- Parameter sweeps (manual config changes for now)
- Equilibrium detection (fixed duration is fine)
- Full invariant suite (3 critical ones catch most lies)
- Pretty reports (console log is enough)

**v0 answers one question:** Does Inovus reduce truck-hours lost, and by how much?

Everything else is polish.