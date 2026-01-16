# Scenario Narrative Spec

## Governing Principle

> **If you feel the urge to explain, the structure is doing too little work.**

The job is not to guide interpretation. The job is to **remove every path except the correct one**.

---

## Design Rules

### 1. Make causality visible, not verbal

Cause and effect must occur **in the same frame**, not separated by narration.

Each scenario beat:
1. Label appears (intervention named)
2. Visual change (intervention visible on screen)
3. Clock montage (time passes)
4. Metrics appear (outcome)

No words between intervention and outcome. That's physics. Humans understand physics.

### 2. One variable per beat

Cognitive overload triggers the explanation urge.

**Bad**: New scenario + new map + new colors + new metrics + new labels
**Good**: Scenario label changes. Everything else identical. Then metrics change.

This teaches counterfactual reasoning without naming it:
> "Nothing else moved. Only this."

### 3. Identical structure across scenarios

The Twinspan insight must be **structurally unavoidable**, not stated.

- Same metric layout
- Same number formatting
- Same line order
- Same position on screen

Then Twinspan shows lanes doubled but top number barely moved. The brain does the work:
> "Wait… why didn't it change?"

If you explain it, you rob them of the comprehension moment.

### 4. Headers as instruments, not narration

Text = measurement labels, not sentences.

**Never**: "This shows that…", "As we can see…", "This implies…"
**Always**: "Capacidad CBP", "Pérdida del sistema", "Δ vs baseline"

These are axes, not claims. Lab bench, not lecturer.

### 5. Silence after metrics

Understanding requires time without input.

After metrics appear:
- No animation
- No new text
- No camera movement
- 2–3 seconds stillness

If something needs explanation, you didn't give the brain time to resolve it.

### 6. Comparison table = synthesis

The final table is the only place synthesis happens. Not verbally. Structurally.

Four rows. Same metrics. Same formatting. The explanation is:
> "These numbers coexist."

The viewer infers priority, causality, and solution.

---

## Scenario Arc

```
BASELINE → TWINSPAN → INTERSERRANA → INOVUS+TWINSPAN+INTERSERRANA
```

| # | Scenario | Intervention | Expected Δ |
|---|----------|--------------|------------|
| 1 | Baseline | — | — |
| 2 | Twinspan | Capacidad CBP ×2 | ~0% |
| 3 | Interserrana | Demanda +25% | +15% to +20% |
| 4 | InovusTwinspanInterserrana | Lotes + CBP ×2 + Demanda | −30% to −40% |

The structure does the arguing:
- Twinspan: lanes doubled, loss unchanged → bridge isn't the constraint
- Interserrana: demand up, loss up → system will degrade without intervention
- Inovus combo: even with more demand AND more lanes, INOVUS makes it work

---

## Pre-baked Metrics

### Source of Truth

Numbers are loaded directly from a validated tracker run. No manual transcription.

**Canonical file location:**
```
engine/data/scenario_metrics.json
```

This file must be copied from a tracker run output. The loader will refuse to start if the file is missing or malformed.

### Generating the Metrics

```bash
cd tracker
node runComparison.js Baseline Twinspan Interserrana InovusTwinspanInterserrana
```

Output: `tracker/results/comparison_Baseline_Twinspan_Interserrana_InovusTwinspanInterserrana_7d.json`

### Installing the Metrics

Copy and rename to canonical location:
```bash
cp tracker/results/comparison_Baseline_Twinspan_Interserrana_InovusTwinspanInterserrana_7d.json \
   engine/data/scenario_metrics.json
```

The director will load this file at runtime:
```javascript
// engine/director.js
import SCENARIO_METRICS from './data/scenario_metrics.json' assert { type: 'json' };
```

### Expected Structure

The JSON contains:
```javascript
{
  "meta": {
    "timestamp": "2025-01-XX",
    "scenarioNames": ["Baseline", "Twinspan", "Interserrana", "InovusTwinspanInterserrana"],
    "runOpts": { "days": 7, "warmup": 24, "dt": 10, "sampleInterval": 300 }
  },
  "scenarios": [
    {
      "scenarioName": "Baseline",
      "summary": {
        "truckHoursLost_final": 847.2,
        "truckHoursLostCongestion_final": 612.1,
        "truckHoursLostLotWait_final": 235.1,
        "sinkQueueCount_mean": 23.4,
        "cbpLanesInUse_mean": 5.2,
        "throughputKgPerHour": 127000
      }
    },
    // ... other scenarios
  ],
  "deltas": [
    // ... vs baseline comparisons
  ]
}
```

### Why This Matters

- **No fabrication**: Numbers come from actual simulation runs
- **Traceable**: File includes timestamp and run config
- **Single source**: One file, one location, no ambiguity
- **Auditable**: Compare file timestamp to bundle version

---

## Beat Structure (per scenario)

### Frame 1: Intervention

```
┌─────────────────────────────────────────┐
│  TWINSPAN                               │
│  Capacidad CBP ×2                       │
│                                         │
│         [visual: lanes light up]        │
│                                         │
└─────────────────────────────────────────┘
```

- Scenario name: large, top-left
- Intervention label: smaller, below name
- Visual change on screen (lanes appear, route highlights, lots activate)
- Duration: 2s

### Frame 2: Time Passing

```
┌─────────────────────────────────────────┐
│  TWINSPAN                   DÍA 4 / 7   │
│  Capacidad CBP ×2               11:47   │
│                                         │
│         [particles flowing]             │
│                                         │
└─────────────────────────────────────────┘
```

- Clock spins through 24h cycles
- Day counter increments
- Particles continue (system is live)
- Duration: 8-10s wall time

### Frame 3: Outcome

```
┌─────────────────────────────────────────┐
│  TWINSPAN                               │
│  Capacidad CBP ×2                       │
│                                         │
│  Pérdida total         831 camión-h/día │
│  ├ Congestión vial     598              │
│  └ Espera en lotes     233              │
│                                         │
│  Carriles CBP activos  9.8 / 14         │
│  Cola CBP promedio     12 camiones      │
│                                         │
│  Δ vs baseline         −1.9%            │
│                                         │
└─────────────────────────────────────────┘
```

- Metrics appear line by line (1s each)
- **Identical layout across all scenarios**
- **Identical line order across all scenarios**
- **Identical formatting across all scenarios**
- Then: 3s silence. No movement. Let it resolve.

### The Identical Structure Requirement

This is non-negotiable. Every scenario shows:

```
Pérdida total         XXX camión-h/día
├ Congestión vial     XXX
└ Espera en lotes     XXX

Carriles CBP activos  X.X / 14
Cola CBP promedio     XX camiones

Δ vs baseline         ±XX.X%
```

Same labels. Same positions. Same units. Only numbers change.

The viewer's eye learns the layout on Baseline. On Twinspan, the eye goes straight to "Pérdida total" and sees it barely moved despite "Capacidad CBP ×2" at the top. No explanation needed. The juxtaposition is the argument.

### Typography

- Scenario name: 700, 24px
- Intervention: 400, 16px
- Metric labels: 400, 14px, left-aligned
- Metric values: 700, 14px, right-aligned
- Delta: 700, 18px
- All: IBM Plex Mono, white on dark

### Color

No semantic colors. No green=good, red=bad.

- All text: #ddd (light gray)
- Delta: #0ff (cyan) — magnitude indicator, not judgment
- Scenario name: #fa0 (gold) — active label only

---

## Director Script Structure

```javascript
alienObserverWithScenarios() {
  return [
    // ... existing phases 0-4 ...

    // ═══════════════════════════════════════════════════════════
    // PHASE 5: SCENARIO COMPARISON
    // ═══════════════════════════════════════════════════════════

    // BASELINE
    { type: 'scenarioIntervention', name: 'BASELINE', intervention: null },
    { type: 'clockMontage', days: 7, wallSeconds: 10 },
    { type: 'showMetrics', scenario: 'Baseline' },
    { type: 'wait', duration: 5000 },  // silence
    { type: 'clearMetrics' },

    // TWINSPAN
    { type: 'scenarioIntervention', name: 'TWINSPAN', intervention: 'Capacidad CBP ×2' },
    { type: 'visualChange', effect: 'cbpLanesDouble' },
    { type: 'clockMontage', days: 7, wallSeconds: 10 },
    { type: 'showMetrics', scenario: 'Twinspan' },
    { type: 'wait', duration: 5000 },  // silence
    { type: 'clearMetrics' },

    // INTERSERRANA
    { type: 'scenarioIntervention', name: 'INTERSERRANA', intervention: 'Demanda +25%' },
    { type: 'visualChange', effect: 'interserranaRoute' },
    { type: 'clockMontage', days: 7, wallSeconds: 10 },
    { type: 'showMetrics', scenario: 'Interserrana' },
    { type: 'wait', duration: 5000 },  // silence
    { type: 'clearMetrics' },

    // INOVUS + TWINSPAN + INTERSERRANA (the full solution)
    { type: 'scenarioIntervention', name: 'INOVUS', intervention: 'Lotes + CBP ×2 + Demanda' },
    { type: 'visualChange', effect: 'inovusFull' },
    { type: 'clockMontage', days: 7, wallSeconds: 10 },
    { type: 'showMetrics', scenario: 'InovusTwinspanInterserrana' },
    { type: 'wait', duration: 5000 },  // silence
    { type: 'clearMetrics' },

    // SYNTHESIS
    { type: 'showComparisonTable' },
    { type: 'wait', duration: 10000 },  // let it resolve

    { type: 'startLocalSimIntro' },
  ];
}
```

Total runtime: ~100 seconds for comparison sequence

---

## New Director Instructions

### `scenarioIntervention`
Shows scenario name + intervention label. Stays visible through montage and metrics.
```javascript
{ type: 'scenarioIntervention', name: 'TWINSPAN', intervention: 'Capacidad CBP ×2' }
```
- `name`: Large, gold (#fa0), top-left
- `intervention`: Smaller, gray, below name (null for Baseline)

### `visualChange`
Triggers visible intervention on screen before time passes.
```javascript
{ type: 'visualChange', effect: 'cbpLanesDouble' }
```
Effects:
- `cbpLanesDouble`: CBP lanes visually expand / light up
- `interserranaRoute`: Highway route highlights
- `inovusLots`: Lot polygons activate / pulse

Duration: 2s. The intervention must be **seen**, not just labeled.

### `clockMontage`
Time compression. Clock spins, days increment, particles flow.
```javascript
{ type: 'clockMontage', days: 7, wallSeconds: 10 }
```
- Day counter: "DÍA X / 7" top-right
- Clock: HH:MM accelerates through cycles
- Particles continue at normal render rate
- Physics: Option A (fake) or B (compressed) — see Implementation section

### `showMetrics`
Displays pre-baked metrics. Identical structure every time.
```javascript
{ type: 'showMetrics', scenario: 'Twinspan' }
```
- Reads from `SCENARIO_METRICS` constant
- Lines appear sequentially (1s each)
- Layout/order/formatting identical across scenarios
- Delta calculated automatically vs Baseline

### `clearMetrics`
Removes metric overlay. Scenario label stays.
```javascript
{ type: 'clearMetrics' }
```

### `showComparisonTable`
Final synthesis. Four rows, same metrics.
```javascript
{ type: 'showComparisonTable' }
```
```
                      Pérdida total    Δ
─────────────────────────────────────────
Baseline                   XXX         —
Twinspan                   XXX      ~0%
Interserrana               XXX     +XX%
INOVUS                     XXX     −XX%
```

Numbers pulled from `scenario_metrics.json`. No annotations. No arrows. The numbers coexist.

---

## Clock Montage Implementation

The montage represents time, not computes it. Metrics are pre-baked from validated tracker runs.

### Option A: Visual only (recommended for MVP)

- Clock spins, days increment
- Particles flow at normal render rate
- No physics acceleration
- Metrics 100% pre-baked

The honesty comes from:
1. Validated run metadata displayed: "7 días, dt=10s"
2. Particles visibly moving (system is live)
3. Numbers from actual tracker runs

### Option B: Compressed physics

- Run dt=30-60s during montage
- Accept numerical drift
- Metrics still pre-baked

Only if Option A feels too disconnected.

---

## Timing

```
Per scenario:
  0s   intervention label
  2s   visual change
  4s   montage begins
 14s   montage ends
 15s   metric line 1
 16s   metric line 2
 17s   metric line 3
 18s   metric line 4
 19s   metric line 5
 20s   delta line
 25s   silence ends, clear
─────────────────────────
 25s   total per scenario
```

Four scenarios × 25s = 100s
Comparison table: 10s
**Total: ~2 minutes**

---

## Open Questions

1. **After comparison**: Snap to local sim? Or end at table?
2. **Particle continuity**: Reset between scenarios? Or continuous flow?
3. **Precision**: "847" vs "~850" — integers feel more measured
4. **Visual changes**: What exactly lights up for each intervention?

---

## Implementation Checklist

### Phase 1: Generate Metrics
1. [ ] Run tracker:
   ```bash
   cd tracker
   node runComparison.js Baseline Twinspan Interserrana InovusTwinspanInterserrana
   ```
2. [ ] Verify output in `tracker/results/`
3. [ ] Copy to canonical location:
   ```bash
   cp tracker/results/comparison_*.json engine/data/scenario_metrics.json
   ```

### Phase 2: Implement Director Instructions
4. [ ] Create `engine/data/` directory
5. [ ] Implement `scenarioIntervention` instruction
6. [ ] Implement `visualChange` effects
7. [ ] Implement `clockMontage` instruction
8. [ ] Implement `showMetrics` (loads from `scenario_metrics.json`)
9. [ ] Implement `showComparisonTable`

### Phase 3: Wire and Test
10. [ ] Add `alienObserverWithScenarios()` to Scripts
11. [ ] Test full sequence
12. [ ] Adjust timing based on viewing
