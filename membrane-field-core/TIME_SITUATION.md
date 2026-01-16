# Time Situation - FIXED

## What Was Wrong

There were **two movement systems** fighting:

1. `getFieldVelocityAt()` returning **0 velocity** (dead code)
2. A **discrete hop integrator** doing 8 cell teleports per frame = 21,000 m/s

## The Fix (Applied)

**Deleted** the discrete hop integrator. **Fixed** continuous velocity integration.

### Particle Mass Invariant (1:1)

- One particle = `TRUCK_KG` kilograms (9,000 kg default).
- Particle count = total field mass / `TRUCK_KG`.
- No caps, clamps, merging, or sampling. If performance is an issue, manually raise `TRUCK_KG`.

### `getFieldVelocityAt()` now returns calibrated visual speed (per sim second):

```javascript
const TARGET_VISUAL_SPEED_MS = 150;  // meters per sim second
const congestionFactor = roadCongestionFactor(idx);
const speedMS = TARGET_VISUAL_SPEED_MS * congestionFactor;
return { vx: dirX * speedMS, vy: dirY * speedMS };
```

### `update()` now uses continuous integration (sim time):

```javascript
const velocity = getFieldVelocityAt(idx, pClass);
const dtSim = simDtSeconds;  // already scaled by time preset
p.x += velocity.vx * dtSim;
p.y += velocity.vy * dtSim;
```

### Resolution Control (Manual Only)

- `TRUCK_KG` is the sole resolution knob. Raising it reduces particle count.
- No auto-scaling, caps, or sampling. Performance mitigation is manual.

## New Timing

- **Visual speed**: 150 m/s (uncongested)
- **Corridor traversal**: ~80km / 150 m/s = ~533 seconds = **~9 minutes real time**
- **Per sim day**: 75 real seconds = one day still holds
- **Congestion**: slows particles via `roadCongestionFactor(idx)`

## Tuning

If 150 m/s is too fast or slow, change `TARGET_VISUAL_SPEED_MS` in `getFieldVelocityAt()` (line 613).

| Target Speed | Corridor Time | Notes |
|-------------|---------------|-------|
| 100 m/s | ~13 min | Slower, more dramatic |
| 150 m/s | ~9 min | Current setting |
| 200 m/s | ~7 min | Faster |
| 666 m/s | ~2 min | Old code speed |

## Summary

- 75-second day: **unchanged**
- Simulation duration: **1 week** (lot releases can take up to 72 hours)
- Total video time: **525 seconds** (~8.75 minutes for full week)
- Particle visual speed: **now 150 m/s** (was 21,000 m/s broken / 666 m/s old)
- Movement system: **pure continuous** (no hop teleportation)

---

## Week Simulation (NEW)

Extended from 1 day to **1 week** because lot releases can take up to 72 hours.

| Constant | Value | Notes |
|----------|-------|-------|
| `SIM_DAYS` | 7 | Number of days |
| `DAY_VIDEO_SECONDS` | 75s | Per-day video duration |
| `TOTAL_VIDEO_SECONDS` | 525s | Full week (~8.75 min) |
| `SIM_SECONDS_TOTAL` | 604,800 | 1 week in sim seconds |
| `SIM_TIME_SCALE` | 1,152 | Same compression ratio |

Hourly inflow profiles wrap via `hour % 24` so they repeat each day.

---

## Injection Timing (Hourly Profiles)

**Good news: Hourly profiles ARE already respected.**

The bundle contains CIEN's hourly inflow data:

```json
"hourly_kg": {
  "0": 447907,   // Night: low (~125 kg/s)
  "7": 2239535,  // Morning peak (~622 kg/s)
  "14": 2239535, // Afternoon peak
  "23": 447907   // Night: low
}
```

The overlay loads this per hour:

```javascript
loadHourlyInflow(hour);  // Called when sim hour changes
const kgPerS = totalKg / 3600;
stampInjectionSources(kgPerS);
```

### Why It Might Look Like a Burst

At 1152x time compression:
- 1 sim hour = 3.125 real seconds
- Full 24-hour cycle = 75 real seconds

With slower particles (150 m/s), you see particles **accumulate faster than they exit** during peak hours. That's correct - it shows congestion building.

### Visual Pacing Options

If particles seem too dense:

1. **Increase speed**: raise `TARGET_VISUAL_SPEED_MS` (line 613)
2. **Larger quanta**: increase `PARTICLE_MASS_KG` (line 391) so each dot = more mass
3. **Start at night**: begin sim at hour 0 instead of peak hour

---

## Time Controls (Console API)

Available via `window.reynosaFieldDebug`:

```javascript
reynosaFieldDebug.pauseSim()      // Freeze physics + FIFO timers
reynosaFieldDebug.resumeSim()     // Resume simulation
reynosaFieldDebug.togglePause()   // Toggle pause state, returns new state

reynosaFieldDebug.setSimSpeed('normal')        // 1x (default)
reynosaFieldDebug.setSimSpeed('fast')          // 2x
reynosaFieldDebug.setSimSpeed('day_per_minute') // 1 sim day = 1 real minute
reynosaFieldDebug.setSimSpeed('week_per_minute') // 1 sim week = 1 real minute
reynosaFieldDebug.setSimSpeed(0.5)             // Custom multiplier

reynosaFieldDebug.getSimStatus()  // Returns current state
// { paused, speedMultiplier, simTimeSeconds, day, hour, queuedTrucks, avgDwellHours, oldestTruckHours }
```

### What Pause Freezes

- Physics (field advection, particle movement)
- FIFO timers (lot service budgets)
- Sim clock progression

**Render keeps going** (camera, UI still responsive)
