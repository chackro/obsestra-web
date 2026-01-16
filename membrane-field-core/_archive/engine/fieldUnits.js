// ═══════════════════════════════════════════════════════════════════════════════
// FIELD UNITS - Explicit physical units for MF-P
// All quantities carry their units. No implicit conversions.
// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────────
// BASE UNITS
// ───────────────────────────────────────────────────────────────────────────────

// Time: seconds
// Nominal physics timestep. Integrators may substep or override.
export const DT_S = 0.016;

// Mass: tons (metric tonnes)
// ρ is in tons/cell (mass density per grid cell)

// Length: meters
// World coordinates are in meters
// Grid cells have side length = worldWidth / FIELD_RES meters

// ───────────────────────────────────────────────────────────────────────────────
// GRID CONSTANTS
// ───────────────────────────────────────────────────────────────────────────────

export const FIELD_RES = 128;  // DEAD CODE - actual resolution is COMPUTE_WINDOW.RESOLUTION
export const FIELD_SIZE = FIELD_RES * FIELD_RES;

// ───────────────────────────────────────────────────────────────────────────────
// CONDUCTANCE UNITS: cells²/s
// K maps potential gradient (1/cell) to velocity (cells/s).
// v = K · (-∇φ)  →  [cells/s] = [cells²/s] · [1/cell]
// ───────────────────────────────────────────────────────────────────────────────

export const K_ROAD = 1.0;           // cells²/s - high permeability along roads
export const K_YARD = 0.3;           // cells²/s - medium permeability in yards
export const K_OFFROAD = 0.0;        // cells²/s - off-road is impassable (zero conductance)

// ───────────────────────────────────────────────────────────────────────────────
// INJECTION/SINK RATES
// S: tons/s (mass injection rate per cell)
// G: 1/s (first-order sink coefficient)
//
// NOTE: G is a first-order service coefficient, NOT a hard throughput cap.
// Effective removal per tick = min(ρ, G · ρ · Δt).
// This models congestion relief proportional to backlog.
// Hard capacity limits (X tons/s max) must be modeled separately if needed.
// ───────────────────────────────────────────────────────────────────────────────

// Default injection: 1 ton/s at full source strength
export const S_BASE_TONS_PER_S = 1.0;

// Default sink: first-order coefficient (80% of backlog removed per second at full rate)
export const G_BASE_PER_S = 0.8;

// ───────────────────────────────────────────────────────────────────────────────
// VELOCITY UNITS: cells/s
// v = K · (-∇φ) has units cells/s
// ───────────────────────────────────────────────────────────────────────────────

// Numerical stability cap (CFL control), not a physical speed limit.
// Ensures advection backtrace stays within neighboring cells per tick.
export const V_MAX_CELLS_PER_S = 2.0;

// ───────────────────────────────────────────────────────────────────────────────
// GEOMETRY STAMPS (in meters, converted to cells at runtime)
// ───────────────────────────────────────────────────────────────────────────────

export const ROAD_WIDTH_M = 60;      // Road stamp width in meters
export const SOURCE_RADIUS_M = 80;   // Source region radius in meters
export const SINK_RADIUS_M = 70;     // Sink region radius in meters

// ───────────────────────────────────────────────────────────────────────────────
// CONVERSION HELPERS
// These are computed at init when world bounds are known.
// Assumes square cells and uniform resolution. worldWidth is authoritative.
// ───────────────────────────────────────────────────────────────────────────────

let _cellSideM = 1;     // meters per cell side
let _m2PerCell = 1;     // m² per cell
let _cellsPerM = 1;     // cells per meter

export function initUnits(worldWidthM, worldHeightM) {
    // Square cells: width determines cell size (height ignored for scaling)
    _cellSideM = worldWidthM / FIELD_RES;
    _m2PerCell = _cellSideM * _cellSideM;
    _cellsPerM = FIELD_RES / worldWidthM;

    console.log('[Units] Cell side:', _cellSideM.toFixed(1), 'm');
    console.log('[Units] Cell area:', _m2PerCell.toFixed(0), 'm²');
}

export function metersToCell(m) {
    return m * _cellsPerM;
}

export function cellToMeters(cells) {
    return cells * _cellSideM;
}

export function getCellSideM() {
    return _cellSideM;
}

export function getM2PerCell() {
    return _m2PerCell;
}
