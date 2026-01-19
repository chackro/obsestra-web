# Modularization Log

## [PHASE 1] Visualization Helpers

### viz/particle-colors.js
- Extracted: particle color functions and color mode API
- Lines moved: 189
- New file: viz/particle-colors.js
- Verified: module loads successfully
- Functions:
  - getParticleClassColor
  - getParticleStallColor
  - getParticleDebugColor
  - getParticleSourceColor
  - getParticleClassColorRGB
  - getParticleStallColorRGB
  - getParticleSourceColorRGB
  - cycleParticleColorMode
  - getParticleColorMode
  - getParticleColorModeName
  - toggleParticleDebugClassColors
  - isParticleDebugColors
  - toggleParticleSourceColors
  - isParticleSourceColors
  - initParticleColors

### viz/heatmap.js
- Extracted: heatmap rendering functions
- Lines moved: 216
- New file: viz/heatmap.js
- Verified: module loads successfully
- Functions:
  - drawCongestionHeatmap
  - drawCongestionCells
  - thermalGradient
  - drawReplayHeatmap

### viz/panels.js
- Extracted: UI panel rendering functions
- Lines moved: 151
- New file: viz/panels.js
- Verified: module loads successfully
- Functions:
  - drawMetricsPanel
  - drawStallModeLegend

### viz/speed-limits.js
- Extracted: speed limit visualization
- Lines moved: 115
- New file: viz/speed-limits.js
- Verified: module loads successfully
- Functions:
  - drawSpeedLimitPolylines
  - SPEED_COLORS constant

### viz/lots.js
- Extracted: lot geometry rendering
- Lines moved: 199
- New file: viz/lots.js
- Verified: module loads successfully
- Functions:
  - buildLotPaths
  - drawLots
  - resetLotsDebug

### viz/roads.js
- Extracted: road geometry rendering
- Lines moved: 140
- New file: viz/roads.js
- Verified: module loads successfully
- Functions:
  - buildRoadPath
  - addCitySegmentsToPath
  - drawRoads

## [PHASE 1.2] Utilities

### lib/geometry-queries.js
- Extracted: pure geometry query functions
- Lines moved: 113
- New file: lib/geometry-queries.js
- Verified: module loads successfully
- Functions:
  - isInBridgeApproach
  - getTwinSpanXAtY
  - isInQueueZone
- Constants moved:
  - QUEUE_ZONE_HALF_WIDTH
  - QUEUE_ZONE_SEGMENTS

### lib/particle-trails.js
- Extracted: particle trail management for replay mode
- Lines moved: 95
- New file: lib/particle-trails.js
- Verified: module loads successfully
- Functions:
  - setTrailsEnabled
  - getTrailsEnabled
  - getParticleTrails
  - updateParticleTrails
  - clearParticleTrails
  - removeParticleTrail
- Constants moved:
  - TRAIL_LENGTH

### lib/metrics.js
- Extracted: service time statistics computation
- Lines moved: 54
- New file: lib/metrics.js
- Verified: module loads successfully
- Functions:
  - computeServiceTimeStats

## [PHASE 1.3] Simple Physics

### physics/sleep-release.js
- Extracted: bridge schedule and sleep lot wake timing
- Lines moved: 95
- New file: physics/sleep-release.js
- Verified: module loads successfully
- Functions:
  - getNextBridgeOpenHour
  - stepSleepRelease

## [PHASE 2] Medium-Risk Extractions

### physics/cbp-lanes.js
- Extracted: CBP inspection lane model
- Lines moved: 115
- New file: physics/cbp-lanes.js
- Verified: module loads successfully
- Functions:
  - stepCBPLanes
  - getLanesInUse

### physics/park-release.js
- Extracted: park waiting zone release logic
- Lines moved: 90
- New file: physics/park-release.js
- Verified: module loads successfully
- Functions:
  - releasePark
  - stepParkRelease

### physics/pulse.js
- Extracted: injection pulse modulation and shift scheduling
- Lines moved: 190
- New file: physics/pulse.js
- Verified: module loads successfully
- Functions:
  - getTrapezoidMultiplier
  - getShiftBoundaryBias
  - getIndustrialShiftFraction
  - smoothPulse
  - getPulseMultiplier
- Constants:
  - PRIOR_INDUSTRIAL_SHIFT_SHARES
  - SHIFT_END_HOURS, SHIFT_BIAS_WINDOW, SHIFT_BIAS_MAX
  - INDUSTRIAL_PULSE_DAMPING
  - CORRIDOR_PHASE_OFFSETS, ZONE_PHASE_OFFSETS

### physics/friction-update.js
- Extracted: congestion factor and commuter load calculations
- Lines moved: 95
- New file: physics/friction-update.js
- Verified: module loads successfully
- Functions:
  - buildCongestionLUT
  - congestionFactor
  - updateCommuterLoad
- Note: Heavy state coupling - wiring deferred

### physics/lot-conversion.js
- Extracted: lot conversion and admission state management
- Lines moved: 155
- New file: physics/lot-conversion.js
- Verified: module loads successfully
- Functions:
  - stepConversion
  - updateLotAdmissionState
- Note: Heavy state coupling - wiring deferred

## [PHASE 3] High-Risk Extractions

### injection/core.js
- Extracted: particle injection core
- Lines moved: 130
- New file: injection/core.js
- Verified: module loads successfully
- Functions:
  - injectParticle
  - stepInjection
- Note: Heavy state coupling - wiring deferred

### routing/loop.js
- Extracted: loop routing waypoint system
- Lines moved: 100
- New file: routing/loop.js
- Verified: module loads successfully
- Functions:
  - checkLoopEntry
  - advanceWaypoint
  - getLoopNextHop
- Constants:
  - LOOP_CAPTURE_RADIUS_M
  - LOOP_WAYPOINT_RADIUS_M

---

## Progress Summary

### Modules Created: 16
| Module | Lines |
|--------|-------|
| viz/particle-colors.js | 189 |
| viz/heatmap.js | 216 |
| viz/panels.js | 151 |
| viz/speed-limits.js | 115 |
| viz/lots.js | 199 |
| viz/roads.js | 140 |
| lib/geometry-queries.js | 113 |
| lib/particle-trails.js | 95 |
| lib/metrics.js | 54 |
| physics/sleep-release.js | 95 |
| physics/cbp-lanes.js | 115 |
| physics/park-release.js | 90 |
| physics/pulse.js | 190 |
| physics/friction-update.js | 95 |
| physics/lot-conversion.js | 155 |
| injection/core.js | 130 |
| routing/loop.js | 100 |
| **Total** | **~2,042** |

### Wiring Status
- **Fully wired:** viz/*, lib/geometry-queries.js, lib/particle-trails.js, lib/metrics.js, physics/sleep-release.js, physics/cbp-lanes.js, physics/park-release.js, physics/pulse.js
- **Wiring deferred:** physics/friction-update.js, physics/lot-conversion.js, injection/core.js, routing/loop.js

### Remaining Work
- Wire deferred modules
- Move MANUAL_CONNECTOR_COORDS (~885 lines) to data/connectors.json
- Move INOVUS_CONNECTOR_COORDS to data file
- Complete geometry/connectors.js, geometry/commuter.js, geometry/bridge.js extractions
- Complete routing/schedule.js extraction
