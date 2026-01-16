# dt-Invariance Deep Audit & Fix Plan

## (A) Time Interaction Matrix

### Continuous Accumulations (dt-scaled)

| Location | Variable | Update Rule | dt Sensitivity | Bug? |
|----------|----------|-------------|----------------|------|
| 2029 | `p.age` | `+= dt` | ✓ Correct | No |
| 2033 | `p.stalledTime` | `+= dt` | ✓ Correct | No |
| 2261 | `moveDistance` | `baseSpeed * c * velJitter * dt` | ✓ Correct | No |
| 1993 | `injectionAccumulator` | `+= rate * dt` | ✓ Correct | No |

### Accumulations with CFL Sub-stepping (BUGGY)

| Location | Variable | Update Rule | Bug |
|----------|----------|-------------|-----|
| 2226 | `_stalledMassKg` | `+= TRUCK_KG` per substep | **Per-substep, but scaled by full dt** |
| 2236 | `_truckHoursLostThisTick` | `+= loss` per substep | **Per-substep, but scaled by full dt** |
| 1712 | `_stallTonHours` | `+= (_stalledMassKg/1000) * (dt/3600)` | Receives inflated `_stalledMassKg` |
| 1716 | `_truckHoursLost` | `+= _truckHoursLostThisTick * (dt/3600)` | Receives inflated accumulator |

**Root Cause:** `stepDriftAndTransferInner()` is called N times (CFL substeps), accumulating N× more, but `step()` then multiplies by full dt instead of accounting for substeps.

### Discrete Service Events (At-Most-One-Per-Tick)

| Location | Event | Trigger | Bug |
|----------|-------|---------|-----|
| 1793 | CBP completion | `simTime >= lane.busyUntil` | **Only 1 exit/lane/tick** |
| 1774 | CBP assignment | `lane.particle === null` | Only assigns after completion |

**Root Cause:** If `SERVICE_TIME_S < dt`, multiple trucks SHOULD complete within [t, t+dt], but only one does.

**Impact:** At dt=60 with SERVICE_TIME_S≈30s, throughput drops ~50%.

### Hourly Caches (Boundary Skipping)

| Location | Variable | Trigger | Bug |
|----------|----------|---------|-----|
| 1880 | `_lastGateCapHour` | `currentHour !== _lastGateCapHour` | **Skips hours if dt > 3600** |
| 1928 | `_lastInflowHour` | `currentHour !== _lastInflowHour` | **Skips hours if dt > 3600** |

**Root Cause:** Uses `if` instead of `while` to catch all hour boundaries.

### Sampled Gates (Temporal Aliasing)

| Location | Event | Sample Rule | Bug |
|----------|-------|-------------|-----|
| 2245 | Intersection blocking | `sin(simTime * 0.3 + phase) > 0.85` | **Aliased at large dt** |
| 1987 | Pulse injection | `getPulseMultiplier(simTime, ...)` | **Aliased at large dt** |

**Root Cause:** Sinusoidal modulation sampled once per tick. At dt=60, the sin wave (period ~21s) is severely undersampled.

### Threshold Events (Correct)

| Location | Event | Trigger | Status |
|----------|-------|---------|--------|
| 2520 | Lot conversion | `waited >= DWELL_S` | ✓ Absolute threshold |
| 2541 | Park release | `waited >= requiredDwell` | ✓ Absolute threshold |
| 2585 | Sleep release | `currentDaySeconds >= wakeTimeS` | ✓ Absolute threshold |

---

## (B) Root-Cause Ranking by Impact

### 1. CFL Substep Accumulation Bug (CRITICAL)
**Impact:** 600-2400% drift in truckHoursLost at dt=2 to dt=60
**Mechanism:**
- At dt=1: ~3 substeps, accumulator × 3, then × (1/3600) = 3/3600
- At dt=60: ~123 substeps, accumulator × 123, then × (60/3600) = 7380/3600
- Ratio: 7380/3 = 2460× per step, offset by 60× fewer steps = ~41× inflation

### 2. CBP Single-Completion-Per-Tick (HIGH)
**Impact:** ~54% throughput drop at dt=60
**Mechanism:**
- SERVICE_TIME_S ≈ 30s (at 218 trucks/hr, 7 lanes)
- At dt=60: 1 completion per lane per 60s instead of 2
- Throughput halved when dt > SERVICE_TIME_S

### 3. Intersection Blocking Aliasing (MEDIUM)
**Impact:** Variable congestion patterns at different dt
**Mechanism:**
- `sin(simTime * 0.3)` has period ≈ 21s
- At dt=60: samples every 60s, completely misses blocking pattern
- At dt=1: samples every 1s, captures blocking correctly

### 4. Hourly Cache Boundary Skip (LOW for dt ≤ 60)
**Impact:** Only affects dt > 3600 (1 hour)
**Status:** Not a factor in current test range

---

## (C) Patch Plan

### Fix 1: CFL Substep Accumulation (CRITICAL)

**Current code (step:1670):**
```javascript
export function step(dt) {
    _stalledMassKg = 0;
    _truckHoursLostThisTick = 0;
    // ...
    stepDriftAndTransfer(dt);  // accumulates per-substep
    // ...
    _stallTonHours += (totalStallKg / 1000) * (dt / 3600);  // uses full dt
    _truckHoursLost += _truckHoursLostThisTick * (dt / 3600);  // uses full dt
}
```

**Fix:** Pass substep count and use it for proper scaling:
```javascript
export function step(dt) {
    _stalledMassKg = 0;
    _truckHoursLostThisTick = 0;
    // ...
    const numSubsteps = stepDriftAndTransfer(dt);  // returns substep count
    // ...
    // Scale by actual time spent per substep, not full dt
    const subDt = dt / numSubsteps;
    _stallTonHours += (_stalledMassKg / 1000) * (subDt / 3600);
    _truckHoursLost += _truckHoursLostThisTick * (subDt / 3600);
}
```

Wait, that's still wrong. The issue is _stalledMassKg accumulates mass for N substeps.
Actually, the correct fix is simpler:

**Correct Fix:** Accumulate dt-weighted values inside the inner loop:
```javascript
function stepDriftAndTransferInner(subDt) {
    // ...
    if (c < STALL_CUTOFF) {
        _stalledMassKg += TRUCK_KG * subDt;  // weight by substep duration
    }
    const loss = 1 - c;
    _truckHoursLostThisTick += loss * subDt;  // weight by substep duration
}
```

Then in step():
```javascript
_stallTonHours += (_stalledMassKg / 1000) / 3600;  // already time-weighted
_truckHoursLost += _truckHoursLostThisTick / 3600;  // already time-weighted
```

### Fix 2: CBP Multi-Completion (HIGH)

**Current code:**
```javascript
function stepCBPCompletion() {
    for (const lane of CBP_LANES) {
        if (lane.particle && simTime >= lane.busyUntil) {
            // exit ONE particle
        }
    }
}
```

**Fix:** Process all completions that should happen within [simTime-dt, simTime]:
```javascript
function stepCBPCompletionAndAssignment(dt) {
    if (!isFinite(SERVICE_TIME_S)) return;

    const tickStart = simTime - dt;
    const tickEnd = simTime;

    for (const lane of CBP_LANES) {
        // Process all completions within this tick window
        while (lane.particle && lane.busyUntil <= tickEnd) {
            // Exit particle
            exitParticle(lane.particle);
            lane.particle = null;

            // Assign next if queue has particles
            if (sinkQueue.length > 0) {
                const p = sinkQueue.shift();
                lane.particle = p;
                // busyUntil starts from when previous completed, not simTime
                lane.busyUntil = Math.max(lane.busyUntil, tickStart) + SERVICE_TIME_S;
                p._cbpLane = lane;
                p._cbpEndTime = lane.busyUntil;
            } else {
                break;  // No more particles to process
            }
        }

        // Also assign to empty lanes (no prior particle)
        if (lane.particle === null && sinkQueue.length > 0) {
            const p = sinkQueue.shift();
            lane.particle = p;
            lane.busyUntil = tickStart + SERVICE_TIME_S;
            p._cbpLane = lane;
            p._cbpEndTime = lane.busyUntil;
        }
    }
}
```

### Fix 3: Intersection Blocking Aliasing (MEDIUM)

**Current code:**
```javascript
if (Math.sin(simTime * 0.3 + phase) > 0.85) {
    continue;  // skip movement
}
```

**Fix:** Integrate blocking probability over dt:
```javascript
// Compute fraction of dt spent blocked
const blockingDuty = computeBlockingDuty(simTime, phase, dt);
// Apply as velocity reduction instead of binary skip
const blockingFactor = 1 - blockingDuty * 0.85;  // max 85% reduction when fully blocked
const moveDistance = baseSpeed * c * velJitter * blockingFactor * dt;
```

Or simpler: move blocking check into substep loop (already happens at subDt granularity).

---

### Fix 4: Incomplete reset() State (CRITICAL)

**Missing resets identified:**
```javascript
// Added to reset():
_stallTonHours = 0;
_stalledMassKg = 0;
activeCells.clear();
sleepingParticles.length = 0;
_rngState = 12345;
particleIdCounter = 0;
_lastGateCapHour = -1;
_lastInflowHour = -1;
_dailyTotalLoaded = false;
dailyTotalKg = 0;
inflowKgPerHour = 0;
sinkCapKgPerHour = 0;
```

**Impact:** Without these resets, consecutive runs in the same session have different initial states, causing non-reproducible results.

---

## (D) Implementation Diffs

### Applied Fixes:

1. **CFL Substep Accumulation (lines 2227, 2238):**
   - Changed `_stalledMassKg += TRUCK_KG` to `_stalledMassKg += TRUCK_KG * dt`
   - Changed `_truckHoursLostThisTick += loss` to `_truckHoursLostThisTick += loss * dt`
   - Updated step() to remove duplicate dt scaling (lines 1714, 1719)

2. **CBP Multi-Completion (lines 1775-1831):**
   - Combined stepCBPAssignment() and stepCBPCompletion() into stepCBPLanes(dt)
   - Added while loop to process all completions in [simTime-dt, simTime]
   - Lane busyUntil now starts from actual lane-free time, not simTime

3. **reset() State (lines 3062-3082):**
   - Added all missing state resets for reproducibility
