# Modularization Roadmap: reynosaOverlay_v2.js

**Current:** 10,355 lines | **Target:** ~2,800 lines in main orchestrator

## Already Extracted

| Module | Lines | Purpose |
|--------|-------|---------|
| `state.js` | 187 | Centralized simulation state |
| `physics/drift.js` | 634 | Particle movement (stepDrift) |
| `physics/transfer.js` | 282 | Cell transitions (applyTransfer) |
| `routing/potential.js` | 168 | Dijkstra routing (computePotential, buildNextHop) |
| `lots/admission.js` | 78 | Dwell time sampling |
| `friction/commuter.js` | 124 | Commuter friction curves |

---

## Phase 1: Low-Risk Extractions (~5,300 lines)

Pure functions or isolated rendering. No physics impact.

### 1.1 Visualization Helpers

| Module | Lines | Functions | Notes |
|--------|-------|-----------|-------|
| `viz/particle-colors.js` | 900 | `getParticleClassColorRGB`, `getParticleSourceColorRGB`, etc. | Data-driven refactor possible |
| `viz/heatmap.js` | 400 | `drawCongestionHeatmap`, `drawFlowHeatmap` | Canvas rendering |
| `viz/panels.js` | 400 | `drawMetricsPanel`, `drawStallModeLegend` | UI overlays |
| `viz/speed-limits.js` | 841 | `drawSpeedLimitPolylines` | Split into 3 sub-functions |
| `viz/lots.js` | 170 | `drawLots`, `buildLotPaths` | Path caching |
| `viz/roads.js` | 200 | `buildRoadPath`, `drawRoads` | Path caching |

### 1.2 Utilities

| Module | Lines | Functions | Notes |
|--------|-------|-----------|-------|
| `lib/geometry-queries.js` | 420 | `isInBridgeApproach`, `isInQueueZone`, `getTwinSpanXAtY` | Pure geometry |
| `lib/particle-trails.js` | 95 | `updateParticleTrails`, `removeParticleTrail` | Trail management |
| `lib/metrics.js` | 800 | `computeServiceTimeStats` | Statistics |

### 1.3 Simple Physics

| Module | Lines | Functions | Notes |
|--------|-------|-----------|-------|
| `physics/sleep-release.js` | 95 | `stepSleepRelease`, `getNextBridgeOpenHour` | Bridge schedule |

---

## Phase 2: Medium-Risk Extractions (~1,300 lines)

Core logic with moderate state coupling.

| Module | Lines | Functions | Context Needed |
|--------|-------|-----------|----------------|
| `physics/cbp-lanes.js` | 205 | `stepCBPLanes`, lane assignment | sinkQueue, CBP_LANES, metrics |
| `physics/park-release.js` | 120 | `stepParkRelease`, `releasePark` | parkReleaseQueue, lotMass |
| `physics/pulse.js` | 150 | `getPulseMultiplier`, shift fractions | simTime, scenario |
| `physics/friction-update.js` | 400 | `updateCommuterLoad`, `congestionFactor` | commuterLoad, baseCommuterWeight |
| `physics/lot-conversion.js` | 400 | `stepConversion`, `updateLotAdmissionState` | conversionQueue, triggers routing |

---

## Phase 3: High-Risk Extractions (~2,900 lines)

Complex initialization, hardcoded data, heavy coupling.

### 3.1 Injection System

| Module | Lines | Functions | Notes |
|--------|-------|-----------|-------|
| `injection/core.js` | 150 | `stepInjection`, `injectParticle` | Source field, accumulator |
| `injection/sources.js` | 250 | `computeSources`, `initCorridorEntries` | Industrial zones |

### 3.2 Geometry Stamping

| Module | Lines | Functions | Notes |
|--------|-------|-----------|-------|
| `geometry/connectors.js` | 400 | `stampConnectorCoord` | **Move coords to JSON** |
| `geometry/commuter.js` | 150 | `stampCommuterWeights` | Polyline stamping |
| `geometry/bridge.js` | 200 | `stampTwinSpanRoad`, `stampSpeedLimits` | Twin span geometry |
| `geometry/tensor.js` | 400 | `bakeKTensor`, `bridgeLotsAndParksToRoads` | Conductance |

### 3.3 Loop Routing

| Module | Lines | Functions | Notes |
|--------|-------|-----------|-------|
| `routing/loop.js` | 966 | `getLoopNextHop` | **CRITICAL: Split into 4 functions** |
| `routing/schedule.js` | 400 | `markRoutingDirty`, `scheduleRoutingRebuild` | Async rebuild |

---

## Critical Refactors

### 1. `getLoopNextHop` (966 lines → 4 functions)

```
routing/loop.js
├── checkWaypointProgress(p, waypoints) → number
├── shouldEnterLoop(p, cellIdx) → boolean
├── shouldExitLoop(p, cellIdx) → boolean
└── getLoopNextHop(p) → number (orchestrator)
```

### 2. `MANUAL_CONNECTOR_COORDS` → JSON

Move ~300 hardcoded coordinates to `data/connectors.json`:
```json
{
  "version": "1.0",
  "connectors": [
    { "name": "PIR_COLONIAL", "coords": [[lat, lon], ...] },
    ...
  ]
}
```

### 3. Particle Colors → Data-Driven

Replace 900 lines of color logic with:
```javascript
// data/particle-themes.js
export const PARTICLE_COLORS = {
  byClass: { ROAD: [0.2, 0.6, 1.0], LOT: [1.0, 0.8, 0.2], ... },
  bySource: { PIR_COLONIAL: [0.3, 0.7, 0.9], ... },
};
```

---

## Target Architecture

```
membrane-field-core/
├── data/
│   ├── geometry.js          # Existing: zones, polylines
│   ├── connectors.json      # NEW: Move hardcoded coords
│   └── particle-themes.js   # NEW: Color definitions
├── lib/
│   ├── constants.js         # Existing
│   ├── grid.js              # Existing
│   ├── MinHeap.js           # Existing
│   ├── geometry-queries.js  # NEW
│   ├── particle-trails.js   # NEW
│   └── metrics.js           # NEW
├── physics/
│   ├── drift.js             # Existing
│   ├── transfer.js          # Existing
│   ├── cbp-lanes.js         # NEW
│   ├── park-release.js      # NEW
│   ├── sleep-release.js     # NEW
│   ├── lot-conversion.js    # NEW
│   ├── friction-update.js   # NEW
│   └── pulse.js             # NEW
├── routing/
│   ├── potential.js         # Existing
│   ├── loop.js              # NEW
│   └── schedule.js          # NEW
├── injection/
│   ├── core.js              # NEW
│   └── sources.js           # NEW
├── geometry/
│   ├── connectors.js        # NEW
│   ├── commuter.js          # NEW
│   ├── bridge.js            # NEW
│   └── tensor.js            # NEW
├── viz/
│   ├── particle-colors.js   # NEW
│   ├── heatmap.js           # NEW
│   ├── panels.js            # NEW
│   ├── speed-limits.js      # NEW
│   ├── lots.js              # NEW
│   └── roads.js             # NEW
├── lots/
│   ├── admission.js         # Existing
│   └── loader.js            # Existing (lotsLoader.js)
├── friction/
│   └── commuter.js          # Existing
├── state.js                 # Existing
└── overlay/
    └── reynosaOverlay_v2.js # ~2,800 lines: lifecycle + orchestration
```

---

## Effort Estimate

| Phase | Lines | Hours | Risk |
|-------|-------|-------|------|
| Phase 1 | 5,300 | 20-30 | Low |
| Phase 2 | 1,300 | 12-17 | Medium |
| Phase 3 | 2,900 | 31-50 | High |
| **Total** | **9,500** | **63-97** | |

---

## What Stays in Main Orchestrator (~2,800 lines)

- `onAttach()`, `onStep()`, `onDetach()` lifecycle
- Enum definitions: `STATE`, `REGION`, `SOURCE_TYPE`
- Configuration constants
- Transform utilities: `worldToFieldX`, `fieldToWorldX`, etc.
- Main step orchestration calling extracted modules
- Assert/invariant checks
- Logging utilities
