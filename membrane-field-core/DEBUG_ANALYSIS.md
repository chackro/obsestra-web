# Debug Analysis: Mass Not Flowing Through Roads

## Problem Summary

Mass spawns at entry cells, accumulates to 56+ megatons, but doesn't drain at PHARR sink.

---

## Root Cause: Conversion Rate = 0

```
[LOTS] in_lots: 289.6t restricted (4% of total), 0.0t cleared | conversion: 0.0t/hr
```

### The Flow (What Should Happen)

1. Mass injects as **65% restricted, 35% cleared**
2. Restricted mass routes to lots via `nextHop_lots` (WORKING)
3. Restricted CONVERTS to cleared in lots (BROKEN - 0.0t/hr)
4. Cleared mass routes to PHARR via `nextHop_pharr`
5. Only cleared mass drains at sink (`drainRestricted=false`)

### What's Actually Happening

- Restricted mass reaches lots: `restricted->lots: 1003636.6t moved`
- But conversion = 0: `conversion: 0.0t/hr`
- So restricted just accumulates
- Sink only sees ~4kg of cleared mass
- Total mass grows: 2kt → 10Mt → 35Mt → 56Mt+

---

## Evidence from debug.log

| Time | Injected | At Sink (cleared) | Drained | Total Mass |
|------|----------|-------------------|---------|------------|
| 14:38:09 | 2,379 kg | 0 | 0 | 2,379 |
| 14:38:27 | 20,878 kg | 11,924 | 31,449 | 10,046,849 |
| 14:40:46 | 28,551 kg | 4 | 192 | 35,352,855 |
| 14:41:23 | 17,916 kg | 4 | 202 | 56,185,860 |

---

## Conversion Logic Location

In `reynosaOverlay.js`:

### Line 4114: `convertTruckFromLot(lotIdx)`
```javascript
function convertTruckFromLot(lotIdx) {
    // Converts restricted mass in lot cells to cleared
    // Called by FIFO queue when particle token is eligible
}
```

### Line 4142: FIFO trigger
```javascript
const convertedKg = convertTruckFromLot(lotIdx);
if (convertedKg < TRUCK_KG * 0.9) {
    console.warn(`[FIFO] Particle token eligible but field lot mass had only ${...}t`);
}
```

### Line 3949: Metric computation
```javascript
const conversionRate = metrics.conversion_kg_per_hr || 0;
```

---

## Likely Causes

### 1. `_yardEnabled` is false
Conversion may be gated by this flag.

### 2. FIFO Queue Not Processing
The clearing queue that triggers `convertTruckFromLot` may be empty.

### 3. No Particles with Proper Dwell State
Particles need to enter lots and dwell before becoming eligible for conversion.

### 4. Particle vs Field Mismatch
- MacroParticles (segment-based): 3000+ spawning on highway segments
- Field particles (cell-based): `alive=0` initially
- The two systems may not be connected

---

## Next: Search for _yardEnabled and FIFO logic

Looking for:
1. Where `_yardEnabled` is set
2. What populates the FIFO clearing queue
3. How particles trigger conversion

---

## UPDATE: Root Cause Found

### The FIFO Queue is Empty

```
[GLOBAL-CLEAR] q=0 trucks rate=0.00kg/sim-s budget=0kg clearedTrucks=0
```

The conversion queue has **0 trucks**. No particles are entering the FIFO queue.

### Why Queue is Empty

Particles enter the queue at `reynosaOverlay.js:697` when:
1. Particle is `restricted` class
2. Particle is in a lot cell (`regionMap[idx] === REGION_LOT`)
3. Particle hasn't already been added (`!p.waitingInLot`)

**But particles never reach lot cells!**

```
[FORENSIC] Sampled 500 road cells: 215 reach lots, 0 dead-ends, 16 loops
[FORENSIC] Distinct lots reachable: 25 [55,45,46,57,80,56,77,84,70,31...]
```

Only 25 out of 85 lots are reachable. And only 43% of road cells reach any lot.

### Entry Point Routing

```
[FORENSIC] Source[0] idx=1010584 (784,561):
[FORENSIC]   nextHop_lots=1014183
[FORENSIC]   phi_lots=21727
```

The entry has valid `nextHop_lots`, but where does the path actually go?
The `phi_lots=21727` keeps changing (21727 -> 22925 -> 23322 -> ...) but particles don't reach lots.

### Hypothesis

The `nextHop_lots` routing from entry points leads to:
1. Dead-ends (cells where `nextHop_lots = -1`)
2. Loops (cells that route back to themselves)
3. Or paths that never actually reach lot cells

This would explain why:
- Mass accumulates at entry (restricted can't leave)
- FIFO queue stays empty (no particles reach lots)
- Conversion = 0 (nothing to convert)

---

## Next: Trace nextHop_lots Path

Need to check where `nextHop_lots[1014183]` leads from entry cell 1010584.

Checking `phi_lots` gradient: particles should flow toward lower phi (toward lots as sinks).
- Entry phi_lots = 21727
- Lot cells should have phi_lots = 0 (sinks)

---

## FIX APPLIED: Render Mode (2025-12-19)

### Problem: Particles Not Rendering

The issue was `localScenario.renderMode` defaulting to `'heatmap'`:

```javascript
// Before (line 1591)
renderMode: RENDER_MODE.HEATMAP,  // Particles never draw!
```

The draw logic at line 2042 requires mode to be `'particles'` or `'both'`:

```javascript
const drawParticles = (mode === RENDER_MODE.PARTICLES || mode === RENDER_MODE.BOTH)
    && (state === OverlayState.ON || state === OverlayState.WARM);
```

### Fix Applied

Changed default `renderMode` to `BOTH`:

```javascript
// After
renderMode: RENDER_MODE.BOTH,  // Was HEATMAP - particles need to render
```

### Additional Checks

If particles still don't appear, verify:

1. **Zoom level**: Camera must be `>= 0.003 px/m` (Z_WARM threshold) for state != OFF
2. **Camera position**: Must be within 50km of Reynosa center
3. **Phi rebuild**: Check `_phiRebuildInProgress` - if stuck, frames skip physics
4. **Source cells**: Check `sourceCellIndices` has entries (injection points exist)

Console logs to watch:
- `[ReynosaOverlay.draw] state:` - should be `ON` or `WARM`, not `OFF`
- `[ACCUM] sourceIdx=...` - shows particle emission attempts
- `[PARTICLE EMIT] simDt=...` - shows mass being emitted
- `[PARTICLE] alive=...` - shows particle count and death stats

### Toggle Debug Colors

Press **M** key to toggle particle debug colors:
- Green: Cleared (routing to PHARR)
- Blue: Restricted (moving normally)
- Yellow: Pre-lot holding stall
- Orange: Waiting in lot FIFO
- Red: Stuck

---

## Remaining Issues (Once Particles Visible)

### 1. Conversion Still 0.0t/hr

Even with particles visible, the conversion logic requires:

1. `_yardEnabled = true` (set when lots load successfully at line 2452)
2. Particles entering lot cells (regionMap[idx] === REGION_LOT)
3. FIFO queue processing (`_waitingParticleQueue` populated)

### 2. Only 25/85 Lots Reachable

The forensics showed only 43% of road cells reach lots. This is a routing issue in `nextHop_lots`.

### 3. Mass Accumulation

With restricted mass not converting, the 65% restricted fraction keeps accumulating indefinitely.

---

## UPDATE 2: Particles Rendering But Stalling (2025-12-19 14:59)

### Render Fix Confirmed Working

```
[ReynosaOverlay.draw] state: ON mode: particles particleLayer: true
[PARTICLES] 1095 restricted (66%), 0 in lots (0%), 566 cleared | total=1661
```

**1661 particles exist and are rendering!**

### New Issue: Dead-End Stalls

```
[PARTICLE] alive=1662 deaths(sink=0 oob=0) stalls(deadEnd=1627 preLot=0)
```

**1627 out of 1662 particles (98%) are stalling at dead-ends!**

Particles are being emitted, but almost all immediately hit dead-ends in the `nextHop_lots` routing table.

### Root Cause: Routing Collapse

```
[LOTS-COMPETE] phi_lots entry winners (47/50 reached lots, 8 distinct):
  lot 58 -> 19 hits
  lot 78 -> 12 hits
  lot 11 -> 7 hits
  lot 24 -> 4 hits
  ...
[LOTS-COMPETE] Road access: 85/85 lots reachable from road network
[LOTS-COMPETE] BYPASSED: 77 lots have road access but got 0 routing hits
```

- All 85 lots are reachable from roads
- But `phi_lots` gradient only routes to 8 lots
- Those 8 lots fill up (23/85 at 90% capacity)
- No fallback routing to other lots
- Particles hit dead-end in `nextHop_lots` and stall

### Evidence Chain

1. Particles emitted: `emitted=1699`
2. Near entry, particles moving: `move(moving=47 stalled=0)`
3. But globally: `stalls(deadEnd=1627)`
4. 0 particles reach lots: `0 in lots (0%)`
5. FIFO empty: `q=0 trucks`
6. No conversion: `conversion: 0.0t/hr`

### Likely Fix

The Dijkstra for `phi_lots` needs to:
1. Use ALL available lot cells as sinks (currently using 473/672)
2. But routing concentrates on 8 lots only
3. Need load-balancing or multi-destination routing

---

## FIX 2: Remove Unused realDt Argument (2025-12-19)

Changed at line 2006:
```javascript
// Before
particleLayer.update(simDeltaSeconds, camera, realDeltaSeconds);

// After
particleLayer.update(simDeltaSeconds, camera);
```

Note: `realDt` was declared but never used in the update function - integration uses `dt` (simDeltaSeconds).

### Potential Remaining Issue: Velocity Scale

With `TARGET_VISUAL_SPEED_MS = 150` m/s and `simDt = 57.6s` per frame:
- Particles move 150 * 57.6 = **8640 meters per frame**
- That's ~195 cells (at 44m/cell)
- Particles teleport across field, hit dead-ends instantly, freeze

The velocity might need to be scaled down significantly for visual smoothness.

---

## FIX 3: Velocity Scale (2025-12-19)

### Problem: Particles Teleporting ("appear and poof gone")

User reported: "particles appear for a sec then disappear at industrial parks, nothing coming in from the two injection points"

Root cause analysis:
- `TARGET_VISUAL_SPEED_MS = 150` m/s (velocity in SIM seconds)
- Typical frame dt = 134s SIM time (at 1x speed)
- Per-frame movement: 150 * 134 = **20,100 meters** (~25% of 80km field)
- Particles teleported across entire corridor in 4-5 frames, appeared to vanish instantly

### Fix Applied

Changed at line 636:
```javascript
// Before
const TARGET_VISUAL_SPEED_MS = 150;  // meters per SIM second

// After
const TARGET_VISUAL_SPEED_MS = 0.13;  // meters per SIM second (was 150 - way too fast)
```

### Calibration Math

For 80km corridor traversal in ~9 minutes real time at 1x speed:
- 9 minutes = 540 seconds real
- SIM_TIME_SCALE = 1152
- SIM time = 540 * 1152 = 622,080 sim-seconds
- Velocity = 80,000m / 622,080s = **0.13 m/s (SIM)**

Per-frame movement at dt=134s:
- 0.13 * 134 = **17 meters per frame** (~0.4 cells)
- Much smoother visual flow

---

## Summary of All Fixes Applied

| Fix | Line | Problem | Solution |
|-----|------|---------|----------|
| 1 | 1591 | renderMode = HEATMAP | Changed to RENDER_MODE.BOTH |
| 2 | 2006 | realDt passed to update() | Removed third argument |
| 2b | 652 | realDt in function signature | Removed from signature |
| 3 | 636 | Velocity = 150 m/s | Reduced to 0.13 m/s |
| 4 | 414 | lifeSeconds = 700 | Increased to 700000 |
| 5 | 808-851 | Continuous integration overshoots | Clamped cell-step integration |

---

## FIX 4: Particle Lifespan (2025-12-19)

### Problem: Particles Fading Instantly

The draw function uses alpha based on particle age:
```javascript
const alpha = Math.max(0, 1 - p.age / p.life);  // line 925, 977
if (alpha <= 0.01) continue;  // Skip nearly invisible particles
```

With `lifeSeconds = 700` and `dt = 134` sim-seconds per frame:
- After 5 frames: `alpha = 1 - 670/700 = 0.04` → invisible
- **5 frames = 0.08 real seconds** → particles faded before user could see them

### Fix Applied

Changed at line 414:
```javascript
// Before
lifeSeconds: 700,

// After
lifeSeconds: 700000,  // ~615k sim-s to cross 80km at 0.13 m/s
```

Now particles stay visible for ~87 real seconds (5224 frames), plenty of time to cross the corridor.

---

## FIX 5: Clamped Cell-Step Integration (2025-12-19)

### Problem: Particles Going Off-Road at Turns

With continuous integration (`p.x += velocity.vx * dt`), particles moving toward a cell would sometimes overshoot past it and land in an off-road cell (K=0) with no valid nextHop. This happened at road turns where the nextHop direction changed sharply.

### Fix Applied

Changed at lines 808-851 to use clamped cell-stepping:
```javascript
// Compute distance to target cell center
const distToTarget = Math.sqrt(dx*dx + dy*dy);
const moveDistance = speed * dt;

if (moveDistance >= distToTarget) {
    // Would overshoot: snap to target cell center
    p.x = targetX;
    p.y = targetY;
} else {
    // Normal integration
    p.x += velocity.vx * dt;
    p.y += velocity.vy * dt;
}
```

Now particles snap to the nextHop cell center when they would overshoot, then resample velocity from that cell on the next frame. This keeps them on the road graph.

---

## Next Steps After Fixes

1. **Verify visual flow**: Refresh browser, particles should now flow visibly along roads
2. **Check conversion**: Watch for FIFO queue population and conversion > 0
3. **Industrial park routing**: Some sources may still have unreachable phi - check console for `[RELOCATE]` warnings
