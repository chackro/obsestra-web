# Particles as Pure Field Tracers - Refactor Status

## Completed Changes

### 1. Added `getFieldVelocityAt()` function (lines 578-631)
- Computes velocity from field's `nextHop` tables (zero particle agency)
- Reads AUTHORITATIVE constants: `FLOW_FRAC` (line 3566), `PHYSICS_SUBSTEPS` (line 2457)
- Uses `roadCongestionFactor()` for congestion coupling

### 2. Replaced `update()` function (lines 633-788)
- Removed all particle-level routing decisions
- Removed `targetNh`, `bestPhi`, `visualLotRemaining`
- Movement is now pure: `p.x += velocity.vx * realDt`
- Particles stall when field returns zero velocity

### 3. Fixed `_deadEndDeaths` → `_deadEndStalls`
- Dead ends are pressure, not failure
- Log now shows: `deaths(sink=X oob=Y) stalls(deadEnd=Z preLot=W)`

### 4. Fixed phi_pharr Dijkstra invariant (line 2862-2870)
```javascript
// PHARR INVARIANT: Lots are NOT intermediate nodes.
if (label === 'PHARR' && regionMap[idx] === REGION_LOT) {
    continue;  // Skip neighbor expansion
}
```
- Lots can RECEIVE phi (for exit routing)
- Lots do NOT propagate phi (no routing through lots)

### 5. Fixed `roadCongestionFactor()` (line 3553-3557)
```javascript
// Local density (SPATIAL mass only - staging buckets excluded)
const rho = rho_restricted[idx] + rho_cleared[idx];
```
- Excluded `rho_restricted_preLot` (staging bucket, not physical occupancy)
- Breaks feedback loop where staging state inflated congestion

---

## Summary of Invariants Now Enforced

| Component | Rule |
|-----------|------|
| `phi_pharr` Dijkstra | Lots receive phi but don't propagate |
| `nextHop_pharr` | From roads: never into lots. From lots: to adjacent road (exit) |
| `getFieldVelocityAt()` | Reads `FLOW_FRAC`, `PHYSICS_SUBSTEPS` from module scope (no duplication) |
| `roadCongestionFactor()` | Spatial mass only (`rho_restricted + rho_cleared`) |
| Particle update | Zero agency - samples velocity from field, nothing else |

---

## What's Next?

Ready to test. The simulation should now show:
- Particles following field routing exactly
- No particles cutting through lots
- Congestion reflecting actual physical occupancy
- Cleared particles exiting lots correctly

Let me know if you want me to check anything else or if there are issues to address.
