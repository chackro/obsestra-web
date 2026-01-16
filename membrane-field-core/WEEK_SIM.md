# Week Simulation - Operational Truth Engine

## 1. What "A Week" Means

```
Sim horizon:     7 days = 604,800 sim seconds
Physics substep: unchanged (8 per frame)
Render rate:     unchanged (60fps)
Time scale:      1,152 sim-seconds per real-second
Video duration:  525 real seconds (~8.75 min for full week)
```

You are not "slowing visuals." You are allowing state to mature.

---

## 2. Audit: Nothing Assumes 24h Convergence

### Checked patterns:
- `_simTimeSeconds > ...` — **none found**
- warmup/cooldown logic — **none found**
- rolling averages — **none found**
- debug counters — **all use modulo throttling, don't reset daily**

### Time constants (all week-safe):
| Constant | Value | Notes |
|----------|-------|-------|
| `MIN_CLEAR_WAIT_S` | 36 hours | Minimum lot dwell |
| `TARGET_DWELL_S` | 54 hours | Midpoint for service rate |
| `SIM_SECONDS_TOTAL` | 604,800 | Full week |

Hourly inflow wraps via `hour % 24` — same profile repeats each day.

---

## 3. Invariants (Must Remain True)

### Mass Conservation
```
total_restricted_mass = injected − cleared − sunk
```

### Particle-Field Alignment
```
particles = ⌊field_mass / 9000kg⌋ ± quantization
```

### Congestion Clearance (only via)
- Lot admission
- FIFO service
- Sink exit

**If congestion "evaporates" overnight → BUG.**

---

## 4. Time Controls (TODO)

### Speed Presets
```javascript
const TIME_PRESETS = {
    realtime: 1,           // 1:1 (for demos)
    day_per_minute: 1440,  // 1 day = 1 minute
    week_per_minute: 10080 // 1 week = 1 minute
};
```

### Pause/Resume Must Freeze
- Physics
- FIFO timers (`_globalServiceBudgetKg`)
- Service budgets
- (Render can keep going)

### Sim Clock HUD (Validation)
```
Day 3 / Hour 14
Avg dwell: 47.2h
Oldest truck: 62.1h
Queue depth: 847 trucks
```

This is not UI fluff — it's validation.

---

## 5. Expected Behavior After 3-5 Sim Days

If the model is correct:
- Lots stop oscillating
- Certain corridors never fully clear
- Pressure becomes structural, not spiky
- Weekday/weekend effects visible (if sources vary)
- Small capacity deltas compound into visible backlog cliffs

**If everything "smooths out nicely" → you over-damped something.**

---

## 6. Warning

**DO NOT INCREASE** just because a week "feels slow":
- `FLOW_FRAC`
- service rate
- congestion softness

A week-long sim is supposed to feel heavy.
That's the point.

---

## Bottom Line

Extending to a week is the moment this stops being a toy and becomes an operational truth engine.

You didn't just fix particles.
You earned the right to let time exist.
