# Unified Physics Integration Plan

## Files Created

```
/home/claude/unifiedPhysics.js        - Core physics module (particles inlined)
/home/claude/unifiedPhysicsAdapter.js - Adapter for existing renderer
```

## Architecture Comparison

### OLD (Two Systems That Can Diverge)
```
graphFlowClass()           →  Updates rho_* arrays
  ↓ (separate)
createParticleLayer()      →  Particles try to follow, can drift/lie
  ↓ (can diverge)
render()                   →  Shows particles (may not match rho)
```

### NEW (Unified - One Truth)
```
createUnifiedPhysics()     →  Cells contain mass + particles atomically
  ↓ (same object)
step()                     →  Moves mass = moves particles (instant teleport)
  ↓ (identical)
render()                   →  Shows particles (ARE the physics state)
```

## Integration Points in reynosaOverlay.js

### 1. Import (add at top, ~line 75)
```javascript
import { createUnifiedAdapter, installConsoleTest } from './unifiedPhysicsAdapter.js';
```

### 2. Replace particleLayer creation (line 2172)

BEFORE:
```javascript
particleLayer = createParticleLayer({
    N, regionMap, fieldToWorldX, fieldToWorldY, ...
});
```

AFTER:
```javascript
particleLayer = createUnifiedAdapter({
    N, regionMap, fieldToWorldX, fieldToWorldY,
    nextHop_lots, nextHop_pharr,
    roadCellIndices, lotCellIndices, sinkCellIndices,
    cellToLotIndex, lotToCellIndices, lotCapacityKg,
    REGION_LOT, G, TRUCK_KG
});
installConsoleTest(particleLayer);
```

### 3. Replace graphFlowClass calls (line 3404-3405)

BEFORE:
```javascript
const rStats = graphFlowClass('restricted', rho_restricted, rhoNext_restricted);
const cStats = graphFlowClass('cleared', rho_cleared, rhoNext_cleared);
```

AFTER:
```javascript
// Physics now unified - step handles both classes
particleLayer.step(substepDt);
const rStats = particleLayer.getStats();
const cStats = rStats;  // Same stats object
```

### 4. Replace rho array reads for heatmap (throughout)

BEFORE:
```javascript
const rho = rho_restricted[idx] + rho_cleared[idx];
```

AFTER:
```javascript
const rho = particleLayer.getRhoArray('restricted')[idx] + 
            particleLayer.getRhoArray('cleared')[idx];
```

Or cache the arrays per frame:
```javascript
// At frame start
const rhoRestricted = particleLayer.getRhoArray('restricted');
const rhoCleared = particleLayer.getRhoArray('cleared');

// Then use directly
const rho = rhoRestricted[idx] + rhoCleared[idx];
```

### 5. Replace particle injection (line 4930)

BEFORE:
```javascript
particleLayer.emitFromMass(restrictedKg, i, 'restricted', parkWaitIdx);
```

AFTER:
```javascript
particleLayer.injectMass(i, restrictedKg, 'restricted');
```

### 6. Replace particle drawing (line 2586)

BEFORE:
```javascript
particleLayer.draw(ctx, camera);
```

AFTER:
```javascript
particleLayer.render(ctx, camera);
// Or for debug colors:
// particleLayer.renderDebug(ctx, camera);
```

## What Gets Deleted

These 200+ lines become unnecessary (particle layer tries to infer physics state):

- Lines 786-1055: `updateParticles()` loop with drift checks, lot detection, etc.
- Lines 646-688: `convertParticlesInLot()` 
- Lines 691-775: `getFieldVelocityAt()` 

These arrays become internal to unified physics:
- `rho_restricted`, `rho_cleared`, `rho_restricted_lot`, `rho_restricted_preLot`
- `rhoNext_restricted`, `rhoNext_cleared`

## Testing Strategy

### Phase 1: Parallel Run
1. Keep old system running
2. Add unified physics alongside
3. Compare outputs each frame
4. Log divergences

### Phase 2: Pressure Tests
Run in browser console after integration:
```javascript
testUnifiedPhysics()   // Run all tests
checkInvariants()      // Verify no lies
physicsStats()         // Show totals
lotStats()             // Show lot usage
```

### Phase 3: Cutover
1. Disable old graphFlowClass
2. Use unified physics for all flow
3. Monitor for invariant violations

## Key Behavioral Differences

| Aspect | Old | New |
|--------|-----|-----|
| Particle position | Drifts continuously | Teleports to cell center |
| Mass ↔ particle sync | Async (can diverge) | Atomic (always synced) |
| State transitions | Inferred from position | Explicit via operations |
| Invariant checking | None | Every operation |
| Lot entry | Proximity capture + Dijkstra | Dijkstra only |
| Debugging | Chase lies through 200 lines | Check one invariant |

## Next Steps

1. Copy files to your project:
   ```bash
   cp /home/claude/unifiedPhysics.js /path/to/your/project/
   cp /home/claude/unifiedPhysicsAdapter.js /path/to/your/project/
   ```

2. Add imports to reynosaOverlay.js

3. Run parallel for one session to verify behavior

4. Cut over when confident

5. Delete old particle layer code (~400 lines)
