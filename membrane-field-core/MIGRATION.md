# Routing Module Migration Guide

## New Structure

```
membrane-field-core/
├── lib/
│   ├── MinHeap.js       # Priority queue (was duplicated)
│   ├── constants.js     # PHI_LARGE, K_THRESHOLD, REGION_* 
│   ├── grid.js          # getNeighbors4, idxToXY, etc.
│   └── index.js         # Re-exports all
│
├── routing/
│   ├── potential.js     # computePotential, buildNextHop
│   └── index.js         # Re-exports all
│
└── engine/
    └── routingWorker.js # Thin wrapper (imports from routing/)
```

## Changes to reynosaOverlay_v2.js

### 1. Add imports at top

```javascript
import { MinHeap } from '../lib/MinHeap.js';
import { getNeighbors4, idxToXY, xyToIdx } from '../lib/grid.js';
import { 
    PHI_LARGE, PHI_SINK, K_THRESHOLD, 
    REGION_VOID, REGION_ROAD, REGION_LOT 
} from '../lib/constants.js';
```

### 2. Delete duplicated MinHeap class

Remove lines ~2074-2115 (the inline MinHeap class).

### 3. Delete duplicated constants

Remove these lines (they're now in lib/constants.js):
```javascript
const PHI_LARGE = 1e9;
const PHI_SINK = 0.01;
const K_THRESHOLD = 0.01;
```

### 4. Replace manual neighbor loops

Before:
```javascript
const x = idx % N;
const y = Math.floor(idx / N);
if (x > 0)     neighbors.push(idx - 1);
if (x < N - 1) neighbors.push(idx + 1);
if (y > 0)     neighbors.push(idx - N);
if (y < N - 1) neighbors.push(idx + N);
```

After:
```javascript
const neighbors = getNeighbors4(idx, N);
```

### 5. Update worker instantiation

Before:
```javascript
_routingWorker = new Worker('../engine/routingWorker.js');
```

After:
```javascript
_routingWorker = new Worker('../engine/routingWorker.js', { type: 'module' });
```

## What This Unlocks

1. **No more duplication** — MinHeap exists once, used everywhere
2. **Testable routing** — Import `computePotential` directly in tests
3. **Main-thread fallback** — If worker fails, call `computeRouting()` directly
4. **Cleaner diffs** — Routing changes are isolated to routing/

## Next Extraction Candidates

After routing is stable, consider extracting:

1. **lots/** — Admission logic, dwell sampling, capacity math
2. **physics/** — step(), congestion calculation, particle state machine  
3. **friction/** — Commuter curves, speed penalties
4. **data/** — Hardcoded geometry (BRIDGE_APPROACH_QUAD, intersections)

Each follows the same pattern:
1. Create module with pure functions
2. Import shared primitives from lib/
3. Update reynosaOverlay_v2 to import instead of inline
4. Delete the duplicated code
