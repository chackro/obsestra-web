// ═══════════════════════════════════════════════════════════════════════════════
// REYNOSA EAST OVERLAY
// Zoom-activated micro-physics overlay for the Reynosa → PHARR corridor.
// Consumes CIEN geometry and scenario data. Renders density/pressure field.
//
// AUTHORITY: This file is authoritative for physics. (fieldPhysics.js was deleted)
//
// INVARIANTS (Dual-Potential Routing Authority):
// 1. phi_pharr defines cleared mass routing (→ PHARR).
// 2. phi_lots defines restricted mass routing (→ lots for transfer dwell).
// 3. Density never alters direction.
// 4. Roads shape resistance, not destination.
// 5. Congestion accumulates, never deflects.
// 6. Class-conditioned routing: restricted → lots, cleared → PHARR.
//
// v2: Multi-class system with restricted/cleared mass and conversion
// ═══════════════════════════════════════════════════════════════════════════════

import {
    REYNOSA_ACTIVATION,
    OverlayState,
    COMPUTE_WINDOW,
    getHs2Class,
    FRICTION_COEFFICIENTS,
    LocalScenarioDefaults,
} from '../spec/renderer_interfaces.js';

import { computeAlpha, resetAlpha, getCurrentAlpha } from './alphaDriver.js';
import { hasBundle, getBundle, getSegmentsInROI } from './bundleConsumer.js';
import {
    hasScenarioPair,
    getVisibleSegments,
    hasGeometryChanged,
    getBaseline,
    getInterserrana,
} from './scenarioPair.js';
import {
    createInterpolatedScenarioAdapter,
    computeGeometryHash,
    createInterpolatedRendererContext,
} from './interpolatedAdapter.js';

import {
    loadWeightMaps,
    hasWeightMaps,
    getBaselineWeight,
    getInterserranaWeight,
    clearWeightMaps,
    computeInjectionPointWeights,
    computeInjectionPointWeightsFromWorldSegments,
    getInjectionPointRatios,
} from './segmentWeights.js';

// Class system imports
import {
    V1_CLASS_IDS,
    V1_CLASSES,
    V1_REGIONS,
    V1_SINKS,
    REGION_YARD_MAIN,
    canClassDrainAtSink,
    getEligibleClassesForSink,
} from '../engine/classSystem.js';

// Physics constants from single source of truth
import {
    G_BASE_PER_S,
    K_OFFROAD,
} from '../engine/fieldUnits.js';

// Coordinate transform from single source of truth
import { RENDERER_TRANSFORM } from '../contracts/ReynosaOverlayBundle.js';

// Lots loader for polygon-based conversion zones
import { loadLots, stampLots, buildLotCellIndices, getIndustrialParksWithArea } from './lotsLoader.js';

// Unified physics adapter (replaces dual particle+graphFlow system)
import { createUnifiedAdapter, installConsoleTest } from './unifiedPhysicsAdapter.js';

// ───────────────────────────────────────────────────────────────────────────────
// SEEDABLE PRNG (xorshift128+ for reproducibility)
// ───────────────────────────────────────────────────────────────────────────────

let _rngState = [0x12345678, 0x9ABCDEF0, 0xDEADBEEF, 0xCAFEBABE];

/**
 * Seed the PRNG for reproducible simulations.
 * @param {number} seed - 32-bit seed value
 */
export function seedRng(seed) {
    _rngState[0] = seed >>> 0;
    _rngState[1] = (seed * 1664525 + 1013904223) >>> 0;
    _rngState[2] = (seed * 22695477 + 1) >>> 0;
    _rngState[3] = (seed * 134775813 + 1) >>> 0;
    console.log(`[RNG] Seeded with ${seed}`);
}

/**
 * Get next random float in [0, 1) from seedable PRNG.
 * Uses xorshift128+ algorithm.
 * @returns {number}
 */
function rng() {
    let s0 = _rngState[0];
    let s1 = _rngState[1];
    const result = (s0 + s1) >>> 0;

    s1 ^= s0;
    _rngState[0] = ((s0 << 23) | (s0 >>> 9)) ^ s1 ^ (s1 << 17);
    _rngState[1] = (s1 << 26) | (s1 >>> 6);

    return result / 0x100000000;
}

// ───────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ───────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// TIME AUTHORITY - Single source of truth for time scaling
// ═══════════════════════════════════════════════════════════════════════════════
//
// ARCHITECTURE: Physics runs real daily rates. Renderers observe state.
// Time compression affects how fast sim-time advances, NOT mass volumes.
//
// Physics = truth (ρ, φ, queues, caps, mass in/out)
// Renderer = instrument (particles, colors, "how it feels")
//
// ═══════════════════════════════════════════════════════════════════════════════

// How long one day takes on screen (video time)
// AUTHORITATIVE: All time scaling derives from this constant.
const DAY_VIDEO_SECONDS = 75;

// Simulation duration: 1 week (lot releases can take up to 72 hours)
const SIM_DAYS = 7;
const SIM_SECONDS_TOTAL = SIM_DAYS * 24 * 3600;  // 604,800 (1 week)

// Legacy alias for compatibility
const SIM_SECONDS_PER_DAY = 24 * 3600;  // 86,400

// Derived: How many simulation seconds pass per real (video) second
// = 86,400 / 75 = 1,152 sim-seconds per real-second (same compression per day)
const SIM_TIME_SCALE = SIM_SECONDS_PER_DAY / DAY_VIDEO_SECONDS;

// Total video duration for full simulation
const TOTAL_VIDEO_SECONDS = SIM_DAYS * DAY_VIDEO_SECONDS;  // 525 seconds (~8.75 min)

const N = COMPUTE_WINDOW.RESOLUTION;
const N2 = N * N;

// Physics parameters (sink-driven potential, no compass bias)
const PHI_SINK = 0.0;              // Low potential at sinks (attractors)
const PHI_LARGE = 1e6;             // Large value for unreachable cells

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFER REQUIREMENT FRACTION
// Fraction of incoming mass that requires yard transfer before PHARR eligibility.
// ~65% of trucks need transfer (restricted class), ~35% can go direct (cleared).
// ═══════════════════════════════════════════════════════════════════════════════
const TRANSFER_REQUIREMENT_FRACTION = 0.65;  // 65% → restricted, 35% → cleared

// ═══════════════════════════════════════════════════════════════════════════════
// LOT CLEARING (GLOBAL FIFO QUEUE OF TRUCK QUANTA) — ontology-correct
//
// Lots are passive buffers. The city has scarce service capacity (visas, dual-plate,
// coordination). Clearing is global and FIFO over discrete truck tokens.
//
// Core invariant:
// A truck arriving at time t cannot be cleared before all earlier-arriving trucks
// (that are eligible) have cleared.
//
// Implementation notes:
// - Restricted mass entering a lot mints TRUCK_KG tokens for that lot, stamped with arrival time.
// - Particles are the truck tokens (1 = 9000kg) and are minted ONLY at source injection.
// - Tokens enter ONE global FIFO queue when a restricted particle physically arrives at a lot
//   (arrivalSimTime stamped then). FIFO service flips eligible tokens to cleared (>=36h wait).
// - Service budget accrues in SIM time and pops eligible tokens oldest-first.
// - Clearing converts TRUCK_KG from that *lot's* restricted storage into `rho_cleared`.
// - Particles mirror these service events per-lot.
// ═══════════════════════════════════════════════════════════════════════════════

// PARTICLE-MASS INVARIANT:
// - One particle represents exactly TRUCK_KG kilograms.
// - Particle count must equal total system mass / TRUCK_KG.
// - No caps, clamps, merges, or sampling; performance is managed by manually raising TRUCK_KG.
// Truck quantum (1 truck = 9000kg)
const TRUCK_KG = 9000;

// Eligibility: minimum dwell before a token may be serviced
const MIN_CLEAR_WAIT_S = 36 * 3600;
const MAX_CLEAR_WAIT_S = 72 * 3600; // used only as calibration target
const TARGET_DWELL_HOURS = 54;       // midpoint of 36–72 for reverse-engineering
const TARGET_DWELL_S = TARGET_DWELL_HOURS * 3600;

// Global FIFO waiting queue of PARTICLE TOKENS (truck quanta).
// Tokens are minted ONLY at source injection (particles), and enter this FIFO when the
// restricted particle physically arrives at a lot (arrivalSimTime is stamped then).
const _waitingParticleQueue = [];
let _waitingParticleQueueHead = 0;

// Global service budget (kg), accumulates in SIM seconds
let _globalServiceBudgetKg = 0;

// Current sim time (seconds). Updated from onFrame before physics runs.
let _simTimeSeconds = 0;

// ───────────────────────────────────────────────────────────────────────────────
// TIME CONTROLS
// Pause/resume freezes physics and FIFO timers (render can keep going).
// Speed presets allow different compression ratios.
// ───────────────────────────────────────────────────────────────────────────────
let _simPaused = false;
let _simSpeedMultiplier = 1.0;  // Applied on top of SIM_TIME_SCALE

const TIME_PRESETS = {
    realtime: 1 / SIM_TIME_SCALE,     // 1:1 real time
    normal: 1.0,                       // Default (1 day = 75s)
    fast: 2.0,                         // 1 day = 37.5s
    day_per_minute: 86400 / 60 / SIM_TIME_SCALE,  // 1 day = 1 minute
    week_per_minute: 604800 / 60 / SIM_TIME_SCALE // 1 week = 1 minute
};

// Spread lot inflow across lot interior (visual + numerical stability).
// Without this, both field storage and particles can "vacuum" into a single entry cell.
let _lotScatterCursor = null; // Int32Array(lotCount), round-robin index into lotToCellIndices[lotIdx]
const LOT_SCATTER_MAX_CELLS_PER_DEPOSIT = 8; // cap work per deposit; spreads enough for visuals

// ───────────────────────────────────────────────────────────────────────────────
// PRE-TRANSFER FRICTION (Survey N=242: shoulder maneuver + coordination wait)
// These delays occur ON ROADS before particles reach lots.
// "No roadside storage" - this is short-term friction, not long-term dwell.
// ───────────────────────────────────────────────────────────────────────────────
const P_SHOULDER = 0.46;             // 46% of restricted do shoulder maneuver
const T_SHOULDER_MIN_S = 3600;       // 1 hour minimum shoulder duration
const T_SHOULDER_MAX_S = 7200;       // 2 hour maximum shoulder duration

const P_COORD_1H = 0.30;             // 30% have coordination wait >= 1 hour
const T_COORD_SHORT_MIN_S = 0;       // 0 hours (quick coordination)
const T_COORD_SHORT_MAX_S = 3600;    // 1 hour (quick coordination)
const T_COORD_LONG_MIN_S = 3600;     // 1 hour (long coordination)
const T_COORD_LONG_MAX_S = 14400;    // 4 hours (long coordination)

// NOTE (2025-12): Pre-transfer friction is now FIELD-authoritative via `rho_restricted_preLot`.
// Particles must NOT introduce independent timers/delay. The survey parameters remain for
// documentation and potential future calibration of PRELOT_MIN_S/PRELOT_MAX_S, but particles
// do not sample them.

// ═══════════════════════════════════════════════════════════════════════════════
// ROAD CONGESTION IMPEDANCE
// Density-dependent flow reduction on roads. Prevents oscillation by making
// lot refilling slow as roads congest. Does NOT change routing or sinks.
// ═══════════════════════════════════════════════════════════════════════════════
const RHO_CONGESTION_0 = 50000;   // kg: congestion onset (~5-6 trucks per cell)
const CONGESTION_P = 3;           // Sharpness exponent (2-4 is sane)

// ───────────────────────────────────────────────────────────────────────────────
// PRE-LOT HOLDING (FIELD-AUTHORITATIVE PRE-TRANSFER FRICTION)
//
// Invariant:
// Particles may never introduce delay/storage/congestion not first represented in field scalars.
//
// Interpretation:
// Restricted mass that reaches a road→lot interface may either:
// - enter the lot immediately (fraction α)
// - divert into roadside/shoulder holding upstream of the lot (fraction 1-α) for 1–6 hours
//
// This is NOT FIFO service dwell and NOT lot storage. It is road occupancy upstream of lots.
// ───────────────────────────────────────────────────────────────────────────────

// α: fraction of restricted inflow at lot boundary that enters lots immediately
const PRELOT_ALPHA = 1.0; // DISABLED FOR TESTING - 100% enter lots, 0% hold roadside

// Deterministic delay distribution (uniform) for roadside holding: 1–6 hours
const PRELOT_MIN_S = 1 * 3600;
const PRELOT_MAX_S = 6 * 3600;

// Bucketed ring buffer to avoid per-particle timers and preserve field authority.
// Sparse by design: only road cells near lot boundaries should accumulate entries.
const PRELOT_BUCKET_WIDTH_S = 15 * 60; // 15 minutes
const PRELOT_BUCKET_COUNT = Math.ceil(PRELOT_MAX_S / PRELOT_BUCKET_WIDTH_S) + 1; // inclusive
const _preLotBuckets = Array.from({ length: PRELOT_BUCKET_COUNT }, () => new Map()); // Map<cellIdx, kg>
let _preLotHead = 0;
let _preLotTimeAccS = 0;

// Sparse live ledger for diagnostics (avoids scanning N2).
// Keyed by road cell idx where rho_restricted_preLot[idx] > 0.
const _preLotLiveKgByCell = new Map(); // Map<cellIdx, kg>
let _preLotLiveTotalKg = 0;

// Debug visualization cache (ImageData approach for phi field)
let _debugOffscreen = null;
let _debugImageData = null;

function _preLotLiveAdd(cellIdx, kg) {
    if (kg <= 0) return;
    _preLotLiveKgByCell.set(cellIdx, (_preLotLiveKgByCell.get(cellIdx) || 0) + kg);
    _preLotLiveTotalKg += kg;
}

function _preLotLiveRemove(cellIdx, kg) {
    if (kg <= 0) return;
    const prev = _preLotLiveKgByCell.get(cellIdx) || 0;
    const next = prev - kg;
    if (next > 1e-6) _preLotLiveKgByCell.set(cellIdx, next);
    else _preLotLiveKgByCell.delete(cellIdx);
    _preLotLiveTotalKg = Math.max(0, _preLotLiveTotalKg - kg);
}

function _preLotBucketAdd(bucketIdx, cellIdx, kg) {
    if (kg <= 0) return;
    const b = _preLotBuckets[bucketIdx];
    b.set(cellIdx, (b.get(cellIdx) || 0) + kg);
}

function schedulePreLotReleaseUniform(cellIdx, kg) {
    if (kg <= 0) return;
    const minOff = Math.max(1, Math.ceil(PRELOT_MIN_S / PRELOT_BUCKET_WIDTH_S));
    const maxOff = Math.max(minOff, Math.ceil(PRELOT_MAX_S / PRELOT_BUCKET_WIDTH_S));
    const n = (maxOff - minOff + 1);
    const share = kg / n;
    for (let off = minOff; off <= maxOff; off++) {
        const bi = (_preLotHead + off) % PRELOT_BUCKET_COUNT;
        _preLotBucketAdd(bi, cellIdx, share);
    }
}

function advancePreLotHolding(dtSimSeconds) {
    if (dtSimSeconds <= 0) return;
    _preLotTimeAccS += dtSimSeconds;
    const steps = Math.floor(_preLotTimeAccS / PRELOT_BUCKET_WIDTH_S);
    if (steps <= 0) return;

    // Advance the ring one (or more) buckets; release matured mass back into rho_restricted.
    for (let s = 0; s < steps; s++) {
        const bucket = _preLotBuckets[_preLotHead];
        if (bucket.size > 0) {
            for (const [cellIdx, kg] of bucket.entries()) {
                // Re-inject into mobile restricted on the same road cell
                rho_restricted[cellIdx] += kg;
                // Remove from preLot storage (clamp to avoid negative due to fp drift)
                rho_restricted_preLot[cellIdx] = Math.max(0, rho_restricted_preLot[cellIdx] - kg);
                _preLotLiveRemove(cellIdx, kg);
            }
            bucket.clear();
        }
        _preLotHead = (_preLotHead + 1) % PRELOT_BUCKET_COUNT;
    }
    _preLotTimeAccS -= steps * PRELOT_BUCKET_WIDTH_S;
}

// ───────────────────────────────────────────────────────────────────────────────
// INJECTION PULSE MODULATION (Organic arrival waves)
//
// Uses overlapping sine waves at incommensurate periods for natural variation.
// No hard on/off - always some trucks, with varying intensity (~12% to ~190%).
// Per-source jitter prevents mechanical synchronization between sources.
// Average multiplier = 1.0 preserves hourly totals from loadHourlyInflow.
// ───────────────────────────────────────────────────────────────────────────────

// Phase offsets for different source types (creates staggered waves)
const CORRIDOR_PHASE_OFFSETS = {
    'ENTRY_EAST': 0,
    'ENTRY_WEST': 1350,  // 22.5 min offset (half period - maximally out of phase)
};

const ZONE_PHASE_OFFSETS = {
    'norte': 450,         // 7.5 min offset
    'poniente': 1800,     // 30 min offset
    'san_fernando': 900,  // 15 min offset
    'pharr_bridge': 2250, // 37.5 min offset
};

// Map source cell index -> phase offset (populated in stampInjectionSources)
const _sourcePhaseOffset = new Map();

/**
 * Get pulse multiplier for injection at given sim time.
 * Uses overlapping sine waves at incommensurate periods for organic variation.
 * Always some flow (never fully off), peaks and troughs vary naturally.
 * Average multiplier ≈ 1.0 to preserve hourly totals.
 *
 * @param {number} simTime - Current simulation time in seconds
 * @param {number} phaseOffset - Base phase offset for this source type
 * @param {number} sourceIdx - Source cell index (adds per-source micro-variation)
 */
function getPulseMultiplier(simTime, phaseOffset = 0, sourceIdx = 0) {
    // Per-source jitter: each source gets unique micro-offset (0-10 min range)
    // Uses prime multiplier to spread sources pseudo-randomly
    const sourceJitter = (sourceIdx * 137) % 600;
    const t = simTime + phaseOffset + sourceJitter;

    // Overlapping waves at incommensurate periods (creates organic, non-mechanical feel)
    // Periods chosen to not align: 47min, 31min, 19min, 11min
    const wave1 = Math.sin(t * 2 * Math.PI / 2820) * 0.35;   // ~47 min, ±35%
    const wave2 = Math.sin(t * 2 * Math.PI / 1860) * 0.25;   // ~31 min, ±25%
    const wave3 = Math.sin(t * 2 * Math.PI / 1140) * 0.18;   // ~19 min, ±18%
    const wave4 = Math.sin(t * 2 * Math.PI / 660) * 0.12;    // ~11 min, ±12%

    // Sum oscillates around 1.0 with range ~0.1 to ~1.9
    // Average is 1.0 (sine averages to 0), preserving hourly totals
    const multiplier = 1.0 + wave1 + wave2 + wave3 + wave4;

    // Soft floor: always some trucks (min 12% of average rate)
    return Math.max(0.12, multiplier);
}

// Diagnostic mode - when true, K=1 on roads, K=0 elsewhere, no extras
let DEBUG_BINARY_K = false;

// Progress callback for long-running operations (Dijkstra solve)
let _phiProgressCallback = null;
export function setPhiProgressCallback(cb) {
    _phiProgressCallback = cb;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MIN-HEAP (for Dijkstra)
// ═══════════════════════════════════════════════════════════════════════════════

class MinHeap {
    constructor() { this.data = []; }

    push(item) {
        this.data.push(item);
        this._bubbleUp(this.data.length - 1);
    }

    pop() {
        if (this.data.length === 0) return undefined;
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            this._bubbleDown(0);
        }
        return top;
    }

    isEmpty() { return this.data.length === 0; }
    size() { return this.data.length; }

    _bubbleUp(i) {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.data[parent][0] <= this.data[i][0]) break;
            [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
            i = parent;
        }
    }

    _bubbleDown(i) {
        const n = this.data.length;
        while (true) {
            let smallest = i;
            const left = 2 * i + 1, right = 2 * i + 2;
            if (left < n && this.data[left][0] < this.data[smallest][0]) smallest = left;
            if (right < n && this.data[right][0] < this.data[smallest][0]) smallest = right;
            if (smallest === i) break;
            [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
            i = smallest;
        }
    }
}

// Weighted conductance parameters
// Low floor + wide span: weak segments become viscous, strong ones feel like highways
const K_BASE = 0.05;
const K_DELTA = 0.95;
const RENDER_MODE = {
    HEATMAP: 'heatmap',
    PARTICLES: 'particles',
    BOTH: 'both',
};
const PARTICLE_Z_FLOOR_DEFAULT = REYNOSA_ACTIVATION.Z_WARM;
const PARTICLE_DEFAULTS = {
    lifeSeconds: 700000,  // ~615k sim-s to cross 80km at 0.13 m/s (was 700 - faded instantly)
    viewportPaddingM: 1200,
    jitterMeters: 30,
};

// Advisory-only (no clamping): operators can raise TRUCK_KG if counts get high.
const ADVISORY_PARTICLE_WARN = 50000;

// Particle mass constant (visualization only, not physics)
// 9000 kg = 1 truck. One particle = one truck.
const PARTICLE_MASS_KG = 9000;

// ───────────────────────────────────────────────────────────────────────────────
// PARTICLE LAYER (INLINED - render-only, non-authoritative)
// Follows nextHop graph and renders lightweight particles for visualization.
// ───────────────────────────────────────────────────────────────────────────────

function createParticleLayer(opts) {
    const pN = opts.N;
    const pN2 = pN * pN;
    const cellSizeM = opts.cellSizeM;
    const fieldToWorldX = opts.fieldToWorldX;
    const fieldToWorldY = opts.fieldToWorldY;
    const worldToFieldX = opts.worldToFieldX;
    const worldToFieldY = opts.worldToFieldY;
    const sourceField = opts.sourceField;

    let lifeSeconds = opts.lifeSeconds ?? PARTICLE_DEFAULTS.lifeSeconds;
    let viewportPaddingM = opts.viewportPaddingM ?? PARTICLE_DEFAULTS.viewportPaddingM;
    let jitterMeters = opts.jitterMeters ?? PARTICLE_DEFAULTS.jitterMeters;

    // Dense array: only alive particles exist in array (macro pattern)
    let particles = [];

    // Per-source accumulator: small trickle from one source never "borrows" mass from another
    const particleAccumulatorKgBySource = new Map();  // sourceIdx → kg
    let sourceCache = [];
    let sourcesDirty = true;

    // Preallocated for off-road snap (4-connected neighbors)
    const _neighbors = new Int32Array(4);
    let _rebuildSourcesLogged = false;

    function rebuildSources(force = false) {
        if (!sourcesDirty && !force) return;
        sourceCache = [];
        let totalSourceWeight = 0;
        for (let i = 0; i < pN2; i++) {
            if (sourceField[i] <= 0) continue;
            const fx = i % pN;
            const fy = Math.floor(i / pN);
            totalSourceWeight += sourceField[i];
            sourceCache.push({
                wx: fieldToWorldX(fx),
                wy: fieldToWorldY(fy),
                weight: sourceField[i],
            });
        }
        if (sourceCache.length > 0 && !_rebuildSourcesLogged) {
            console.log('[ParticleLayer] rebuildSources:', sourceCache.length, 'cells, totalWeight:', totalSourceWeight.toFixed(2));
            _rebuildSourcesLogged = true;
        }
        sourcesDirty = false;
    }

    // Emit particle from specific source (dense array: just push)
    // CLASS-CONDITIONED ROUTING: particles are assigned 'restricted' or 'cleared'
    // based on TRANSFER_REQUIREMENT_FRACTION (65/35 split) unless forcedClassId is provided
    //
    // forcedClassId: optional 'restricted' or 'cleared' to force class (for deterministic emission)
    // parkWaitIdx: optional wait zone index for park particles (spawns parked in park)
    function emitParticleFromSource(sourceIdx, forcedClassId = null, parkWaitIdx = -1) {
        const fx = sourceIdx % pN;
        const fy = Math.floor(sourceIdx / pN);
        let wx = fieldToWorldX(fx + 0.5);
        let wy = fieldToWorldY(fy + 0.5);

        // Particle tokens are mass-conserving (1 particle = 9000kg).
        // Tokens are minted at SOURCE injection, split between restricted/cleared.
        const classId = forcedClassId || (rng() < TRANSFER_REQUIREMENT_FRACTION ? 'restricted' : 'cleared');

        // PARK LOCAL DWELL: If this is a park-origin restricted particle,
        // spawn it directly in the park wait zone and flag as waiting
        let waitingInPark = false;
        let parkIdx = -1;
        let releaseCellIdx = sourceIdx;  // Where cleared particle exits to road

        if (parkWaitIdx >= 0 && classId === 'restricted') {
            // Get a cell in the park wait zone
            const parkCell = getParkWaitCell(parkWaitIdx);
            if (parkCell >= 0) {
                const pcx = parkCell % pN;
                const pcy = Math.floor(parkCell / pN);
                wx = fieldToWorldX(pcx + 0.5);
                wy = fieldToWorldY(pcy + 0.5);
                waitingInPark = true;
                parkIdx = parkWaitIdx;
                // Find nearest road for cleared exit
                releaseCellIdx = findNearestRoadFromPark(parkCell);
            }
        }

        const p = {
            x: wx + (rng() - 0.5) * jitterMeters,
            y: wy + (rng() - 0.5) * jitterMeters,
            px: wx,
            py: wy,
            age: 0,
            life: lifeSeconds,
            // NOTE: sourceIdx is provenance metadata only.
            // It must never be used to influence routing,
            // conductance, capacity, or conversion logic.
            sourceIdx: sourceIdx,
            // CLASS-CONDITIONED ROUTING: determines which nextHop table to follow
            classId: classId,
            // FIELD-AUTHORITATIVE: whether this token is in pre-lot holding state (visual only).
            // Determined each frame from `rho_restricted_preLot` fraction at the current cell.
            // Stable assignment uses this token key so particles don't flicker between states.
            _preLotTokenKey: rng(), // [0,1)
            preLotStalled: false,
            // Lot parking: once a restricted particle enters a lot, we "park" it
            // at an interior cell so lots don't look like single-cell vacuums.
            lotParked: false,
            // PARK LOCAL DWELL: for park-origin restricted particles
            waitingInPark: waitingInPark,
            parkIdx: parkIdx,
            releaseCellIdx: releaseCellIdx,
        };

        particles.push(p);
        _injectedTrucks++;

        // If parking in park, add to FIFO queue immediately
        if (waitingInPark) {
            p.waitingInLot = true;  // Reuse waitingInLot flag for FIFO compatibility
            p.lotIdx = -1;  // Not in a lot (in park)
            p.lotArrivalSimTime = _simTimeSeconds;
            _waitingParticleQueue.push(p);
        }

        return true;
    }

    // Emit particles proportional to injected mass (called from injectMass)
    // forcedClassId: optional 'restricted' or 'cleared' to force class
    // parkWaitIdx: optional wait zone index for park particles
    let _emitCounter = 0;
    let _emitDebugCounter = 0;
    function emitFromMass(injectedKg, sourceIdx, forcedClassId = null, parkWaitIdx = -1) {
        let acc = particleAccumulatorKgBySource.get(sourceIdx) ?? 0;
        acc += injectedKg;

        while (acc >= PARTICLE_MASS_KG) {
            emitParticleFromSource(sourceIdx, forcedClassId, parkWaitIdx);
            acc -= PARTICLE_MASS_KG;
            _emitCounter++;
        }

        particleAccumulatorKgBySource.set(sourceIdx, acc);

        // Debug accumulator state every 60 calls
        if (_emitDebugCounter++ % 60 === 0) {
            const classInfo = forcedClassId ? ` class=${forcedClassId}` : '';
            const parkInfo = parkWaitIdx >= 0 ? ` park=${parkWaitIdx}` : '';
            console.log(`[ACCUM] sourceIdx=${sourceIdx} added=${injectedKg.toFixed(2)} acc=${acc.toFixed(0)}/${PARTICLE_MASS_KG} emitted=${_emitCounter}${classInfo}${parkInfo}`);
        }
    }

    let _particleDebugCounter = 0;
    let _deadEndStalls = 0, _sinkDeaths = 0, _oobDeaths = 0, _ageDeaths = 0, _nanDeaths = 0;
    let _preLotStalls = 0;  // Restricted particles stalled due to FIELD pre-lot holding (visual mirror)
    let _particleClearLogMs = 0;

    // Conservation counters (truck tokens)
    let _injectedTrucks = 0;
    let _sunkTrucks = 0;

    // Convert N restricted particles currently dwelling in a specific lot into 'cleared',
    // to visually mirror the FIFO service event for that lot.
    function clearRestrictedParticlesInLot(lotIdx, trucksToClear) {
        if (lotIdx == null || lotIdx < 0) return 0;
        if (!trucksToClear || trucksToClear <= 0) return 0;

        let cleared = 0;
        let restrictedInThisLot = 0;

        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            if ((p.classId || 'cleared') !== 'restricted') continue;

            const fx = worldToFieldX(p.x);
            const fy = worldToFieldY(p.y);
            const cellX = Math.floor(fx);
            const cellY = Math.floor(fy);
            if (cellX < 0 || cellX >= N || cellY < 0 || cellY >= N) continue;
            const idx = cellY * N + cellX;
            if (regionMap[idx] !== REGION_LOT) continue;
            if (cellToLotIndex[idx] !== lotIdx) continue;

            restrictedInThisLot++;
            if (cleared < trucksToClear) {
                p.classId = 'cleared';
                p.preLotStalled = false;
                cleared++;
                if (cleared >= trucksToClear) break;
            }
        }

        const now = performance.now();
        if (now - _particleClearLogMs > 2000) {
            _particleClearLogMs = now;
            console.log(`[PARTICLE-CLEAR] lot#${lotIdx} trucksWanted=${trucksToClear} flipped=${cleared} restrictedInLot=${restrictedInThisLot}`);
        }

        return cleared;
    }

    // NOTE: No "mint restricted particles into lots". Lots do not create tokens.
    // Restricted particles are minted at SOURCE injection only.

    /**
     * Get velocity vector for a particle based on FIELD state only.
     * Particles have ZERO agency - they follow field-computed routing and congestion.
     *
     * @param {number} idx - Cell index where particle is located
     * @param {string} classId - 'restricted' or 'cleared'
     * @returns {{vx: number, vy: number}} Velocity in world units/second
     */
    function getFieldVelocityAt(idx, classId) {
        // Restricted particles in lots are parked (zero velocity)
        if (classId === 'restricted' && regionMap[idx] === REGION_LOT) {
            return { vx: 0, vy: 0 };
        }

        // Get field-computed next hop (field decides routing, not particle)
        const nh_table = (classId === 'restricted') ? nextHop_lots : nextHop_pharr;
        const nh = nh_table[idx];

        // No next hop means no movement (at sink or stuck)
        if (nh < 0) {
            return { vx: 0, vy: 0 };
        }

        // ─────────────────────────────────────────────────────────────────────
        // CAPACITY GATE FOR PARTICLES: mirror field gate to avoid visual entry
        // into lots that have no remaining capacity.
        // Restricted particles wait on road until capacity is available.
        // ─────────────────────────────────────────────────────────────────────
        if (classId === 'restricted' && regionMap[nh] === REGION_LOT) {
            const lotIdx = cellToLotIndex[nh];
            if (lotIdx >= 0) {
                // If lot fullness is known, block when full (fast path)
                if (lotIsFull && lotIsFull.length > lotIdx && lotIsFull[lotIdx]) {
                    return { vx: 0, vy: 0 };
                }
                const remaining = lotAcceptRemainingKgLive?.[lotIdx] ?? 0;
                if (remaining < TRUCK_KG) {
                    return { vx: 0, vy: 0 };
                }
            }
        }

        // Compute direction vector from current cell to next hop
        const cx = idx % N;
        const cy = Math.floor(idx / N);
        const nhx = nh % N;
        const nhy = Math.floor(nh / N);

        const dx = nhx - cx;
        const dy = nhy - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 0.001) {
            return { vx: 0, vy: 0 };
        }

        // ═══════════════════════════════════════════════════════════════════
        // VISUAL SPEED CALIBRATION (per SIM second)
        // Target: particles look like trucks moving at reasonable speed on screen.
        // 80km corridor in ~9 minutes real time at 1x speed:
        //   80000m / (540s real × SIM_TIME_SCALE) = 80000 / (540 × 1152) = 0.13 m/s sim
        // Visual pacing tracks sim time (time presets accelerate world + particles together).
        // Congestion uses the SAME scalar as physics (roadCongestionFactor).
        // ═══════════════════════════════════════════════════════════════════
        const TARGET_VISUAL_SPEED_MS = 0.5;  // meters per SIM second

        // Congestion from field (same scalar as physics) - slows particles in dense areas
        const congestionFactor = (regionMap[idx] === REGION_LOT) ? 1.0 : roadCongestionFactor(idx);

        // Final visual speed
        const speedMS = TARGET_VISUAL_SPEED_MS * congestionFactor;

        const dirX = dx / dist;
        const dirY = dy / dist;

        return {
            vx: dirX * speedMS,
            vy: dirY * speedMS
        };
    }

    function update(dt, camera) {
        // ═══════════════════════════════════════════════════════════════
        // PARTICLES AS PURE FIELD TRACERS
        // Particles have ZERO agency. They follow field-computed routing
        // and congestion. Movement is sampled from getFieldVelocityAt().
        // ═══════════════════════════════════════════════════════════════

        // Reset death counters
        _sinkDeaths = 0;
        _ageDeaths = 0;
        _oobDeaths = 0;
        _deadEndStalls = 0;
        _nanDeaths = 0;
        _preLotStalls = 0;

        // DENSE ITERATION: process all particles, mark dead with life = -1
        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            const pClass = p.classId || 'cleared';

            // Get particle's current cell coordinates
            const fx = worldToFieldX(p.x);
            const fy = worldToFieldY(p.y);
            const cellX = Math.floor(fx);
            const cellY = Math.floor(fy);

            // Out of bounds check
            if (cellX < 0 || cellX >= N || cellY < 0 || cellY >= N) {
                _oobDeaths++;
                console.warn(`[PARTICLE OOB] Particle escaped bounds at (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
                p.life = -1;
                continue;
            }

            const idx = cellY * N + cellX;

            // ═══════════════════════════════════════════════════════════════
            // PARK LOCAL DWELL: Restricted particles waiting in industrial parks
            // ═══════════════════════════════════════════════════════════════
            if (p.waitingInPark && pClass === 'restricted') {
                // Parked in industrial park - no movement
                p.px = p.x;
                p.py = p.y;
                p.age += dt;
                continue;
            }

            // PARK LOCAL DWELL: Cleared park particles teleport to release road
            if (p.waitingInPark === false && p.parkIdx >= 0 && pClass === 'cleared') {
                // Particle was converted from park - teleport to release cell
                if (p.releaseCellIdx >= 0 && p.releaseCellIdx < N2) {
                    const rx = p.releaseCellIdx % N;
                    const ry = Math.floor(p.releaseCellIdx / N);
                    p.x = fieldToWorldX(rx + 0.5);
                    p.y = fieldToWorldY(ry + 0.5);
                    p.parkIdx = -1;  // Clear park association
                    p.releaseCellIdx = -1;
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // RESTRICTED PARTICLES IN LOTS: Parked (field handles conversion)
            // ═══════════════════════════════════════════════════════════════
            // DEBUG: Check for restricted particles that LOOK like they're in lots but aren't registered
            if (pClass === 'restricted' && !p.waitingInLot) {
                const lotIdx = cellToLotIndex ? cellToLotIndex[idx] : -1;
                if (lotIdx >= 0 && regionMap[idx] !== REGION_LOT) {
                    // Particle is in a cell that maps to a lot but regionMap says it's not a lot!
                    if (Math.random() < 0.01) {
                        console.error(`[LOT-MISMATCH] Particle at cell ${idx} (${cellX},${cellY}) has lotIdx=${lotIdx} but regionMap=${regionMap[idx]} (expected ${REGION_LOT})`);
                    }
                }
                // Check if particle is on a ROAD cell adjacent to a lot (might look like it's in the lot visually)
                if (regionMap[idx] !== REGION_LOT && lotIdx < 0) {
                    // Check neighbors for lot cells
                    let adjacentLot = -1;
                    const x = idx % N, y = Math.floor(idx / N);
                    const neighbors = [idx-1, idx+1, idx-N, idx+N];
                    for (const ni of neighbors) {
                        if (ni >= 0 && ni < N*N && regionMap[ni] === REGION_LOT) {
                            adjacentLot = cellToLotIndex ? cellToLotIndex[ni] : -1;
                            break;
                        }
                    }
                    if (adjacentLot >= 0 && Math.random() < 0.005) {
                        console.warn(`[LOT-ADJACENT] Particle at road cell ${idx} (${cellX},${cellY}) is adjacent to lot#${adjacentLot} - may LOOK like it's in lot`);
                    }
                }
            }
            if (pClass === 'restricted' && regionMap[idx] === REGION_LOT) {
                // DRIFT CHECK: Verify particle was actually routed here, not drifted by accident.
                // Field mass goes cell-to-cell discretely; particles drift continuously.
                // A particle can step onto a different lot than its routing intended.
                const prevCellX = Math.floor(worldToFieldX(p.px));
                const prevCellY = Math.floor(worldToFieldY(p.py));
                const prevIdx = prevCellY * N + prevCellX;
                const intendedNh = nextHop_lots[prevIdx];

                // Only park if we were actually routed here (or already here)
                if (intendedNh !== idx && prevIdx !== idx) {
                    // Drifted onto wrong lot - snap back to previous position
                    p.x = p.px;
                    p.y = p.py;
                    continue;
                }

                const lotIdx = cellToLotIndex ? cellToLotIndex[idx] : -1;
                const remaining = lotIdx >= 0 ? (lotAcceptRemainingKgLive?.[lotIdx] ?? 0) : 0;
                const fullFlag = lotIdx >= 0 ? (lotIsFull?.[lotIdx] ?? false) : false;
                // Capacity gate: if lot is full/no remaining capacity, do NOT park or queue
                if (lotIdx >= 0 && (fullFlag || remaining < TRUCK_KG)) {
                    // Do not park or queue; particle stays in place (velocity gate will stall it)
                } else {
                // First time entering lot: add to FIFO queue
                    if (!p.waitingInLot) {
                    p.waitingInLot = true;
                        p.lotIdx = lotIdx;
                    p.lotArrivalSimTime = _simTimeSeconds;
                    _waitingParticleQueue.push(p);
                    }

                    // Visual parking: position randomly within lot (one-time)
                    if (!p.lotParked) {
                        const cells = lotIdx >= 0 ? lotToCellIndices[lotIdx] : null;
                        if (cells && cells.length > 0) {
                            const pick = cells[Math.floor(rng() * cells.length)];
                            const cx = pick % N;
                            const cy = Math.floor(pick / N);
                            // DEBUG: Verify target cell is actually REGION_LOT
                            if (regionMap[pick] !== REGION_LOT) {
                                console.error(`[LOT-PARK BUG] Particle repositioned to cell ${pick} (${cx},${cy}) which is NOT REGION_LOT! regionMap=${regionMap[pick]} lotIdx=${lotIdx}`);
                            }
                            p.x = fieldToWorldX(cx + 0.5);
                            p.y = fieldToWorldY(cy + 0.5);
                        }
                        p.lotParked = true;
                    }

                    // NO MOVEMENT - parked particles are stationary
                    p.px = p.x;
                    p.py = p.y;
                        p.age += dt;
                    continue;  // Skip all movement logic
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // CLEARED PARTICLES AT PHARR SINK: Die (conservation: mass exits)
            // ═══════════════════════════════════════════════════════════════
            if (pClass === 'cleared' && G[idx] > 0.001) {
                const nh_table = nextHop_pharr;
                if (nh_table[idx] < 0) {
                    _sinkDeaths++;
                    _sunkTrucks++;
                    p.life = -1;
                    continue;
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // CONVERSION: Un-park if particle converted from restricted to cleared
            // ═══════════════════════════════════════════════════════════════
            if (p.lotParked && pClass === 'cleared') {
                p.lotParked = false;
                p.waitingInLot = false;
            }

            // ═══════════════════════════════════════════════════════════════
            // MOVEMENT: Sample velocity from FIELD (zero particle agency)
            // ═══════════════════════════════════════════════════════════════
            p.px = p.x;
            p.py = p.y;

            // FIELD-AUTHORITATIVE PRE-LOT HOLDING (visual mirror only)
            // Deterministically stall a fraction of restricted particles based on the
            // preLot fraction in the field at this cell.
            if (pClass === 'restricted' && regionMap[idx] !== REGION_LOT) {
                const pre = rho_restricted_preLot[idx] || 0;
                const mob = rho_restricted[idx] || 0;
                const denom = pre + mob;
                const frac = denom > 1e-6 ? (pre / denom) : 0;
                if (typeof p._preLotTokenKey !== 'number') {
                    p._preLotTokenKey = rng();
                }
                const shouldStall = frac > 0 && p._preLotTokenKey < frac;
                p.preLotStalled = shouldStall;
                if (shouldStall) {
                    _preLotStalls++;
                    p.age += dt;
                    continue;
                }
            } else {
                p.preLotStalled = false;
            }

            // Discrete nextHop cell-step integrator.
            // This keeps particles on the traversable graph and avoids drifting off-road,
            // even when simDt per frame is large (SIM_TIME_SCALE).
            const nh_table = (pClass === 'restricted') ? nextHop_lots : nextHop_pharr;

            // If we're already in an invalid cell (nh<0) try to recover by snapping to a neighboring
            // cell that has a valid nextHop. This fixes "scattered off-road and frozen".
            let currentIdx = idx;
            if (nh_table[currentIdx] < 0 && regionMap[currentIdx] !== REGION_LOT) {
                const cx0 = currentIdx % N;
                const cy0 = Math.floor(currentIdx / N);
                let recoveredIdx = -1;
                for (let oy = -1; oy <= 1 && recoveredIdx < 0; oy++) {
                    for (let ox = -1; ox <= 1; ox++) {
                        if (ox === 0 && oy === 0) continue;
                        const cx = cx0 + ox;
                        const cy = cy0 + oy;
                        if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;
                        const nIdx = cy * N + cx;
                        if (nh_table[nIdx] >= 0) {
                            recoveredIdx = nIdx;
                            break;
                        }
                    }
                }
                if (recoveredIdx >= 0) {
                    const rx = recoveredIdx % N;
                    const ry = Math.floor(recoveredIdx / N);
                    p.x = fieldToWorldX(rx + 0.5);
                    p.y = fieldToWorldY(ry + 0.5);
                    currentIdx = recoveredIdx;  // USE RECOVERED INDEX FOR VELOCITY
                } else {
                    // No recovery possible: treat as dead-end stall.
                    _deadEndStalls++;
                    p.age += dt;
                    continue;
                }
            }

            // ═══════════════════════════════════════════════════════════════
            // CLAMPED CELL-STEP INTEGRATION
            // Move toward nextHop but clamp to cell boundary to avoid overshooting
            // into off-road cells during turns. Resample velocity when entering new cell.
            // ═══════════════════════════════════════════════════════════════
            const velocity = getFieldVelocityAt(currentIdx, pClass);

            // Diagnostic: detect stalls
            if (velocity.vx === 0 && velocity.vy === 0) {
                const nh = nh_table[currentIdx];
                if (nh < 0) {
                    _deadEndStalls++;
                } else {
                    _preLotStalls++;
                }
                p.age += dt;
                continue;
            }

            // Compute next cell center as target
            const nh = nh_table[currentIdx];
            const nhx = nh % N;
            const nhy = Math.floor(nh / N);
            const targetX = fieldToWorldX(nhx + 0.5);
            const targetY = fieldToWorldY(nhy + 0.5);

            // Distance to target
            const dx = targetX - p.x;
            const dy = targetY - p.y;
            const distToTarget = Math.sqrt(dx * dx + dy * dy);

            // How far we'd move this frame
            const speed = Math.sqrt(velocity.vx * velocity.vx + velocity.vy * velocity.vy);
            const moveDistance = speed * dt;

            if (moveDistance >= distToTarget) {
                // Would overshoot: snap to target cell center
                p.x = targetX;
                p.y = targetY;
            } else {
                // Normal integration
                p.x += velocity.vx * dt;
                p.y += velocity.vy * dt;
            }

            p.age += dt;

            // NO AGE-BASED DEATH
            // Particles live until they reach sink or go out of bounds
            // Conservation: if field mass exists, particle must exist
        }

        // In-place compaction: remove dead particles (life < 0)
        let writeIdx = 0;
        for (let i = 0; i < particles.length; i++) {
            if (particles[i].life >= 0) {
                if (writeIdx !== i) {
                    particles[writeIdx] = particles[i];
                }
                writeIdx++;
            }
        }
        particles.length = writeIdx;

        // Advisory-only: warn at high counts; no clamping.
        if (particles.length > ADVISORY_PARTICLE_WARN) {
            console.warn(`[PARTICLE ADVISORY] High particle count ${particles.length} (warn=${ADVISORY_PARTICLE_WARN}). Consider increasing TRUCK_KG for performance; physics untouched.`);
        }

        // Diagnostic logging (every ~5 seconds)
        if (_particleDebugCounter++ % 300 === 0) {
            const aliveCount = particles.length;
            const visualizedKg = aliveCount * PARTICLE_MASS_KG;
            console.log(
                `[PARTICLE] alive=${aliveCount} ` +
                `deaths(sink=${_sinkDeaths} oob=${_oobDeaths}) ` +
                `stalls(deadEnd=${_deadEndStalls} preLot=${_preLotStalls}) visualizedKg=${visualizedKg.toFixed(0)}`
            );

            // Conservation check
            const expectedAlive = _injectedTrucks - _sunkTrucks;
            if (Math.abs(aliveCount - expectedAlive) > 10) {
                console.warn(`[PARTICLE CONSERVATION] alive=${aliveCount} expected=${expectedAlive} (injected=${_injectedTrucks} sunk=${_sunkTrucks})`);
            }
        }
    }

    // Debug mode: color-code particles by class/state (M key)
    let debugClassColors = false;

    function toggleDebugClassColors() {
        debugClassColors = !debugClassColors;
        console.log(`[PARTICLE DEBUG] Class colors: ${debugClassColors ? 'ON' : 'OFF'}`);
        return debugClassColors;
    }

    // Color scheme for debug mode
    // - Cleared (routing to PHARR): green
    // - Restricted moving on road: blue
    // - Restricted pre-lot holding stall: yellow (field-authoritative)
    // - Restricted waiting in lot (FIFO): orange
    // - Restricted stuck/detour: red
    function getParticleDebugColor(p, idx) {
        const pClass = p.classId || 'cleared';

        if (pClass === 'cleared') {
            return '#00cc00';  // Green - cleared, routing to PHARR
        }

        // Restricted particle states
        if (p.waitingInLot) {
            return '#ff8800';  // Orange - in lot, waiting in FIFO
        }
        if (p.preLotStalled) {
            return '#ffff00';  // Yellow - pre-lot holding stall (field-authoritative)
        }

        // Use actual stuck flag set by particle update logic
        if (p.stuck) {
            return '#ff0000';  // Red - truly stuck (surrounded by full lots)
        }

        return '#0088ff';  // Blue - restricted, moving normally
    }

    // Reusable buckets for batched rendering (5 opacity levels)
    const NUM_BUCKETS = 5;
    const arcBuckets = Array.from({ length: NUM_BUCKETS }, () => []);

    function draw(ctx, camera) {
        if (!camera?.worldToScreen) return;

        const particleR = Math.max(1, camera.metersToPixels(6));
        const jitterPx = particleR * 2;

        // DEBUG MODE: Color-coded by class/state
        if (debugClassColors) {
            ctx.save();
            ctx.globalAlpha = 0.9;

            for (let i = 0; i < particles.length; i++) {
                const p = particles[i];
                const alpha = Math.max(0, 1 - p.age / p.life);
                if (alpha <= 0.01) continue;

                const screenCurr = camera.worldToScreen(p.x, p.y);
                const jx = ((i * 7919) % 1000) / 500 - 1;
                const jy = ((i * 6271) % 1000) / 500 - 1;

                ctx.fillStyle = getParticleDebugColor(p, i);
                ctx.beginPath();
                ctx.arc(
                    screenCurr.x + jx * jitterPx,
                    screenCurr.y + jy * jitterPx,
                    particleR, 0, 6.283185307
                );
                ctx.fill();
            }

            // Draw legend
            ctx.globalAlpha = 1.0;
            ctx.font = '11px monospace';
            const legend = [
                ['#0088ff', 'Restricted (moving)'],
                ['#ffff00', 'Pre-lot holding'],
                ['#ff0000', 'Stuck at full lot'],
                ['#ff8800', 'Waiting in FIFO'],
                ['#00cc00', 'Cleared (to PHARR)'],
            ];
            let ly = 20;
            for (const [color, label] of legend) {
                ctx.fillStyle = color;
                ctx.fillRect(10, ly - 8, 12, 12);
                ctx.fillStyle = '#fff';
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 2;
                ctx.strokeText(label, 26, ly);
                ctx.fillText(label, 26, ly);
                ly += 16;
            }

            ctx.restore();
            return;
        }

        // NORMAL MODE: Black particles with alpha buckets
        // Clear buckets
        for (let b = 0; b < NUM_BUCKETS; b++) {
            arcBuckets[b].length = 0;
        }

        // First pass: bucket particles by quantized alpha
        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            const alpha = Math.max(0, 1 - p.age / p.life);
            if (alpha <= 0.01) continue;

            // Quantize alpha to bucket (0-4)
            const bucket = Math.min(NUM_BUCKETS - 1, Math.floor(alpha * NUM_BUCKETS));

            const screenCurr = camera.worldToScreen(p.x, p.y);
            // Use particle index as seed for deterministic jitter (no flicker)
            const jx = ((i * 7919) % 1000) / 500 - 1;  // -1 to 1
            const jy = ((i * 6271) % 1000) / 500 - 1;  // -1 to 1
            arcBuckets[bucket].push(screenCurr.x + jx * jitterPx, screenCurr.y + jy * jitterPx, particleR);
        }

        // Second pass: draw all particles solid black
        ctx.save();
        ctx.fillStyle = '#000';
        ctx.globalAlpha = 1.0;

        for (let b = 0; b < NUM_BUCKETS; b++) {
            const arcs = arcBuckets[b];
            if (arcs.length === 0) continue;

            // Draw all arcs in one path
            ctx.beginPath();
            for (let j = 0; j < arcs.length; j += 3) {
                ctx.moveTo(arcs[j] + arcs[j + 2], arcs[j + 1]);
                ctx.arc(arcs[j], arcs[j + 1], arcs[j + 2], 0, 6.283185307);
            }
            ctx.fill();
        }

        ctx.restore();
    }

    function reset() {
        particles.length = 0;  // Dense array: just clear
        particleAccumulatorKgBySource.clear();
        sourceCache = [];
        sourcesDirty = true;
    }

    function configure(newOpts = {}) {
        if (typeof newOpts.lifeSeconds === 'number') lifeSeconds = newOpts.lifeSeconds;
        if (typeof newOpts.viewportPaddingM === 'number') viewportPaddingM = newOpts.viewportPaddingM;
        if (typeof newOpts.jitterMeters === 'number') jitterMeters = newOpts.jitterMeters;
        if (newOpts.sourcesDirty === true) sourcesDirty = true;
    }

    function markSourcesDirty() {
        sourcesDirty = true;
    }

    return {
        update,
        draw,
        reset,
        configure,
        markSourcesDirty,
        emitFromMass,
        clearRestrictedParticlesInLot,
        getAccumulatorsBySource: () => particleAccumulatorKgBySource,
        getParticles: () => particles,
        toggleDebugClassColors,
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────────────────────────────────────

let state = OverlayState.OFF;
let rendererContext = null;

// Compute window (ROI)
let roi = {
    centerX: 0,
    centerY: 0,
    sizeM: COMPUTE_WINDOW.SIZE_M,
    cellSize: COMPUTE_WINDOW.SIZE_M / N,
};

// Unified physics adapter (replaces separate particle layer + graphFlowClass)
let particleLayer = null;
let _unifiedAdapterInitialized = false;
let _particleDebugColors = false;  // Toggle for debug coloring in renderDebug()

/**
 * Create unified adapter after all initialization is complete.
 * Called from rebuildPhiBase completion when routing tables are ready.
 */
function createUnifiedAdapterIfReady() {
    if (_unifiedAdapterInitialized) return;
    if (!_lotsLoaded) return;
    if (roadCellIndices.length === 0) return;
    if (sinkCellIndices.length === 0) return;

    particleLayer = createUnifiedAdapter({
        N,
        regionMap,
        fieldToWorldX,
        fieldToWorldY,
        worldToFieldX,
        worldToFieldY,
        nextHop_lots,
        nextHop_pharr,
        roadCellIndices,
        lotCellIndices,
        sinkCellIndices,
        cellToLotIndex,
        lotToCellIndices,
        lotCapacityKg,
        REGION_LOT,
        G,
        TRUCK_KG,
    });
    installConsoleTest(particleLayer);
    _unifiedAdapterInitialized = true;
    console.log('[ReynosaOverlay] Unified physics adapter initialized');
}

// ───────────────────────────────────────────────────────────────────────────────
// MULTI-CLASS FIELD STATE
// ───────────────────────────────────────────────────────────────────────────────

// Per-class density arrays
//
// Ontology (crisp):
// - `rho_restricted` is restricted mass ON ROADS (transit).
// - `rho_restricted_preLot` is restricted mass ON ROADS but stopped/holding before lot entry (pre-lot staging).
// - `rho_restricted_lot` is restricted mass stored INSIDE LOTS (buffered).
// - `rho_park_wait` is restricted mass dwelling inside industrial parks (park wait zones).
// - `rho_cleared` is cleared mass (can exit to PHARR).
//
// Clearing order/eligibility is handled by the GLOBAL FIFO token queue, not by per-cell clocks.
const rho_restricted = new Float32Array(N2);
const rho_restricted_preLot = new Float32Array(N2);
const rho_restricted_lot = new Float32Array(N2);
const rho_park_wait = new Float32Array(N2);
const rho_cleared = new Float32Array(N2);

// Class registry for iteration
const classRhoMap = {
    restricted: rho_restricted,
    cleared: rho_cleared,
};

// Region map: cell index → region ID
const regionMap = new Uint8Array(N2);
const REGION_CORRIDOR = 0;
const REGION_YARD = 1;      // @deprecated - use REGION_LOT
const REGION_LOT = 1;       // Polygon-based conversion zones (replaces circular yard)

// ───────────────────────────────────────────────────────────────────────────────
// ROAD TYPE CLASSIFICATION (Topology Layer - affects Dijkstra edge cost)
// ───────────────────────────────────────────────────────────────────────────────

// Road type map: cell index → road type (0=highway, 1=city)
const roadTypeMap = new Uint8Array(N2);
const ROAD_TYPE_HIGHWAY = 0;
const ROAD_TYPE_CITY = 1;

// Cost multiplier for city roads in Dijkstra (city roads are "slower" topologically)
const CITY_ROAD_COST_MULT = 2.0;

// City road polylines (world coordinates in meters from PHARR origin)
// Roads near these polylines are classified as "city" and get higher edge cost
const CITY_ROAD_POLYLINES = [
    // Polyline 1: East-west city road
    [
        { x: -4582.148437394849, y: -4574.063756261302 },
        { x: -8085.774369604802, y: -2855.8426982720207 },
        { x: -8156.599019810488, y: -2725.997506228261 },
        { x: -12365.875627078103, y: -2227.198746026022 },
        { x: -15661.581272968138, y: -1869.3443267423252 },
        { x: -16491.623787176923, y: -1351.347870506768 },
        { x: -16903.524583701583, y: -1463.6844513771298 },
        { x: -25299.031995218917, y: -5130.40918906724 },
    ],
    // Polyline 2: North-south city road
    [
        { x: -6425, y: -12000 },
        { x: -7348.530176320497, y: -3659.508440337674 },
        { x: -7269.432741877691, y: -3369.484514047387 },
    ],
];

// Distance threshold for city road classification (meters from polyline)
// Increased to 500m to compensate for coarser grid (525 resolution = ~152m cells)
const CITY_ROAD_RADIUS_M = 800;

// Lot-road connector stamping K (used to bridge lots to the road network).
// IMPORTANT: connector/apron cells are not "true roads" and should not be classified as city roads.
const K_CONNECTOR = 0.2;

// ───────────────────────────────────────────────────────────────────────────────
// ROAD EXCLUSION ZONES (applied LAST - overrides everything including lots)
// Line segments where K is forced to 0 (impassable).
// Each entry: { p1: {x, y}, p2: {x, y}, radius: number (meters) }
// ───────────────────────────────────────────────────────────────────────────────
const ROAD_EXCLUSION_ZONES = [
    {
        p1: { x: -746.4875169201009, y: -3595.809872749691 },
        p2: { x: -729.1409315876358, y: -3852.5393356701743 },
        radius: 45,
    },
];

// ───────────────────────────────────────────────────────────────────────────────
// SHARED FIELD ARRAYS
// ───────────────────────────────────────────────────────────────────────────────

const phi = new Float32Array(N2);

// DUAL POTENTIAL FIELDS (Routing Authority Invariant)
// phi_pharr: distance to PHARR sinks (cleared mass routes here)
// phi_lots: distance to lot sinks (restricted mass routes here)
const phi_pharr = new Float32Array(N2);   // Cleared → PHARR
const phi_lots = new Float32Array(N2);    // Restricted → lots

const Kxx = new Float32Array(N2);
const Kxy = new Float32Array(N2);
const Kyy = new Float32Array(N2);
const S = new Float32Array(N2);
const G = new Float32Array(N2);

// DUAL NEXT-HOP TABLES (class-conditioned routing)
// nextHop_pharr: next hop toward PHARR (for cleared mass)
// nextHop_lots: next hop toward lots (for restricted mass)
const nextHop_pharr = new Int32Array(N2);
const nextHop_lots = new Int32Array(N2);
const rhoNext_restricted = new Float32Array(N2);  // Scratch for graph flow
const rhoNext_cleared = new Float32Array(N2);     // Scratch for graph flow

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 4: SHADOW BUFFERS FOR ATOMIC ROUTING SWAP
// During phi rebuild, compute into shadow buffers. Old routing remains active.
// On completion, atomically copy shadow → main. No flow freeze during rebuild.
// ═══════════════════════════════════════════════════════════════════════════════
const _shadow_phi_pharr = new Float32Array(N2);
const _shadow_phi_lots = new Float32Array(N2);
const _shadow_nextHop_pharr = new Int32Array(N2);
const _shadow_nextHop_lots = new Int32Array(N2);
let _shadowRoadCellIndices = [];

// Direction tensor: accumulated tangent directions from road segments
// [[Tdxx, Tdxy], [Tdxy, Tdyy]] - principal axis gives road tangent
const Tdxx = new Float32Array(N2);  // tx*tx accumulated
const Tdxy = new Float32Array(N2);  // tx*ty accumulated
const Tdyy = new Float32Array(N2);  // ty*ty accumulated

// Pre-baked K tensors for baseline and interserrana
const K_baseline_xx = new Float32Array(N2);
const K_baseline_xy = new Float32Array(N2);
const K_baseline_yy = new Float32Array(N2);
const K_interserrana_xx = new Float32Array(N2);
const K_interserrana_xy = new Float32Array(N2);
const K_interserrana_yy = new Float32Array(N2);
let _kTensorsBaked = false;

// PHARR sink cells
let sinkCellIndices = [];
let gateCapKgPerHour = 0;

// Sparse iteration: road cells only (built by buildNextHop)
let roadCellIndices = [];
// Sparse iteration: source cells only (built by stampInjectionSources)
let sourceCellIndices = [];
// Sparse iteration: lot cells only (built by initLots)
let lotCellIndices = [];

// ───────────────────────────────────────────────────────────────────────────────
// LOT CAPACITY SYSTEM
// ───────────────────────────────────────────────────────────────────────────────

// Capacity knob: kg per square meter of lot area
let LOT_KG_PER_M2 = 1;  // Default: 1 kg/m² (adjustable via setLotCapacity)

// Per-lot data (indexed by lot index 0..N-1)
let lotCapacityKg = [];      // Max capacity of each lot in kg
let lotAreaM2 = [];          // Area of each lot in m²
let lotCellCount = [];       // Number of cells per lot

// Cell → lot mapping (for capacity enforcement)
let cellToLotIndex = new Int16Array(0);  // -1 = not a lot cell

// Lot → cells mapping (for fast per-lot mass computation)
let lotToCellIndices = [];   // lotToCellIndices[lotIdx] = array of cell indices

// LIVE lot mass - updated at start of each substep for O(1) acceptance checks
let lotMassKgLive = null;    // Float64Array, same length as lotCapacityKg

// LIVE remaining acceptance capacity (kg) per lot for the CURRENT substep.
// This fixes overflow-by-oversubscription: many upstream cells can try to enter
// the same lot in one substep. We must reserve capacity atomically as we accept.
let lotAcceptRemainingKgLive = null;  // Float64Array, same length as lotCapacityKg

// Diagnostics: per-physics-frame accounting for lot entry attempts.
// (Used to confirm / quantify oversubscription pressure.)
let lotEntryAttemptKgFrame = null;      // outflow that targeted a lot (kg)
let lotEntryDesiredKgFrame = null;      // after soft acceptance multiplier (kg)
let lotEntryAcceptedKgFrame = null;     // accepted into lots (kg)
let lotEntryRejectedKgFrame = null;     // rejected back to roads (kg)
let lotEntryCapShortfallKgFrame = null; // desired - remaining_at_time (kg, clipped >=0)
let _lotEntryDiagLastLogMs = 0;
const LOT_LOG_IDX_LIST = [61, 64, 62]; // Targeted lot instrumentation (narrow)
let _lotLogLastMs = Object.create(null);

// Lot gate thrash tracking
let _lotGateState = null;    // Uint8Array: 0=open, 1=closed
let _lotGateFlipCount = 0;
let _lotGateLastLog = 0;

// Lot utilization tracking (updated each physics frame)
let lotCurrentMassKg = [];    // Current restricted mass per lot
let lotIsFull = [];           // Boolean: is lot at capacity?
let _lastFullLotCount = 0;    // For detecting capacity state changes

// Capacity threshold: lots are "full" when utilization exceeds this
const LOT_CAPACITY_THRESHOLD = 0.90;  // 90% - lots excluded from sinks when nearly full

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 1: SOFT CAPACITY BIAS PARAMETERS
// Continuous utilization penalty applied during phi_lots Dijkstra edge relaxation.
// Lots compete EARLY based on fill fraction, before hard exclusion at 90%.
//
// RATIONALE: Previous values (ALPHA=3, BETA=2) were too weak to overcome
// geometric advantage of closest lots. Stronger values force φ_lots to explore
// farther sinks before near-full lots hit hard exclusion.
// ═══════════════════════════════════════════════════════════════════════════════
const SOFT_CAPACITY_ALPHA = 20.0;  // Penalty multiplier: higher = stronger aversion to full lots
const SOFT_CAPACITY_BETA = 2.0;    // Exponent: higher = penalty ramps up faster as lot fills

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 2: CREW CONVERSION THROUGHPUT CAP
// Limits how much restricted mass can actively convert per lot per tick.
// Models realistic crew processing rate. Excess mass queues, forming natural backlog.
//
// CANONICAL RULE (NON-NEGOTIABLE):
// All rates are defined in SIM time. dt is SIM seconds.
// No visual/real-time semantics belong in physics.
// SIM_TIME_SCALE is a viewer concern, not a dynamics concern.
// ═══════════════════════════════════════════════════════════════════════════════
const CREW_RATE_KG_PER_SIM_S = 2.6;  // kg per SIM second per lot (≈ 3t/real-s @ 1152x compression)

// Snapshot of full lot indices at rebuild trigger (not affected by conversion during rebuild)
let _fullLotsSnapshot = [];
let _lotDebugCounter = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// INDUSTRIAL PARK WAIT ZONES (local dwell for park-origin restricted mass)
// ═══════════════════════════════════════════════════════════════════════════════
// Parks act as "private waiting zones" for their own restricted outflow.
// This keeps park-origin restricted mass from routing to external lots.
//
// Key invariants:
// - Only restricted mass originating from industrial parks dwells in park wait zones
// - Corridor-origin restricted mass still routes to external lots (unchanged)
// - Park wait zones reuse rho_restricted_lot storage and FIFO conversion queue
// - Cleared mass from parks exits to roads normally (same as lot conversion)
// ═══════════════════════════════════════════════════════════════════════════════

// Per-park wait zone: list of cell indices where park trucks can dwell
// Built from industrialPark polygons during initLots
let _parkWaitZones = [];              // Array of { parkId, cells: number[], roadCells: number[] }
let _parkIdToWaitZoneIdx = new Map(); // parkId -> index into _parkWaitZones
let _sourceToWaitZoneIdx = new Map(); // source cell idx -> wait zone idx (for park sources only)

// Park wait zone scatter cursor (round-robin for visual spread)
let _parkWaitScatterCursor = null;    // Int32Array indexed by waitZoneIdx

/**
 * Build park wait zones from loaded lots.
 * Called during initLots after industrial park polygons are rasterized.
 */
function buildParkWaitZones() {
    _parkWaitZones = [];
    _parkIdToWaitZoneIdx.clear();

    if (!_loadedLots) return;

    // Find all industrial parks in loaded lots
    const industrialParks = _loadedLots.filter(lot => lot.layer === 'industrialParks');

    for (const park of industrialParks) {
        const parkId = park.id;
        const waitZoneIdx = _parkWaitZones.length;

        // Get all cells covered by this park's polygons (excluding lot cells; lots win)
        const parkCells = [];
        const roadAdjacentCells = [];
        let lotOverlap = 0;

        for (const poly of park.polygons) {
            if (poly.geometry !== 'Polygon' || !poly.fieldCoords) continue;

            // Get bounding box
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            for (const fc of poly.fieldCoords) {
                minX = Math.min(minX, fc.x);
                maxX = Math.max(maxX, fc.x);
                minY = Math.min(minY, fc.y);
                maxY = Math.max(maxY, fc.y);
            }

            // Clamp to field bounds
            minX = Math.max(0, Math.floor(minX));
            maxX = Math.min(N - 1, Math.ceil(maxX));
            minY = Math.max(0, Math.floor(minY));
            maxY = Math.min(N - 1, Math.ceil(maxY));

            // Test each cell center using point-in-polygon
            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const px = x + 0.5, py = y + 0.5;
                    if (pointInFieldPolygon(px, py, poly.fieldCoords)) {
                        const idx = y * N + x;
                        if (regionMap[idx] === REGION_LOT) {
                            lotOverlap++;
                            continue; // lot overwrites park here
                        }
                        parkCells.push(idx);

                        // Check if cell is adjacent to road (prefer these for waiting)
                        const neighbors = [idx - 1, idx + 1, idx - N, idx + N];
                        for (const ni of neighbors) {
                            if (ni >= 0 && ni < N2) {
                                const isRoad = Kxx[ni] > K_OFFROAD + 0.1 || Kyy[ni] > K_OFFROAD + 0.1;
                                const notLot = regionMap[ni] !== REGION_LOT;
                                if (isRoad && notLot) {
                                    roadAdjacentCells.push(idx);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (parkCells.length === 0) {
            if (lotOverlap > 0) {
                console.warn(`[PARK-WAIT] Park ${parkId} fully overlapped by lots (${lotOverlap} cells)`);
            }
            continue;
        }

        _parkWaitZones.push({
            parkId: parkId,
            cells: parkCells,
            roadCells: roadAdjacentCells.length > 0 ? roadAdjacentCells : parkCells,
        });
        _parkIdToWaitZoneIdx.set(parkId, waitZoneIdx);
    }

    // Initialize scatter cursors
    _parkWaitScatterCursor = new Int32Array(_parkWaitZones.length);

    console.log(`[PARK-WAIT] Built ${_parkWaitZones.length} park wait zones`);
    for (const zone of _parkWaitZones) {
        console.log(`  ${zone.parkId}: ${zone.cells.length} cells, ${zone.roadCells.length} road-adjacent`);
    }
}

/**
 * Point-in-polygon test for field coordinates.
 */
function pointInFieldPolygon(px, py, fieldCoords) {
    let inside = false;
    for (let i = 0, j = fieldCoords.length - 1; i < fieldCoords.length; j = i++) {
        const xi = fieldCoords[i].x, yi = fieldCoords[i].y;
        const xj = fieldCoords[j].x, yj = fieldCoords[j].y;
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * Deposit restricted mass into a park wait zone (spreads across park cells).
 * Uses rho_restricted_lot for storage (same as lots).
 */
function depositToParkWaitZone(waitZoneIdx, kg) {
    if (waitZoneIdx < 0 || waitZoneIdx >= _parkWaitZones.length) {
        throw new Error(`[INVARIANT] depositToParkWaitZone invalid zone=${waitZoneIdx}`);
    }
    if (kg <= 0) return;

    const zone = _parkWaitZones[waitZoneIdx];
    const cells = zone.roadCells;  // Prefer road-adjacent cells
    if (!cells || cells.length === 0) {
        throw new Error(`[INVARIANT] depositToParkWaitZone has no roadCells (zone=${waitZoneIdx}) kg=${kg}`);
    }

    // Spread mass across cells round-robin for visual distribution
    const cursor = _parkWaitScatterCursor[waitZoneIdx];
    const cellsToUse = Math.min(8, cells.length);  // Cap work per deposit
    const kgPerCell = kg / cellsToUse;

    for (let i = 0; i < cellsToUse; i++) {
        const cellIdx = cells[(cursor + i) % cells.length];
        if (regionMap[cellIdx] === REGION_LOT) {
            throw new Error(`[INVARIANT] depositToParkWaitZone targeted lot cell ${cellIdx} zone=${waitZoneIdx}`);
        }
        rho_park_wait[cellIdx] += kgPerCell;
    }

    _parkWaitScatterCursor[waitZoneIdx] = (cursor + cellsToUse) % cells.length;
}

/**
 * Get a cell from park wait zone for particle placement (visual spread).
 */
function getParkWaitCell(waitZoneIdx) {
    if (waitZoneIdx < 0 || waitZoneIdx >= _parkWaitZones.length) return -1;

    const zone = _parkWaitZones[waitZoneIdx];
    const cells = zone.roadCells;
    if (cells.length === 0) return -1;

    const cursor = _parkWaitScatterCursor[waitZoneIdx];
    const cellIdx = cells[cursor % cells.length];
    _parkWaitScatterCursor[waitZoneIdx] = (cursor + 1) % cells.length;

    return cellIdx;
}

/**
 * Find the nearest road cell adjacent to a park (for cleared truck exit).
 */
function findNearestRoadFromPark(parkCellIdx) {
    const x = parkCellIdx % N;
    const y = Math.floor(parkCellIdx / N);

    // Check immediate neighbors first
    const neighbors = [parkCellIdx - 1, parkCellIdx + 1, parkCellIdx - N, parkCellIdx + N];
    for (const ni of neighbors) {
        if (ni >= 0 && ni < N2) {
            const isRoad = Kxx[ni] > K_OFFROAD + 0.1 || Kyy[ni] > K_OFFROAD + 0.1;
            const notLot = regionMap[ni] !== REGION_LOT;
            if (isRoad && notLot) return ni;
        }
    }

    // BFS for nearest road
    const visited = new Set([parkCellIdx]);
    let frontier = [parkCellIdx];

    for (let radius = 0; radius < 20 && frontier.length > 0; radius++) {
        const nextFrontier = [];
        for (const idx of frontier) {
            const cx = idx % N, cy = Math.floor(idx / N);
            const adj = [idx - 1, idx + 1, idx - N, idx + N];
            for (const ni of adj) {
                if (ni < 0 || ni >= N2 || visited.has(ni)) continue;
                visited.add(ni);

                const isRoad = Kxx[ni] > K_OFFROAD + 0.1 || Kyy[ni] > K_OFFROAD + 0.1;
                const notLot = regionMap[ni] !== REGION_LOT;
                if (isRoad && notLot) return ni;

                nextFrontier.push(ni);
            }
        }
        frontier = nextFrontier;
    }

    return parkCellIdx;  // Fallback: return original cell
}

/**
 * Compute current mass per lot from rho_restricted.
 * Updates lotCurrentMassKg[] and lotIsFull[].
 * Returns true if any lot's "full" status changed.
 */
function updateLotUtilization() {
    if (lotCapacityKg.length === 0) return false;

    // Reset current mass
    if (lotCurrentMassKg.length !== lotCapacityKg.length) {
        lotCurrentMassKg = new Array(lotCapacityKg.length).fill(0);
        lotIsFull = new Array(lotCapacityKg.length).fill(false);
    } else {
        lotCurrentMassKg.fill(0);
    }

    // Sum mass per lot (restricted-in-lots only — cleared mass is exit-bound and not occupancy)
    for (const cellIdx of lotCellIndices) {
        const lotIdx = cellToLotIndex[cellIdx];
        if (lotIdx >= 0 && lotIdx < lotCurrentMassKg.length) {
            lotCurrentMassKg[lotIdx] += rho_restricted_lot[cellIdx];
        }
    }

    // Check capacity and detect changes
    let fullCount = 0;
    let changed = false;
    const FULL_EPS = 1e-6;
    for (let i = 0; i < lotCapacityKg.length; i++) {
        const utilization = lotCurrentMassKg[i] / lotCapacityKg[i];
        const wasFull = lotIsFull[i];
        // Treat lots at (or extremely close to) the threshold as full.
        // This avoids “stuck at 89.999%” rounding that prevents reroute/exclusion.
        const nowFull = utilization >= (LOT_CAPACITY_THRESHOLD - FULL_EPS);
        lotIsFull[i] = nowFull;
        if (nowFull) fullCount++;
        if (wasFull !== nowFull) changed = true;
    }

    // If full lot count changed, trigger phi rebuild
    if (fullCount !== _lastFullLotCount) {
        _lastFullLotCount = fullCount;
        return true;
    }

    // Periodic debug: log lot distribution every 300 frames (~5s)
    if (_lotDebugCounter++ % 300 === 0) {
        const activeCount = lotCurrentMassKg.filter(m => m > 0).length;
        const totalMass = lotCurrentMassKg.reduce((a, b) => a + b, 0);
        const topUtil = Math.max(...lotCapacityKg.map((cap, i) => lotCurrentMassKg[i] / cap));
        console.log(`[LOTS-DEBUG] ${activeCount}/${lotCapacityKg.length} active, full=${fullCount}, totalMass=${(totalMass/1000).toFixed(1)}t, topUtil=${(topUtil*100).toFixed(0)}%`);
    }

    return changed;
}

/**
 * Rebuild LIVE lot mass from current rho arrays.
 * Called at start of each substep for O(1) acceptance checks.
 */
function rebuildLotMassLiveFromRho() {
    if (!lotCapacityKg.length) return;
    if (!lotMassKgLive || lotMassKgLive.length !== lotCapacityKg.length) {
        lotMassKgLive = new Float64Array(lotCapacityKg.length);
        lotAcceptRemainingKgLive = new Float64Array(lotCapacityKg.length);
    } else {
        lotMassKgLive.fill(0);
        if (!lotAcceptRemainingKgLive || lotAcceptRemainingKgLive.length !== lotCapacityKg.length) {
            lotAcceptRemainingKgLive = new Float64Array(lotCapacityKg.length);
        } else {
            lotAcceptRemainingKgLive.fill(0);
        }
    }

    for (let lotIdx = 0; lotIdx < lotToCellIndices.length; lotIdx++) {
        const cells = lotToCellIndices[lotIdx];
        if (!cells) continue;
        let sum = 0;
        for (const idx of cells) {
            sum += rho_restricted_lot[idx];
        }
        lotMassKgLive[lotIdx] = sum;

        // Remaining acceptance capacity for THIS substep, capped at threshold fraction.
        const cap = lotCapacityKg[lotIdx] || 0;
        const hardLimit = cap * LOT_CAPACITY_THRESHOLD;
        lotAcceptRemainingKgLive[lotIdx] = Math.max(0, hardLimit - sum);
    }
}

/**
 * Find the nearest road cell adjacent to a lot cell (for cleared exit).
 */
function findNearestRoadFromLot(lotCellIdx) {
    const x = lotCellIdx % N;
    const y = Math.floor(lotCellIdx / N);

    const neighbors = [lotCellIdx - 1, lotCellIdx + 1, lotCellIdx - N, lotCellIdx + N];
    for (const ni of neighbors) {
        if (ni >= 0 && ni < N2) {
            const isRoad = Kxx[ni] > K_OFFROAD + 0.1 || Kyy[ni] > K_OFFROAD + 0.1;
            const notLot = regionMap[ni] !== REGION_LOT;
            if (isRoad && notLot) return ni;
        }
    }

    // Fallback: use routing if available
    const nh = (nextHop_pharr && nextHop_pharr.length > lotCellIdx) ? nextHop_pharr[lotCellIdx] : -1;
    if (nh >= 0 && nh < N2 && regionMap[nh] !== REGION_LOT) return nh;

    return -1;
}

/**
 * Log lot gate thrashing (state flips between open/closed).
 * Called once per substep to track oscillation.
 */
function logLotGateThrash() {
    if (!lotCapacityKg.length || !lotMassKgLive) return;
    if (!_lotGateState || _lotGateState.length !== lotCapacityKg.length) {
        _lotGateState = new Uint8Array(lotCapacityKg.length);
    }

    for (let i = 0; i < lotCapacityKg.length; i++) {
        const cap = lotCapacityKg[i];
        if (cap <= 0) continue;
        const closed = (lotMassKgLive[i] / cap) >= LOT_CAPACITY_THRESHOLD ? 1 : 0;
        if (closed !== _lotGateState[i]) {
            _lotGateState[i] = closed;
            _lotGateFlipCount++;
        }
    }

    const now = performance.now();
    if (now - _lotGateLastLog > 2000) {
        _lotGateLastLog = now;
        const fullCount = _lotGateState.reduce((a, b) => a + b, 0);
        console.log(`[LOT-THRASH] flips=${_lotGateFlipCount} closed=${fullCount}/${_lotGateState.length}`);
        _lotGateFlipCount = 0;
    }
}

/**
 * Get lot cell indices excluding lots that are at capacity.
 * Used as sink set for phi_lots computation.
 */
function getAvailableLotCells() {
    if (_fullLotsSnapshot.length === 0) {
        console.log(`[getAvailableLotCells] No lots in snapshot - returning all ${lotCellIndices.length} cells`);
        return lotCellIndices;  // No lots excluded
    }

    // Use snapshot taken at rebuild trigger (not live lotIsFull which changes during rebuild)
    const fullSet = new Set(_fullLotsSnapshot);
    const available = [];
    let excludedCells = 0;
    for (const cellIdx of lotCellIndices) {
        const lotIdx = cellToLotIndex[cellIdx];
        if (lotIdx < 0 || !fullSet.has(lotIdx)) {
            available.push(cellIdx);
        } else {
            excludedCells++;
        }
    }

    // Log exclusion stats
    console.log(`[getAvailableLotCells] snapshot=${_fullLotsSnapshot.length} full lots [${_fullLotsSnapshot.slice(0,5).join(',')}${_fullLotsSnapshot.length > 5 ? '...' : ''}], excluding ${excludedCells}/${lotCellIndices.length} cells`);

    return available;
}

/**
 * Get acceptance multiplier for a lot cell (hard + soft capacity model).
 * Used for flow gating: rejected mass stays upstream on roads.
 * @param {number} cellIdx - Cell index
 * @returns {number} Acceptance in [0, 1], where 0 = lot full, 1 = lot empty
 */
let _lotRejectLogTime = 0;  // Throttle REJECT logs

function getLotAcceptance(cellIdx) {
    if (!lotCapacityKg.length) return 1.0;  // No capacity tracking
    const lotIdx = cellToLotIndex[cellIdx];
    if (lotIdx < 0) return 1.0;  // Not a lot cell

    const cap = lotCapacityKg[lotIdx];
    if (cap <= 0) return 1.0;  // No capacity defined

    // O(1) lookup from LIVE lot mass (updated at start of each substep)
    const fill = (lotMassKgLive && lotMassKgLive.length === lotCapacityKg.length)
        ? (lotMassKgLive[lotIdx] / cap)
        : (lotCurrentMassKg[lotIdx] / cap);  // fallback only

    // HARD CLAMP: At or above threshold, reject ALL new mass immediately
    const FULL_EPS = 1e-6;
    if (fill >= (LOT_CAPACITY_THRESHOLD - FULL_EPS)) {
        // DIAGNOSTIC: Log rejection (throttled to ~1/sec)
        const now = performance.now();
        if (now - _lotRejectLogTime > 1000) {
            console.log(`[LOT-GATE] REJECT lot#${lotIdx} util=${(fill*100).toFixed(1)}%`);
            _lotRejectLogTime = now;
        }
        return 0.0;
    }

    return Math.max(0, 1 - fill);  // Soft capacity below threshold: linear acceptance decay
}

/**
 * Set lot capacity parameter (kg per m²).
 * Changes which lots are "full" and excluded from phi_lots sinks.
 */
export function setLotCapacity(kgPerM2) {
    LOT_KG_PER_M2 = kgPerM2;
    // Snapshot current occupancy before changing capacity to enforce invariant A.
    // This is intentionally local and does not mutate rho arrays.
    updateLotUtilization();

    const clampedLots = [];
    const devAssert = (typeof process !== 'undefined' && process?.env?.NODE_ENV !== 'production');

    // Recalculate capacities with non-decreasing rule relative to current mass
    for (let i = 0; i < lotAreaM2.length; i++) {
        const desiredCap = lotAreaM2[i] * LOT_KG_PER_M2;
        const currentMass = lotCurrentMassKg[i] || 0;
        const enforcedCap = Math.max(desiredCap, currentMass);

        if (enforcedCap !== desiredCap) clampedLots.push(i);
        lotCapacityKg[i] = enforcedCap;

        // Dev-only assertion: capacity must never fall below present mass.
        if (devAssert) {
            console.assert(
                lotCapacityKg[i] + 1e-6 >= currentMass,
                `[LOTS] Invariant A violated for lot ${i}: cap=${lotCapacityKg[i]}, mass=${currentMass}`
            );
        }
    }

    // Minimal runtime proof that utilization cannot exceed 100% after this call.
    if (clampedLots.length > 0) {
        console.warn(
            `[LOTS] Capacity clamped to current mass for lots: ${clampedLots.slice(0, 10).join(',')}` +
            `${clampedLots.length > 10 ? '...' : ''}`
        );
    }
    const maxUtil = lotCapacityKg.length > 0
        ? Math.max(...lotCapacityKg.map((cap, idx) => cap > 0 ? (lotCurrentMassKg[idx] || 0) / cap : 0))
        : 0;
    console.log(
        `[LOTS] Capacity updated: ${kgPerM2} kg/m² (max utilization now ${(maxUtil * 100).toFixed(1)}%) - triggering phi rebuild`
    );
    phiBaseDirty = true;
}

export function getLotCapacity() {
    return LOT_KG_PER_M2;
}

export function getLotStats() {
    return {
        count: lotCapacityKg.length,
        kgPerM2: LOT_KG_PER_M2,
        fullCount: lotIsFull.filter(f => f).length,
        lots: lotCapacityKg.map((cap, i) => ({
            index: i,
            name: _loadedLots?.[i]?.name || `lot_${i}`,
            cells: lotCellCount[i],
            areaM2: lotAreaM2[i],
            capacityKg: cap,
            currentKg: lotCurrentMassKg[i] || 0,
            utilization: cap > 0 ? (lotCurrentMassKg[i] || 0) / cap : 0,
            isFull: lotIsFull[i] || false,
        })),
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// SOURCE RELOCATION (prevents injection inside lot capture basins)
// ───────────────────────────────────────────────────────────────────────────────

// Minimum phi_lots distance from lot sinks before injection is allowed
// Lots have phi_lots=0 at sinks; this threshold ensures sources are far enough
// that phi_lots routing can distribute mass across multiple lots.
const LOT_CAPTURE_RADIUS_PHI = 5000;  // ~5km in phi units (edgeCost ~44m)

/**
 * Relocate a source cell if it's inside or too close to a lot.
 * Walks upstream via nextHop_pharr until finding a safe injection point.
 *
 * CRITICAL: UNREACH is not a reason to give up - it's a reason to MOVE.
 * If source is unreachable to lots, walk upstream until it becomes reachable,
 * then continue until outside the capture radius.
 *
 * @param {number} srcIdx - Original source cell index
 * @returns {number} - Relocated source index (or original if relocation fails)
 */
function relocateRestrictedSource(srcIdx) {
    // Guard: if routing not yet built, can't relocate
    if (!_nextHopBuilt) return srcIdx;

    let idx = srcIdx;

    // Phase 1: If source is unreachable-to-lots (phi_lots >= PHI_LARGE),
    // walk upstream via PHARR routing until we enter the lot-reachable zone
    if (phi_lots[idx] >= PHI_LARGE) {
        for (let i = 0; i < 400; i++) {
            const nh = nextHop_pharr[idx];
            if (nh < 0) break;  // Dead end or sink
            idx = nh;
            if (phi_lots[idx] < PHI_LARGE) break;  // Now in lot-reachable zone
        }
    }

    // Phase 2: Check if current position is safe (outside lot region AND beyond capture radius)
    if (phi_lots[idx] < PHI_LARGE &&
        phi_lots[idx] >= LOT_CAPTURE_RADIUS_PHI &&
        regionMap[idx] !== REGION_LOT) {
        if (idx !== srcIdx) {
            console.log(`[RELOCATE] Moved source from ${srcIdx} to ${idx} (phi_lots: ${phi_lots[srcIdx]?.toFixed(0) || 'UNREACH'} -> ${phi_lots[idx].toFixed(0)})`);
        }
        return idx;
    }

    // Phase 3: Keep walking upstream until we find a safe position
    for (let i = 0; i < 400; i++) {
        const nh = nextHop_pharr[idx];
        if (nh < 0) break;  // Dead end or sink
        idx = nh;

        if (phi_lots[idx] < PHI_LARGE &&
            phi_lots[idx] >= LOT_CAPTURE_RADIUS_PHI &&
            regionMap[idx] !== REGION_LOT) {
            console.log(`[RELOCATE] Moved source from ${srcIdx} to ${idx} (phi_lots: ${phi_lots[srcIdx]?.toFixed(0) || 'UNREACH'} -> ${phi_lots[idx].toFixed(0)})`);
            return idx;
        }
    }

    // Fallback: return original if no safe cell found
    throw new Error(`[INVARIANT] Source relocation failed for ${srcIdx} (isLot=${regionMap[srcIdx] === REGION_LOT}, phi_lots=${phi_lots[srcIdx] < PHI_LARGE ? phi_lots[srcIdx].toFixed(0) : 'UNREACH'})`);
}

// ───────────────────────────────────────────────────────────────────────────────
// METRICS
// ───────────────────────────────────────────────────────────────────────────────

const metrics = {
    // Cumulative
    injectedTotal: 0,
    drainedTotal: 0,
    convertedTotal: 0,
    // Per-tick
    injectedThisTick: 0,
    drainedThisTick: 0,
    convertedThisTick: 0,
    // Current state
    total: 0,
    restricted: 0,
    cleared: 0,
    backlog_near_pharr: 0,
    // Derived (EMA smoothed)
    throughput_kg_per_hr: 0,
    inflow_kg_per_hr: 0,
    conversion_kg_per_hr: 0,
    spillback_extent_m: 0,
};

const EMA_ALPHA = 0.1;

// Field→Particle coupling (visualization only):
// number of 9000kg truck quanta cleared by GLOBAL clearing this tick.
let _clearedTrucksThisTick = 0;

// Local scenario toggles
let localScenario = {
    ...LocalScenarioDefaults,
    renderMode: RENDER_MODE.BOTH,  // Was HEATMAP - particles need to render
    particleConfig: { ...PARTICLE_DEFAULTS },
    particleZoomFloor: PARTICLE_Z_FLOOR_DEFAULT,
};

// Alpha-driven geometry tracking
let _lastGeometryHash = null;
const _alphaGeomThreshold = 0.1;

// Yard configuration
let _yardEnabled = false;
let _yardConfig = {
    centerX: 0,
    centerY: 0,
    radiusM: 500,
};

// ───────────────────────────────────────────────────────────────────────────────
// COORDINATE TRANSFORMS
// ───────────────────────────────────────────────────────────────────────────────

function worldToFieldX(wx) {
    return ((wx - roi.centerX) / roi.sizeM + 0.5) * N;
}

function worldToFieldY(wy) {
    return ((wy - roi.centerY) / roi.sizeM + 0.5) * N;
}

function fieldToWorldX(fx) {
    return roi.centerX + (fx / N - 0.5) * roi.sizeM;
}

function fieldToWorldY(fy) {
    return roi.centerY + (fy / N - 0.5) * roi.sizeM;
}

function clampField(v) {
    return Math.max(0, Math.min(N - 1.001, v));
}

// ───────────────────────────────────────────────────────────────────────────────
// LIFECYCLE: onAttach
// ───────────────────────────────────────────────────────────────────────────────

export function onAttach(context) {
    rendererContext = context;

    const pharr = context.geometry.poePoints.PHARR;
    if (!pharr) {
        console.error('[ReynosaOverlay] PHARR POE not found in geometry');
        return;
    }

    // Set ROI center south of PHARR
    roi.centerX = pharr.x;
    roi.centerY = pharr.y + REYNOSA_ACTIVATION.CENTER_OFFSET_Y;
    roi.cellSize = roi.sizeM / N;

    // Reset all field state
    resetFields();

    // Unified adapter created after phi rebuild (when routing tables are ready)
    // See: createUnifiedAdapterIfReady() called from rebuildPhiBase completion
    particleLayer = null;

    // Bake static geometry
    bakeKTensor(context.geometry);
    stampPharrSink(pharr);

    // Load lots (async - will stamp when complete)
    initLots().catch(err => {
        console.error('[ReynosaOverlay] Failed to load lots:', err);
    });

    // Initialize geometry hash for alpha-driven mode
    if (hasScenarioPair()) {
        const alpha = getCurrentAlpha();
        const segments = getVisibleSegments(alpha, _alphaGeomThreshold);
        _lastGeometryHash = computeGeometryHash(segments);
    } else {
        _lastGeometryHash = null;
    }

    console.log('[ReynosaOverlay] Attached with multi-class system. ROI center:', roi.centerX, roi.centerY);
}

// ───────────────────────────────────────────────────────────────────────────────
// LIFECYCLE: onDetach
// ───────────────────────────────────────────────────────────────────────────────

export function onDetach() {
    state = OverlayState.OFF;
    rendererContext = null;
    _lastGeometryHash = null;
    _kTensorsBaked = false;
    _yardEnabled = false;
    _lotsLoaded = false;
    _loadedLots = null;
    _loadedLayers = null;
    lotCellIndices = [];

    // Reset park wait zone data
    _parkWaitZones = [];
    _parkIdToWaitZoneIdx.clear();
    _sourceToWaitZoneIdx.clear();
    _parkWaitScatterCursor = null;
    _parkLocalDwellKg = 0;

    particleLayer?.reset();
    particleLayer = null;
    _unifiedAdapterInitialized = false;
    _particleDebugColors = false;
    resetAlpha();
    clearWeightMaps();
    console.log('[ReynosaOverlay] Detached');
}

// ───────────────────────────────────────────────────────────────────────────────
// LIFECYCLE: onFrame
// ───────────────────────────────────────────────────────────────────────────────

let _frameDebugCounter = 0;
let _lastFrameTime = 0;

// ───────────────────────────────────────────────────────────────────────────────
// DEBUG / INSTRUMENTATION (log-only, throttled)
// Goal: diagnose "particles stuck at injection" by separating:
// - φ rebuild skip-time (particle timers not advancing)
// - near-source density/congestion suppression
// - per-particle stall modes (preDelay vs stuck vs waiting)
// ───────────────────────────────────────────────────────────────────────────────

const _DBG_PROBE_ENABLED = true;
const _DBG_PROBE_INTERVAL_MS = 2000;
const _DBG_PROBE_RADIUS_CELLS = 2; // radius in grid cells around entry/source

let _dbgLastProbeLogMs = 0;
let _dbgLastExternalSimTimeSeconds = null;
let _dbgRebuildSkipFrames = 0;
let _dbgRebuildSkippedSimSeconds = 0;
let _dbgLastRebuildSkipLogMs = 0;

function _dbgGetProbePoints() {
    // Probe both the configured corridor entries AND the actual active source cells.
    // Sources may be relocated (relocateRestrictedSource), so both are useful.
    const points = [];

    if (corridorEntryPoints && corridorEntryPoints.length > 0) {
        for (const e of corridorEntryPoints) {
            const idx = e.fieldY * N + e.fieldX;
            if (idx >= 0 && idx < N2) {
                points.push({ label: e.segmentId || 'ENTRY', idx });
            }
        }
    }

    if (sourceCellIndices && sourceCellIndices.length > 0) {
        // Add up to first 4 sources (usually 2) to avoid noise.
        for (let i = 0; i < Math.min(4, sourceCellIndices.length); i++) {
            const idx = sourceCellIndices[i];
            if (idx >= 0 && idx < N2) {
                points.push({ label: `SRC_${i}`, idx });
            }
        }
    }

    // De-dupe by idx
    const seen = new Set();
    const out = [];
    for (const p of points) {
        if (seen.has(p.idx)) continue;
        seen.add(p.idx);
        out.push(p);
    }
    return out;
}

function _dbgLogSourceProbe(externalSimTimeSeconds, simDeltaSeconds, contextLabel = '') {
    if (!_DBG_PROBE_ENABLED) return;
    if (!particleLayer?.getParticles) return;
    if (!roi || !Number.isFinite(roi.cellSize)) return;

    const now = performance.now();
    if (now - _dbgLastProbeLogMs < _DBG_PROBE_INTERVAL_MS) return;
    _dbgLastProbeLogMs = now;

    const particles = particleLayer?.getParticlesForRender?.() || [];
    const points = _dbgGetProbePoints();
    if (points.length === 0) return;

    const header = [
        `[SRC-PROBE] ${contextLabel}`.trim(),
        `extSim=${Number.isFinite(externalSimTimeSeconds) ? externalSimTimeSeconds.toFixed(0) : 'n/a'}s`,
        `intSim=${Number.isFinite(_simTimeSeconds) ? _simTimeSeconds.toFixed(0) : 'n/a'}s`,
        `dt=${Number.isFinite(simDeltaSeconds) ? simDeltaSeconds.toFixed(1) : 'n/a'}s`,
        `alive=${particles.length}`,
        `preLot(totalKg=${_preLotLiveTotalKg.toFixed(1)} cells=${_preLotLiveKgByCell.size})`,
        `rebuildSkip(frames=${_dbgRebuildSkipFrames}, simS=${_dbgRebuildSkippedSimSeconds.toFixed(1)})`,
    ].join(' ');
    console.log(header);

    for (const pt of points) {
        const idx0 = pt.idx;
        const x0 = idx0 % N;
        const y0 = (idx0 / N) | 0;

        // Field conditions at probe cell
        const rhoHere = (rho_restricted[idx0] || 0) + (rho_cleared[idx0] || 0);
        const cong = (typeof roadCongestionFactor === 'function') ? roadCongestionFactor(idx0) : 1.0;
        const nhPharr = nextHop_pharr[idx0];
        const nhLots = nextHop_lots[idx0];
        const phiP = phi_pharr[idx0];
        const phiL = phi_lots[idx0];

        // Particle census near probe cell
        let near = 0;
        let cleared = 0;
        let restricted = 0;
        let preLot = 0;
        let waiting = 0;
        let stuck = 0;
        let moving = 0;
        let stalled = 0;

        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            const fx = worldToFieldX(p.x);
            const fy = worldToFieldY(p.y);
            const cx = Math.floor(fx);
            const cy = Math.floor(fy);
            if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;
            const dx = Math.abs(cx - x0);
            const dy = Math.abs(cy - y0);
            if (dx > _DBG_PROBE_RADIUS_CELLS || dy > _DBG_PROBE_RADIUS_CELLS) continue;

            near++;

            const pClass = p.classId || 'cleared';
            const movedDist = Math.hypot((p.x ?? 0) - (p.px ?? p.x ?? 0), (p.y ?? 0) - (p.py ?? p.y ?? 0));
            const didMove = movedDist > 1e-6;

            if (didMove) moving++;
            else stalled++;

            if (pClass === 'cleared') {
                cleared++;
                continue;
            }

            // restricted
            restricted++;
            if (p.waitingInLot) {
                waiting++;
                continue;
            }
            if (p.preLotStalled) {
                preLot++;
                continue;
            }
            if (p.stuck) {
                stuck++;
                continue;
            }
        }
        const preKg = rho_restricted_preLot[idx0] || 0;
        const mobKg = rho_restricted[idx0] || 0;
        const preFrac = (preKg + mobKg) > 1e-6 ? (preKg / (preKg + mobKg)) : 0;

        console.log(
            `[SRC-PROBE] ${pt.label} cell=(${x0},${y0}) idx=${idx0} ` +
            `rho=${rhoHere.toFixed(1)}kg cong=${cong.toFixed(3)} preLotKg=${preKg.toFixed(1)} preLotFrac=${preFrac.toFixed(3)} ` +
            `nhP=${nhPharr} nhL=${nhLots} ` +
            `phiP=${phiP < PHI_LARGE ? phiP.toFixed(0) : 'UNREACH'} phiL=${phiL < PHI_LARGE ? phiL.toFixed(0) : 'UNREACH'}`
        );
        console.log(
            `[SRC-PROBE] ${pt.label} near=${near} ` +
            `cleared=${cleared} restricted=${restricted} ` +
            `restricted(preLot=${preLot} waiting=${waiting} stuck=${stuck}) ` +
            `move(moving=${moving} stalled=${stalled})`
        );
    }
}

/**
 * onFrame - Main update function called each rendered frame
 *
 * TIME AUTHORITY:
 * - realDeltaSeconds: Wall-clock time since last frame (from requestAnimationFrame)
 * - simDeltaSeconds: realDeltaSeconds * SIM_TIME_SCALE (the true time quantum per frame)
 * - Physics receives simDeltaSeconds directly - one honest pass per frame
 * - FPS affects smoothness, not how much time passes
 *
 * @param {object} camera - Camera object with worldToScreen, zoom, etc.
 * @param {object} time - Time object with simTimeSeconds, currentHour
 * @param {number} realDeltaSeconds - Wall-clock delta in seconds (from frame loop)
 */
export function onFrame(camera, time, realDeltaSeconds = 1/60) {
    const newState = computeActivationState(camera);

    // Debug: log activation check periodically
    if (_frameDebugCounter++ % 60 === 0) {
        console.log('[ReynosaOverlay.onFrame] newState:', newState, 'camera.zoom:', camera.zoom, 'center:', camera.centerWorld);
    }

    if (newState === OverlayState.OFF) {
        state = OverlayState.OFF;
        return;
    }

    state = newState;

    // CRITICAL: Skip ALL heavy processing during phi rebuild
    // This gives the async Dijkstra CPU time to complete
    // Without this, the 60fps frame loop starves the Dijkstra yields
    if (_phiRebuildInProgress) {
        // Instrumentation: account for skipped external sim-time while rebuild runs.
        const ext = time?.simTimeSeconds;
        if (Number.isFinite(ext) && Number.isFinite(_dbgLastExternalSimTimeSeconds)) {
            const d = ext - _dbgLastExternalSimTimeSeconds;
            if (d > 0) _dbgRebuildSkippedSimSeconds += d;
        }
        if (Number.isFinite(ext)) _dbgLastExternalSimTimeSeconds = ext;
        _dbgRebuildSkipFrames++;

        // Throttled rebuild skip log
        const now = performance.now();
        if (_DBG_PROBE_ENABLED && (now - _dbgLastRebuildSkipLogMs) > _DBG_PROBE_INTERVAL_MS) {
            _dbgLastRebuildSkipLogMs = now;
            console.log(
                `[REBUILD-SKIP] frames=${_dbgRebuildSkipFrames} skippedSimS=${_dbgRebuildSkippedSimSeconds.toFixed(1)} ` +
                `extSim=${Number.isFinite(ext) ? ext.toFixed(0) : 'n/a'} intSim=${Number.isFinite(_simTimeSeconds) ? _simTimeSeconds.toFixed(0) : 'n/a'}`
            );
            // Also run the source probe (will reflect particles frozen-in-place during rebuild)
            _dbgLogSourceProbe(ext, NaN, 'during_phi_rebuild');
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SIMULATION TIME AUTHORITY
    // Each frame advances by exactly simDeltaSeconds. FPS affects smoothness,
    // not how much time passes. Physics runs once per frame with the true dt.
    // ═══════════════════════════════════════════════════════════════════════════

    // Convert real time to simulation time
    // realDeltaSeconds * SIM_TIME_SCALE * speedMultiplier = sim seconds elapsed this frame
    // If paused, simDeltaSeconds = 0 (physics freezes, render continues)
    let simDeltaSeconds = _simPaused ? 0 : realDeltaSeconds * SIM_TIME_SCALE * _simSpeedMultiplier;

    // Cap dt to prevent runaway accumulation during blocking operations (Dijkstra rebuilds)
    // Without this, a 700ms frame at 60x speed becomes 15000+ sim-seconds of mass injection
    if (simDeltaSeconds > 120) {
        console.warn(`[TIME] Capping extreme dt: ${simDeltaSeconds.toFixed(1)}s → 120s`);
        simDeltaSeconds = 120;
    }
    if (!_simPaused) {
        _simTimeSeconds = time?.simTimeSeconds ?? _simTimeSeconds;
    }
    if (Number.isFinite(time?.simTimeSeconds)) _dbgLastExternalSimTimeSeconds = time.simTimeSeconds;

    // Alpha-driven scenario interpolation (once per frame)
    if (hasScenarioPair() && _kTensorsBaked) {
        const prevAlpha = getCurrentAlpha();
        const alpha = computeAlpha(time.simTimeHours);

        if (hasGeometryChanged(prevAlpha, alpha, _alphaGeomThreshold)) {
            const baselineCtx = createInterpolatedRendererContext(_alphaGeomThreshold);
            const interserranaCtx = createInterpolatedRendererContext(_alphaGeomThreshold);

            bakeKTensorWeighted(
                baselineCtx.geometry,
                K_baseline_xx, K_baseline_xy, K_baseline_yy,
                getBaselineWeight
            );
            bakeKTensorWeighted(
                interserranaCtx.geometry,
                K_interserrana_xx, K_interserrana_xy, K_interserrana_yy,
                getInterserranaWeight
            );

            _lastGeometryHash = computeGeometryHash(
                getVisibleSegments(alpha, _alphaGeomThreshold)
            );
            console.log('[ReynosaOverlay] K tensors re-baked at alpha=' + alpha.toFixed(3));

            interpolateKTensor(alpha);
            phiBaseDirty = true;
        } else {
            interpolateKTensor(alpha);
        }
    }

    // Load hourly schedules
    const hour = time.currentHour;
    loadHourlyInflow(hour);
    loadGateCapacity(hour);

    // Physics update: one honest pass with the true dt
    updateMultiClassPhysics(simDeltaSeconds);

    // Update metrics (once per frame)
    updateMetrics(simDeltaSeconds);

    // Particle emission: based on simDeltaSeconds (matches physics)
    emitParticlesForPhysicsTime(simDeltaSeconds);

    // ═══════════════════════════════════════════════════════════════════════════
    // TIME AUTHORITY DIAGNOSTICS (every 60 frames)
    // ═══════════════════════════════════════════════════════════════════════════
    if (_frameDebugCounter % 60 === 0) {
        console.log(`[TIME] realDt=${(realDeltaSeconds*1000).toFixed(1)}ms simDt=${simDeltaSeconds.toFixed(1)}s hour=${time.currentHour} simTime=${time.simTimeSeconds.toFixed(0)}s`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // UNIFIED PHYSICS: Particle movement happens atomically with mass during step()
    // No separate update needed - particles ARE the physics state.
    // ═══════════════════════════════════════════════════════════════════════════

    // Throttled probe after particle update (best place to interpret movement this frame).
    _dbgLogSourceProbe(time?.simTimeSeconds, simDeltaSeconds, 'post_particle_update');
}

// ───────────────────────────────────────────────────────────────────────────────
// LIFECYCLE: draw
// ───────────────────────────────────────────────────────────────────────────────

let currentCamera = null;

let _drawDebugCounter = 0;
export function draw(ctx, camera) {
    // Debug: log state periodically
    if (_drawDebugCounter++ % 60 === 0) {
        console.log('[ReynosaOverlay.draw] state:', state, 'mode:', localScenario.renderMode, 'particleLayer:', !!particleLayer);
    }

    if (state === OverlayState.OFF) return;
    if (!camera?.worldToScreen || !camera?.metersToPixels) {
        console.warn('[ReynosaOverlay] Camera missing worldToScreen/metersToPixels');
        return;
    }

    currentCamera = camera;
    const mode = localScenario.renderMode || RENDER_MODE.HEATMAP;
    // DEBUG_BINARY_K: Show phi_pharr instead of normal visualization
    if (DEBUG_BINARY_K) {
        drawPhiBaseDebugInternal(ctx, camera);
        drawMetricsHUD(ctx, camera);
        return;
    }

    const drawHeatmap = (mode === RENDER_MODE.HEATMAP || mode === RENDER_MODE.BOTH) && state === OverlayState.ON;
    const drawParticles = (mode === RENDER_MODE.PARTICLES || mode === RENDER_MODE.BOTH) && (state === OverlayState.ON || state === OverlayState.WARM);

    if (!drawHeatmap && !drawParticles) return;

    if (drawHeatmap) {
        drawDensityHeatmap(ctx, camera);
    }

    // Draw lot boundaries (after heatmap, before particles)
    if (_loadedLots && state === OverlayState.ON) {
        drawLots(ctx, camera);
    }

    if (drawParticles && particleLayer) {
        if (_particleDebugColors && particleLayer.renderDebug) {
            particleLayer.renderDebug(ctx, camera);
        } else {
            particleLayer.render(ctx, camera);
        }
    }

    if (state === OverlayState.ON) {
        drawMetricsHUD(ctx, camera);
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// ACTIVATION LOGIC
// ───────────────────────────────────────────────────────────────────────────────

function computeActivationState(camera) {
    if (!rendererContext) return OverlayState.OFF;

    const mode = localScenario.renderMode || RENDER_MODE.HEATMAP;
    const wantsParticles = mode === RENDER_MODE.PARTICLES || mode === RENDER_MODE.BOTH;
    const particleZoomFloor = localScenario.particleZoomFloor ?? PARTICLE_Z_FLOOR_DEFAULT;

    const pharr = rendererContext.geometry.poePoints.PHARR;
    const reynosaCenter = {
        x: pharr.x,
        y: pharr.y + REYNOSA_ACTIVATION.CENTER_OFFSET_Y,
    };

    const dist = Math.hypot(
        camera.centerWorld.x - reynosaCenter.x,
        camera.centerWorld.y - reynosaCenter.y
    );

    if (dist > REYNOSA_ACTIVATION.RADIUS_M) {
        return OverlayState.OFF;
    }

    if (camera.zoom >= REYNOSA_ACTIVATION.Z_ON) {
        return OverlayState.ON;
    } else if (camera.zoom >= REYNOSA_ACTIVATION.Z_WARM) {
        return OverlayState.WARM;
    }

    // Allow particle-only warm state at lower zoom if requested
    if (wantsParticles && camera.zoom >= particleZoomFloor) {
        return OverlayState.WARM;
    }

    return OverlayState.OFF;
}

// ───────────────────────────────────────────────────────────────────────────────
// FIELD INITIALIZATION
// ───────────────────────────────────────────────────────────────────────────────

function resetFields() {
    // Reset per-class densities
    rho_restricted.fill(0);
    rho_cleared.fill(0);
    rho_restricted_preLot.fill(0);
    rho_restricted_lot.fill(0);
    rho_park_wait.fill(0);
    _globalServiceBudgetKg = 0;
    _waitingParticleQueue.length = 0;
    _waitingParticleQueueHead = 0;
    if (_lotScatterCursor) _lotScatterCursor.fill(0);
    _clearedTrucksThisTick = 0;

    // Reset shared fields
    phi.fill(0);
    phi_pharr.fill(PHI_LARGE);
    phi_lots.fill(PHI_LARGE);
    phiBaseDirty = true;
    _nextHopBuilt = false;
    S.fill(0);
    G.fill(0);
    sinkCellIndices = [];
    lotCellIndices = [];

    // Reset region map (all corridor by default)
    regionMap.fill(REGION_CORRIDOR);

    // Reset conductance to offroad baseline
    Kxx.fill(K_OFFROAD);
    Kyy.fill(K_OFFROAD);
    Kxy.fill(0);

    // Reset metrics
    metrics.injectedTotal = 0;
    metrics.drainedTotal = 0;
    metrics.convertedTotal = 0;
    metrics.injectedThisTick = 0;
    metrics.drainedThisTick = 0;
    metrics.convertedThisTick = 0;
    metrics.total = 0;
    metrics.restricted = 0;
    metrics.cleared = 0;
    metrics.backlog_near_pharr = 0;
    metrics.throughput_kg_per_hr = 0;
    metrics.inflow_kg_per_hr = 0;
    metrics.conversion_kg_per_hr = 0;
    metrics.spillback_extent_m = 0;
}

// ───────────────────────────────────────────────────────────────────────────────
// LOTS MANAGEMENT (replaces circular yard)
// ───────────────────────────────────────────────────────────────────────────────

let _lotsLoaded = false;
let _loadedLots = null;   // Store lot data for rendering (polygon vertices)
let _loadedLayers = null; // Store layer metadata (styles, enabled flags)

/**
 * Initialize lots from lots.json.
 * Called once during onAttach. Stamps lot polygons into regionMap.
 */
async function initLots() {
    if (_lotsLoaded) return;

    const lotsJsonPath = new URL('../test/SIG_v2.json', import.meta.url).href;

    const { lots, layers, totalCells } = await loadLots(lotsJsonPath, roi, N);

    // Store for rendering (lots now include layer, type, style fields)
    _loadedLots = lots;
    _loadedLayers = layers;

    // Build industrial park injection points for Reynosa-local tonnage
    // Parks are assigned to submarket zones; each zone gets a fixed share of flow
    const industrialParks = getIndustrialParksWithArea(lots);
    if (industrialParks.length > 0) {
        const totalAreaM2 = industrialParks.reduce((sum, p) => sum + p.areaM2, 0);
        console.log(`[LOTS] Industrial parks: ${industrialParks.length} parks, ${(totalAreaM2 / 1e6).toFixed(2)} km² total`);

        // Assign each park to a zone based on centroid
        const parksWithZone = industrialParks
            .filter(p => p.areaM2 > 0)
            .map(park => ({
                id: park.id,
                name: park.name,
                centroidX: park.centroid.x,
                centroidY: park.centroid.y,
                fieldX: Math.floor(worldToFieldX(park.centroid.x)),
                fieldY: Math.floor(worldToFieldY(park.centroid.y)),
                areaM2: park.areaM2,
                zone: findZoneForPoint(park.centroid.x, park.centroid.y),
            }));

        // Compute total m² per zone
        const zoneAreaM2 = {};
        for (const zone of INDUSTRIAL_ZONES) {
            zoneAreaM2[zone.id] = 0;
        }
        for (const park of parksWithZone) {
            if (park.zone && zoneAreaM2[park.zone] !== undefined) {
                zoneAreaM2[park.zone] += park.areaM2;
            }
        }

        // Log zone coverage
        let unzoned = 0;
        for (const park of parksWithZone) {
            if (!park.zone) unzoned++;
        }
        console.log(`[LOTS] Zone assignment: ${parksWithZone.length - unzoned} in zones, ${unzoned} unzoned`);
        for (const zone of INDUSTRIAL_ZONES) {
            const parksInZone = parksWithZone.filter(p => p.zone === zone.id);
            console.log(`  ${zone.id}: ${parksInZone.length} parks, ${(zoneAreaM2[zone.id] / 1e6).toFixed(3)} km², ${(zone.share * 100).toFixed(0)}% share`);
        }

        // Build injection points with zone-based ratios
        // zoneRatio = park's m² / zone's total m² (distributes zone's share among its parks)
        _industrialParkInjectionPoints = parksWithZone
            .filter(p => p.zone !== null)  // Only parks inside defined zones
            .map(park => {
                const zone = INDUSTRIAL_ZONES.find(z => z.id === park.zone);
                const zoneTotalM2 = zoneAreaM2[park.zone] || 1;
                return {
                    id: park.id,
                    name: park.name,
                    fieldX: park.fieldX,
                    fieldY: park.fieldY,
                    areaM2: park.areaM2,
                    zone: park.zone,
                    zoneShare: zone ? zone.share : 0,
                    zoneRatio: park.areaM2 / zoneTotalM2,  // fraction of zone's total m²
                };
            });

        // Log parks by zone
        for (const zone of INDUSTRIAL_ZONES) {
            const parksInZone = _industrialParkInjectionPoints.filter(p => p.zone === zone.id);
            if (parksInZone.length > 0) {
                const topPark = parksInZone.sort((a, b) => b.areaM2 - a.areaM2)[0];
                console.log(`[LOTS] ${zone.id} top park: ${topPark.id} (${(topPark.zoneRatio * 100).toFixed(1)}% of zone)`);
            }
        }
        console.log(`[LOTS] Industrial park injection: ${_industrialParkInjectionPoints.length} zoned points, ${(REYNOSA_LOCAL_RATIO * 100).toFixed(1)}% of total flow`);
    }

    // Filter: only layer="lots" gets stamped as conversion zones
    // Industrial parks spawn trucks but don't convert them
    const conversionLots = lots.filter(lot => lot.layer === 'lots');
    console.log(`[LOTS] Conversion lots: ${conversionLots.length} (layer=lots), other: ${lots.length - conversionLots.length}`);

    // Stamp lot regions (only conversion lots)
    stampLots(conversionLots, regionMap, REGION_LOT);

    // Build sparse index
    lotCellIndices = buildLotCellIndices(regionMap, REGION_LOT, N2);

    // CRITICAL: Stamp K values for lot cells so they're traversable
    // Lots need K > K_ROAD_THRESHOLD (0.01) to be included in roadCellIndices
    // and have valid nextHop entries. K=0.4 = reduced conductance (dwell zone).
    const K_LOT = 0.4;
    const K_ROAD_OVERLAP_THRESHOLD = 0.5;  // If K > this before stamping, it was a road
    let lotRoadOverlapCount = 0;

    // Build temporary cell-to-lot lookup for overlap detection
    const tempCellToLot = new Map();
    for (let lotIdx = 0; lotIdx < conversionLots.length; lotIdx++) {
        for (const cellIdx of (conversionLots[lotIdx].cells || [])) {
            tempCellToLot.set(cellIdx, lotIdx);
        }
    }
    const overlapByLot = new Map();  // lotIdx -> count of overlapping cells

    for (const idx of lotCellIndices) {
        // Detect lot-road overlap BEFORE overwriting
        const existingK = Math.max(Kxx[idx], Kyy[idx]);
        if (existingK > K_ROAD_OVERLAP_THRESHOLD) {
            lotRoadOverlapCount++;
            const lotIdx = tempCellToLot.get(idx) ?? -1;
            if (lotIdx >= 0) {
                overlapByLot.set(lotIdx, (overlapByLot.get(lotIdx) || 0) + 1);
            }
        }
        Kxx[idx] = K_LOT;
        Kyy[idx] = K_LOT;
    }

    console.log(`[LOTS] Stamped K=${K_LOT} for ${lotCellIndices.length} lot cells`);
    if (lotRoadOverlapCount > 0) {
        console.warn(`[LOTS] WARNING: ${lotRoadOverlapCount} lot cells were already roads (K>${K_ROAD_OVERLAP_THRESHOLD})`);
        console.warn(`[LOTS] This may indicate grid resolution too coarse or lot polygons overlapping roads.`);
        // Log which lots have the most overlap
        const sortedOverlap = [...overlapByLot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        for (const [lotIdx, count] of sortedOverlap) {
            const lotName = conversionLots[lotIdx]?.name || `lot_${lotIdx}`;
            const lotTotal = conversionLots[lotIdx]?.cells?.length || 0;
            console.warn(`[LOTS]   ${lotName}: ${count}/${lotTotal} cells (${(100*count/lotTotal).toFixed(0)}% overlap)`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LOT CAPACITY: Compute area and capacity for conversion lots only
    // ─────────────────────────────────────────────────────────────────────────
    const cellSizeM = roi.sizeM / N;  // meters per cell
    const cellAreaM2 = cellSizeM * cellSizeM;

    // Initialize cell-to-lot mapping
    cellToLotIndex = new Int16Array(N2);
    cellToLotIndex.fill(-1);

    // Reset per-lot arrays
    lotCapacityKg = [];
    lotAreaM2 = [];
    lotCellCount = [];
    lotToCellIndices = [];

    // Build cell-to-lot mapping and compute per-lot stats (conversion lots only)
    for (let lotIdx = 0; lotIdx < conversionLots.length; lotIdx++) {
        const lot = conversionLots[lotIdx];
        const cells = lot.cells || [];

        // Map cells to this lot (forward mapping)
        for (const cellIdx of cells) {
            cellToLotIndex[cellIdx] = lotIdx;
        }

        // Store reverse mapping: lot -> cells (keep reference, no copy)
        lotToCellIndices.push(cells);

        // Compute area and capacity
        const area = cells.length * cellAreaM2;
        const capacity = area * LOT_KG_PER_M2;

        lotCellCount.push(cells.length);
        lotAreaM2.push(area);
        lotCapacityKg.push(capacity);
    }

    // Log capacity stats
    const totalCapacity = lotCapacityKg.reduce((a, b) => a + b, 0);
    const minCap = Math.min(...lotCapacityKg.filter(c => c > 0));
    const maxCap = Math.max(...lotCapacityKg);
    console.log(`[LOTS] Capacity: ${conversionLots.length} conversion lots, ${LOT_KG_PER_M2} kg/m², total=${(totalCapacity/1e6).toFixed(1)}Mt, range=${(minCap/1e3).toFixed(0)}-${(maxCap/1e3).toFixed(0)}t`);

    // MAPPING SANITY CHECK: Verify cellToLotIndex is correctly populated
    const uniqueLotsInMap = new Set();
    let unmappedLotCells = 0;
    for (const cellIdx of lotCellIndices) {
        const lotIdx = cellToLotIndex[cellIdx];
        if (lotIdx < 0) {
            unmappedLotCells++;
        } else {
            uniqueLotsInMap.add(lotIdx);
        }
    }
    console.log(`[LOTS MAPPING] ${uniqueLotsInMap.size}/${lots.length} lots in cellToLotIndex, ${unmappedLotCells} unmapped cells`);
    if (unmappedLotCells > 0 || uniqueLotsInMap.size !== lots.length) {
        console.warn(`[LOTS MAPPING] WARNING: Mapping mismatch! Redistribution may not work correctly.`);
    }

    // DEBUG: Verify lotToCellIndices cells are actually REGION_LOT in regionMap
    let mismatchCount = 0;
    let mismatchLots = [];
    for (let lotIdx = 0; lotIdx < lotToCellIndices.length; lotIdx++) {
        const cells = lotToCellIndices[lotIdx];
        for (const cellIdx of cells) {
            if (regionMap[cellIdx] !== REGION_LOT) {
                mismatchCount++;
                if (!mismatchLots.includes(lotIdx)) mismatchLots.push(lotIdx);
            }
        }
    }
    if (mismatchCount > 0) {
        console.error(`[LOTS VERIFY] BUG FOUND: ${mismatchCount} cells in lotToCellIndices are NOT REGION_LOT in regionMap!`);
        console.error(`[LOTS VERIFY] Affected lots: ${mismatchLots.slice(0, 10).join(', ')}${mismatchLots.length > 10 ? '...' : ''}`);
    } else {
        console.log(`[LOTS VERIFY] OK: All ${lotCellIndices.length} cells in lotToCellIndices are correctly marked as REGION_LOT`);
    }

    // CONNECTIVITY: Bridge lots to road network via BFS
    // If lots are not adjacent to roads, mass/particles can't reach them.
    // BFS from lot cell until road found, then backtrack to stamp only the shortest path.
    const K_ROAD_CHECK = 0.1; // Threshold to consider "on road"
    // Widen connector stamping to fdrm a corridor (particles are continuous and can drift).
    // A 1-cell bridge is easy for particles to miss and end up stuck in K=0 cells.
    const CONNECTOR_RADIUS_CELLS = 1; // 1 => 3x3 corridor; 2 => 5x5
    // Add a wider "apron" near the road connection to handle curves/turning.
    // This flares the last few connector steps approaching the road into a wider region.
    const CONNECTOR_APRON_RADIUS_CELLS = 2; // 2 => 5x5 apron
    const CONNECTOR_APRON_STEPS = 3;        // widen first N steps from the road
    let connectorCells = 0;
    let maxBridgeLength = 0;

    for (const lotIdx of lotCellIndices) {
        // Check if this lot cell is already adjacent to a road
        const lx = lotIdx % N;
        const ly = Math.floor(lotIdx / N);
        let needsBridge = true;

        // Check 8-connected neighbors for road
        for (let dy = -1; dy <= 1 && needsBridge; dy++) {
            for (let dx = -1; dx <= 1 && needsBridge; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = lx + dx, ny = ly + dy;
                if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                const ni = ny * N + nx;
                if (regionMap[ni] !== REGION_LOT && (Kxx[ni] > K_ROAD_CHECK || Kyy[ni] > K_ROAD_CHECK)) {
                    needsBridge = false;  // Already connected
                }
            }
        }

        if (!needsBridge) continue;

        // BFS to find nearest road cell, tracking parent pointers for path reconstruction
        const parent = new Map();  // child → parent
        parent.set(lotIdx, -1);    // Start node has no parent
        let frontier = [lotIdx];
        let foundCell = -1;

        // No limit - search until road found or field exhausted
        while (foundCell < 0 && frontier.length > 0) {
            const nextFrontier = [];
            for (const idx of frontier) {
                const x = idx % N;
                const y = Math.floor(idx / N);
                // 4-connected expansion
                const neighbors = [];
                if (x > 0) neighbors.push(idx - 1);
                if (x < N - 1) neighbors.push(idx + 1);
                if (y > 0) neighbors.push(idx - N);
                if (y < N - 1) neighbors.push(idx + N);

                for (const ni of neighbors) {
                    if (parent.has(ni)) continue;  // Already visited
                    parent.set(ni, idx);  // Track parent for path reconstruction

                    // Found road?
                    if (regionMap[ni] !== REGION_LOT && (Kxx[ni] > K_ROAD_CHECK || Kyy[ni] > K_ROAD_CHECK)) {
                        foundCell = ni;
                        break;
                    }

                    // Continue searching (only through non-lot cells)
                    if (regionMap[ni] !== REGION_LOT) {
                        nextFrontier.push(ni);
                    }
                }
                if (foundCell >= 0) break;
            }
            frontier = nextFrontier;
        }

        // Backtrack from road cell to lot cell, stamp only the path
        if (foundCell >= 0) {
            let current = parent.get(foundCell);  // Start from cell before road
            let pathLength = 0;
            let stepsFromRoad = 0;
            while (current >= 0 && current !== lotIdx) {
                // Stamp a widened corridor around the path cell (non-lot only).
                const cx = current % N;
                const cy = Math.floor(current / N);
                const r = (stepsFromRoad < CONNECTOR_APRON_STEPS) ? CONNECTOR_APRON_RADIUS_CELLS : CONNECTOR_RADIUS_CELLS;
                for (let dy = -r; dy <= r; dy++) {
                    for (let dx = -r; dx <= r; dx++) {
                        const nx = cx + dx;
                        const ny = cy + dy;
                        if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                        const ni = ny * N + nx;
                        if (regionMap[ni] === REGION_LOT) continue;
                        if (Kxx[ni] < K_CONNECTOR) {
                            Kxx[ni] = K_CONNECTOR;
                            Kyy[ni] = K_CONNECTOR;
                            connectorCells++;
                        }
                    }
                }
                pathLength++;
                stepsFromRoad++;
                current = parent.get(current);
            }
            if (pathLength > maxBridgeLength) maxBridgeLength = pathLength;

            // Optional: stamp a small apron around the road contact cell itself (non-lot only).
            // This helps particles transitioning onto the road network near sharp corners.
            {
                const cx = foundCell % N;
                const cy = Math.floor(foundCell / N);
                const r = CONNECTOR_APRON_RADIUS_CELLS;
                for (let dy = -r; dy <= r; dy++) {
                    for (let dx = -r; dx <= r; dx++) {
                        const nx = cx + dx;
                        const ny = cy + dy;
                        if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                        const ni = ny * N + nx;
                        if (regionMap[ni] === REGION_LOT) continue;
                        if (Kxx[ni] < K_CONNECTOR) {
                            Kxx[ni] = K_CONNECTOR;
                            Kyy[ni] = K_CONNECTOR;
                            connectorCells++;
                        }
                    }
                }
            }
        }
    }

    if (connectorCells > 0) {
        console.log(
            `[LOTS] Bridged ${connectorCells} connector cells ` +
            `(K=${K_CONNECTOR}, radius=${CONNECTOR_RADIUS_CELLS}, apronRadius=${CONNECTOR_APRON_RADIUS_CELLS} x ${CONNECTOR_APRON_STEPS} steps), ` +
            `max path length=${maxBridgeLength}`
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INDUSTRIAL PARK BRIDGING: Connect injection points to road network
    // Parks spawn trucks at centroids - need road access for particles to leave
    // ─────────────────────────────────────────────────────────────────────────
    let parkConnectorCells = 0;
    let parkMaxBridgeLength = 0;
    const K_PARK_CONNECTOR = 0.3;  // Slightly lower than lot connectors

    for (const park of _industrialParkInjectionPoints) {
        const parkIdx = park.fieldY * N + park.fieldX;
        if (parkIdx < 0 || parkIdx >= N2) continue;

        // Check if already on/near road
        let needsBridge = true;
        const px = park.fieldX;
        const py = park.fieldY;
        for (let dy = -2; dy <= 2 && needsBridge; dy++) {
            for (let dx = -2; dx <= 2 && needsBridge; dx++) {
                const nx = px + dx, ny = py + dy;
                if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                const ni = ny * N + nx;
                if (Kxx[ni] > K_ROAD_CHECK || Kyy[ni] > K_ROAD_CHECK) {
                    needsBridge = false;
                }
            }
        }

        if (!needsBridge) continue;

        // BFS from park centroid to find nearest road
        const parent = new Map();
        parent.set(parkIdx, -1);
        let frontier = [parkIdx];
        let foundCell = -1;

        while (foundCell < 0 && frontier.length > 0) {
            const nextFrontier = [];
            for (const idx of frontier) {
                const x = idx % N;
                const y = Math.floor(idx / N);
                const neighbors = [];
                if (x > 0) neighbors.push(idx - 1);
                if (x < N - 1) neighbors.push(idx + 1);
                if (y > 0) neighbors.push(idx - N);
                if (y < N - 1) neighbors.push(idx + N);

                for (const ni of neighbors) {
                    if (parent.has(ni)) continue;
                    parent.set(ni, idx);

                    if (Kxx[ni] > K_ROAD_CHECK || Kyy[ni] > K_ROAD_CHECK) {
                        foundCell = ni;
                        break;
                    }
                    nextFrontier.push(ni);
                }
                if (foundCell >= 0) break;
            }
            frontier = nextFrontier;
        }

        // Backtrack and stamp connector path
        if (foundCell >= 0) {
            let current = foundCell;
            let pathLength = 0;
            while (current >= 0 && parent.get(current) !== -1) {
                const cx = current % N;
                const cy = Math.floor(current / N);
                // Stamp wider corridor (radius 2 for parks)
                for (let dy = -2; dy <= 2; dy++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        const nx = cx + dx, ny = cy + dy;
                        if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                        const ni = ny * N + nx;
                        if (Kxx[ni] < K_PARK_CONNECTOR) {
                            Kxx[ni] = K_PARK_CONNECTOR;
                            Kyy[ni] = K_PARK_CONNECTOR;
                            parkConnectorCells++;
                        }
                    }
                }
                pathLength++;
                current = parent.get(current);
            }
            // Also stamp around the injection point itself
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const nx = px + dx, ny = py + dy;
                    if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                    const ni = ny * N + nx;
                    if (Kxx[ni] < K_PARK_CONNECTOR) {
                        Kxx[ni] = K_PARK_CONNECTOR;
                        Kyy[ni] = K_PARK_CONNECTOR;
                        parkConnectorCells++;
                    }
                }
            }
            if (pathLength > parkMaxBridgeLength) parkMaxBridgeLength = pathLength;
        }
    }

    if (parkConnectorCells > 0) {
        console.log(
            `[PARKS] Bridged ${parkConnectorCells} connector cells for ${_industrialParkInjectionPoints.length} industrial parks, ` +
            `max path length=${parkMaxBridgeLength}`
        );
    }

    // Build park wait zones for industrial park local dwell
    buildParkWaitZones();

    _lotsLoaded = true;
    _yardEnabled = true;  // Lots enable conversion by default

    // CRITICAL: Force FULL rebuild now that lots are stamped
    // The first rebuild (before lots loaded) built roadCellIndices WITHOUT lot cells.
    // We must rebuild both routing tables AND the traversable cell list.
    phiBaseDirty = true;
    _nextHopBuilt = false;  // Force routing rebuild, not just potential recompute

    // If a rebuild is in progress, wait for it to complete then trigger another IMMEDIATELY
    // Don't just set phiBaseDirty - that waits for overlay to go ON which delays rebuild
    if (_phiRebuildInProgress) {
        console.log(`[LOTS] Rebuild in progress - will trigger immediate rebuild after completion`);
        const waitForRebuild = setInterval(() => {
            if (!_phiRebuildInProgress) {
                clearInterval(waitForRebuild);
                console.log(`[LOTS] Previous rebuild complete - triggering immediate rebuild with lot cells`);
                _nextHopBuilt = false;
                rebuildPhiBase();  // Start rebuild immediately, don't wait for ON state
            }
        }, 100);
    } else {
        // No rebuild in progress - start one immediately
        console.log(`[LOTS] Starting immediate rebuild with lot cells`);
        _nextHopBuilt = false;
        rebuildPhiBase();
    }

    // Apply road exclusions LAST - overrides everything including lots
    applyRoadExclusions();

    console.log(`[ReynosaOverlay] Lots initialized: ${lots.length} lots, ${lotCellIndices.length} cells`);
}

/**
 * Draw lot geometries with per-layer styles.
 * Renders in z-order: urbanFootprint, industrialParks, electricity, phases.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ worldToScreen: Function }} camera
 */
function drawLots(ctx, camera) {
    if (!_loadedLots || !camera?.worldToScreen) return;

    // Render order (back to front)
    const renderOrder = ['urbanFootprint', 'industrialParks', 'electricity', 'phases', 'lots'];

    // Default style fallback
    const defaultStyle = {
        fill: 'rgba(255, 255, 255, 0.08)',
        stroke: 'rgba(255, 255, 255, 0.4)',
        strokeWidth: 1
    };

    // Layer-specific style overrides
    const layerStyles = {
        lots: {
            fill: null,  // No fill - just outlines
            stroke: 'rgba(153, 153, 153, 0.8)',  // 60% gray - darker than roads (75%)
            strokeWidth: 1
        }
    };

    ctx.save();

    // DEBUG: log once per layer
    if (!drawLots._debugged) {
        drawLots._debugged = true;
        for (const ln of renderOrder) {
            const ll = _loadedLots.filter(lot => lot.layer === ln);
            const polyCount = ll.reduce((sum, l) => sum + l.polygons.length, 0);
            const wcCount = ll.reduce((sum, l) => sum + l.polygons.filter(p => p.worldCoords?.length > 0).length, 0);
            console.log(`[LOTS RENDER] layer=${ln} lots=${ll.length} polygons=${polyCount} withWorldCoords=${wcCount}`);
            if (ln === 'industrialParks' && ll.length > 0) {
                console.log(`[LOTS RENDER] industrialParks[0]:`, ll[0].id, ll[0].style, ll[0].polygons[0]?.worldCoords?.slice(0,2));
            }
        }
    }

    for (const layerName of renderOrder) {
        const layerLots = _loadedLots.filter(lot => lot.layer === layerName);
        if (layerLots.length === 0) continue;

        // Use layer-specific style if defined, otherwise lot style or default
        const layerStyle = layerStyles[layerName];

        for (const lot of layerLots) {
            const style = layerStyle || lot.style || defaultStyle;

            for (const poly of lot.polygons) {
                if (poly.worldCoords.length < 2) continue;

                const geometry = poly.geometry || 'Polygon';

                ctx.beginPath();
                const first = camera.worldToScreen(poly.worldCoords[0].x, poly.worldCoords[0].y);
                ctx.moveTo(first.x, first.y);

                for (let i = 1; i < poly.worldCoords.length; i++) {
                    const pt = camera.worldToScreen(poly.worldCoords[i].x, poly.worldCoords[i].y);
                    ctx.lineTo(pt.x, pt.y);
                }

                if (geometry === 'Polygon') {
                    ctx.closePath();
                    if (style.fill) {
                        ctx.fillStyle = style.fill;
                        ctx.fill();
                    }
                    if (style.stroke) {
                        ctx.strokeStyle = style.stroke;
                        ctx.lineWidth = style.strokeWidth || 1;
                        ctx.stroke();
                    }
                } else if (geometry === 'LineString') {
                    // Don't close path for lines
                    ctx.strokeStyle = style.stroke || 'rgba(0, 255, 85, 0.6)';
                    ctx.lineWidth = style.strokeWidth || 2;
                    ctx.stroke();
                } else if (geometry === 'Point') {
                    // Draw point as circle
                    const radius = style.radius || 4;
                    ctx.arc(first.x, first.y, radius, 0, Math.PI * 2);
                    if (style.fill) {
                        ctx.fillStyle = style.fill;
                        ctx.fill();
                    }
                    if (style.stroke) {
                        ctx.strokeStyle = style.stroke;
                        ctx.lineWidth = style.strokeWidth || 1;
                        ctx.stroke();
                    }
                }
            }
        }
    }

    ctx.restore();
}

/**
 * Enable conversion in lots (Inovus mode).
 * Lots geometry is always present; this enables the conversion logic.
 * @deprecated Use initLots() at startup. This is kept for backward compatibility.
 */
export function enableYard(centerX, centerY, radiusM = 500) {
    _yardEnabled = true;
    // Lots are stamped at init, not here. Ignore position/radius params.
    console.log('[ReynosaOverlay] Conversion enabled (lots mode)');
}

/**
 * Disable conversion in lots.
 * Lots geometry remains; only conversion is disabled.
 */
export function disableYard() {
    _yardEnabled = false;
    // Do NOT clear regionMap - lots are persistent geometry
    console.log('[ReynosaOverlay] Conversion disabled');
}

/**
 * Check if conversion (yard mode) is enabled.
 */
export function isYardEnabled() {
    return _yardEnabled;
}

/**
 * Check if lots have been loaded.
 */
export function areLotsLoaded() {
    return _lotsLoaded;
}

// ───────────────────────────────────────────────────────────────────────────────
// MULTI-CLASS PHYSICS UPDATE
// ───────────────────────────────────────────────────────────────────────────────

let _physicsDebugCounter = 0;
const PHYSICS_SUBSTEPS = 8;  // Graph flow runs 8× per frame - smaller steps prevent threshold overshoot

function updateMultiClassPhysics(dt) {
    // Field-authoritative pre-lot holding release (roadside staging).
    // IMPORTANT: run before flow substeps so released mass can participate this frame.
    advancePreLotHolding(dt);

    // 0. Update lot utilization tracking - triggers phi rebuild when lots fill/empty
    const capacityChanged = updateLotUtilization();

    // DIAGNOSTIC: LOT-GATE status (every ~2s)
    if (_physicsDebugCounter % 120 === 0 && lotCapacityKg.length > 0) {
        const fullCount = lotIsFull.filter(Boolean).length;
        const utilizations = lotCapacityKg.map((cap, i) => cap > 0 ? lotCurrentMassKg[i] / cap : 0);
        const topUtil = Math.max(...utilizations);
        const hotLotIdx = utilizations.indexOf(topUtil);
        console.log(`[LOT-GATE] full=${fullCount}/${lotIsFull.length} topUtil=${(topUtil*100).toFixed(1)}% hotLot=#${hotLotIdx} hotMass=${(lotCurrentMassKg[hotLotIdx]/1000).toFixed(1)}t`);
    }

    if (capacityChanged) {
        const fullCount = lotIsFull.filter(f => f).length;
        console.log(
            `[LOTS] Capacity state changed - scheduling phi rebuild ` +
            `(${fullCount}/${lotIsFull.length} lots >=90%)`
        );
        requestCapacityRebuild();
    }

    // Check if scheduled capacity rebuild is due
    maybeRunCapacityRebuild();

    // 1. Compute potential (only once per frame - it's static)
    computePotentialMultiClass();

    // 2-6: Run graph flow multiple times to accelerate propagation
    // Graph flow follows shortest-path tree - robust, topology-aware
    let enteredLotsKgThisFrame = 0;  // restricted mass accepted into lots this physics frame
    // No "mint at lots" for particles: tokens are minted at source injection only.

    // Lot entry diagnostics (per physics frame)
    if (lotCapacityKg.length > 0) {
        const nLots = lotCapacityKg.length;
        if (!lotEntryAttemptKgFrame || lotEntryAttemptKgFrame.length !== nLots) {
            lotEntryAttemptKgFrame = new Float64Array(nLots);
            lotEntryDesiredKgFrame = new Float64Array(nLots);
            lotEntryAcceptedKgFrame = new Float64Array(nLots);
            lotEntryRejectedKgFrame = new Float64Array(nLots);
            lotEntryCapShortfallKgFrame = new Float64Array(nLots);
        } else {
            lotEntryAttemptKgFrame.fill(0);
            lotEntryDesiredKgFrame.fill(0);
            lotEntryAcceptedKgFrame.fill(0);
            lotEntryRejectedKgFrame.fill(0);
            lotEntryCapShortfallKgFrame.fill(0);
        }
    }

    for (let substep = 0; substep < PHYSICS_SUBSTEPS; substep++) {
        // Rebuild live lot mass from current rho (O(1) lookup for getLotAcceptance)
        rebuildLotMassLiveFromRho();

        // 3. Graph flow each class (exactly mass-conservative)
        const rStats = graphFlowClass('restricted', rho_restricted, rhoNext_restricted);
        const cStats = graphFlowClass('cleared', rho_cleared, rhoNext_cleared);
        accumulateRoutingStats('restricted', rStats);
        accumulateRoutingStats('cleared', cStats);
        enteredLotsKgThisFrame += (rStats.enteredLots || 0);

        // PARALLEL RUN: Step unified physics alongside old system
        // TODO: Compare outputs and log divergences before cutover
        if (particleLayer?.step) {
            const substepDt = dt / PHYSICS_SUBSTEPS;
            particleLayer.step(substepDt);
        }

        // Track gate thrash (lot open/close oscillation)
        logLotGateThrash();
    }

    // Diagnostic: oversubscription pressure (every ~2s)
    if (lotCapacityKg.length > 0) {
        const now = performance.now();
        if (now - _lotEntryDiagLastLogMs > 2000) {
            _lotEntryDiagLastLogMs = now;

            // Find top offenders by capacity shortfall (desired > remaining-at-time)
            const top = [];
            for (let i = 0; i < lotCapacityKg.length; i++) {
                const shortfall = lotEntryCapShortfallKgFrame?.[i] || 0;
                const rejected = lotEntryRejectedKgFrame?.[i] || 0;
                const desired = lotEntryDesiredKgFrame?.[i] || 0;
                if (shortfall <= 0 && rejected <= 0) continue;
                top.push([shortfall, rejected, desired, i]);
            }
            top.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));

            const lines = [];
            for (let k = 0; k < Math.min(5, top.length); k++) {
                const [shortfall, rejected, desired, lotIdx] = top[k];
                const cap = lotCapacityKg[lotIdx] || 0;
                const mass = lotCurrentMassKg?.[lotIdx] || 0;
                const util = cap > 0 ? (100 * mass / cap) : 0;
                lines.push(
                    `lot#${lotIdx} util=${util.toFixed(0)}% desired=${(desired/1000).toFixed(1)}t ` +
                    `rejected=${(rejected/1000).toFixed(1)}t shortfall=${(shortfall/1000).toFixed(1)}t`
                );
            }

            if (lines.length > 0) {
                console.log(`[LOT-ENTRY-DIAG] oversubscription pressure (top ${lines.length}):`);
                for (const l of lines) console.log(`  ${l}`);
            }
        }
        // Unified debug block for targeted lots (LOT_LOG_IDX_LIST):
        // Field (mass/capacity), routing attempts, particle counts, and phi rebuild state.
        if (lotCapacityKg.length > 0) {
            const now = performance.now();
            for (const LOT_LOG_IDX of LOT_LOG_IDX_LIST) {
                if (LOT_LOG_IDX < 0 || LOT_LOG_IDX >= lotCapacityKg.length) continue;
                const last = _lotLogLastMs[LOT_LOG_IDX] || 0;
                if (now - last <= 2000) continue;
                _lotLogLastMs[LOT_LOG_IDX] = now;

                const cap = lotCapacityKg[LOT_LOG_IDX] || 0;
                if (cap <= 0) continue;

                // Field state
                const mass = lotCurrentMassKg?.[LOT_LOG_IDX] ?? 0;       // stored restricted mass
                const live = lotMassKgLive?.[LOT_LOG_IDX] ?? 0;          // live snapshot used for gating
                const remaining = lotAcceptRemainingKgLive?.[LOT_LOG_IDX] ?? 0;
                const util = cap > 0 ? (100 * mass / cap) : 0;
                const isFull = lotIsFull?.[LOT_LOG_IDX] || false;
                const inSnapshot = _fullLotsSnapshot?.includes(LOT_LOG_IDX) || false;

                // Routing attempts this frame
                const attempt = lotEntryAttemptKgFrame?.[LOT_LOG_IDX] ?? 0;
                const desired = lotEntryDesiredKgFrame?.[LOT_LOG_IDX] ?? 0;
                const accepted = lotEntryAcceptedKgFrame?.[LOT_LOG_IDX] ?? 0;
                const rejected = lotEntryRejectedKgFrame?.[LOT_LOG_IDX] ?? 0;
                const shortfall = lotEntryCapShortfallKgFrame?.[LOT_LOG_IDX] ?? 0;

                // Particle-side visibility (safe if particle layer exists)
                let pRestrictedInLot = 0;
                let pRestrictedOnCells = 0;
                if (typeof particles !== 'undefined') {
                    for (let i = 0; i < particles.length; i++) {
                        const p = particles[i];
                        if ((p.classId || 'cleared') !== 'restricted') continue;
                        if (p.waitingInLot && p.lotIdx === LOT_LOG_IDX) pRestrictedInLot++;
                        const fx = worldToFieldX(p.x);
                        const fy = worldToFieldY(p.y);
                        const cx = Math.floor(fx);
                        const cy = Math.floor(fy);
                        if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;
                        const idx = cy * N + cx;
                        if (regionMap[idx] === REGION_LOT && cellToLotIndex[idx] === LOT_LOG_IDX) {
                            pRestrictedOnCells++;
                        }
                    }
                }

                // Phi rebuild status
                const phiPending = !!_phiRebuildPending;
                const phiInProgress = !!_phiRebuildInProgress;
                const phiDirty = !!phiBaseDirty;

                console.log(
                    `[LOT${LOT_LOG_IDX} DEBUG] util=${util.toFixed(0)}% mass=${(mass/1000).toFixed(1)}t live=${(live/1000).toFixed(1)}t ` +
                    `remaining=${(remaining/1000).toFixed(1)}t isFull=${isFull ? 1 : 0} inSnapshot=${inSnapshot ? 1 : 0} | ` +
                    `attempt=${(attempt/1000).toFixed(1)}t desired=${(desired/1000).toFixed(1)}t accepted=${(accepted/1000).toFixed(1)}t rejected=${(rejected/1000).toFixed(1)}t shortfall=${(shortfall/1000).toFixed(1)}t | ` +
                    `p.waiting=${pRestrictedInLot} p.onCells=${pRestrictedOnCells} | phiDirty=${phiDirty ? 1 : 0} phiPending=${phiPending ? 1 : 0} phiInProgress=${phiInProgress ? 1 : 0}`
                );
            }
        }
    }

    // 4. Inject into restricted class
    injectMass(dt);

    // No "mint restricted particles into lots".

    // 5. Apply conversions (restricted → cleared in lots)
    // Global clearing model: dwell delay + single global budget
    applyConversions(dt, enteredLotsKgThisFrame);

    // Particle coupling is handled inside FIFO service (per-lot ordering).

    // 6. Drain sink (cleared only)
    drainPharrSinkMultiClass(dt);

    // 7. Enforce non-negative
    enforceNonNegative();

    // ═══════════════════════════════════════════════════════════════════════════════
    // FIX 3: CLEARED MASS EXIT INVARIANT
    // Cleared mass must never be trapped in lot cells.
    // Invariant: if lot cell has rho_cleared > 0, then:
    //   - nextHop_pharr[idx] >= 0 (valid next hop), OR
    //   - idx is a PHARR sink (can drain directly)
    // ═══════════════════════════════════════════════════════════════════════════════
    if (_physicsDebugCounter % 60 === 0) {  // Check every 60 frames
        const sinkSet = new Set(sinkCellIndices);
        let trappedMass = 0;
        let trappedCells = 0;
        for (const idx of lotCellIndices) {
            const cleared = rho_cleared[idx];
            // Trapped = has cleared mass, no nextHop, and not a PHARR sink
            if (cleared > 0.001 && nextHop_pharr[idx] < 0 && !sinkSet.has(idx)) {
                trappedMass += cleared;
                trappedCells++;
            }
        }
        if (trappedCells > 0) {
            console.error(`[INVARIANT VIOLATION] FIX 3: Cleared mass trapped in ${trappedCells} lot cells, total ${(trappedMass/1000).toFixed(2)}t`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // DECISIVE DIAGNOSTIC: WHY CLEARED MASS DOESN'T EXIT LOTS
    // Pick ONE lot cell with cleared mass and trace exactly what happens.
    // Remove after diagnosis.
    // ═══════════════════════════════════════════════════════════════════════════════
    if (_physicsDebugCounter % 120 === 0) {  // Every ~2 seconds
        // Find ONE lot cell with nonzero rho_cleared
        let targetIdx = -1;
        let targetMass = 0;
        for (const idx of lotCellIndices) {
            if (rho_cleared[idx] > 0.1) {
                targetIdx = idx;
                targetMass = rho_cleared[idx];
                break;
            }
        }

        if (targetIdx >= 0) {
            const roadSet = new Set(roadCellIndices);
            const sinkSet = new Set(sinkCellIndices);
            const inRoadSet = roadSet.has(targetIdx);
            const nh = nextHop_pharr[targetIdx];
            const phiHere = phi_pharr[targetIdx];
            const phiNext = nh >= 0 ? phi_pharr[nh] : -1;
            const nhRegion = nh >= 0 ? regionMap[nh] : -1;
            const isSink = sinkSet.has(targetIdx);
            const lotIdx = cellToLotIndex[targetIdx];

            console.log(`[EXIT-DIAG] ===================================================`);
            console.log(`[EXIT-DIAG] Lot cell ${targetIdx} (lot #${lotIdx}): cleared=${(targetMass/1000).toFixed(2)}t`);
            console.log(`[EXIT-DIAG]   In roadCellIndices? ${inRoadSet}`);
            console.log(`[EXIT-DIAG]   nextHop_pharr = ${nh} (${nh < 0 ? 'INVALID/SINK' : nh >= 0 && nhRegion === REGION_LOT ? 'points to LOT' : 'points to ROAD'})`);
            console.log(`[EXIT-DIAG]   phi_pharr[here] = ${phiHere < PHI_LARGE ? phiHere.toFixed(0) : 'UNREACHABLE'}`);
            console.log(`[EXIT-DIAG]   phi_pharr[next] = ${phiNext >= 0 ? (phiNext < PHI_LARGE ? phiNext.toFixed(0) : 'UNREACHABLE') : 'N/A'}`);
            console.log(`[EXIT-DIAG]   Gradient valid? ${nh >= 0 && phiNext < phiHere ? 'YES (downhill)' : 'NO'}`);
            console.log(`[EXIT-DIAG]   Is PHARR sink? ${isSink}`);

            // Check if this cell would be processed by graphFlowClass
            if (!inRoadSet) {
                console.error(`[EXIT-DIAG]   FATAL: Cell NOT in roadCellIndices - cleared mass will NEVER move!`);
            } else if (nh < 0 && !isSink) {
                console.error(`[EXIT-DIAG]   FATAL: No valid nextHop and not a sink - cleared mass STUCK!`);
            } else if (nh >= 0 && phiNext >= phiHere) {
                console.error(`[EXIT-DIAG]   FATAL: nextHop exists but gradient is wrong - routing broken!`);
            } else {
                console.log(`[EXIT-DIAG]   OK: Cell should flow correctly. If mass still accumulates, check flow logic.`);
            }
            console.log(`[EXIT-DIAG] ===================================================`);
        }
    }

    // 8. Log routing stats (high-signal, every ~2s)
    logRoutingStats();

    // Debug: log physics state periodically (every 600 frames ~10s)
    if (_physicsDebugCounter++ % 600 === 0) {
        let totalRho = 0, sourceSum = 0;
        let roadCells = 0, deadEndCells = 0;

        for (let i = 0; i < N2; i++) {
            totalRho += rho_restricted[i] + rho_cleared[i];
            sourceSum += S[i];

            // Count road cells and dead-ends (nextHop_pharr = -1 on road cells)
            const hasK = Kxx[i] > K_OFFROAD + 0.01 || Kyy[i] > K_OFFROAD + 0.01;
            if (hasK) {
                roadCells++;
                if (nextHop_pharr[i] === -1 && G[i] < 0.001) {
                    deadEndCells++;  // Road cell with no path to sink (not a sink itself)
                }
            }
        }

        console.log(`[FIELD Physics] totalRho=${totalRho.toFixed(0)} sourceSum=${sourceSum.toFixed(3)} injected=${metrics.injectedThisTick.toFixed(3)}`);
        console.log(`[GRAPH] roadCells=${roadCells} deadEndCells=${deadEndCells}`);

        // PATH TRACE via nextHop_pharr (graph-based, matches cleared mass physics)
        if (sinkCellIndices.length > 0) {
            const sinkIdx = sinkCellIndices[0];
            const sinkX = sinkIdx % N, sinkY = Math.floor(sinkIdx / N);
            let srcIdx = -1;
            for (let i = 0; i < N2; i++) { if (S[i] > 0) { srcIdx = i; break; } }
            if (srcIdx >= 0) {
                const srcX = srcIdx % N, srcY = Math.floor(srcIdx / N);
                console.log(`[PATH] Source(${srcX},${srcY}) phi_pharr=${phi_pharr[srcIdx].toFixed(0)} -> Sink(${sinkX},${sinkY}) phi_pharr=${phi_pharr[sinkIdx].toFixed(0)}`);

                // Follow nextHop_pharr chain (cleared mass routing)
                let trace = [];
                let idx = srcIdx;
                for (let step = 0; step < 200; step++) {
                    const cx = idx % N, cy = Math.floor(idx / N);
                    const nh = nextHop_pharr[idx];
                    if (nh === -1) {
                        if (G[idx] > 0.001) {
                            trace.push(`SINK(${cx},${cy})`);
                        } else {
                            trace.push(`DEAD_END(${cx},${cy}) phi=${phi_pharr[idx].toFixed(0)}`);
                        }
                        break;
                    }
                    if (step % 20 === 0) {
                        trace.push(`(${cx},${cy})`);
                    }
                    idx = nh;
                }
                console.log(`[PATH nextHop_pharr] ${trace.slice(0,10).join('->')}${trace.length>10?'...':''}`);
            }
        }

        // Mass balance check
        const injected = metrics.injectedThisTick;
        const drained = metrics.drainedThisTick;
        const delta = injected - drained;
        console.log(`[MASS] injected=${injected.toFixed(3)} drained=${drained.toFixed(3)} total=${totalRho.toFixed(0)} delta=${delta.toFixed(3)}`);

        // Failure warnings
        if (roadCells > 0 && deadEndCells / roadCells > 0.1) {
            console.log(`[FIELD WARN] ${(100*deadEndCells/roadCells).toFixed(1)}% dead-end road cells - check graph connectivity`);
        }

        if (injected > 0.1 && drained < 0.001) {
            console.log('[FIELD WARN] drained=0 while injected>0 - sink not draining');

            // Diagnostic: find where mass is accumulating
            let maxRhoIdx = 0, maxRhoVal = 0;
            for (let i = 0; i < N2; i++) {
                const rho = rho_restricted[i] + rho_cleared[i];
                if (rho > maxRhoVal) {
                    maxRhoVal = rho;
                    maxRhoIdx = i;
                }
            }
            const maxX = maxRhoIdx % N;
            const maxY = Math.floor(maxRhoIdx / N);
            const maxPhi = phi_pharr[maxRhoIdx];
            const maxNh = nextHop_pharr[maxRhoIdx];

            // Get sink center for distance comparison
            const sinkIdx = sinkCellIndices.length > 0 ? sinkCellIndices[Math.floor(sinkCellIndices.length / 2)] : 0;
            const sinkX = sinkIdx % N;
            const sinkY = Math.floor(sinkIdx / N);
            const distToSink = Math.hypot(maxX - sinkX, maxY - sinkY) * roi.cellSize;

            console.log(`[MASS ACCUM] peak at field(${maxX},${maxY}) rho=${maxRhoVal.toFixed(1)} phi=${maxPhi.toFixed(1)} nextHop=${maxNh} distToSink=${(distToSink/1000).toFixed(1)}km`);
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// DUAL POTENTIAL FIELDS (Routing Authority Invariant)
// phi_pharr: cleared mass → PHARR sinks
// phi_lots: restricted mass → lot sinks
// ───────────────────────────────────────────────────────────────────────────────

// Dirty flag - rebuild potentials when K or sinks change
let phiBaseDirty = true;
let _phiRebuildInProgress = false;
let _phiRebuildPending = false;  // FIX E: Coalesce triggers during rebuild
let _nextHopBuilt = false;

// ═══════════════════════════════════════════════════════════════════════════════
// CAPACITY REBUILD DEBOUNCE (CAPACITY-ONLY)
// Schedule pattern: don't skip rebuilds, schedule them for later.
// DOES NOT apply to topology / K / geometry rebuilds.
// ═══════════════════════════════════════════════════════════════════════════════
const REBUILD_DEBOUNCE_MS = 1500;
let _pendingCapacityRebuild = false;
let _nextCapacityRebuildAtMs = 0;

function requestCapacityRebuild() {
    _pendingCapacityRebuild = true;
    _nextCapacityRebuildAtMs = Math.max(_nextCapacityRebuildAtMs, Date.now() + REBUILD_DEBOUNCE_MS);
}

function maybeRunCapacityRebuild() {
    if (!_pendingCapacityRebuild) return;
    if (Date.now() < _nextCapacityRebuildAtMs) return;

    _pendingCapacityRebuild = false;
    phiBaseDirty = true;
    console.log(`[LOTS] Running scheduled capacity rebuild`);
}

export function isPhiRebuilding() {
    return _phiRebuildInProgress;
}

/**
 * Get lot utilization for soft capacity bias during phi_lots computation.
 * Returns utilization in [0, 1] or 0 if cell is not a lot.
 * @param {number} cellIdx - Cell index
 * @returns {number} Utilization fraction
 */
function getLotUtilization(cellIdx) {
    if (lotCapacityKg.length === 0) return 0;
    const lotIdx = cellToLotIndex[cellIdx];
    if (lotIdx < 0 || lotIdx >= lotCapacityKg.length) return 0;
    const cap = lotCapacityKg[lotIdx];
    if (cap <= 0) return 0;
    return Math.min(1.0, lotCurrentMassKg[lotIdx] / cap);
}

/**
 * Generic Dijkstra: compute geodesic distance from each traversable cell to given sinks.
 * @param {number[]} sinkIndices - Array of sink cell indices
 * @param {Float32Array} phiOutput - Output potential array
 * @param {string} label - Label for logging (e.g., 'PHARR' or 'LOTS')
 * @param {boolean} applyCapacityBias - If true, apply soft capacity penalty for lot cells (FIX 1)
 * @returns {Promise<{reachable: number, minPhi: number, maxPhi: number}>}
 */
async function computePotentialToSinks(sinkIndices, phiOutput, label, applyCapacityBias = false, fullLotMask = null) {
    const t0 = performance.now();

    // Initialize: all cells = LARGE
    phiOutput.fill(PHI_LARGE);

    if (sinkIndices.length === 0) {
        console.log(`[DIJKSTRA ${label}] No sinks, skipping`);
        return { reachable: 0, minPhi: PHI_LARGE, maxPhi: 0 };
    }

    // K threshold for road cells
    const K_THRESHOLD = 0.01;

    // Edge cost = physical distance between adjacent cells
    const edgeCost = roi.cellSize;

    // Initialize sink cells and seed the priority queue
    const heap = new MinHeap();
    for (const idx of sinkIndices) {
        phiOutput[idx] = PHI_SINK;
        heap.push([PHI_SINK, idx]);
    }

    console.log(`[DIJKSTRA ${label}] Starting: sinkCells=${sinkIndices.length} edgeCost=${edgeCost.toFixed(1)}m`);

    // Progress tracking
    let processedCount = 0;
    let addedCount = 0;
    let skippedVisited = 0;
    const YIELD_INTERVAL = 1000;
    const visited = new Uint8Array(N2);
    if (_phiProgressCallback) _phiProgressCallback(0, N2);

    let totalPops = 0;
    while (!heap.isEmpty()) {
        const [cost, idx] = heap.pop();
        totalPops++;

        if (visited[idx]) {
            skippedVisited++;
            continue;
        }
        visited[idx] = 1;
        processedCount++;

        // ═══════════════════════════════════════════════════════════════════
        // PHARR INVARIANT: Lots are NOT intermediate nodes.
        // Lot cells can RECEIVE phi (from adjacent roads), enabling exit routing.
        // But lot cells do NOT propagate phi further (no routing THROUGH lots).
        // This ensures nextHop_pharr never needs to point through a lot.
        // ═══════════════════════════════════════════════════════════════════
        if (label === 'PHARR' && regionMap[idx] === REGION_LOT) {
            continue;  // Skip neighbor expansion - lot is a sink for PHARR propagation
        }

        // Check 4-connected neighbors (orthogonal only - no corner cutting)
        const x = idx % N;
        const y = Math.floor(idx / N);

        const neighbors = [];
        if (x > 0) neighbors.push([idx - 1, 1]);
        if (x < N - 1) neighbors.push([idx + 1, 1]);
        if (y > 0) neighbors.push([idx - N, 1]);
        if (y < N - 1) neighbors.push([idx + N, 1]);

        for (const [ni, costMult] of neighbors) {
            // CRITICAL: Skip non-road cells entirely — don't waste cycles on 3M+ off-road cells
            const neighborHasK = Kxx[ni] > K_THRESHOLD || Kyy[ni] > K_THRESHOLD;
            if (!neighborHasK) continue;

            // If computing LOTS routing, treat FULL lots as obstacles (not just "not sinks").
            // Otherwise nextHop_lots can keep pointing into a full lot boundary, causing
            // repeated rejections and apparent "stuck outside lot" behavior.
            if (label === 'LOTS' && fullLotMask) {
                const neighborIsLot = regionMap[ni] === REGION_LOT;
                if (neighborIsLot) {
                    const lotIdx = cellToLotIndex[ni];
                    if (lotIdx >= 0 && lotIdx < fullLotMask.length && fullLotMask[lotIdx]) {
                        continue;
                    }
                }
            }

            const roadTypeCost = roadTypeMap[ni] === ROAD_TYPE_CITY ? CITY_ROAD_COST_MULT : 1.0;

            // ═══════════════════════════════════════════════════════════════════
            // LOT TRAVERSAL PENALTY — Prefer roads over lot perimeters
            // Lots/parks stamped against roads have K>0, making them "passable".
            // Without this penalty, Dijkstra treats lot cells equally to road cells,
            // causing mass to cut through lot perimeters instead of staying on roads.
            // ═══════════════════════════════════════════════════════════════════
            const LOT_TRAVERSAL_COST_MULT = 3.0;  // Lot cells cost 3x more to traverse
            const neighborIsLot = regionMap[ni] === REGION_LOT;
            const lotTraversalCost = neighborIsLot ? LOT_TRAVERSAL_COST_MULT : 1.0;

            // ═══════════════════════════════════════════════════════════════════
            // FIX 1: SOFT CAPACITY BIAS — ENTRY TRANSITION PENALTY
            // Apply penalty ONLY on road→lot transition (first entry into lot).
            // This makes "cost to enter lot A" rise as lot A fills, causing
            // routing to prefer less-full lots at the decision boundary.
            // Penalty inside lot cells would be too late — routing already decided.
            // ═══════════════════════════════════════════════════════════════════
            let capacityPenalty = 1.0;
            if (applyCapacityBias) {
                const currIsLot = regionMap[idx] === REGION_LOT;
                // Only penalize on ENTRY: current cell is NOT lot, neighbor IS lot
                if (!currIsLot && neighborIsLot) {
                    const util = getLotUtilization(ni);
                    capacityPenalty = 1.0 + SOFT_CAPACITY_ALPHA * Math.pow(util, SOFT_CAPACITY_BETA);
                }
            }

            const newCost = cost + edgeCost * costMult * roadTypeCost * lotTraversalCost * capacityPenalty;

            if (newCost < phiOutput[ni]) {
                phiOutput[ni] = newCost;
                heap.push([phiOutput[ni], ni]);
                addedCount++;
            }
        }

        // Yield periodically for UI responsiveness
        if (totalPops % YIELD_INTERVAL === 0) {
            if (_phiProgressCallback) _phiProgressCallback(processedCount, N2);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    // Compute stats
    let minPhi = Infinity, maxPhi = -Infinity, reachableCount = 0;
    for (let i = 0; i < N2; i++) {
        if (phiOutput[i] < minPhi) minPhi = phiOutput[i];
        if (phiOutput[i] < PHI_LARGE && phiOutput[i] > maxPhi) maxPhi = phiOutput[i];
        if (phiOutput[i] < PHI_LARGE) reachableCount++;
    }

    const elapsed = performance.now() - t0;
    console.log(`[DIJKSTRA ${label}] Complete in ${elapsed.toFixed(1)}ms: processed=${processedCount} reachable=${reachableCount} min=${minPhi.toFixed(0)} max=${maxPhi < PHI_LARGE ? maxPhi.toFixed(0) : 'LARGE'}`);

    return { reachable: reachableCount, minPhi, maxPhi };
}

/**
 * Build next-hop table from a potential field.
 * nextHop[i] = neighbor index with strictly lower phi, or -1 if sink/dead-end.
 * @param {Float32Array} phiInput - Potential field to derive from
 * @param {Int32Array} nhOutput - Output next-hop array
 * @param {string} label - Label for logging
 * @param {number[]|null} precomputedRoadCells - Optional pre-computed road cell list (avoids 3.24M scan)
 * @returns {number[]} - Road cell indices (for sparse iteration)
 */
function buildNextHopFromPhi(phiInput, nhOutput, label, precomputedRoadCells = null) {
    let roadCells = precomputedRoadCells;
    let deadEnds = 0;
    let sinkCount = 0;

    // If no precomputed list, scan once (slow path - only used during init)
    if (!roadCells) {
        roadCells = [];
        for (let idx = 0; idx < N2; idx++) {
            if (!isRoad(idx)) {
                nhOutput[idx] = -1;
                continue;
            }
            roadCells.push(idx);
        }
    } else {
        // Fast path: initialize all cells to -1 first, then process only road cells
        nhOutput.fill(-1);
    }

    // Build next-hop for known road cells only
    for (const idx of roadCells) {
        const x = idx % N;
        const y = (idx / N) | 0;
        const phiC = phiInput[idx];

        // Sink cells have phi=0, no next hop needed
        if (phiC < 1) {
            nhOutput[idx] = -1;
            sinkCount++;
            continue;
        }

        let best = -1;
        let bestPhi = phiC;
        let fallback = -1;       // Any valid road neighbor (for local minima escape)
        let fallbackPhi = Infinity;

        // For PHARR routing: avoid lot neighbors unless exiting from lot (prevents routing THROUGH lots)
        const currentIsLot = regionMap[idx] === REGION_LOT;
        const isPharrRouting = label === 'PHARR';
        const shouldAvoidLot = (n) => isPharrRouting && !currentIsLot && regionMap[n] === REGION_LOT;

        // Check neighbor for best (strictly lower phi) and fallback (any valid)
        const chk = (n) => {
            if (!isRoad(n) || shouldAvoidLot(n)) return;
            const p = phiInput[n];
            if (p < bestPhi) { bestPhi = p; best = n; }
            if (p < fallbackPhi) { fallbackPhi = p; fallback = n; }
        };

        // Check 4-neighbors for lowest phi among roads (orthogonal only - no corner cutting)
        if (x > 0) chk(idx - 1);
        if (x < N - 1) chk(idx + 1);
        if (y > 0) chk(idx - N);
        if (y < N - 1) chk(idx + N);

        // Use fallback if no strictly-lower neighbor exists (escapes local minima)
        nhOutput[idx] = (best >= 0) ? best : fallback;
        if (best === -1) deadEnds++;
    }

    console.log(`[NEXTHOP ${label}] built: roadCells=${roadCells.length} sinks=${sinkCount} deadEnds=${deadEnds}`);

    // DEBUG: Check lot cells specifically
    if (label === 'PHARR' && lotCellIndices.length > 0) {
        let lotCellsWithRoute = 0, lotCellsDeadEnd = 0, lotCellsPointToLot = 0;
        let sampleIdx = -1, sampleNh = -1;
        for (const idx of lotCellIndices) {
            if (nhOutput[idx] >= 0) {
                lotCellsWithRoute++;
                if (regionMap[nhOutput[idx]] === REGION_LOT) lotCellsPointToLot++;
                if (sampleIdx < 0) { sampleIdx = idx; sampleNh = nhOutput[idx]; }
            }
            else lotCellsDeadEnd++;
        }
        console.log(`[NEXTHOP PHARR] lot cells: ${lotCellsWithRoute}/${lotCellIndices.length} have route, ${lotCellsDeadEnd} dead-ends, ${lotCellsPointToLot} point to other lots`);
        if (sampleIdx >= 0) {
            const delta = phiInput[sampleIdx] - phiInput[sampleNh];
            console.log(`[NEXTHOP PHARR] phi gradient: lot[${sampleIdx}]=${phiInput[sampleIdx].toFixed(0)} -> nh[${sampleNh}]=${phiInput[sampleNh].toFixed(0)}, delta=${delta.toFixed(0)} (must be >0 for flow)`);
        }
    }

    return roadCells;
}

/**
 * Rebuild dual potential fields (phi_pharr, phi_lots) and next-hop tables.
 * Called ONLY when K tensor or sink geometry changes.
 *
 * DUAL POTENTIAL ROUTING AUTHORITY:
 * - phi_pharr: cleared mass routes toward PHARR sinks
 * - phi_lots: restricted mass routes toward lot sinks (for transfer dwell)
 *
 * FIX 4: ATOMIC ROUTING SWAP
 * Compute into shadow buffers while old routing remains active.
 * Only swap to main buffers at completion. No flow freeze during rebuild.
 */
async function rebuildPhiBase() {
    // ═══════════════════════════════════════════════════════════════════════════════
    // FIX E: REBUILD MUTEX
    // If rebuild already in progress, set pending flag and return.
    // Prevents interleaved async state corruption of shadow buffers.
    // ═══════════════════════════════════════════════════════════════════════════════
    if (_phiRebuildInProgress) {
        _phiRebuildPending = true;
        console.log(`[FIX E] Rebuild already in progress - coalescing trigger`);
        return;
    }

    _phiRebuildInProgress = true;
    _phiRebuildPending = false;  // Clear pending flag at start
    // FIX 4: Do NOT set _nextHopBuilt = false here - old routing stays active
    const t0 = performance.now();

    try {
        // Snapshot full lots NOW at rebuild start (before async Dijkstra)
        _fullLotsSnapshot = lotIsFull.map((f, i) => f ? i : -1).filter(i => i >= 0);
        console.log(`[FIELD] rebuildPhiBase: computing dual potentials... (${_fullLotsSnapshot.length} lots at >=90%: [${_fullLotsSnapshot.slice(0,5).join(',')}${_fullLotsSnapshot.length > 5 ? '...' : ''}])`);

        // ═══════════════════════════════════════════════════════════════════════════════
        // FORENSIC DIAGNOSTICS - remove after debugging
        // ═══════════════════════════════════════════════════════════════════════════════
        console.log(`\n=== DUAL-POTENTIAL FORENSICS ===`);

        // 1. Lot sink availability
        const uniqueLots = new Set();
        for (const cellIdx of lotCellIndices) {
            const lotIdx = cellToLotIndex[cellIdx];
            if (lotIdx >= 0) uniqueLots.add(lotIdx);
        }
        console.log(`[FORENSIC] Total lots: ${lotCapacityKg.length}, unique in lotCellIndices: ${uniqueLots.size}`);
        console.log(`[FORENSIC] lotIsFull array length: ${lotIsFull.length}, full count: ${lotIsFull.filter(f => f).length}`);
        console.log(`[FORENSIC] lotIsFull sample: [${lotIsFull.slice(0, 10).map(f => f ? '1' : '0').join('')}${lotIsFull.length > 10 ? '...' : ''}]`);
        console.log(`[FORENSIC] _fullLotsSnapshot: [${_fullLotsSnapshot.slice(0, 10).join(',')}${_fullLotsSnapshot.length > 10 ? '...' : ''}] (${_fullLotsSnapshot.length} total)`);

        // 2. Available lot cells breakdown by lot
        const availableLotCellsPreview = getAvailableLotCells();
        const cellsPerLot = new Map();
        for (const cellIdx of availableLotCellsPreview) {
            const lotIdx = cellToLotIndex[cellIdx];
            cellsPerLot.set(lotIdx, (cellsPerLot.get(lotIdx) || 0) + 1);
        }
        const lotCounts = [...cellsPerLot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        console.log(`[FORENSIC] Top 5 lots by available sink cells: ${lotCounts.map(([l, c]) => `lot${l}=${c}`).join(', ')}`);
        console.log(`[FORENSIC] Total lots with available cells: ${cellsPerLot.size}`);
        console.log(`[FORENSIC] Total available lot cells: ${availableLotCellsPreview.length}/${lotCellIndices.length}`);

        // 3. K tensor check for lot cells
        let lotCellsWithK = 0, lotCellsZeroK = 0;
        for (const idx of lotCellIndices.slice(0, 100)) {
            if (Kxx[idx] > 0.01 || Kyy[idx] > 0.01) lotCellsWithK++;
            else lotCellsZeroK++;
        }
        console.log(`[FORENSIC] K tensor (first 100 lot cells): ${lotCellsWithK} have K>0.01, ${lotCellsZeroK} have K<=0.01`);
        // ═══════════════════════════════════════════════════════════════════════════════

        // ═══════════════════════════════════════════════════════════════════════════════
        // FIX 4: COMPUTE INTO SHADOW BUFFERS (old routing stays active during this)
        // ═══════════════════════════════════════════════════════════════════════════════

        // 1. Compute phi_pharr (PHARR sinks) - for cleared mass → into shadow buffer
        // Compute phi_pharr: lots are reachable (for conversion-cleared exit), but nextHop avoids routing through them
        const pharrStats = await computePotentialToSinks(sinkCellIndices, _shadow_phi_pharr, 'PHARR');

        // 2. Compute phi_lots (lot sinks) - for restricted mass → into shadow buffer
        // DYNAMIC SINKS: Exclude lots at capacity (>90%). Mass re-routes to next-closest lot.
        // FIX 1: Pass applyCapacityBias=true for soft capacity weighting during Dijkstra
        const availableLotCells = getAvailableLotCells();
        console.log(`[FIELD] Computing phi_lots (restricted -> LOTS) with soft capacity bias... (${availableLotCells.length}/${lotCellIndices.length} available lot cells as sinks)`);
        // Snapshot full lots into a mask for this rebuild (stable during async Dijkstra)
        const fullLotMask = new Uint8Array(lotCapacityKg.length);
        for (const li of _fullLotsSnapshot) {
            if (li >= 0 && li < fullLotMask.length) fullLotMask[li] = 1;
        }
        const lotsStats = await computePotentialToSinks(availableLotCells, _shadow_phi_lots, 'LOTS', true, fullLotMask);

        // 3. Pre-compute road cell indices once (reuse for both PHARR and LOTS)
        // This avoids scanning 6.48M cells (3.24M × 2) — now scans ~57k cells instead
        // CRITICAL: Include lot cells even if isRoad() is false — cleared mass must exit lots
        const precomputedRoadCells = [];
        for (let idx = 0; idx < N2; idx++) {
            if (isRoad(idx) || regionMap[idx] === REGION_LOT) {
                precomputedRoadCells.push(idx);
            }
        }
        console.log(`[NEXTHOP] Pre-computed ${precomputedRoadCells.length} traversable cells (roads + lots)`);

        // 4. Build next-hop tables → into shadow buffers (using pre-computed list)
        buildNextHopFromPhi(_shadow_phi_pharr, _shadow_nextHop_pharr, 'PHARR', precomputedRoadCells);
        buildNextHopFromPhi(_shadow_phi_lots, _shadow_nextHop_lots, 'LOTS', precomputedRoadCells);
        _shadowRoadCellIndices = precomputedRoadCells.slice();  // Copy for later use

        // ═══════════════════════════════════════════════════════════════════════════════
        // DIAGNOSTIC: φ_lots COMPETITION ANALYSIS (ONCE PER REBUILD)
        // Sample upstream road cells, walk nextHop_lots to see which lots win routing.
        // Remove after diagnosis.
        // ═══════════════════════════════════════════════════════════════════════════════
        {
            const SAMPLE_SIZE = 50;
            const lotHits = new Map();  // lotIdx → count
            let sampledCount = 0;
            let reachedLotCount = 0;

            // Sample non-lot road cells with valid phi_lots
            const candidates = [];
            for (const idx of precomputedRoadCells) {
                if (regionMap[idx] !== REGION_LOT && _shadow_phi_lots[idx] < PHI_LARGE) {
                    candidates.push(idx);
                }
            }

            // Sample evenly across candidates
            const step = Math.max(1, Math.floor(candidates.length / SAMPLE_SIZE));
            for (let i = 0; i < candidates.length && sampledCount < SAMPLE_SIZE; i += step) {
                const srcIdx = candidates[i];
                sampledCount++;

                // Walk nextHop_lots until reaching a lot sink
                let idx = srcIdx;
                let reachedLotIdx = -1;
                for (let s = 0; s < 500; s++) {
                    if (regionMap[idx] === REGION_LOT) {
                        reachedLotIdx = cellToLotIndex[idx];
                        break;
                    }
                    const nh = _shadow_nextHop_lots[idx];
                    if (nh < 0) break;  // dead end
                    idx = nh;
                }

                if (reachedLotIdx >= 0) {
                    reachedLotCount++;
                    lotHits.set(reachedLotIdx, (lotHits.get(reachedLotIdx) || 0) + 1);
                }
            }

            // Sort and print top 10
            const sorted = [...lotHits.entries()].sort((a, b) => b[1] - a[1]);
            const top10 = sorted.slice(0, 10);
            const lines = top10.map(([lotIdx, hits]) => `  lot ${lotIdx} -> ${hits} hits`);

            console.log(`[LOTS-COMPETE] phi_lots entry winners (${reachedLotCount}/${sampledCount} reached lots, ${lotHits.size} distinct):`);
            for (const line of lines) {
                console.log(line);
            }

            // Count lots with road-adjacent boundary cells
            const lotsWithRoadAccess = new Set();
            for (const cellIdx of lotCellIndices) {
                const lotIdx = cellToLotIndex[cellIdx];
                const x = cellIdx % N, y = Math.floor(cellIdx / N);
                const neighbors = [
                    x > 0 ? cellIdx - 1 : -1,
                    x < N-1 ? cellIdx + 1 : -1,
                    y > 0 ? cellIdx - N : -1,
                    y < N-1 ? cellIdx + N : -1,
                ];
                for (const ni of neighbors) {
                    if (ni >= 0 && regionMap[ni] !== REGION_LOT && _shadow_phi_lots[ni] < PHI_LARGE) {
                        lotsWithRoadAccess.add(lotIdx);
                        break;
                    }
                }
            }
            const totalLots = new Set([...lotCellIndices].map(c => cellToLotIndex[c])).size;
            console.log(`[LOTS-COMPETE] Road access: ${lotsWithRoadAccess.size}/${totalLots} lots reachable from road network`);

            // Lots with 0 hits but road access (bypassed lots)
            const bypassedLots = [...lotsWithRoadAccess].filter(li => !lotHits.has(li));
            if (bypassedLots.length > 0) {
                console.log(`[LOTS-COMPETE] BYPASSED: ${bypassedLots.length} lots have road access but got 0 routing hits`);
            }
        }

        // ═══════════════════════════════════════════════════════════════════════════════
        // FIX 3: ENSURE LOT CELLS IN ROAD ITERATION SET
        // Lot cells must be iterable by graphFlowClass for cleared mass to exit.
        // Add any lot cells not already in roadCellIndices.
        // ═══════════════════════════════════════════════════════════════════════════════
        const roadSet = new Set(_shadowRoadCellIndices);
        let addedLotCells = 0;
        for (const idx of lotCellIndices) {
            if (!roadSet.has(idx)) {
                _shadowRoadCellIndices.push(idx);
                roadSet.add(idx);
                addedLotCells++;
            }
        }
        if (addedLotCells > 0) {
            console.log(`[FIX 3] Added ${addedLotCells} lot cells to roadCellIndices for flow iteration`);
        }

        // ═══════════════════════════════════════════════════════════════════════════════
        // FIX 4: ATOMIC SWAP - Copy shadow → main in one go
        // Flow continues using old routing until this point, then atomically switches.
        // ═══════════════════════════════════════════════════════════════════════════════
        phi_pharr.set(_shadow_phi_pharr);
        phi_lots.set(_shadow_phi_lots);
        nextHop_pharr.set(_shadow_nextHop_pharr);
        nextHop_lots.set(_shadow_nextHop_lots);
        roadCellIndices = _shadowRoadCellIndices.slice();  // Copy array

        _nextHopBuilt = true;
        console.log(`[FIX 4] Atomic routing swap complete - flow resumes with new routing`);

        // PHI AUDIT: Source reachability for phi_pharr
        for (let i = 0; i < Math.min(5, corridorEntryPoints.length); i++) {
            const entry = corridorEntryPoints[i];
            const idx = entry.fieldY * N + entry.fieldX;
            const phiVal = idx >= 0 && idx < N2 ? phi_pharr[idx] : PHI_LARGE;
            console.log(`[PHI AUDIT] source ${entry.segmentId} phi_pharr=${phiVal < PHI_LARGE ? phiVal.toFixed(2) : 'UNREACHABLE'}`);
        }

        // Road connectivity diagnostic
        let roadCellsTotal = 0, roadCellsReachablePharr = 0, roadCellsReachableLots = 0;
        for (let idx = 0; idx < N2; idx++) {
            if (isRoad(idx)) {
                roadCellsTotal++;
                if (phi_pharr[idx] < PHI_LARGE) roadCellsReachablePharr++;
                if (phi_lots[idx] < PHI_LARGE) roadCellsReachableLots++;
            }
        }
        console.log(`[FIELD] Road connectivity: PHARR=${roadCellsReachablePharr}/${roadCellsTotal} LOTS=${roadCellsReachableLots}/${roadCellsTotal}`);

        // HIGH-SIGNAL: Lot cell traversability audit
        // This confirms whether lot cells are in roadCellIndices and have valid nextHop_pharr
        if (lotCellIndices.length > 0) {
            const roadSet = new Set(roadCellIndices);
            let lotInRoad = 0, lotWithPharrRoute = 0, lotWithLotsRoute = 0;
            let lotRoutesToRoad = 0, lotRoutesToLot = 0, lotDeadEnd = 0;

            for (const idx of lotCellIndices) {
                if (roadSet.has(idx)) lotInRoad++;
                if (nextHop_pharr[idx] >= 0) {
                    lotWithPharrRoute++;
                    if (regionMap[nextHop_pharr[idx]] !== REGION_LOT) lotRoutesToRoad++;
                    else lotRoutesToLot++;
                } else {
                    lotDeadEnd++;
                }
                if (nextHop_lots[idx] >= 0) lotWithLotsRoute++;
            }

            console.log(`[LOT TRAVERSABILITY] in roadCellIndices: ${lotInRoad}/${lotCellIndices.length}`);
            console.log(`[LOT TRAVERSABILITY] nextHop_pharr: ${lotWithPharrRoute} valid (${lotRoutesToRoad}->road, ${lotRoutesToLot}->lot), ${lotDeadEnd} dead-ends`);
            console.log(`[LOT TRAVERSABILITY] nextHop_lots: ${lotWithLotsRoute}/${lotCellIndices.length} valid (rest are sinks)`);

            // Sample 3 lot cells for detailed trace
            const samples = lotCellIndices.slice(0, 3);
            for (const idx of samples) {
                console.log(`[LOT SAMPLE] idx=${idx} K=${Kxx[idx].toFixed(2)} phi_pharr=${phi_pharr[idx] < PHI_LARGE ? phi_pharr[idx].toFixed(0) : 'UNREACH'} nh_pharr=${nextHop_pharr[idx]} inRoad=${roadSet.has(idx)}`);
            }

            // ═══════════════════════════════════════════════════════════════════════════════
            // FORENSIC PATH TRACES - remove after debugging
            // ═══════════════════════════════════════════════════════════════════════════════

            // PATH TRACE: Restricted from source to lot
            console.log(`[FORENSIC] === PATH TRACE: restricted mass (nextHop_lots) ===`);
            // Use actual source cells, not corridor entry points
            const actualSourceIdx = sourceCellIndices.length > 0 ? sourceCellIndices[0] : -1;
            if (actualSourceIdx >= 0) {
                const srcX = actualSourceIdx % N, srcY = Math.floor(actualSourceIdx / N);
                const srcIsLot = regionMap[actualSourceIdx] === REGION_LOT;
                const srcPhiLots = phi_lots[actualSourceIdx] < PHI_LARGE ? phi_lots[actualSourceIdx].toFixed(0) : 'UNREACH';
                let trace = [`src(${srcX},${srcY}) idx=${actualSourceIdx} isLot=${srcIsLot} phi_lots=${srcPhiLots}`];
                let idx = actualSourceIdx;
                let hitLot = false;
                let lastRegion = regionMap[idx];
                for (let step = 0; step < 200 && !hitLot; step++) {
                    const nh = nextHop_lots[idx];
                    if (nh < 0) {
                        if (regionMap[idx] === REGION_LOT) {
                            trace.push(`LOT_SINK(phi=${phi_lots[idx].toFixed(0)})`);
                        } else if (G[idx] > 0.001) {
                            trace.push(`PHARR_SINK`);
                        } else {
                            trace.push(`DEAD_END(phi=${phi_lots[idx] < PHI_LARGE ? phi_lots[idx].toFixed(0) : 'UNREACH'})`);
                        }
                        break;
                    }
                    if (regionMap[nh] === REGION_LOT && lastRegion !== REGION_LOT) {
                        trace.push(`->LOT@step${step}`);
                        hitLot = true;
                    }
                    lastRegion = regionMap[nh];
                    idx = nh;
                }
                console.log(`[FORENSIC] restricted path: ${trace.join('')}`);
            }

            // PATH TRACE: Cleared from lot to PHARR
            console.log(`[FORENSIC] === PATH TRACE: cleared mass from lot (nextHop_pharr) ===`);
            const sampleLotIdx = lotCellIndices[0];
            if (sampleLotIdx !== undefined) {
                const lx = sampleLotIdx % N, ly = Math.floor(sampleLotIdx / N);
                let trace = [`lot(${lx},${ly})`];
                let idx = sampleLotIdx;
                let reachedRoad = false;
                for (let step = 0; step < 200; step++) {
                    const nh = nextHop_pharr[idx];
                    if (nh < 0) {
                        if (G[idx] > 0.001) {
                            trace.push(`->PHARR_SINK`);
                        } else {
                            trace.push(`->DEAD_END(phi=${phi_pharr[idx] < PHI_LARGE ? phi_pharr[idx].toFixed(0) : 'UNREACH'})`);
                        }
                        break;
                    }
                    // Log when we exit lot region
                    if (!reachedRoad && regionMap[nh] !== REGION_LOT) {
                        trace.push(`->ROAD@step${step}`);
                        reachedRoad = true;
                    }
                    idx = nh;
                }
                if (!trace.some(t => t.includes('SINK') || t.includes('DEAD_END'))) {
                    trace.push(`->...@200steps`);
                }
                console.log(`[FORENSIC] cleared path: ${trace.join('')}`);
                console.log(`[FORENSIC] lot cell ${sampleLotIdx}: phi_pharr=${phi_pharr[sampleLotIdx] < PHI_LARGE ? phi_pharr[sampleLotIdx].toFixed(0) : 'UNREACH'}, nextHop=${nextHop_pharr[sampleLotIdx]}, inRoadCellIndices=${roadSet.has(sampleLotIdx)}`);
            }

            // ═══════════════════════════════════════════════════════════════════════════════
            // DECISIVE NEXTHOPLOTSS HEALTH DIAGNOSTICS
            // ═══════════════════════════════════════════════════════════════════════════════
            console.log(`[FORENSIC] === NEXTHOP_LOTS HEALTH CHECK ===`);

            // 1. Count road cells with valid phi_lots and nextHop_lots
            let roadWithPhiLots = 0, roadWithNhLots = 0, lotSinkCells = 0, roadDeadEndsNoLot = 0;
            for (const idx of roadCellIndices) {
                if (phi_lots[idx] < PHI_LARGE) roadWithPhiLots++;
                if (nextHop_lots[idx] >= 0) roadWithNhLots++;
                else if (regionMap[idx] === REGION_LOT) lotSinkCells++;  // Arrived at lot sink
                else roadDeadEndsNoLot++;  // Dead-end NOT in a lot = fractured graph
            }
            console.log(`[FORENSIC] Road cells: ${roadCellIndices.length} total`);
            console.log(`[FORENSIC]   phi_lots < LARGE: ${roadWithPhiLots} (${(100*roadWithPhiLots/roadCellIndices.length).toFixed(0)}%)`);
            console.log(`[FORENSIC]   nextHop_lots >= 0: ${roadWithNhLots} (${(100*roadWithNhLots/roadCellIndices.length).toFixed(0)}%)`);
            console.log(`[FORENSIC]   lotSinkCells (nh=-1, regionMap=LOT): ${lotSinkCells}`);
            console.log(`[FORENSIC]   roadDeadEndsNoLot (nh=-1, regionMap!=LOT): ${roadDeadEndsNoLot} (graph fracture indicator)`);

            // 2. Sample from ACTUAL roadCellIndices (not arbitrary 0..1000)
            const sampleSize = Math.min(500, roadCellIndices.length);
            const sampleStep = Math.floor(roadCellIndices.length / sampleSize);
            const lotsReachable = new Set();
            let sampledReachLot = 0, sampledDeadEnd = 0, sampledLoop = 0;

            for (let s = 0; s < sampleSize; s++) {
                const startIdx = roadCellIndices[s * sampleStep];
                if (regionMap[startIdx] === REGION_LOT) continue;  // Skip lot cells

                let idx = startIdx;
                const visited = new Set();
                for (let step = 0; step < 200; step++) {
                    if (visited.has(idx)) { sampledLoop++; break; }
                    visited.add(idx);

                    const nh = nextHop_lots[idx];
                    if (nh < 0) {
                        if (regionMap[idx] === REGION_LOT) {
                            const lotIdx = cellToLotIndex[idx];
                            if (lotIdx >= 0) lotsReachable.add(lotIdx);
                            sampledReachLot++;
                        } else {
                            sampledDeadEnd++;
                        }
                        break;
                    }
                    idx = nh;
                }
            }
            console.log(`[FORENSIC] Sampled ${sampleSize} road cells: ${sampledReachLot} reach lots, ${sampledDeadEnd} dead-ends, ${sampledLoop} loops`);
            console.log(`[FORENSIC] Distinct lots reachable: ${lotsReachable.size} [${[...lotsReachable].slice(0, 10).join(',')}${lotsReachable.size > 10 ? '...' : ''}]`);

            // 3. Source cell diagnostics (if sources exist)
            if (sourceCellIndices.length > 0) {
                console.log(`[FORENSIC] === SOURCE CELL DIAGNOSTICS ===`);
                for (let i = 0; i < Math.min(3, sourceCellIndices.length); i++) {
                    const src = sourceCellIndices[i];
                    const sx = src % N, sy = Math.floor(src / N);
                    console.log(`[FORENSIC] Source[${i}] idx=${src} (${sx},${sy}):`);
                    console.log(`[FORENSIC]   regionMap=${regionMap[src]} (LOT=${REGION_LOT})`);
                    console.log(`[FORENSIC]   phi_lots=${phi_lots[src] < PHI_LARGE ? phi_lots[src].toFixed(0) : 'UNREACH'}`);
                    console.log(`[FORENSIC]   nextHop_lots=${nextHop_lots[src]}`);
                    console.log(`[FORENSIC]   phi_pharr=${phi_pharr[src] < PHI_LARGE ? phi_pharr[src].toFixed(0) : 'UNREACH'}`);
                    console.log(`[FORENSIC]   nextHop_pharr=${nextHop_pharr[src]}`);
                }
            }
            // ═══════════════════════════════════════════════════════════════════════════════
        }

        const elapsed = performance.now() - t0;
        console.log(`[FIELD] rebuildPhiBase complete in ${elapsed.toFixed(1)}ms`);
    } catch (err) {
        console.error(`[FIELD] rebuildPhiBase FAILED:`, err);
    } finally {
        // CRITICAL: Always clear rebuild flags to prevent permanent blockage
        if (_phiProgressCallback) _phiProgressCallback(1, 1);
        _phiRebuildInProgress = false;
        phiBaseDirty = false;
        // If rebuild failed, ensure nextHop is still marked built if we have valid data
        if (roadCellIndices.length > 0) {
            _nextHopBuilt = true;
        }

        // Create unified physics adapter once routing is ready
        createUnifiedAdapterIfReady();

        // ═══════════════════════════════════════════════════════════════════════════════
        // FIX E: PROCESS PENDING REBUILD
        // If another rebuild was requested during this one, trigger it now.
        // ═══════════════════════════════════════════════════════════════════════════════
        if (_phiRebuildPending) {
            console.log(`[FIX E] Processing pending rebuild trigger`);
            _phiRebuildPending = false;
            // Schedule on next tick to avoid deep recursion
            setTimeout(() => rebuildPhiBase(), 0);
        }
    }
}

/**
 * Per-frame potential: copy phi_pharr for visualization.
 * INVARIANT: Density never alters direction.
 */
function computePotentialMultiClass() {
    if (_phiRebuildInProgress) return;

    if (phiBaseDirty) {
        rebuildPhiBase();
        return;
    }

    // Per-frame φ = phi_pharr (visualization uses PHARR potential)
    phi.set(phi_pharr);
}

// ───────────────────────────────────────────────────────────────────────────────
// GRAPH-BASED FLOW (replaces semi-Lagrangian advection)
// Mass flows along shortest-path tree from Dijkstra. Robust, topology-aware.
// CLASS-CONDITIONED ROUTING: restricted → lots, cleared → PHARR
// ───────────────────────────────────────────────────────────────────────────────

const K_ROAD_THRESHOLD = 0.01;  // K > this means "is road"

function isRoad(idx) {
    return (Kxx[idx] > K_ROAD_THRESHOLD) || (Kyy[idx] > K_ROAD_THRESHOLD);
}

/**
 * Road congestion impedance factor.
 * Returns value in (0, 1] that scales outflow based on local density.
 * Only applies to road cells, not lots.
 *
 * C(ρ) = 1 / (1 + (ρ / ρ₀)^p)
 *
 * @param {number} idx - Cell index
 * @returns {number} Impedance factor in (0, 1]
 */
function roadCongestionFactor(idx) {
    // DISABLED FOR TESTING
    return 1.0;

    // // Only apply to road cells, not lots (lots are explicitly immune; document if changed)
    // if (regionMap[idx] === REGION_LOT) return 1.0;

    // // Local density ρ (kg per cell, class-agnostic):
    // // ρ[i] = ρ_restricted[i] + ρ_cleared[i]
    // // Pre-lot holding (rho_restricted_preLot) affects field flow, not congestion scalar
    // const rho = rho_restricted[idx] + rho_cleared[idx];

    // // Rational decay: 1 / (1 + (rho/rho0)^p)
    // const ratio = rho / RHO_CONGESTION_0;
    // return 1 / (1 + Math.pow(ratio, CONGESTION_P));
}

/**
 * Graph-based flow: push mass along next-hop edges.
 * CLASS-CONDITIONED ROUTING (Routing Authority Invariant):
 * - restricted mass follows nextHop_lots (toward lots for transfer dwell)
 * - cleared mass follows nextHop_pharr (toward PHARR for export)
 *
 * @param {string} classId - 'restricted' or 'cleared'
 * @param {Float32Array} rho - Current density
 * @param {Float32Array} rhoNext - Scratch buffer for output
 * @returns {{moved: number, stuck: number}} - Flow stats for logging
 */
const FLOW_FRAC = 0.4;  // 40% of mass moves per tick

// ═══════════════════════════════════════════════════════════════════════════════
// FALLBACK LOT SEARCH (BFS)
// When target lot is full, find nearest lot with remaining capacity.
// This enables automatic load redistribution without waiting for phi rebuild.
// ═══════════════════════════════════════════════════════════════════════════════
const FALLBACK_LOT_SEARCH_RADIUS = 60;  // Max BFS depth (cells)
let _fallbackSearchHits = 0;
let _fallbackSearchMisses = 0;
let _fallbackLogCounter = 0;

/**
 * Find nearest lot cell with remaining capacity via BFS from starting cell.
 * Returns cell index of a lot with capacity, or -1 if none found within radius.
 * @param {number} startIdx - Starting cell index
 * @param {number} excludeLotIdx - Lot index to exclude (the one that's full)
 * @returns {number} Cell index of lot with capacity, or -1
 */
function findNearestLotWithCapacity(startIdx, excludeLotIdx) {
    if (!lotAcceptRemainingKgLive || lotCapacityKg.length === 0) return -1;
    
    const visited = new Set([startIdx]);
    let frontier = [startIdx];
    
    for (let depth = 0; depth < FALLBACK_LOT_SEARCH_RADIUS && frontier.length > 0; depth++) {
        const nextFrontier = [];
        
        for (const idx of frontier) {
            const x = idx % N, y = Math.floor(idx / N);
            
            // Check 8-connected neighbors
            const neighbors = [];
            if (x > 0) neighbors.push(idx - 1);
            if (x < N - 1) neighbors.push(idx + 1);
            if (y > 0) neighbors.push(idx - N);
            if (y < N - 1) neighbors.push(idx + N);
            if (x > 0 && y > 0) neighbors.push(idx - N - 1);
            if (x < N - 1 && y > 0) neighbors.push(idx - N + 1);
            if (x > 0 && y < N - 1) neighbors.push(idx + N - 1);
            if (x < N - 1 && y < N - 1) neighbors.push(idx + N + 1);
            
            for (const ni of neighbors) {
                if (ni < 0 || ni >= N2 || visited.has(ni)) continue;
                visited.add(ni);
                
                // Check if this is a lot cell with capacity
                if (regionMap[ni] === REGION_LOT) {
                    const lotIdx = cellToLotIndex[ni];
                    if (lotIdx >= 0 && lotIdx !== excludeLotIdx) {
                        const remaining = lotAcceptRemainingKgLive[lotIdx] || 0;
                        if (remaining >= TRUCK_KG) {
                            return ni;  // Found a lot with capacity
                        }
                    }
                }
                
                // Only expand through traversable cells (roads or lots)
                const isTraversable = (Kxx[ni] > K_ROAD_THRESHOLD) || 
                                      (Kyy[ni] > K_ROAD_THRESHOLD) || 
                                      (regionMap[ni] === REGION_LOT);
                if (isTraversable) {
                    nextFrontier.push(ni);
                }
            }
        }
        
        frontier = nextFrontier;
    }
    
    return -1;  // No lot with capacity found within radius
}

/**
 * Fisher-Yates shuffle for array (in-place).
 * Uses seedable RNG for reproducibility.
 */
function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

let _graphFlowDebugCounter = 0;
function graphFlowClass(classId, rho, rhoNext) {
    if (!_nextHopBuilt) return { moved: 0, stuck: 0, rejected: 0 };

    // CLASS-CONDITIONED ROUTING: select next-hop table based on class
    const nh_table = (classId === 'restricted') ? nextHop_lots : nextHop_pharr;

    // DEBUG: Check if lot cells are in roadCellIndices (every 120 frames for cleared class)
    if (classId === 'cleared' && _graphFlowDebugCounter++ % 120 === 0) {
        let lotCellsInRoad = 0, clearedInLots = 0;
        let sampleLotWithMass = -1, sampleMass = 0, sampleNh = -1;
        for (const idx of lotCellIndices) {
            if (roadCellIndices.includes(idx)) lotCellsInRoad++;
            const m = rho[idx];
            clearedInLots += m;
            if (m > 0 && sampleLotWithMass < 0) {
                sampleLotWithMass = idx;
                sampleMass = m;
                sampleNh = nh_table[idx];
            }
        }
        console.log(`[GRAPHFLOW DEBUG] lot cells in roadCellIndices: ${lotCellsInRoad}/${lotCellIndices.length}, cleared in lots: ${(clearedInLots/1000).toFixed(1)}t`);
        if (sampleLotWithMass >= 0) {
            const nhRegion = sampleNh >= 0 ? regionMap[sampleNh] : -1;
            const nhIsRoad = sampleNh >= 0 && roadCellIndices.includes(sampleNh);
            console.log(`[CLEARED FLOW] sample lot idx=${sampleLotWithMass} mass=${sampleMass.toFixed(1)}kg nh=${sampleNh} nhRegion=${nhRegion} nhInRoadList=${nhIsRoad}`);
        }
    }

    // SPARSE: zero only road cells
    for (const idx of roadCellIndices) {
        rhoNext[idx] = 0;
    }

    // CRITICAL: Also zero sink cells - they're NOT in roadCellIndices but receive mass
    // Without this, rhoNext[sinkIdx] accumulates infinitely and .set() overwrites drain
    for (const idx of sinkCellIndices) {
        rhoNext[idx] = 0;
    }

    let totalMoved = 0;
    let totalStuck = 0;
    let totalRejected = 0;  // Mass rejected by capacity gating
    let totalEnteredLots = 0;  // Restricted mass accepted into lots this substep

    for (const idx of roadCellIndices) {
        const m = rho[idx];
        if (m <= 0) continue;

        let nh = nh_table[idx];

        // ─────────────────────────────────────────────────────────────────────
        // PROXIMITY CAPTURE (field-authoritative): restricted mass on roads
        // adjacent to lots enters the lot instead of following global Dijkstra.
        // This spreads load across all lots, not just the few that win routing.
        // SHUFFLE neighbors to randomize lot selection and spread load at t=0.
        // ─────────────────────────────────────────────────────────────────────
        if (classId === 'restricted' && regionMap[idx] !== REGION_LOT) {
            const x = idx % N, y = Math.floor(idx / N);
            const neighbors = [];
            // Orthogonal (4-connected)
            if (x > 0) neighbors.push(idx - 1);
            if (x < N - 1) neighbors.push(idx + 1);
            if (y > 0) neighbors.push(idx - N);
            if (y < N - 1) neighbors.push(idx + N);
            // Diagonal (8-connected)
            if (x > 0 && y > 0) neighbors.push(idx - N - 1);
            if (x < N - 1 && y > 0) neighbors.push(idx - N + 1);
            if (x > 0 && y < N - 1) neighbors.push(idx + N - 1);
            if (x < N - 1 && y < N - 1) neighbors.push(idx + N + 1);

            // SHUFFLE to randomize lot selection - prevents all mass funneling to same lots
            shuffleArray(neighbors);

            for (const ni of neighbors) {
                if (regionMap[ni] === REGION_LOT) {
                    const lotIdx = cellToLotIndex[ni];
                    const remaining = (lotIdx >= 0 && lotAcceptRemainingKgLive)
                        ? lotAcceptRemainingKgLive[lotIdx] : 0;
                    if (remaining > 0) {
                        nh = ni;  // Override Dijkstra - use this adjacent lot
                        break;
                    }
                }
            }
        }

        if (nh >= 0) {
        const congestion = roadCongestionFactor(idx);
        // NOTE: effective_rate = base_flow_rate * congestion. Congestion never changes direction.
        const out = m * FLOW_FRAC * congestion;

            // ─────────────────────────────────────────────────────────────
            // CAPACITY GATING: When restricted mass flows into lot cells,
            // apply acceptance multiplier based on lot fill fraction.
            // If lot is full, FALLBACK REROUTE to nearest lot with capacity.
            // Only truly reject if NO lot has capacity within search radius.
            // ─────────────────────────────────────────────────────────────
            if (classId === 'restricted' && regionMap[nh] === REGION_LOT) {
                // Prevent overflow-by-oversubscription within a substep:
                // reserve remaining capacity per-lot as we accept inflows.
                let targetLotCell = nh;
                let lotIdx = cellToLotIndex[targetLotCell];
                let remaining = (lotIdx >= 0 && lotAcceptRemainingKgLive) ? lotAcceptRemainingKgLive[lotIdx] : 0;

                // ═══════════════════════════════════════════════════════════════
                // FALLBACK REROUTING: If target lot is full, find another lot
                // This enables automatic load redistribution without phi rebuild
                // ═══════════════════════════════════════════════════════════════
                if (remaining < TRUCK_KG) {
                    const fallbackCell = findNearestLotWithCapacity(idx, lotIdx);
                    if (fallbackCell >= 0) {
                        targetLotCell = fallbackCell;
                        lotIdx = cellToLotIndex[targetLotCell];
                        remaining = (lotIdx >= 0 && lotAcceptRemainingKgLive) ? lotAcceptRemainingKgLive[lotIdx] : 0;
                        _fallbackSearchHits++;
                    } else {
                        _fallbackSearchMisses++;
                    }
                }

                // Log fallback stats periodically
                if (_fallbackLogCounter++ % 300 === 0 && (_fallbackSearchHits > 0 || _fallbackSearchMisses > 0)) {
                    console.log(`[FALLBACK-REROUTE] hits=${_fallbackSearchHits} misses=${_fallbackSearchMisses} (hits=found alt lot, misses=all lots full)`);
                    _fallbackSearchHits = 0;
                    _fallbackSearchMisses = 0;
                }

                // Field-authoritative pre-lot holding split happens at the road→lot interface
                // BEFORE any lot acceptance/capacity gating.
                //
                // Interpretation:
                // - fraction (1-α) immediately becomes pre-lot roadside holding at THIS road cell
                // - fraction α attempts to enter the lot and is still subject to capacity gating
                const toPreLot = out * (1 - PRELOT_ALPHA);
                const toLotAttempt = out - toPreLot;

                // Keep the existing acceptance shape for the lot attempt only.
                const acceptMultiplier = getLotAcceptance(targetLotCell); // reads lotMassKgLive snapshot (soft shape)
                const desiredLot = toLotAttempt * acceptMultiplier;
                const accepted = Math.min(desiredLot, Math.max(0, remaining));
                const rejected = toLotAttempt - accepted; // rejected by lot capacity/gating (queues on road as mobile restricted)

                if (lotIdx >= 0 && lotAcceptRemainingKgLive) {
                    // Reserve only what actually enters the lot.
                    lotAcceptRemainingKgLive[lotIdx] = Math.max(0, remaining - accepted);
                    // DEBUG: Trace lot#55 overflow
                    if (lotIdx === 55 && accepted > 0) {
                        const lotMass = lotMassKgLive ? lotMassKgLive[lotIdx] : 0;
                        const cap = lotCapacityKg[lotIdx] || 0;
                        console.log(`[LOT55-TRACE] accepted=${(accepted/1000).toFixed(3)}t remaining=${(remaining/1000).toFixed(3)}t lotMass=${(lotMass/1000).toFixed(3)}t cap=${(cap/1000).toFixed(3)}t util=${cap>0?(100*lotMass/cap).toFixed(1):0}%`);
                    }
                }

                // Diagnostics (per physics frame)
                if (lotIdx >= 0 && lotEntryAttemptKgFrame) {
                    // Only the lot-attempting flow counts as "attempt"; preLot is not attempting entry this tick.
                    lotEntryAttemptKgFrame[lotIdx] += toLotAttempt;
                    lotEntryDesiredKgFrame[lotIdx] += desiredLot;
                    lotEntryAcceptedKgFrame[lotIdx] += accepted;
                    lotEntryRejectedKgFrame[lotIdx] += rejected;
                    // This quantifies instantaneous oversubscription pressure seen at this edge.
                    lotEntryCapShortfallKgFrame[lotIdx] += Math.max(0, desiredLot - remaining);
                }
                // Restricted mass entering a lot becomes LOT STORAGE.
                // Truck tokens are minted globally (FIFO) based on arrivals.
                if (lotIdx >= 0 && lotCapacityKg.length > 0 && accepted > 0) {
                    if (!_lotScatterCursor || _lotScatterCursor.length !== lotCapacityKg.length) {
                        _lotScatterCursor = new Int32Array(lotCapacityKg.length);
                    }

                    // Spread accepted mass across lot interior cells to avoid single-cell hotspot.
                    const cells = lotToCellIndices[lotIdx];
                    if (cells && cells.length > 0) {
                        const scatterN = Math.min(LOT_SCATTER_MAX_CELLS_PER_DEPOSIT, cells.length);
                        const perCell = accepted / scatterN;
                        let cursor = _lotScatterCursor[lotIdx] | 0;
                        for (let s = 0; s < scatterN; s++) {
                            const cIdx = cells[(cursor + s) % cells.length];
                            rho_restricted_lot[cIdx] += perCell;
                        }
                        _lotScatterCursor[lotIdx] = (cursor + scatterN) % cells.length;
                    } else {
                        // Fallback: no mapping; deposit at entry cell.
                        rho_restricted_lot[targetLotCell] += accepted;
                    }

                    // No token minting here. Tokens are particles minted at source injection.
                }

                // Pre-lot holding: stays at the ROAD cell idx, occupies road, contributes to congestion,
                // and is released later (deterministic bucketed delay).
                if (toPreLot > 0) {
                    rho_restricted_preLot[idx] += toPreLot;
                    _preLotLiveAdd(idx, toPreLot);
                    schedulePreLotReleaseUniform(idx, toPreLot);
                }

                rhoNext[idx] += (m - out) + rejected;  // Keep residual + rejected-lot-attempt (preLot is held separately)
                totalMoved += accepted;
                totalRejected += rejected;
                totalEnteredLots += accepted;
            } else {
                // Normal flow (no capacity gating)
                rhoNext[nh] += out;
                rhoNext[idx] += (m - out);
                totalMoved += out;
            }
        } else {
            // Sink or dead-end: keep mass here (drain/conversion handles sinks)
            rhoNext[idx] += m;
            if (G[idx] < 0.001 && regionMap[idx] !== REGION_LOT) totalStuck += m;
        }
    }

    rho.set(rhoNext);
    return { moved: totalMoved, stuck: totalStuck, rejected: totalRejected, enteredLots: totalEnteredLots };
}

// ───────────────────────────────────────────────────────────────────────────────
// ROUTING STATS (high-signal consolidated logging)
// ───────────────────────────────────────────────────────────────────────────────

let _routingLogCounter = 0;
const _routingStats = {
    restricted: { moved: 0, stuck: 0, rejected: 0 },
    cleared: { moved: 0, stuck: 0, rejected: 0 },
};

function accumulateRoutingStats(classId, stats) {
    _routingStats[classId].moved += stats.moved;
    _routingStats[classId].stuck += stats.stuck;
    _routingStats[classId].rejected += stats.rejected || 0;
}

function logRoutingStats() {
    // Log every 300 frames (~5s at 60fps)
    if (_routingLogCounter++ % 300 !== 0) return;

    // 1. Class flow summary
    const r = _routingStats.restricted;
    const c = _routingStats.cleared;
    console.log(`[ROUTING] restricted->lots: ${(r.moved/1000).toFixed(1)}t moved, ${(r.stuck/1000).toFixed(1)}t stuck, ${(r.rejected/1000).toFixed(1)}t rejected | cleared->pharr: ${(c.moved/1000).toFixed(1)}t moved, ${(c.stuck/1000).toFixed(1)}t stuck`);

    // Reset accumulators
    _routingStats.restricted = { moved: 0, stuck: 0, rejected: 0 };
    _routingStats.cleared = { moved: 0, stuck: 0, rejected: 0 };

    // 1b. Road congestion stats
    let maxCongestion = 0, sumCongestion = 0, congestionSamples = 0;
    const sampleStep = Math.max(1, Math.floor(roadCellIndices.length / 100));
    for (let i = 0; i < roadCellIndices.length; i += sampleStep) {
        const idx = roadCellIndices[i];
        const rho = rho_restricted[idx] + rho_cleared[idx];
        if (rho > 100) {  // Only count cells with meaningful density
            const c = 1 - roadCongestionFactor(idx);  // c=0 is free flow, c=1 is gridlock
            maxCongestion = Math.max(maxCongestion, c);
            sumCongestion += c;
            congestionSamples++;
        }
    }
    if (congestionSamples > 0) {
        console.log(`[CONGESTION] max=${(maxCongestion*100).toFixed(0)}% avg=${((sumCongestion/congestionSamples)*100).toFixed(0)}% (${congestionSamples} cells sampled)`);
    }

    // 2. Lot mass state + total restricted mass
    let lotsRestricted = 0, lotsCleared = 0;
    for (const i of lotCellIndices) {
        lotsRestricted += rho_restricted_lot[i];
        lotsCleared += rho_cleared[i];
    }
    let totalRestricted = 0, totalCleared = 0;
    for (let i = 0; i < N2; i++) {
        totalRestricted += rho_restricted[i] + rho_restricted_lot[i];
        totalCleared += rho_cleared[i];
    }
    const conversionRate = metrics.conversion_kg_per_hr || 0;
    const lotsPctRestricted = totalRestricted > 0 ? (100 * lotsRestricted / totalRestricted).toFixed(0) : '0';
    console.log(`[LOTS] in_lots: ${(lotsRestricted/1000).toFixed(1)}t restricted (${lotsPctRestricted}% of total), ${(lotsCleared/1000).toFixed(1)}t cleared | conversion: ${(conversionRate/1000).toFixed(1)}t/hr`);

    // 2b. Per-lot capacity stats
    if (lotCapacityKg.length > 0) {
        let fullLots = 0, activeLots = 0;
        let mostFullPct = 0, leastFullPct = 100;
        let mostFullIdx = -1;
        for (let i = 0; i < lotCapacityKg.length; i++) {
            const util = (lotCurrentMassKg[i] / lotCapacityKg[i]) * 100;
            if (lotCurrentMassKg[i] > 0) activeLots++;
            if (lotIsFull[i]) fullLots++;
            if (util > mostFullPct) {
                mostFullPct = util;
                mostFullIdx = i;
            }
            if (lotCurrentMassKg[i] > 0 && util < leastFullPct) leastFullPct = util;
        }
        console.log(`[LOT CAPACITY] ${fullLots}/${lotCapacityKg.length} full (>${(LOT_CAPACITY_THRESHOLD*100).toFixed(0)}%), ${activeLots} active, util range: ${leastFullPct.toFixed(0)}-${mostFullPct.toFixed(0)}%`);
        if (mostFullIdx >= 0) {
            console.log(`[LOT CAPACITY] most full: lot#${mostFullIdx} mass=${(lotCurrentMassKg[mostFullIdx]/1000).toFixed(1)}t / cap=${(lotCapacityKg[mostFullIdx]/1000).toFixed(1)}t (${lotCellCount[mostFullIdx]} cells)`);
        }
    }

    // 3. Particle class stats with in-lot breakdown
    if (particleLayer) {
        const particles = particleLayer?.getParticlesForRender?.() || [];
        let restrictedCount = 0, clearedCount = 0;
        let restrictedInLots = 0;
        let waitingInLotFlag = 0;  // DEBUG: count particles with waitingInLot=true
        let escapedFromLot = 0;    // DEBUG: waitingInLot=true but NOT in REGION_LOT
        for (const p of particles) {
            if (p.classId === 'restricted') {
                restrictedCount++;
                // Check if particle is in lot cell
                const fx = worldToFieldX(p.x);
                const fy = worldToFieldY(p.y);
                const cellX = Math.floor(fx);
                const cellY = Math.floor(fy);
                const inLotRegion = (cellX >= 0 && cellX < N && cellY >= 0 && cellY < N) &&
                                    regionMap[cellY * N + cellX] === REGION_LOT;
                if (inLotRegion) {
                    restrictedInLots++;
                }
                // DEBUG: Track waitingInLot flag vs actual position
                if (p.waitingInLot) {
                    waitingInLotFlag++;
                    if (!inLotRegion) {
                        escapedFromLot++;
                    }
                }
            } else {
                clearedCount++;
            }
        }
        const total = restrictedCount + clearedCount;
        if (total > 0) {
            const rPct = (100 * restrictedCount / total).toFixed(0);
            const inLotPct = restrictedCount > 0 ? (100 * restrictedInLots / restrictedCount).toFixed(0) : '0';
            console.log(`[PARTICLES] ${restrictedCount} restricted (${rPct}%), ${restrictedInLots} in lots (${inLotPct}%), ${clearedCount} cleared | total=${total}`);
            // DEBUG: Log escaped particles if any
            if (escapedFromLot > 0) {
                console.error(`[PARTICLES ESCAPED] ${escapedFromLot} particles have waitingInLot=true but are NOT in REGION_LOT! (waitingFlag=${waitingInLotFlag} inLotRegion=${restrictedInLots})`);
            }
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// INJECTION (split between restricted and cleared classes)
// ───────────────────────────────────────────────────────────────────────────────

let _injectDebugCounter = 0;
let _parkLocalDwellKg = 0;  // Track park-local dwell mass for diagnostics
function injectMass(dt) {
    // CRITICAL: Skip injection during phi rebuild
    // Otherwise mass accumulates at source while flow is paused
    if (_phiRebuildInProgress || !_nextHopBuilt) {
        return { restricted: 0, cleared: 0 };
    }

    let injectedRestricted = 0;
    let injectedCleared = 0;
    let injectedParkDwell = 0;  // Restricted mass that goes to park wait zones
    let boundarySourceCells = 0;
    let deadEndSources = 0;

    // SPARSE: iterate only source cells (O(sourceCells) instead of O(N²))
    for (const i of sourceCellIndices) {
        // PULSE INJECTION: Modulate mass rate by organic pulse multiplier.
        // Overlapping sine waves create natural variation (~12% to ~190% of average).
        // Per-source jitter prevents mechanical synchronization.
        const phaseOffset = _sourcePhaseOffset.get(i) ?? 0;
        const pulseMultiplier = getPulseMultiplier(_simTimeSeconds, phaseOffset, i);
        const added = dt * S[i] * pulseMultiplier;  // dt = simDeltaSeconds (the true time quantum)

        // Split at injection: TRANSFER_REQUIREMENT_FRACTION → restricted, rest → cleared
        const toRestricted = added * TRANSFER_REQUIREMENT_FRACTION;
        const toCleared = added * (1 - TRANSFER_REQUIREMENT_FRACTION);

        // PARK LOCAL DWELL: Check if this source is a park source
        // Park-origin restricted mass goes directly to park wait zone (local dwell)
        // instead of entering road network and routing to external lots
        const parkWaitIdx = _sourceToWaitZoneIdx.get(i);
        if (parkWaitIdx !== undefined) {
            // Park source: restricted mass dwells locally in park
            depositToParkWaitZone(parkWaitIdx, toRestricted);
            injectedParkDwell += toRestricted;
            // Cleared mass still enters road network normally
            rho_cleared[i] += toCleared;
        } else {
            // Corridor source: both classes enter road network
            rho_restricted[i] += toRestricted;
            rho_cleared[i] += toCleared;
            injectedRestricted += toRestricted;
        }

        injectedCleared += toCleared;

        // Check source cell properties
        const x = i % N, y = Math.floor(i / N);
        if (x <= 1 || x >= N-2 || y <= 1 || y >= N-2) boundarySourceCells++;
        if (nextHop_pharr[i] === -1) deadEndSources++;
    }

    _parkLocalDwellKg += injectedParkDwell;

    // Debug every 60 frames
    if (_injectDebugCounter++ % 60 === 0 && sourceCellIndices.length > 0) {
        const sampleIdx = sourceCellIndices[0];
        let nhInfo = '';
        if (sampleIdx >= 0) {
            const sx = sampleIdx % N, sy = Math.floor(sampleIdx / N);
            const sphi = phi_pharr[sampleIdx];
            const nh = nextHop_pharr[sampleIdx];
            nhInfo = nh >= 0
                ? ` sample(${sx},${sy}): phi_pharr=${sphi.toFixed(0)} nextHop_pharr=(${nh % N},${Math.floor(nh / N)}) nhPhi=${phi_pharr[nh].toFixed(0)}`
                : ` sample(${sx},${sy}): phi_pharr=${sphi.toFixed(0)} nextHop_pharr=DEAD_END`;
        }
        const parkDwellInfo = injectedParkDwell > 0 ? ` parkDwell=${injectedParkDwell.toFixed(0)}kg` : '';
        console.log(`[INJECT] restricted=${injectedRestricted.toFixed(0)}kg cleared=${injectedCleared.toFixed(0)}kg${parkDwellInfo} (${(TRANSFER_REQUIREMENT_FRACTION*100).toFixed(0)}/${((1-TRANSFER_REQUIREMENT_FRACTION)*100).toFixed(0)} split)${nhInfo}`);
    }

    const totalInjected = injectedRestricted + injectedCleared + injectedParkDwell;
    metrics.injectedThisTick = totalInjected;
    metrics.injectedTotal += totalInjected;
}

// ───────────────────────────────────────────────────────────────────────────────
// PARTICLE EMISSION (post-physics pass)
// PHYSICS AUTHORITY: birth uses sim time (dt), not wall clock.
// "Physics decides what the world is." — particles born per sim-time quantum.
// ───────────────────────────────────────────────────────────────────────────────

let _particleEmitDebugCounter = 0;
function emitParticlesForPhysicsTime(dt) {
    if (!particleLayer || dt <= 0) return;

    let totalEmitted = 0;
    let parkRestrictedEmitted = 0;
    let parkClearedEmitted = 0;

    // Emit particles for each source based on sim-time elapsed
    for (const i of sourceCellIndices) {
        // PULSE INJECTION: Apply same organic pulse multiplier as mass injection
        const phaseOffset = _sourcePhaseOffset.get(i) ?? 0;
        const pulseMultiplier = getPulseMultiplier(_simTimeSeconds, phaseOffset, i);
        const massKg = dt * S[i] * pulseMultiplier;

        // PARK LOCAL DWELL: For park sources, split by class
        // NOTE: Park wait zones not yet supported in unified physics - mass goes to roads
        const parkWaitIdx = _sourceToWaitZoneIdx.get(i);
        if (parkWaitIdx !== undefined) {
            // Park source: split by class
            const restrictedKg = massKg * TRANSFER_REQUIREMENT_FRACTION;
            const clearedKg = massKg * (1 - TRANSFER_REQUIREMENT_FRACTION);

            // Inject both classes (park dwell handled by old rho system for now)
            particleLayer.injectMass(i, restrictedKg, 'restricted');
            particleLayer.injectMass(i, clearedKg, 'cleared');
            parkRestrictedEmitted += restrictedKg;
            parkClearedEmitted += clearedKg;

            totalEmitted += massKg;
        } else {
            // Corridor source: split by class (65% restricted, 35% cleared)
            const restrictedKg = massKg * TRANSFER_REQUIREMENT_FRACTION;
            const clearedKg = massKg * (1 - TRANSFER_REQUIREMENT_FRACTION);
            particleLayer.injectMass(i, restrictedKg, 'restricted');
            particleLayer.injectMass(i, clearedKg, 'cleared');
            totalEmitted += massKg;
        }
    }

    // Debug every 60 frames
    if (_particleEmitDebugCounter++ % 60 === 0) {
        const stats = particleLayer.getStats?.() || {};
        const parkInfo = parkRestrictedEmitted > 0 ? ` parkRestricted=${parkRestrictedEmitted.toFixed(0)}kg parkCleared=${parkClearedEmitted.toFixed(0)}kg` : '';
        console.log(`[PARTICLE EMIT] simDt=${dt.toFixed(1)}s emittedKg=${totalEmitted.toFixed(0)} injected=${stats.injected || 0}${parkInfo}`);
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// CONVERSION (restricted -> cleared in lots)
function applyConversions(dt, enteredLotsKgThisFrame = 0) {
    if (!_yardEnabled) {
        metrics.convertedThisTick = 0;
        _clearedTrucksThisTick = 0;
        return;
    }

    // Particle-token FIFO queue length defines backlog in discrete trucks.
    // This rate choice does NOT affect FIFO order; it only sets throughput.
    const queuedTrucks = Math.max(0, _waitingParticleQueue.length - _waitingParticleQueueHead);
    const queuedKg = queuedTrucks * TRUCK_KG;
    const globalServiceRateKgPerSimS = queuedKg > 0 ? (queuedKg / TARGET_DWELL_S) : 0;

    _globalServiceBudgetKg += globalServiceRateKgPerSimS * dt;

    // Service FIFO: only the head of the waiting queue can clear, and only if eligible.
    let trucksCleared = 0;
    let totalConverted = 0;
    let parkTrucksCleared = 0;  // Track park conversions separately

    function convertTruckFromLot(lotIdx) {
        const cells = lotToCellIndices[lotIdx];
        if (!cells || cells.length === 0) return 0;
        let remaining = TRUCK_KG;
        let releaseCellIdx = -1;

        for (let k = 0; k < cells.length && remaining > 0; k++) {
            const cellIdx = cells[k];
            const m = rho_restricted_lot[cellIdx];
            if (m <= 0) continue;

            if (releaseCellIdx < 0) {
                releaseCellIdx = findNearestRoadFromLot(cellIdx);
                if (releaseCellIdx < 0) {
                    throw new Error(`[LOTS] No egress road for cleared mass from lot cell ${cellIdx} (lot ${lotIdx})`);
                }
            }

            const take = Math.min(m, remaining);
            rho_restricted_lot[cellIdx] = m - take;
            rho_cleared[releaseCellIdx] += take;
            remaining -= take;
        }
        return TRUCK_KG - remaining;
    }

    // PARK LOCAL DWELL: Convert truck from park wait zone
    function convertTruckFromPark(parkWaitIdx, releaseCellIdx) {
        if (parkWaitIdx < 0 || parkWaitIdx >= _parkWaitZones.length) {
            throw new Error(`[INVARIANT] convertTruckFromPark invalid zone=${parkWaitIdx}`);
        }
        const zone = _parkWaitZones[parkWaitIdx];
        const cells = zone.cells;
        if (!cells || cells.length === 0) {
            throw new Error(`[INVARIANT] convertTruckFromPark zone=${parkWaitIdx} has no cells`);
        }
        if (releaseCellIdx < 0 || releaseCellIdx >= N2) {
            throw new Error(`[INVARIANT] convertTruckFromPark invalid releaseCellIdx=${releaseCellIdx} zone=${parkWaitIdx}`);
        }

        let remaining = TRUCK_KG;
        for (let k = 0; k < cells.length && remaining > 0; k++) {
            const cellIdx = cells[k];
            const m = rho_park_wait[cellIdx];
            if (m <= 0) continue;
            const take = Math.min(m, remaining);
            rho_park_wait[cellIdx] = m - take;
            remaining -= take;
        }

        // Deposit cleared mass to road cell (not park cell)
        const converted = TRUCK_KG - remaining;
        if (converted > 0) {
            rho_cleared[releaseCellIdx] += converted;
        } else {
            throw new Error(`[INVARIANT] convertTruckFromPark converted=0 zone=${parkWaitIdx} releaseCellIdx=${releaseCellIdx}`);
        }
        return converted;
    }

    function getParkMassAvailable(parkWaitIdx) {
        if (parkWaitIdx < 0 || parkWaitIdx >= _parkWaitZones.length) return 0;
        const zone = _parkWaitZones[parkWaitIdx];
        let mass = 0;
        for (const cellIdx of zone.cells) {
            mass += rho_park_wait[cellIdx] || 0;
        }
        return mass;
    }

    // DEBUG: Track skip reasons
    let _fifoSkipNull = 0, _fifoSkipClass = 0, _fifoSkipWaiting = 0, _fifoTimeBreak = 0;

    while (_globalServiceBudgetKg >= TRUCK_KG && _waitingParticleQueueHead < _waitingParticleQueue.length) {
        const p = _waitingParticleQueue[_waitingParticleQueueHead];
        if (!p || (p.classId || 'cleared') !== 'restricted' || !p.waitingInLot) {
            // DEBUG: Log skip reason
            if (!p) _fifoSkipNull++;
            else if ((p.classId || 'cleared') !== 'restricted') _fifoSkipClass++;
            else if (!p.waitingInLot) _fifoSkipWaiting++;
            _waitingParticleQueueHead++;
            continue;
        }

        // Eligibility gate: must have waited >=36h since arriving at lot/park
        const waitSeconds = _simTimeSeconds - p.lotArrivalSimTime;
        if (waitSeconds < MIN_CLEAR_WAIT_S) {
            _fifoTimeBreak++;
            if ((performance.now() | 0) % 2000 < 50) {
                console.log(`[FIFO-TIME] BREAK: waitS=${waitSeconds.toFixed(0)} waitH=${(waitSeconds/3600).toFixed(1)} < minS=${MIN_CLEAR_WAIT_S}`);
            }
            break;
        }

        // PARK LOCAL DWELL: Handle park and lot particles differently
        const isParkParticle = p.waitingInPark && p.parkIdx >= 0;

        if (isParkParticle) {
            // Park particle conversion
            const parkWaitIdx = p.parkIdx;
            const parkMass = getParkMassAvailable(parkWaitIdx);

            if (parkMass < TRUCK_KG * 0.999) {
                _waitingParticleQueueHead++;
                continue;
            }

            const convertedKg = convertTruckFromPark(parkWaitIdx, p.releaseCellIdx);
            if (convertedKg < TRUCK_KG * 0.999) {
                break;
            }

            // Flip particle to cleared
            p.classId = 'cleared';
            p.waitingInLot = false;
            p.waitingInPark = false;
            p.preLotStalled = false;

            _waitingParticleQueueHead++;
            _globalServiceBudgetKg -= TRUCK_KG;
            trucksCleared += 1;
            parkTrucksCleared += 1;
            totalConverted += TRUCK_KG;
        } else {
            // Lot particle conversion (existing behavior)
            console.log(`[FIFO-TIME] PASS: waitS=${waitSeconds.toFixed(0)} waitH=${(waitSeconds/3600).toFixed(1)} >= minS=${MIN_CLEAR_WAIT_S} - attempting conversion`);

            const lotIdx = p.lotIdx;

            // Pre-check: does the lot have enough mass for conversion?
            const cells = lotToCellIndices[lotIdx];
            let lotMassAvailable = 0;
            if (cells) {
                for (let k = 0; k < cells.length; k++) {
                    lotMassAvailable += rho_restricted_lot[cells[k]] || 0;
                }
            }

            if (lotMassAvailable < TRUCK_KG * 0.999) {
                console.log(`[FIFO-SKIP-MASS] lot#${lotIdx} has only ${(lotMassAvailable/1000).toFixed(2)}t, need 9t - skipping`);
                _waitingParticleQueueHead++;
                continue;
            }

            console.log(`[FIFO-CONVERT] lot#${lotIdx}, budget=${_globalServiceBudgetKg.toFixed(0)}kg lotMass=${(lotMassAvailable/1000).toFixed(2)}t`);
            const convertedKg = convertTruckFromLot(lotIdx);
            if (convertedKg < TRUCK_KG * 0.999) {
                console.warn(`[FIFO] lot#${lotIdx} mass insufficient; stopping.`);
                break;
            }

            // Flip particle to cleared
            p.classId = 'cleared';
            p.waitingInLot = false;
            p.preLotStalled = false;

            _waitingParticleQueueHead++;
            _globalServiceBudgetKg -= TRUCK_KG;
            trucksCleared += 1;
            totalConverted += TRUCK_KG;
            console.log(`[FIFO-SUCCESS] lotIdx=${lotIdx} trucksCleared=${trucksCleared}`);
        }
    }

    // Compaction (avoid unbounded head growth)
    if (_waitingParticleQueueHead > 5000) {
        _waitingParticleQueue.splice(0, _waitingParticleQueueHead);
        _waitingParticleQueueHead = 0;
    }

    _clearedTrucksThisTick = trucksCleared;

    // Particle service is performed directly above by flipping the FIFO head particle.

    if ((performance.now() | 0) % 2000 < 50) {
        console.log(
            `[GLOBAL-CLEAR] q=${queuedTrucks} trucks rate=${globalServiceRateKgPerSimS.toFixed(2)}kg/sim-s ` +
            `budget=${_globalServiceBudgetKg.toFixed(0)}kg clearedTrucks=${trucksCleared} headWaitH=${_waitingParticleQueueHead < _waitingParticleQueue.length ? ((_simTimeSeconds - _waitingParticleQueue[_waitingParticleQueueHead].lotArrivalSimTime)/3600).toFixed(1) : 'n/a'}`
        );
        // DEBUG: Log skip reasons if any skips occurred
        if (_fifoSkipNull + _fifoSkipClass + _fifoSkipWaiting > 0 || _fifoTimeBreak > 0) {
            console.log(`[FIFO-DEBUG] skips: null=${_fifoSkipNull} classNotRestricted=${_fifoSkipClass} notWaiting=${_fifoSkipWaiting} timeBreak=${_fifoTimeBreak}`);
        }
    }

    metrics.convertedThisTick = totalConverted;
    metrics.convertedTotal += totalConverted;
}

// ───────────────────────────────────────────────────────────────────────────────
// SINK DRAIN
// When yard enabled: only cleared class can drain (must go through conversion)
// When yard disabled: drain all mass directly (bypass conversion requirement)
// ───────────────────────────────────────────────────────────────────────────────

let _drainDebugCounter = 0;
function drainPharrSinkMultiClass(dt) {
    if (sinkCellIndices.length === 0) {
        metrics.drainedThisTick = 0;
        return;
    }

    // When yard disabled, drain ALL mass (restricted + cleared)
    // When yard enabled, only drain cleared (conversion is required)
    const drainRestricted = !_yardEnabled;

    // Debug: check mass at sink cells
    if (_drainDebugCounter++ % 60 === 0) {
        let sinkMassRestricted = 0, sinkMassCleared = 0;
        for (const i of sinkCellIndices) {
            sinkMassRestricted += rho_restricted[i];
            sinkMassCleared += rho_cleared[i];
        }
        console.log(`[DRAIN DEBUG] sinkCells=${sinkCellIndices.length} drainRestricted=${drainRestricted} sinkMass: restricted=${sinkMassRestricted.toFixed(3)} cleared=${sinkMassCleared.toFixed(3)}`);
    }

    // Compute desired drain (dt = simDeltaSeconds)
    const desired = sinkCellIndices.map(i => {
        let mass = rho_cleared[i];
        if (drainRestricted) mass += rho_restricted[i];
        return mass * G[i] * G_BASE_PER_S * dt;
    });
    const totalDesired = desired.reduce((a, b) => a + b, 0);

    if (totalDesired <= 0) {
        metrics.drainedThisTick = 0;
        return;
    }

    // Capacity cap (if not set, default to uncapped)
    const effectiveCap = gateCapKgPerHour > 0 ? gateCapKgPerHour : 1e9;
    const capKgThisTick = (effectiveCap / 3600) * dt;
    const allowed = Math.min(totalDesired, capKgThisTick);

    // Proportional removal
    let drained = 0;
    sinkCellIndices.forEach((cellIdx, i) => {
        const removed = allowed * (desired[i] / totalDesired);

        if (drainRestricted) {
            // Drain from both classes proportionally
            const totalMass = rho_restricted[cellIdx] + rho_cleared[cellIdx];
            if (totalMass > 0) {
                const restrictedRatio = rho_restricted[cellIdx] / totalMass;
                rho_restricted[cellIdx] -= removed * restrictedRatio;
                rho_cleared[cellIdx] -= removed * (1 - restrictedRatio);
            }
        } else {
            // Only drain cleared
            rho_cleared[cellIdx] -= removed;
        }
        drained += removed;
    });

    metrics.drainedThisTick = drained;
    metrics.drainedTotal += drained;
}

// ───────────────────────────────────────────────────────────────────────────────
// NON-NEGATIVE ENFORCEMENT
// ───────────────────────────────────────────────────────────────────────────────

function enforceNonNegative() {
    // SPARSE: iterate only road cells (O(roadCells) instead of O(N²))
    for (const i of roadCellIndices) {
        if (rho_restricted[i] < 0) rho_restricted[i] = 0;
        if (rho_cleared[i] < 0) rho_cleared[i] = 0;
        if (rho_restricted_preLot[i] < 0) rho_restricted_preLot[i] = 0;
    }
    // Lot storage arrays: meaningful only on lot cells
    for (const i of lotCellIndices) {
        if (rho_restricted_lot[i] < 0) rho_restricted_lot[i] = 0;
        if (rho_cleared[i] < 0) rho_cleared[i] = 0;
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// HOURLY DATA LOADING
// ───────────────────────────────────────────────────────────────────────────────

let _inflowDebugCounter = 0;
function loadHourlyInflow(hour) {
    if (!rendererContext?.scenario) {
        if (_inflowDebugCounter++ % 60 === 0) console.log('[FIELD] loadHourlyInflow: no scenario');
        return;
    }

    const inflow = rendererContext.scenario.getPharrInflow(hour);
    if (!inflow) {
        if (_inflowDebugCounter++ % 60 === 0) console.log('[FIELD] loadHourlyInflow: no inflow for hour', hour);
        return;
    }

    let totalKg = 0;
    for (const hs2 in inflow.hs2_kg) {
        totalKg += inflow.hs2_kg[hs2];
    }

    // Real daily rate - no scaling. Physics stays pure.
    const kgPerS = totalKg / 3600;

    if (_inflowDebugCounter++ % 600 === 0) {
        console.log(`[FIELD] loadHourlyInflow: hour ${hour} totalKg ${totalKg.toFixed(0)} kgPerS ${kgPerS.toFixed(3)}`);
    }

    S.fill(0);
    stampInjectionSources(kgPerS);
}

function loadGateCapacity(hour) {
    if (!rendererContext?.scenario) return;

    const cap = rendererContext.scenario.getPharrGateCapacity(hour);
    if (cap) {
        // Real daily capacity - no scaling. Physics stays pure.
        gateCapKgPerHour = cap.cap_kg_per_hour;
    }
}

// Corridor entry points - manually specified from coordinate picker
// These are where CIEN corridors enter the Reynosa ROI from Mexico
let corridorEntryPoints = [];

// Injection point weight ratios (from CIEN segment matching)
// Key = entry point id, Value = ratio [0,1] (sums to 1)
// If null, uses equal split (fallback)
let _injectionPointRatios = null;

// Industrial park injection points (from lots.json industrialParks layer)
// Each entry: { id, name, fieldX, fieldY, areaM2, zone, zoneRatio }
// zoneRatio = park's M² / zone's total M² (sums to 1 within zone)
let _industrialParkInjectionPoints = [];

// Submarket zones for industrial park injection (world coordinates)
// Each zone gets a fixed share of total industrial flow; parks within distribute by m²
const INDUSTRIAL_ZONES = [
    {
        id: 'norte',
        share: 0.07,  // 7%
        polygon: [
            { x: -15074.134959326351, y: 9637.908434651506 },
            { x: -15178.790784024386, y: 7926.0381592336535 },
            { x: -12405.411429526468, y: 7724.201925887443 },
            { x: -12517.54267027436, y: 9608.006770452068 },
        ]
    },
    {
        id: 'poniente',
        share: 0.32,  // 32%
        polygon: [
            { x: -19374.27564805051, y: 1861.8294955748534 },
            { x: -17832.80399913455, y: -4934.659138281881 },
            { x: -10020.345414855932, y: -4847.075521866202 },
            { x: -9757.594565608893, y: 1616.5953696109507 },
        ]
    },
    {
        id: 'san_fernando',
        share: 0.03,  // 3%
        polygon: [
            { x: -9261.317711786247, y: -5681.080225777392 },
            { x: -9261.317711786247, y: -7866.3996312016425 },
            { x: -4645.596350796708, y: -8540.376644089496 },
            { x: -5605.503005515771, y: -4680.326479368156 },
        ]
    },
    {
        id: 'pharr_bridge',
        share: 0.58,  // 58%
        polygon: [
            { x: -3481.454237626778, y: -1718.9123318306201 },
            { x: -2317.31212445685, y: -9153.083019442089 },
            { x: 5341.51756745057, y: -9663.67166556925 },
            { x: 5116.858563154619, y: -3128.136995141586 },
        ]
    },
];

// Point-in-polygon test (ray casting)
function pointInPolygon(px, py, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// Find which zone a point belongs to (returns zone id or null)
function findZoneForPoint(x, y) {
    for (const zone of INDUSTRIAL_ZONES) {
        if (pointInPolygon(x, y, zone.polygon)) {
            return zone.id;
        }
    }
    return null;
}

// Corridor vs Reynosa-local split (from segment matching analysis)
// Matched corridors: 5.71B kg, Total Pharr: 8.83B kg, Difference: 3.12B kg
const CORRIDOR_TRAFFIC_RATIO = 0.647;  // 64.7% through southern corridors
const REYNOSA_LOCAL_RATIO = 0.353;     // 35.3% from industrial parks

// Hardcoded entry points (from user coordinate picker)
// These are located on the actual CIEN roads entering the ROI
const CORRIDOR_ENTRY_COORDS = [
    { x: -5149.56485028844, y: -30066.614170046476, id: 'ENTRY_EAST' },    // Eastern corridor
    { x: -39274.13970892275, y: -11175.886784032422, id: 'ENTRY_WEST' },   // Western corridor
];

function initCorridorEntries() {
    corridorEntryPoints = CORRIDOR_ENTRY_COORDS.map((coord) => ({
        worldX: coord.x,
        worldY: coord.y,
        fieldX: Math.floor(worldToFieldX(coord.x)),
        fieldY: Math.floor(worldToFieldY(coord.y)),
        id: coord.id,
    }));

    console.log('[CORRIDOR ENTRIES] Initialized', corridorEntryPoints.length, 'entry points:',
        corridorEntryPoints.map(e => `${e.id}(${e.worldX.toFixed(0)}, ${e.worldY.toFixed(0)}) -> field(${e.fieldX}, ${e.fieldY})`).join(', '));

    // Log K value at each corridor entry (source-on-road verification)
    for (const entry of corridorEntryPoints) {
        const idx = entry.fieldY * N + entry.fieldX;
        const kVal = idx >= 0 && idx < N2 ? Math.max(Kxx[idx], Kyy[idx]) : 0;
        const onRoad = kVal > K_OFFROAD + 0.01;
        console.log(`[CORRIDOR CHECK] entry=${entry.id} idx=${idx} K=${kVal.toFixed(3)} ${onRoad ? 'ON_ROAD' : 'OFF_ROAD'}`);
    }

    // Compute injection weights from bundle if available
    // Try scenario pair first, then fall back to direct bundle
    if (hasScenarioPair()) {
        computeInjectionWeightsFromBundle(getBaseline());
    } else if (hasBundle()) {
        computeInjectionWeightsFromBundle(getBundle());
    }

    return corridorEntryPoints;
}

/**
 * Compute injection point weight ratios from CIEN bundle.
 *
 * Uses segment geometry matching with pre-transformed world coordinates
 * (same coordinate system as MACRO view rendering).
 *
 * @param {object} bundle - ReynosaOverlayBundle
 */
function computeInjectionWeightsFromBundle(bundle) {
    if (!bundle) {
        console.warn('[INJECTION] No bundle provided, using equal split');
        _injectionPointRatios = null;
        return;
    }

    if (!bundle.segment_load_kg_by_poe_hs2) {
        console.warn('[INJECTION] No segment load data, using equal split');
        _injectionPointRatios = null;
        return;
    }

    // Get segments with world coordinates (same transform as MACRO view)
    const worldSegments = getSegmentsInROI();
    if (!worldSegments || worldSegments.length === 0) {
        console.warn('[INJECTION] No segments in ROI, using equal split');
        _injectionPointRatios = null;
        return;
    }

    // Build injection points array
    const injectionPoints = CORRIDOR_ENTRY_COORDS.map(c => ({
        x: c.x,
        y: c.y,
        id: c.id,
    }));

    // Log flow totals for verification (if available)
    const pharrFlowKg = bundle.flow_kg_by_poe?.hidalgo_pharr;
    if (pharrFlowKg) {
        console.log(`[INJECTION] Flow totals (verification): hidalgo_pharr = ${(pharrFlowKg / 1e9).toFixed(2)}B kg/year`);
    }

    // Match segments using world coordinates (same as MACRO view)
    const result = computeInjectionPointWeightsFromWorldSegments(
        bundle,
        worldSegments,
        injectionPoints,
        500,  // 500m threshold
        'hidalgo_pharr'
    );

    const totalMatched = result.matched;
    const totalUnmatched = result.unmatched.length;
    const matchedKg = Array.from(result.weights.values()).reduce((a, b) => a + b, 0);

    // Breakdown unmatched by reason
    const noGeom = result.unmatched.filter(u => u.reason === 'no_geometry');
    const noMatch = result.unmatched.filter(u => u.reason === 'no_match');
    const noGeomKg = noGeom.reduce((a, u) => a + u.weight, 0);
    const noMatchKg = noMatch.reduce((a, u) => a + u.weight, 0);

    console.log(`[INJECTION] Matched ${totalMatched} segments (${(matchedKg / 1e9).toFixed(2)}B kg), unmatched ${totalUnmatched}`);
    console.log(`[INJECTION] Unmatched: upstream=${noGeom.length} (${(noGeomKg / 1e9).toFixed(2)}B kg), in-ROI=${noMatch.length} (${(noMatchKg / 1e9).toFixed(2)}B kg)`);

    // Log per-entry weights
    for (const [id, kg] of result.weights) {
        const pct = matchedKg > 0 ? (kg / matchedKg * 100).toFixed(1) : 0;
        console.log(`  ${id}: ${(kg / 1e9).toFixed(2)}B kg (${pct}%)`);
    }

    // Store unmatched segment IDs for debug visualization
    _unmatchedSegmentIds = new Set(result.unmatched.map(u => u.segmentId));
    console.log(`[INJECTION] Stored ${_unmatchedSegmentIds.size} unmatched segment IDs for visualization`);

    if (totalMatched === 0) {
        console.warn('[INJECTION] No segments matched, using equal split');
        _injectionPointRatios = null;
        return;
    }

    _injectionPointRatios = getInjectionPointRatios(result.weights);
    console.log('[INJECTION] Ratios:', Object.fromEntries(_injectionPointRatios));
}

let _injectionDebugDone = false;
let _currentInjectionRateKgPerS = 0;  // Track for service rate calculation

// Debug: unmatched segment IDs for visualization
let _unmatchedSegmentIds = new Set();

/**
 * Get unmatched segment IDs for debug visualization.
 * @returns {Set<string>}
 */
export function getUnmatchedSegmentIds() {
    return _unmatchedSegmentIds;
}

function stampInjectionSources(totalKgPerS) {
    _currentInjectionRateKgPerS = totalKgPerS;  // Store for applyConversions
    const K_THRESHOLD = K_OFFROAD + 0.01;
    sourceCellIndices = [];  // Reset sparse source list
    _sourcePhaseOffset.clear();  // Reset pulse phase offsets

    if (!_injectionDebugDone) {
        let maxKxx = 0, maxKyy = 0, roadCellCount = 0;
        for (let i = 0; i < N2; i++) {
            if (Kxx[i] > maxKxx) maxKxx = Kxx[i];
            if (Kyy[i] > maxKyy) maxKyy = Kyy[i];
            if (Kxx[i] > K_THRESHOLD || Kyy[i] > K_THRESHOLD) roadCellCount++;
        }
        console.log('[INJECTION DEBUG] K tensor: maxKxx=', maxKxx.toFixed(3), 'maxKyy=', maxKyy.toFixed(3),
                    'roadCells=', roadCellCount, 'corridorEntries=', corridorEntryPoints.length,
                    'industrialParks=', _industrialParkInjectionPoints.length);
        _injectionDebugDone = true;
    }

    // Split total flow between corridors and industrial parks
    const hasIndustrialParks = _industrialParkInjectionPoints.length > 0;
    const corridorKgPerS = hasIndustrialParks ? totalKgPerS * CORRIDOR_TRAFFIC_RATIO : totalKgPerS;
    const industrialKgPerS = hasIndustrialParks ? totalKgPerS * REYNOSA_LOCAL_RATIO : 0;

    // 1. Inject at corridor entry points (through-traffic from south)
    if (corridorEntryPoints.length > 0) {
        let relocated = 0;
        for (const entry of corridorEntryPoints) {
            // Use CIEN-derived ratio if available, otherwise equal split
            let ratio;
            if (_injectionPointRatios && _injectionPointRatios.has(entry.id)) {
                ratio = _injectionPointRatios.get(entry.id);
            } else {
                ratio = 1.0 / corridorEntryPoints.length;
            }
            const kgForEntry = corridorKgPerS * ratio;

            let idx = entry.fieldY * N + entry.fieldX;
            if (idx >= 0 && idx < N2) {
                const origIdx = idx;
                idx = relocateRestrictedSource(idx);
                if (idx !== origIdx) relocated++;

                S[idx] = (S[idx] || 0) + kgForEntry;
                sourceCellIndices.push(idx);

                // Record pulse phase offset for this corridor
                const phaseOffset = CORRIDOR_PHASE_OFFSETS[entry.id] ?? 0;
                _sourcePhaseOffset.set(idx, phaseOffset);
            }
        }
        if (relocated > 0) {
            console.log(`[INJECTION] Relocated ${relocated}/${corridorEntryPoints.length} corridor sources`);
        }
    }

    // 2. Inject at industrial park centroids (Reynosa-local exports)
    // Each park gets: industrialKgPerS * zoneShare * zoneRatio
    // zoneShare = fixed % for the zone (norte=7%, poniente=32%, san_fernando=3%, pharr_bridge=58%)
    // zoneRatio = park's m² / zone's total m² (proportional within zone)
    //
    // PARK LOCAL DWELL: Wire source cells to park wait zones so injectMass knows which
    // sources are park sources (and should deposit restricted mass into park wait zones).
    _sourceToWaitZoneIdx.clear();  // Reset for this stamp

    if (hasIndustrialParks) {
        let parksInjected = 0;
        let parksWithWaitZone = 0;
        const zoneInjected = {};  // Track kg/s per zone for logging
        for (const park of _industrialParkInjectionPoints) {
            const kgForPark = industrialKgPerS * park.zoneShare * park.zoneRatio;
            let idx = park.fieldY * N + park.fieldX;
            if (idx >= 0 && idx < N2) {
                S[idx] = (S[idx] || 0) + kgForPark;
                sourceCellIndices.push(idx);
                parksInjected++;
                zoneInjected[park.zone] = (zoneInjected[park.zone] || 0) + kgForPark;

                // Wire source cell to park wait zone for local dwell
                const waitZoneIdx = _parkIdToWaitZoneIdx.get(park.id);
                if (waitZoneIdx !== undefined) {
                    _sourceToWaitZoneIdx.set(idx, waitZoneIdx);
                    parksWithWaitZone++;
                }

                // Record pulse phase offset for this zone
                const phaseOffset = ZONE_PHASE_OFFSETS[park.zone] ?? 0;
                _sourcePhaseOffset.set(idx, phaseOffset);
            }
        }
        if (!_injectionDebugDone) {
            console.log(`[INJECTION] Industrial parks: ${parksInjected} points, ${(industrialKgPerS).toFixed(3)} kg/s total`);
            console.log(`[INJECTION] Park wait zones wired: ${parksWithWaitZone}/${parksInjected}`);
            for (const [zone, kg] of Object.entries(zoneInjected)) {
                console.log(`  ${zone}: ${kg.toFixed(3)} kg/s (${(kg / industrialKgPerS * 100).toFixed(1)}%)`);
            }
        }
    }

    // 3. Fallback if no corridor entries
    if (corridorEntryPoints.length === 0 && !hasIndustrialParks) {
        // Fallback: inject at southern road cells
        const SOUTH_START = Math.floor(N * 0.75);
        const roadCells = [];
        for (let y = SOUTH_START; y < N - 1; y++) {
            for (let x = 0; x < N; x++) {
                const idx = y * N + x;
                if (Kxx[idx] > K_THRESHOLD || Kyy[idx] > K_THRESHOLD) {
                    roadCells.push(idx);
                }
            }
        }
        if (roadCells.length === 0) {
            console.error('[INJECTION] NO ROAD CELLS FOUND');
            const centerIdx = Math.floor(N * 0.8) * N + Math.floor(N / 2);
            roadCells.push(centerIdx);
        }
        const kgPerCell = totalKgPerS / roadCells.length;
        let relocated = 0;
        for (let idx of roadCells) {
            // CRITICAL: Relocate sources that are inside lot capture basins
            const origIdx = idx;
            idx = relocateRestrictedSource(idx);
            if (idx !== origIdx) relocated++;

            S[idx] = kgPerCell;
            sourceCellIndices.push(idx);
        }
        if (relocated > 0) {
            console.log(`[INJECTION FALLBACK] Relocated ${relocated}/${roadCells.length} sources away from lot capture basins`);
        }
    }

    particleLayer?.markSourcesDirty();
}

// ───────────────────────────────────────────────────────────────────────────────
// GEOMETRY BAKING
// ───────────────────────────────────────────────────────────────────────────────

function bakeKTensorWeighted(geometry, outKxx, outKxy, outKyy, getWeight, accumulateDirection = false) {
    const roadWidthCells = 1;  // 1 cell radius = ~312m wide roads at 256 resolution

    // DEBUG_BINARY_K: K=0 off-road, K=1 on-road (no weights)
    const offRoadK = DEBUG_BINARY_K ? 0 : K_OFFROAD;
    outKxx.fill(offRoadK);
    outKyy.fill(offRoadK);
    outKxy.fill(0);

    // Clear direction tensors if accumulating
    if (accumulateDirection) {
        Tdxx.fill(0);
        Tdxy.fill(0);
        Tdyy.fill(0);
    }

    if (DEBUG_BINARY_K) {
        console.log('[BAKE] DEBUG_BINARY_K enabled: K=0 off-road, K=1 on-road');
    }

    let segmentsProcessed = 0, cellsStamped = 0, segmentsInROI = 0;
    let pointsOutOfField = 0, shortSegments = 0;
    let sampleSegments = [];

    console.log('[BAKE DEBUG] Starting bake. ROI center:', roi.centerX, roi.centerY, 'sizeM:', roi.sizeM, 'cellSize:', roi.cellSize);
    console.log('[BAKE DEBUG] Total segments in geometry:', geometry.roadSegments?.length);

    for (const seg of geometry.roadSegments) {
        segmentsProcessed++;

        // Debug: sample first few segments to see their structure
        if (sampleSegments.length < 3 && seg.points?.length > 0) {
            sampleSegments.push({
                id: seg.id || seg.segment_id,
                pointCount: seg.points.length,
                firstPoint: seg.points[0],
                hasXY: seg.points[0] && 'x' in seg.points[0] && 'y' in seg.points[0],
            });
        }

        const inROI = seg.points.some(p =>
            Math.abs(p.x - roi.centerX) < roi.sizeM &&
            Math.abs(p.y - roi.centerY) < roi.sizeM
        );
        if (!inROI) continue;
        segmentsInROI++;

        const segId = seg.id || seg.segment_id || '';
        const weight = getWeight(String(segId));
        // DEBUG_BINARY_K: K=1 on roads (ignore weights)
        const K_seg = DEBUG_BINARY_K ? 1.0 : (K_BASE + weight * K_DELTA);

        for (let i = 0; i < seg.points.length - 1; i++) {
            const p1 = seg.points[i];
            const p2 = seg.points[i + 1];

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.hypot(dx, dy);
            if (len < 0.001) {
                shortSegments++;
                continue;
            }

            const tx = dx / len;
            const ty = dy / len;

            const steps = Math.ceil(len / roi.cellSize * 2);
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const fx = worldToFieldX(p1.x + dx * t);
                const fy = worldToFieldY(p1.y + dy * t);

                // Debug: count points that fall outside field
                if (fx < 0 || fx >= N || fy < 0 || fy >= N) {
                    pointsOutOfField++;
                    continue;
                }

                for (let ry = -roadWidthCells; ry <= roadWidthCells; ry++) {
                    for (let rx = -roadWidthCells; rx <= roadWidthCells; rx++) {
                        const cx = Math.floor(fx + rx);
                        const cy = Math.floor(fy + ry);
                        if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;
                        if (Math.hypot(rx, ry) > roadWidthCells) continue;

                        const idx = cy * N + cx;
                        // Use ISOTROPIC K for visualization - allows flow in any direction on roads
                        // Anisotropic was blocking flow when roads run perpendicular to gradient
                        const newK = K_seg;

                        if (newK > outKxx[idx] || newK > outKyy[idx]) {
                            cellsStamped++;
                        }
                        outKxx[idx] = Math.max(outKxx[idx], newK);
                        outKyy[idx] = Math.max(outKyy[idx], newK);
                        // Keep Kxy = 0 for isotropic

                        // Accumulate direction tensor (tx, ty already computed above)
                        if (accumulateDirection) {
                            Tdxx[idx] += tx * tx;
                            Tdxy[idx] += tx * ty;
                            Tdyy[idx] += ty * ty;
                        }
                    }
                }
            }
        }
    }

    // DILATION PASS: Give cells adjacent to roads a small K value
    // This creates a buffer zone so particles don't die when stepping slightly off-road
    const K_BUFFER = 0.15;  // Buffer zone conductance (lower than road but > 0)
    const K_ROAD_THRESHOLD = 0.1;  // Threshold for "is road"
    let bufferCellsAdded = 0;

    // Use a copy to avoid modifying while iterating
    const roadMask = new Uint8Array(N2);
    for (let i = 0; i < N2; i++) {
        if (outKxx[i] > K_ROAD_THRESHOLD || outKyy[i] > K_ROAD_THRESHOLD) {
            roadMask[i] = 1;
        }
    }

    for (let y = 1; y < N - 1; y++) {
        for (let x = 1; x < N - 1; x++) {
            const idx = y * N + x;
            // Skip if already a road
            if (roadMask[idx]) continue;

            // Check if any neighbor is a road
            const hasRoadNeighbor =
                roadMask[idx - 1] || roadMask[idx + 1] ||
                roadMask[idx - N] || roadMask[idx + N];

            if (hasRoadNeighbor) {
                outKxx[idx] = Math.max(outKxx[idx], K_BUFFER);
                outKyy[idx] = Math.max(outKyy[idx], K_BUFFER);
                bufferCellsAdded++;
            }
        }
    }
    console.log(`[BAKE] Buffer zone: ${bufferCellsAdded} cells with K=${K_BUFFER}`);

    // Final diagnostic
    let maxKxx = 0, maxKyy = 0, cellsAboveOffroad = 0;
    const kValues = [];
    for (let i = 0; i < N2; i++) {
        if (outKxx[i] > maxKxx) maxKxx = outKxx[i];
        if (outKyy[i] > maxKyy) maxKyy = outKyy[i];
        const kMax = Math.max(outKxx[i], outKyy[i]);
        if (kMax > K_OFFROAD + 0.01) {
            cellsAboveOffroad++;
            kValues.push(kMax);
        }
    }

    console.log('[BAKE DEBUG] Segments: processed=', segmentsProcessed, 'inROI=', segmentsInROI);
    console.log('[BAKE DEBUG] Issues: pointsOutOfField=', pointsOutOfField, 'shortSegments=', shortSegments);
    console.log('[BAKE DEBUG] Cells stamped:', cellsStamped, 'cellsAboveOffroad:', cellsAboveOffroad);
    console.log('[BAKE DEBUG] Final K range: maxKxx=', maxKxx.toFixed(4), 'maxKyy=', maxKyy.toFixed(4));
    console.log('[BAKE DEBUG] Sample segments:', JSON.stringify(sampleSegments, null, 2));

    // K Distribution Summary (percentiles)
    if (kValues.length > 0) {
        kValues.sort((a, b) => a - b);
        const p = (pct) => kValues[Math.floor(kValues.length * pct / 100)] || 0;
        console.log(`[K DISTRIBUTION] min=${kValues[0].toFixed(3)} p25=${p(25).toFixed(3)} p50=${p(50).toFixed(3)} p75=${p(75).toFixed(3)} max=${kValues[kValues.length-1].toFixed(3)} roadCells=${kValues.length}`);
    } else {
        console.log('[K DISTRIBUTION] NO ROAD CELLS - all K at offroad level');
        console.log('[FIELD WARN] No road cells with K > offroad - flow will be impossible');
    }
}

function bakeKTensor(geometry) {
    bakeKTensorWeighted(geometry, Kxx, Kxy, Kyy, () => 1.0, true);  // accumulate direction
    // NOTE: K stays isotropic for Jacobi solver (which only uses Kxx/Kyy, ignores Kxy)
    // Direction tensor (Tdxx, Tdxy, Tdyy) is available for velocity anisotropy if needed
    stampCityRoads();  // Mark city roads for Dijkstra cost penalty
    initCorridorEntries();
    phiBaseDirty = true;
    console.log('[ReynosaOverlay] K tensor baked from', geometry.roadSegments.length, 'segments');
}

// ───────────────────────────────────────────────────────────────────────────────
// ROAD EXCLUSION - Forces K=0 in exclusion zones (called LAST, overrides everything)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Distance from point (px, py) to line segment (ax, ay)-(bx, by)
 */
function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) {
        return Math.hypot(px - ax, py - ay);
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    return Math.hypot(px - projX, py - projY);
}

/**
 * Apply road exclusion zones - sets K to 0 for cells within radius of exclusion segments.
 * Called AFTER all other stamping (roads, lots, connectors) to ensure it overrides everything.
 */
function applyRoadExclusions() {
    if (ROAD_EXCLUSION_ZONES.length === 0) return;

    let excludedCount = 0;

    for (let fy = 0; fy < N; fy++) {
        for (let fx = 0; fx < N; fx++) {
            const idx = fy * N + fx;

            // Get world coords for cell center
            const wx = fieldToWorldX(fx + 0.5);
            const wy = fieldToWorldY(fy + 0.5);

            // Check each exclusion zone
            for (const zone of ROAD_EXCLUSION_ZONES) {
                const dist = distanceToSegment(
                    wx, wy,
                    zone.p1.x, zone.p1.y,
                    zone.p2.x, zone.p2.y
                );

                if (dist <= zone.radius) {
                    // Force K to 0 - completely impassable
                    Kxx[idx] = 0;
                    Kxy[idx] = 0;
                    Kyy[idx] = 0;
                    excludedCount++;
                    break;  // No need to check other zones for this cell
                }
            }
        }
    }

    if (excludedCount > 0) {
        console.log(`[EXCLUSION] Removed ${excludedCount} cells from road network`);
    }
}

// Apply anisotropic conductance: K stronger along road tangent, weaker across
// Uses direction tensor to compute principal axis (road tangent)
const K_ANISO_RATIO = 4.0;  // tangent K is this many times stronger than perpendicular

function applyAnisotropicK() {
    let cellsWithDirection = 0;

    for (let i = 0; i < N2; i++) {
        // Skip cells without accumulated direction
        const trace = Tdxx[i] + Tdyy[i];
        if (trace < 0.001) continue;
        cellsWithDirection++;

        // Principal axis of 2x2 symmetric matrix [[Tdxx, Tdxy], [Tdxy, Tdyy]]
        // eigenvector for larger eigenvalue gives tangent direction
        const a = Tdxx[i], b = Tdxy[i], c = Tdyy[i];
        const diff = a - c;
        const disc = Math.sqrt(diff * diff + 4 * b * b);
        const lambda1 = 0.5 * (a + c + disc);  // larger eigenvalue

        // Tangent direction (eigenvector for lambda1)
        let tx, ty;
        if (Math.abs(b) > 1e-9) {
            tx = lambda1 - c;
            ty = b;
        } else if (a >= c) {
            tx = 1; ty = 0;
        } else {
            tx = 0; ty = 1;
        }

        // Normalize
        const len = Math.hypot(tx, ty);
        if (len < 1e-9) continue;
        tx /= len;
        ty /= len;

        // Build anisotropic K tensor: stronger along tangent (tx,ty), weaker across
        // K_tangent = K_base * K_ANISO_RATIO
        // K_perp = K_base
        // Full tensor: K = K_perp * I + (K_tangent - K_perp) * (t ⊗ t)
        const K_base = Math.max(Kxx[i], Kyy[i]);
        const K_tang = K_base * K_ANISO_RATIO;
        const K_perp = K_base;
        const dK = K_tang - K_perp;

        Kxx[i] = K_perp + dK * tx * tx;
        Kyy[i] = K_perp + dK * ty * ty;
        Kxy[i] = dK * tx * ty;
    }

    console.log(`[ANISO K] Applied anisotropic K to ${cellsWithDirection} cells (ratio=${K_ANISO_RATIO})`);
}

function interpolateKTensor(alpha) {
    for (let i = 0; i < N2; i++) {
        Kxx[i] = K_baseline_xx[i] + alpha * (K_interserrana_xx[i] - K_baseline_xx[i]);
        Kxy[i] = K_baseline_xy[i] + alpha * (K_interserrana_xy[i] - K_baseline_xy[i]);
        Kyy[i] = K_baseline_yy[i] + alpha * (K_interserrana_yy[i] - K_baseline_yy[i]);
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// ROAD TYPE STAMPING
// Marks cells near CITY_ROAD_POLYLINE as city roads (higher Dijkstra cost)
// ───────────────────────────────────────────────────────────────────────────────

function distanceToPolyline(px, py, polyline) {
    let minDist = Infinity;
    for (let i = 0; i < polyline.length - 1; i++) {
        const ax = polyline[i].x, ay = polyline[i].y;
        const bx = polyline[i + 1].x, by = polyline[i + 1].y;

        // Project point onto line segment
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-9) {
            // Degenerate segment
            const d = Math.hypot(px - ax, py - ay);
            if (d < minDist) minDist = d;
            continue;
        }

        // t = projection parameter [0,1]
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));

        // Closest point on segment
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        const d = Math.hypot(px - cx, py - cy);
        if (d < minDist) minDist = d;
    }
    return minDist;
}

function stampCityRoads() {
    // Reset to all highway
    roadTypeMap.fill(ROAD_TYPE_HIGHWAY);

    let cityCount = 0;

    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const idx = y * N + x;

            // Only classify road cells
            if (Kxx[idx] < K_OFFROAD + 0.01 && Kyy[idx] < K_OFFROAD + 0.01) continue;

            // Do NOT classify lot connector/apron cells as city roads.
            // These are artificial bridges (K=K_CONNECTOR) and should keep default highway cost.
            if (regionMap[idx] !== REGION_LOT && Kxx[idx] <= K_CONNECTOR + 1e-6 && Kyy[idx] <= K_CONNECTOR + 1e-6) {
                continue;
            }

            // Convert to world coordinates
            const worldX = fieldToWorldX(x);
            const worldY = fieldToWorldY(y);

            // Check distance to all city road polylines
            for (const polyline of CITY_ROAD_POLYLINES) {
                const dist = distanceToPolyline(worldX, worldY, polyline);
                if (dist < CITY_ROAD_RADIUS_M) {
                    roadTypeMap[idx] = ROAD_TYPE_CITY;
                    cityCount++;
                    break;  // No need to check other polylines
                }
            }
        }
    }

    console.log(`[ROAD TYPE] Stamped ${cityCount} cells as CITY (cost mult=${CITY_ROAD_COST_MULT}, ${CITY_ROAD_POLYLINES.length} polylines)`);
}

function stampPharrSink(pharr) {
    const sinkRadiusCells = 0;  // Single cell sink - ensures roads adjacent to it
    const fcx = worldToFieldX(pharr.x);
    const fcy = worldToFieldY(pharr.y);

    console.log('[SINK] Stamping PHARR at field coords:', fcx.toFixed(1), fcy.toFixed(1));

    sinkCellIndices = [];

    for (let ry = -sinkRadiusCells; ry <= sinkRadiusCells; ry++) {
        for (let rx = -sinkRadiusCells; rx <= sinkRadiusCells; rx++) {
            const cx = Math.floor(fcx + rx);
            const cy = Math.floor(fcy + ry);
            if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;

            const dist = Math.hypot(rx, ry);
            if (dist > sinkRadiusCells) continue;

            const idx = cy * N + cx;
            // For single-cell sink (radius=0), falloff=1. Otherwise use Gaussian.
            const falloff = sinkRadiusCells > 0
                ? Math.exp(-dist * dist / (sinkRadiusCells * sinkRadiusCells * 0.5))
                : 1.0;
            G[idx] = falloff;
            sinkCellIndices.push(idx);

            // CRITICAL: Sink cells MUST have high K to influence Jacobi relaxation
            // Without this, sink's low potential (φ=0) has zero weight in neighbor averaging
            Kxx[idx] = 1.0;
            Kyy[idx] = 1.0;
        }
    }

    console.log('[ReynosaOverlay] PHARR sink stamped:', sinkCellIndices.length, 'cells with K=1');

    // Mark potentials dirty when sink changes (triggers dual-potential rebuild)
    phiBaseDirty = true;

    // BFS connectivity diagnostic: trace from sink through K>0 cells
    diagnoseKConnectivity();
}

function diagnoseKConnectivity() {
    const K_THRESHOLD = 0.01;
    const visited = new Uint8Array(N2);
    const queue = [];

    // Start from sink cells
    for (const idx of sinkCellIndices) {
        visited[idx] = 1;
        queue.push(idx);
    }

    // BFS through K>0 neighbors
    let head = 0;
    while (head < queue.length) {
        const idx = queue[head++];
        const y = Math.floor(idx / N);
        const x = idx % N;

        // 4-connected neighbors
        const neighbors = [
            y > 0 ? idx - N : -1,      // up
            y < N-1 ? idx + N : -1,    // down
            x > 0 ? idx - 1 : -1,      // left
            x < N-1 ? idx + 1 : -1,    // right
        ];

        for (const ni of neighbors) {
            if (ni < 0 || visited[ni]) continue;
            if (Kxx[ni] > K_THRESHOLD || Kyy[ni] > K_THRESHOLD) {
                visited[ni] = 1;
                queue.push(ni);
            }
        }
    }

    const reachableCount = queue.length;

    // Count total road cells
    let totalRoadCells = 0;
    for (let i = 0; i < N2; i++) {
        if (Kxx[i] > K_THRESHOLD || Kyy[i] > K_THRESHOLD) totalRoadCells++;
    }

    console.log('[K CONNECTIVITY] BFS from sink: ' + reachableCount + ' reachable out of ' + totalRoadCells + ' road cells (' + (100*reachableCount/totalRoadCells).toFixed(1) + '%)');

    // Find frontier cells (reachable cells with unreachable K>0 neighbors)
    let frontierCells = [];
    for (let i = 0; i < queue.length; i++) {
        const idx = queue[i];
        const y = Math.floor(idx / N);
        const x = idx % N;

        // Check for unreachable K>0 neighbors
        const neighbors = [
            y > 0 ? idx - N : -1,
            y < N-1 ? idx + N : -1,
            x > 0 ? idx - 1 : -1,
            x < N-1 ? idx + 1 : -1,
        ];

        for (const ni of neighbors) {
            if (ni < 0) continue;
            if (!visited[ni] && (Kxx[ni] > K_THRESHOLD || Kyy[ni] > K_THRESHOLD)) {
                frontierCells.push({ idx, x, y, neighborIdx: ni });
                break;
            }
        }
    }

    if (frontierCells.length > 0) {
        console.log('[K CONNECTIVITY] Frontier (edge of reachable region): ' + frontierCells.length + ' cells');
        // Sample a few frontier cells
        const samples = frontierCells.slice(0, 5);
        for (const f of samples) {
            const wx = fieldToWorldX(f.x);
            const wy = fieldToWorldY(f.y);
            console.log('  Frontier cell field(' + f.x + ',' + f.y + ') world(' + (wx/1000).toFixed(1) + 'km,' + (wy/1000).toFixed(1) + 'km)');
        }
    }

    // Check entry points reachability
    for (const entry of corridorEntryPoints) {
        const idx = entry.fieldY * N + entry.fieldX;
        const reachable = idx >= 0 && idx < N2 && visited[idx];
        const hasK = idx >= 0 && idx < N2 && (Kxx[idx] > K_THRESHOLD || Kyy[idx] > K_THRESHOLD);
        console.log('[K CONNECTIVITY] ' + entry.segmentId + ' field(' + entry.fieldX + ',' + entry.fieldY + '): K=' + (hasK ? 'yes' : 'NO') + ' reachable=' + (reachable ? 'yes' : 'NO'));
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// WEIGHTED K TENSOR INITIALIZATION
// ───────────────────────────────────────────────────────────────────────────────

export function initializeWeightedKTensors(hs2Filter = null) {
    if (!hasScenarioPair()) {
        console.error('[ReynosaOverlay] Cannot initialize weighted K: no scenario pair loaded');
        return;
    }

    if (!rendererContext) {
        console.error('[ReynosaOverlay] Cannot initialize weighted K: not attached');
        return;
    }

    const baseline = getBaseline();
    const interserrana = getInterserrana();

    loadWeightMaps(baseline, interserrana, { hs2Filter, poeFilter: 'hidalgo_pharr' });

    // Compute injection point weights from CIEN segment data
    computeInjectionWeightsFromBundle(baseline);

    const baselineGeom = {
        roadSegments: baseline.geometry.segments_in_roi.map(seg => ({
            id: seg.segment_id,
            points: seg.geometry_coordinates.map(([lat, lon]) => latLonToWorld(lat, lon)),
        })),
    };

    const interserranaGeom = {
        roadSegments: interserrana.geometry.segments_in_roi.map(seg => ({
            id: seg.segment_id,
            points: seg.geometry_coordinates.map(([lat, lon]) => latLonToWorld(lat, lon)),
        })),
    };

    bakeKTensorWeighted(baselineGeom, K_baseline_xx, K_baseline_xy, K_baseline_yy, getBaselineWeight);
    bakeKTensorWeighted(interserranaGeom, K_interserrana_xx, K_interserrana_xy, K_interserrana_yy, getInterserranaWeight);

    _kTensorsBaked = true;
    interpolateKTensor(0);

    console.log('[ReynosaOverlay] Weighted K tensors initialized with HS2 filter:', hs2Filter);
}

function latLonToWorld(lat, lon) {
    return {
        x: (lon - RENDERER_TRANSFORM.origin_lon) * RENDERER_TRANSFORM.meters_per_deg_lon,
        y: (lat - RENDERER_TRANSFORM.origin_lat) * RENDERER_TRANSFORM.meters_per_deg_lat,
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// METRICS
// ───────────────────────────────────────────────────────────────────────────────

function updateMetrics(dt) {
    // Total mass per class
    let totalRestricted = 0;
    let totalCleared = 0;
    for (let i = 0; i < N2; i++) {
        totalRestricted += rho_restricted[i] + rho_restricted_preLot[i] + rho_restricted_lot[i];
        totalCleared += rho_cleared[i];
    }
    metrics.restricted = totalRestricted;
    metrics.cleared = totalCleared;
    metrics.total = totalRestricted + totalCleared;

    // Backlog near PHARR (both classes)
    let backlog = 0;
    sinkCellIndices.forEach(i => {
        backlog += rho_restricted[i] + rho_cleared[i];
    });
    metrics.backlog_near_pharr = backlog;

    // Instantaneous rates (dt = simDeltaSeconds)
    const drainedKgPerHr = (metrics.drainedThisTick / dt) * 3600;
    const inflowKgPerHr = (metrics.injectedThisTick / dt) * 3600;
    const convertedKgPerHr = (metrics.convertedThisTick / dt) * 3600;

    // EMA smoothing
    metrics.throughput_kg_per_hr = EMA_ALPHA * drainedKgPerHr + (1 - EMA_ALPHA) * metrics.throughput_kg_per_hr;
    metrics.inflow_kg_per_hr = EMA_ALPHA * inflowKgPerHr + (1 - EMA_ALPHA) * metrics.inflow_kg_per_hr;
    metrics.conversion_kg_per_hr = EMA_ALPHA * convertedKgPerHr + (1 - EMA_ALPHA) * metrics.conversion_kg_per_hr;

    // Dev-time invariant: particle count mirrors total field mass / TRUCK_KG
    if (typeof __DEV__ !== 'undefined' && __DEV__ && particleLayer?.getParticlesForRender) {
        const particlesCount = particleLayer.getParticlesForRender().length;
        const totalMassKg = metrics.total;
        const expected = Math.round(totalMassKg / TRUCK_KG);
        if (Math.abs(particlesCount - expected) > 1) {
            throw new Error(
                `Particle/mass parity violation: particles=${particlesCount} expected=${expected} totalMassKg=${totalMassKg.toFixed(2)}`
            );
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// RENDERING
// ───────────────────────────────────────────────────────────────────────────────

function drawDensityHeatmap(ctx, camera) {
    const cellScreenSize = camera.metersToPixels(roi.cellSize);
    if (cellScreenSize < 1) return;

    // Use fixed reference scale for consistent coloring
    // Log scale: 0.01 = dark blue, 0.1 = cyan, 1 = green, 10 = yellow, 100+ = red
    const LOG_MIN = 0.01;
    const LOG_MAX = 100;

    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const idx = y * N + x;
            const restricted = rho_restricted[idx] + rho_restricted_preLot[idx] + rho_restricted_lot[idx];
            const cleared = rho_cleared[idx];
            const total = restricted + cleared;

            if (total > LOG_MIN) {
                // Logarithmic normalization for wide dynamic range
                const logVal = Math.log10(Math.max(LOG_MIN, Math.min(LOG_MAX, total)));
                const logMin = Math.log10(LOG_MIN);  // -2
                const logMax = Math.log10(LOG_MAX);  // 2
                const t = (logVal - logMin) / (logMax - logMin);  // 0 to 1

                // Spectral color map: blue → cyan → green → yellow → red
                let r, g, b;
                if (t < 0.25) {
                    // Blue to Cyan
                    const s = t / 0.25;
                    r = 0;
                    g = Math.floor(255 * s);
                    b = 255;
                } else if (t < 0.5) {
                    // Cyan to Green
                    const s = (t - 0.25) / 0.25;
                    r = 0;
                    g = 255;
                    b = Math.floor(255 * (1 - s));
                } else if (t < 0.75) {
                    // Green to Yellow
                    const s = (t - 0.5) / 0.25;
                    r = Math.floor(255 * s);
                    g = 255;
                    b = 0;
                } else {
                    // Yellow to Red
                    const s = (t - 0.75) / 0.25;
                    r = 255;
                    g = Math.floor(255 * (1 - s));
                    b = 0;
                }

                const a = 0.6 + 0.3 * t;  // More opaque for higher density

                ctx.fillStyle = `rgba(${r},${g},${b},${a})`;

                const wx = fieldToWorldX(x);
                const wy = fieldToWorldY(y);
                const screen = camera.worldToScreen(wx, wy);
                ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
            }
        }
    }

    // Lot boundaries are now polygon-based; no single circular boundary to draw
}

/**
 * Internal phi_pharr debug visualization for DEBUG_BINARY_K mode.
 * Shows phi gradient as grayscale: dark = low (near sink), light = high (far from sink)
 * Red = unreachable (PHI_LARGE)
 */
function drawPhiBaseDebugInternal(ctx, camera) {
    const cellScreenSize = camera.metersToPixels(roi.cellSize);
    if (cellScreenSize < 0.5) return;

    // Find max reachable phi for scaling
    let maxPhi = 0;
    for (let i = 0; i < N2; i++) {
        if (phi_pharr[i] < PHI_LARGE && phi_pharr[i] > maxPhi) {
            maxPhi = phi_pharr[i];
        }
    }
    maxPhi = Math.max(maxPhi, 1);

    // Draw cells
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const idx = y * N + x;
            const val = phi_pharr[idx];

            let color;
            if (val >= PHI_LARGE) {
                // Unreachable = red
                color = 'rgba(255, 50, 50, 0.6)';
            } else if (G[idx] > 0) {
                // Sink = bright green
                color = 'rgba(0, 255, 0, 0.8)';
            } else {
                // Gradient: dark (low phi, near sink) to light (high phi, far from sink)
                const norm = Math.min(1, val / maxPhi);
                const gray = Math.floor(40 + 180 * norm);  // 40-220 range
                color = `rgba(${gray}, ${gray}, ${Math.floor(gray * 0.8)}, 0.7)`;
            }

            ctx.fillStyle = color;
            const wx = fieldToWorldX(x);
            const wy = fieldToWorldY(y);
            const screen = camera.worldToScreen(wx, wy);
            ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
        }
    }

    // Draw sink marker
    if (sinkCellIndices.length > 0) {
        const sinkIdx = sinkCellIndices[Math.floor(sinkCellIndices.length / 2)];
        const sx = sinkIdx % N;
        const sy = Math.floor(sinkIdx / N);
        const screen = camera.worldToScreen(fieldToWorldX(sx), fieldToWorldY(sy));
        ctx.fillStyle = 'lime';
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'black';
        ctx.font = '12px monospace';
        ctx.fillText('SINK', screen.x - 15, screen.y - 15);
    }

    // Show debug info
    ctx.fillStyle = 'white';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 2;
    ctx.font = '14px monospace';
    const info = `DEBUG_BINARY_K | phi_pharr: max=${maxPhi.toFixed(1)}`;
    ctx.strokeText(info, 10, camera.viewportWorld ? 40 : 40);
    ctx.fillText(info, 10, 40);
}

function drawMetricsHUD(ctx, camera) {
    ctx.save();
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;

    const x = 10;
    let y = 20;
    const lineHeight = 16;

    const lines = [
        `Inflow:      ${(metrics.inflow_kg_per_hr / 1000).toFixed(0)} t/hr`,
        `Throughput:  ${(metrics.throughput_kg_per_hr / 1000).toFixed(0)} t/hr`,
        `Conversion:  ${(metrics.conversion_kg_per_hr / 1000).toFixed(0)} t/hr`,
        `───────────`,
        `Restricted:  ${(metrics.restricted / 1000).toFixed(1)} t`,
        `Cleared:     ${(metrics.cleared / 1000).toFixed(1)} t`,
        `Total:       ${(metrics.total / 1000).toFixed(1)} t`,
        `───────────`,
        `Backlog:     ${(metrics.backlog_near_pharr / 1000).toFixed(1)} t`,
        `Yard:        ${_yardEnabled ? 'ON' : 'OFF'}`,
    ];

    lines.forEach(line => {
        ctx.strokeText(line, x, y);
        ctx.fillText(line, x, y);
        y += lineHeight;
    });

    ctx.restore();
}

// ───────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ───────────────────────────────────────────────────────────────────────────────

export function setLocalScenario(options) {
    localScenario = { ...localScenario, ...options };

    if (options.renderMode) {
        const valid = Object.values(RENDER_MODE);
        if (valid.includes(options.renderMode)) {
            localScenario.renderMode = options.renderMode;
        } else {
            console.warn('[ReynosaOverlay] Ignoring invalid renderMode:', options.renderMode);
        }
    }

    if (options.particleConfig) {
        localScenario.particleConfig = { ...localScenario.particleConfig, ...options.particleConfig };
        // NOTE: Unified physics adapter uses fixed configuration - dynamic reconfiguration not supported
    }

    if (options.inovusEnabled !== undefined) {
        if (options.inovusEnabled && !_yardEnabled) {
            // Default yard position: 4km south of PHARR
            const pharr = rendererContext?.geometry?.poePoints?.PHARR;
            if (pharr) {
                enableYard(pharr.x, pharr.y + 4000, 600);
            }
        } else if (!options.inovusEnabled && _yardEnabled) {
            disableYard();
        }
    }
}

export function getMetrics() {
    return { ...metrics };
}

export function getState() {
    return state;
}

/**
 * Get per-class density arrays for external access.
 */
export function getClassDensities() {
    return {
        // Backwards-compat: `restricted` here is road-only. Lot-resident restricted is separate.
        restricted: rho_restricted,
        restricted_preLot: rho_restricted_preLot,
        restricted_lot: rho_restricted_lot,
        cleared: rho_cleared,
    };
}

/**
 * Get region map for visualization/debugging.
 */
export function getRegionMap() {
    return regionMap;
}

/**
 * Get corridor entry points for debugging.
 * Returns array of { worldX, worldY, fieldX, fieldY, segmentId }
 */
export function getCorridorEntries() {
    return corridorEntryPoints;
}

/**
 * Get all physics debug data for visualization.
 * Returns everything that affects the physics simulation.
 */
export function getPhysicsDebugData() {
    return {
        // Grid config
        N,
        roi: { ...roi },

        // Sink (PHARR)
        sinkCellIndices: [...sinkCellIndices],
        G,  // sink strength array

        // Fields (references - don't modify!)
        phi,           // potential (per-frame, copies phi_pharr)
        phi_pharr,     // base potential → PHARR (cleared mass routing)
        phi_lots,      // base potential → lots (restricted mass routing)
        Kxx, Kyy,      // conductance tensor (diagonal - isotropic)
        nextHop_pharr, // graph routing table → PHARR (cleared)
        nextHop_lots,  // graph routing table → lots (restricted)
        S,             // source field

        // Density
        rho_restricted,
        rho_cleared,

        // Road type classification (topology layer)
        roadTypeMap,
        ROAD_TYPE_HIGHWAY,
        ROAD_TYPE_CITY,
        CITY_ROAD_COST_MULT,

        // Coordinate transforms
        worldToFieldX,
        worldToFieldY,
        fieldToWorldX,
        fieldToWorldY,

        // Constants
        PHI_SINK,
        PHI_LARGE,
        DEBUG_BINARY_K,

        // Lot data for debug visualization
        regionMap,
        REGION_LOT,
        cellToLotIndex,
        lotToCellIndices,
        lotCount: lotToCellIndices.length,
    };
}

/**
 * Toggle DEBUG_BINARY_K mode and re-bake K tensor.
 * When enabled: K=1 on roads, K=0 elsewhere, pure geometric flow.
 */
export function setDebugBinaryK(enabled) {
    DEBUG_BINARY_K = !!enabled;
    console.log('[FIELD] DEBUG_BINARY_K:', DEBUG_BINARY_K);
    if (rendererContext) {
        // Re-bake K tensor with new mode
        bakeKTensor(rendererContext.geometry);
        // Sink is already stamped, just mark dirty
        phiBaseDirty = true;
    }
}

/**
 * Force immediate rebuild of dual potentials (async with progress).
 * Call this after onAttach to precompute phi_pharr and phi_lots.
 */
export async function forceRebuildPhiBase() {
    console.log('[FIELD] forceRebuildPhiBase called');
    await rebuildPhiBase();
    phiBaseDirty = false;
}

/**
 * Toggle particle debug class colors.
 * Color-codes physics particles by state: restricted/cleared/waiting/stuck.
 */
export function toggleParticleDebugClassColors() {
    _particleDebugColors = !_particleDebugColors;
    console.log(`[PARTICLE DEBUG] Class colors: ${_particleDebugColors ? 'ON' : 'OFF'}`);
    return _particleDebugColors;
}

/**
 * Draw phi_pharr as grayscale/contours for debugging.
 * Call from external debug UI or add to draw() with a toggle.
 */
export function drawPhiBaseDebug(ctx, camera) {
    if (!camera?.worldToScreen || !camera?.metersToPixels) return;

    const cellScreenSize = camera.metersToPixels(roi.cellSize);
    if (cellScreenSize < 1) return;

    // Find max reachable phi for scaling
    let maxPhi = 0;
    for (let i = 0; i < N2; i++) {
        if (phi_pharr[i] < PHI_LARGE && phi_pharr[i] > maxPhi) {
            maxPhi = phi_pharr[i];
        }
    }
    maxPhi = Math.max(maxPhi, 1);

    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const idx = y * N + x;
            const val = phi_pharr[idx];

            // Unreachable = red
            if (val >= PHI_LARGE) {
                ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
            } else {
                // Grayscale: low phi (near sink) = dark, high phi = light
                const norm = Math.min(1, val / maxPhi);
                const gray = Math.floor(255 * norm);
                ctx.fillStyle = `rgba(${gray}, ${gray}, ${gray}, 0.5)`;
            }

            const wx = fieldToWorldX(x);
            const wy = fieldToWorldY(y);
            const screen = camera.worldToScreen(wx, wy);
            ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
        }
    }

    // Draw contour lines at fixed phi values
    ctx.strokeStyle = 'rgba(0, 100, 255, 0.5)';
    ctx.lineWidth = 1;
    const contourStep = maxPhi / 10;
    for (let contour = contourStep; contour < maxPhi; contour += contourStep) {
        for (let y = 1; y < N - 1; y++) {
            for (let x = 1; x < N - 1; x++) {
                const idx = y * N + x;
                const val = phi_pharr[idx];
                if (val >= PHI_LARGE) continue;

                // Check if this cell crosses the contour
                const crosses =
                    (val < contour && phi_pharr[idx + 1] >= contour) ||
                    (val >= contour && phi_pharr[idx + 1] < contour) ||
                    (val < contour && phi_pharr[idx + N] >= contour) ||
                    (val >= contour && phi_pharr[idx + N] < contour);

                if (crosses) {
                    const wx = fieldToWorldX(x);
                    const wy = fieldToWorldY(y);
                    const screen = camera.worldToScreen(wx, wy);
                    ctx.fillStyle = 'rgba(0, 100, 255, 0.8)';
                    ctx.fillRect(screen.x, screen.y, 2, 2);
                }
            }
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// TIME CONTROL FUNCTIONS
// ───────────────────────────────────────────────────────────────────────────────

function pauseSim() {
    _simPaused = true;
    console.log('[TIME] Simulation PAUSED');
}

function resumeSim() {
    _simPaused = false;
    console.log('[TIME] Simulation RESUMED');
}

function togglePause() {
    _simPaused = !_simPaused;
    console.log(`[TIME] Simulation ${_simPaused ? 'PAUSED' : 'RESUMED'}`);
    return _simPaused;
}

function setSimSpeed(presetOrMultiplier) {
    if (typeof presetOrMultiplier === 'string') {
        const mult = TIME_PRESETS[presetOrMultiplier];
        if (mult !== undefined) {
            _simSpeedMultiplier = mult;
            console.log(`[TIME] Speed preset: ${presetOrMultiplier} (${mult.toFixed(4)}x)`);
        } else {
            console.warn(`[TIME] Unknown preset: ${presetOrMultiplier}`);
        }
    } else if (typeof presetOrMultiplier === 'number') {
        _simSpeedMultiplier = presetOrMultiplier;
        console.log(`[TIME] Speed multiplier: ${presetOrMultiplier.toFixed(4)}x`);
    }
    return _simSpeedMultiplier;
}

function getSimStatus() {
    const day = Math.floor(_simTimeSeconds / 86400) + 1;
    const hourInDay = Math.floor((_simTimeSeconds % 86400) / 3600);
    const queuedTrucks = Math.max(0, _waitingParticleQueue.length - _waitingParticleQueueHead);

    // Calculate average dwell for trucks in queue
    let avgDwellH = 0;
    let oldestDwellH = 0;
    if (queuedTrucks > 0) {
        let totalDwell = 0;
        for (let i = _waitingParticleQueueHead; i < _waitingParticleQueue.length; i++) {
            const p = _waitingParticleQueue[i];
            const dwell = _simTimeSeconds - p.lotArrivalSimTime;
            totalDwell += dwell;
            if (dwell > oldestDwellH * 3600) oldestDwellH = dwell / 3600;
        }
        avgDwellH = (totalDwell / queuedTrucks) / 3600;
    }

    return {
        paused: _simPaused,
        speedMultiplier: _simSpeedMultiplier,
        simTimeSeconds: _simTimeSeconds,
        day,
        hour: hourInDay,
        queuedTrucks,
        avgDwellHours: avgDwellH,
        oldestTruckHours: oldestDwellH
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// EXPORT: OVERLAY INTERFACE
// ───────────────────────────────────────────────────────────────────────────────

export const ReynosaEastOverlay = {
    id: 'reynosa-east',
    onAttach,
    onDetach,
    onFrame,
    draw,

    // ═══════════════════════════════════════════════════════════════════════════
    // TIME AUTHORITY EXPORTS
    // Physics runs real daily rates. Time compression only affects clock speed.
    // Simulation runs for 1 week (lot releases can take up to 72 hours).
    // ═══════════════════════════════════════════════════════════════════════════
    DAY_VIDEO_SECONDS,        // How long one day takes on screen (75s)
    SIM_DAYS,                 // Number of days to simulate (7)
    SIM_SECONDS_TOTAL,        // Total sim seconds (604,800 = 1 week)
    TOTAL_VIDEO_SECONDS,      // Total video duration (525s = ~8.75 min)
    SIM_SECONDS_PER_DAY,      // Sim seconds in a day (86,400)
    SIM_TIME_SCALE,           // Sim seconds per real second (1,152)

    // ═══════════════════════════════════════════════════════════════════════════
    // TIME CONTROL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════
    pauseSim,                 // Freeze physics and FIFO timers
    resumeSim,                // Resume physics
    togglePause,              // Toggle pause state, returns new state
    setSimSpeed,              // Set speed preset ('normal', 'fast', etc.) or multiplier
    getSimStatus,             // Get current sim status (day, hour, queue, dwell times)
    TIME_PRESETS,             // Available speed presets

    // ═══════════════════════════════════════════════════════════════════════════
    // CLASS SPLIT EXPORTS
    // ═══════════════════════════════════════════════════════════════════════════
    TRANSFER_REQUIREMENT_FRACTION,  // 65% restricted, 35% cleared at injection
};

export default ReynosaEastOverlay;

// ───────────────────────────────────────────────────────────────────────────────
// GLOBAL DEBUG ACCESS (for console and keybindings)
// ───────────────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
    window.reynosaFieldDebug = {
        toggleBinaryK: () => {
            DEBUG_BINARY_K = !DEBUG_BINARY_K;
            console.log('[FIELD DEBUG] DEBUG_BINARY_K:', DEBUG_BINARY_K);
            if (rendererContext) {
                bakeKTensor(rendererContext.geometry);
                // Re-stamp sink to restore K=1 (bakeKTensor overwrites it)
                const pharr = rendererContext.geometry.poePoints.PHARR;
                stampPharrSink(pharr);
                phiBaseDirty = true;
            }
            return DEBUG_BINARY_K;
        },
        getPhiPharrStats: () => {
            let min = Infinity, max = -Infinity, reachable = 0;
            for (let i = 0; i < N2; i++) {
                if (phi_pharr[i] < min) min = phi_pharr[i];
                if (phi_pharr[i] < PHI_LARGE && phi_pharr[i] > max) max = phi_pharr[i];
                if (phi_pharr[i] < PHI_LARGE) reachable++;
            }
            return { min, max, reachable, total: N2 };
        },
        getPhiLotsStats: () => {
            let min = Infinity, max = -Infinity, reachable = 0;
            for (let i = 0; i < N2; i++) {
                if (phi_lots[i] < min) min = phi_lots[i];
                if (phi_lots[i] < PHI_LARGE && phi_lots[i] > max) max = phi_lots[i];
                if (phi_lots[i] < PHI_LARGE) reachable++;
            }
            return { min, max, reachable, total: N2 };
        },
        rebuildPhiBase: () => {
            phiBaseDirty = true;
            console.log('[FIELD DEBUG] dual potentials marked dirty, will rebuild next frame');
        },
        forceRebuildPhiBaseNow: async () => {
            await rebuildPhiBase();
            phiBaseDirty = false;
            console.log('[FIELD DEBUG] dual potentials rebuilt immediately');
        },
        isDebugMode: () => DEBUG_BINARY_K,
        // Time controls
        pauseSim,
        resumeSim,
        togglePause,
        setSimSpeed,
        getSimStatus,
        TIME_PRESETS,
    };
    console.log('[ReynosaOverlay] Debug API available at window.reynosaFieldDebug');
    console.log('[ReynosaOverlay] Time controls: pauseSim(), resumeSim(), togglePause(), setSimSpeed(preset), getSimStatus()');
}