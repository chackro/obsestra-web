// ═══════════════════════════════════════════════════════════════════════════════
// Routing Constants — Shared between main thread and workers
// ═══════════════════════════════════════════════════════════════════════════════

// Potential field values
export const PHI_LARGE = 1e9;          // "Unreachable" marker
export const PHI_SINK = 0.01;          // Sink potential (slightly above zero)

// Traversability threshold
export const K_THRESHOLD = 0.01;       // Minimum conductance for cell to be passable

// Region types — MUST match reynosaOverlay_v2.js REGION enum (lines 884-890)
export const REGION_OFFROAD = 0;       // Not traversable (alias: VOID)
export const REGION_ROAD = 1;          // Traversable road
export const REGION_PARK = 2;          // Park waiting zone (distinct from lot)
export const REGION_LOT = 3;           // Lot interior (conversion yards)
export const REGION_SINK = 4;          // Exit point (PHARR)

// Legacy alias
export const REGION_VOID = REGION_OFFROAD;
