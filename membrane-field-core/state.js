// ═══════════════════════════════════════════════════════════════════════════════
// Simulation State — Centralized mutable state for physics simulation
// ═══════════════════════════════════════════════════════════════════════════════
//
// All simulation state lives here. Functions receive `state` as first argument.
// This enables:
//   - Testability: create mock state, call function, assert mutations
//   - Clarity: explicit dependencies, no hidden globals
//   - Worker compatibility: state can be transferred/shared
//
// ═══════════════════════════════════════════════════════════════════════════════

import { COMPUTE_WINDOW } from './spec/renderer_interfaces.js';

const N = COMPUTE_WINDOW.RESOLUTION;
const N2 = N * N;

// ═══════════════════════════════════════════════════════════════════════════════
// STATE STRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════

export const state = {
    // Grid dimensions (read-only after init)
    N,
    N2,

    // ───────────────────────────────────────────────────────────────────────────
    // GRID — Per-cell physical state
    // ───────────────────────────────────────────────────────────────────────────
    grid: {
        cellMass: new Float64Array(N2),           // kg per cell
        cellParticles: Array.from({ length: N2 }, () => []),  // particles[] per cell
        regionMap: new Uint8Array(N2),            // REGION enum per cell
        Kxx: new Float32Array(N2),                // X conductance
        Kyy: new Float32Array(N2),                // Y conductance
        commuterLoad: new Float32Array(N2),       // [0, 1+] commuter friction
        baseCommuterWeight: new Float32Array(N2), // [0, 1] static arterial map
    },

    // ───────────────────────────────────────────────────────────────────────────
    // ROUTING — Potential fields and next-hop maps (rebuilt periodically)
    // ───────────────────────────────────────────────────────────────────────────
    routing: {
        phi_lots: new Float32Array(N2),
        phi_pharr: new Float32Array(N2),
        phi_pharr_twin: new Float32Array(N2),
        phi_parks: new Float32Array(N2),
        phi_sleepLots: new Float32Array(N2),
        nextHop_lots: new Int32Array(N2),
        nextHop_pharr: new Int32Array(N2),
        nextHop_pharr_twin: new Int32Array(N2),
        nextHop_parks: new Int32Array(N2),
        nextHop_sleepLots: new Int32Array(N2),
        version: 0,                               // Increments on rebuild
        dirty: false,                             // Needs rebuild
    },

    // ───────────────────────────────────────────────────────────────────────────
    // LOTS — Conversion yard state
    // ───────────────────────────────────────────────────────────────────────────
    lots: {
        capacity: new Float32Array(0),            // Max kg per lot (resized on load)
        mass: new Float32Array(0),                // Current kg per lot
        draining: new Set(),                      // Lots currently draining
        cooldownEndSimS: new Float64Array(0),     // Sim-time when cooldown ends
        cellToLotIndex: new Int16Array(N2),       // Cell → lot index (-1 if not)
        lotToCellIndices: [],                     // Lot → array of cell indices
    },

    // ───────────────────────────────────────────────────────────────────────────
    // PARKS — Staging area state
    // ───────────────────────────────────────────────────────────────────────────
    parks: {
        capacity: new Float32Array(0),            // Max kg per park
        mass: new Float32Array(0),                // Current kg per park
        cellToParkIndex: new Int16Array(N2),      // Cell → park index (-1 if not)
        parkToCellIndices: [],                    // Park → array of cell indices
        releaseQueue: [],                         // FIFO queue for park → lot release
    },

    // ───────────────────────────────────────────────────────────────────────────
    // PARTICLES — Global particle tracking
    // ───────────────────────────────────────────────────────────────────────────
    particles: {
        idCounter: 0,
        activeCount: 0,
        movingCount: 0,
    },

    // ───────────────────────────────────────────────────────────────────────────
    // TIME — Simulation clock
    // ───────────────────────────────────────────────────────────────────────────
    time: {
        simTime: 0,                               // Simulation time in seconds
    },

    // ───────────────────────────────────────────────────────────────────────────
    // METRICS — Counters and accumulators
    // ───────────────────────────────────────────────────────────────────────────
    metrics: {
        cbpCompletionCount: 0,
        departedCount: 0,
        spawnCount: 0,
        truckHoursLost: 0,
        truckHoursLostCongestion: 0,
        truckHoursLostLotWait: 0,
        truckHoursLostBridgeQueue: 0,
        truckHoursLostBridgeService: 0,
        stallTonHours: 0,
    },

    // ───────────────────────────────────────────────────────────────────────────
    // CELL INDICES — Precomputed cell lists by type
    // ───────────────────────────────────────────────────────────────────────────
    cellIndices: {
        road: [],
        lot: [],
        sink: [],
        source: [],
        conductive: [],
        park: [],
        industrialPark: [],
        twinSpan: [],
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize cell arrays to default values.
 * Called once at startup.
 */
export function initState() {
    // cellToLotIndex: -1 means "not a lot cell"
    state.lots.cellToLotIndex.fill(-1);
    state.parks.cellToParkIndex.fill(-1);
}

/**
 * Reset all mutable state to initial values.
 * Called on simulation reset.
 */
export function resetState() {
    // Grid
    state.grid.cellMass.fill(0);
    for (let i = 0; i < N2; i++) {
        state.grid.cellParticles[i].length = 0;
    }
    state.grid.commuterLoad.fill(0);

    // Lots
    state.lots.mass.fill(0);
    state.lots.draining.clear();
    state.lots.cooldownEndSimS.fill(0);

    // Parks
    state.parks.mass.fill(0);
    state.parks.releaseQueue.length = 0;

    // Particles
    state.particles.activeCount = 0;
    state.particles.movingCount = 0;

    // Time
    state.time.simTime = 0;

    // Metrics
    state.metrics.cbpCompletionCount = 0;
    state.metrics.departedCount = 0;
    state.metrics.spawnCount = 0;
    state.metrics.truckHoursLost = 0;
    state.metrics.truckHoursLostCongestion = 0;
    state.metrics.truckHoursLostLotWait = 0;
    state.metrics.truckHoursLostBridgeQueue = 0;
    state.metrics.truckHoursLostBridgeService = 0;
    state.metrics.stallTonHours = 0;

    // Routing
    state.routing.version = 0;
    state.routing.dirty = true;
}

// Initialize on module load
initState();
