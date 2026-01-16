# Temporal Semantics & Timestep Coupling Audit

**Date:** 2025-12-23
**Scope:** reynosaOverlay_v2.js, kernel.js, narrative.js, headlessSim.js, masterTracker.js

---

## 1. Canonical Time Variable Inventory

| Variable | Location | Unit | Semantic Meaning | Operational Meaning | Breaks if dt Changes? |
|----------|----------|------|------------------|---------------------|----------------------|
| `simTime` | overlay:1065 | seconds | Global simulation clock | Hour of day, event scheduling | No (absolute time) |
| `dt` | step() param | seconds | Physics timestep | Particle movement, accumulator deltas | **YES** (core physics) |
| `SIM_TIME_SCALE` | overlay:193 | ratio | Real-to-sim conversion | ~1152x (86400s / 150s) | No (constant) |
| `_dtMs` | overlay:1099 | milliseconds | Frame delta for metrics | HUD display only | No (display only) |
| `_lastMetricsTime` | overlay:1093 | seconds | Rate sampling reference | Inflow/exit rate calculation | No (sampling interval) |
| `_lastRateSampleTime` | overlay:varies | seconds | Loss rate sampling | truckHoursLostRate calculation | No (60s interval) |
| `_lastGateCapHour` | overlay:varies | hour (0-23) | Hourly capacity cache | Avoids reloading same-hour data | No (hourly trigger) |
| `_lastInflowHour` | overlay:864 | hour (0-23) | Hourly inflow cache | Avoids reloading same-hour data | No (hourly trigger) |
| `SERVICE_TIME_S` | overlay:917 | seconds | CBP lane service time | Time per truck per lane | No (derived from capacity) |
| `lane.busyUntil` | overlay:915 | seconds | CBP lane completion | simTime threshold for exit | No (absolute time) |
| `DWELL_S` | overlay:95 | seconds | Lot dwell time | Time before lot→cleared | No (fixed duration) |
| `PARK_DWELL_S` | overlay:948 | seconds | Park dwell time | Time before park→lot | No (fixed duration) |
| `p.lotArrivalTime` | particle | seconds | Per-particle timestamp | Dwell timeout start | No (absolute time) |
| `p.parkArrivalTime` | particle | seconds | Per-particle timestamp | Park timeout start | No (absolute time) |
| `p.age` | particle | seconds | Particle lifetime | Accumulates with dt | **YES** (dt-scaled) |
| `p.stalledTime` | particle | seconds | Stuck duration | Accumulates with dt | **YES** (dt-scaled) |
| `p.wakeOffset` | particle | seconds | Sleep-to-wake offset | Staggered release timing | No (fixed offset) |

### Kernel Time Variables (Visual Path)

| Variable | Location | Unit | Semantic Meaning | Operational Meaning | Breaks if dt Changes? |
|----------|----------|------|------------------|---------------------|----------------------|
| `state.simStart` | kernel:81 | ms (Date.now) | Session start timestamp | Phase elapsed base | N/A (wall-clock) |
| `state.elapsed` | kernel:82 | ms | Wall-clock elapsed | Phase transitions | N/A (wall-clock) |
| `state.simTime` | kernel:136 | ms | Kernel sim time | Queue timing | **FRAME-LOCKED** (+16ms/tick) |
| `state.spawnInterval` | kernel:132 | ms | Spawn cadence | Truck spawning | N/A (wall-clock checked) |
| `state.lastSpawnTime` | kernel:130 | ms (Date.now) | Last spawn time | Spawn interval check | N/A (wall-clock) |

---

## 2. Execution Clock Graph

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            EXECUTION ENTRY POINTS                            │
└──────────────────────────────────────────────────────────────────────────────┘

                     ┌─────────────────────────────────────┐
                     │          VISUAL PATH                │
                     │   (requestAnimationFrame driven)    │
                     └─────────────────────────────────────┘
                                    │
                     ┌──────────────┴──────────────┐
                     │                             │
              ┌──────▼──────┐              ┌───────▼───────┐
              │  onFrame()  │              │   update()    │
              │  (l.7277)   │              │   (l.3471)    │
              └──────┬──────┘              └───────┬───────┘
                     │                             │
         ┌───────────┴───────────┐                 │
         │ time.simTimeSeconds   │                 │
         │ → simTime (sync)      │                 │
         │                       │                 │
         │ time.timeScale OR     │     realDt × SIM_TIME_SCALE
         │ SIM_TIME_SCALE        │                 │
         │ → effectiveScale      │                 │
         └───────────┬───────────┘                 │
                     │                             │
                     │     realDeltaSeconds        │
                     │     × effectiveScale        │
                     │     = simDt                 │
                     │                             │
                     └──────────────┬──────────────┘
                                    │
                             ┌──────▼──────┐
                             │   step(dt)  │
                             │   (l.1670)  │
                             │             │
                             │ dt in sim-  │
                             │ seconds     │
                             └──────┬──────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
           ┌────────▼────────┐ ┌────▼────┐ ┌───────▼───────┐
           │ stepInjection() │ │stepDrift│ │ stepCBP*()    │
           │ (l.1949)        │ │Transfer │ │ (l.1769,1791) │
           │ dt → accum      │ │(l.2002) │ │ simTime-based │
           └─────────────────┘ │ dt→dist │ └───────────────┘
                               └─────────┘

                    ┌──────────────────────────────────────┐
                    │           _particlesDirty = true     │
                    │           (visual path only)         │
                    └──────────────────────────────────────┘

                    ═══════════════════════════════════════

                     ┌─────────────────────────────────────┐
                     │          HEADLESS PATH              │
                     │      (explicit loop driven)         │
                     └─────────────────────────────────────┘
                                    │
                        ┌───────────▼───────────┐
                        │ HeadlessSim.step(dt)  │
                        │    (headlessSim:78)   │
                        └───────────┬───────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
          ┌─────────▼─────────┐           ┌────────▼────────┐
          │ setSimTime(this.  │           │    step(dt)     │
          │   simTime)        │           │    (overlay)    │
          │ (external sync)   │           │                 │
          └───────────────────┘           └────────┬────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │ this.simTime    │
                                          │   += dt         │
                                          │ (manual advance)│
                                          └─────────────────┘

                    ═══════════════════════════════════════

                     ┌─────────────────────────────────────┐
                     │           KERNEL PATH               │
                     │    (visual, archived v1 engine)     │
                     └─────────────────────────────────────┘
                                    │
                        ┌───────────▼───────────┐
                        │      tick()           │
                        │   (kernel:951)        │
                        └───────────┬───────────┘
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          │                         │                         │
┌─────────▼─────────┐   ┌───────────▼───────────┐   ┌────────▼────────┐
│ Date.now() → now  │   │ state.simTime += 16   │   │ narrative.      │
│ state.elapsed =   │   │ (fixed 16ms per tick) │   │ updatePhase1()  │
│ now - simStart    │   │ ASSUMES 60fps         │   │ uses Date.now() │
└───────────────────┘   └───────────────────────┘   └─────────────────┘
```

---

## 3. Discrete Event Classification

### Per-Frame Events (frame-count based)
| Event | Location | Trigger | Consequence |
|-------|----------|---------|-------------|
| HUD cache refresh | overlay:3506 | `_hudCache.frameCount++ >= 30` | Recalculate expensive metrics |
| Draw timing log | overlay:3790 | `frameCount > 0 && now - lastLogTime > 2000` | Performance logging |
| `_particlesDirty = true` | overlay:3481,7299 | Every update()/onFrame() call | GPU sync on next draw |

### Per-Step Events (dt-dependent)
| Event | Location | Trigger | Consequence |
|-------|----------|---------|-------------|
| Particle movement | overlay:2261 | `baseSpeed * c * velJitter * dt` | Position update |
| Injection accumulation | overlay:1993 | `acc += rate * dt` | Particle spawning |
| Age accumulation | overlay:2029 | `p.age += dt` | Particle age |
| Stalled time accumulation | overlay:2033 | `p.stalledTime += dt` | Stuck detection |
| Stall-ton-hours | overlay:1712 | `(totalStallKg/1000) * (dt/3600)` | Metric accumulation |
| Truck-hours lost | overlay:1716 | `_truckHoursLostThisTick * (dt/3600)` | Metric accumulation |
| CFL sub-stepping | overlay:2010-2016 | `dt > maxDtPerStep` | Subdivides large dt |

### Per-Sim-Second Events (simTime threshold)
| Event | Location | Trigger | Consequence |
|-------|----------|---------|-------------|
| Rate sampling | overlay:1724 | `simTime - _lastRateSampleTime >= 60` | Loss rate update |
| Phi rebuild throttle | overlay:3255 | `simTime - _lastRebuildTime >= REBUILD_MIN_INTERVAL_S` | Routing update |

### Hourly Events (hour transition)
| Event | Location | Trigger | Consequence |
|-------|----------|---------|-------------|
| Gate capacity load | overlay:1880 | `currentHour !== _lastGateCapHour` | Update sinkCapKgPerHour |
| Inflow load | overlay:1928 | `currentHour !== _lastInflowHour` | Update inflowKgPerHour |
| Commuter load update | overlay:4289 | Every step() | Recalculate commuterLoad array |

### Threshold-Crossing Events
| Event | Location | Trigger | Consequence |
|-------|----------|---------|-------------|
| CBP completion | overlay:1793 | `simTime >= lane.busyUntil` | Exit particle |
| Lot conversion | overlay:2520 | `waited >= DWELL_S` | Convert lot→cleared |
| Park release | overlay:2541 | `waited >= requiredDwell` | Release park→lot |
| Sleep release | overlay:2585 | `currentDaySeconds >= wakeTimeS` | Wake sleeping particle |
| Stuck log | overlay:2035 | `stalledTime >= 72*3600` | Log stuck particle |
| Intersection blocking | overlay:2245 | `sin(simTime*0.3 + phase) > 0.85` | Skip movement |

### Accumulator-Based Events
| Event | Location | Trigger | Mechanism |
|-------|----------|---------|-----------|
| Particle spawn | overlay:1994 | `acc >= TRUCK_KG` | `acc += rate*dt; while(acc >= TRUCK_KG) spawn()` |

---

## 4. Temporal Non-Invariance Findings

### Finding 1: Kernel simTime Assumes 60fps
**Location:** kernel.js:956
**Code:** `state.simTime += 16`
**Issue:** Fixed 16ms increment regardless of actual frame rate
**Divergence Type:** Linear drift if fps ≠ 60
**Impact:** Queue timing (queuedAtSimTime) diverges from wall-clock

### Finding 2: Kernel Spawning Uses Wall-Clock
**Location:** kernel.js:1023
**Code:** `now - state.lastSpawnTime > currentSpawnInterval` (now = Date.now())
**Issue:** Spawn rate tied to real time, not sim time
**Impact:** During advanceClock() fast-forward, spawning uses simulated clock (correct), but normal tick() uses wall-clock (inconsistent)

### Finding 3: Narrative Uses Wall-Clock
**Location:** narrative.js:176, 661
**Code:** `state.phase1.stateStartTime = Date.now()` / `const now = Date.now()`
**Issue:** Animation timing divorced from sim time
**Impact:** Narrative beats proceed at real-time speed regardless of sim time scale

### Finding 4: Intersection Blocking is simTime-Modulated
**Location:** overlay:2245
**Code:** `Math.sin(simTime * 0.3 + phase) > 0.85`
**Issue:** Blocking frequency depends on simTime, not dt
**Divergence Type:** Non-linear (sinusoidal)
**Impact:** Same particle can experience different blocking patterns depending on when step() is called

### Finding 5: dt-Invariant Dwell Times
**Location:** overlay:2520, 2541
**Mechanism:** Dwell uses `simTime - arrivalTime >= DWELL_S` (absolute threshold)
**Status:** **CORRECT** — not dt-dependent

### Finding 6: dt-Sensitive Stall Metrics
**Location:** overlay:1712, 1716
**Mechanism:** `_stallTonHours += (mass/1000) * (dt/3600)`
**Status:** **CORRECT** — properly scaled by dt

### Finding 7: CFL Sub-Stepping Preserves Invariants
**Location:** overlay:2002-2019
**Mechanism:** Large dt subdivided to ensure `moveDistance < 0.9 * cellSize`
**Status:** **CORRECT** — maintains numerical stability

---

## 5. Render-Physics Coupling Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PHYSICS → RENDER COUPLING                            │
└─────────────────────────────────────────────────────────────────────────────┘

              PHYSICS STATE                           RENDER READS
         ┌─────────────────────┐
         │ Particles:          │
         │   p.x, p.y          │─────────────────────▶ syncPositionsToGL()
         │   p.state           │─────────────────────▶ _glColors (state→color)
         │   p.renderStalled   │─────────────────────▶ stall viz
         │   p.stallReason     │
         └─────────────────────┘

         ┌─────────────────────┐
         │ Cells:              │
         │   cellMass[]        │─────────────────────▶ HUD, congestion heatmap
         │   cellParticles[]   │─────────────────────▶ particle count
         └─────────────────────┘

         ┌─────────────────────┐
         │ Lots:               │
         │   lotMass[]         │─────────────────────▶ _hudCache.lotMassTotal
         │   lotCapacity[]     │
         └─────────────────────┘

         ┌─────────────────────┐
         │ Metrics:            │
         │   metrics.injected  │─────────────────────▶ HUD display
         │   metrics.exited    │─────────────────────▶ HUD display
         │   _truckHoursLost   │
         │   _stallTonHours    │
         └─────────────────────┘

         ┌─────────────────────┐
         │ Global:             │
         │   simTime           │─────────────────────▶ HUD time display
         │   sinkQueue.length  │─────────────────────▶ queue count
         │   CBP_LANES         │─────────────────────▶ lanes in use
         └─────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────┐
│                        RENDER → PHYSICS COUPLING                            │
│                           (SHOULD BE NONE)                                  │
└─────────────────────────────────────────────────────────────────────────────┘

         RENDER ACTION                                PHYSICS IMPACT
         ┌─────────────────────┐
         │ _particlesDirty     │
         │ (set by update/     │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶ NONE (read-only flag)
         │  onFrame, cleared   │
         │  by draw)           │
         └─────────────────────┘

         ┌─────────────────────┐
         │ _hudCache.frameCount│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶ NONE (display refresh)
         └─────────────────────┘

         ┌─────────────────────┐
         │ syncPositionsToGL() │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶ NONE (read-only)
         └─────────────────────┘


         ═══════════════════════════════════════════════════════════════════

         KEY FINDING: NO render→physics coupling in overlay

         Physics is pure: step(dt) has no render dependencies
         Headless path calls step() without any rendering
         Visual path calls step() then sets _particlesDirty
```

---

## 6. Headless vs Visual Delta Analysis

### Execution Path Comparison

| Aspect | Visual Path | Headless Path | Delta |
|--------|-------------|---------------|-------|
| Entry point | `onFrame(camera, time, realDelta)` | `HeadlessSim.step(dt)` | Different entry |
| Time source | External `time.simTimeSeconds` | `this.simTime` (internal) | External vs internal |
| dt calculation | `realDelta * effectiveScale` | Passed directly | Scaling vs raw |
| simTime sync | Before step() | Before step() | Same |
| simTime advance | External responsibility | `this.simTime += dt` after step() | External vs explicit |
| GPU dirty flag | `_particlesDirty = true` | Never set | Visual-only side effect |
| Narrative | Updates via kernel.tick() | Not executed | Missing in headless |

### Trajectory Reproducibility Test

**Hypothesis:** Same dt sequence → same particle trajectories

**Verification Points:**
1. `step(dt)` is pure function of: simTime, dt, scenario, particle state
2. No hidden state in overlay that differs between paths
3. RNG uses deterministic seeding (if applicable)

**Risk Factors:**
1. `rng()` calls in overlay (l.2053, 2055, 2056, 2255) — appears to be unseeded
2. Intersection blocking depends on `simTime * 0.3` — affected by when step() is called
3. Pulse injection uses `simTime` for phase — consistent if simTime synced correctly

### Clock Synchronization

| Clock | Visual | Headless | Sync Method |
|-------|--------|----------|-------------|
| simTime | External (time object) | setSimTime() before step | Explicit sync |
| dt | Computed from realDelta | Passed directly | Caller controlled |
| Hour-of-day | `Math.floor(simTime/3600) % 24` | Same | Derived from simTime |

---

## 7. Executive Summary

### What's dt-Invariant (Safe)
- Dwell times (absolute simTime thresholds)
- CBP lane completion (absolute simTime thresholds)
- Hourly rate loading (hour-of-day triggers)
- Sleep release timing (absolute simTime thresholds)

### What's dt-Sensitive (Correct Scaling)
- Particle movement: `distance = speed * dt` ✓
- Injection accumulation: `acc += rate * dt` ✓
- Stall metrics: `_stallTonHours += mass * (dt/3600)` ✓
- Truck-hours lost: `_truckHoursLost += loss * (dt/3600)` ✓

### What's Temporally Anomalous (Investigate)
1. **Kernel simTime += 16** — Assumes 60fps, drifts at other rates
2. **Kernel spawning uses Date.now()** — Wall-clock, not sim-clock
3. **Narrative uses Date.now()** — Animation divorced from physics
4. **Intersection sin() blocking** — simTime-phase dependent, not dt-scaled

### Headless Purity Assessment
**VERDICT: MOSTLY PURE**

The overlay's `step(dt)` function is:
- Free of render dependencies
- Properly dt-scaled for continuous quantities
- Uses absolute simTime for discrete events

**One concern:** `rng()` appears unseeded, meaning:
- Different run → different particle scatter in lots
- Different run → different velocity jitter

If exact reproducibility is required, RNG seeding should be audited.

---

## Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Kernel simTime drift at non-60fps | Medium | Low (visual only) | Use frame delta instead of fixed 16ms |
| RNG non-reproducibility | Low | Medium | Seed RNG from scenario or simTime |
| Intersection blocking phase sensitivity | Low | Medium | Document as intentional variation |
| Narrative wall-clock timing | Low | Low | Only affects visual, not physics |

---

*This audit is diagnostic only. No recommendations. Only truth.*
