// ═══════════════════════════════════════════════════════════════════════════════
// Routing Constants — Shared between main thread and workers
// ═══════════════════════════════════════════════════════════════════════════════

// Potential field values
export const PHI_LARGE = 1e9;          // "Unreachable" marker
export const PHI_SINK = 0.01;          // Sink potential (slightly above zero)

// Traversability threshold
export const K_THRESHOLD = 0.01;       // Minimum conductance for cell to be passable

// Region types (must match reynosaOverlay)
export const REGION_VOID = 0;
export const REGION_ROAD = 1;
export const REGION_LOT = 2;
