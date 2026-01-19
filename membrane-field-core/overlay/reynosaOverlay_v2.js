// ═══════════════════════════════════════════════════════════════════════════════
// REYNOSA OVERLAY v2 — UNIFIED PHYSICS
// ═══════════════════════════════════════════════════════════════════════════════
//
// GOAL STATEMENT:
// This file exists to:
//   1. Move mass on a grid
//   2. Enforce physical capacity in lots
//   3. Route mass toward exits
//   4. Visualize exactly what exists
//
// Anything else is noise.
//
// INVARIANTS (enforced, not hoped):
//   1. cell.mass === cell.particles.length * TRUCK_KG  (always)
//   2. particle.cellIdx === the cell containing it     (always)
//   3. Σ(all mass) = injected - exited                 (conservation)
//   4. lot.mass <= lot.capacity                        (hard limit)
//
// If any invariant fails, we THROW. No silent fixes. No lies.
//
// ═══════════════════════════════════════════════════════════════════════════════

// MODULE LOAD DIAGNOSTIC - removed (was noisy in headless runs)

import {
    REYNOSA_ACTIVATION,
    OverlayState,
    COMPUTE_WINDOW,
} from '../spec/renderer_interfaces.js';

import { hasBundle, getBundle, getSegmentsInROI, loadBundle, latLonToWorld } from './bundleConsumer.js';
import {
    hasScenarioPair,
    getBaseline,
    getInterserrana,
} from './scenarioPair.js';

import { loadLots, stampLots, buildLotCellIndices, getIndustrialParksWithArea } from './lotsLoader.js';

import {
    computeInjectionPointWeightsFromWorldSegments,
    getInjectionPointRatios,
} from './segmentWeights.js';

import {
    ctrlPhi,
    ctrlRouting,
    recordRebuild,
    recordAdmitLots,
} from '../tracker/logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — All with physical meaning or explicit knobs
// ═══════════════════════════════════════════════════════════════════════════════

const N = COMPUTE_WINDOW.RESOLUTION;      // Grid dimension (cells per side)
const N2 = N * N;                         // Total cells

/*
───────────────────────────────────────────────────────────────────────────────
CONGESTION ONTOLOGY — READ BEFORE MODIFYING

IMPORTANT:
This simulation models CONGESTION as VEHICLE (TRUCK) OCCUPANCY,
NOT as physical cargo mass.

Implementation detail:
- Congestion is computed using `cellMass` (kg),
- BUT `cellMass` is only a proxy for truck count:

    cellMass[cellIdx] = cellParticles[cellIdx].length * TRUCK_KG

Semantic invariant:
- ONE particle == ONE truck
- TRUCK_KG is a FIXED truck-equivalent constant (avg truck incl. empties)
- TRUCK_KG MUST NOT be tuned for visuals or performance

Therefore:
- Although congestion math uses kg units,
  the EFFECTIVE driver of congestion is:
      number of trucks per cell

Why this matters:
- Changing TRUCK_KG changes the meaning of congestion
- Introducing variable particle masses breaks congestion semantics
- Splitting particles for visual smoothness requires a DIFFERENT model

Related:
- Bridge (PHARR) throughput is also truck-derived (μ = trucks/min/lane),
  expressed in kg/hr only for accounting consistency.

If you want:
- true mass-based congestion, or
- multi-class vehicles, or
- fractional truck particles,

you must design a NEW ontology. Do NOT modify TRUCK_KG here.

───────────────────────────────────────────────────────────────────────────────
*/
const TRUCK_KG = 9000;                    // Mass per particle (one truck) — SEE ONTOLOGY ABOVE
let _stressMultiplier = 1;                // Stress test: 5x particles, 5x weight each

// Effective mass per particle (scales with stress mode)
function particleMass() {
    return TRUCK_KG * _stressMultiplier;
}

export function setStressMode(enabled) {
    _stressMultiplier = enabled ? 5 : 1;
}

export function isStressMode() {
    return _stressMultiplier > 1;
}

// DEPRECATED: Fixed dwell time replaced by sampleDwellSeconds()
// Kept for reference: mean dwell is ~46h (weighted by cold chain fraction)
const DWELL_HOURS_MEAN = 46;              // Approximate mean (for documentation only)
const DWELL_S_MEAN = DWELL_HOURS_MEAN * 3600;

// ═══════════════════════════════════════════════════════════════════════════════
// LOT DWELL TIME — Bimodal distribution (cold chain vs non-cold)
// ═══════════════════════════════════════════════════════════════════════════════
// Source: BTS HS2 x POE x direction x transport mode query (Pharr-specific)
// 64% cold chain (shorter dwell), 36% non-cold (longer dwell)
// ═══════════════════════════════════════════════════════════════════════════════

const COLD_CHAIN_FRACTION = 0.64;

// Triangular distribution: bounded, has mode, easy to reason about
function triangular(min, mode, max) {
    const u = rng();  // MUST use seeded rng(), not Math.random()
    const f = (mode - min) / (max - min);
    if (u < f) {
        return min + Math.sqrt(u * (max - min) * (mode - min));
    } else {
        return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    }
}

// Sample dwell time in seconds
// Cold chain: 36-48 hours, mode 40h
// Non-cold: 48-72 hours, mode 54h
function sampleDwellSeconds() {
    if (rng() < COLD_CHAIN_FRACTION) {
        return triangular(36, 40, 48) * 3600;
    } else {
        return triangular(48, 54, 72) * 3600;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIELD CALIBRATED CONGESTION PARAMETERS
// ═══════════════════════════════════════════════════════════════════════════════
//
// Source:
//   MetroCount tube study, Colonial corridor (P1, P2, P3)
//   March 2023, ~10 consecutive days, ~150,000 vehicle observations
//
// Purpose:
//   Ground congestion dynamics (speed collapse + time-of-day forcing)
//   Reduce model error below ±15% for strategic comparisons
//   Anchor simulation to observed corridor behavior
//
// Scope:
//   Applies to Colonial industrial approach zone (PIR_COLONIAL segment)
//   Not a citywide traffic model
//   Intended for A/B scenario comparison (baseline vs Inovus variants)
//
// Confidence:
//   ±12% at measured corridor locations and hours
//   Higher uncertainty outside measured spatial extent
// ═══════════════════════════════════════════════════════════════════════════════

// FREE_FLOW_SPEED: Upper-bound truck speed under uncongested conditions
// Bounded between P1 (upstream arterial) and P2 (exit ramp / industrial approach)
// Midpoint biased upward for traffic growth since 2023 (~8-10%)
const FREE_FLOW_SPEED_KPH = 60;           // Field calibrated — LOCKED
const FREE_FLOW_SPEED_MS = 16.7;          // 60 / 3.6
const VISUAL_SPEED_MS = FREE_FLOW_SPEED_MS;  // Alias for legacy compatibility

// CONGESTION_P: Sharpness of speed collapse as density increases
// c(ρ) = 1 / (1 + (ρ / ρ0)^p)
// Fitted to observed speed drop: free-flow (60 kph) → peak congestion (24.4 kph)
// c_peak = 24.4 / 60 = 0.41 at 6am northbound into industrial zone
const CONGESTION_P = 3.7;                 // Field calibrated — LOCKED

// Congestion LUT: pre-computed to avoid Math.pow per particle
// 1024 entries cover ratio 0..10.23 with 0.01 precision
const CONGESTION_LUT_SIZE = 1024;
const CONGESTION_LUT = new Float32Array(CONGESTION_LUT_SIZE);
for (let i = 0; i < CONGESTION_LUT_SIZE; i++) {
    CONGESTION_LUT[i] = 1 / (1 + Math.pow(i / 100, CONGESTION_P));
}

// Commuter forcing curve: hourly congestion multiplier [0.3, 1.0]
// Source: MetroCount P1 light-vehicle hourly volumes, normalized to peak (6am = 1.0)
// Modulates effective density / friction seen by trucks
const COMMUTER_MULT_24 = [
    0.342, 0.300, 0.300, 0.352, 0.439, 0.853, 1.000, 0.816,  // 00:00-07:00
    0.728, 0.642, 0.710, 0.784, 0.812, 0.779, 0.721, 0.767,  // 08:00-15:00
    0.821, 0.839, 0.746, 0.599, 0.518, 0.485, 0.451, 0.383   // 16:00-23:00
];

// ═══════════════════════════════════════════════════════════════════════════════
// ROAD CONGESTION — Physical capacity gates with nonlinear throughput degradation
// Exposes upstream shockwaves and variance propagation, not vehicle-level dynamics.
// ═══════════════════════════════════════════════════════════════════════════════
//
// ROAD CAPACITY — Physical derivation
// ───────────────────────────────────────────────────────────────────────────────
// GRIDLOCK DENSITY:
//   - Truck length: 18m (articulado promedio)
//   - Gap at gridlock: 2m (bumper-to-bumper minimum)
//   - Spacing: 20m per truck per lane
//   - Lanes: 3 (typical arterial)
//   - Cell: 20m → fits 1 truck/lane → 3 trucks max
//   - Capacity: 3 × 9,000 kg = 27,000 kg
//
// FORMULA (computed dynamically in computeRoadCellCap):
//   trucksAtGridlock = (cellSize / TRUCK_SPACING_M) × ROAD_LANES
//   ROAD_CELL_CAP_KG = trucksAtGridlock × TRUCK_KG
//
// The 27,000 kg default assumes 20m cells. Actual value is recomputed at init.
// ═══════════════════════════════════════════════════════════════════════════════

// Physical parameters (resolution-independent)
const ROAD_LANES = 3;                     // Effective lane count for arterials
const TRUCK_SPACING_M = 20;               // Truck length + gap at gridlock (~18m truck + 2m gap)
const CONGESTION_ONSET_FRAC = 0.4;        // Flow degrades at 40% of gridlock density
const STALL_CUTOFF = 0.1;                 // Below this factor, particle is considered "stalled"

// Computed at init (after roi.cellSize is known)
let ROAD_CELL_CAP_KG = 27000;             // Hard cap: physical gridlock (recomputed)
let RHO_CONGESTION_0 = 10800;             // Onset density: flow starts degrading (recomputed)
let MAX_RENDER_OFFSET_M = 50;             // Max congestion spread offset (recomputed)

const PHI_LARGE = 1e9;                    // "Unreachable" marker
const PHI_SINK = 0.01;                    // Sink potential (slightly above zero)
const K_THRESHOLD = 0.01;                 // Minimum conductance for traversability
const SINK_CAP_MULT = 3.0;                // Bridge approach capacity multiplier (simulates 3 lanes)

// Bridge approach region (quadrilateral in world coords)
// Cells inside this region get 3x capacity to simulate multi-lane approach
const BRIDGE_APPROACH_QUAD = [
    { x: 145.43365576849544, y: 2199.9614127275727 },   // Top-left
    { x: 444.4335700493182, y: 2116.241436728942 },    // Top-right
    { x: -285.12622079588925, y: -2416.5972637683303 }, // Bottom-right
    { x: -536.2861487917803, y: -2308.957294627234 },  // Bottom-left
];

// Point-in-quadrilateral test using cross products
function isInBridgeApproach(wx, wy) {
    const q = BRIDGE_APPROACH_QUAD;
    // Check if point is on same side of all 4 edges
    const cross = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const s0 = cross(q[0].x, q[0].y, q[1].x, q[1].y, wx, wy) >= 0;
    const s1 = cross(q[1].x, q[1].y, q[2].x, q[2].y, wx, wy) >= 0;
    const s2 = cross(q[2].x, q[2].y, q[3].x, q[3].y, wx, wy) >= 0;
    const s3 = cross(q[3].x, q[3].y, q[0].x, q[0].y, wx, wy) >= 0;
    return (s0 === s1) && (s1 === s2) && (s2 === s3);
}

// Cache for cell bridge approach status (computed once per cell)
let _bridgeApproachCache = null;

function isCellInBridgeApproach(cellIdx) {
    if (!_bridgeApproachCache) return false;
    return _bridgeApproachCache[cellIdx] === 1;
}

// ───────────────────────────────────────────────────────────────────────────────
// MASS CLASS SPLIT — Restricted vs Cleared at injection
//
// EMPIRICAL: Long-hauler restriction fraction (~65%) observed from survey of 242 drivers in LRSII Inovus Location study.
// Trucks arriving via corridors often need lot processing before crossing.
// ───────────────────────────────────────────────────────────────────────────────
const TRANSFER_REQUIREMENT_FRACTION = 0.65;  // 65% → restricted (need lot), 35% → cleared (direct)
const LOT_SINK_BIAS_WEIGHT = 0;              // Bias lots by distance to PHARR (0=nearest lot, 1=full PHARR priority)

// Time scaling
const DAY_VIDEO_SECONDS = 150;            // Real seconds to show one sim day
const SIM_SECONDS_PER_DAY = 86400;
const SIM_TIME_SCALE = SIM_SECONDS_PER_DAY / DAY_VIDEO_SECONDS;  // ~1152x

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUTER FRICTION — FIELD CALIBRATED (PARAMETRIC)
// ═══════════════════════════════════════════════════════════════════════════════
//
// SOURCE:     MetroCount pneumatic tube aforo, RP1 (bidirectional)
// LOCATION:   Parque Colonial approach corridor (2-park stack)
// PERIOD:     Mar 11-21, 2023 (10 days, 147,941 vehicles)
// INSTRUMENT: MC5900-X13, Scheme F3 classification
//
// MEASURED PEAK (weekday AM, Thu Mar 16):
//   Total:        2,143 veh/hr @ 05:30-06:30
//   Non-trucks:   1,886 veh/hr (88%) — friction source
//   Trucks:         257 veh/hr (12%) — already simulated as particles
//
// ROAD CAPACITY: 5,400 veh/hr (3 lanes × 1,800 veh/lane/hr)
//
// ───────────────────────────────────────────────────────────────────────────────
// CAPACITY THEFT (measured):
//   occ_target = 1,886 / 5,400 = 0.35 (35% pre-truck occupancy)
// ───────────────────────────────────────────────────────────────────────────────
//
// GRID CAPACITY (derived geometrically):
//   cellSize = 16.67m, ROAD_LANES = 3, TRUCK_SPACING_M = 20
//   ROAD_CELL_CAP_KG = ceil(16.67/20) × 3 × 9000 = 27,000 kg
//
// ───────────────────────────────────────────────────────────────────────────────
// CALIBRATION FORMULA:
//
//   COMMUTER_EQUIV_KG = (occ_target × ROAD_CELL_CAP_KG) / L_peak
//
//   Where:
//     occ_target = 0.35 (measured capacity theft)
//     ROAD_CELL_CAP_KG = 27,000 (grid-derived)
//     L_peak = commuterLoad at measurement location during peak
//            = commuterMultiplier(hour) × baseCommuterWeight[cell]
//
//   For Colonial corridor (weight=1.0, 6am multiplier=1.0):
//     L_peak = 1.0
//     COMMUTER_EQUIV_KG = 0.35 × 27,000 / 1.0 = 9,450 ≈ 9,000
//
//   For corridor with weight=0.7:
//     L_peak = 0.7
//     COMMUTER_EQUIV_KG = 0.35 × 27,000 / 0.7 = 13,500
//
// ───────────────────────────────────────────────────────────────────────────────
// CHOSEN VALUE:
//   Colonial corridor stamped with weight = 1.0
//   Peak temporal multiplier = 1.0 (05:00-07:00)
//   Therefore L_peak = 1.0
//
//   COMMUTER_EQUIV_KG = 9,000
//
// ───────────────────────────────────────────────────────────────────────────────
// SECONDARY FRICTION (separate phenomenon — direct interference):
//   COMMUTER_SPEED_PENALTY = 0.15 (texture, not main engine)
//   At peak: velJitter ≈ 0.85 (15% from weaving/yielding/signals)
//
// ───────────────────────────────────────────────────────────────────────────────
// VALIDATION:
//   - Google Maps "Typical Traffic" Monday 6:00 AM shows red/orange on
//     Av Puente Pharr at Colonial approach (see screenshot)
//   - Pneumatic tube installation photo on file
//
// ═══════════════════════════════════════════════════════════════════════════════

const COMMUTER_EQUIV_KG = 9000;           // = 0.35 × 27,000 / 1.0 (field calibrated)
const COMMUTER_LANE_SHRINK = 0.35;        // Lane narrowing visual factor
const COMMUTER_SPEED_PENALTY = 0.15;      // Direct friction (texture, weaving/yielding)
const MAGENTA_STRENGTH = 0.70;            // Deep magenta tint intensity (congestion glow)

// ═══════════════════════════════════════════════════════════════════════════════
// CORRIDOR & INDUSTRIAL PARK INJECTION
// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────────
// CORRIDOR vs LOCAL SPLIT
//
// EMPIRICAL: Derived from CIEN segment matching analysis.
// Matched corridors: 5.71B kg, Total Pharr: 8.83B kg, Difference: 3.12B kg
// ───────────────────────────────────────────────────────────────────────────────
const CORRIDOR_TRAFFIC_RATIO = 0.647;  // 64.7% through southern corridors
const REYNOSA_LOCAL_RATIO = 0.353;     // 35.3% from industrial parks
const INDUSTRIAL_LOT_SPLIT = 0.5;      // 50% of restricted industrial route through lots

// ───────────────────────────────────────────────────────────────────────────────
// HARDCODED LOOP SEQUENCE
//
// Bypass phi routing for particles on this loop. Particles follow the exact
// cell sequence from entry to exit, then return to normal phi routing.
// ───────────────────────────────────────────────────────────────────────────────
const LOOP_WORLD_COORDS = [
    { x: -636.84, y: -12303.03 },  // Entry (moved 10m south)
    { x: -548.45, y: -12194.64 },  // (moved 10m north)
    { x: -473.42, y: -12090.45 },  // (moved 10m south & west)
    { x: -373.91, y: -12071.50 },
    { x: -404.12, y: -12199.05 },
    { x: -457.82, y: -12344.50 },
    { x: -547.33, y: -12289.68 },
    { x: -556.28, y: -11986.47 },  // Exit → return to normal routing
];

// Loop routing state (initialized after field init)
let LOOP_CELL_SEQUENCE = null;  // Array of cell indices in order
let LOOP_NEXT_HOP = null;       // Map: cellIdx -> next cell in sequence
let _loopRoutingEnabled = true; // ON by default

// ───────────────────────────────────────────────────────────────────────────────
// INDUSTRIAL SHIFT PATTERN (3-shift manufacturing schedule)
//
// PRIOR — not empirically measured.
// Industrial parks produce on shift schedules, NOT following CIEN demand.
// Corridors follow CIEN hourly profile (demand-driven, empirical).
// Industrial follows shift pattern (production-driven, assumed).
//
// NOTE: These shift shares are modeling priors, not observed data.
// Corridor/industrial split (64.7%/35.3%) is derived from CIEN segment matching.
// Shift distribution within industrial is assumed based on typical maquiladora ops.
//
// SHAPE: Soft trapezoid within each shift (no hard edges)
//   - First 20% of shift → ramp up
//   - Middle 60% → flat
//   - Last 20% → ramp down
//
// BIAS: Mild release boost near shift END times (06, 14, 22)
//   - ±1.5 hour window, max +25% boost, linear falloff
// ───────────────────────────────────────────────────────────────────────────────
const PRIOR_INDUSTRIAL_SHIFT_SHARES = {
    day:     0.45,  // 06:00-14:00: 45% — highest staffing, fresh workers
    evening: 0.35,  // 14:00-22:00: 35% — moderate
    night:   0.20,  // 22:00-06:00: 20% — skeleton crew, maintenance windows
};

// Shift boundaries (end times where release bias peaks)
const SHIFT_END_HOURS = [6, 14, 22];
const SHIFT_BIAS_WINDOW = 1.5;    // Hours before/after shift end
const SHIFT_BIAS_MAX = 0.25;      // Max +25% boost at shift boundary

// Industrial pulse damping (smoother than corridors)
const INDUSTRIAL_PULSE_DAMPING = 0.17;  // ±15% range (vs corridor's full ±88%)

/**
 * Compute trapezoid multiplier for within-shift density.
 * Ramp up first 20%, flat middle 60%, ramp down last 20%.
 * @param {number} progressInShift - 0.0 to 1.0 progress through 8-hour shift
 * @returns {number} Multiplier (0.0 to 1.0, averages ~0.8 for mass conservation)
 */
function getTrapezoidMultiplier(progressInShift) {
    const p = Math.max(0, Math.min(1, progressInShift));
    if (p < 0.2) {
        // Ramp up: 0→1 over first 20%
        return p / 0.2;
    } else if (p < 0.8) {
        // Flat middle 60%
        return 1.0;
    } else {
        // Ramp down: 1→0 over last 20%
        return (1.0 - p) / 0.2;
    }
}

/**
 * Compute shift boundary bias (release surge near shift ends).
 * @param {number} hour - Hour (0-23)
 * @returns {number} Bias multiplier (1.0 to 1.25)
 */
function getShiftBoundaryBias(hour) {
    const h = hour % 24;
    let minDist = 24;
    for (const endHour of SHIFT_END_HOURS) {
        // Distance considering wrap-around
        let dist = Math.abs(h - endHour);
        if (dist > 12) dist = 24 - dist;
        if (dist < minDist) minDist = dist;
    }
    if (minDist >= SHIFT_BIAS_WINDOW) return 1.0;
    // Linear falloff: max boost at boundary, 1.0 at edge of window
    const bias = SHIFT_BIAS_MAX * (1 - minDist / SHIFT_BIAS_WINDOW);
    return 1.0 + bias;
}

/**
 * Get industrial shift hourly fraction with trapezoid shaping and boundary bias.
 * Returns what fraction of daily industrial production happens THIS HOUR.
 * PRIOR — assumed distribution, not empirically measured.
 * @param {number} hour - Hour (0-23, can be fractional)
 * @returns {number} Fraction of daily industrial production
 */
function getIndustrialShiftFraction(hour) {
    const h = hour % 24;

    // Determine which shift and base share
    let shiftShare, shiftStart;
    if (h >= 6 && h < 14) {
        shiftShare = PRIOR_INDUSTRIAL_SHIFT_SHARES.day;
        shiftStart = 6;
    } else if (h >= 14 && h < 22) {
        shiftShare = PRIOR_INDUSTRIAL_SHIFT_SHARES.evening;
        shiftStart = 14;
    } else {
        shiftShare = PRIOR_INDUSTRIAL_SHIFT_SHARES.night;
        shiftStart = (h >= 22) ? 22 : -2;  // Night wraps around midnight
    }

    // Progress through 8-hour shift (0.0 to 1.0)
    let progressInShift;
    if (shiftStart === -2) {
        // Night shift before midnight: hour 0-6 → progress 0.25-1.0
        progressInShift = (h + 2) / 8;
    } else if (shiftStart === 22) {
        // Night shift after midnight: hour 22-24 → progress 0-0.25
        progressInShift = (h - 22) / 8;
    } else {
        progressInShift = (h - shiftStart) / 8;
    }

    // Base hourly fraction (uniform within shift)
    const baseHourlyFraction = shiftShare / 8;

    // Apply trapezoid shaping (smooth ramp up/down)
    // Trapezoid averages ~0.8, so scale to preserve mass
    const trapezoid = getTrapezoidMultiplier(progressInShift);
    const trapezoidScale = 1.0 / 0.8;  // Normalize so average = 1.0

    // Apply shift boundary bias (surge near shift ends)
    const boundaryBias = getShiftBoundaryBias(h);

    return baseHourlyFraction * trapezoid * trapezoidScale * boundaryBias;
}

// ───────────────────────────────────────────────────────────────────────────────
// COMMUTER FRICTION TEMPORAL MODULATION
//
// Models commuter presence based on industrial shift patterns.
// Peak at day shift arrival (05:00-07:00), secondary peaks at shift turnovers.
// Baseline 25% during off-peak hours (city never fully empty).
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Compute commuter presence multiplier based on time of day.
 * @param {number} hour - Hour (0-23)
 * @returns {number} Multiplier [0.25, 1.0]
 */
/**
 * Smooth ramp function: rises from 0 to 1 over rampWidth hours centered at peakHour.
 */
function smoothPulse(hour, peakHour, rampWidth, peakValue, baseValue) {
    const dist = Math.abs(hour - peakHour);
    if (dist >= rampWidth) return baseValue;
    // Cosine smoothstep: smooth rise and fall
    const t = 1 - dist / rampWidth;
    const smooth = t * t * (3 - 2 * t);  // smoothstep
    return baseValue + (peakValue - baseValue) * smooth;
}

/**
 * Arterial multiplier: peaks at 7:30AM, 2PM, 8PM.
 * Peak: 1.2, Medium: 0.6 (daytime), Low: 0.24 (night)
 */
function arterialMultiplier(hour) {
    // Peak: 7-8 (7:30AM), 14 (2PM), 20 (8PM)
    if (hour === 7 || hour === 8 || hour === 14 || hour === 20) return 1.2;
    if (hour === 6 || hour === 9 || hour === 13 || hour === 15 || hour === 19 || hour === 21) return 0.84;
    // Medium: daytime
    if (hour >= 6 && hour <= 22) return 0.6;
    // Low: night
    return 0.24;
}

/**
 * Industrial approach multiplier (PIR_COLONIAL segment).
 * ============================================================
 * FIELD CALIBRATED — MetroCount Colonial P1-P3, Mar 2023
 * Range: [0.3, 1.0], peak at 6am (industrial zone morning rush).
 * Source: COMMUTER_MULT_24 array (see calibration block at top of file).
 * ============================================================
 */
function approachMultiplier(hour) {
    return COMMUTER_MULT_24[hour % 24];
}

/**
 * Urban arterial multiplier: peak at 7PM only, otherwise clear.
 * Peak: 1.0 at 19:00, shoulder at 18-20, otherwise 0.
 */
function urbanMultiplier(hour) {
    if (hour === 19) return 1.0;
    if (hour === 18 || hour === 20) return 0.5;
    return 0;
}

/**
 * Aduana (customs/border) multiplier: dual peaks at shift boundaries.
 * Peak at 6AM and 4PM (shift start/end), medium at 10AM and 8PM.
 */
function aduanaMultiplier(hour) {
    // Peak: 6AM, 4PM (1.0)
    // Medium: 10AM, 8PM (0.5)
    // Low: night/off-peak (0.15)
    if (hour === 6 || hour === 16) return 1.0;
    if (hour === 5 || hour === 7 || hour === 15 || hour === 17) return 0.8;
    if (hour === 10 || hour === 20) return 0.5;
    if (hour === 9 || hour === 11 || hour === 19 || hour === 21) return 0.35;
    if (hour >= 8 && hour <= 18) return 0.25;  // Daytime base
    return 0.15;  // Night
}

/** Legacy wrapper for compatibility */
function commuterMultiplier(hour) {
    return approachMultiplier(hour);
}

// Hardcoded corridor entry points (from user coordinate picker)
// These are located on the actual CIEN roads entering the ROI
const CORRIDOR_ENTRY_COORDS = [
    { x: -5149.56485028844, y: -30066.614170046476, id: 'ENTRY_VICTORIA' },    // Eastern corridor → Cd. Victoria
    { x: -39274.13970892275, y: -11175.886784032422, id: 'ENTRY_MTY' },        // Western corridor → Monterrey
];

// Label positions for corridor sources (moved closer to center for visibility)
// Injection points stay at CORRIDOR_ENTRY_COORDS, labels display here
const CORRIDOR_LABEL_COORDS = {
    'ENTRY_MTY': { x: -27664.087536843654, y: -6092.212061384 },
    'ENTRY_VICTORIA': { x: -6383.904054372736, y: -17043.417596222833 },
};

// Runtime override for corridor label positions (set via director)
let _corridorLabelOverride = null;

/**
 * Set an override position for a corridor label.
 * @param {string} corridorId - 'ENTRY_MTY' or 'ENTRY_VICTORIA'
 * @param {{x: number, y: number}|null} pos - Override position or null to clear
 */
export function setCorridorLabelOverride(corridorId, pos) {
    if (pos) {
        _corridorLabelOverride = { id: corridorId, ...pos };
        console.log(`[SOURCE] Corridor label override: ${corridorId} → (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})`);
    } else {
        _corridorLabelOverride = null;
        console.log(`[SOURCE] Corridor label override cleared`);
    }
}

/**
 * Get effective label position for a corridor (override or default).
 */
function getCorridorLabelPos(corridorId) {
    if (_corridorLabelOverride && _corridorLabelOverride.id === corridorId) {
        return { x: _corridorLabelOverride.x, y: _corridorLabelOverride.y };
    }
    return CORRIDOR_LABEL_COORDS[corridorId];
}

// ───────────────────────────────────────────────────────────────────────────────
// INJECTION PULSE MODULATION (Organic arrival waves)
//
// Uses overlapping sine waves at incommensurate periods for natural variation.
// No hard on/off - always some trucks, with varying intensity (~12% to ~190%).
// Per-source jitter prevents mechanical synchronization between sources.
// Average multiplier = 1.0 preserves hourly totals.
// ───────────────────────────────────────────────────────────────────────────────

// Phase offsets for different source types (creates staggered waves)
const CORRIDOR_PHASE_OFFSETS = {
    'ENTRY_VICTORIA': 0,
    'ENTRY_MTY': 1350,  // 22.5 min offset (half period - maximally out of phase)
};

const ZONE_PHASE_OFFSETS = {
    'norte': 450,         // 7.5 min offset
    'poniente': 1800,     // 30 min offset
    'san_fernando': 900,  // 15 min offset
    'pharr_bridge': 2250, // 37.5 min offset
};

// Map source cell index -> phase offset (populated in stampSourcesFromConfig)
const _sourcePhaseOffset = new Map();

/**
 * Get pulse multiplier for injection at given sim time.
 * Uses overlapping sine waves at incommensurate periods for organic variation.
 * Always some flow (never fully off), peaks and troughs vary naturally.
 * Average multiplier ≈ 1.0 to preserve hourly totals.
 *
 * @param {number} simTimeS - Current simulation time in seconds
 * @param {number} phaseOffset - Base phase offset for this source type
 * @param {number} sourceIdx - Source cell index (adds per-source micro-variation)
 */
function getPulseMultiplier(simTimeS, phaseOffset = 0, sourceIdx = 0) {
    // Per-source jitter: each source gets unique micro-offset (0-10 min range)
    // Uses prime multiplier to spread sources pseudo-randomly
    const sourceJitter = (sourceIdx * 137) % 600;
    const t = simTimeS + phaseOffset + sourceJitter;

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

// Injection point weight ratios (from CIEN segment matching)
// Key = entry point id, Value = ratio [0,1] (sums to 1)
let _injectionPointRatios = null;
let _baselineInjectionRatios = null;      // Baseline scenario ratios
let _interserranaInjectionRatios = null;  // Interserrana scenario ratios

// Industrial park injection points (from lots.json industrialParks layer)
// Each entry: { id, name, fieldX, fieldY, areaM2, zone, zoneShare, zoneRatio }
let _industrialParkInjectionPoints = [];

// Corridor entry points (populated by initCorridorEntries)
let corridorEntryPoints = [];

// Particle color mode (M key cycles)
// 0 = OFF (default white/black)
// 1 = STALL (normal colors, yellow when stalled)
// 2 = SOURCE (corridor origin colors)
// 3 = STATE (restricted=orange, cleared=cyan)
let _particleColorMode = 0;
const PARTICLE_COLOR_MODE_NAMES = ['OFF', 'STALL', 'SOURCE', 'STATE'];

// Source type enum for tracking particle origin
const SOURCE_TYPE = {
    UNKNOWN: 0,
    CORRIDOR_WEST: 1,   // SW corridor (red)
    CORRIDOR_EAST: 2,   // East corridor (blue)
    INDUSTRIAL: 3,      // Industrial parks (green)
};

// Mapping: cell index → source type
let _cellToSourceType = new Map();

// Verbosity flag — set false for headless runs to quiet init logs
let _verbose = false;
let _logPrefix = '';  // Prefix for log messages (e.g., "[Baseline]")
// Quiet mode — suppresses BUILD/WORKER/DIJKSTRA logs (set true for headless runs)
let _quietMode = false;
export function setVerbose(v) { _verbose = v; }
export function setQuietMode(q) { _quietMode = q; }
export function setLogPrefix(prefix) { _logPrefix = prefix ? `[${prefix}] ` : ''; }
function log(...args) { if (_verbose) console.log(_logPrefix + args[0], ...args.slice(1)); }
function logBuild(...args) { if (!_quietMode) console.warn(_logPrefix + args[0], ...args.slice(1)); }

// Dark mode (backtick key) - dark background with light particles
let _darkMode = true;  // Default ON

// Hide particles (for lot highlight overlay)
let _hideParticles = false;

export function setHideParticles(hide) {
    _hideParticles = hide;
}

// Particle debug colors mode
let _particleDebugColors = false;

// Loaded lots for rendering (full lot objects with polygons)
let _loadedLots = [];

// Cached Path2D per layer for fast lot rendering
// { layerName: { stroke: Path2D, polygonPaths: [Path2D,...] for fills } }
let _lotPathsByLayer = null;

// Phi rebuild trigger: fires when admitted lot count DECREASES (lot excluded from routing)
let _admittedLotCount = 0;               // Lots currently below _lotAdmissionCutoff
let _lastRebuildWallMs = 0;              // Last rebuild wall-clock time (ms)
const REBUILD_MIN_INTERVAL_MS = 3000;    // Rate limit: min ms between rebuilds (wall-clock)

// Event-driven routing rebuild (no per-frame triggers)
let _routingDirty = false;               // Set by structural events only
let _rebuildPending = false;             // Scheduled but not yet running
let _pendingRebuild = null;              // Promise for Node.js blocking rebuild

// Web Worker for off-thread routing computation
let _routingWorker = null;
let _workerRequestId = 0;
let _routingBuildToken = 0;              // Monotonic token for stale result rejection
const _workerPending = new Map();

// ───────────────────────────────────────────────────────────────────────────────
// INSTRUMENTATION COUNTERS (for dt-invariance bisection)
// These track discrete events per step to identify divergent subsystems
// ───────────────────────────────────────────────────────────────────────────────
let _phiRebuildCount = 0;
let _lotExclusionCount = 0;
let _cooldownExpiryCount = 0;

// ───────────────────────────────────────────────────────────────────────────────
// ROUTING LINEAGE — Causal debugging for reroute failures
// ───────────────────────────────────────────────────────────────────────────────
let _routingVersion = 0;  // Increments on each phi_lots rebuild
const _rebuildEventLog = [];  // Circular buffer of rebuild lifecycle events
const REBUILD_LOG_MAX = 50;

function logRebuildEvent(event, details = {}) {
    const entry = {
        t: simTime,
        wallMs: Date.now(),
        routingVersion: _routingVersion,
        event,
        ...details,
    };
    _rebuildEventLog.push(entry);
    if (_rebuildEventLog.length > REBUILD_LOG_MAX) _rebuildEventLog.shift();

    // Structured logging via logger
    ctrlRouting(event, { version: _routingVersion, ...details });
    if (event === 'EXECUTE_COMPLETE') {
        recordRebuild(simTime);
    }
}
let _cbpCompletionCount = 0;
let _departedCount = 0;  // Particles removed after DEPARTING animation
let _spawnCount = 0;
let _intersectionBlockCount = 0;

// Debug visualization cache (ImageData approach for phi field)
let _debugOffscreen = null;
let _debugImageData = null;

// ═══════════════════════════════════════════════════════════════════════════════
// CELL STATES — One meaning each, no dual-use
// ═══════════════════════════════════════════════════════════════════════════════

const STATE = {
    EMPTY: 0,       // No mass
    ROAD: 1,        // Restricted mass in transit on roads
    PARK: 2,        // Restricted mass in park waiting zone (staging, holds, paperwork)
    LOT: 3,         // Restricted mass parked inside a lot (conversion)
    CLEARED: 4,     // Cleared mass, routing to exit
    SLEEPING: 5,    // Cleared mass parked overnight in sleep lot (waiting for bridge to open)
    DEPARTING: 6,   // Processed, animating departure from sink
};

// Exit zone for departing particles (world coords, ~4 cells north of PHARR)
const EXIT_ZONE = {
    x: 411.07,
    y: 2924.09,
    radiusCells: 4,
    maxTimeS: 180,  // Max seconds before forced removal (in case stuck)
};

const REGION = {
    OFFROAD: 0,     // Not traversable
    ROAD: 1,        // Traversable road
    PARK: 2,        // Park waiting zone (distinct from lot)
    LOT: 3,         // Lot interior (conversion yards)
    SINK: 4,        // Exit point (PHARR)
};

// ═══════════════════════════════════════════════════════════════════════════════
// GRID STATE — Single source of truth
// ═══════════════════════════════════════════════════════════════════════════════

// Cell arrays
const cellMass = new Float64Array(N2);           // kg per cell (Float64 for precision at scale)
const cellParticles = new Array(N2);             // particles[] per cell
const activeCells = new Set();                   // cells with particles > 0
const regionMap = new Uint8Array(N2);            // REGION enum per cell

// Heatmap accumulators (for headless PNG export)
const cellPresenceHours = new Float64Array(N2);  // total truck-hours present in cell (roads)
const cellLotDwellHours = new Float64Array(N2);  // truck-hours in lots (dwell time)

// Directed outflow counts for O(P) pairwise cancellation (4 neighbors: W=0, E=1, N=2, S=3)
const outCount4 = new Uint16Array(N2 * 4);
const touchedCells = [];
const touchedMark = new Uint8Array(N2);

// Initialize particle arrays
for (let i = 0; i < N2; i++) {
    cellParticles[i] = [];
}

// Direction helpers for O(P) pairwise cancellation
function dirFromTo(a, b) {
    const d = b - a;
    if (d === -1) return 0;      // W
    if (d === +1) return 1;      // E
    if (d === -N) return 2;      // N
    if (d === +N) return 3;      // S
    return -1;  // not 4-neighbor
}
function oppositeDir(dir) {
    return dir ^ 1;  // 0<->1, 2<->3
}




// ═══════════════════════════════════════════════════════════════════════════════
// WEBGL PARTICLE RENDERER — GPU-accelerated particle drawing
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_PARTICLES = 20000;  // Pre-allocated buffer size
const _glPositions = new Float32Array(MAX_PARTICLES * 2);  // [x0, y0, x1, y1, ...] — moving particles
const _glColors = new Float32Array(MAX_PARTICLES * 3);     // [r0, g0, b0, r1, g1, b1, ...]
let _glParticleCount = 0;

let _webglRenderer = null;
const DEBUG_GL = true;  // Enable GL sync assertions
const DEBUG_PAIRWISE_CANCELLATION = false;  // Enable old vs new opposing mass comparison (1 in 200 particles)
let _lastGLAssertTime = 0;

// Flat particle array for O(1) iteration (no cell indirection)
const _activeParticles = new Array(MAX_PARTICLES);
let _activeParticleCount = 0;

// Moving particles only (ROAD/CLEARED) — excludes LOT/PARK/SLEEPING
// Used by drift loop to avoid iterating parked particles
const _movingParticles = new Array(MAX_PARTICLES);
let _movingParticleCount = 0;

// Dirty flag: skip GL sync when particles haven't moved
let _particlesDirty = true;

// ═══════════════════════════════════════════════════════════════════════════════
// OBJECT POOLS — Reusable objects for render path (zero GC pressure)
// ═══════════════════════════════════════════════════════════════════════════════
const _flowBasis = { fx: 0, fy: 0, lx: 0, ly: 0 };
const _renderOffset = { dx: 0, dy: 0 };
const _particleColor = { r: 0, g: 0, b: 0 };

/**
 * Sync particle world positions to GPU buffer with viewport culling.
 * Called once per frame before WebGL draw.
 * Only syncs particles within the visible viewport + padding.
 * Physics runs on ALL particles (truth), but we only RENDER visible ones.
 */
function syncPositionsToGL(camera) {
    // Viewport bounds with padding for particles partially visible
    const vp = camera.viewportWorld;
    const pad = 200; // 200m padding for point sprite radius at high zoom
    const minX = vp.minX - pad;
    const maxX = vp.maxX + pad;
    const minY = vp.minY - pad;
    const maxY = vp.maxY + pad;

    // Default color based on dark mode
    const defaultR = _darkMode ? 0.878 : 0.2;  // #e0e0e0 or #333333
    const defaultG = _darkMode ? 0.878 : 0.2;
    const defaultB = _darkMode ? 0.878 : 0.2;

    let j = 0;
    let c = 0;
    for (let i = 0; i < _activeParticleCount; i++) {
        const p = _activeParticles[i];
        // Cull particles outside viewport
        if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
            // Apply congestion/stall jitter (render-only)
            const offset = getCongestionRenderOffset(p);
            let renderX = p.x + offset.dx;
            let renderY = p.y + offset.dy;

            // Twin span visual split — DISABLED: physics now handles separation via nextHop_pharr_twin
            // Particles with useTwinSpan=true physically route through twin span cells

            _glPositions[j++] = renderX;
            _glPositions[j++] = renderY;

            // Get particle color based on mode (using pooled _particleColor)
            if (_particleColorMode === 3) {
                // STATE mode: color by particle state (restricted vs cleared)
                if (p.state === STATE.ROAD || p.state === STATE.LOT || p.state === STATE.PARK) {
                    _particleColor.r = 1.0; _particleColor.g = 0.5; _particleColor.b = 0.0;  // Orange - restricted
                } else if (p.state === STATE.CLEARED) {
                    _particleColor.r = 0.0; _particleColor.g = 0.8; _particleColor.b = 1.0;  // Cyan - cleared
                } else {
                    _particleColor.r = 0.5; _particleColor.g = 0.5; _particleColor.b = 0.5;  // Gray - unknown
                }
            } else if (_particleColorMode === 2) {
                const src = getParticleSourceColorRGB(p);
                _particleColor.r = src.r; _particleColor.g = src.g; _particleColor.b = src.b;
            } else if (_particleColorMode === 1) {
                // STALL mode: distinct color per stall reason + congestion + queue
                if (regionMap[p.cellIdx] === REGION.SINK) {
                    _particleColor.r = 0.0; _particleColor.g = 0.5; _particleColor.b = 1.0;  // Blue - in sink queue
                } else if (p.renderStalled && isInQueueZone(p.x, p.y)) {
                    _particleColor.r = 0.0; _particleColor.g = 0.5; _particleColor.b = 1.0;  // Blue - queue zone
                } else if (p.stallReason === 'dead_end') {
                    _particleColor.r = 1.0; _particleColor.g = 0.0; _particleColor.b = 0.0;  // Red - dead end
                } else if (p.stallReason === 'lot_full') {
                    _particleColor.r = 1.0; _particleColor.g = 0.0; _particleColor.b = 1.0;  // Magenta - lot full
                } else if (p.stallReason === 'road_full') {
                    _particleColor.r = 1.0; _particleColor.g = 0.5; _particleColor.b = 0.0;  // Orange - road full
                } else if (p.stallReason === 'pre_lot_hold') {
                    _particleColor.r = 0.0; _particleColor.g = 1.0; _particleColor.b = 1.0;  // Cyan - pre-lot hold
                } else if (regionMap[p.cellIdx] === REGION.ROAD && cellMass[p.cellIdx] > RHO_CONGESTION_0) {
                    _particleColor.r = 1.0; _particleColor.g = 1.0; _particleColor.b = 0.0;  // Yellow - congested
                } else {
                    _particleColor.r = 0.0; _particleColor.g = 1.0; _particleColor.b = 0.0;  // Green - moving
                }
            } else {
                // Default mode: neutral gray/white (congestion shown via cell overlay)
                _particleColor.r = defaultR; _particleColor.g = defaultG; _particleColor.b = defaultB;
            }
            _glColors[c++] = _particleColor.r;
            _glColors[c++] = _particleColor.g;
            _glColors[c++] = _particleColor.b;
        }
    }

    // Add particle trails (motion streaks for high-speed replay)
    if (_trailsEnabled && REPLAY_MODE && _particleTrails.size > 0) {
        // Trail color: faded version of default particle color
        // Older positions = more faded (lower brightness)
        for (const [particleId, trail] of _particleTrails) {
            if (trail.length < 2) continue;  // Need at least 2 points for a trail

            // Render trail positions from oldest to newest (excluding current position)
            // Current position is already rendered in main loop
            for (let t = 0; t < trail.length - 1; t++) {
                const pos = trail[t];

                // Viewport culling
                if (pos.x < minX || pos.x > maxX || pos.y < minY || pos.y > maxY) continue;

                // Check buffer capacity
                if (j >= MAX_PARTICLES * 2) break;

                _glPositions[j++] = pos.x;
                _glPositions[j++] = pos.y;

                // Fade factor: 0.2 (oldest) to 0.6 (newest in trail)
                // Trail[0] is oldest, trail[length-2] is second newest
                const fadeT = trail.length > 1 ? t / (trail.length - 1) : 0;
                const fade = 0.2 + fadeT * 0.4;

                // Tinted trail color (cyan-ish for visibility)
                _glColors[c++] = defaultR * fade * 0.5;
                _glColors[c++] = defaultG * fade * 0.8;
                _glColors[c++] = defaultB * fade + (1 - fade) * 0.3;
            }
        }
    }

    // Add replay lot particles (fake particles for lot fill during replay)
    if (_replayLotParticleMode && _replayLotParticles.length > 0) {
        // Lot particles: white by default, orange in STATE mode (mode 3)
        const lotR = _particleColorMode === 3 ? 1.0 : 1.0;
        const lotG = _particleColorMode === 3 ? 0.5 : 1.0;
        const lotB = _particleColorMode === 3 ? 0.0 : 1.0;

        for (const rp of _replayLotParticles) {
            // Viewport culling
            if (rp.x < minX || rp.x > maxX || rp.y < minY || rp.y > maxY) continue;

            // Check buffer capacity
            if (j >= MAX_PARTICLES * 2) break;

            _glPositions[j++] = rp.x;
            _glPositions[j++] = rp.y;
            _glColors[c++] = lotR;
            _glColors[c++] = lotG;
            _glColors[c++] = lotB;
        }
    }

    _glParticleCount = j / 2;
}

/**
 * Sync ONLY replay lot particles to GL arrays (for ROAD_HEATMAP mode).
 * Used during scenario replay when regular particles are paused/cleared.
 */
function syncReplayLotParticlesToGL(camera) {
    if (!_replayLotParticleMode || _replayLotParticles.length === 0) {
        _glParticleCount = 0;
        return;
    }

    const { viewportWorld } = camera;
    const minX = viewportWorld.minX;
    const maxX = viewportWorld.maxX;
    const minY = viewportWorld.minY;
    const maxY = viewportWorld.maxY;

    let j = 0;  // Position index (x,y pairs)
    let c = 0;  // Color index (r,g,b triplets)

    // Lot particles: white by default, orange in STATE mode (mode 3)
    const lotR = _particleColorMode === 3 ? 1.0 : 1.0;
    const lotG = _particleColorMode === 3 ? 0.5 : 1.0;
    const lotB = _particleColorMode === 3 ? 0.0 : 1.0;

    for (const rp of _replayLotParticles) {
        // Viewport culling
        if (rp.x < minX || rp.x > maxX || rp.y < minY || rp.y > maxY) continue;

        // Check buffer capacity
        if (j >= MAX_PARTICLES * 2) break;

        _glPositions[j++] = rp.x;
        _glPositions[j++] = rp.y;
        _glColors[c++] = lotR;
        _glColors[c++] = lotG;
        _glColors[c++] = lotB;
    }

    _glParticleCount = j / 2;
}

/** Add particle to flat array (call on inject) */
function addToActiveParticles(p) {
    p.activeIdx = _activeParticleCount;
    _activeParticles[_activeParticleCount++] = p;
}

/** Remove particle from flat array via swap-remove (call on exit) */
function removeFromActiveParticles(p) {
    const idx = p.activeIdx;
    const last = _activeParticles[--_activeParticleCount];
    if (idx < _activeParticleCount) {
        _activeParticles[idx] = last;
        last.activeIdx = idx;
    }
}

/** Add particle to moving array (call when state becomes ROAD/CLEARED) */
function addToMovingParticles(p) {
    p.movingIdx = _movingParticleCount;
    _movingParticles[_movingParticleCount++] = p;
}

/** Remove particle from moving array via swap-remove (call when state becomes LOT/PARK/SLEEPING or on exit) */
function removeFromMovingParticles(p) {
    const idx = p.movingIdx;
    if (idx === undefined || idx < 0 || idx >= _movingParticleCount) return;
    const last = _movingParticles[--_movingParticleCount];
    if (idx < _movingParticleCount) {
        _movingParticles[idx] = last;
        last.movingIdx = idx;
    }
    p.movingIdx = -1;
}

/**
 * Set the WebGL renderer instance (called from testBundle.html)
 */
export function setWebGLRenderer(renderer) {
    _webglRenderer = renderer;
    log('[OVERLAY] WebGL renderer attached');
}

// Conductance tensor (road network shape)
const Kxx = new Float32Array(N2);
const Kyy = new Float32Array(N2);

// Routing tables
const phi_lots = new Float32Array(N2);           // Distance to nearest lot
const phi_pharr = new Float32Array(N2);          // Distance to PHARR (main span)
const nextHop_lots = new Int32Array(N2);         // Next cell toward lot
const nextHop_pharr = new Int32Array(N2);        // Next cell toward PHARR (main span)

// Twin span routing (separate parallel bridge)
const phi_pharr_twin = new Float32Array(N2);     // Distance to PHARR via twin span
const nextHop_pharr_twin = new Int32Array(N2);   // Next cell toward PHARR via twin span
let _twinSpanCellIndices = [];                   // Cells stamped for twin span road
let _twinSpanActive = false;                     // Whether twin span road is physically stamped

// Precomputed cell centers (world coords) — avoids fieldToWorld() in drift loop
const cellCenterX = new Float32Array(N2);
const cellCenterY = new Float32Array(N2);

// Source field
const sourceField = new Float32Array(N2);        // kg/s injection rate per cell

// Cell lists (sparse iteration)
let roadCellIndices = [];
let lotCellIndices = [];
let sinkCellIndices = [];
let sourceCellIndices = [];
let conductiveCellIndices = [];  // All cells with K > 0 (for debug viz)

// Sink rate limiting (PHARR gate capacity)
let sinkCapKgPerHour = 0;                         // Hourly capacity from scenario (0 = unlimited)
let inflowKgPerHour = 0;                          // Hourly inflow from scenario (from CIEN bundle)
let dailyTotalKg = 0;                             // Sum of all 24 hourly values (for industrial shift calc)
let _lastInflowHour = -1;                         // Track which hour we last loaded
let _dailyTotalLoaded = false;                    // Track if we've computed daily total
let _twinSpanCapMult = 1.0;                       // Twin span capacity multiplier (1.0 = normal, 2.0 = twin span active)

// Scenario interpolation (0 = baseline, 1 = interserrana)
let _scenarioAlpha = 0;
let _interserranaScenario = null;                 // Second scenario for interpolation

// Phases-as-lots toggle (FASE 1, FASE 2 polygons become lots)
let _phasesAsLots = false;
let _phaseLotIndices = [];                        // Lot indices created from phases
let _phaseLotCells = [];                          // Cells stamped from phases
let _inovusConnectorCells = [];                   // Cells stamped for Inovus road access

// ═══════════════════════════════════════════════════════════════════════════════
// SLEEP LOTS — Overnight parking for CLEARED particles when bridge is closed
// ═══════════════════════════════════════════════════════════════════════════════
const SLEEP_LOT_INDICES = [31, 77, 58, 35];       // Designated sleep lot indices
const WAKE_OFFSETS = [3600, 2700, 1800, 0];       // 1hr, 45min, 30min, 0min before opening
const sleepingParticles = [];                     // Particles currently sleeping

// Phase sleep lots (FASE 1 when inovus enabled)
let _phaseSleepLotIndices = [];                   // Lot indices for phase sleep lots

// Sleep lot routing (computed in rebuildPhi)
const phi_sleepLots = new Float32Array(N2);       // Distance to sleep lots
const nextHop_sleepLots = new Int32Array(N2);     // Next cell toward sleep lot

function isSleepLot(lotIdx) {
    return SLEEP_LOT_INDICES.includes(lotIdx) || _phaseSleepLotIndices.includes(lotIdx);
}

function isBridgeOpen() {
    return SERVICE_TIME_S !== Infinity && sinkCapKgPerHour > 0;
}

function getNextBridgeOpenHour() {
    const currentHour = Math.floor(simTime / 3600) % 24;
    for (let i = 1; i <= 24; i++) {
        const h = (currentHour + i) % 24;
        if (!rendererContext?.scenario?.getPharrGateCapacity) return currentHour;
        const cap = rendererContext.scenario.getPharrGateCapacity(h);
        if (cap && cap.cap_kg_per_hour > 0) return h;
    }
    return currentHour;  // Fallback: never opens
}

// ═══════════════════════════════════════════════════════════════════════════════
// CBP LANE MODEL — Replaces budget-based draining
// Particles exit ONLY on service completion, never by budget math.
// ═══════════════════════════════════════════════════════════════════════════════
const sinkQueue = [];                             // Particles waiting for CBP
const BASE_LANES = 7;                             // CBP inspection lanes per bridge
const MAX_LANES = 14;                             // Max lanes (twin span = 2x bridges)
const CBP_LANES = Array.from({ length: MAX_LANES }, () => ({
    particle: null,
    busyUntil: 0,
}));
let SERVICE_TIME_S = Infinity;                    // Seconds per truck per lane (Infinity = closed)

// Get effective lane count (doubles with twin span)
function getEffectiveLanes() {
    return Math.floor(BASE_LANES * _twinSpanCapMult);
}

// Lot tracking
let cellToLotIndex = new Int16Array(N2);         // Cell → lot index (-1 if not lot)
let lotToCellIndices = [];                        // Lot → array of cell indices
let lotCapacity = new Float32Array(0);            // Max kg per lot
let lotMass = new Float32Array(0);                // Current kg per lot

// Lot draining/cooldown state
// Once a lot hits cutoff and starts releasing, it stays excluded until empty + cooldown
let lotDraining = new Set();                      // Lots currently draining (exclude from phi)
let lotCooldownEndSimS = new Float64Array(0);     // Sim-time seconds when cooldown ends (0 = no cooldown)
const LOT_COOLDOWN_S = 60;                        // 60 sim-seconds after empty (dt-invariant)

// ═══════════════════════════════════════════════════════════════════════════════
// REPLAY LOT PARTICLES — Fake particles for lot fill visualization during replay
// ═══════════════════════════════════════════════════════════════════════════════

let _replayLotParticles = [];                     // Array of fake particles for replay rendering
let _replayLotParticleMode = false;               // Whether to render replay lot particles

/**
 * Update replay lot particles based on interpolated fill ratios.
 * Creates/removes particles to match the sampled lot fill levels.
 *
 * @param {number[]} lotFillRatios - Array of fill ratios (0-1) per lot
 */
export function updateReplayLotParticles(lotFillRatios) {
    if (!lotFillRatios || lotFillRatios.length === 0) {
        _replayLotParticles = [];
        _replayLotParticleMode = false;
        return;
    }

    _replayLotParticleMode = true;
    const newParticles = [];

    for (let lotIdx = 0; lotIdx < lotFillRatios.length && lotIdx < lotToCellIndices.length; lotIdx++) {
        const fillRatio = lotFillRatios[lotIdx] || 0;
        const capacity = lotCapacity[lotIdx] || 0;
        if (capacity <= 0 || fillRatio <= 0) continue;

        // Target particle count = fillRatio * capacity / TRUCK_KG
        const targetCount = Math.round(fillRatio * capacity / TRUCK_KG);
        const lotCells = lotToCellIndices[lotIdx];
        if (!lotCells || lotCells.length === 0) continue;

        // Create particles distributed across lot cells
        for (let i = 0; i < targetCount; i++) {
            // Pick a random cell in this lot (deterministic based on i for stability)
            const cellIdx = lotCells[i % lotCells.length];
            const fx = cellIdx % N;
            const fy = Math.floor(cellIdx / N);

            // Add jitter within cell
            const jitterX = ((i * 7) % 100) / 100 - 0.5;  // Deterministic pseudo-random
            const jitterY = ((i * 13) % 100) / 100 - 0.5;
            const wx = fieldToWorldX(fx + 0.5 + jitterX * 0.8);
            const wy = fieldToWorldY(fy + 0.5 + jitterY * 0.8);

            newParticles.push({
                x: wx,
                y: wy,
                state: STATE.LOT,
                lotIdx: lotIdx,
                isReplayParticle: true,
            });
        }
    }

    _replayLotParticles = newParticles;
    _particlesDirty = true;  // Force GL sync
}

/**
 * Clear all replay lot particles (call when replay ends).
 */
export function clearReplayLotParticles() {
    _replayLotParticles = [];
    _replayLotParticleMode = false;
    _particlesDirty = true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARTICLE TRAILS — Motion streaks for high-speed replay visualization
// ═══════════════════════════════════════════════════════════════════════════════
// At 168x replay speed, particles move too fast to see. Trails show motion by
// keeping the last N positions of each particle and rendering them as fading streaks.

const TRAIL_LENGTH = 8;                            // Number of past positions to keep
const _particleTrails = new Map();                 // particle.id → [{x, y}, ...]  (ring buffer)
let _trailsEnabled = false;                        // Whether to render trails

/**
 * Enable or disable particle trails for replay mode.
 */
export function setTrailsEnabled(enabled) {
    _trailsEnabled = enabled;
    if (!enabled) {
        _particleTrails.clear();
    }
    _particlesDirty = true;
}

export function getTrailsEnabled() {
    return _trailsEnabled;
}

/**
 * Update trail history for all active particles.
 * Should be called each tick during REPLAY_MODE before position updates.
 */
function updateParticleTrails() {
    if (!_trailsEnabled || !REPLAY_MODE) return;

    for (let i = 0; i < _activeParticleCount; i++) {
        const p = _activeParticles[i];

        // Skip particles in lots (they don't move, no trail needed)
        if (p.state === STATE.LOT || p.state === STATE.PARK) continue;

        let trail = _particleTrails.get(p.id);
        if (!trail) {
            trail = [];
            _particleTrails.set(p.id, trail);
        }

        // Add current position to trail
        trail.push({ x: p.x, y: p.y });

        // Keep only last TRAIL_LENGTH positions
        if (trail.length > TRAIL_LENGTH) {
            trail.shift();
        }
    }
}

/**
 * Clear all particle trails.
 * Call when replay ends or trails are disabled.
 */
export function clearParticleTrails() {
    _particleTrails.clear();
    _particlesDirty = true;
}

/**
 * Remove trail for a specific particle (call when particle exits).
 */
function removeParticleTrail(particleId) {
    _particleTrails.delete(particleId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARK WAITING ZONES — First-class physical container for staging/holds
// ═══════════════════════════════════════════════════════════════════════════════

// Park zone tracking (parallel to lot tracking, but semantically distinct)
let parkCellIndices = [];                         // All cells in any park zone
let cellToParkIndex = new Int16Array(N2);         // Cell → park index (-1 if not park)
let parkToCellIndices = [];                       // Park → array of cell indices
let parkCapacity = new Float32Array(0);           // Max kg per park
let parkMass = new Float32Array(0);               // Current kg per park

// Routing to parks (restricted mass seeks parks before lots)
const phi_parks = new Float32Array(N2);           // Distance to nearest park
const nextHop_parks = new Int32Array(N2);         // Next cell toward park

// Park release timing
const PARK_DWELL_HOURS = 4;                       // Hours in park before release to lot
const PARK_DWELL_S = PARK_DWELL_HOURS * 3600;     // Dwell time in seconds
const PARK_DWELL_24H_S = 24 * 3600;               // 24-hour dwell for industrial park particles
const parkReleaseQueue = [];                      // FIFO queue for park → lot/road release

// Park capacity density (kg per m² of park area)
const PARK_KG_PER_M2 = 4.0;                       // Higher than lots - staging is denser

// ═══════════════════════════════════════════════════════════════════════════════
// INDUSTRIAL PARK TRACKING — For source injection only (merged with regular parks)
// Industrial parks now use the same storage system as regular parks
// ═══════════════════════════════════════════════════════════════════════════════

let industrialParkCellIndices = [];               // All cells in any industrial park (for geometry tracking)
let cellToIndustrialParkIndex = new Int16Array(N2); // Cell → industrial park index (-1 if not, for source mapping)
let industrialParkToCellIndices = [];             // Park → array of cell indices (for geometry)

// Industrial parks now use regular park storage system - no separate mapping needed

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUTER FRICTION FIELD — Spatial arrays
// ═══════════════════════════════════════════════════════════════════════════════
const commuterLoad = new Float32Array(N2);        // [0, 1+] dynamic, updated each tick
const baseCommuterWeight = new Float32Array(N2);  // [0, 1] static spatial map (arterials=1, collectors=0.4)
const commuterType = new Uint8Array(N2);          // 0=none, 1=arterial, 2=industrial_approach, 3=aduana
const isIntersection = new Uint8Array(N2);        // 1 = intersection cell (3+ road neighbors)
const speedLimitMS = new Float32Array(N2);        // Speed limit per cell (m/s), 0 = use default

// Commuter type constants
const CTYPE_NONE = 0;
const CTYPE_ARTERIAL = 1;
const CTYPE_INDUSTRIAL = 2;
const CTYPE_ADUANA = 3;
const CTYPE_URBAN = 4;

// Speed limit constants (km/h → m/s)
const SPEED_DEFAULT_KPH = 36;
const SPEED_DEFAULT_MS = SPEED_DEFAULT_KPH / 3.6;  // 10 m/s
const SPEED_SAFE_KPH = 25;
const SPEED_SAFE_MS = SPEED_SAFE_KPH / 3.6;        // 6.94 m/s (bridge approaches, constrained zones)
const SPEED_BLVD_KPH = 55;
const SPEED_BLVD_MS = SPEED_BLVD_KPH / 3.6;        // 15.28 m/s
const SPEED_LIBRAMIENTO_KPH = 110;
const SPEED_LIBRAMIENTO_MS = SPEED_LIBRAMIENTO_KPH / 3.6;  // 30.56 m/s

// ═══════════════════════════════════════════════════════════════════════════════
// PARTICLE — Lives inside cells, moves atomically with mass
// ═══════════════════════════════════════════════════════════════════════════════

let particleIdCounter = 0;
const SPAWN_JITTER_M = 30;        // ±30m random offset at birth - matches legacy
const PARTICLE_LIFE_S = 700000;   // No practical age-based death - matches legacy

// Simple seeded RNG for deterministic jitter
let _rngState = 12345;
function rng() {
    _rngState = (_rngState * 1103515245 + 12345) & 0x7fffffff;
    return _rngState / 0x7fffffff;
}

function createParticle(cellIdx, state, sourceType = SOURCE_TYPE.UNKNOWN) {
    _spawnCount++;
    const fx = cellIdx % N;
    const fy = Math.floor(cellIdx / N);
    const baseX = fieldToWorldX(fx + 0.5);
    const baseY = fieldToWorldY(fy + 0.5);

    // ─────────────────────────────────────────────────────────────────────────
    // LAYER E: Shoulder suppression - reduce spawn jitter when commuters present
    // High commuter load = less usable shoulder = particles closer to center
    // ─────────────────────────────────────────────────────────────────────────
    const load = commuterLoad[cellIdx] || 0;
    const jitterScale = load > 0.3 ? (1 - 0.5 * load) : 1.0;

    // Spawn jitter: ±15m random offset (scaled by shoulder suppression)
    const jitterX = (rng() - 0.5) * SPAWN_JITTER_M * 2 * jitterScale;
    const jitterY = (rng() - 0.5) * SPAWN_JITTER_M * 2 * jitterScale;
    const wx = baseX + jitterX;
    const wy = baseY + jitterY;

    // Life varies ±20%
    const life = PARTICLE_LIFE_S * (0.8 + rng() * 0.4);

    return {
        id: particleIdCounter++,
        cellIdx,
        // Current position (continuous drift toward nextHop)
        x: wx,
        y: wy,
        // Previous position (for interpolation during boundary crossing)
        px: wx,
        py: wy,
        state,
        // Source tracking (for debug coloring)
        sourceType,
        // Lifecycle
        age: 0,
        life,
        // Park tracking
        parkIdx: -1,
        parkArrivalTime: 0,
        parkDwell24h: false,  // If true, use 24-hour dwell instead of 4-hour
        // Lot tracking
        lotIdx: -1,
        lotArrivalTime: 0,
        dwellEnd: 0,          // Absolute simTime when dwell completes
        lotParked: false,     // One-time scatter flag
        // Render flags
        renderStalled: false, // Visual stall indicator (capacity gate)
        stallReason: null,    // Why stalled: 'dead_end', 'lot_full', 'pre_lot_hold'
        // Routing lineage (causal debugging)
        routingVersion: _routingVersion,  // Version when last routed
        lastRouteCell: -1,                // Cell where last routing decision was made
        lastRouteNh: -1,                  // nextHop from that decision
        stallStartVersion: -1,            // Routing version when stall began
        // Performance: slot index for O(1) removal
        slotIdx: -1,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSION QUEUE — FIFO, oldest first
// ═══════════════════════════════════════════════════════════════════════════════

const conversionQueue = [];  // Particles waiting for conversion
let simTime = 0;

// Headless time control — allows external time management
export function setSimTime(t) {
    simTime = t;
}

export function getSimTime() {
    return simTime;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSTANT REPLAY — Debug DVR for catching visual anomalies
// ═══════════════════════════════════════════════════════════════════════════════
// INVARIANT: Snapshots are keyed to simTime, never render cadence.
// - Prevents duplicate snapshots
// - Prevents missed seconds
// - Prevents off-by-one rewind bugs
// ═══════════════════════════════════════════════════════════════════════════════

const SNAPSHOT_BUFFER_SIZE = 30;
const snapshotBuffer = [];
let snapshotHead = 0;
let lastSnapshotSecond = -1;

// Explicit particle serializer — schema-locked, no spread operator
function serializeParticle(p) {
    return {
        id: p.id,
        cellIdx: p.cellIdx,
        x: p.x, y: p.y,
        px: p.px, py: p.py,
        state: p.state,
        sourceType: p.sourceType,
        age: p.age,
        life: p.life,
        parkIdx: p.parkIdx,
        parkArrivalTime: p.parkArrivalTime,
        parkDwell24h: p.parkDwell24h,
        lotIdx: p.lotIdx,
        lotArrivalTime: p.lotArrivalTime,
        dwellEnd: p.dwellEnd,
        lotParked: p.lotParked,
        sleepLotIdx: p.sleepLotIdx,
        sleepArrivalTime: p.sleepArrivalTime,
        wakeOffset: p.wakeOffset,
        _cbpLane: p._cbpLane,
        _cbpEndTime: p._cbpEndTime,
        _intersectionHoldUntil: p._intersectionHoldUntil,
    };
}

// Capture — triggers on integer sim-second crossing only
export function captureSnapshot() {
    const currentSecond = Math.floor(simTime);
    if (currentSecond <= lastSnapshotSecond) return;

    const snap = {
        simSecond: currentSecond,
        simTime,
        rngState: _rngState,
        particles: [],
        lotMass: [...lotMass],
        sinkQueue: sinkQueue.map(p => p.id),
        conversionQueue: conversionQueue.map(p => p.id),
        sleepingParticles: sleepingParticles.map(p => p.id),
        parkReleaseQueue: parkReleaseQueue.map(p => p.id),
        cbpLanes: CBP_LANES.map(l => ({
            particleId: l.particle ? l.particle.id : null,
            busyUntil: l.busyUntil,
        })),
    };

    // Serialize all active particles
    for (let i = 0; i < _activeParticleCount; i++) {
        snap.particles.push(serializeParticle(_activeParticles[i]));
    }

    snapshotBuffer[snapshotHead] = snap;
    snapshotHead = (snapshotHead + 1) % SNAPSHOT_BUFFER_SIZE;
    lastSnapshotSecond = currentSecond;
}

function findSnapshot(targetTime) {
    const targetSecond = Math.floor(targetTime);
    let best = null;
    for (const snap of snapshotBuffer) {
        if (!snap) continue;
        if (snap.simSecond <= targetSecond) {
            if (!best || snap.simSecond > best.simSecond) {
                best = snap;
            }
        }
    }
    return best;
}

function rebuildCellArraysFromParticles() {
    cellMass.fill(0);
    for (let i = 0; i < N2; i++) cellParticles[i].length = 0;

    for (let i = 0; i < _activeParticleCount; i++) {
        const p = _activeParticles[i];
        cellMass[p.cellIdx] += particleMass();
        p.slotIdx = cellParticles[p.cellIdx].length;
        cellParticles[p.cellIdx].push(p);
    }
}

export function restoreSnapshot(targetTime) {
    const snap = findSnapshot(targetTime);
    if (!snap) return false;

    // Restore RNG state
    _rngState = snap.rngState;
    simTime = snap.simTime;
    lastSnapshotSecond = snap.simSecond;

    // Restore lot mass
    for (let i = 0; i < snap.lotMass.length && i < lotMass.length; i++) {
        lotMass[i] = snap.lotMass[i];
    }

    // Rebuild particles from snapshot
    _activeParticleCount = 0;
    _movingParticleCount = 0;
    const idToParticle = new Map();
    for (const pSnap of snap.particles) {
        const p = { ...pSnap };
        p.activeIdx = _activeParticleCount;
        _activeParticles[_activeParticleCount++] = p;
        // Rebuild movingParticles for ROAD/CLEARED states
        if (p.state === STATE.ROAD || p.state === STATE.CLEARED) {
            p.movingIdx = _movingParticleCount;
            _movingParticles[_movingParticleCount++] = p;
        } else {
            p.movingIdx = -1;
        }
        idToParticle.set(p.id, p);
    }

    // Rebuild cell arrays
    rebuildCellArraysFromParticles();

    // Restore all queues
    const restoreQueue = (queue, ids) => {
        queue.length = 0;
        for (const id of ids) {
            const p = idToParticle.get(id);
            if (p) queue.push(p);
        }
    };
    restoreQueue(sinkQueue, snap.sinkQueue);
    restoreQueue(conversionQueue, snap.conversionQueue);
    restoreQueue(sleepingParticles, snap.sleepingParticles);
    restoreQueue(parkReleaseQueue, snap.parkReleaseQueue);

    // Restore CBP lanes
    for (let i = 0; i < CBP_LANES.length; i++) {
        const ls = snap.cbpLanes[i];
        CBP_LANES[i].particle = ls.particleId ? idToParticle.get(ls.particleId) : null;
        CBP_LANES[i].busyUntil = ls.busyUntil;
    }

    _particlesDirty = true;
    return true;
}

export function getSnapshotCount() {
    return snapshotBuffer.filter(s => s).length;
}

export function getOldestSnapshotTime() {
    let oldest = Infinity;
    for (const snap of snapshotBuffer) {
        if (snap && snap.simTime < oldest) oldest = snap.simTime;
    }
    return oldest === Infinity ? null : oldest;
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS — What actually happened
// ═══════════════════════════════════════════════════════════════════════════════

const metrics = {
    injected: 0,
    moved: 0,
    enteredLots: 0,
    converted: 0,
    exited: 0,
    violations: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS PANEL — Rate tracking
// ═══════════════════════════════════════════════════════════════════════════════

let _lastMetricsTime = 0;
let _lastInjected = 0;
let _lastExited = 0;
let _inRateKtMin = 0;
let _outRateKtMin = 0;
let _dtMs = 0;

// ═══════════════════════════════════════════════════════════════════════════════
// COORDINATE TRANSFORMS
// ═══════════════════════════════════════════════════════════════════════════════

const roi = {
    centerX: 0,
    centerY: 0,
    sizeM: COMPUTE_WINDOW.SIZE_M,
    cellSize: COMPUTE_WINDOW.SIZE_M / N,
};

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

/** Precompute cell centers for O(1) lookup in drift loop (call after ROI is set) */
function initCellCenters() {
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const idx = y * N + x;
            cellCenterX[idx] = roi.centerX + ((x + 0.5) / N - 0.5) * roi.sizeM;
            cellCenterY[idx] = roi.centerY + ((y + 0.5) / N - 0.5) * roi.sizeM;
        }
    }
}

// Build bridge approach cache - mark cells inside the approach quadrilateral
function initBridgeApproachCache() {
    _bridgeApproachCache = new Uint8Array(N2);
    let count = 0;
    for (let idx = 0; idx < N2; idx++) {
        const wx = cellCenterX[idx];
        const wy = cellCenterY[idx];
        if (isInBridgeApproach(wx, wy)) {
            _bridgeApproachCache[idx] = 1;
            count++;
        }
    }
    logBuild(`[INIT] Bridge approach region: ${count} cells marked for 3x capacity`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVARIANT ENFORCEMENT — Throw on violation
// ═══════════════════════════════════════════════════════════════════════════════

function assertCellInvariant(idx, context) {
    const mass = cellMass[idx];
    const particles = cellParticles[idx];
    const expectedMass = particles.length * particleMass();
    const delta = Math.abs(mass - expectedMass);

    if (delta > 1) {  // Strict: mass must match particle count exactly
        metrics.violations++;
        throw new Error(
            `[INVARIANT:CELL] ${context}: cell=${idx} mass=${mass.toFixed(0)} ` +
            `particles=${particles.length} expected=${expectedMass.toFixed(0)} delta=${delta.toFixed(0)}`
        );
    }
    
    for (const p of particles) {
        if (p.cellIdx !== idx) {
            metrics.violations++;
            throw new Error(
                `[INVARIANT:PARTICLE] ${context}: particle ${p.id} claims cell=${p.cellIdx} but is in cell=${idx}`
            );
        }
    }
}

function assertLotInvariant(lotIdx, context) {
    if (lotMass[lotIdx] > lotCapacity[lotIdx] * 1.001) {
        metrics.violations++;
        throw new Error(
            `[INVARIANT:LOT] ${context}: lot=${lotIdx} mass=${lotMass[lotIdx].toFixed(0)} > capacity=${lotCapacity[lotIdx].toFixed(0)}`
        );
    }
}

function assertGlobalInvariant(context) {
    let totalMass = 0;
    let totalParticles = 0;
    
    for (let i = 0; i < N2; i++) {
        totalMass += cellMass[i];
        totalParticles += cellParticles[i].length;
    }
    
    const expectedMass = totalParticles * particleMass();
    const delta = Math.abs(totalMass - expectedMass);

    if (delta > particleMass()) {
        metrics.violations++;
        throw new Error(
            `[INVARIANT:GLOBAL] ${context}: totalMass=${totalMass.toFixed(0)} particles=${totalParticles} expected=${expectedMass.toFixed(0)}`
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTHORIZED WRITE PATHS — One function per state transition
// ═══════════════════════════════════════════════════════════════════════════════

// AUTHORIZED WRITE: cellMass += TRUCK_KG ONLY IN injectParticle()
function injectParticle(cellIdx, state = STATE.ROAD) {
    // Lookup source type from cell mapping
    const sourceType = _cellToSourceType.get(cellIdx) || SOURCE_TYPE.UNKNOWN;
    const p = createParticle(cellIdx, state, sourceType);
    p.slotIdx = cellParticles[cellIdx].length;
    cellParticles[cellIdx].push(p);
    activeCells.add(cellIdx);
    addToActiveParticles(p);  // Flat array for GPU sync
    if (state === STATE.ROAD || state === STATE.CLEARED) {
        addToMovingParticles(p);  // Only moving particles need drift iteration
    }
    cellMass[cellIdx] += particleMass();
    metrics.injected += particleMass();
    assertCellInvariant(cellIdx, 'injectParticle');
    return p;
}

// Inject with source-dependent split
// Corridors: 65% restricted (ROAD → lot → convert), 35% cleared (direct to PHARR)
// Industrial parks: 60% cleared, 20% ROAD (route to lots), 20% PARK (24h dwell)
function injectWithSplit(cellIdx) {
    const sourceType = _cellToSourceType.get(cellIdx) || SOURCE_TYPE.UNKNOWN;

    if (sourceType === SOURCE_TYPE.INDUSTRIAL) {
        // Industrial park: 60% cleared, 20% ROAD, 20% PARK (24h)
        return injectIndustrialParticle(cellIdx);
    }

    // Corridor sources: 65% restricted (needs lot), 35% cleared
    const isRestricted = rng() < TRANSFER_REQUIREMENT_FRACTION;
    return injectParticle(cellIdx, isRestricted ? STATE.ROAD : STATE.CLEARED);
}

// AUTHORIZED WRITE: Industrial park injection - merged with regular parks
// 60% inject as CLEARED, 20% inject as ROAD (route to lots), 20% inject as PARK (24h dwell)
function injectIndustrialParticle(cellIdx) {
    const rand = rng();
    
    if (rand < 0.6) {
        // 60% inject as CLEARED (direct to PHARR)
        return injectParticle(cellIdx, STATE.CLEARED);
    } else if (rand < 0.8) {
        // 20% inject as ROAD (route to lots)
        return injectParticle(cellIdx, STATE.ROAD);
    } else {
        // 20% inject as PARK (24-hour dwell)
        // Find the park that contains this source cell
        const parkIdx = cellToParkIndex[cellIdx];
        if (parkIdx < 0) {
            // No park found, fallback to ROAD
            return injectParticle(cellIdx, STATE.ROAD);
        }
        
        // Check park capacity
        if (parkMass[parkIdx] >= parkCapacity[parkIdx]) {
            // Park full, fallback to ROAD
            return injectParticle(cellIdx, STATE.ROAD);
        }
        
        // Scatter to random cell within park
        const parkCells = parkToCellIndices[parkIdx];
        const targetCell = parkCells.length > 0
            ? parkCells[Math.floor(rng() * parkCells.length)]
            : cellIdx;
        
        // Create particle in park state with 24-hour dwell
        const p = createParticle(targetCell, STATE.PARK, SOURCE_TYPE.INDUSTRIAL);
        p.parkIdx = parkIdx;
        p.parkArrivalTime = simTime;
        p.parkDwell24h = true;  // Mark for 24-hour dwell
        p.slotIdx = cellParticles[targetCell].length;
        cellParticles[targetCell].push(p);
        activeCells.add(targetCell);
        addToActiveParticles(p);  // Flat array for GPU sync
        cellMass[targetCell] += particleMass();
        parkMass[parkIdx] += particleMass();
        metrics.injected += particleMass();
        parkReleaseQueue.push(p);
        
        assertCellInvariant(targetCell, 'injectIndustrialParticle');
        return p;
    }
}

// AUTHORIZED WRITE: state changes to CLEARED ONLY IN convertParticle()
function convertParticle(p) {
    if (p.state !== STATE.LOT) {
        throw new Error(`[INVARIANT:CONVERT] Cannot convert particle in state ${p.state}`);
    }

    p.state = STATE.CLEARED;
    addToMovingParticles(p);

    // Assign to twin span based on particle ID (deterministic 50/50 split)
    p.useTwinSpan = _twinSpanActive && (p.id % 2 === 0);

    // Reduce lot mass (particle stays in cell until it flows out)
    if (p.lotIdx >= 0) {
        lotMass[p.lotIdx] -= particleMass();
    }

    metrics.converted += particleMass();
    return particleMass();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARK TRANSITIONS — Authorized writes for park waiting zones
// ═══════════════════════════════════════════════════════════════════════════════

// AUTHORIZED WRITE: particle released from park ONLY IN releasePark()
function releasePark(p) {
    if (p.state !== STATE.PARK) {
        throw new Error(`[INVARIANT:RELEASE] Cannot release particle in state ${p.state}`);
    }

    // Release from park mass accounting
    if (p.parkIdx >= 0) {
        parkMass[p.parkIdx] -= particleMass();
    }

    // Transition to ROAD state (will seek lot or exit via normal flow)
    p.state = STATE.ROAD;
    addToMovingParticles(p);
    p.parkIdx = -1;
    p.parkArrivalTime = 0;
    p.parkDwell24h = false;

    metrics.releasedFromParks = (metrics.releasedFromParks || 0) + particleMass();

    return particleMass();
}

// Park invariant check
function assertParkInvariant(parkIdx, context) {
    if (parkMass[parkIdx] > parkCapacity[parkIdx] * 1.001) {
        metrics.violations++;
        throw new Error(
            `[INVARIANT:PARK] ${context}: park=${parkIdx} mass=${parkMass[parkIdx].toFixed(0)} > capacity=${parkCapacity[parkIdx].toFixed(0)}`
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDUSTRIAL PARK TRANSITIONS — Authorized writes for industrial holding zones
// ═══════════════════════════════════════════════════════════════════════════════

// Find nearest road cell with valid routing to PHARR
function findNearestRoutableRoad(fromCellIdx) {
    const fx = fromCellIdx % N;
    const fy = Math.floor(fromCellIdx / N);

    let bestCell = -1;
    let bestDistSq = Infinity;

    for (const roadIdx of roadCellIndices) {
        // Must have valid routing
        if (nextHop_pharr[roadIdx] < 0) continue;

        const rx = roadIdx % N;
        const ry = Math.floor(roadIdx / N);
        const dx = rx - fx;
        const dy = ry - fy;
        const distSq = dx * dx + dy * dy;

        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            bestCell = roadIdx;
        }
    }

    return bestCell;
}


// ═══════════════════════════════════════════════════════════════════════════════
// DIJKSTRA — Compute shortest paths to sinks
// ═══════════════════════════════════════════════════════════════════════════════

class MinHeap {
    constructor() { this.data = []; }
    
    push(item) {
        this.data.push(item);
        let i = this.data.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.data[parent][0] <= this.data[i][0]) break;
            [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
            i = parent;
        }
    }
    
    pop() {
        if (this.data.length === 0) return undefined;
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            let i = 0;
            while (true) {
                let smallest = i;
                const left = 2 * i + 1, right = 2 * i + 2;
                if (left < this.data.length && this.data[left][0] < this.data[smallest][0]) smallest = left;
                if (right < this.data.length && this.data[right][0] < this.data[smallest][0]) smallest = right;
                if (smallest === i) break;
                [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
                i = smallest;
            }
        }
        return top;
    }
    
    isEmpty() { return this.data.length === 0; }
}

function computePotential(sinkIndices, phiOutput, label, sinkBias = null, biasWeight = 0, KxxSource = null, KyySource = null) {
    // Use overrides if provided, otherwise global K fields
    const KxxUse = KxxSource || Kxx;
    const KyyUse = KyySource || Kyy;

    const dijkstraStart = Date.now();
    phiOutput.fill(PHI_LARGE);

    if (sinkIndices.length === 0) {
        log(`[DIJKSTRA:${label}] No sinks`);
        return 0;
    }

    const edgeCost = roi.cellSize;
    const heap = new MinHeap();
    const visited = new Uint8Array(N2);

    // Initialize sinks (optionally biased by distance to another target)
    for (const idx of sinkIndices) {
        let initCost = PHI_SINK;
        if (sinkBias && biasWeight > 0 && sinkBias[idx] < PHI_LARGE) {
            // Add bias: sinks closer to bias target (lower sinkBias) are more attractive
            initCost += biasWeight * sinkBias[idx];
        }
        phiOutput[idx] = initCost;
        heap.push([initCost, idx]);
    }

    let reachable = 0;

    while (!heap.isEmpty()) {
        const [cost, idx] = heap.pop();

        if (visited[idx]) continue;
        visited[idx] = 1;
        reachable++;

        // 4-connected neighbors only
        const x = idx % N;
        const y = Math.floor(idx / N);
        const neighbors = [];
        if (x > 0) neighbors.push(idx - 1);
        if (x < N - 1) neighbors.push(idx + 1);
        if (y > 0) neighbors.push(idx - N);
        if (y < N - 1) neighbors.push(idx + N);

        for (const ni of neighbors) {
            // Must be traversable (use K overrides if provided)
            if (KxxUse[ni] < K_THRESHOLD && KyyUse[ni] < K_THRESHOLD) continue;

            // Draining lots are walls - completely impassable
            if (regionMap[ni] === REGION.LOT) {
                const lotIdx = cellToLotIndex[ni];
                if (lotIdx >= 0 && lotDraining.has(lotIdx)) continue;
            }

            // For PHARR routing: prevent roads from getting phi VIA lots (keeps lot phi valid for exit)
            // Block LOT→ROAD propagation so roads use road-only paths, but lots still get phi from roads
            if (label === 'PHARR' && regionMap[idx] === REGION.LOT && regionMap[ni] !== REGION.LOT) continue;

            // Capacity bias: penalize entry into fuller lots (advisory, not hard gate)
            // This biases routing toward emptier lots; physics still enforces hard gate at entry
            let capacityPenalty = 1.0;
            if (label === 'LOTS' && regionMap[ni] === REGION.LOT) {
                const lotIdx = cellToLotIndex[ni];
                if (lotIdx >= 0 && lotCapacity[lotIdx] > 0) {
                    const util = lotMass[lotIdx] / lotCapacity[lotIdx];
                    capacityPenalty = 1.0 + 4.0 * Math.pow(util, 3);  // Ramps up as lot fills
                }
            }

            const newCost = cost + edgeCost * capacityPenalty;
            if (newCost < phiOutput[ni]) {
                phiOutput[ni] = newCost;
                heap.push([newCost, ni]);
            }
        }
    }

    logBuild(`[DIJKSTRA:${label}] reachable=${reachable} (${((Date.now() - dijkstraStart)/1000).toFixed(1)}s)`);
    return reachable;
}

function buildNextHop(phiInput, nhOutput, label = null) {
    nhOutput.fill(-1);

    for (let idx = 0; idx < N2; idx++) {
        if (phiInput[idx] >= PHI_LARGE) continue;

        const x = idx % N;
        const y = Math.floor(idx / N);
        const neighbors = [];
        if (x > 0) neighbors.push(idx - 1);
        if (x < N - 1) neighbors.push(idx + 1);
        if (y > 0) neighbors.push(idx - N);
        if (y < N - 1) neighbors.push(idx + N);

        let bestNh = -1;
        let bestPhi = phiInput[idx];

        // For PHARR routing: non-lot cells cannot pick lot neighbors
        // (cleared particles must use roads only, lots can exit to roads)
        const skipLots = (label === 'PHARR' && regionMap[idx] !== REGION.LOT);

        for (const ni of neighbors) {
            if (skipLots && regionMap[ni] === REGION.LOT) continue;
            if (phiInput[ni] < bestPhi) {
                bestPhi = phiInput[ni];
                bestNh = ni;
            }
        }

        nhOutput[idx] = bestNh;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROAD CELL CAPACITY — Physical density limit, resolution-independent
// Computes hard cap and congestion onset based on cell geometry.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute road cell capacity parameters from cell size.
 * Must be called after roi.cellSize is set.
 *
 * Physical basis:
 *   - Gridlock: trucks at minimum spacing (bumper-to-bumper + 2m gap)
 *   - Congestion onset: ~40% of gridlock density (flow starts degrading)
 */
function computeRoadCellCap() {
    const trucksAtGridlock = (roi.cellSize / TRUCK_SPACING_M) * ROAD_LANES;
    ROAD_CELL_CAP_KG = Math.ceil(trucksAtGridlock) * TRUCK_KG;
    RHO_CONGESTION_0 = ROAD_CELL_CAP_KG * CONGESTION_ONSET_FRAC;
    MAX_RENDER_OFFSET_M = roi.cellSize * 0.45;  // Congestion spread radius

    log(`[CAPACITY] cellSize=${roi.cellSize.toFixed(1)}m × ${ROAD_LANES} lanes`);
    log(`[CAPACITY] gridlock=${trucksAtGridlock.toFixed(1)} trucks → cap=${ROAD_CELL_CAP_KG/1000}t (${Math.ceil(trucksAtGridlock)} trucks)`);
    log(`[CAPACITY] onset=${(RHO_CONGESTION_0/TRUCK_KG).toFixed(1)} trucks (${(CONGESTION_ONSET_FRAC*100).toFixed(0)}% of cap)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONGESTION — Density-based velocity degradation
// Nonlinear throughput degradation in constrained mass-transport network.
// Creates upstream shockwaves when downstream capacity is constrained.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute congestion factor based on local mass density.
 * C(ρ) = 1 / (1 + (ρ / ρ₀)^p)
 * Returns value in (0, 1] where 1 = free flow, →0 = stalled.
 * @param {number} rho - Local mass density (kg per cell)
 * @returns {number} Congestion factor
 */
function congestionFactor(rho) {
    if (rho <= 0) return 1.0;
    // LUT lookup: ratio * 100 gives index (0.01 precision)
    const idx = Math.min(CONGESTION_LUT_SIZE - 1, (rho / RHO_CONGESTION_0 * 100) | 0);
    return CONGESTION_LUT[idx];
}

// Stall metrics — accumulated per step
let _stalledMassKg = 0;        // Mass with congestionFactor < STALL_CUTOFF this frame
let _stallTonHours = 0;        // Accumulated stall-ton-hours (never reset)

// Truck-hours lost metrics — congestion cost
let _truckHoursLost = 0;           // cumulative, monotonic (NEVER decreases)
let _truckHoursLostThisTick = 0;   // per-tick accumulator
let _truckHoursLostRate = 0;       // truck-hours lost per sim-hour
let _lastRateSampleTime = 0;
let _lastRateSampleValue = 0;

// Truck-hours lost BREAKDOWN (instrumentation only, no behavior change)
// Split by cause: congestion vs waiting outside full lots vs bridge queue vs bridge service
let _truckHoursLostCongestion = 0;      // Normal road congestion (density-based)
let _truckHoursLostLotWait = 0;         // Bounced from full lots, waiting on road
let _truckHoursLostBridgeQueue = 0;     // Waiting in CBP queue at PHARR (pre-service only)
let _truckHoursLostBridgeService = 0;   // Being serviced in CBP lane (in-service only)
let _truckHoursLostCongestionTick = 0;  // Per-tick accumulator
let _truckHoursLostLotWaitTick = 0;     // Per-tick accumulator
let _truckHoursLostBridgeQueueTick = 0; // Per-tick accumulator (pre-service)
let _truckHoursLostBridgeServiceTick = 0; // Per-tick accumulator (in-service)

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE TIME INSTRUMENTATION — Per-completion tracking for audit
// ═══════════════════════════════════════════════════════════════════════════════
let _serviceTimeActual = [];           // Collected actualServiceTime per completion (seconds)
let _serviceTimeExpected = [];         // SERVICE_TIME_S at assignment time (seconds)
let _serviceTimeAssignSim = [];        // simTime at assignment (for debugging)

// ═══════════════════════════════════════════════════════════════════════════════
// CONGESTION VISUALIZATION — Density-driven render spread (anti-aliasing)
// Reveals density gradients aliased by grid discretization.
// Physics untouched. Render-only.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get flow basis vectors for a cell (flow direction + lateral).
 */
function getFlowBasis(cellIdx) {
    const nh = nextHop_pharr[cellIdx] >= 0 ? nextHop_pharr[cellIdx] : nextHop_lots[cellIdx];
    if (nh < 0) return null;

    const cx = cellIdx % N, cy = Math.floor(cellIdx / N);
    const nx = nh % N, ny = Math.floor(nh / N);

    const dx = nx - cx;
    const dy = ny - cy;
    const len = Math.hypot(dx, dy) || 1;

    _flowBasis.fx = dx / len;        // flow direction
    _flowBasis.fy = dy / len;
    _flowBasis.lx = -dy / len;       // lateral direction
    _flowBasis.ly = dx / len;
    return _flowBasis;
}

/**
 * Compute render offset for congested/stalled particles.
 *
 * CONGESTED (flowing but slow): Low-amplitude, slow, flow-aligned jitter
 *   "Vibration under load" - pressure, not failure
 *
 * STALLED (hard blocked): High-amplitude, fast, incoherent jitter
 *   "Frustration/deadlock" - exclusion, not pressure
 *
 * Returns {dx, dy} in world meters.
 */
function getCongestionRenderOffset(p) {
    if (regionMap[p.cellIdx] !== REGION.ROAD) {
        _renderOffset.dx = 0; _renderOffset.dy = 0;
        return _renderOffset;
    }

    const rho = cellMass[p.cellIdx] / ROAD_CELL_CAP_KG;
    const isCongested = rho > CONGESTION_ONSET_FRAC;
    const isStalled = p.renderStalled;
    const load = commuterLoad[p.cellIdx];

    // ─────────────────────────────────────────────────────────────────────────
    // LAYER A: Lane narrowing - compress lateral spread toward road center
    // High commuter load = less usable road width = particles closer to center
    // ─────────────────────────────────────────────────────────────────────────
    const laneNarrowFactor = 1 - COMMUTER_LANE_SHRINK * load;  // 1.0 = full width, 0.65 = compressed

    if (!isCongested && !isStalled && load <= 0) {
        _renderOffset.dx = 0; _renderOffset.dy = 0;
        return _renderOffset;
    }

    const basis = getFlowBasis(p.cellIdx);
    if (!basis) {
        _renderOffset.dx = 0; _renderOffset.dy = 0;
        return _renderOffset;
    }

    // Use simTime so jitter freezes when paused
    const t = simTime;

    // Per-particle frequency variation (no lockstep)
    const freqOffset1 = (p.id * 7919) % 1000 / 1000 * Math.PI * 2;
    const freqOffset2 = (p.id * 6271) % 1000 / 1000 * Math.PI * 2;

    let dx = 0, dy = 0;

    if (isStalled) {
        // STALLED: High-amplitude, fast, incoherent jitter
        // "You cannot go there" - frustration/deadlock
        const amp = MAX_RENDER_OFFSET_M * 1.2 * laneNarrowFactor;  // Lane narrowing applies
        const freq = 4.0;  // Fast

        // Two orthogonal phases for 2D wobble (directionless)
        const jx = Math.sin(t * freq + freqOffset1) * amp;
        const jy = Math.sin(t * freq * 1.3 + freqOffset2) * amp * 0.8;

        // Random direction (no flow alignment)
        dx = jx;
        dy = jy;

    } else if (isCongested || load > 0) {
        // CONGESTED or COMMUTER FRICTION: Low-amplitude, slow, flow-aligned jitter
        // "We're packed, but alive" - vibration under load
        const congestionLevel = isCongested
            ? (rho - CONGESTION_ONSET_FRAC) / (1 - CONGESTION_ONSET_FRAC)
            : 0;
        const baseAmp = MAX_RENDER_OFFSET_M * 0.4 * Math.min(1, Math.max(congestionLevel, load * 0.5));
        const amp = baseAmp * laneNarrowFactor;  // Lane narrowing compresses lateral spread
        const freq = 1.5;  // Slow

        // Mostly lateral oscillation with slight longitudinal
        const lateral = Math.sin(t * freq + freqOffset1) * amp;
        const longitudinal = Math.sin(t * freq * 0.7 + freqOffset2) * amp * 0.3;

        // Flow-aligned (directional bias)
        dx = basis.lx * lateral + basis.fx * longitudinal;
        dy = basis.ly * lateral + basis.fy * longitudinal;
    }

    _renderOffset.dx = dx; _renderOffset.dy = dy;
    return _renderOffset;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHYSICS STEP — Continuous drift with boundary-triggered cell transfers (PIC)
// ═══════════════════════════════════════════════════════════════════════════════

let injectionAccumulator = new Map();  // cellIdx → accumulated kg

// ═══════════════════════════════════════════════════════════════════════════════
// STEP TIMING INSTRUMENTATION — find the bottleneck
// ═══════════════════════════════════════════════════════════════════════════════
const _stepTiming = {
    calls: 0,
    commuter: 0,
    injection: 0,
    releases: 0,
    drift: 0,
    cbp: 0,
    lotState: 0,
    lastLog: 0,
};

export async function step(dt) {
    // simTime is synced from external time source in onFrame()
    // NOTE: _particlesDirty is set in update(), not here (headless purity)
    // NOTE: Do NOT cap dt here — simTime is set externally and must match

    // Instant Replay: capture on integer sim-second crossing
    captureSnapshot();

    // Reset per-frame stall tracking
    _stalledMassKg = 0;
    _truckHoursLostThisTick = 0;
    _truckHoursLostCongestionTick = 0;
    _truckHoursLostLotWaitTick = 0;
    _truckHoursLostBridgeQueueTick = 0;
    _truckHoursLostBridgeServiceTick = 0;

    // 0. UPDATE COMMUTER FRICTION: Apply time-of-day modulation to spatial weights
    const tCommuter0 = performance.now();
    updateCommuterLoad();
    _stepTiming.commuter += performance.now() - tCommuter0;

    // 1. LOAD HOURLY RATES: Update capacity and inflow from scenario
    loadGateCapacity();
    loadHourlyInflow();

    // ═══════════════════════════════════════════════════════════════════════════
    // UNIFIED CFL SUBSTEP LOOP
    // ═══════════════════════════════════════════════════════════════════════════
    // Injection, CBP lanes, and drift ALL run inside the CFL loop.
    // This prevents Jensen's inequality drift: at large dt, injection/exit bursts
    // create density spikes that the nonlinear congestion function (ρ^3.7) punishes.
    // Substepping smooths mass flow, making truckHoursLost dt-invariant.
    // ═══════════════════════════════════════════════════════════════════════════
    const maxPossibleSpeed = Math.max(VISUAL_SPEED_MS, SPEED_LIBRAMIENTO_MS);
    const maxMovePerStep = 0.9 * roi.cellSize;
    const cflDt = maxMovePerStep / maxPossibleSpeed;

    // PHYSICAL_TIME_QUANTUM_S
    // Smallest meaningful state-transition interval.
    // Chosen to match driver reaction + congestion persistence.
    // Do not tune for stability.
    const MAX_SUBDT = 0.5;
    const maxDtPerStep = Math.min(cflDt, MAX_SUBDT);

    // CAP SUBSTEPS: Break the death spiral. When a slow frame occurs, run slower-than-realtime
    // instead of trying to "catch up" with thousands of substeps that guarantee worse frames.
    // Also cap dt to ensure subDt stays within CFL bounds.
    const MAX_SUBSTEPS = 120;
    const MAX_DT = MAX_SUBSTEPS * maxDtPerStep;  // Max sim-time per frame (~60s)
    if (dt > MAX_DT) {
        dt = MAX_DT;  // Sim runs slower-than-realtime, but stays stable
    }
    const numSubsteps = dt > maxDtPerStep ? Math.ceil(dt / maxDtPerStep) : 1;
    const subDt = dt / numSubsteps;

    // Advance simTime through substeps so dwell checks see progressive time
    const stepStartTime = simTime - dt;

    for (let i = 0; i < numSubsteps; i++) {
        simTime = stepStartTime + (i + 1) * subDt;

        if (REPLAY_MODE) {
            updateParticleTrails();
            stepDriftAndTransferInner(subDt);
            continue;
        }

        const tInj0 = performance.now();
        stepInjection(subDt);
        _stepTiming.injection += performance.now() - tInj0;

        const tRel0 = performance.now();
        stepParkRelease();
        stepSleepRelease();
        stepConversion();
        _stepTiming.releases += performance.now() - tRel0;

        const tDrift0 = performance.now();
        stepDriftAndTransferInner(subDt);
        _stepTiming.drift += performance.now() - tDrift0;

        const tCbp0 = performance.now();
        stepCBPLanes(subDt);
        _stepTiming.cbp += performance.now() - tCbp0;
    }
    // simTime is now at stepStartTime + dt = original simTime (correct)

    // 7. LOT STATE: Update lot admission state machine
    // Skip in REPLAY_MODE — particles follow pre-recorded paths
    // NOTE: This no longer triggers rebuilds inline — uses markRoutingDirty()
    if (!REPLAY_MODE) {
        const tLot0 = performance.now();
        updateLotAdmissionState();
        _stepTiming.lotState += performance.now() - tLot0;
    }

    // 7b. HEATMAP ACCUMULATORS: Track truck-hours per cell
    // Used for headless PNG export - accumulates over entire run
    const dtHours = dt / 3600;
    for (const idx of roadCellIndices) {
        const mass = cellMass[idx];
        if (mass <= 0) continue;
        cellPresenceHours[idx] += (mass / TRUCK_KG) * dtHours;
    }
    for (const idx of lotCellIndices) {
        const mass = cellMass[idx];
        if (mass <= 0) continue;
        cellLotDwellHours[idx] += (mass / TRUCK_KG) * dtHours;
    }

    // Log timing every 2 seconds
    _stepTiming.calls++;
    const now = performance.now();
    if (now - _stepTiming.lastLog > 2000) {
        const n = _stepTiming.calls || 1;
        if (_verbose) {
            console.log(`[STEP TIMING] calls=${n} particles=${_activeParticleCount} substeps=${numSubsteps}`);
            console.log(`  commuter=${(_stepTiming.commuter/n).toFixed(2)}ms injection=${(_stepTiming.injection/n).toFixed(2)}ms releases=${(_stepTiming.releases/n).toFixed(2)}ms`);
            console.log(`  DRIFT=${(_stepTiming.drift/n).toFixed(2)}ms cbp=${(_stepTiming.cbp/n).toFixed(2)}ms lotState=${(_stepTiming.lotState/n).toFixed(2)}ms`);
        }
        _stepTiming.calls = 0;
        _stepTiming.commuter = 0;
        _stepTiming.injection = 0;
        _stepTiming.releases = 0;
        _stepTiming.drift = 0;
        _stepTiming.cbp = 0;
        _stepTiming.lotState = 0;
        _stepTiming.lastLog = now;
    }

    // 8. STALL METRICS: Accumulate stall-ton-hours
    // _stalledMassKg is now in kg·s (time-integrated across substeps)
    // explicitStallKg is instantaneous and needs dt scaling
    const cbpLanesInUse = CBP_LANES.filter(l => l.particle !== null).length;
    const explicitStallKg = (sinkQueue.length + cbpLanesInUse) * TRUCK_KG + conversionQueue.length * TRUCK_KG;
    // _stalledMassKg: kg·s → ton·hours = kg·s / 1000 / 3600
    // explicitStallKg: kg × dt → ton·hours = kg × dt / 1000 / 3600
    _stallTonHours += (_stalledMassKg / 1000 / 3600) + (explicitStallKg * dt / 1000 / 3600);

    // 9. TRUCK-HOURS LOST: Finalize cumulative metric
    // _truckHoursLostThisTick is now in truck·s (time-integrated across substeps)
    const prevTruckHoursLost = _truckHoursLost;
    _truckHoursLost += _truckHoursLostThisTick / 3600;  // truck·s → truck·hours

    // INSTRUMENTATION: Accumulate breakdown (no behavior change)
    _truckHoursLostCongestion += _truckHoursLostCongestionTick / 3600;
    _truckHoursLostLotWait += _truckHoursLostLotWaitTick / 3600;
    _truckHoursLostBridgeQueue += _truckHoursLostBridgeQueueTick / 3600;
    _truckHoursLostBridgeService += _truckHoursLostBridgeServiceTick / 3600;

    // INVARIANT: cumulative must be monotonic
    if (_truckHoursLost < prevTruckHoursLost) {
        console.error(`[INVARIANT VIOLATION] truckHoursLost decreased: ${prevTruckHoursLost} → ${_truckHoursLost}`);
    }

    // Compute loss rate (sample every 60 sim-seconds)
    if (simTime - _lastRateSampleTime >= 60) {
        const delta = _truckHoursLost - _lastRateSampleValue;
        const elapsed = (simTime - _lastRateSampleTime) / 3600;
        // INVARIANT: c=1 everywhere for full sample → rate must be exactly 0
        // Zero loss produces zero rate — no floating point drift allowed
        if (delta === 0) {
            _truckHoursLostRate = 0;  // Explicit zero, not computed
        } else if (elapsed > 0) {
            _truckHoursLostRate = delta / elapsed;
        } else {
            console.error(`[INVARIANT VIOLATION] delta=${delta} but elapsed=0`);
            _truckHoursLostRate = 0;
        }

        _lastRateSampleTime = simTime;
        _lastRateSampleValue = _truckHoursLost;
    }

    // Node.js: await pending routing rebuild (ensures deterministic step order)
    if (_pendingRebuild) {
        await _pendingRebuild;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CBP LANE FUNCTIONS — Lane-based service model
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update CBP service time from hourly capacity.
 * Called once per hour when capacity changes.
 */
function updateCBPServiceTime() {
    if (_testBlockBridge) {
        SERVICE_TIME_S = Infinity;
        return;
    }
    if (sinkCapKgPerHour > 0) {
        const trucksPerHour = sinkCapKgPerHour / TRUCK_KG;
        const trucksPerLanePerHour = trucksPerHour / getEffectiveLanes();
        SERVICE_TIME_S = 3600 / trucksPerLanePerHour;
    } else {
        SERVICE_TIME_S = Infinity;  // Closed hours
    }
}

/**
 * Process CBP lane completions and assignments for the time window [simTime-dt, simTime].
 * Handles multiple completions per lane per tick when dt > SERVICE_TIME_S.
 * This is the ONLY place particles exit the system.
 *
 * @param {number} dt - Time step in seconds
 */
function stepCBPLanes(dt) {
    // Closed hours or blocked: do nothing
    if (!isFinite(SERVICE_TIME_S)) return;

    const tickStart = simTime - dt;
    const tickEnd = simTime;

    for (const lane of CBP_LANES) {
        // Process all completions that should happen within [tickStart, tickEnd]
        while (lane.particle && lane.busyUntil <= tickEnd) {
            const p = lane.particle;

            // === AUTHORITATIVE EXIT ===
            // Particle is officially processed - count it as exited
            metrics.exited += particleMass();
            _cbpCompletionCount++;

            // AUDIT: Record actual vs expected service time
            if (p._cbpAssignTime !== undefined) {
                const actualServiceTime = simTime - p._cbpAssignTime;
                _serviceTimeActual.push(actualServiceTime);
                _serviceTimeExpected.push(p._cbpExpectedServiceTime || 0);
                _serviceTimeAssignSim.push(p._cbpAssignTime);
            }

            // Transition to DEPARTING state for exit animation
            // Particle stays in sink cell, drift loop will move it out
            // Note: particle is already in movingParticles (was CLEARED, entered SINK but never removed)
            p.state = STATE.DEPARTING;
            p.departureTime = simTime;

            // Lane becomes free at busyUntil time (not simTime)
            const laneFreeTime = lane.busyUntil;
            lane.particle = null;

            // Immediately assign next particle if queue has particles
            if (sinkQueue.length > 0) {
                const next = sinkQueue.shift();
                lane.particle = next;
                // busyUntil starts from when lane became free, not simTime
                lane.busyUntil = laneFreeTime + SERVICE_TIME_S;
                next._cbpLane = lane;
                next._cbpEndTime = lane.busyUntil;
                // AUDIT: Record assignment time and expected service time
                next._cbpAssignTime = laneFreeTime;
                next._cbpExpectedServiceTime = SERVICE_TIME_S;
            } else {
                break;  // No more particles to process in queue
            }
        }

        // Also assign to lanes that were empty at start of tick
        if (lane.particle === null && sinkQueue.length > 0) {
            const p = sinkQueue.shift();
            lane.particle = p;
            // Service starts at beginning of tick window
            lane.busyUntil = tickStart + SERVICE_TIME_S;
            p._cbpLane = lane;
            p._cbpEndTime = lane.busyUntil;
            // AUDIT: Record assignment time and expected service time
            p._cbpAssignTime = tickStart;
            p._cbpExpectedServiceTime = SERVICE_TIME_S;
        }
    }
}

let _lastGateCapHour = -1;

// TEST: Set to true to block bridge completely
let _testBlockBridge = false;

export function toggleBlockBridge() {
    _testBlockBridge = !_testBlockBridge;
    if (_testBlockBridge) {
        sinkCapKgPerHour = 0;
        updateCBPServiceTime();  // Set SERVICE_TIME_S = Infinity
    }
    log(`[TEST] Bridge blocked: ${_testBlockBridge}, sinkQueue=${sinkQueue.length}`);
    return _testBlockBridge;
}

// Draw stop sign at PHARR when bridge is blocked
function drawStopSign(ctx, camera) {
    if (!_testBlockBridge) return;

    const pharr = rendererContext?.geometry?.poePoints?.PHARR;
    if (!pharr) return;

    const screen = camera.worldToScreen(pharr.x, pharr.y);
    const size = 18;

    // Draw octagon
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
        const angle = (i * Math.PI / 4) - Math.PI / 8;
        const x = Math.cos(angle) * size;
        const y = Math.sin(angle) * size;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = '#cc0000';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw STOP text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('STOP', 0, 0);
    ctx.restore();
}

function loadGateCapacity() {
    if (_testBlockBridge) {
        sinkCapKgPerHour = 0;
        updateCBPServiceTime();
        return;
    }
    if (!rendererContext?.scenario?.getPharrGateCapacity) return;

    const currentHour = Math.floor(simTime / 3600) % 24;
    if (currentHour === _lastGateCapHour) return;  // Already loaded for this hour

    const cap = rendererContext.scenario.getPharrGateCapacity(currentHour);
    if (cap && cap.cap_kg_per_hour !== undefined) {
        sinkCapKgPerHour = cap.cap_kg_per_hour * _twinSpanCapMult;
        _lastGateCapHour = currentHour;
        updateCBPServiceTime();
        const serviceInfo = isFinite(SERVICE_TIME_S) ? `${SERVICE_TIME_S.toFixed(1)}s/truck` : 'CLOSED';
        const multInfo = _twinSpanCapMult > 1 ? ` (${_twinSpanCapMult.toFixed(1)}x twin)` : '';
        log(`[SINK] Hour ${currentHour}: ${(sinkCapKgPerHour / 1000).toFixed(0)} t/hr${multInfo}, ${getEffectiveLanes()} lanes, ${serviceInfo}`);
    }
}

// Helper: sum HS2 kg from inflow object
function sumInflowKg(inflow) {
    if (!inflow?.hs2_kg) return 0;
    let sum = 0;
    for (const hs2 in inflow.hs2_kg) {
        sum += inflow.hs2_kg[hs2] || 0;
    }
    return sum;
}

function loadHourlyInflow() {
    if (!rendererContext?.scenario?.getPharrInflow) return;

    const hasInterserrana = _interserranaScenario?.getPharrInflow && _scenarioAlpha > 0;

    // Compute daily total once (sum all 24 hours) for industrial shift calculation
    if (!_dailyTotalLoaded) {
        let baselineSum = 0;
        let interserranaSum = 0;
        for (let h = 0; h < 24; h++) {
            baselineSum += sumInflowKg(rendererContext.scenario.getPharrInflow(h));
            if (hasInterserrana) {
                interserranaSum += sumInflowKg(_interserranaScenario.getPharrInflow(h));
            }
        }
        // Interpolate daily total
        dailyTotalKg = hasInterserrana
            ? baselineSum * (1 - _scenarioAlpha) + interserranaSum * _scenarioAlpha
            : baselineSum;
        _dailyTotalLoaded = true;
        const scenarioLabel = hasInterserrana ? `interserrana α=${_scenarioAlpha.toFixed(2)}` : 'baseline';
        log(`[INFLOW] Daily total: ${(dailyTotalKg / 1e6).toFixed(2)}M kg/day (${scenarioLabel})`);
    }

    const currentHour = Math.floor(simTime / 3600) % 24;
    if (currentHour === _lastInflowHour) return;  // Already loaded for this hour

    // Get baseline inflow
    const baselineKg = sumInflowKg(rendererContext.scenario.getPharrInflow(currentHour));

    // Interpolate with interserrana if available
    if (hasInterserrana) {
        const interserranaKg = sumInflowKg(_interserranaScenario.getPharrInflow(currentHour));
        inflowKgPerHour = baselineKg * (1 - _scenarioAlpha) + interserranaKg * _scenarioAlpha;
    } else {
        inflowKgPerHour = baselineKg;
    }
    _lastInflowHour = currentHour;

    // Log both corridor (CIEN hourly) and industrial (shift) rates
    const shiftFrac = getIndustrialShiftFraction(currentHour);
    const indHourly = dailyTotalKg * shiftFrac;
    const scenarioLabel = hasInterserrana ? `interserrana α=${_scenarioAlpha.toFixed(2)}` : 'baseline';
    log(`[INFLOW] Hour ${currentHour}: corridors ${(inflowKgPerHour / 1000).toFixed(0)} t/hr, industrial ${(indHourly / 1000).toFixed(0)} t/hr (${scenarioLabel})`);
}

function stepInjection(dt) {
    const currentHour = Math.floor(simTime / 3600) % 24;

    // CORRIDORS: Follow CIEN hourly profile (demand-driven)
    const corridorKgPerS = inflowKgPerHour / 3600;

    // INDUSTRIAL: Follow 3-shift pattern (production-driven)
    // shiftFraction = what fraction of DAILY industrial production happens THIS HOUR
    const shiftFraction = getIndustrialShiftFraction(currentHour);
    const industrialDailyKg = dailyTotalKg * REYNOSA_LOCAL_RATIO;
    const industrialKgPerS = industrialDailyKg * shiftFraction / 3600;

    if (corridorKgPerS <= 0 && industrialKgPerS <= 0) return;

    for (const idx of sourceCellIndices) {
        const share = sourceField[idx];  // This source's share (0-1)
        if (share <= 0) continue;

        // Determine rate based on source type
        const sourceType = _cellToSourceType.get(idx);
        let baseRate;
        if (sourceType === SOURCE_TYPE.INDUSTRIAL) {
            // Industrial source: share is its portion of REYNOSA_LOCAL_RATIO (0.353)
            // Normalize: (share / 0.353) gives fraction within industrial sources
            // Then multiply by total industrial kg/s for this hour
            const normalizedShare = share / REYNOSA_LOCAL_RATIO;
            baseRate = normalizedShare * industrialKgPerS;
        } else {
            // Corridor source: share is its portion of CORRIDOR_TRAFFIC_RATIO (0.647)
            // Normalize and multiply by CIEN hourly rate for corridors
            const normalizedShare = share / CORRIDOR_TRAFFIC_RATIO;
            baseRate = normalizedShare * corridorKgPerS * CORRIDOR_TRAFFIC_RATIO;
        }

        // PULSE INJECTION: Modulate rate by organic pulse multiplier.
        // Industrial sources use damped pulse (±15%) for smoother, controlled flow.
        // Corridor sources use full pulse (±88%) for noisy, demand-driven flow.
        const phaseOffset = _sourcePhaseOffset.get(idx) ?? 0;
        const rawPulse = getPulseMultiplier(simTime, phaseOffset, idx);
        const pulseMultiplier = (sourceType === SOURCE_TYPE.INDUSTRIAL)
            ? 1.0 + (rawPulse - 1.0) * INDUSTRIAL_PULSE_DAMPING  // Damp to ±15%
            : rawPulse;                                           // Full ±88%
        const rate = baseRate * pulseMultiplier;

        let acc = (injectionAccumulator.get(idx) || 0) + rate * dt;
        const threshold = TRUCK_KG / _stressMultiplier;  // Stress: 5x more particles
        while (acc >= threshold) {
            injectWithSplit(idx);  // 65% restricted, 35% cleared
            acc -= threshold;
        }
        injectionAccumulator.set(idx, acc);
    }
}

// NOTE: CFL substepping now lives in step() to include injection/CBP in the loop.
// This prevents Jensen's inequality drift from density spikes at large dt.

function stepDriftAndTransferInner(dt) {
    // Collect transfers to apply after iteration (avoids concurrent modification)
    const transfers = [];

    // ═══════════════════════════════════════════════════════════════════════════
    // PASS A: Build directed outflow counts for O(P) pairwise cancellation
    // For each moving particle, increment outCount4[cellIdx * 4 + dir] where dir is toward nh
    // Loop particles are EXCLUDED (exempt from congestion — bridge/overpass in 3D)
    // ═══════════════════════════════════════════════════════════════════════════
    for (let i = 0; i < _movingParticleCount; i++) {
        const p = _movingParticles[i];

        // Skip particles waiting in sink queue
        if (p.state === STATE.CLEARED && regionMap[p.cellIdx] === REGION.SINK) continue;

        // Skip loop particles (exempt from congestion)
        if (p.loopTargetIdx !== undefined && p.loopTargetIdx >= 0) continue;

        // Compute nh using same logic as main loop
        let nh;
        if (p.state === STATE.ROAD) {
            nh = nextHop_lots[p.cellIdx];
        } else if (p.state === STATE.CLEARED) {
            if (!isBridgeOpen() && nextHop_sleepLots[p.cellIdx] >= 0) {
                nh = nextHop_sleepLots[p.cellIdx];
            } else if (p.useTwinSpan && _twinSpanActive && nextHop_pharr_twin[p.cellIdx] >= 0) {
                nh = nextHop_pharr_twin[p.cellIdx];
            } else {
                nh = nextHop_pharr[p.cellIdx];
            }
        } else {
            continue;
        }

        if (nh < 0) continue;

        const dir = dirFromTo(p.cellIdx, nh);
        if (dir >= 0) {
            outCount4[p.cellIdx * 4 + dir]++;
            if (!touchedMark[p.cellIdx]) {
                touchedMark[p.cellIdx] = 1;
                touchedCells.push(p.cellIdx);
            }
        }
    }

    for (let i = 0; i < _movingParticleCount; i++) {
        const p = _movingParticles[i];
        const cellIdx = p.cellIdx;

        // Age particle
        p.age += dt;

        // Stuck detection: track stalled time in seconds, log only if stuck > 72 hours
        if (p.px !== undefined && p.x === p.px && p.y === p.py) {
            p.stalledTime = (p.stalledTime || 0) + dt;
            const STUCK_THRESHOLD_S = 72 * 3600;  // 72 hours
            if (p.stalledTime >= STUCK_THRESHOLD_S && !p.stuckLogged) {
                p.stuckLogged = true;
                const nh = (p.state === STATE.CLEARED ? nextHop_pharr : nextHop_lots)[p.cellIdx];
                if (_verbose) console.log(`[STUCK >72h] id=${p.id} cell=${p.cellIdx} nh=${nh} state=${p.state} region=${regionMap[p.cellIdx]} reason=${p.stallReason}`);
            }
        } else {
            p.stalledTime = 0;
            p.stuckLogged = false;
        }

        // Skip particles in CBP area (still in movingParticles but not drifting)
        // Separate queue time (waiting) from service time (in lane)
        if (p.state === STATE.CLEARED && regionMap[cellIdx] === REGION.SINK) {
            _truckHoursLostThisTick += dt;           // c=0 → loss=1
            if (p._cbpLane) {
                // In service — assigned to lane, being processed
                _truckHoursLostBridgeServiceTick += dt;
            } else {
                // In queue — waiting for lane assignment
                _truckHoursLostBridgeQueueTick += dt;
            }
            continue;
        }

        // Early exit zone check for DEPARTING particles (in case they get stuck)
        if (p.state === STATE.DEPARTING) {
            const edx = p.x - EXIT_ZONE.x;
            const edy = p.y - EXIT_ZONE.y;
            const exitDist2 = edx * edx + edy * edy;
            const exitRadiusM = EXIT_ZONE.radiusCells * roi.cellSize;
            const timedOut = (simTime - p.departureTime) > EXIT_ZONE.maxTimeS;
            if (exitDist2 < exitRadiusM * exitRadiusM || timedOut) {
                transfers.push({ p, from: cellIdx, to: -1, action: 'departed' });
                continue;
            }
        }

            // Get routing table for this particle's state
            let nhTable;
            let nh;
            if (p.state === STATE.ROAD) {
                // Industrial parks are source-only, not destinations
                nhTable = nextHop_lots;
                nh = nhTable[p.cellIdx];
            } else if (p.state === STATE.CLEARED) {
                // Route to sleep lots when bridge is closed (and sleep lots available)
                if (!isBridgeOpen() && nextHop_sleepLots[p.cellIdx] >= 0) {
                    nhTable = nextHop_sleepLots;
                } else if (p.useTwinSpan && _twinSpanActive && nextHop_pharr_twin[p.cellIdx] >= 0) {
                    // Twin span particles use separate routing
                    nhTable = nextHop_pharr_twin;
                } else {
                    nhTable = nextHop_pharr;
                }
                nh = nhTable[p.cellIdx];
            } else if (p.state === STATE.DEPARTING) {
                // DEPARTURE ROUTING: Move toward exit zone (north of sink)
                // Find conductive neighbor closest to exit zone
                const cx = cellIdx % N;
                const cy = Math.floor(cellIdx / N);
                const myX = cellCenterX[cellIdx];
                const myY = cellCenterY[cellIdx];
                const myDist2 = (myX - EXIT_ZONE.x) * (myX - EXIT_ZONE.x) + (myY - EXIT_ZONE.y) * (myY - EXIT_ZONE.y);
                let bestDist2 = myDist2;
                nh = -1;
                // Check all 4 neighbors, pick one closest to exit zone with conductivity
                if (cx > 0 && (Kxx[cellIdx - 1] > 0 || Kyy[cellIdx - 1] > 0)) {
                    const nx = cellCenterX[cellIdx - 1], ny = cellCenterY[cellIdx - 1];
                    const d2 = (nx - EXIT_ZONE.x) * (nx - EXIT_ZONE.x) + (ny - EXIT_ZONE.y) * (ny - EXIT_ZONE.y);
                    if (d2 < bestDist2) { bestDist2 = d2; nh = cellIdx - 1; }
                }
                if (cx < N - 1 && (Kxx[cellIdx + 1] > 0 || Kyy[cellIdx + 1] > 0)) {
                    const nx = cellCenterX[cellIdx + 1], ny = cellCenterY[cellIdx + 1];
                    const d2 = (nx - EXIT_ZONE.x) * (nx - EXIT_ZONE.x) + (ny - EXIT_ZONE.y) * (ny - EXIT_ZONE.y);
                    if (d2 < bestDist2) { bestDist2 = d2; nh = cellIdx + 1; }
                }
                if (cy > 0 && (Kxx[cellIdx - N] > 0 || Kyy[cellIdx - N] > 0)) {
                    const nx = cellCenterX[cellIdx - N], ny = cellCenterY[cellIdx - N];
                    const d2 = (nx - EXIT_ZONE.x) * (nx - EXIT_ZONE.x) + (ny - EXIT_ZONE.y) * (ny - EXIT_ZONE.y);
                    if (d2 < bestDist2) { bestDist2 = d2; nh = cellIdx - N; }
                }
                if (cy < N - 1 && (Kxx[cellIdx + N] > 0 || Kyy[cellIdx + N] > 0)) {
                    const nx = cellCenterX[cellIdx + N], ny = cellCenterY[cellIdx + N];
                    const d2 = (nx - EXIT_ZONE.x) * (nx - EXIT_ZONE.x) + (ny - EXIT_ZONE.y) * (ny - EXIT_ZONE.y);
                    if (d2 < bestDist2) { bestDist2 = d2; nh = cellIdx + N; }
                }
            } else {
                continue;
            }

            // LOOP OVERRIDE: Per-particle waypoint tracking
            const loopNh = getLoopNextHop(p);
            if (loopNh >= 0) {
                nh = loopNh;
            }

            if (nh < 0) {
                p.renderStalled = true;
                p.stallReason = 'dead_end';
                if (p.stallStartVersion < 0) p.stallStartVersion = _routingVersion;
                _truckHoursLostThisTick += dt;           // c=0 → loss=1
                _truckHoursLostCongestionTick += dt;    // attribute to congestion
                continue;
            }
            // LINEAGE: Clear stall tracking on successful route
            p.renderStalled = false;
            p.stallReason = null;
            p.stallStartVersion = -1;
            p.routingVersion = _routingVersion;
            p.lastRouteCell = cellIdx;
            p.lastRouteNh = nh;

            // ─────────────────────────────────────────────────────────────────
            // CAPACITY GATE: Check if next hop is a full lot (try alternative first)
            // REPLAY_MODE: Skip all capacity gates — kinematic movement only
            // ─────────────────────────────────────────────────────────────────
            if (!REPLAY_MODE && p.state === STATE.ROAD && regionMap[nh] === REGION.LOT) {
                const lotIdx = cellToLotIndex[nh];
                if (lotIdx >= 0) {
                    const fill = lotMass[lotIdx] / lotCapacity[lotIdx];
                    if (fill >= _lotAdmissionCutoff) {
                        // Try alternative neighbor toward different lot (forward)
                        const currentPhi = phi_lots[cellIdx];
                        const cx = cellIdx % N;
                        const cy = Math.floor(cellIdx / N);

                        let altNh = -1;
                        let altPhi = currentPhi;
                        let backtrackNh = -1;
                        let backtrackPhi = Infinity;
                        const neighbors = [];
                        if (cx > 0) neighbors.push(cellIdx - 1);
                        if (cx < N - 1) neighbors.push(cellIdx + 1);
                        if (cy > 0) neighbors.push(cellIdx - N);
                        if (cy < N - 1) neighbors.push(cellIdx + N);

                        for (const ni of neighbors) {
                            if (ni === nh) continue;  // Skip the full lot
                            if (Kxx[ni] < K_THRESHOLD && Kyy[ni] < K_THRESHOLD) continue;  // Must be traversable
                            if (phi_lots[ni] >= PHI_LARGE) continue;  // Skip unreachable cells
                            // Skip if neighbor is also a full lot
                            if (regionMap[ni] === REGION.LOT) {
                                const niLotIdx = cellToLotIndex[ni];
                                if (niLotIdx >= 0 && lotMass[niLotIdx] / lotCapacity[niLotIdx] >= _lotAdmissionCutoff) continue;
                            }

                            if (phi_lots[ni] < currentPhi) {
                                // Forward alternative: lower phi (toward a different lot)
                                if (phi_lots[ni] < altPhi) {
                                    altPhi = phi_lots[ni];
                                    altNh = ni;
                                }
                            } else {
                                // Backtrack candidate: higher phi (retreat toward main network)
                                // Pick the one with lowest phi among backtrack options
                                if (phi_lots[ni] < backtrackPhi) {
                                    backtrackPhi = phi_lots[ni];
                                    backtrackNh = ni;
                                }
                            }
                        }

                        if (altNh >= 0) {
                            nh = altNh;
                        } else if (backtrackNh >= 0) {
                            // No forward alternative — backtrack toward main network
                            // Pairwise cancellation handles congestion with oncoming traffic
                            nh = backtrackNh;
                            p.stallReason = 'backtrack';  // Visual indicator
                        } else {
                            // LINEAGE: Track when stall began
                            if (p.stallStartVersion < 0) {
                                p.stallStartVersion = _routingVersion;
                                p.lastRouteCell = cellIdx;
                                p.lastRouteNh = nh;
                            }
                            // INVARIANT: If routing was rebuilt since stall started, we should have found a route
                            if (_routingVersion > p.stallStartVersion) {
                                console.error(`[REROUTE FAILURE] Particle ${p.id} stalled at v${p.stallStartVersion}, now v${_routingVersion}`,
                                    `cell=${cellIdx} nh=${nh} phi=${phi_lots[cellIdx]?.toFixed(1)} nhPhi=${phi_lots[nh]?.toFixed(1)}`);
                            }
                            p.renderStalled = true;
                            p.stallReason = 'lot_full';
                            p.routingVersion = _routingVersion;
                            _truckHoursLostThisTick += dt;        // c=0 → loss=1
                            _truckHoursLostLotWaitTick += dt;     // attribute to lot wait
                            continue;
                        }
                    }
                }
            }

            // ─────────────────────────────────────────────────────────────────
            // CAPACITY GATE: Check if next hop road cell is at gridlock
            // For ROAD particles, try alternative neighbors before stalling
            // EXCEPTION: Skip capacity check near sink (prevents funnel bottleneck)
            // REPLAY_MODE: Skip — kinematic movement only
            // ─────────────────────────────────────────────────────────────────
            const nearSink = isCellInBridgeApproach(nh);
            const nhCap = nearSink ? ROAD_CELL_CAP_KG * SINK_CAP_MULT : ROAD_CELL_CAP_KG;
            if (!REPLAY_MODE && regionMap[nh] === REGION.ROAD && cellMass[nh] >= nhCap) {
                // ROAD particles can seek alternatives (multiple lots available)
                // CLEARED particles must wait (single destination)
                if (p.state === STATE.ROAD) {
                    // Industrial parks are source-only, not destinations
                    const currentPhi = phi_lots[cellIdx];
                    const cx = cellIdx % N;
                    const cy = Math.floor(cellIdx / N);

                    // Check 4 neighbors for less congested alternative
                    let altNh = -1;
                    let altCongestion = Infinity;
                    const neighbors = [];
                    if (cx > 0) neighbors.push(cellIdx - 1);
                    if (cx < N - 1) neighbors.push(cellIdx + 1);
                    if (cy > 0) neighbors.push(cellIdx - N);
                    if (cy < N - 1) neighbors.push(cellIdx + N);

                    for (const ni of neighbors) {
                        if (ni === nh) continue;  // Skip the blocked one
                        if (phi_lots[ni] >= currentPhi) continue;  // Must still lead to destination
                        if (Kxx[ni] < K_THRESHOLD && Kyy[ni] < K_THRESHOLD) continue;  // Must be traversable
                        const niNearSink = isCellInBridgeApproach(ni);
                        const niCap = niNearSink ? ROAD_CELL_CAP_KG * SINK_CAP_MULT : ROAD_CELL_CAP_KG;
                        if (regionMap[ni] === REGION.ROAD && cellMass[ni] >= niCap) continue;  // Must have room

                        const neighborCongestion = cellMass[ni];
                        if (neighborCongestion < altCongestion) {
                            altCongestion = neighborCongestion;
                            altNh = ni;
                        }
                    }

                    if (altNh >= 0) {
                        nh = altNh;  // Use alternative route
                    } else {
                        p.renderStalled = true;
                        p.stallReason = 'road_full';
                        _truckHoursLostThisTick += dt;        // c=0 → loss=1
                        _truckHoursLostCongestionTick += dt;  // attribute to congestion
                        continue;
                    }
                } else {
                    p.renderStalled = true;
                    p.stallReason = 'road_full';
                    _truckHoursLostThisTick += dt;        // c=0 → loss=1
                    _truckHoursLostCongestionTick += dt;  // attribute to congestion
                    continue;  // CLEARED must wait
                }
            }

            // ─────────────────────────────────────────────────────────────────
            // CONTINUOUS DRIFT toward next hop (with congestion scaling)
            // ─────────────────────────────────────────────────────────────────
            const targetX = cellCenterX[nh];
            const targetY = cellCenterY[nh];

            const dx = targetX - p.x;
            const dy = targetY - p.y;
            const dist2 = dx * dx + dy * dy;
            if (dist2 < 0.000001) continue;  // 0.001^2

            // CONGESTION: Scale velocity by DOWNSTREAM density + commuter friction (anticipation)
            // Drivers slow when they see congestion ahead, not when sitting in it
            // Commuter friction adds effective mass without adding particles
            // Exempt from congestion:
            //   - Lots (explicitly parked)
            //   - Source cells (entrance ramps - trucks spawn here, should flow freely)
            //   - Loop particles (bridge/overpass - no 2D intersection with roads below)
            // PAIRWISE CANCELLATION: O(1) lookup of opposing traffic (trucks in nh headed back toward us)
            const dirAB = dirFromTo(cellIdx, nh);
            let opposingMass = 0;
            if (dirAB >= 0) {
                const dirBA = oppositeDir(dirAB);
                opposingMass = outCount4[nh * 4 + dirBA] * TRUCK_KG;
            }

            // DEBUG: Compare O(1) lookup vs O(P²) scan for 1-in-200 particles
            if (DEBUG_PAIRWISE_CANCELLATION && (p.id % 200 === 0)) {
                let opposingMass_old = 0;
                for (const other of cellParticles[nh]) {
                    let otherNh = -1;
                    const otherLoopNh = getLoopNextHop(other);
                    if (otherLoopNh >= 0) {
                        otherNh = otherLoopNh;
                    } else if (other.state === STATE.ROAD) {
                        otherNh = nextHop_lots[other.cellIdx];
                    } else if (other.state === STATE.CLEARED) {
                        if (!isBridgeOpen() && nextHop_sleepLots[other.cellIdx] >= 0) {
                            otherNh = nextHop_sleepLots[other.cellIdx];
                        } else if (other.useTwinSpan && _twinSpanActive && nextHop_pharr_twin[other.cellIdx] >= 0) {
                            otherNh = nextHop_pharr_twin[other.cellIdx];
                        } else {
                            otherNh = nextHop_pharr[other.cellIdx];
                        }
                    } else {
                        continue;
                    }
                    if (otherNh === cellIdx) {
                        opposingMass_old += TRUCK_KG;
                    }
                }
                // Tolerance: loop particles are excluded from outCount4, so old may be higher
                const diff = Math.abs(opposingMass_old - opposingMass);
                if (diff > TRUCK_KG * 2) {
                    console.warn(`[PAIRWISE] p=${p.id} cell=${cellIdx} nh=${nh} old=${opposingMass_old} new=${opposingMass} diff=${diff}`);
                }
            }

            const rho = Math.max(0, cellMass[nh] - opposingMass);
            const commuterFriction = COMMUTER_EQUIV_KG * commuterLoad[nh];
            const rho_eff = rho + commuterFriction;
            const isSourceCell = sourceField[cellIdx] > 0;
            const isOnLoop = p.loopTargetIdx !== undefined && p.loopTargetIdx >= 0;
            // REPLAY_MODE: Force c=1.0 — no congestion slowdown during kinematic replay
            // Loop particles exempt: bridge/overpass in 3D, appears as overlap in 2D
            const c = REPLAY_MODE ? 1.0 : ((regionMap[nh] === REGION.LOT || isSourceCell || isOnLoop) ? 1.0 : congestionFactor(rho_eff));

            // Track stalled mass (moving particles slowed below cutoff)
            // Weight by dt so accumulation is time-integrated, not per-substep
            if (c < STALL_CUTOFF) {
                _stalledMassKg += TRUCK_KG * dt;  // kg·s (time-weighted)
            }

            // Track truck-hours lost vs free-flow
            // Each particle == one truck; c=1 → 0 loss, c=0 → 1 hr lost per hr
            // INVARIANT: loss = (1 - c), where c ∈ [0,1]
            // Weight by dt so accumulation is time-integrated, not per-substep
            const loss = 1 - c;
            if (loss < 0 || loss > 1) {
                console.error(`[INVARIANT VIOLATION] truck-hours loss=${loss} out of bounds, c=${c}`);
            }
            _truckHoursLostThisTick += loss * dt;  // truck·s (time-weighted)

            // INSTRUMENTATION: Split by cause (no behavior change)
            if (p.stallReason === 'lot_full') {
                _truckHoursLostLotWaitTick += loss * dt;
            } else {
                _truckHoursLostCongestionTick += loss * dt;
            }

            // ─────────────────────────────────────────────────────────────────
            // LAYER C: Intersection stop-go waves (physical effect)
            // At high-commuter intersections, sin-wave blocking creates phantom queues
            // EVENT-BASED HOLD: Compute hold-until time once, release when simTime exceeds it
            // This ensures dt-invariance (blocking duration doesn't change with timestep)
            // REPLAY_MODE: Skip — kinematic movement only
            // ─────────────────────────────────────────────────────────────────
            const cellLoad = commuterLoad[cellIdx];
            if (!REPLAY_MODE && isIntersection[cellIdx] && cellLoad > 0.6) {
                // Check if already held from previous substep/tick
                if (p._intersectionHoldUntil !== undefined) {
                    if (simTime < p._intersectionHoldUntil) {
                        _truckHoursLostThisTick += dt;        // c=0 → loss=1
                        _truckHoursLostCongestionTick += dt;  // attribute to congestion
                        continue;  // Still held
                    } else {
                        p._intersectionHoldUntil = undefined;  // Release
                    }
                } else {
                    // Check if entering a new blocking window
                    const phase = (cellIdx * 7919) % 1000 / 1000 * Math.PI * 2;  // Per-cell phase
                    const theta = simTime * 0.3 + phase;
                    const sinVal = Math.sin(theta);
                    if (sinVal > 0.85) {
                        // Compute hold duration: time until sin drops below 0.85
                        // sin(x) = 0.85 at x = asin(0.85) and x = π - asin(0.85)
                        // We're in blocking zone, exit point is at θ = π - asin(0.85) + 2πk
                        const ASIN_085 = 1.0160;  // asin(0.85)
                        const exitAngle = Math.PI - ASIN_085;  // ≈ 2.126 rad
                        // Find time until theta reaches exitAngle (mod 2π)
                        const thetaMod = theta % (2 * Math.PI);
                        let timeToExit;
                        if (thetaMod < exitAngle) {
                            timeToExit = (exitAngle - thetaMod) / 0.3;
                        } else {
                            // Wrapped past exit, wait for next cycle exit
                            timeToExit = (2 * Math.PI - thetaMod + exitAngle) / 0.3;
                        }
                        p._intersectionHoldUntil = simTime + timeToExit;
                        _intersectionBlockCount++;
                        _truckHoursLostThisTick += dt;        // c=0 → loss=1
                        _truckHoursLostCongestionTick += dt;  // attribute to congestion
                        continue;  // Block this substep
                    }
                }
            }

            // ─────────────────────────────────────────────────────────────────
            // LAYER B: Velocity jitter (stop-go hesitation from commuter chaos)
            // dt-INVARIANT: Use deterministic seed from particle ID + sim-second
            // Changes once per second, not per substep, ensuring same jitter at any dt
            // ─────────────────────────────────────────────────────────────────
            const jitterSeed = ((p.id * 7919) ^ Math.floor(simTime)) % 1000;
            const velJitter = cellLoad > 0
                ? Math.min(1.0, (1 - COMMUTER_SPEED_PENALTY * cellLoad) * (0.95 + jitterSeed * 0.0001))
                : 1.0;

            // Move toward target (speed scaled by congestion + commuter jitter)
            // Use speed limit if defined, otherwise default
            // REPLAY_MODE: Apply time scale for accelerated kinematic motion
            const baseSpeed = speedLimitMS[cellIdx] > 0 ? speedLimitMS[cellIdx] : VISUAL_SPEED_MS;
            const moveDistance = baseSpeed * c * velJitter * dt * (REPLAY_MODE ? REPLAY_TIME_SCALE : 1.0);

            // CFL assertion: substeps guarantee this never fires
            // REPLAY_MODE: Skip CFL check — kinematic animation doesn't require physics stability
            if (!REPLAY_MODE && moveDistance > 0.9 * roi.cellSize) {
                throw new Error(`[CFL] moveDistance=${moveDistance.toFixed(1)}m > limit=${(0.9 * roi.cellSize).toFixed(1)}m — substep logic broken`);
            }

            p.px = p.x;
            p.py = p.y;

            if (moveDistance * moveDistance >= dist2) {
                p.x = targetX;
                p.y = targetY;
            } else {
                const dist = Math.sqrt(dist2);  // Only compute sqrt when lerping
                p.x += (dx / dist) * moveDistance;
                p.y += (dy / dist) * moveDistance;
            }

            // ─────────────────────────────────────────────────────────────────
            // EXIT ZONE CHECK: Remove DEPARTING particles that reached exit or timed out
            // ─────────────────────────────────────────────────────────────────
            if (p.state === STATE.DEPARTING) {
                const edx = p.x - EXIT_ZONE.x;
                const edy = p.y - EXIT_ZONE.y;
                const exitDist2 = edx * edx + edy * edy;
                const exitRadiusM = EXIT_ZONE.radiusCells * roi.cellSize;
                const timedOut = (simTime - p.departureTime) > EXIT_ZONE.maxTimeS;
                if (exitDist2 < exitRadiusM * exitRadiusM || timedOut) {
                    transfers.push({ p, from: cellIdx, to: -1, action: 'departed' });
                    continue;
                }
            }

            // ─────────────────────────────────────────────────────────────────
            // BOUNDARY CHECK: Did particle cross into a new cell?
            // ─────────────────────────────────────────────────────────────────
            const newCellX = Math.floor(worldToFieldX(p.x));
            const newCellY = Math.floor(worldToFieldY(p.y));

            // Bounds check
            if (newCellX < 0 || newCellX >= N || newCellY < 0 || newCellY >= N) {
                transfers.push({ p, from: cellIdx, to: -1, action: 'oob' });
                continue;
            }

            const newIdx = newCellY * N + newCellX;
            if (newIdx !== p.cellIdx) {
                // Skip routing validation for particles on the hardcoded loop
                if (p.loopTargetIdx !== undefined && p.loopTargetIdx >= 0) {
                    transfers.push({ p, from: cellIdx, to: newIdx });
                } else if (p.state === STATE.DEPARTING) {
                    // DEPARTING: Accept any conductive cell (climbing phi gradient)
                    if (Kxx[newIdx] > 0 || Kyy[newIdx] > 0) {
                        transfers.push({ p, from: cellIdx, to: newIdx });
                    }
                } else {
                    // Validate: does new cell have routing?
                    const hasRoute = (p.state === STATE.CLEARED)
                        ? ((p.useTwinSpan && _twinSpanActive ? nextHop_pharr_twin[newIdx] >= 0 : nextHop_pharr[newIdx] >= 0) || regionMap[newIdx] === REGION.SINK)
                        : (nextHop_lots[newIdx] >= 0 || regionMap[newIdx] === REGION.LOT);

                    if (hasRoute) {
                        transfers.push({ p, from: cellIdx, to: newIdx });
                    } else if (nh >= 0 && nh !== p.cellIdx) {
                        // Diagonal drift to bad cell - snap to intended next hop
                        transfers.push({ p, from: cellIdx, to: nh });
                    }
                    // else: stay put (shouldn't happen if routing is good)
                }
            }
    }

    // Apply all transfers (deferred to avoid concurrent modification)
    for (const t of transfers) {
        applyTransfer(t);
    }

    // Reset outflow counts for next substep (sparse reset — only touched cells)
    for (let k = 0; k < touchedCells.length; k++) {
        const c = touchedCells[k];
        const base = c * 4;
        outCount4[base] = outCount4[base + 1] = outCount4[base + 2] = outCount4[base + 3] = 0;
        touchedMark[c] = 0;
    }
    touchedCells.length = 0;
}

function applyTransfer({ p, from, to, action }) {
    // Remove from old cell - O(1) swap-and-pop
    const arr = cellParticles[from];
    if (arr.length > 0 && p.slotIdx >= 0 && p.slotIdx < arr.length) {
        const lastP = arr[arr.length - 1];
        arr[p.slotIdx] = lastP;
        lastP.slotIdx = p.slotIdx;
        arr.pop();
        cellMass[from] -= particleMass();
        if (arr.length === 0) {
            activeCells.delete(from);
        }
    }

    // Handle out-of-bounds
    if (action === 'oob') {
        console.warn(`[TRANSFER] Particle ${p.id} went OOB`);
        metrics.violations++;
        removeFromActiveParticles(p);
        removeFromMovingParticles(p);
        removeParticleTrail(p.id);
        return;
    }

    // Handle departed particles (DEPARTING state reached exit zone)
    if (action === 'departed' || to < 0) {
        _departedCount++;
        removeFromActiveParticles(p);
        removeFromMovingParticles(p);
        removeParticleTrail(p.id);
        return;
    }

    const region = regionMap[to];

    // ─────────────────────────────────────────────────────────────────────────
    // SINK: Queue particle for CBP lane service
    // Particle stays visible until service completion (stepCBPCompletion)
    // DEPARTING particles are exiting through sink - don't re-queue them
    // ─────────────────────────────────────────────────────────────────────────
    if (region === REGION.SINK && p.state !== STATE.DEPARTING) {
        // Add particle to sink cell (stays visible until CBP service complete)
        p.cellIdx = to;
        p.slotIdx = cellParticles[to].length;
        cellParticles[to].push(p);
        activeCells.add(to);
        cellMass[to] += particleMass();

        // Queue for CBP lane assignment
        sinkQueue.push(p);
        return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LOT ENTRY: Capacity-gated, triggers state change
    // ─────────────────────────────────────────────────────────────────────────
    if (region === REGION.LOT && p.state === STATE.ROAD) {
        const lotIdx = cellToLotIndex[to];
        if (lotIdx < 0) {
            throw new Error(`[INVARIANT:LOT] Cell ${to} is REGION.LOT but cellToLotIndex=${lotIdx}`);
        }
        if (lotIdx >= 0) {
            const fill = lotMass[lotIdx] / lotCapacity[lotIdx];
            const canAdmit = fill < _lotAdmissionCutoff && (lotCapacity[lotIdx] - lotMass[lotIdx]) >= particleMass();
            if (canAdmit) {
                // Enter lot - scatter to random cell within lot (physics position, not just render)
                const cells = lotToCellIndices[lotIdx];
                const targetCell = (cells && cells.length > 0)
                    ? cells[Math.floor(rng() * cells.length)]
                    : to;

                p.cellIdx = targetCell;
                p.state = STATE.LOT;
                removeFromMovingParticles(p);
                p.lotIdx = lotIdx;
                p.lotArrivalTime = simTime;
                p.dwellEnd = simTime + sampleDwellSeconds();
                p.renderStalled = false;  // Clear stall - now waiting normally
                p.stallReason = null;     // Clear lot_full stall (instrumentation)
                p.slotIdx = cellParticles[targetCell].length;
                cellParticles[targetCell].push(p);
                activeCells.add(targetCell);
                cellMass[targetCell] += particleMass();
                lotMass[lotIdx] += particleMass();
                // Assert capacity not exceeded
                if (lotMass[lotIdx] > lotCapacity[lotIdx]) {
                    throw new Error(`[INVARIANT:LOT] lot=${lotIdx} mass=${lotMass[lotIdx]} > capacity=${lotCapacity[lotIdx]}`);
                }
                conversionQueue.push(p);
                metrics.enteredLots += particleMass();
                // Set render position to match physics cell
                const cx = targetCell % N;
                const cy = Math.floor(targetCell / N);
                p.x = fieldToWorldX(cx + 0.3 + rng() * 0.4);
                p.y = fieldToWorldY(cy + 0.3 + rng() * 0.4);
                p.lotParked = true;
                return;
            } else {
                // Lot full - bounce back (shouldn't happen if gate works, but safety)
                p.x = p.px;
                p.y = p.py;
                p.slotIdx = cellParticles[from].length;
                cellParticles[from].push(p);
                activeCells.add(from);
                cellMass[from] += particleMass();
                p.renderStalled = true;
                p.stallReason = 'lot_full';
                return;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SLEEP LOT ENTRY: CLEARED particles entering designated lots when bridge closed
    // ─────────────────────────────────────────────────────────────────────────
    if (region === REGION.LOT && p.state === STATE.CLEARED && !isBridgeOpen()) {
        const lotIdx = cellToLotIndex[to];
        if (lotIdx >= 0 && isSleepLot(lotIdx)) {
            const fill = lotMass[lotIdx] / lotCapacity[lotIdx];
            const canAdmit = fill < _lotAdmissionCutoff && (lotCapacity[lotIdx] - lotMass[lotIdx]) >= particleMass();
            if (canAdmit) {
                // Enter sleep lot - scatter to random cell within lot (physics position)
                const cells = lotToCellIndices[lotIdx];
                const targetCell = (cells && cells.length > 0)
                    ? cells[Math.floor(rng() * cells.length)]
                    : to;

                p.cellIdx = targetCell;
                p.state = STATE.SLEEPING;
                removeFromMovingParticles(p);
                p.sleepLotIdx = lotIdx;
                p.sleepArrivalTime = simTime;
                p.wakeOffset = WAKE_OFFSETS[Math.floor(rng() * 4)];  // Random wave: 1hr, 45min, 30min, 0
                p.renderStalled = false;
                p.slotIdx = cellParticles[targetCell].length;
                cellParticles[targetCell].push(p);
                activeCells.add(targetCell);
                cellMass[targetCell] += particleMass();
                lotMass[lotIdx] += particleMass();
                sleepingParticles.push(p);
                // Set render position to match physics cell
                const cx = targetCell % N;
                const cy = Math.floor(targetCell / N);
                p.x = fieldToWorldX(cx + 0.3 + rng() * 0.4);
                p.y = fieldToWorldY(cy + 0.3 + rng() * 0.4);
                p.lotParked = true;
                return;
            } else {
                // Sleep lot full - fall back to sink queue
                // Continue to sink entry below
            }
        }
        // Not a sleep lot or full - continue routing to sink (fall through)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PARK ENTRY: Similar to lot but different state
    // ─────────────────────────────────────────────────────────────────────────
    if (region === REGION.PARK && p.state === STATE.ROAD) {
        const parkIdx = cellToParkIndex[to];
        if (parkIdx >= 0) {
            const available = parkCapacity[parkIdx] - parkMass[parkIdx];
            if (available >= particleMass()) {
                // Scatter within 3-cell radius of entry (physics position)
                const entryCx = to % N;
                const entryCy = Math.floor(to / N);
                const offsetX = Math.floor(rng() * 7) - 3;  // -3 to +3
                const offsetY = Math.floor(rng() * 7) - 3;
                const cx = Math.max(0, Math.min(N - 1, entryCx + offsetX));
                const cy = Math.max(0, Math.min(N - 1, entryCy + offsetY));
                const targetCell = cy * N + cx;

                p.cellIdx = targetCell;
                p.state = STATE.PARK;
                removeFromMovingParticles(p);
                p.parkIdx = parkIdx;
                p.parkArrivalTime = simTime;
                p.slotIdx = cellParticles[targetCell].length;
                cellParticles[targetCell].push(p);
                activeCells.add(targetCell);
                cellMass[targetCell] += particleMass();
                parkMass[parkIdx] += particleMass();
                parkReleaseQueue.push(p);
                metrics.enteredParks = (metrics.enteredParks || 0) + particleMass();
                // Set render position to match physics cell
                p.x = fieldToWorldX(cx + 0.4 + rng() * 0.2);
                p.y = fieldToWorldY(cy + 0.4 + rng() * 0.2);
                p.lotParked = true;
                return;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ROAD CAPACITY GATE: Handle deferred-transfer race condition
    // Pre-check passed for multiple particles, first transfer filled cell
    // EXCEPTION: Skip near sink (prevents funnel bottleneck)
    // ─────────────────────────────────────────────────────────────────────────
    const toNearSink = isCellInBridgeApproach(to);
    const toCap = toNearSink ? ROAD_CELL_CAP_KG * SINK_CAP_MULT : ROAD_CELL_CAP_KG;
    if (regionMap[to] === REGION.ROAD && cellMass[to] >= toCap) {
        // Race condition: cell filled by earlier transfer this tick — stall
        p.x = p.px;
        p.y = p.py;
        p.slotIdx = cellParticles[from].length;
        cellParticles[from].push(p);
        activeCells.add(from);
        cellMass[from] += particleMass();
        p.renderStalled = true;
        p.stallReason = 'road_full';
        return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // NORMAL MOVE: Road-to-road or cleared-to-road
    // ─────────────────────────────────────────────────────────────────────────
    p.cellIdx = to;
    p.slotIdx = cellParticles[to].length;
    cellParticles[to].push(p);
    activeCells.add(to);
    cellMass[to] += particleMass();
    metrics.moved += particleMass();
}

/**
 * Check if lot conversion is allowed based on bridge schedule.
 * Lots stop releasing 1hr before close, start releasing 1hr before open.
 * This prevents trucks from leaving lots when bridge is about to close.
 */
function isLotConversionAllowed() {
    if (!rendererContext?.scenario) return true;  // Allow if no scenario

    const currentHour = Math.floor(simTime / 3600) % 24;
    const nextHour = (currentHour + 1) % 24;

    // Check if bridge will be open in the next hour
    const nextCap = rendererContext.scenario.getPharrGateCapacity(nextHour);
    return nextCap && nextCap.cap_kg_per_hour > 0;
}

function stepConversion() {
    // Gate: don't convert if bridge closes in <1hr
    if (!isLotConversionAllowed()) return;

    // Scan queue for any ready particles (dwell times vary per particle)
    // Process in queue order but don't assume ordering by readiness
    let i = 0;
    while (i < conversionQueue.length) {
        const p = conversionQueue[i];

        // Check particle still valid
        if (p.state !== STATE.LOT) {
            // Remove invalid particle, don't increment i
            conversionQueue.splice(i, 1);
            continue;
        }

        // Check if dwell complete
        if (simTime >= p.dwellEnd) {
            // Convert and remove from queue
            convertParticle(p);
            conversionQueue.splice(i, 1);
            // Don't increment i, next particle now at this index
        } else {
            // Not ready, move to next
            i++;
        }
    }
}

function stepParkRelease() {
    // Scan queue for any ready particles (dwell times vary: 4h vs 24h)
    // Process in queue order but don't assume ordering by readiness
    let i = 0;
    while (i < parkReleaseQueue.length) {
        const p = parkReleaseQueue[i];

        // Check particle still valid (still in park state)
        if (p.state !== STATE.PARK) {
            parkReleaseQueue.splice(i, 1);
            continue;
        }

        // Check dwell time (24-hour for industrial park particles, 4-hour for others)
        const waited = simTime - p.parkArrivalTime;
        const requiredDwell = p.parkDwell24h ? PARK_DWELL_24H_S : PARK_DWELL_S;

        if (waited >= requiredDwell) {
            // Release and remove from queue
            releasePark(p);
            parkReleaseQueue.splice(i, 1);
        } else {
            i++;
        }
    }
}

/**
 * Release sleeping particles before bridge opens.
 * Staggered waves: 25% at 1hr, 45min, 30min, 0min before opening.
 */
function stepSleepRelease() {
    if (sleepingParticles.length === 0) return;

    // Only release when bridge is about to open or is open
    const openHour = getNextBridgeOpenHour();
    const currentHour = Math.floor(simTime / 3600) % 24;
    const currentDaySeconds = simTime % (24 * 3600);

    // Calculate target open time (in current day seconds)
    let openTimeS = openHour * 3600;
    if (openHour <= currentHour) {
        // Bridge opens tomorrow - add 24 hours
        openTimeS += 24 * 3600;
    }

    // Release particles whose wake time has arrived
    for (let i = sleepingParticles.length - 1; i >= 0; i--) {
        const p = sleepingParticles[i];
        if (p.state !== STATE.SLEEPING) {
            // Already released somehow - remove from list
            sleepingParticles.splice(i, 1);
            continue;
        }

        const wakeTimeS = openTimeS - p.wakeOffset;
        if (currentDaySeconds >= wakeTimeS || (wakeTimeS > 24 * 3600 && currentDaySeconds + 24 * 3600 >= wakeTimeS)) {
            // Time to wake up
            const lotIdx = p.sleepLotIdx;
            p.state = STATE.CLEARED;
            addToMovingParticles(p);
            // Assign to twin span based on particle ID (deterministic 50/50 split)
            p.useTwinSpan = _twinSpanActive && (p.id % 2 === 0);
            p.sleepLotIdx = undefined;
            p.sleepArrivalTime = undefined;
            p.wakeOffset = undefined;
            p.lotParked = false;

            // Decrement lot mass
            if (lotIdx >= 0 && lotIdx < lotMass.length) {
                lotMass[lotIdx] -= particleMass();
                if (lotMass[lotIdx] < 0) lotMass[lotIdx] = 0;
            }

            sleepingParticles.splice(i, 1);
        }
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// LOT RENDERING — Draw lot geometries with per-layer styles
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build cached Path2D objects for each layer.
 * Called once during initialization to avoid per-frame path construction.
 * - Stroke-only layers (lots): all polygons batched into one Path2D
 * - Filled layers: individual Path2D per polygon to handle overlaps correctly
 */
function buildLotPaths() {
    // Skip in Node.js (no Path2D)
    if (typeof Path2D === 'undefined') return;
    if (!_loadedLots || _loadedLots.length === 0) return;

    const renderOrder = ['urbanFootprint', 'industrialParks', 'electricity', 'phases', 'parkWaiting', 'lots'];

    // Layer styles (same as drawLots)
    const layerStyles = {
        lots: { fill: null, stroke: true },
        parkWaiting: { fill: true, stroke: true }
        // Others use default (fill + stroke)
    };

    _lotPathsByLayer = {};
    let totalPolygons = 0;

    for (const layerName of renderOrder) {
        const layerLots = _loadedLots.filter(lot => lot.layer === layerName);
        if (layerLots.length === 0) continue;

        const style = layerStyles[layerName] || { fill: true, stroke: true };
        const hasStroke = style.stroke !== false;
        const hasFill = style.fill !== false && style.fill !== null;

        // Build stroke path (batches all polygons)
        const strokePath = hasStroke ? new Path2D() : null;
        // Build individual fill paths (for overlapping polygons)
        const fillPaths = hasFill ? [] : null;

        for (const lot of layerLots) {
            for (const poly of (lot.polygons || [])) {
                if (!poly.worldCoords || poly.worldCoords.length < 2) continue;
                const geometry = poly.geometry || 'Polygon';

                // Build path in world coordinates
                const polyPath = new Path2D();
                polyPath.moveTo(poly.worldCoords[0].x, poly.worldCoords[0].y);
                for (let i = 1; i < poly.worldCoords.length; i++) {
                    polyPath.lineTo(poly.worldCoords[i].x, poly.worldCoords[i].y);
                }
                if (geometry === 'Polygon') {
                    polyPath.closePath();
                }

                // Add to stroke batch
                if (strokePath) {
                    strokePath.addPath(polyPath);
                }
                // Store individual path for fills
                if (fillPaths) {
                    fillPaths.push({ path: polyPath, geometry });
                }

                totalPolygons++;
            }
        }

        _lotPathsByLayer[layerName] = {
            stroke: strokePath,
            fills: fillPaths,
            style: style
        };
    }

    log('[INIT] Lot Path2D cached:', totalPolygons, 'polygons across', Object.keys(_lotPathsByLayer).length, 'layers');
}

/**
 * Draw lot geometries with per-layer styles using cached Path2D.
 * Renders in z-order: urbanFootprint, industrialParks, electricity, phases, parkWaiting, lots.
 */
function drawLots(ctx, camera) {
    if (!_lotPathsByLayer || !camera) return;

    // Render order (back to front)
    const renderOrder = ['urbanFootprint', 'industrialParks', 'electricity', 'phases', 'parkWaiting', 'lots'];

    // Default style fallback (dark mode aware)
    const defaultStyle = _darkMode
        ? { fill: 'rgba(255, 255, 255, 0.08)', stroke: 'rgba(255, 255, 255, 0.4)', strokeWidth: 1 }
        : { fill: 'rgba(0, 0, 0, 0.06)', stroke: 'rgba(0, 0, 0, 0.3)', strokeWidth: 1 };

    // Layer-specific style overrides (dark mode aware)
    const layerStyles = {
        lots: {
            fill: null,  // No fill - just outlines
            stroke: _darkMode ? 'rgba(153, 153, 153, 0.8)' : 'rgba(80, 80, 80, 0.6)',
            strokeWidth: 1
        },
        parkWaiting: {
            fill: 'rgba(204, 0, 204, 0.15)',  // Magenta tint (matches particle color)
            stroke: 'rgba(204, 0, 204, 0.6)',  // Magenta outline
            strokeWidth: 1.5
        },
        industrialParks: {
            fill: _darkMode ? 'rgba(35, 35, 35, 1)' : 'rgba(200, 200, 200, 1)',
            stroke: null,
            strokeWidth: 1
        }
    };

    // Camera transform: world → screen
    const cx = camera.centerWorld.x;
    const cy = camera.centerWorld.y;
    const zoom = camera.zoom;
    const halfW = camera.canvasWidth * 0.5;
    const halfH = camera.canvasHeight * 0.5;

    ctx.save();

    // Clip to canvas bounds - helps browser optimize path clipping at high zoom
    ctx.beginPath();
    ctx.rect(0, 0, camera.canvasWidth, camera.canvasHeight);
    ctx.clip();

    // Apply camera transform (same as drawRoads)
    ctx.setTransform(zoom, 0, 0, -zoom, halfW - cx * zoom, halfH + cy * zoom);

    // DEBUG: log once per layer
    if (!drawLots._debugged) {
        drawLots._debugged = true;
        for (const ln of renderOrder) {
            const ll = _loadedLots.filter(lot => lot.layer === ln);
            const polyCount = ll.reduce((sum, l) => sum + (l.polygons?.length || 0), 0);
            const wcCount = ll.reduce((sum, l) => sum + (l.polygons?.filter(p => p.worldCoords?.length > 0).length || 0), 0);
            log(`[LOTS RENDER v2] layer=${ln} lots=${ll.length} polygons=${polyCount} withWorldCoords=${wcCount}`);
        }
    }

    for (const layerName of renderOrder) {
        // Skip phases layer when Inovus is disabled
        if (layerName === 'phases' && !_phasesAsLots) continue;

        const cached = _lotPathsByLayer[layerName];
        if (!cached) continue;

        const style = layerStyles[layerName] || defaultStyle;

        // Draw fills (individual paths to handle overlaps)
        if (cached.fills && style.fill) {
            ctx.fillStyle = style.fill;
            for (const fillData of cached.fills) {
                ctx.fill(fillData.path);
            }
        }

        // Draw strokes (batched for performance)
        if (cached.stroke && style.stroke) {
            ctx.strokeStyle = style.stroke;
            // Line width in world units - convert to screen: 1px at any zoom
            ctx.lineWidth = 1 / zoom;
            ctx.stroke(cached.stroke);
        }
    }

    ctx.restore();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROAD RENDERING (for dark mode - roads are drawn by main renderer otherwise)
// ═══════════════════════════════════════════════════════════════════════════════

let _roadPath = null;  // Cached Path2D in world coords
let _twinSpanPath = null;  // Twin span bridge/approach path
let _twinSpanAlpha = 0;  // Twin span visibility (0 = hidden, 1 = fully visible)
let _twinSpanSegments = null;  // Actual segment points for offset calculation

function buildRoadPath(geometry) {
    // Skip in Node.js (no Path2D)
    if (typeof Path2D === 'undefined') return;
    const segments = geometry?.roadSegments || rendererContext?.geometry?.roadSegments;
    if (!segments) return;

    // Filter to segments that pass within 100km of ROI center
    const cx = roi.centerX;
    const cy = roi.centerY;
    const maxDist = 100000;  // 100km

    _roadPath = new Path2D();
    let segCount = 0;
    for (const seg of segments) {
        if (!seg.points || seg.points.length < 2) continue;
        // Check if ANY point is within range
        let inRange = false;
        for (const p of seg.points) {
            if (Math.abs(p.x - cx) <= maxDist && Math.abs(p.y - cy) <= maxDist) {
                inRange = true;
                break;
            }
        }
        if (!inRange) continue;

        segCount++;
        _roadPath.moveTo(seg.points[0].x, seg.points[0].y);
        for (let i = 1; i < seg.points.length; i++) {
            _roadPath.lineTo(seg.points[i].x, seg.points[i].y);
        }
    }
}

// Add city segments to road path (called from testBundle after load)
export function setCitySegments(citySegments) {
    if (!_roadPath) _roadPath = new Path2D();

    const cx = roi.centerX;
    const cy = roi.centerY;
    const maxDist = 100000;  // 100km

    let segCount = 0;
    for (const seg of citySegments) {
        if (!seg.points || seg.points.length < 2) continue;
        // Check if ANY point is within range
        let inRange = false;
        for (const p of seg.points) {
            if (Math.abs(p.x - cx) <= maxDist && Math.abs(p.y - cy) <= maxDist) {
                inRange = true;
                break;
            }
        }
        if (!inRange) continue;

        segCount++;
        _roadPath.moveTo(seg.points[0].x, seg.points[0].y);
        for (let i = 1; i < seg.points.length; i++) {
            _roadPath.lineTo(seg.points[i].x, seg.points[i].y);
        }
    }
}

function drawRoads(ctx, camera) {
    if (!_roadPath) return;

    const cx = camera.centerWorld.x;
    const cy = camera.centerWorld.y;
    const zoom = camera.zoom;
    const halfW = camera.canvasWidth * 0.5;
    const halfH = camera.canvasHeight * 0.5;

    ctx.save();

    // Clip to canvas bounds - helps browser optimize path clipping at high zoom
    ctx.beginPath();
    ctx.rect(0, 0, camera.canvasWidth, camera.canvasHeight);
    ctx.clip();

    // Apply camera transform: world → screen
    ctx.setTransform(zoom, 0, 0, -zoom, halfW - cx * zoom, halfH + cy * zoom);

    // Dark mode: subtle gray so particles stand out. Light mode: darker gray.
    ctx.strokeStyle = _darkMode ? 'rgb(70, 70, 70)' : 'rgb(140, 140, 140)';
    ctx.lineWidth = 24;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.stroke(_roadPath);

    // Draw twin span if active
    if (_twinSpanPath && _twinSpanAlpha > 0.01) {
        ctx.globalAlpha = _twinSpanAlpha;
        ctx.strokeStyle = _darkMode ? 'rgb(70, 70, 70)' : 'rgb(140, 140, 140)';
        ctx.stroke(_twinSpanPath);
        ctx.globalAlpha = 1;
    }

    ctx.restore();
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER — Shows exactly what exists, nothing more
// ═══════════════════════════════════════════════════════════════════════════════

// MODE 1: CLASS - Simple class colors (hex for canvas)
function getParticleClassColor(p) {
    if (p.state === STATE.CLEARED) return '#00cc00';  // Green
    if (p.state === STATE.LOT || p.state === STATE.PARK) return '#ff8800';  // Orange
    if (p.state === STATE.ROAD) return '#0088ff';  // Blue
    return '#888888';
}

// MODE 2: STALL - Class + stall overlays (hex for canvas)
function getParticleStallColor(p) {
    if (p.state === STATE.CLEARED) {
        if (p.renderStalled || p.stallReason) {
            if (p.stallReason === 'dead_end') return '#ff0000';
            if (p.stallReason === 'road_full') return '#ff8800';
            return '#ffcc00';
        }
        return '#00cc00';
    }
    if (p.state === STATE.LOT || p.state === STATE.PARK) {
        return '#ff8800';
    }
    if (p.state === STATE.ROAD) {
        if (p.renderStalled || p.stallReason) {
            if (p.stallReason === 'dead_end') return '#ff0000';
            if (p.stallReason === 'lot_full') return '#ff6600';
            if (p.stallReason === 'road_full') return '#ff9900';
            return '#ffcc00';
        }
        return '#0088ff';
    }
    return '#888888';
}

// Legacy function (kept for compatibility)
function getParticleDebugColor(p) {
    return getParticleStallColor(p);
}

// MODE 1: CLASS - Simple class colors (no stall overlays)
// ROAD=blue, CLEARED=green, LOT/INDUSTRIAL/PARK=orange
function getParticleClassColorRGB(p) {
    if (p.state === STATE.CLEARED) {
        return { r: 0, g: 0.8, b: 0 };  // Green
    }
    if (p.state === STATE.LOT || p.state === STATE.PARK) {
        return { r: 1, g: 0.533, b: 0 };  // Orange (all waiting states)
    }
    if (p.state === STATE.ROAD) {
        return { r: 0, g: 0.533, b: 1 };  // Blue
    }
    return { r: 0.533, g: 0.533, b: 0.533 };
}

// MODE 2: STALL - Class colors + stall reason overlays
function getParticleStallColorRGB(p) {
    // Cleared particles → green (stalls shown)
    if (p.state === STATE.CLEARED) {
        if (p.renderStalled || p.stallReason) {
            if (p.stallReason === 'dead_end') return { r: 1, g: 0, b: 0 };
            if (p.stallReason === 'road_full') return { r: 1, g: 0.5, b: 0 };
            return { r: 1, g: 0.8, b: 0 };  // Gold generic
        }
        return { r: 0, g: 0.8, b: 0 };
    }
    // Waiting states → orange (uniform)
    if (p.state === STATE.LOT || p.state === STATE.PARK) {
        return { r: 1, g: 0.533, b: 0 };
    }
    // ROAD with stall reasons
    if (p.state === STATE.ROAD) {
        if (p.renderStalled || p.stallReason) {
            if (p.stallReason === 'dead_end') return { r: 1, g: 0, b: 0 };     // Red
            if (p.stallReason === 'lot_full') return { r: 1, g: 0.4, b: 0 };   // Orange-red
            if (p.stallReason === 'road_full') return { r: 1, g: 0.6, b: 0 };  // Orange
            return { r: 1, g: 0.8, b: 0 };  // Gold generic
        }
        return { r: 0, g: 0.533, b: 1 };  // Blue
    }
    return { r: 0.533, g: 0.533, b: 0.533 };
}

// RGB version for WebGL source colors
function getParticleSourceColorRGB(p) {
    switch (p.sourceType) {
        case SOURCE_TYPE.CORRIDOR_WEST:
            return { r: 1, g: 0.2, b: 0.2 };
        case SOURCE_TYPE.CORRIDOR_EAST:
            return { r: 0.2, g: 0.4, b: 1 };
        case SOURCE_TYPE.INDUSTRIAL:
            return { r: 0.2, g: 0.8, b: 0.2 };
        default:
            return { r: 0.533, g: 0.533, b: 0.533 };
    }
}

// Canvas render function removed - WebGL only

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

let state = OverlayState.OFF;
let rendererContext = null;

export function reset() {
    // Clear all cell state
    cellMass.fill(0);
    commuterLoad.fill(0);  // Reset dynamic commuter friction
    for (let i = 0; i < N2; i++) {
        cellParticles[i].length = 0;
    }
    _activeParticleCount = 0;  // Reset flat GPU array
    _movingParticleCount = 0;  // Reset moving particles array

    // Clear lot state
    if (lotMass.length > 0) {
        lotMass.fill(0);
    }
    lotDraining.clear();
    if (lotCooldownEndSimS.length > 0) {
        lotCooldownEndSimS.fill(0);
    }

    // Clear park state
    if (parkMass.length > 0) {
        parkMass.fill(0);
    }
    parkReleaseQueue.length = 0;

    // Clear queues
    conversionQueue.length = 0;
    sinkQueue.length = 0;
    injectionAccumulator.clear();

    // Reset CBP lanes
    for (const lane of CBP_LANES) {
        lane.particle = null;
        lane.busyUntil = 0;
    }
    SERVICE_TIME_S = Infinity;

    // Reset metrics
    metrics.injected = 0;
    metrics.moved = 0;
    metrics.enteredLots = 0;
    metrics.enteredParks = 0;
    metrics.releasedFromParks = 0;
    metrics.converted = 0;
    metrics.exited = 0;
    metrics.violations = 0;

    // Reset time
    simTime = 0;

    // Reset truck-hours lost metrics
    _truckHoursLost = 0;
    _truckHoursLostThisTick = 0;
    _truckHoursLostRate = 0;
    _lastRateSampleTime = 0;
    _lastRateSampleValue = 0;

    // Reset truck-hours lost breakdown (instrumentation)
    _truckHoursLostCongestion = 0;
    _truckHoursLostLotWait = 0;
    _truckHoursLostBridgeQueue = 0;
    _truckHoursLostBridgeService = 0;
    _truckHoursLostCongestionTick = 0;
    _truckHoursLostLotWaitTick = 0;
    _truckHoursLostBridgeQueueTick = 0;
    _truckHoursLostBridgeServiceTick = 0;

    // Reset service time instrumentation arrays
    _serviceTimeActual = [];
    _serviceTimeExpected = [];
    _serviceTimeAssignSim = [];

    // Reset stall-ton-hours (critical for fresh runs)
    _stallTonHours = 0;
    _stalledMassKg = 0;

    // Reset active cells tracking
    activeCells.clear();

    // Reset sleeping particles
    sleepingParticles.length = 0;

    // Reset deterministic RNG for reproducibility
    _rngState = 12345;
    particleIdCounter = 0;

    // Reset hourly caches (forces reload on first step)
    _lastGateCapHour = -1;
    _lastInflowHour = -1;
    _dailyTotalLoaded = false;
    dailyTotalKg = 0;
    inflowKgPerHour = 0;
    sinkCapKgPerHour = 0;

    // Reset rebuild timing and lot admission baseline
    _lastRebuildWallMs = 0;
    _admittedLotCount = 0;
    _routingDirty = false;
    _rebuildPending = false;

    // Reset instrumentation counters
    _phiRebuildCount = 0;
    _lotExclusionCount = 0;
    _cooldownExpiryCount = 0;
    _cbpCompletionCount = 0;
    _departedCount = 0;
    _spawnCount = 0;
    _intersectionBlockCount = 0;

    // Reset routing lineage
    _routingVersion = 0;
    _rebuildEventLog.length = 0;

    // Reset static routing flag for determinism (forces identical init paths)
    _staticRoutingReady = false;

    // Reset rebuild guard (should be false at end of run, but ensure clean state)
    _phiRebuilding = false;
}

// Admission control: dispatch stops routing to lots above this fill fraction
let _lotAdmissionCutoff = 0.55;  // Default: 55% (can be raised via setLotAdmissionCutoff)

// Track if static routing (PHARR) has been computed — PHARR never changes (bridge sinks fixed)
let _staticRoutingReady = false;

async function buildRouting() {
    // Guard: don't rebuild if already rebuilding
    if (_phiRebuilding) {
        logBuild('[BUILD] Skipping — rebuild already in progress');
        return;
    }
    _phiRebuilding = true;
    _routingBuildToken++;  // Increment token to invalidate any in-flight results

    try {
        const routingStart = Date.now();
        _phiRebuildCount++;
        logBuild('[BUILD] Computing lot routing...');

        // Sinks for lot routing = lot cells with capacity AND not full/draining/cooldown
        const lotSinks = [];
        const excludedLots = new Set();
        const drainingLotsLocal = new Set();
        const cooldownLots = new Set();

        for (let i = 0; i < lotCellIndices.length; i++) {
            const idx = lotCellIndices[i];
            const lotIdx = cellToLotIndex[idx];
            if (lotIdx >= 0 && lotCapacity[lotIdx] > 0) {
                // Check draining state
                if (lotDraining.has(lotIdx)) {
                    drainingLotsLocal.add(lotIdx);
                    continue;
                }
                // Check cooldown state (sim-time based, dt-invariant)
                if (lotCooldownEndSimS[lotIdx] > 0 && simTime < lotCooldownEndSimS[lotIdx]) {
                    cooldownLots.add(lotIdx);
                    continue;
                }
                // Check fill level
                const fill = lotMass[lotIdx] / lotCapacity[lotIdx];
                if (fill < _lotAdmissionCutoff) {
                    lotSinks.push(idx);
                } else {
                    excludedLots.add(lotIdx);
                }
            }
        }

        // Always log lot routing state for diagnostics
        const uniqueSinkLots = new Set(lotSinks.map(idx => cellToLotIndex[idx]));
        logBuild(`[BUILD] Lot routing: ${uniqueSinkLots.size} available, ${excludedLots.size} full, ${drainingLotsLocal.size} draining, ${cooldownLots.size} cooldown`);
        if (excludedLots.size > 0) {
            logBuild(`[BUILD] Full lots: [${[...excludedLots].join(', ')}]`);
        }
        if (drainingLotsLocal.size > 0) {
            logBuild(`[BUILD] Draining lots: [${[...drainingLotsLocal].join(', ')}]`);
        }

        // Fallback: if ALL lots are full, include them anyway (prevent routing failure)
        if (lotSinks.length === 0 && lotCellIndices.length > 0) {
            logBuild('[BUILD] All lots full! Including all as sinks (fallback)');
            for (const idx of lotCellIndices) {
                const lotIdx = cellToLotIndex[idx];
                if (lotIdx >= 0 && lotCapacity[lotIdx] > 0) {
                    lotSinks.push(idx);
                }
            }
        }

        // Compute PHARR routing FIRST (needed for lot sink bias) — async via worker
        // OPTIMIZATION: PHARR sinks (bridge) never change, only compute once
        // NOTE: Now also computes twin span routing when active
        if (!_staticRoutingReady) {
            log('[BUILD] Computing PHARR routing (first time)...');
            await computeRoutingAsync(sinkCellIndices, phi_pharr, nextHop_pharr, 'PHARR');

            // Twin span routing (when active): force routing through twin span path
            if (_twinSpanActive && _twinSpanCellIndices.length > 0) {
                log('[BUILD] Computing twin span PHARR routing...');
                // Create K mask that blocks main approach cells NORTH of junction
                // This allows particles to reach junction via main roads, then forces twin span
                const KxxTwin = new Float32Array(Kxx);
                const KyyTwin = new Float32Array(Kyy);
                const JUNCTION_Y = -2583;  // Y coordinate where twin span branches off
                let blockedCells = 0;
                for (let idx = 0; idx < N2; idx++) {
                    // Block main approach cells north of junction (but not twin span cells)
                    if (_bridgeApproachCache && _bridgeApproachCache[idx] === 1) {
                        // Check if this is a twin span cell - if so, don't block
                        if (!_twinSpanCellIndices.includes(idx)) {
                            // Only block cells north of junction (closer to sink)
                            const fy = Math.floor(idx / N);
                            const wy = fieldToWorldY(fy + 0.5);
                            if (wy > JUNCTION_Y) {
                                KxxTwin[idx] = 0;
                                KyyTwin[idx] = 0;
                                blockedCells++;
                            }
                        }
                    }
                }
                log(`[TWIN_SPAN] Blocked ${blockedCells} main approach cells north of junction for twin routing`);
                await computeRoutingAsync(sinkCellIndices, phi_pharr_twin, nextHop_pharr_twin, 'PHARR_TWIN', null, 0, KxxTwin, KyyTwin);
            } else {
                // Twin span not active - clear its routing
                phi_pharr_twin.fill(PHI_LARGE);
                nextHop_pharr_twin.fill(-1);
            }
        }

        // BUILD BLOCKED LOTS: draining + cooldown + full (all non-admissible)
        const blockedLots = new Set([...drainingLotsLocal, ...cooldownLots, ...excludedLots]);

        // Create K overrides for LOTS routing: zero conductance for blocked lot cells
        // This prevents routing THROUGH non-admissible lots to reach lots beyond
        let KxxLots = null;
        let KyyLots = null;
        let blockedLotCellCount = 0;
        if (blockedLots.size > 0) {
            KxxLots = new Float32Array(Kxx);
            KyyLots = new Float32Array(Kyy);
            for (const idx of lotCellIndices) {
                const lotIdx = cellToLotIndex[idx];
                if (lotIdx >= 0 && blockedLots.has(lotIdx)) {
                    KxxLots[idx] = 0;
                    KyyLots[idx] = 0;
                    blockedLotCellCount++;
                }
            }
            logBuild(`[BUILD] Blocked ${blockedLotCellCount} lot cells from LOTS routing (${blockedLots.size} lots)`);
        }

        // ─────────────────────────────────────────────────────────────────────────────
        // PARALLEL: Compute LOTS and SLEEP_LOTS routing simultaneously
        // They're independent — LOTS uses phi_pharr bias, SLEEP_LOTS has no dependencies
        // ─────────────────────────────────────────────────────────────────────────────

        // Build sleep lot sinks list
        const sleepLotSinks = [];
        for (const idx of lotCellIndices) {
            const lotIdx = cellToLotIndex[idx];
            if (lotIdx >= 0 && isSleepLot(lotIdx)) {
                const fill = lotCapacity[lotIdx] > 0 ? lotMass[lotIdx] / lotCapacity[lotIdx] : 1;
                if (fill < _lotAdmissionCutoff) {
                    sleepLotSinks.push(idx);
                }
            }
        }

        // Launch both in parallel
        const lotsPromise = computeRoutingAsync(lotSinks, phi_lots, nextHop_lots, 'LOTS', phi_pharr, LOT_SINK_BIAS_WEIGHT, KxxLots, KyyLots);

        let sleepLotsPromise;
        if (sleepLotSinks.length > 0) {
            sleepLotsPromise = computeRoutingAsync(sleepLotSinks, phi_sleepLots, nextHop_sleepLots, 'SLEEP_LOTS');
        } else {
            phi_sleepLots.fill(PHI_LARGE);
            nextHop_sleepLots.fill(-1);
            sleepLotsPromise = Promise.resolve();
            logBuild('[BUILD] No sleep lots available (all full or not configured)');
        }

        // Wait for both to complete
        await Promise.all([lotsPromise, sleepLotsPromise]);
        if (sleepLotSinks.length > 0) {
            log(`[BUILD] Sleep lot routing: ${sleepLotSinks.length} sink cells from lots ${SLEEP_LOT_INDICES.join(',')}`);
        }

        // ─────────────────────────────────────────────────────────────────────────────
        // PARK ROUTING: If parks exist, compute routes to them
        // OPTIMIZATION: Park cells are static, only compute once
        // ─────────────────────────────────────────────────────────────────────────────
        if (!_staticRoutingReady && parkCellIndices.length > 0) {
            log('[BUILD] Computing park routing...');

            // Sinks for park routing = all park cells with capacity
            const parkSinks = [];
            for (let i = 0; i < parkCellIndices.length; i++) {
                const idx = parkCellIndices[i];
                const parkIdx = cellToParkIndex[idx];
                if (parkIdx >= 0 && parkCapacity[parkIdx] > 0) {
                    parkSinks.push(idx);
                }
            }

            if (parkSinks.length > 0) {
                await computeRoutingAsync(parkSinks, phi_parks, nextHop_parks, 'PARKS');

                // Validate: each park must have road exit
                for (let parkIdx = 0; parkIdx < parkToCellIndices.length; parkIdx++) {
                    const cells = parkToCellIndices[parkIdx];
                    let hasExit = false;
                    for (const idx of cells) {
                        if (nextHop_lots[idx] >= 0) {
                            hasExit = true;
                            break;
                        }
                    }
                    if (!hasExit) {
                        throw new Error(`[INVARIANT:PARK] Park ${parkIdx} has no valid exit to lots`);
                    }
                }
            }
        }

        // Build sparse cell lists
        roadCellIndices = [];
        for (let i = 0; i < N2; i++) {
            if (regionMap[i] === REGION.ROAD && (Kxx[i] > K_THRESHOLD || Kyy[i] > K_THRESHOLD)) {
                roadCellIndices.push(i);
            }
        }

        sourceCellIndices = [];
        for (let i = 0; i < N2; i++) {
            if (sourceField[i] > 0) {
                sourceCellIndices.push(i);
            }
        }

        // All cells with K > 0 (for debug visualization - includes roads, lots, parks)
        conductiveCellIndices = [];
        for (let i = 0; i < N2; i++) {
            if (Kxx[i] > K_THRESHOLD || Kyy[i] > K_THRESHOLD) {
                conductiveCellIndices.push(i);
            }
        }

        logBuild(`[BUILD] roadCells=${roadCellIndices.length} lotCells=${lotCellIndices.length} sinkCells=${sinkCellIndices.length} sourceCells=${sourceCellIndices.length} conductiveCells=${conductiveCellIndices.length}`);

        // Mark static routing as ready (PHARR won't rebuild again)
        if (!_staticRoutingReady) {
            _staticRoutingReady = true;
            log('[BUILD] PHARR routing cached — subsequent rebuilds run LOTS+SLEEP_LOTS in parallel');
        }

        // INCREMENT ROUTING VERSION — all particles will see new routes
        const oldVersion = _routingVersion;
        _routingVersion++;

        // POST-REBUILD VALIDATION: Check particles that were stalled at old version
        let staleStalls = 0;
        let rerouteFailures = 0;
        const failureSamples = [];
        for (let i = 0; i < N2; i++) {
            for (const p of cellParticles[i]) {
                if (p.stallReason === 'lot_full' && p.stallStartVersion < _routingVersion) {
                    staleStalls++;
                    // Check if new routing gives a different nextHop
                    const newNh = nextHop_lots[p.cellIdx];
                    if (newNh === p.lastRouteNh) {
                        rerouteFailures++;
                        // Collect diagnostic sample (first 5)
                        if (failureSamples.length < 5) {
                            const nhLotIdx = newNh >= 0 ? cellToLotIndex[newNh] : -1;
                            failureSamples.push({
                                pid: p.id,
                                cell: p.cellIdx,
                                nh: newNh,
                                nhRegion: newNh >= 0 ? regionMap[newNh] : -1,
                                nhLotIdx,
                                nhLotBlocked: nhLotIdx >= 0 ? blockedLots.has(nhLotIdx) : false,
                                phiHere: phi_lots[p.cellIdx],
                                phiNh: newNh >= 0 ? phi_lots[newNh] : -1,
                            });
                        }
                    }
                }
            }
        }
        if (staleStalls > 0) {
            logRebuildEvent('POST_REBUILD_CHECK', {
                oldVersion,
                staleStalls,
                rerouteFailures,
                lotSinkCount: lotSinks.length,
                blockedLotCellCount,
                failureSamples,
            });
        }

        logBuild(`[BUILD] Routing complete v${_routingVersion} (${((Date.now() - routingStart)/1000).toFixed(1)}s)`);
    } finally {
        _phiRebuilding = false;
        _lastRebuildWallMs = Date.now();

        // CRITICAL: Requeue if dirty events arrived during rebuild
        if (_routingDirty) {
            logRebuildEvent('REQUEUE_DIRTY');
            scheduleRoutingRebuild();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER ROUTING — Off-thread Dijkstra + buildNextHop (Browser + Node.js)
// ═══════════════════════════════════════════════════════════════════════════════

const _isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

/**
 * Initialize the routing worker (Web Worker in browser, worker_threads in Node.js).
 * Returns true if worker is available, false otherwise (falls back to sync).
 */
async function initRoutingWorker() {
    if (_routingWorker) return true;

    const handleMessage = (data) => {
        const { id, token, phi, nextHop, reachable } = data;
        // Reject stale results
        if (token !== _routingBuildToken) {
            logBuild(`[WORKER] Discarding stale result (token ${token} != ${_routingBuildToken})`);
            return;
        }
        const pending = _workerPending.get(id);
        if (pending) {
            _workerPending.delete(id);
            pending.resolve({
                phi: new Float32Array(phi),
                nextHop: new Int32Array(nextHop),
                reachable
            });
        }
    };

    const handleError = (err) => {
        console.error('[WORKER] Error:', err);
        for (const [id, pending] of _workerPending) {
            pending.reject(err);
        }
        _workerPending.clear();
    };

    if (_isNode) {
        // Node.js: use worker_threads (ES module compatible)
        try {
            const { createRequire } = await import('module');
            const require = createRequire(import.meta.url);
            const { Worker } = require('worker_threads');
            const path = require('path');
            const { fileURLToPath } = require('url');
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const workerPath = path.resolve(__dirname, '../engine/routingWorker.js');
            _routingWorker = new Worker(workerPath);
            _routingWorker.on('message', handleMessage);
            _routingWorker.on('error', handleError);
            console.log('[WORKER] Node.js worker_threads initialized');
            return true;
        } catch (err) {
            console.warn('[WORKER] Failed to initialize worker_threads, using sync fallback:', err);
            return false;
        }
    } else {
        // Browser: use Web Worker
        try {
            _routingWorker = new Worker(
                new URL('../engine/routingWorker.js', import.meta.url),
                { type: 'module' }
            );
            _routingWorker.onmessage = (e) => handleMessage(e.data);
            _routingWorker.onerror = handleError;
            console.log('[WORKER] Web Worker initialized');
            return true;
        } catch (err) {
            console.warn('[WORKER] Failed to initialize Web Worker, using sync fallback:', err);
            return false;
        }
    }
}

/**
 * Compute routing (phi + nextHop) asynchronously using Web Worker.
 * Falls back to synchronous computation if worker unavailable.
 */
async function computeRoutingAsync(sinkIndices, phiOutput, nextHopOutput, label, sinkBias = null, biasWeight = 0, KxxOverride = null, KyyOverride = null) {
    // Use overrides if provided, otherwise global K fields
    const KxxSource = KxxOverride || Kxx;
    const KyySource = KyyOverride || Kyy;

    // Try worker, fall back to sync if unavailable
    if (!(await initRoutingWorker())) {
        const reachable = computePotential(sinkIndices, phiOutput, label, sinkBias, biasWeight, KxxSource, KyySource);
        buildNextHop(phiOutput, nextHopOutput, label);
        return reachable;
    }

    const id = ++_workerRequestId;
    const config = {
        sinkIndices: Array.from(sinkIndices),
        N, N2,
        edgeCost: roi.cellSize,
        Kxx: KxxSource.buffer.slice(0),
        Kyy: KyySource.buffer.slice(0),
        regionMap: regionMap.buffer.slice(0),
        cellToLotIndex: cellToLotIndex.buffer.slice(0),
        drainingLots: Array.from(lotDraining),
        lotCapacity: lotCapacity.buffer.slice(0),
        lotMass: lotMass.buffer.slice(0),
        label,
        sinkBias: sinkBias ? sinkBias.buffer.slice(0) : null,
        biasWeight
    };

    const result = await new Promise((resolve, reject) => {
        _workerPending.set(id, { resolve, reject });
        _routingWorker.postMessage(
            { id, token: _routingBuildToken, cmd: 'computeRouting', config },
            [config.Kxx, config.Kyy, config.regionMap, config.cellToLotIndex,
             config.lotCapacity, config.lotMass, ...(config.sinkBias ? [config.sinkBias] : [])]
        );
    });

    phiOutput.set(result.phi);
    nextHopOutput.set(result.nextHop);
    logBuild(`[ROUTING:${label}] reachable=${result.reachable} (worker)`);
    return result.reachable;
}

/**
 * Mark routing as dirty (needs rebuild).
 * Only structural events should call this - not time-based triggers.
 */
function markRoutingDirty(reason) {
    if (_routingDirty) {
        logRebuildEvent('DIRTY_REDUNDANT', { reason });
        return;  // Already dirty
    }
    _routingDirty = true;
    logRebuildEvent('DIRTY', { reason });
    scheduleRoutingRebuild();
}

/**
 * Schedule routing rebuild asynchronously (outside frame path).
 * Uses setTimeout(0) to yield to event loop before heavy work.
 */
function scheduleRoutingRebuild() {
    // Already pending or rebuilding
    if (_rebuildPending || _phiRebuilding) {
        logRebuildEvent('SCHEDULE_SKIP', { pending: _rebuildPending, rebuilding: _phiRebuilding });
        return;
    }

    // Check wall-clock cooldown (browser only - Node.js has no frame responsiveness concern)
    if (!_isNode) {
        const timeSinceLastRebuild = Date.now() - _lastRebuildWallMs;
        if (timeSinceLastRebuild < REBUILD_MIN_INTERVAL_MS) {
            // Schedule for after cooldown expires
            const delay = REBUILD_MIN_INTERVAL_MS - timeSinceLastRebuild;
            logRebuildEvent('SCHEDULE_DELAYED', { delayMs: delay });
            _rebuildPending = true;
            setTimeout(() => {
                _rebuildPending = false;
                scheduleRoutingRebuild();
            }, delay);
            return;
        }
    }

    // In Node.js: run synchronously (no frame responsiveness concern)
    // In browser: defer via setTimeout to keep frames responsive
    logRebuildEvent('SCHEDULE_IMMEDIATE');

    if (_isNode) {
        // Node.js: blocking rebuild (deterministic, no visual lag concern)
        if (!_routingDirty) {
            logRebuildEvent('EXECUTE_CANCEL', { reason: 'no longer dirty' });
            return;
        }
        _routingDirty = false;
        logRebuildEvent('EXECUTE_START');
        // Store promise for step() to await
        _pendingRebuild = buildRouting().then(() => {
            _lastRebuildWallMs = Date.now();
            logRebuildEvent('EXECUTE_COMPLETE', { newVersion: _routingVersion });
            _pendingRebuild = null;
        });
    } else {
        // Browser: defer to keep frame responsive
        _rebuildPending = true;
        setTimeout(async () => {
            _rebuildPending = false;
            if (!_routingDirty) {
                logRebuildEvent('EXECUTE_CANCEL', { reason: 'no longer dirty' });
                return;
            }
            _routingDirty = false;
            logRebuildEvent('EXECUTE_START');
            await buildRouting();
            _lastRebuildWallMs = Date.now();
            logRebuildEvent('EXECUTE_COMPLETE', { newVersion: _routingVersion });
        }, 0);
    }
}

/**
 * Update lot admission state machine (called per frame).
 * Tracks draining/cooldown states but does NOT trigger rebuilds inline.
 * Rebuilds are triggered via markRoutingDirty() and scheduled asynchronously.
 */
function updateLotAdmissionState() {
    // Guard: skip if routing rebuild is in progress (state may be stale)
    if (_phiRebuilding) return;

    let needsRebuild = false;

    // Process lot draining/cooldown state machine
    for (let i = 0; i < lotCapacity.length; i++) {
        if (lotCapacity[i] <= 0) continue;

        const fill = lotMass[i] / lotCapacity[i];
        const isEmpty = lotMass[i] <= 0;

        // Check if lot crossed cutoff → mark as draining
        if (fill >= _lotAdmissionCutoff && !lotDraining.has(i)) {
            lotDraining.add(i);
            _lotExclusionCount++;
            log(`[LOT] Lot ${i} started draining (fill=${(fill * 100).toFixed(0)}%)`);
            needsRebuild = true;
        }

        // Check if draining lot is now empty → start cooldown (sim-time based)
        if (lotDraining.has(i) && isEmpty) {
            lotDraining.delete(i);
            lotCooldownEndSimS[i] = simTime + LOT_COOLDOWN_S;
            log(`[LOT] Lot ${i} empty, cooldown started (${LOT_COOLDOWN_S}s sim-time)`);
        }

        // Check if cooldown expired → lot can accept again (sim-time based)
        if (lotCooldownEndSimS[i] > 0 && simTime >= lotCooldownEndSimS[i]) {
            lotCooldownEndSimS[i] = 0;
            _cooldownExpiryCount++;
            log(`[LOT] Lot ${i} cooldown expired, now accepting`);
            needsRebuild = true;
        }
    }

    // Count currently admitted lots (below cutoff, not draining, not cooldown)
    let admitted = 0;
    for (let i = 0; i < lotCapacity.length; i++) {
        if (lotCapacity[i] > 0) {
            if (lotDraining.has(i)) continue;
            if (lotCooldownEndSimS[i] > 0 && simTime < lotCooldownEndSimS[i]) continue;
            const fill = lotMass[i] / lotCapacity[i];
            if (fill < _lotAdmissionCutoff) admitted++;
        }
    }

    // Trigger: admitted count changed (a lot was excluded or re-admitted)
    if (admitted !== _admittedLotCount) {
        const phiState = recordAdmitLots(admitted);
        ctrlPhi('ADMIT_CHANGE', {
            from: _admittedLotCount,
            to: admitted,
            delta: admitted - _admittedLotCount,
            phiState,
        });
        _admittedLotCount = admitted;
        needsRebuild = true;
    }


    // Always mark dirty when rebuild needed; let scheduleRoutingRebuild handle rate limiting
    if (needsRebuild) {
        markRoutingDirty('lot admission changed');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE — Minimal interface
// ═══════════════════════════════════════════════════════════════════════════════

export async function onAttach(context) {
    logBuild('[ATTACH] onAttach entered');
    rendererContext = context;

    const pharr = context.geometry?.poePoints?.PHARR;
    if (!pharr) {
        throw new Error('[INVARIANT:INIT] PHARR POE not found');
    }

    roi.centerX = pharr.x;
    roi.centerY = pharr.y + REYNOSA_ACTIVATION.CENTER_OFFSET_Y;
    roi.cellSize = roi.sizeM / N;

    // Precompute cell centers for O(1) lookup in drift loop
    initCellCenters();

    // Build bridge approach cache (depends on cell centers)
    initBridgeApproachCache();

    // Compute physical road capacity now that cellSize is known
    computeRoadCellCap();

    reset();

    // Auto-initialize if geometry is provided (testbundle.html path)
    logBuild(`[ATTACH] Checking geometry: ${context.geometry?.roadSegments?.length || 0} segments`);
    if (context.geometry?.roadSegments) {
        logBuild('[ATTACH] Starting initializeFromGeometry...');
        await initializeFromGeometry(context.geometry);
        logBuild('[ATTACH] initializeFromGeometry complete');
    }
}

async function initializeFromGeometry(geometry) {
    const geomStart = Date.now();
    const logGeomTime = () => `${((Date.now() - geomStart)/1000).toFixed(1)}s`;
    logBuild('[INIT] Building K-tensor from roads...');
    bakeKTensor(geometry);
    logBuild(`[INIT] K-tensor complete (${logGeomTime()})`);

    // Cache road geometry for fast rendering
    buildRoadPath(geometry);

    // Build road cell list
    roadCellIndices = [];
    for (let i = 0; i < N2; i++) {
        if (Kxx[i] > K_THRESHOLD || Kyy[i] > K_THRESHOLD) {
            if (regionMap[i] !== REGION.LOT && regionMap[i] !== REGION.SINK) {
                regionMap[i] = REGION.ROAD;
                roadCellIndices.push(i);
            }
        }
    }
    log(`[INIT] ${roadCellIndices.length} road cells`);

    // Load lots
    logBuild(`[INIT] Loading lots... (${logGeomTime()})`);
    const lotsJsonPath = new URL('../test/SIG16.json', import.meta.url).href;
    await loadAndStampLots(lotsJsonPath);
    logBuild(`[INIT] Lots loaded (${logGeomTime()})`);

    // Cache lot geometry for fast rendering (same pattern as roads)
    buildLotPaths();

    // Add manual injection points (before bridging so they get connected)
    addManualInjectionPoints();

    // Apply injection point overrides (move existing points)
    applyInjectionPointOverrides();

    // Bridge lots and industrial parks to road network
    bridgeLotsAndParksToRoads();

    // Stamp manual fine-grained connectors
    stampManualConnectors();

    // Unstamp Inovus-only connectors (they exist in bundle but should only be active when Inovus enabled)
    unstampInovusConnectors();

    // Stamp manual blockers (destroy roads/lots)
    stampManualBlockers();

    // Stamp sink at PHARR (larger catchment to prevent diagonal-drift dead ends)
    const pharr = geometry?.poePoints?.PHARR;
    if (pharr) {
        sinkCellIndices = [];  // Reset - was accumulating across runs
        const fx = Math.floor(worldToFieldX(pharr.x));
        const fy = Math.floor(worldToFieldY(pharr.y));
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const cx = fx + dx, cy = fy + dy;
                if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;
                const idx = cy * N + cx;
                regionMap[idx] = REGION.SINK;
                sinkCellIndices.push(idx);
                Kxx[idx] = 1;
                Kyy[idx] = 1;
            }
        }
        log(`[INIT] PHARR sink at (${fx},${fy}), ${sinkCellIndices.length} cells`);
    }

    // Initialize hardcoded loop routing
    initLoopSequence();

    // Build routing
    logBuild(`[INIT] Starting buildRouting... (${logGeomTime()})`);
    await buildRouting();
    logBuild(`[INIT] buildRouting complete (${logGeomTime()})`);

    // Initialize corridor entry points
    initCorridorEntries();

    // Compute source shares (0-1) for each injection point
    // At runtime, stepInjection multiplies: share × (CIEN_hourly_kg / 3600)
    computeSources();

    // CRITICAL: Ensure all source cells are traversable roads
    // This fixes the case where injection points fall inside lot polygons
    // and get skipped by stampConnector
    let sourcesFixed = 0;
    for (const idx of sourceCellIndices) {
        const sx = idx % N;
        const sy = Math.floor(idx / N);

        // Force-stamp source cell and immediate neighbors as ROAD
        // This ensures connectivity even if surrounded by LOT cells
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const nx = sx + dx, ny = sy + dy;
                if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                const ni = ny * N + nx;

                // Don't touch sinks
                if (regionMap[ni] === REGION.SINK) continue;

                // Mark as ROAD so stepFlow() processes it
                if (regionMap[ni] !== REGION.ROAD) {
                    regionMap[ni] = REGION.ROAD;
                    if (dx === 0 && dy === 0) sourcesFixed++;
                }
                // Ensure traversable
                if (Kxx[ni] < K_CONNECTOR) {
                    Kxx[ni] = K_CONNECTOR;
                    Kyy[ni] = K_CONNECTOR;
                }
                // Add to roadCellIndices if not present
                if (!roadCellIndices.includes(ni)) {
                    roadCellIndices.push(ni);
                }
            }
        }
    }
    if (sourcesFixed > 0) {
        log(`[INIT] Fixed ${sourcesFixed} source cells (marked as ROAD)`);
    }
    // Always rebuild routing after modifying source cell areas
    // (we may have stamped neighbor cells even if center was already ROAD)
    if (sourceCellIndices.length > 0) {
        log('[INIT] Rebuilding routing to include source areas...');
        await buildRouting();
    }

    // Initialize admitted lot count for phi rebuild trigger baseline
    _admittedLotCount = 0;
    for (let i = 0; i < lotCapacity.length; i++) {
        if (lotCapacity[i] > 0) {
            const fill = lotMass[i] / lotCapacity[i];
            if (fill < _lotAdmissionCutoff) _admittedLotCount++;
        }
    }
    log(`[INIT] Admitted lots baseline: ${_admittedLotCount}/${lotCapacity.length}`);

    // Diagnostic: verify source cells have valid routing
    let sourcesWithRoute = 0;
    let sourcesWithoutRoute = 0;
    for (const idx of sourceCellIndices) {
        if (nextHop_lots[idx] >= 0 || regionMap[idx] === REGION.LOT) {
            sourcesWithRoute++;
        } else {
            sourcesWithoutRoute++;
            const x = idx % N, y = Math.floor(idx / N);
            logBuild(`[INIT] Source cell (${x},${y}) has no route to lots! phi=${phi_lots[idx].toFixed(0)}`);
        }
    }
    log(`[INIT] Source routing: ${sourcesWithRoute} OK, ${sourcesWithoutRoute} unreachable`);

    // Initialize commuter friction field from explicit polylines
    stampCommuterWeights();
    stampSpeedLimits();

    // ACTIVATE THE OVERLAY
    state = OverlayState.ON;

    log('[INIT] Complete - overlay ACTIVE');
}

export function onDetach() {
    reset();
    state = OverlayState.OFF;
    rendererContext = null;
    // Clear cached paths
    _roadPath = null;
    _lotPathsByLayer = null;
    _loadedLots = [];
    // Reset debug flags
    drawLots._debugged = false;
}

export async function onBundleReady(bundle) {
    // Store bundle for CIEN data access (injection weights, flow totals, etc.)
    loadBundle(bundle);

    // Delegate to shared initialization
    await initializeFromGeometry(bundle.geometry);

    // Initialize commuter friction field from explicit polylines
    stampCommuterWeights();
    stampSpeedLimits();
}

export function update(realDt, camera) {
    if (state === OverlayState.OFF) return;

    // Track frame DT for metrics panel (convert to ms)
    _dtMs = realDt * 1000;

    // Apply time scaling: realDt * SIM_TIME_SCALE = sim seconds per frame
    const simDt = realDt * SIM_TIME_SCALE;

    step(simDt);
    _particlesDirty = true;  // Signal render to sync GPU (render path only)
}

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS PANEL — Top-left HUD
// ═══════════════════════════════════════════════════════════════════════════════

// Cached HUD metrics (recalculated every 30 frames)
let _hudCache = { roadMass: 0, peakCell: 0, lotMassTotal: 0, lotsOccupied: 0, maxUtil: 0, frameCount: 0 };

function drawMetricsPanel(ctx) {
    // Calculate rates (update every 60 sim seconds)
    const now = simTime;
    const elapsed = now - _lastMetricsTime;
    if (elapsed >= 60) {
        const injectedDelta = metrics.injected - _lastInjected;
        const exitedDelta = metrics.exited - _lastExited;
        _inRateKtMin = (injectedDelta / 1000) / (elapsed / 60);  // kt/min
        _outRateKtMin = (exitedDelta / 1000) / (elapsed / 60);
        _lastInjected = metrics.injected;
        _lastExited = metrics.exited;
        _lastMetricsTime = now;
    }

    // Recalculate expensive metrics every 30 frames
    if (_hudCache.frameCount++ >= 30) {
        _hudCache.frameCount = 0;

        // Road mass using sparse roadCellIndices (not N2 iteration)
        let roadMass = 0, peakCell = 0;
        for (const i of roadCellIndices) {
            roadMass += cellMass[i];
            if (cellMass[i] > peakCell) peakCell = cellMass[i];
        }
        _hudCache.roadMass = roadMass;
        _hudCache.peakCell = peakCell;

        // Lot stats (lotMass array is small)
        let lotMassTotal = 0, lotsOccupied = 0, maxUtil = 0;
        for (let i = 0; i < lotMass.length; i++) {
            lotMassTotal += lotMass[i];
            if (lotMass[i] > 0) lotsOccupied++;
            const util = lotCapacity[i] > 0 ? lotMass[i] / lotCapacity[i] : 0;
            if (util > maxUtil) maxUtil = util;
        }
        _hudCache.lotMassTotal = lotMassTotal;
        _hudCache.lotsOccupied = lotsOccupied;
        _hudCache.maxUtil = maxUtil;
    }

    const { roadMass, peakCell, lotMassTotal, lotsOccupied, maxUtil } = _hudCache;
    const totalMass = roadMass + lotMassTotal + metrics.exited;

    // Format sim time as HH:MM
    const hours = Math.floor(simTime / 3600) % 24;
    const minutes = Math.floor((simTime % 3600) / 60);
    const simTimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

    // // Text styling: IBM Plex Mono, black/white based on dark mode (no background, no border)
    // ctx.fillStyle = _darkMode ? '#ddd' : '#000';

    // let y = 32;
    // const x = 20;
    // const lineH = 22;
    // const groupGap = 28;

    // // Total Mass
    // ctx.font = "700 16px 'IBM Plex Mono', monospace";
    // ctx.fillText('Total Mass', x, y);
    // y += lineH;
    // ctx.font = "400 16px 'IBM Plex Mono', monospace";
    // ctx.fillText(`${(totalMass / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} kt`, x, y);
    // y += lineH + groupGap;

    // // IN/OUT rates
    // ctx.font = "700 16px 'IBM Plex Mono', monospace";
    // ctx.fillText(`IN:  ${_inRateKtMin.toFixed(1)} kt/min`, x, y);
    // y += lineH;
    // ctx.fillText(`OUT: ${_outRateKtMin.toFixed(1)} kt/min`, x, y);
    // y += lineH + groupGap;

    // // Lot stats
    // ctx.fillText(`LOTS: ${lotsOccupied} / ${lotMass.length}`, x, y);
    // y += lineH;
    // ctx.fillText(`MAX UTIL: ${(maxUtil * 100).toFixed(0)}%`, x, y);
    // y += lineH + groupGap;

    // // Road mass
    // ctx.fillText(`ROAD MASS: ${(roadMass / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} t`, x, y);
    // y += lineH;
    // ctx.fillText(`PEAK CELL: ${(peakCell / 1000).toFixed(0)} t`, x, y);
    // y += lineH + groupGap;

    // // DT (keep in left panel)
    // ctx.fillText(`DT: ${_dtMs.toFixed(1)} ms`, x, y);

    // SIM CLOCK — Top-right corner, 5x size (80px)
    ctx.save();
    ctx.font = "700 80px 'IBM Plex Mono', monospace";
    ctx.textAlign = 'right';
    ctx.fillStyle = _darkMode ? '#ddd' : '#000';
    ctx.fillText(simTimeStr, ctx.canvas.width - 30, 80);

    // STATUS NOTES — Below clock, Spanish
    ctx.font = "600 18px 'IBM Plex Mono', monospace";
    ctx.fillStyle = _darkMode ? '#ddd' : '#000';
    let statusY = 110;
    const statusX = ctx.canvas.width - 30;

    // Bridge closed indicator
    if (sinkCapKgPerHour === 0) {
        ctx.fillText('Puente cerrado', statusX, statusY);
        statusY += 24;
    }

    // Shift change indicator (during peak hours: 4-8, 12-16, 20-24)
    const h = hours;
    const isShiftChange = (h >= 4 && h < 8) || (h >= 12 && h < 16) || (h >= 20 && h < 24);
    if (isShiftChange) {
        ctx.fillText('Cambio de turno', statusX, statusY);
    }

    ctx.restore();
}

// Stall mode legend (drawn when M key cycles to STALL mode)
function drawStallModeLegend(ctx) {
    // Count particles by state
    let inQueue = 0;      // In SINK region OR in queue zone (bridge approach)
    let deadEnd = 0;      // stallReason === 'dead_end'
    let lotFull = 0;      // stallReason === 'lot_full'
    let roadFull = 0;     // stallReason === 'road_full'
    let preLotHold = 0;   // stallReason === 'pre_lot_hold'
    let congested = 0;    // On road with mass > RHO_CONGESTION_0
    let moving = 0;       // Normal flow

    for (let i = 0; i < N2; i++) {
        for (const p of cellParticles[i]) {
            if (regionMap[p.cellIdx] === REGION.SINK) {
                inQueue++;
            } else if (p.renderStalled && isInQueueZone(p.x, p.y)) {
                // Stalled in queue zone = bridge queue, not road congestion
                inQueue++;
            } else if (p.stallReason === 'dead_end') {
                deadEnd++;
            } else if (p.stallReason === 'lot_full') {
                lotFull++;
            } else if (p.stallReason === 'road_full') {
                roadFull++;
            } else if (p.stallReason === 'pre_lot_hold') {
                preLotHold++;
            } else if (regionMap[p.cellIdx] === REGION.ROAD && cellMass[p.cellIdx] > RHO_CONGESTION_0) {
                congested++;
            } else {
                moving++;
            }
        }
    }

    const lineH = 20;
    const boxSize = 12;
    const x = ctx.canvas.width - 30;
    let y = 160;

    ctx.save();
    ctx.textAlign = 'right';

    ctx.font = "700 14px 'IBM Plex Mono', monospace";
    ctx.fillStyle = _darkMode ? '#fff' : '#000';
    ctx.fillText('STALL MODE', x, y);
    y += lineH + 4;

    const legend = [
        { color: '#0080ff', label: 'queue', count: inQueue },
        { color: '#ff0000', label: 'dead_end', count: deadEnd },
        { color: '#ff00ff', label: 'lot_full', count: lotFull },
        { color: '#ff8000', label: 'road_full', count: roadFull },
        { color: '#00ffff', label: 'pre_lot_hold', count: preLotHold },
        { color: '#ffff00', label: 'congested', count: congested },
        { color: '#00ff00', label: 'moving', count: moving },
    ];

    ctx.font = "400 13px 'IBM Plex Mono', monospace";
    for (const item of legend) {
        // Draw color box
        ctx.fillStyle = item.color;
        ctx.fillRect(x - boxSize, y - boxSize + 3, boxSize, boxSize);
        // Draw label and count
        ctx.fillStyle = _darkMode ? '#fff' : '#000';
        ctx.fillText(`${item.label}: ${item.count}`, x - boxSize - 8, y);
        y += lineH;
    }

    ctx.restore();
}

// Source mode labels (drawn when M key cycles to SOURCE mode)
// Prominent labels with large text, high contrast, and colored borders
function drawSourceLabels(ctx, camera) {
    const shares = getSourceShares();

    // Helper to draw a prominent label with border
    function drawLabel(screen, text, color, label) {
        ctx.font = "bold 24px 'IBM Plex Mono', monospace";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const metrics = ctx.measureText(text);
        const padX = 12;
        const padY = 8;
        const boxW = metrics.width + padX * 2;
        const boxH = 32;
        const x = screen.x - boxW / 2;
        const y = screen.y - boxH / 2;

        // Drop shadow
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x + 3, y + 3, boxW, boxH);

        // Background
        ctx.fillStyle = 'rgba(0,0,0,0.9)';
        ctx.fillRect(x, y, boxW, boxH);

        // Colored border (3px)
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, boxW, boxH);

        // Text
        ctx.fillStyle = color;
        ctx.fillText(text, screen.x, screen.y);

        // Label above (smaller, same color)
        if (label) {
            ctx.font = "bold 14px 'IBM Plex Mono', monospace";
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.8;
            ctx.fillText(label, screen.x, screen.y - boxH / 2 - 12);
            ctx.globalAlpha = 1.0;
        }
    }

    // Draw corridor labels (at label coords, not injection points)
    for (const c of shares.corridors) {
        const labelPos = getCorridorLabelPos(c.id);
        if (!labelPos) continue;
        const screen = camera.worldToScreen(labelPos.x, labelPos.y);
        const color = c.id === 'ENTRY_MTY' ? '#ff4444' : '#4488ff';
        const label = c.id === 'ENTRY_MTY' ? 'CORREDOR MTY' : 'CORREDOR VICTORIA';
        drawLabel(screen, c.pct, color, label);
    }

    // Draw industrial zone labels (grouped by zone)
    const zonePositions = new Map();
    for (const park of _industrialParkInjectionPoints) {
        if (!zonePositions.has(park.zone)) {
            zonePositions.set(park.zone, { sumX: 0, sumY: 0, count: 0 });
        }
        const pos = zonePositions.get(park.zone);
        pos.sumX += park.fieldX;
        pos.sumY += park.fieldY;
        pos.count++;
    }

    for (const z of shares.industrialByZone) {
        const pos = zonePositions.get(z.zone);
        if (!pos || pos.count === 0) continue;
        const fx = pos.sumX / pos.count;
        const fy = pos.sumY / pos.count;
        const wx = fieldToWorldX(fx + 0.5);
        const wy = fieldToWorldY(fy + 0.5);
        const screen = camera.worldToScreen(wx, wy);
        drawLabel(screen, z.pct, '#44dd44', z.zone.toUpperCase());
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
}

let _drawDebugCounter = 0;
// Draw sub-timing accumulators
const _drawSubTiming = {
    darkBg: 0,
    roads: 0,
    lots: 0,
    particles: 0,
    hud: 0,
    frameCount: 0,
    lastLogTime: 0,
};

export function draw(ctx, camera) {
    if (state === OverlayState.OFF) return;

    const t0 = performance.now();

    // Note: Background is cleared by main renderer (testBundle.html)
    // Roads are also drawn by main renderer (both CIEN + city segments)
    // So we don't fill background or draw roads here anymore
    _drawSubTiming.darkBg += (performance.now() - t0);

    // Draw lot geometries (urbanFootprint, industrialParks, phases, lot outlines)
    const tLots0 = performance.now();
    drawLots(ctx, camera);
    _drawSubTiming.lots += (performance.now() - tLots0);

    // Draw roads ON TOP of industrial parks (so road lines are visible over park shading)
    const tRoads0 = performance.now();
    drawRoads(ctx, camera);
    _drawSubTiming.roads += (performance.now() - tRoads0);

    // Draw congestion heatmap (cyan cells) if enabled - behind particles
    drawCongestionHeatmap(ctx, camera);

    // Draw commuter friction debug (magenta cells + intersections) if enabled
    drawCommuterDebug(ctx, camera);

    // Draw simplified commuter heatmap (green→yellow→red) if enabled
    drawCommuterHeatmap(ctx, camera);

    // Draw commuter pressure (when in COMMUTER mode, not during replay)
    if (_flowRenderMode !== 'ROAD_HEATMAP') {
        drawCommuterPressure(ctx, camera);
    }

    // Draw speed limit polylines (when in SPEED mode)
    drawSpeedLimitPolylines(ctx, camera);

    // Draw cell-based congestion (always on, behind particles)
    drawCongestionCells(ctx, camera);

    // Draw road heatmap during replay (ROAD_HEATMAP mode)
    // This replaces particles during clockMontage replay
    if (_flowRenderMode === 'ROAD_HEATMAP') {
        drawRoadHeatmap(ctx, camera);

        // Render replay lot particles via WebGL even in ROAD_HEATMAP mode
        if (_replayLotParticleMode && _replayLotParticles.length > 0 && _webglRenderer && _webglRenderer.isAvailable()) {
            syncReplayLotParticlesToGL(camera);
            const pointSize = Math.max(2, camera.zoom * 6 * (_darkMode ? 1 : 2));
            _webglRenderer.updatePositions(_glPositions, _glParticleCount);
            _webglRenderer.updateColors(_glColors, _glParticleCount);
            _webglRenderer.draw(camera, pointSize);
        }
    }

    // Draw particles (WebGL) - skip when particles hidden for lot highlight OR in ROAD_HEATMAP mode
    const tParticles0 = performance.now();
    if (!_hideParticles && _flowRenderMode !== 'ROAD_HEATMAP' && _webglRenderer && _webglRenderer.isAvailable()) {
        const tSync0 = performance.now();

        // Sync all particles every frame
        syncPositionsToGL(camera);
        _particlesDirty = false;

        // ═══════════════════════════════════════════════════════════════════
        // INVARIANT: SIM STATE COHERENT
        // ═══════════════════════════════════════════════════════════════════
        if (DEBUG_GL && tSync0 - _lastGLAssertTime > 1000) {
            let simCount = 0;
            for (const c of activeCells) simCount += cellParticles[c].length;
            if (simCount !== _activeParticleCount) {
                throw new Error(`SIM DESYNC: cells=${simCount}, flat=${_activeParticleCount}`);
            }
            const cullPct = ((1 - _glParticleCount / _activeParticleCount) * 100).toFixed(1);
            if (_glParticleCount < _activeParticleCount * 0.5) {
                log(`[CULL] GPU: ${_glParticleCount}/${_activeParticleCount} particles (${cullPct}% culled)`);
            }
            _lastGLAssertTime = tSync0;
        }

        const pointSize = Math.max(2, camera.zoom * 6 * (_darkMode ? 1 : 2));

        // Draw all particles
        _webglRenderer.updatePositions(_glPositions, _glParticleCount);
        _webglRenderer.updateColors(_glColors, _glParticleCount);
        _webglRenderer.draw(camera, pointSize);
    } else if (!_hideParticles && _flowRenderMode !== 'ROAD_HEATMAP') {
        throw new Error('[OVERLAY] WebGL renderer not available - call setWebGLRenderer() before draw()');
    }
    _drawSubTiming.particles += (performance.now() - tParticles0);

    // Draw stop sign at sink when bridge is blocked
    drawStopSign(ctx, camera);

    // Draw metrics HUD
    const tHud0 = performance.now();
    drawMetricsPanel(ctx);

    // Draw stall mode legend when active
    if (_particleColorMode === 1) {
        drawStallModeLegend(ctx);
    }
    // Draw source labels when in SOURCE mode
    if (_particleColorMode === 2) {
        drawSourceLabels(ctx, camera);
    }

    // Draw PHARR infrastructure polygon when enabled
    drawPharrInfraPolygon(ctx, camera);

    _drawSubTiming.hud += (performance.now() - tHud0);

    _drawSubTiming.frameCount++;

    // Log every 2 seconds
    const now = performance.now();
    if (now - _drawSubTiming.lastLogTime > 2000 && _drawSubTiming.frameCount > 0) {
        const n = _drawSubTiming.frameCount;
        log(`[OVERLAY BREAKDOWN] darkBg=${(_drawSubTiming.darkBg/n).toFixed(2)}ms roads=${(_drawSubTiming.roads/n).toFixed(2)}ms lots=${(_drawSubTiming.lots/n).toFixed(2)}ms particles=${(_drawSubTiming.particles/n).toFixed(2)}ms hud=${(_drawSubTiming.hud/n).toFixed(2)}ms`);
        _drawSubTiming.darkBg = 0;
        _drawSubTiming.roads = 0;
        _drawSubTiming.lots = 0;
        _drawSubTiming.particles = 0;
        _drawSubTiming.hud = 0;
        _drawSubTiming.frameCount = 0;
        _drawSubTiming.lastLogTime = now;
    }
}

export function getState() {
    return state;
}

export function setState(newState) {
    state = newState;
}

// ═══════════════════════════════════════════════════════════════════════════════
// K-TENSOR BUILDING — Stamp roads onto grid
// ═══════════════════════════════════════════════════════════════════════════════

function bakeKTensor(geometry) {
    if (!geometry?.roadSegments) {
        console.error('[BAKE] No road segments');
        return;
    }

    // Off-road = 0, on-road = 1
    Kxx.fill(0);
    Kyy.fill(0);

    let cellsStamped = 0;

    for (const seg of geometry.roadSegments) {
        // Check if segment is in ROI
        const inROI = seg.points?.some(p =>
            Math.abs(p.x - roi.centerX) < roi.sizeM &&
            Math.abs(p.y - roi.centerY) < roi.sizeM
        );
        if (!inROI) continue;

        // Stamp each segment
        for (let i = 0; i < seg.points.length - 1; i++) {
            const p1 = seg.points[i];
            const p2 = seg.points[i + 1];

            const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            if (len < 0.001) continue;

            const steps = Math.ceil(len / roi.cellSize * 2);
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const fx = worldToFieldX(p1.x + (p2.x - p1.x) * t);
                const fy = worldToFieldY(p1.y + (p2.y - p1.y) * t);

                // Stamp 3x3 kernel (1-cell road width)
                for (let ry = -1; ry <= 1; ry++) {
                    for (let rx = -1; rx <= 1; rx++) {
                        const cx = Math.floor(fx + rx);
                        const cy = Math.floor(fy + ry);
                        if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;

                        const idx = cy * N + cx;
                        if (Kxx[idx] < 1) cellsStamped++;
                        Kxx[idx] = 1;
                        Kyy[idx] = 1;
                    }
                }
            }
        }
    }

    log(`[BAKE] Stamped ${cellsStamped} road cells`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TWIN SPAN ROAD STAMPING — Physical separation for parallel bridge
// ═══════════════════════════════════════════════════════════════════════════════

// Twin span polyline (world meters, relative to PHARR origin)
// Approach start -> junction -> bridge end
const TWIN_SPAN_POLYLINE = [
    { x: -363.6711606637666, y: -2694.9719926976927 },   // approach start (south)
    { x: -481.6711606637666, y: -2583.9719926976927 },   // junction
    { x: 236.39229354591248, y: 2212.2113236596624 }     // bridge end (north)
];

/**
 * Stamp twin span road cells onto the grid.
 * Creates physical road cells for twin span routing (separate from main approach).
 * Call when twin span activates, unstamp when it deactivates.
 */
function stampTwinSpanRoad() {
    if (_twinSpanCellIndices.length > 0) {
        // Already stamped
        return;
    }

    let cellsStamped = 0;

    // Stamp each segment of the polyline
    for (let i = 0; i < TWIN_SPAN_POLYLINE.length - 1; i++) {
        const p1 = TWIN_SPAN_POLYLINE[i];
        const p2 = TWIN_SPAN_POLYLINE[i + 1];

        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (len < 0.001) continue;

        const steps = Math.ceil(len / roi.cellSize * 2);
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const fx = worldToFieldX(p1.x + (p2.x - p1.x) * t);
            const fy = worldToFieldY(p1.y + (p2.y - p1.y) * t);

            // Stamp 3x3 kernel (1-cell road width) - same as bakeKTensor
            for (let ry = -1; ry <= 1; ry++) {
                for (let rx = -1; rx <= 1; rx++) {
                    const cx = Math.floor(fx + rx);
                    const cy = Math.floor(fy + ry);
                    if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;

                    const idx = cy * N + cx;
                    // Only stamp if not already a road (avoid double-counting)
                    if (Kxx[idx] < 1) {
                        Kxx[idx] = 1;
                        Kyy[idx] = 1;
                        regionMap[idx] = REGION.ROAD;  // Mark as road for heatmap/routing
                        roadCellIndices.push(idx);     // Add to sparse road list
                        _twinSpanCellIndices.push(idx);
                        // Add to bridge approach cache (so twin span cells get SINK_CAP_MULT)
                        if (_bridgeApproachCache) {
                            _bridgeApproachCache[idx] = 1;
                        }
                        cellsStamped++;
                    }
                }
            }
        }
    }

    log(`[TWIN_SPAN] Stamped ${cellsStamped} road cells`);
}

/**
 * Unstamp twin span road cells (revert to non-road).
 * Call when twin span deactivates.
 */
function unstampTwinSpanRoad() {
    if (_twinSpanCellIndices.length === 0) {
        return;
    }

    for (const idx of _twinSpanCellIndices) {
        // Only unstamp if this was a twin-span-only cell (not part of main road network)
        // We track which cells we stamped, so just revert those
        Kxx[idx] = 0;
        Kyy[idx] = 0;
        regionMap[idx] = REGION.OFFROAD;  // Revert to non-road
        // Remove from bridge approach cache
        if (_bridgeApproachCache) {
            _bridgeApproachCache[idx] = 0;
        }
    }
    // Note: cells remain in roadCellIndices but won't render (Kxx=0)

    log(`[TWIN_SPAN] Unstamped ${_twinSpanCellIndices.length} road cells`);
    _twinSpanCellIndices = [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUTER FRICTION FIELD — Spatial initialization
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * COMMUTER CAPACITY THEFT ZONES
 *
 * These polylines define where commuter traffic steals road capacity from freight.
 * Rasterize into baseCommuterWeight (max-merge), time-modulate into commuterLoad,
 * fold into rho_eff, and let existing congestion/stall logic react.
 *
 * Types:
 *   - commuter_arterial (weight 1.0): Major E-W and N-S commuter spines
 *   - industrial_approach (weight 0.7): Shift-critical industrial park feeds
 *   - aduana (weight 0.4): Border/customs approach - constant low pressure
 *
 * NO cars, NO buses, NO new particles. This is capacity theft, not traffic simulation.
 */
const COMMUTER_POLYLINES = [
    {
        type: 'industrial_approach',
        weight: 1.0,
        name: 'PIR_COLONIAL_SPINE',
        polylines: [
            [
                [-214.49423692434993, -7500.193165803793],
                [-214.49423692434993, -6204.256763733247],
                [-324.0099892120017, -5751.591654277619],
            ],
        ],
    },
    {
        type: 'industrial_approach',
        weight: 0.6,
        name: 'REX-RBR',
        polylines: [
            [
                [-294.7045281296, -5749.520168684549],
                [2999.6942131163346, -6601.03964126846],
            ],
        ],
    },
    {
        type: 'aduana',
        weight: 0.9,
        name: 'ADUANA_APPROACH',
        polylines: [
            [
                [-335.775121533232, -4271.348689457563],
                [-417.0257555042095, -3875.9289374654722],
                [-509.10980733798397, -3422.730956871798],
                [-510.9153769817835, -3346.8970318322185],
                [-460.35942695539745, -3036.3390530987044],
                [-391.74778049101644, -2906.3380387451407],
            ],
        ],
    },
    {
        type: 'industrial_approach',
        weight: 0.8,
        name: 'VILLAFLORIDA',
        polylines: [
            [
                [-18471.80685735676, -2188.2584241885993],
                [-16524.762802685364, -1361.195462912253],
                [-15887.23510336818, -1748.8812260105403],
                [-15590.009351659493, -1891.0326724799124],
            ],
        ],
    },
    {
        type: 'commuter_arterial',
        weight: 1.0,
        name: 'SAN_FERNANDO_ARTERY',
        polylines: [
            [
                [-7366.374550970289, -3970.4150578068948],
                [-7345.63073495644, -3826.804023864861],
                [-7269.038183520689, -3762.9768976684018],
                [-7245.103011197017, -3691.171380697385],
                [-7292.973355844361, -3590.6436569379616],
                [-7299.356068464007, -3515.646783657122],
                [-7261.059792746131, -3354.483290011062],
                [-7249.890045661751, -3273.103704110576],
                [-7186.062919465291, -3265.1253133360187],
                [-7069.578414156753, -3320.9740487579206],
            ],
        ],
    },
    {
        type: 'commuter_arterial',
        weight: 0.7,
        name: 'PORFIRIO_DIAZ',
        polylines: [
            [
                [-4613.0306114751775, -4521.432135977184],
                [-2814.5068624856867, -4989.726998921617],
                [-473.0325477635197, -5648.0545598724875],
            ],
        ],
    },
    {
        type: 'urban_arterial',
        weight: 0.7,
        name: 'ENTRADA_MTY',
        polylines: [
            [
                [-37945.192676822146, -10833.036383865958],
                [-8663.937237237742, 2123.9191481501402],
            ],
        ],
    },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SPEED LIMIT ZONES — Road classification determines max speed (not friction)
// ═══════════════════════════════════════════════════════════════════════════════
const SPEED_LIMIT_POLYLINES = [
    {
        speedKph: 55,
        name: 'BLVD_LIBRAMIENTO',
        polylines: [
            [
                [-16574.487964270673, -1305.6248559919432],
                [-15663.974536014346, -1882.332109016965],
                [-8222.462782699557, -2696.002274209865],
                [-8025.920266903473, -2833.899039324859],
                [-7296.81093411155, -3228.5690912057044],
                [-4600.6914230701095, -4544.135930808523],
                [-1310.1893037743844, -5442.842434489004],
                [931.0293844164419, -6045.1501441866785],
                [3604.9586114163885, -6785.354618999349],
            ],
        ],
    },
    {
        speedKph: 100,
        name: 'LRSII_PONIENTE',
        polylines: [
            [
                [-6007.013894734803, -15181.327649239845],
                [-7299.582348194048, -15613.630907514353],
                [-7738.900174284277, -15643.199973757553],
                [-8096.33315750356, -15620.860412306349],
                [-13679.444947061722, -14726.545011459011],
                [-14011.146831257453, -14632.708294219428],
                [-14340.666466215054, -14475.586349074083],
                [-24174.208363900656, -7792.687776732117],
                [-25312.160153590215, -5179.150149862686],
            ],
        ],
    },
    {
        speedKph: 80,
        name: 'LRSII_ESTE',
        polylines: [
            [
                [-6368.473358043923, -15656.368140701457],
                [-6301.114177286924, -15442.473198297654],
                [-6168.759295799487, -15278.211336451637],
                [-5986.771333754261, -15176.581695309498],
                [-4934.735747801488, -14801.840246823089],
                [-4247.4223822055665, -14047.257913530544],
                [-4107.034971360443, -13968.289994930163],
                [-3992.181464068437, -13935.825215512823],
                [-3430.181464068437, -13885.825215512823],
                [-3097.181464068437, -13861.825215512823],
                [-2880.181464068437, -13836.825215512823],
                [-2740.181464068437, -13805.825215512823],
                [-2624.181464068437, -13765.825215512823],
                [-2447.5932287743194, -13688.001686101059],
                [-2232.5932287743194, -13568.001686101059],
                [-2105.5932287743194, -13510.001686101059],
                [-2025.5932287743194, -13494.001686101059],
                [-1580.818552802236, -13285.33128553804],
                [-1436.818552802236, -13205.33128553804],
                [-1298.818552802236, -13082.33128553804],
                [2701.563588760961, -8238.34914153981],
                [2807.563588760961, -8080.34914153981],
                [3145.563588760961, -7258.34914153981],
            ],
        ],
    },
    {
        speedKph: 110,
        name: 'ENTRADA_SANFERNANDO',
        polylines: [
            [
                [-5313.633075342698, -27903.379680195907],
                [-6409.465627335332, -15286.63804459721],
            ],
        ],
    },
    {
        speedKph: 55,
        name: 'REYNOSA_SANFERNANDO',
        polylines: [
            [
                [-6414.56121856187, -15274.666116411796],
                [-7355.329811062372, -4148.605235697094],
                [-7265.419170352707, -3344.6983305283306],
            ],
        ],
    },
    {
        speedKph: 60,
        name: '2D',
        polylines: [
            [
                [3156.928263876448, -7259.223566829529],
                [3329.928263876448, -7116.223566829529],
                [4100.928263876448, -6771.223566829529],
                [5990.236081950355, -5914.857394929713],
                [6214.236081950355, -5861.857394929713],
                [6406.236081950355, -5853.857394929713],
                [9768.246661723451, -5897.328711504852],
                [11627.841972782506, -5919.581117947901],
            ],
        ],
    },
    {
        speedKph: 100,
        name: 'AVE_PTE_PHARR',
        polylines: [
            [
                [-344.6282421308715, -13042.040588503369],
                [-549.9350614429121, -12139.653375770506],
                [-554.5252970950285, -10710.832667154451],
                [-538.5252970950285, -10483.832667154451],
                [-466.52529709502846, -10238.832667154451],
                [-168.63719050313227, -9461.650814745419],
                [-120.63719050313227, -9191.650814745419],
                [-124.16125407285438, -8202.671062174459],
                [-186.7697831430176, -7861.169994519023],
                [-214.74712221281024, -6522.50849375271],
                [-212.17383969920076, -6204.079288562246],
                [-302.17383969920076, -5929.079288562246],
                [-308.47102721409914, -5727.142442084996],
            ],
        ],
    },
    {
        speedKph: 60,
        name: 'LRSII_NORTE_60',
        polylines: [
            [
                [-16558.58956968774, -1340.766476624469],
                [-25277.560682617026, -5134.537879489104],
            ],
        ],
    },
    {
        speedKph: 100,
        name: 'LRSII_NORTE_100',
        polylines: [
            [
                [-25277.560682617026, -5134.537879489104],
                [-39213.000266958436, -11141.148604974645],
            ],
        ],
    },
    {
        speedKph: 25,
        name: 'ENTRADA_PUENTE',
        polylines: [
            [
                [-301.47102721409914, -5688.142442084996],
                [-330.15914851380217, -4290.670112505478],
                [-464.58723897602334, -3567.648156670087],
                [-508.58723897602334, -3346.648156670087],
                [-465.58723897602334, -3036.648156670087],
                [-414.58723897602334, -2954.648156670087],
                [-386.58723897602334, -2818.648156670087],
                [-365.58723897602334, -2696.648156670087],
                [-379.4315421967008, -2631.832858514562],
                [-387.58723897602334, -2596.648156670087],
                [333.60928610387634, 2195.2086653000115],
            ],
        ],
    },
];

const SPEED_LIMIT_BUFFER_M = 60;  // Buffer radius for speed limit zones

function stampSpeedLimits() {
    speedLimitMS.fill(0);  // 0 = use default

    const bufferCells = Math.ceil(SPEED_LIMIT_BUFFER_M / roi.cellSize);

    for (const zone of SPEED_LIMIT_POLYLINES) {
        const speedMS = zone.speedKph / 3.6;
        let stamped = 0;

        for (const polyline of zone.polylines) {
            if (polyline.length < 2) continue;

            for (let i = 0; i < polyline.length - 1; i++) {
                const [x1, y1] = polyline[i];
                const [x2, y2] = polyline[i + 1];
                const len = Math.hypot(x2 - x1, y2 - y1);
                if (len < 0.001) continue;

                const steps = Math.ceil(len / roi.cellSize * 2);
                for (let s = 0; s <= steps; s++) {
                    const t = s / steps;
                    const wx = x1 + (x2 - x1) * t;
                    const wy = y1 + (y2 - y1) * t;
                    const fx = worldToFieldX(wx);
                    const fy = worldToFieldY(wy);
                    const centerX = Math.floor(fx);
                    const centerY = Math.floor(fy);

                    for (let dy = -bufferCells; dy <= bufferCells; dy++) {
                        for (let dx = -bufferCells; dx <= bufferCells; dx++) {
                            const cx = centerX + dx;
                            const cy = centerY + dy;
                            if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;

                            const distM = Math.sqrt(dx * dx + dy * dy) * roi.cellSize;
                            if (distM > SPEED_LIMIT_BUFFER_M) continue;

                            const idx = cy * N + cx;
                            // Max-merge: highest speed limit wins
                            if (speedLimitMS[idx] < speedMS) {
                                if (speedLimitMS[idx] === 0) stamped++;
                                speedLimitMS[idx] = speedMS;
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Explicit intersection points (world coords).
 * Each gets stamped with a 75m radius.
 */
const INTERSECTION_POINTS = [
    { x: -288.55119353020353, y: -5711.657348025975 },
    { x: -218.11852623957964, y: -6523.704570906109 },
    { x: -226.40472239141775, y: -7016.733241940477 },
    { x: -205.68923201182247, y: -7480.760226443411 },
    { x: 1961.1510616938422, y: -6324.835863261995 },
    { x: 2876.7757364719528, y: -6569.278649741219 },
    { x: 3013.4979729772817, y: -6606.56653242449 },
    { x: -1303.6102221303713, y: -5409.211188483885 },
    { x: -1332.6119086618048, y: -5475.50075769859 },
    { x: -5931.74033199413, y: -3856.344878610892 },
    { x: -5663.804292899273, y: -3981.613676109787 },
    { x: -5315.8354109578995, y: -4134.719984163991 },
    { x: -8147.731542817304, y: -2707.214527676298 },
    { x: -9507.593650139586, y: -2540.564759622097 },
];

const INTERSECTION_RADIUS_M = 75;

/**
 * Stamp intersection cells from explicit INTERSECTION_POINTS.
 * Each point gets a 75m radius circle stamped.
 */
function detectIntersections() {
    isIntersection.fill(0);
    let intersectionCount = 0;

    const radiusCells = Math.ceil(INTERSECTION_RADIUS_M / roi.cellSize);

    for (const pt of INTERSECTION_POINTS) {
        const fx = Math.floor(worldToFieldX(pt.x));
        const fy = Math.floor(worldToFieldY(pt.y));

        // Stamp circular region
        for (let dy = -radiusCells; dy <= radiusCells; dy++) {
            for (let dx = -radiusCells; dx <= radiusCells; dx++) {
                const cx = fx + dx;
                const cy = fy + dy;
                if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;

                // Check if within radius
                const distM = Math.sqrt(dx * dx + dy * dy) * roi.cellSize;
                if (distM > INTERSECTION_RADIUS_M) continue;

                const idx = cy * N + cx;
                if (!isIntersection[idx]) {
                    isIntersection[idx] = 1;
                    intersectionCount++;
                }
            }
        }
    }

    log(`[COMMUTER] Stamped ${intersectionCount} intersection cells from ${INTERSECTION_POINTS.length} points`);
}

/**
 * Stamp baseCommuterWeight from explicit COMMUTER_POLYLINES.
 * Rasterizes polylines onto road cells with max-merge (never sum).
 * Each point stamps a 50m buffer to cover road width.
 * This is capacity theft, not traffic simulation.
 */
const COMMUTER_ROAD_BUFFER_M = 50;

// Sparse index: only cells with non-zero commuter weight (optimization for updateCommuterLoad)
let _commuterCellIndices = [];

function stampCommuterWeights() {
    baseCommuterWeight.fill(0);
    commuterType.fill(0);
    _commuterCellIndices = [];  // Reset sparse index

    log(`[COMMUTER] ROI: center=(${roi.centerX.toFixed(0)}, ${roi.centerY.toFixed(0)}), size=${roi.sizeM}m, cellSize=${roi.cellSize.toFixed(1)}m`);

    const bufferCells = Math.ceil(COMMUTER_ROAD_BUFFER_M / roi.cellSize);
    let arterialCells = 0;
    let approachCells = 0;

    for (const zone of COMMUTER_POLYLINES) {
        const weight = zone.weight;
        // Convert type string to numeric constant
        let typeCode = CTYPE_NONE;
        if (zone.type === 'commuter_arterial') typeCode = CTYPE_ARTERIAL;
        else if (zone.type === 'industrial_approach') typeCode = CTYPE_INDUSTRIAL;
        else if (zone.type === 'aduana') typeCode = CTYPE_ADUANA;
        else if (zone.type === 'urban_arterial') typeCode = CTYPE_URBAN;

        let zoneStamped = 0;

        for (const polyline of zone.polylines) {
            if (polyline.length < 2) continue;

            // Debug first point
            const [firstX, firstY] = polyline[0];
            const firstFx = worldToFieldX(firstX);
            const firstFy = worldToFieldY(firstY);
            log(`[COMMUTER] ${zone.name} first point: world=(${firstX.toFixed(0)}, ${firstY.toFixed(0)}) -> field=(${firstFx.toFixed(1)}, ${firstFy.toFixed(1)})`);

            for (let i = 0; i < polyline.length - 1; i++) {
                const [x1, y1] = polyline[i];
                const [x2, y2] = polyline[i + 1];
                const len = Math.hypot(x2 - x1, y2 - y1);
                if (len < 0.001) continue;

                const steps = Math.ceil(len / roi.cellSize * 2);
                for (let s = 0; s <= steps; s++) {
                    const t = s / steps;
                    const wx = x1 + (x2 - x1) * t;
                    const wy = y1 + (y2 - y1) * t;
                    const fx = worldToFieldX(wx);
                    const fy = worldToFieldY(wy);
                    const centerX = Math.floor(fx);
                    const centerY = Math.floor(fy);

                    // Stamp buffer radius around centerline point
                    for (let dy = -bufferCells; dy <= bufferCells; dy++) {
                        for (let dx = -bufferCells; dx <= bufferCells; dx++) {
                            const cx = centerX + dx;
                            const cy = centerY + dy;
                            if (cx < 0 || cx >= N || cy < 0 || cy >= N) continue;

                            // Check if within buffer radius
                            const distM = Math.sqrt(dx * dx + dy * dy) * roi.cellSize;
                            if (distM > COMMUTER_ROAD_BUFFER_M) continue;

                            const idx = cy * N + cx;

                            // Max-merge: never sum weights
                            if (baseCommuterWeight[idx] < weight) {
                                if (baseCommuterWeight[idx] === 0) {
                                    // New cell - count it and add to sparse index
                                    _commuterCellIndices.push(idx);
                                    if (weight >= 1.0) arterialCells++;
                                    else approachCells++;
                                    zoneStamped++;
                                }
                                baseCommuterWeight[idx] = weight;
                                commuterType[idx] = typeCode;
                            }
                        }
                    }
                }
            }
        }

        log(`[COMMUTER] ${zone.name}: weight=${weight}, stamped=${zoneStamped}`);
    }

    log(`[COMMUTER] TOTAL: ${arterialCells} arterial, ${approachCells} approach (${_commuterCellIndices.length} cells vs ${N2} grid)`);

    // Detect intersections after stamping road weights
    detectIntersections();
}

/**
 * Update commuterLoad array based on current hour and spatial weights.
 * Called at start of each step().
 */
let _commuterLastHour = -1;  // Cache: only recompute when hour changes

function updateCommuterLoad() {
    const currentHour = Math.floor(simTime / 3600) % 24;

    // OPTIMIZATION: Only recompute when hour changes
    if (currentHour === _commuterLastHour) return;
    _commuterLastHour = currentHour;

    const artMult = arterialMultiplier(currentHour);
    const appMult = approachMultiplier(currentHour);
    const aduMult = aduanaMultiplier(currentHour);
    const urbMult = urbanMultiplier(currentHour);

    // OPTIMIZATION: Sparse iteration — only cells with non-zero weight
    // Reduces from 65k iterations to ~2-5k (the actual commuter polyline cells)
    for (const i of _commuterCellIndices) {
        const w = baseCommuterWeight[i];
        const ctype = commuterType[i];
        let mult;
        if (ctype === CTYPE_ARTERIAL) {
            mult = artMult;
        } else if (ctype === CTYPE_INDUSTRIAL) {
            mult = appMult;
        } else if (ctype === CTYPE_ADUANA) {
            mult = aduMult;
        } else if (ctype === CTYPE_URBAN) {
            mult = urbMult;
        } else {
            mult = appMult;  // Default fallback
        }
        commuterLoad[i] = w * mult;
    }

    // Update visual cache for drawCommuterPressure
    updateCommuterPressureCache();
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOT LOADING — Convert polygons to grid
// ═══════════════════════════════════════════════════════════════════════════════

const LOT_KG_PER_M2 = 75.0;   // Capacity density
const INOVUS_FASE1_CAPACITY_KG = 1_188_000;  // 132 trucks @ 9000 kg each (sleep lot)
const INOVUS_FASE2_CAPACITY_KG = 6_822_000;  // 758 trucks @ 9000 kg each

// Inovus capacity multiplier — set BEFORE togglePhasesAsLots() to take effect
let _inovusCapacityMult = 1.0;

async function loadAndStampLots(lotsJsonPath) {
    try {
        // Use lotsLoader to get properly processed lots
        const { lots } = await loadLots(lotsJsonPath, roi, N);

        // Store for rendering
        _loadedLots = lots;

        log(`[LOTS] Loaded ${lots.length} lots`);

        // ─────────────────────────────────────────────────────────────────────
        // BUILD INDUSTRIAL PARK INJECTION POINTS (35.3% of flow)
        // ─────────────────────────────────────────────────────────────────────
        const industrialParks = getIndustrialParksWithArea(lots);
        if (industrialParks.length > 0) {
            const totalAreaM2 = industrialParks.reduce((sum, p) => sum + p.areaM2, 0);
            log(`[LOTS] Industrial parks: ${industrialParks.length} parks, ${(totalAreaM2 / 1e6).toFixed(2)} km² total`);

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
            log(`[LOTS] Zone assignment: ${parksWithZone.length - unzoned} in zones, ${unzoned} unzoned`);
            for (const zone of INDUSTRIAL_ZONES) {
                const parksInZone = parksWithZone.filter(p => p.zone === zone.id);
                log(`  ${zone.id}: ${parksInZone.length} parks, ${(zoneAreaM2[zone.id] / 1e6).toFixed(3)} km², ${(zone.share * 100).toFixed(0)}% share`);
            }

            // Build injection points with zone-based ratios
            _industrialParkInjectionPoints = parksWithZone
                .filter(p => p.zone !== null)
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
                        zoneRatio: park.areaM2 / zoneTotalM2,
                    };
                });

            log(`[LOTS] Industrial park injection: ${_industrialParkInjectionPoints.length} zoned points, ${(REYNOSA_LOCAL_RATIO * 100).toFixed(1)}% of total flow`);
        }

        // ─────────────────────────────────────────────────────────────────────
        // STAMP CONVERSION LOTS (layer='lots')
        // ─────────────────────────────────────────────────────────────────────
        const conversionLots = lots.filter(lot => lot.layer === 'lots');
        log(`[LOTS] Conversion lots: ${conversionLots.length} (layer=lots)`);

        const cellAreaM2 = roi.cellSize * roi.cellSize;

        cellToLotIndex.fill(-1);
        lotToCellIndices = [];
        lotCellIndices = [];  // Reset - was accumulating across runs
        const capacities = [];
        const masses = [];

        for (let lotIdx = 0; lotIdx < conversionLots.length; lotIdx++) {
            const lot = conversionLots[lotIdx];
            const cells = [];

            // Rasterize polygon(s) to grid cells
            for (const poly of (lot.polygons || [])) {
                if (!poly.worldCoords || poly.worldCoords.length < 3) continue;

                // Bounding box
                let minX = Infinity, maxX = -Infinity;
                let minY = Infinity, maxY = -Infinity;
                for (const pt of poly.worldCoords) {
                    minX = Math.min(minX, pt.x);
                    maxX = Math.max(maxX, pt.x);
                    minY = Math.min(minY, pt.y);
                    maxY = Math.max(maxY, pt.y);
                }

                // Scan grid cells in bbox
                const fx0 = Math.floor(worldToFieldX(minX));
                const fx1 = Math.ceil(worldToFieldX(maxX));
                const fy0 = Math.floor(worldToFieldY(minY));
                const fy1 = Math.ceil(worldToFieldY(maxY));

                for (let fy = fy0; fy <= fy1; fy++) {
                    for (let fx = fx0; fx <= fx1; fx++) {
                        if (fx < 0 || fx >= N || fy < 0 || fy >= N) continue;

                        const wx = fieldToWorldX(fx + 0.5);
                        const wy = fieldToWorldY(fy + 0.5);

                        // Point-in-polygon test using {x,y} format
                        if (pointInZonePolygon(wx, wy, poly.worldCoords)) {
                            const idx = fy * N + fx;
                            if (cellToLotIndex[idx] < 0) {  // Only if not already claimed
                                cells.push(idx);
                                cellToLotIndex[idx] = lotIdx;
                                regionMap[idx] = REGION.LOT;
                                Kxx[idx] = Math.max(Kxx[idx], 0.4);
                                Kyy[idx] = Math.max(Kyy[idx], 0.4);
                            }
                        }
                    }
                }
            }

            lotToCellIndices.push(cells);
            lotCellIndices.push(...cells);

            const area = cells.length * cellAreaM2;
            capacities.push(area * LOT_KG_PER_M2);
            masses.push(0);
        }

        lotCapacity = new Float32Array(capacities);
        lotMass = new Float32Array(masses);
        lotCooldownEndSimS = new Float64Array(capacities.length);
        lotDraining.clear();

        log(`[LOTS] Stamped ${conversionLots.length} lots, ${lotCellIndices.length} cells`);

        // ─────────────────────────────────────────────────────────────────────
        // STAMP PARK WAITING ZONES (layer='parkWaiting')
        // ─────────────────────────────────────────────────────────────────────
        const parkZones = lots.filter(lot => lot.layer === 'parkWaiting');
        log(`[PARKS] Park waiting zones: ${parkZones.length} (layer=parkWaiting)`);

        if (parkZones.length > 0) {
            cellToParkIndex.fill(-1);
            parkToCellIndices = [];
            parkCellIndices = [];
            const parkCaps = [];
            const parkMasses = [];

            for (let parkIdx = 0; parkIdx < parkZones.length; parkIdx++) {
                const park = parkZones[parkIdx];
                const cells = [];

                // Rasterize polygon(s) to grid cells
                for (const poly of (park.polygons || [])) {
                    if (!poly.worldCoords || poly.worldCoords.length < 3) continue;

                    // Bounding box
                    let minX = Infinity, maxX = -Infinity;
                    let minY = Infinity, maxY = -Infinity;
                    for (const pt of poly.worldCoords) {
                        minX = Math.min(minX, pt.x);
                        maxX = Math.max(maxX, pt.x);
                        minY = Math.min(minY, pt.y);
                        maxY = Math.max(maxY, pt.y);
                    }

                    // Scan grid cells in bbox
                    const fx0 = Math.floor(worldToFieldX(minX));
                    const fx1 = Math.ceil(worldToFieldX(maxX));
                    const fy0 = Math.floor(worldToFieldY(minY));
                    const fy1 = Math.ceil(worldToFieldY(maxY));

                    for (let fy = fy0; fy <= fy1; fy++) {
                        for (let fx = fx0; fx <= fx1; fx++) {
                            if (fx < 0 || fx >= N || fy < 0 || fy >= N) continue;

                            const wx = fieldToWorldX(fx + 0.5);
                            const wy = fieldToWorldY(fy + 0.5);

                            // Point-in-polygon test
                            if (pointInZonePolygon(wx, wy, poly.worldCoords)) {
                                const idx = fy * N + fx;
                                // Only claim cells that are not already lot or sink
                                if (cellToParkIndex[idx] < 0 && regionMap[idx] !== REGION.LOT && regionMap[idx] !== REGION.SINK) {
                                    cells.push(idx);
                                    cellToParkIndex[idx] = parkIdx;
                                    regionMap[idx] = REGION.PARK;
                                    // Parks are traversable
                                    Kxx[idx] = Math.max(Kxx[idx], 0.5);
                                    Kyy[idx] = Math.max(Kyy[idx], 0.5);
                                }
                            }
                        }
                    }
                }

                parkToCellIndices.push(cells);
                parkCellIndices.push(...cells);

                const area = cells.length * cellAreaM2;
                parkCaps.push(area * PARK_KG_PER_M2);
                parkMasses.push(0);
            }

            parkCapacity = new Float32Array(parkCaps);
            parkMass = new Float32Array(parkMasses);

            log(`[PARKS] Stamped ${parkZones.length} parks, ${parkCellIndices.length} cells`);
        }

        // ─────────────────────────────────────────────────────────────────────
        // STAMP INDUSTRIAL PARKS (layer='industrialParks')
        // Merged with regular parks - use same storage system
        // ─────────────────────────────────────────────────────────────────────
        const industrialParkZones = lots.filter(lot => lot.layer === 'industrialParks');
        log(`[INDUSTRIAL] Industrial park zones: ${industrialParkZones.length} (layer=industrialParks)`);

        if (industrialParkZones.length > 0) {
            cellToIndustrialParkIndex.fill(-1);
            industrialParkToCellIndices = [];
            industrialParkCellIndices = [];

            // Get current park count to use as starting index
            const parkStartIdx = parkToCellIndices.length;

            for (let indIdx = 0; indIdx < industrialParkZones.length; indIdx++) {
                const indPark = industrialParkZones[indIdx];
                const cells = [];

                // Rasterize polygon(s) to grid cells
                for (const poly of (indPark.polygons || [])) {
                    if (!poly.worldCoords || poly.worldCoords.length < 3) continue;

                    // Bounding box
                    let minX = Infinity, maxX = -Infinity;
                    let minY = Infinity, maxY = -Infinity;
                    for (const pt of poly.worldCoords) {
                        minX = Math.min(minX, pt.x);
                        maxX = Math.max(maxX, pt.x);
                        minY = Math.min(minY, pt.y);
                        maxY = Math.max(maxY, pt.y);
                    }

                    // Scan grid cells in bbox
                    const fx0 = Math.floor(worldToFieldX(minX));
                    const fx1 = Math.ceil(worldToFieldX(maxX));
                    const fy0 = Math.floor(worldToFieldY(minY));
                    const fy1 = Math.ceil(worldToFieldY(maxY));

                    for (let fy = fy0; fy <= fy1; fy++) {
                        for (let fx = fx0; fx <= fx1; fx++) {
                            if (fx < 0 || fx >= N || fy < 0 || fy >= N) continue;

                            const wx = fieldToWorldX(fx + 0.5);
                            const wy = fieldToWorldY(fy + 0.5);

                            // Point-in-polygon test
                            if (pointInZonePolygon(wx, wy, poly.worldCoords)) {
                                const idx = fy * N + fx;
                                // Claim cells not already claimed by lot, park, or sink
                                if (cellToIndustrialParkIndex[idx] < 0 &&
                                    cellToParkIndex[idx] < 0 &&
                                    regionMap[idx] !== REGION.LOT &&
                                    regionMap[idx] !== REGION.SINK) {
                                    cells.push(idx);
                                    cellToIndustrialParkIndex[idx] = indIdx;
                                    // Add to regular park system
                                    const parkIdx = parkStartIdx + indIdx;
                                    cellToParkIndex[idx] = parkIdx;
                                    regionMap[idx] = REGION.PARK;
                                    // Parks are traversable
                                    Kxx[idx] = Math.max(Kxx[idx], 0.5);
                                    Kyy[idx] = Math.max(Kyy[idx], 0.5);
                                }
                            }
                        }
                    }
                }

                industrialParkToCellIndices.push(cells);
                industrialParkCellIndices.push(...cells);

                // Add to regular park arrays
                parkToCellIndices.push(cells);
                parkCellIndices.push(...cells);

                const area = cells.length * cellAreaM2;
                // Use regular park capacity density - append to existing arrays
                const newCapacity = area * PARK_KG_PER_M2;
                const currentCaps = Array.from(parkCapacity);
                const currentMasses = Array.from(parkMass);
                currentCaps.push(newCapacity);
                currentMasses.push(0);
                parkCapacity = new Float32Array(currentCaps);
                parkMass = new Float32Array(currentMasses);
            }

            log(`[INDUSTRIAL] Stamped ${industrialParkZones.length} industrial parks as parks, ${industrialParkCellIndices.length} cells`);
        }

    } catch (e) {
        console.error('[LOTS] Failed to load:', e);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HARDCODED LOOP ROUTING — Initialize loop cell sequence
// ═══════════════════════════════════════════════════════════════════════════════

const LOOP_CAPTURE_RADIUS_M = 50;   // Radius to capture particle onto loop
const LOOP_WAYPOINT_RADIUS_M = 30;  // Radius to advance to next waypoint

// Waypoints in world coords (populated from LOOP_WORLD_COORDS during init)
let _loopWaypoints = null;  // Array of {x, y} in world coords

/**
 * Initialize loop waypoints in world coordinates.
 * Particles track their own progress through the loop via p.loopTargetIdx.
 */
function initLoopSequence() {
    _loopWaypoints = LOOP_WORLD_COORDS.map(c => ({ x: c.x, y: c.y }));

    // LOOP_CELL_SEQUENCE for debug visualization (entry zone cells)
    LOOP_CELL_SEQUENCE = [];
    const radiusCells = Math.ceil(LOOP_CAPTURE_RADIUS_M / roi.cellSize);

    // Just mark entry zone for visualization
    const entryX = Math.floor(worldToFieldX(_loopWaypoints[0].x));
    const entryY = Math.floor(worldToFieldY(_loopWaypoints[0].y));
    for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        for (let dx = -radiusCells; dx <= radiusCells; dx++) {
            const fx = entryX + dx;
            const fy = entryY + dy;
            if (fx < 0 || fx >= N || fy < 0 || fy >= N) continue;
            if (dx * dx + dy * dy > radiusCells * radiusCells) continue;
            LOOP_CELL_SEQUENCE.push(fy * N + fx);
        }
    }

    // LOOP_NEXT_HOP not used anymore - routing is per-particle
    LOOP_NEXT_HOP = null;

    log(`[LOOP] Initialized ${_loopWaypoints.length} waypoints, capture=${LOOP_CAPTURE_RADIUS_M}m, advance=${LOOP_WAYPOINT_RADIUS_M}m, enabled=${_loopRoutingEnabled}`);
}

/**
 * Get the next hop cell for a particle on the loop.
 * Returns cell index to move toward, or -1 if not on loop / exiting loop.
 */
function getLoopNextHop(p) {
    if (!_loopRoutingEnabled || !_loopWaypoints || _loopWaypoints.length < 2) return -1;

    // Check if particle should enter the loop (near entry point)
    if (p.loopTargetIdx === undefined || p.loopTargetIdx < 0) {
        const entry = _loopWaypoints[0];
        const dx = p.x - entry.x;
        const dy = p.y - entry.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < LOOP_CAPTURE_RADIUS_M) {
            p.loopTargetIdx = 1;  // Start heading to waypoint 1
        } else {
            return -1;  // Not on loop
        }
    }

    // Check if reached current target waypoint
    const target = _loopWaypoints[p.loopTargetIdx];
    const dx = p.x - target.x;
    const dy = p.y - target.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < LOOP_WAYPOINT_RADIUS_M) {
        p.loopTargetIdx++;
        if (p.loopTargetIdx >= _loopWaypoints.length) {
            // Exited the loop
            p.loopTargetIdx = -1;
            return -1;
        }
    }

    // Return cell index of current target waypoint
    if (p.loopTargetIdx >= 0 && p.loopTargetIdx < _loopWaypoints.length) {
        const wp = _loopWaypoints[p.loopTargetIdx];
        const fx = Math.floor(worldToFieldX(wp.x));
        const fy = Math.floor(worldToFieldY(wp.y));
        if (fx >= 0 && fx < N && fy >= 0 && fy < N) {
            return fy * N + fx;
        }
    }

    return -1;
}

/**
 * Enable/disable loop routing (for future condition-based control).
 */
export function setLoopRoutingEnabled(enabled) {
    _loopRoutingEnabled = enabled;
    log(`[LOOP] Routing ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

export function isLoopRoutingEnabled() {
    return _loopRoutingEnabled;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BRIDGING — Connect lots and injection points to road network
// ═══════════════════════════════════════════════════════════════════════════════

const K_CONNECTOR = 0.35;       // Connector conductance (slightly less than full road)
const K_ROAD_CHECK = 0.1;       // Threshold to consider cell a road
const CONNECTOR_RADIUS = 3;     // Connector path width in cells (7 cells = ~120m at 4800 grid)

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL CONNECTOR STAMPS — Fine-grained lot-to-road connections
// ─────────────────────────────────────────────────────────────────────────────

const MANUAL_CONNECTOR_COORDS = [
    { x: -6015.3899592982425, y: -3570.373171783605 },
    { x: -6012.799408533557, y: -3596.2786794304607 },
    { x: -6181.185208238117, y: -3565.192070254234 },
    { x: -6131.9647437090925, y: -3578.1448240776617 },
    { x: -6108.6497868269225, y: -3596.2786794304607 },
    { x: -6064.610423827267, y: -3598.869230195146 },
    { x: -6038.7049161804125, y: -3622.184187077316 },
    { x: -6023.161611592299, y: -3617.003085547945 },
    { x: -6173.413555944061, y: -3557.4204179601775 },
    // Lot access area (south)
    { x: -6307.13518837926, y: -10196.773038040405 },
    { x: -6321.367961540596, y: -10199.935876520702 },
    { x: -6770.49102574276, y: -10187.284522599513 },
    { x: -6810.026506746472, y: -10112.957818312536 },
    { x: -6680.350129054297, y: -10100.306464391348 },
    { x: -6359.32202330416, y: -10150.911880076099 },
    { x: -6319.786542300449, y: -10139.84194539506 },
    // Lot access area (north batch)
    { x: -6388.564111590598, y: -3542.1334463820644 },
    { x: -6387.211827900491, y: -3575.940538634768 },
    { x: -6387.211827900491, y: -3614.928731358103 },
    { x: -6385.859544210385, y: -3648.73582361081 },
    { x: -6412.960619700018, y: -3541.457304536995 },
    { x: -6411.608336009912, y: -3575.264396789699 },
    { x: -6411.608336009912, y: -3612.9001893760095 },
    { x: -6410.256052319806, y: -3645.3548815023097 },
    { x: -6339.4501761959835, y: -3543.485688619006 },
    { x: -6339.4501761959835, y: -3575.940538634768 },
    { x: -6338.097892505877, y: -3614.252589512034 },
    { x: -6338.097892505877, y: -3649.4120237107905 },
    { x: -6313.5872612808645, y: -3543.485688619006 },
    { x: -6312.234977590758, y: -3577.292780871709 },
    { x: -6312.234977590758, y: -3613.5763894120535 },
    { x: -6312.234977590758, y: -3649.4120237107905 },
    { x: -6287.724346365745, y: -3545.514072701017 },
    { x: -6287.724346365745, y: -3577.9689647273174 },
    { x: -6286.3720626756385, y: -3616.2810156046024 },
    { x: -6286.3720626756385, y: -3652.1166499033493 },
    { x: -6262.537573296695, y: -3545.514072701017 },
    { x: -6261.185289606588, y: -3580.6451648633186 },
    { x: -6261.185289606588, y: -3615.6048155046217 },
    { x: -6261.185289606588, y: -3654.145033985349 },
    { x: -6186.323541151776, y: -3547.542456783028 },
    { x: -6186.323541151776, y: -3578.6451647533384 },
    { x: -6186.323541151776, y: -3616.9572156306135 },
    { x: -6186.323541151776, y: -3654.8212499033504 },
    { x: -6137.346518776801, y: -3547.542456783028 },
    { x: -6137.346518776801, y: -3581.3495490357096 },
    { x: -6137.346518776801, y: -3618.3093995866695 },
    { x: -6137.346518776801, y: -3656.173433859406 },
    { x: -6088.357132386593, y: -3581.3496733952006 },
    // Additional lot access (x ≈ -6415, -6343 columns)
    { x: -6415.67996062541, y: -3582.526038416792 },
    { x: -6418.344322070956, y: -3603.8409299811574 },
    { x: -6386.371984724407, y: -3611.8340143177948 },
    { x: -6343.742201595676, y: -3614.4983757633404 },
    { x: -6343.742201595676, y: -3593.183484198975 },
    { x: -6383.464206224202, y: -3580.693804956002 },
    { x: -6351.009397661606, y: -3579.3415212658942 },
    // Northern connector
    { x: -13852.666111594648, y: 8543.94239316011 },
    { x: -13873.666111594648, y: 8547.94239316011 },
    { x: -13890.666111594648, y: 8547.94239316011 },
    // Industrial Connector A
    { x: 758.0004948412638, y: -5861.7000528288545 },
    { x: 759.0004948412638, y: -5884.7000528288545 },
    { x: 759.0004948412638, y: -5902.7000528288545 },
    { x: 756.0004948412638, y: -5921.7000528288545 },
    { x: 757.0004948412638, y: -5942.7000528288545 },
    { x: 757.0004948412638, y: -5954.7000528288545 },
    { x: 757.0004948412638, y: -5962.7000528288545 },
    { x: 742.0004948412638, y: -5958.7000528288545 },
    { x: 743.0004948412638, y: -5942.7000528288545 },
    { x: 743.0004948412638, y: -5929.7000528288545 },
    { x: 742.0004948412638, y: -5917.7000528288545 },
    { x: 742.0004948412638, y: -5909.7000528288545 },
    { x: 742.0004948412638, y: -5897.7000528288545 },
    { x: 742.0004948412638, y: -5893.7000528288545 },
    { x: 742.0004948412638, y: -5889.7000528288545 },
    { x: 742.0004948412638, y: -5881.7000528288545 },
    { x: 742.0004948412638, y: -5863.7000528288545 },
    { x: 742.0004948412638, y: -5853.7000528288545 },
    { x: 742.0004948412638, y: -5832.7000528288545 },
    { x: 742.0004948412638, y: -5829.7000528288545 },
    { x: 735.0004948412638, y: -5821.7000528288545 },
    { x: 731.0004948412638, y: -5820.7000528288545 },
    { x: 731.0004948412638, y: -5828.7000528288545 },
    { x: 731.0004948412638, y: -5837.7000528288545 },
    { x: 731.0004948412638, y: -5845.7000528288545 },
    { x: 731.0004948412638, y: -5849.7000528288545 },
    { x: 731.0004948412638, y: -5853.7000528288545 },
    { x: 729.0004948412638, y: -5853.7000528288545 },
    { x: 727.0004948412638, y: -5878.7000528288545 },
    { x: 727.0004948412638, y: -5881.7000528288545 },
    { x: 727.0004948412638, y: -5886.7000528288545 },
    { x: 725.0004948412638, y: -5894.7000528288545 },
    { x: 724.0004948412638, y: -5910.7000528288545 },
    { x: 724.0004948412638, y: -5926.7000528288545 },
    { x: 724.0004948412638, y: -5935.7000528288545 },
    { x: 732.0004948412638, y: -5862.7000528288545 },
    // Industrial Connector B
    { x: 491.00049484126384, y: -5875.7000528288545 },
    { x: 493.00049484126384, y: -5845.7000528288545 },
    { x: 493.00049484126384, y: -5834.7000528288545 },
    { x: 492.00049484126384, y: -5823.7000528288545 },
    { x: 973.0004948412638, y: -5989.7000528288545 },
    { x: 973.0004948412638, y: -6003.7000528288545 },
    { x: 976.0004948412638, y: -5971.7000528288545 },
    { x: 973.0004948412638, y: -5955.7000528288545 },
    { x: 973.0004948412638, y: -5939.7000528288545 },
    { x: 973.0004948412638, y: -5930.7000528288545 },
    { x: -194.99950515873616, y: -6010.7000528288545 },
    { x: -195.99950515873616, y: -6024.7000528288545 },
    { x: -182.99950515873616, y: -6004.7000528288545 },
    { x: -180.99950515873616, y: -6020.7000528288545 },
    { x: -162.99950515873616, y: -5920.7000528288545 },
    { x: -163.99950515873616, y: -5899.7000528288545 },
    { x: -163.99950515873616, y: -5879.7000528288545 },
    { x: -159.99950515873616, y: -5927.7000528288545 },
    { x: -156.99950515873616, y: -5946.7000528288545 },
    { x: -156.99950515873616, y: -5965.7000528288545 },
    { x: -159.99950515873616, y: -5979.7000528288545 },
    { x: -159.99950515873616, y: -5985.7000528288545 },
    { x: -159.99950515873616, y: -5997.7000528288545 },
    { x: -159.99950515873616, y: -6003.7000528288545 },
    { x: -159.99950515873616, y: -6010.7000528288545 },
    { x: -160.99950515873616, y: -6028.7000528288545 },
    // Industrial Connector C
    { x: 96.94388379755219, y: -5576.703357639915 },
    { x: 104.94388379755219, y: -5573.703357639915 },
    { x: 116.94388379755219, y: -5582.703357639915 },
    { x: 110.94388379755219, y: -5574.703357639915 },
    { x: 118.94388379755219, y: -5574.703357639915 },
    { x: 130.9438837975522, y: -5582.703357639915 },
    { x: 134.9438837975522, y: -5583.703357639915 },
    { x: 158.9438837975522, y: -5590.703357639915 },
    { x: 167.9438837975522, y: -5590.703357639915 },
    { x: 175.9438837975522, y: -5591.703357639915 },
    { x: 177.9438837975522, y: -5591.703357639915 },
    { x: 184.9438837975522, y: -5593.703357639915 },
    { x: 186.9438837975522, y: -5669.703357639915 },
    { x: 173.9438837975522, y: -5675.703357639915 },
    { x: 153.9438837975522, y: -5678.703357639915 },
    { x: 144.9438837975522, y: -5684.703357639915 },
    { x: 135.9438837975522, y: -5690.703357639915 },
    { x: 127.94388379755219, y: -5697.703357639915 },
    { x: 121.94388379755219, y: -5704.703357639915 },
    { x: 117.94388379755219, y: -5712.703357639915 },
    { x: 113.94388379755219, y: -5724.703357639915 },
    { x: 111.94388379755219, y: -5741.703357639915 },
    { x: 113.94388379755219, y: -5748.703357639915 },
    { x: 114.94388379755219, y: -5748.703357639915 },
    { x: 120.94388379755219, y: -5734.703357639915 },
    { x: 122.94388379755219, y: -5730.703357639915 },
    { x: 129.9438837975522, y: -5723.703357639915 },
    { x: 145.9438837975522, y: -5708.703357639915 },
    { x: 146.9438837975522, y: -5707.703357639915 },
    { x: 167.9438837975522, y: -5707.703357639915 },
    { x: 194.9438837975522, y: -5609.703357639915 },
    { x: 199.9438837975522, y: -5589.703357639915 },
    { x: 203.9438837975522, y: -5588.703357639915 },
    { x: 115.94388379755219, y: -5593.703357639915 },
    { x: 165.9438837975522, y: -5607.703357639915 },
    { x: 144.9438837975522, y: -5588.703357639915 },
    { x: 127.94388379755219, y: -5575.703357639915 },
    { x: 155.9438837975522, y: -5590.703357639915 },
    { x: 139.9438837975522, y: -5584.703357639915 },
    { x: 204.9438837975522, y: -5603.703357639915 },
    { x: 208.9438837975522, y: -5593.703357639915 },
    { x: 218.9438837975522, y: -5601.703357639915 },
    { x: 162.9438837975522, y: -5657.703357639915 },
    { x: 156.9438837975522, y: -5668.703357639915 },
    { x: 177.9438837975522, y: -5676.703357639915 },
    { x: 183.9438837975522, y: -5673.703357639915 },
    { x: 191.9438837975522, y: -5672.703357639915 },
    { x: 109.94388379755219, y: -5758.703357639915 },
    { x: 104.94388379755219, y: -5765.703357639915 },
    { x: 101.94388379755219, y: -5766.703357639915 },
    { x: 89.94388379755219, y: -5774.703357639915 },
    { x: 86.94388379755219, y: -5776.703357639915 },
    { x: 86.94388379755219, y: -5760.703357639915 },
    { x: 106.94388379755219, y: -5748.703357639915 },
    { x: 113.94388379755219, y: -5739.703357639915 },
    { x: 104.94388379755219, y: -5739.703357639915 },
    { x: 100.94388379755219, y: -5748.703357639915 },
    { x: 107.94388379755219, y: -5711.703357639915 },
    { x: 141.9438837975522, y: -5685.703357639915 },
    { x: 143.9438837975522, y: -5683.703357639915 },
    { x: 99.94388379755219, y: -5726.703357639915 },
    { x: 189.9438837975522, y: -5662.703357639915 },
    { x: 197.9438837975522, y: -5662.703357639915 },
    { x: 198.9438837975522, y: -5662.703357639915 },
    { x: 191.9438837975522, y: -5667.703357639915 },
    { x: 187.9438837975522, y: -5676.703357639915 },
    { x: 180.9438837975522, y: -5678.703357639915 },
    { x: 179.9438837975522, y: -5678.703357639915 },
    { x: 203.9438837975522, y: -5662.703357639915 },
    { x: 227.9438837975522, y: -5606.703357639915 },
    { x: 231.9438837975522, y: -5589.703357639915 },
    { x: 219.9438837975522, y: -5619.703357639915 },
    { x: 220.9438837975522, y: -5634.703357639915 },
    { x: 215.9438837975522, y: -5591.703357639915 },
    { x: 83.94388379755219, y: -5745.703357639915 },
    { x: 100.94388379755219, y: -5755.703357639915 },
    { x: 102.94388379755219, y: -5751.703357639915 },
    { x: 101.94388379755219, y: -5755.703357639915 },
    { x: 103.94388379755219, y: -5756.703357639915 },
    { x: 104.94388379755219, y: -5771.703357639915 },
    { x: 100.94388379755219, y: -5774.703357639915 },
    { x: 118.94388379755219, y: -5781.703357639915 },
    { x: 131.9438837975522, y: -5745.703357639915 },
    { x: 145.9438837975522, y: -5709.703357639915 },
    { x: 154.9438837975522, y: -5699.703357639915 },
    { x: 154.9438837975522, y: -5713.703357639915 },
    { x: 143.9438837975522, y: -5714.703357639915 },
    { x: 179.9438837975522, y: -5609.703357639915 },
    { x: 160.9438837975522, y: -5606.703357639915 },
    { x: 148.9438837975522, y: -5605.703357639915 },
    { x: 132.9438837975522, y: -5593.703357639915 },
    { x: 124.94388379755219, y: -5590.703357639915 },
    { x: 111.94388379755219, y: -5589.703357639915 },
    { x: 81.94388379755219, y: -5736.703357639915 },
    { x: 85.94388379755219, y: -5736.703357639915 },
    { x: 170.9438837975522, y: -5654.703357639915 },
    { x: 165.9438837975522, y: -5670.703357639915 },
    { x: 142.9438837975522, y: -5602.703357639915 },
    // Industrial Connector D
    { x: 70.72583207038076, y: -5766.260216475173 },
    { x: 70.72583207038076, y: -5781.260216475173 },
    { x: 76.72583207038076, y: -5777.260216475173 },
    { x: 82.72583207038076, y: -5771.260216475173 },
    { x: 82.72583207038076, y: -5759.260216475173 },
    { x: 82.72583207038076, y: -5755.260216475173 },
    { x: 82.72583207038076, y: -5754.260216475173 },
    { x: 78.72583207038076, y: -5754.260216475173 },
    // Connector area (x ≈ -40 to -58, y ≈ -5400 to -5743)
    { x: -44.878110113976106, y: -5400.068764630037 },
    { x: -44.878110113976106, y: -5408.068764630037 },
    { x: -42.878110113976106, y: -5412.068764630037 },
    { x: -42.878110113976106, y: -5415.068764630037 },
    { x: -42.878110113976106, y: -5422.068764630037 },
    { x: -42.878110113976106, y: -5427.068764630037 },
    { x: -42.878110113976106, y: -5435.068764630037 },
    { x: -41.878110113976106, y: -5448.068764630037 },
    { x: -41.878110113976106, y: -5458.068764630037 },
    { x: -41.878110113976106, y: -5467.068764630037 },
    { x: -41.878110113976106, y: -5484.068764630037 },
    { x: -41.878110113976106, y: -5489.068764630037 },
    { x: -41.878110113976106, y: -5501.068764630037 },
    { x: -44.878110113976106, y: -5743.068764630037 },
    { x: -44.878110113976106, y: -5733.068764630037 },
    { x: -44.878110113976106, y: -5723.068764630037 },
    { x: -44.878110113976106, y: -5721.068764630037 },
    { x: -44.878110113976106, y: -5718.068764630037 },
    { x: -44.878110113976106, y: -5703.068764630037 },
    { x: -44.878110113976106, y: -5703.068764630037 },
    { x: -42.878110113976106, y: -5692.068764630037 },
    { x: -42.878110113976106, y: -5690.068764630037 },
    { x: -42.878110113976106, y: -5688.068764630037 },
    { x: -42.878110113976106, y: -5684.068764630037 },
    { x: -42.878110113976106, y: -5682.068764630037 },
    { x: -42.878110113976106, y: -5677.068764630037 },
    { x: -42.878110113976106, y: -5671.068764630037 },
    { x: -42.878110113976106, y: -5667.068764630037 },
    { x: -42.878110113976106, y: -5662.068764630037 },
    { x: -42.878110113976106, y: -5658.068764630037 },
    { x: -42.878110113976106, y: -5654.068764630037 },
    { x: -42.878110113976106, y: -5651.068764630037 },
    { x: -42.878110113976106, y: -5651.068764630037 },
    { x: -42.878110113976106, y: -5643.068764630037 },
    { x: -42.878110113976106, y: -5633.068764630037 },
    { x: -42.878110113976106, y: -5629.068764630037 },
    { x: -42.878110113976106, y: -5624.068764630037 },
    { x: -42.878110113976106, y: -5618.068764630037 },
    { x: -42.878110113976106, y: -5618.068764630037 },
    { x: -42.878110113976106, y: -5615.068764630037 },
    { x: -42.878110113976106, y: -5612.068764630037 },
    { x: -42.878110113976106, y: -5601.068764630037 },
    { x: -42.878110113976106, y: -5598.068764630037 },
    { x: -41.878110113976106, y: -5588.068764630037 },
    { x: -41.878110113976106, y: -5586.068764630037 },
    { x: -41.878110113976106, y: -5581.068764630037 },
    { x: -41.878110113976106, y: -5572.068764630037 },
    { x: -41.878110113976106, y: -5571.068764630037 },
    { x: -41.878110113976106, y: -5571.068764630037 },
    { x: -41.878110113976106, y: -5555.068764630037 },
    { x: -41.878110113976106, y: -5555.068764630037 },
    { x: -41.878110113976106, y: -5537.068764630037 },
    { x: -41.878110113976106, y: -5535.068764630037 },
    { x: -41.878110113976106, y: -5526.068764630037 },
    { x: -41.878110113976106, y: -5518.068764630037 },
    { x: -41.878110113976106, y: -5518.068764630037 },
    { x: -41.878110113976106, y: -5514.068764630037 },
    { x: -40.878110113976106, y: -5545.068764630037 },
    { x: -41.878110113976106, y: -5553.068764630037 },
    { x: -40.878110113976106, y: -5474.068764630037 },
    { x: -58.878110113976106, y: -5402.068764630037 },
    { x: -54.878110113976106, y: -5418.068764630037 },
    { x: -54.878110113976106, y: -5422.068764630037 },
    { x: -56.878110113976106, y: -5427.068764630037 },
    { x: -56.878110113976106, y: -5433.068764630037 },
    { x: -56.878110113976106, y: -5437.068764630037 },
    { x: -56.878110113976106, y: -5446.068764630037 },
    { x: -56.878110113976106, y: -5451.068764630037 },
    { x: -56.878110113976106, y: -5451.068764630037 },
    { x: -55.878110113976106, y: -5456.068764630037 },
    { x: -53.878110113976106, y: -5466.068764630037 },
    { x: -53.878110113976106, y: -5471.068764630037 },
    { x: -53.878110113976106, y: -5482.068764630037 },
    { x: -53.878110113976106, y: -5486.068764630037 },
    { x: -53.878110113976106, y: -5498.068764630037 },
    { x: -53.878110113976106, y: -5512.068764630037 },
    { x: -51.878110113976106, y: -5684.068764630037 },
    { x: -52.878110113976106, y: -5692.068764630037 },
    { x: -54.878110113976106, y: -5697.068764630037 },
    { x: -54.878110113976106, y: -5706.068764630037 },
    { x: -54.878110113976106, y: -5711.068764630037 },
    { x: -54.878110113976106, y: -5718.068764630037 },
    { x: -50.878110113976106, y: -5670.068764630037 },
    { x: -53.878110113976106, y: -5660.068764630037 },
    { x: -53.878110113976106, y: -5654.068764630037 },
    { x: -53.878110113976106, y: -5650.068764630037 },
    { x: -54.878110113976106, y: -5643.068764630037 },
    { x: -54.878110113976106, y: -5639.068764630037 },
    { x: -56.878110113976106, y: -5636.068764630037 },
    { x: -56.878110113976106, y: -5634.068764630037 },
    { x: -56.878110113976106, y: -5622.068764630037 },
    { x: -52.878110113976106, y: -5614.068764630037 },
    { x: -52.878110113976106, y: -5600.068764630037 },
    { x: -56.878110113976106, y: -5593.068764630037 },
    { x: -56.878110113976106, y: -5593.068764630037 },
    { x: -56.878110113976106, y: -5586.068764630037 },
    { x: -56.878110113976106, y: -5586.068764630037 },
    { x: -56.878110113976106, y: -5573.068764630037 },
    { x: -56.878110113976106, y: -5565.068764630037 },
    { x: -56.878110113976106, y: -5558.068764630037 },
    { x: -56.878110113976106, y: -5554.068764630037 },
    { x: -56.878110113976106, y: -5554.068764630037 },
    { x: -56.878110113976106, y: -5544.068764630037 },
    { x: -56.878110113976106, y: -5544.068764630037 },
    { x: -56.878110113976106, y: -5535.068764630037 },
    { x: -56.878110113976106, y: -5532.068764630037 },
    { x: -56.878110113976106, y: -5532.068764630037 },
    { x: -58.878110113976106, y: -5729.068764630037 },
    { x: -56.878110113976106, y: -5739.068764630037 },
    { x: -56.878110113976106, y: -5743.068764630037 },
    { x: -54.878110113976106, y: -5524.068764630037 },
    // Connector area (x ≈ 83 to 290, y ≈ -4936 to -4966)
    { x: 83.1218898860239, y: -4951.068764630037 },
    { x: 94.1218898860239, y: -4950.068764630037 },
    { x: 98.1218898860239, y: -4950.068764630037 },
    { x: 101.1218898860239, y: -4950.068764630037 },
    { x: 117.1218898860239, y: -4954.068764630037 },
    { x: 117.1218898860239, y: -4954.068764630037 },
    { x: 119.1218898860239, y: -4954.068764630037 },
    { x: 129.1218898860239, y: -4954.068764630037 },
    { x: 149.1218898860239, y: -4955.068764630037 },
    { x: 151.1218898860239, y: -4955.068764630037 },
    { x: 162.1218898860239, y: -4955.068764630037 },
    { x: 173.1218898860239, y: -4955.068764630037 },
    { x: 191.1218898860239, y: -4955.068764630037 },
    { x: 206.1218898860239, y: -4957.068764630037 },
    { x: 218.1218898860239, y: -4958.068764630037 },
    { x: 226.1218898860239, y: -4959.068764630037 },
    { x: 234.1218898860239, y: -4959.068764630037 },
    { x: 246.1218898860239, y: -4959.068764630037 },
    { x: 255.1218898860239, y: -4959.068764630037 },
    { x: 266.1218898860239, y: -4963.068764630037 },
    { x: 273.1218898860239, y: -4964.068764630037 },
    { x: 281.1218898860239, y: -4966.068764630037 },
    { x: 88.1218898860239, y: -4940.068764630037 },
    { x: 87.1218898860239, y: -4939.068764630037 },
    { x: 95.1218898860239, y: -4936.068764630037 },
    { x: 110.1218898860239, y: -4936.068764630037 },
    { x: 136.1218898860239, y: -4941.068764630037 },
    { x: 160.1218898860239, y: -4945.068764630037 },
    { x: 172.1218898860239, y: -4945.068764630037 },
    { x: 178.1218898860239, y: -4945.068764630037 },
    { x: 199.1218898860239, y: -4945.068764630037 },
    { x: 199.1218898860239, y: -4945.068764630037 },
    { x: 225.1218898860239, y: -4947.068764630037 },
    { x: 237.1218898860239, y: -4947.068764630037 },
    { x: 251.1218898860239, y: -4951.068764630037 },
    { x: 252.1218898860239, y: -4951.068764630037 },
    { x: 264.1218898860239, y: -4951.068764630037 },
    { x: 271.1218898860239, y: -4951.068764630037 },
    { x: 282.1218898860239, y: -4954.068764630037 },
    { x: 282.1218898860239, y: -4954.068764630037 },
    { x: 290.1218898860239, y: -4957.068764630037 },
    { x: 147.1218898860239, y: -4942.068764630037 },
    { x: 123.1218898860239, y: -4942.068764630037 },
    { x: 144.1218898860239, y: -4961.068764630037 },
    { x: 212.1218898860239, y: -4939.068764630037 },
    { x: 188.1218898860239, y: -4957.068764630037 },
    { x: 208.1218898860239, y: -4945.068764630037 },
    { x: 140.1218898860239, y: -4959.068764630037 },
    // Connector area (x ≈ 489 to 759, y ≈ -5787 to -5872)
    { x: 489.0630663566121, y: -5854.421705806507 },
    { x: 736.0630663566121, y: -5841.421705806507 },
    { x: 749.0630663566121, y: -5840.421705806507 },
    { x: 746.0630663566121, y: -5812.421705806507 },
    { x: 734.0630663566121, y: -5809.421705806507 },
    { x: 733.0630663566121, y: -5809.421705806507 },
    { x: 730.0630663566121, y: -5800.421705806507 },
    { x: 730.0630663566121, y: -5797.421705806507 },
    { x: 737.0630663566121, y: -5794.421705806507 },
    { x: 744.0630663566121, y: -5794.421705806507 },
    { x: 749.0630663566121, y: -5794.421705806507 },
    { x: 752.0630663566121, y: -5794.421705806507 },
    { x: 752.0630663566121, y: -5867.421705806507 },
    { x: 725.0630663566121, y: -5787.421705806507 },
    { x: 723.0630663566121, y: -5809.421705806507 },
    { x: 755.0630663566121, y: -5827.421705806507 },
    { x: 759.0630663566121, y: -5811.421705806507 },
    { x: 757.0630663566121, y: -5872.421705806507 },
    { x: 756.0630663566121, y: -5812.421705806507 },
    // Connector area (x ≈ -508 to -541, y ≈ -3771 to -3794)
    { x: -525.5746275174401, y: -3791.731063577916 },
    { x: -508.57462751744015, y: -3794.731063577916 },
    { x: -512.5746275174401, y: -3782.731063577916 },
    { x: -509.57462751744015, y: -3771.731063577916 },
    { x: -534.5746275174401, y: -3791.731063577916 },
    { x: -536.5746275174401, y: -3775.731063577916 },
    { x: -541.5746275174401, y: -3776.731063577916 },
    // Connector area (x ≈ -475 to -508, y ≈ -3752 to -3792)
    { x: -508.46328553868386, y: -3788.9478984980806 },
    { x: -508.46328553868386, y: -3775.9478984980806 },
    { x: -492.46328553868386, y: -3770.9478984980806 },
    { x: -492.46328553868386, y: -3792.9478984980806 },
    { x: -475.46328553868386, y: -3762.9478984980806 },
    { x: -475.46328553868386, y: -3775.9478984980806 },
    { x: -479.46328553868386, y: -3792.9478984980806 },
    { x: -478.46328553868386, y: -3752.9478984980806 },
    // Connector area (x ≈ -480 to -512, y ≈ -3640 to -3788)
    { x: -509.61368320215206, y: -3769.7993130098216 },
    { x: -509.61368320215206, y: -3788.7993130098216 },
    { x: -492.61368320215206, y: -3777.7993130098216 },
    { x: -494.61368320215206, y: -3776.7993130098216 },
    { x: -505.61368320215206, y: -3720.7993130098216 },
    { x: -498.61368320215206, y: -3656.7993130098216 },
    { x: -512.6136832021521, y: -3640.7993130098216 },
    { x: -494.61368320215206, y: -3640.7993130098216 },
    { x: -510.61368320215206, y: -3736.7993130098216 },
    { x: -492.61368320215206, y: -3733.7993130098216 },
    { x: -480.61368320215206, y: -3740.7993130098216 },
    // Connector area (x ≈ -484 to -508, y ≈ -3768 to -3792)
    { x: -508.6992909875406, y: -3792.3532693685775 },
    { x: -508.6992909875406, y: -3780.3532693685775 },
    { x: -508.6992909875406, y: -3769.3532693685775 },
    { x: -484.6992909875406, y: -3771.3532693685775 },
    { x: -484.6992909875406, y: -3771.3532693685775 },
    { x: -494.6992909875406, y: -3768.3532693685775 },
    // New connector points
    { x: 71.26489526617746, y: -4974.036413956675 },
    { x: 71.26489526617746, y: -4992.036413956675 },
    { x: 71.26489526617746, y: -5003.036413956675 },
    { x: 71.26489526617746, y: -5014.036413956675 },
    { x: 260.26489526617746, y: -4940.036413956675 },
    { x: 275.26489526617746, y: -4939.036413956675 },
    { x: 288.26489526617746, y: -4939.036413956675 },
    // Additional connector points
    { x: -74.09852577630258, y: -5490.179278424113 },
    { x: -77.09852577630258, y: -5506.179278424113 },
    { x: -79.09852577630258, y: -5524.179278424113 },
    { x: -26.09852577630258, y: -5538.179278424113 },
    { x: -26.09852577630258, y: -5506.179278424113 },
    { x: 9.90147422369742, y: -5407.179278424113 },
    { x: -13.09852577630258, y: -5407.179278424113 },
    { x: -21.09852577630258, y: -5407.179278424113 },
    { x: -7.09852577630258, y: -5404.179278424113 },
    { x: -1.09852577630258, y: -5406.179278424113 },
    { x: -77.09852577630258, y: -5408.179278424113 },
    { x: -93.09852577630258, y: -5407.179278424113 },
    // Path connector with 13m spacing
    // Segment 1: (325.12, -3914.86) → (325.12, -3972.05) - vertical, ~57m
    { x: 325.1245418497183, y: -3914.8565120403796 },
    { x: 325.1245418497183, y: -3927.8565120403796 },
    { x: 325.1245418497183, y: -3940.8565120403796 },
    { x: 325.1245418497183, y: -3953.8565120403796 },
    { x: 325.1245418497183, y: -3966.8565120403796 },
    { x: 325.1245418497183, y: -3972.052924268701 },
    // Segment 2: (325.12, -3972.05) → (325.12, -4043.55) - vertical, ~71m
    { x: 325.1245418497183, y: -3985.052924268701 },
    { x: 325.1245418497183, y: -3998.052924268701 },
    { x: 325.1245418497183, y: -4011.052924268701 },
    { x: 325.1245418497183, y: -4024.052924268701 },
    { x: 325.1245418497183, y: -4037.052924268701 },
    { x: 325.1245418497183, y: -4043.548439554103 },
    // Segment 3: (325.12, -4043.55) → (321.55, -4172.24) - diagonal, ~129m
    { x: 324.9515418497183, y: -4056.548439554103 },
    { x: 324.7785418497183, y: -4069.548439554103 },
    { x: 324.6055418497183, y: -4082.548439554103 },
    { x: 324.4325418497183, y: -4095.548439554103 },
    { x: 324.2595418497183, y: -4108.548439554103 },
    { x: 324.0865418497183, y: -4121.548439554103 },
    { x: 323.9135418497183, y: -4134.548439554103 },
    { x: 323.7405418497183, y: -4147.548439554103 },
    { x: 323.5675418497183, y: -4160.548439554103 },
    { x: 323.3945418497183, y: -4172.240367067827 },
    { x: 321.54976608544825, y: -4172.240367067827 },
    // Segment 4: (321.55, -4172.24) → (328.70, -4644.11) - diagonal, ~472m
    { x: 321.65676608544825, y: -4185.240367067827 },
    { x: 321.76376608544825, y: -4198.240367067827 },
    { x: 321.87076608544825, y: -4211.240367067827 },
    { x: 321.97776608544825, y: -4224.240367067827 },
    { x: 322.08476608544825, y: -4237.240367067827 },
    { x: 322.19176608544825, y: -4250.240367067827 },
    { x: 322.29876608544825, y: -4263.240367067827 },
    { x: 322.40576608544825, y: -4276.240367067827 },
    { x: 322.51276608544825, y: -4289.240367067827 },
    { x: 322.61976608544825, y: -4302.240367067827 },
    { x: 322.72676608544825, y: -4315.240367067827 },
    { x: 322.83376608544825, y: -4328.240367067827 },
    { x: 322.94076608544825, y: -4341.240367067827 },
    { x: 323.04776608544825, y: -4354.240367067827 },
    { x: 323.15476608544825, y: -4367.240367067827 },
    { x: 323.26176608544825, y: -4380.240367067827 },
    { x: 323.36876608544825, y: -4393.240367067827 },
    { x: 323.47576608544825, y: -4406.240367067827 },
    { x: 323.58276608544825, y: -4419.240367067827 },
    { x: 323.68976608544825, y: -4432.240367067827 },
    { x: 323.79676608544825, y: -4445.240367067827 },
    { x: 323.90376608544825, y: -4458.240367067827 },
    { x: 324.01076608544825, y: -4471.240367067827 },
    { x: 324.11776608544825, y: -4484.240367067827 },
    { x: 324.22476608544825, y: -4497.240367067827 },
    { x: 324.33176608544825, y: -4510.240367067827 },
    { x: 324.43876608544825, y: -4523.240367067827 },
    { x: 324.54576608544825, y: -4536.240367067827 },
    { x: 324.65276608544825, y: -4549.240367067827 },
    { x: 324.75976608544825, y: -4562.240367067827 },
    { x: 324.86676608544825, y: -4575.240367067827 },
    { x: 324.97376608544825, y: -4588.240367067827 },
    { x: 325.08076608544825, y: -4601.240367067827 },
    { x: 325.18776608544825, y: -4614.240367067827 },
    { x: 325.29476608544825, y: -4627.240367067827 },
    { x: 325.40176608544825, y: -4640.240367067827 },
    { x: 328.69931761398846, y: -4644.110767951479 },
    // South access road (interpolated every 14m, overrides lots)
    // Path: (-1212.68, -13027.85) -> (-225.99, -13033.58) -> (-225.99, -13027.85)
    { x: -1212.6838743626743, y: -13027.845816000443 },
    { x: -1198.9838743626743, y: -13027.925816000443 },
    { x: -1185.2838743626743, y: -13028.005816000443 },
    { x: -1171.5838743626743, y: -13028.085816000443 },
    { x: -1157.8838743626743, y: -13028.165816000443 },
    { x: -1089.3838743626743, y: -13028.565816000443 },
    { x: -1075.6838743626743, y: -13028.645816000443 },
    { x: -1061.9838743626743, y: -13028.725816000443 },
    { x: -1048.2838743626743, y: -13028.805816000443 },
    { x: -1034.5838743626743, y: -13028.885816000443 },
    { x: -1020.8838743626743, y: -13028.965816000443 },
    { x: -1007.1838743626743, y: -13029.045816000443 },
    { x: -993.4838743626743, y: -13029.125816000443 },
    { x: -979.7838743626743, y: -13029.205816000443 },
    { x: -966.0838743626743, y: -13029.285816000443 },
    { x: -952.3838743626743, y: -13029.365816000443 },
    { x: -938.6838743626743, y: -13029.445816000443 },
    { x: -924.9838743626743, y: -13029.525816000443 },
    { x: -911.2838743626743, y: -13029.605816000443 },
    { x: -897.5838743626743, y: -13029.685816000443 },
    { x: -883.8838743626743, y: -13029.765816000443 },
    { x: -870.1838743626743, y: -13029.845816000443 },
    { x: -856.4838743626743, y: -13029.925816000443 },
    { x: -842.7838743626743, y: -13030.005816000443 },
    { x: -829.0838743626743, y: -13030.085816000443 },
    { x: -815.3838743626743, y: -13030.165816000443 },
    { x: -801.6838743626743, y: -13030.245816000443 },
    { x: -787.9838743626743, y: -13030.325816000443 },
    { x: -774.2838743626743, y: -13030.405816000443 },
    { x: -760.5838743626743, y: -13030.485816000443 },
    { x: -746.8838743626743, y: -13030.565816000443 },
    { x: -733.1838743626743, y: -13030.645816000443 },
    { x: -719.4838743626743, y: -13030.725816000443 },
    { x: -705.7838743626743, y: -13030.805816000443 },
    { x: -692.0838743626743, y: -13030.885816000443 },
    { x: -678.3838743626743, y: -13030.965816000443 },
    { x: -664.6838743626743, y: -13031.045816000443 },
    { x: -650.9838743626743, y: -13031.125816000443 },
    { x: -637.2838743626743, y: -13031.205816000443 },
    { x: -623.5838743626743, y: -13031.285816000443 },
    { x: -609.8838743626743, y: -13031.365816000443 },
    { x: -596.1838743626743, y: -13031.445816000443 },
    { x: -582.4838743626743, y: -13031.525816000443 },
    { x: -568.7838743626743, y: -13031.605816000443 },
    { x: -555.0838743626743, y: -13031.685816000443 },
    { x: -541.3838743626743, y: -13031.765816000443 },
    { x: -527.6838743626743, y: -13031.845816000443 },
    { x: -513.9838743626743, y: -13031.925816000443 },
    { x: -500.2838743626743, y: -13032.005816000443 },
    { x: -486.5838743626743, y: -13032.085816000443 },
    { x: -472.8838743626743, y: -13032.165816000443 },
    { x: -459.1838743626743, y: -13032.245816000443 },
    { x: -445.4838743626743, y: -13032.325816000443 },
    { x: -431.7838743626743, y: -13032.405816000443 },
    { x: -418.0838743626743, y: -13032.485816000443 },
    { x: -404.3838743626743, y: -13032.565816000443 },
    { x: -390.6838743626743, y: -13032.645816000443 },
    { x: -376.9838743626743, y: -13032.725816000443 },
    { x: -363.2838743626743, y: -13032.805816000443 },
    { x: -349.5838743626743, y: -13032.885816000443 },
    { x: -335.8838743626743, y: -13032.965816000443 },
    { x: -322.1838743626743, y: -13033.045816000443 },
    { x: -308.4838743626743, y: -13033.125816000443 },
    { x: -294.7838743626743, y: -13033.205816000443 },
    { x: -281.0838743626743, y: -13033.285816000443 },
    { x: -267.3838743626743, y: -13033.365816000443 },
    { x: -253.6838743626743, y: -13033.445816000443 },
    { x: -239.9838743626743, y: -13033.525816000443 },
    { x: -225.9854461963513, y: -13033.575772029282 },
    { x: -225.9854461963513, y: -13027.845816000443 },
    // Lot access connector (y ≈ -12362 to -12718)
    // Left edge (every 13m)
    { x: -545.557, y: -12362.38 },
    { x: -544.84, y: -12375.38 },
    { x: -544.12, y: -12388.38 },
    { x: -543.41, y: -12401.38 },
    { x: -542.69, y: -12414.38 },
    { x: -541.98, y: -12427.38 },
    { x: -541.26, y: -12440.38 },
    { x: -540.55, y: -12453.38 },
    { x: -539.83, y: -12466.38 },
    { x: -539.12, y: -12479.38 },
    { x: -538.40, y: -12492.38 },
    { x: -537.69, y: -12505.38 },
    { x: -536.97, y: -12518.38 },
    { x: -536.26, y: -12531.38 },
    { x: -535.54, y: -12544.38 },
    { x: -534.83, y: -12557.38 },
    { x: -534.11, y: -12570.38 },
    { x: -533.40, y: -12583.38 },
    { x: -532.68, y: -12596.38 },
    { x: -531.97, y: -12609.38 },
    { x: -531.25, y: -12622.38 },
    { x: -530.54, y: -12635.38 },
    { x: -529.82, y: -12648.38 },
    { x: -529.11, y: -12661.38 },
    { x: -528.39, y: -12674.38 },
    { x: -527.68, y: -12687.38 },
    { x: -526.96, y: -12700.38 },
    { x: -526.25, y: -12713.38 },
    { x: -526.07, y: -12718.02 },
    // Right edge (every 13m)
    { x: -535.81, y: -12372.12 },
    { x: -535.24, y: -12385.12 },
    { x: -534.67, y: -12398.12 },
    { x: -534.10, y: -12411.12 },
    { x: -533.53, y: -12424.12 },
    { x: -532.96, y: -12437.12 },
    { x: -532.38, y: -12450.12 },
    { x: -531.81, y: -12463.12 },
    { x: -531.24, y: -12476.12 },
    { x: -530.67, y: -12489.12 },
    { x: -530.10, y: -12502.12 },
    { x: -529.53, y: -12515.12 },
    { x: -528.96, y: -12528.12 },
    { x: -528.39, y: -12541.12 },
    { x: -527.81, y: -12554.12 },
    { x: -527.24, y: -12567.12 },
    { x: -526.67, y: -12580.12 },
    { x: -526.10, y: -12593.12 },
    { x: -525.53, y: -12606.12 },
    { x: -524.96, y: -12619.12 },
    { x: -524.39, y: -12632.12 },
    { x: -523.82, y: -12645.12 },
    { x: -523.24, y: -12658.12 },
    { x: -522.67, y: -12671.12 },
    { x: -522.10, y: -12684.12 },
    { x: -521.53, y: -12697.12 },
    { x: -520.96, y: -12710.12 },
    { x: -516.33, y: -12713.15 },
    // Center fill (every 13m)
    { x: -540.69, y: -12367.25 },
    { x: -540.04, y: -12380.25 },
    { x: -539.39, y: -12393.25 },
    { x: -538.75, y: -12406.25 },
    { x: -538.10, y: -12419.25 },
    { x: -537.45, y: -12432.25 },
    { x: -536.81, y: -12445.25 },
    { x: -536.16, y: -12458.25 },
    { x: -535.51, y: -12471.25 },
    { x: -534.87, y: -12484.25 },
    { x: -534.22, y: -12497.25 },
    { x: -533.58, y: -12510.25 },
    { x: -532.93, y: -12523.25 },
    { x: -532.28, y: -12536.25 },
    { x: -531.64, y: -12549.25 },
    { x: -530.99, y: -12562.25 },
    { x: -530.34, y: -12575.25 },
    { x: -529.70, y: -12588.25 },
    { x: -529.05, y: -12601.25 },
    { x: -528.41, y: -12614.25 },
    { x: -527.76, y: -12627.25 },
    { x: -527.11, y: -12640.25 },
    { x: -526.47, y: -12653.25 },
    { x: -525.82, y: -12666.25 },
    { x: -525.17, y: -12679.25 },
    { x: -524.53, y: -12692.25 },
    { x: -523.88, y: -12705.25 },
    { x: -521.20, y: -12715.59 },
    // L-shaped escape path (x ≈ -427 to -686, y ≈ -5260 to -4510)
    // Horizontal leg (y = -5260, -5275)
    { x: -427, y: -5260 }, { x: -440, y: -5260 }, { x: -453, y: -5260 }, { x: -466, y: -5260 },
    { x: -479, y: -5260 }, { x: -492, y: -5260 }, { x: -505, y: -5260 }, { x: -518, y: -5260 },
    { x: -531, y: -5260 }, { x: -544, y: -5260 }, { x: -557, y: -5260 }, { x: -570, y: -5260 },
    { x: -583, y: -5260 }, { x: -596, y: -5260 }, { x: -609, y: -5260 }, { x: -622, y: -5260 },
    { x: -635, y: -5260 }, { x: -648, y: -5260 }, { x: -661, y: -5260 }, { x: -674, y: -5260 },
    { x: -427, y: -5275 }, { x: -440, y: -5275 }, { x: -453, y: -5275 }, { x: -466, y: -5275 },
    { x: -479, y: -5275 }, { x: -492, y: -5275 }, { x: -505, y: -5275 }, { x: -518, y: -5275 },
    { x: -531, y: -5275 }, { x: -544, y: -5275 }, { x: -557, y: -5275 }, { x: -570, y: -5275 },
    { x: -583, y: -5275 }, { x: -596, y: -5275 }, { x: -609, y: -5275 }, { x: -622, y: -5275 },
    { x: -635, y: -5275 }, { x: -648, y: -5275 }, { x: -661, y: -5275 }, { x: -674, y: -5275 },
    // Vertical leg (x = -660, -673, -686) going up to y = -4510
    { x: -660, y: -5275 }, { x: -673, y: -5275 }, { x: -686, y: -5275 },
    { x: -660, y: -5262 }, { x: -673, y: -5262 }, { x: -686, y: -5262 },
    { x: -660, y: -5249 }, { x: -673, y: -5249 }, { x: -686, y: -5249 },
    { x: -660, y: -5236 }, { x: -673, y: -5236 }, { x: -686, y: -5236 },
    { x: -660, y: -5223 }, { x: -673, y: -5223 }, { x: -686, y: -5223 },
    { x: -660, y: -5210 }, { x: -673, y: -5210 }, { x: -686, y: -5210 },
    { x: -660, y: -5197 }, { x: -673, y: -5197 }, { x: -686, y: -5197 },
    { x: -660, y: -5184 }, { x: -673, y: -5184 }, { x: -686, y: -5184 },
    { x: -660, y: -5171 }, { x: -673, y: -5171 }, { x: -686, y: -5171 },
    { x: -660, y: -5158 }, { x: -673, y: -5158 }, { x: -686, y: -5158 },
    { x: -660, y: -5145 }, { x: -673, y: -5145 }, { x: -686, y: -5145 },
    { x: -660, y: -5132 }, { x: -673, y: -5132 }, { x: -686, y: -5132 },
    { x: -660, y: -5119 }, { x: -673, y: -5119 }, { x: -686, y: -5119 },
    { x: -660, y: -5106 }, { x: -673, y: -5106 }, { x: -686, y: -5106 },
    { x: -660, y: -5093 }, { x: -673, y: -5093 }, { x: -686, y: -5093 },
    { x: -660, y: -5080 }, { x: -673, y: -5080 }, { x: -686, y: -5080 },
    { x: -660, y: -5067 }, { x: -673, y: -5067 }, { x: -686, y: -5067 },
    { x: -660, y: -5054 }, { x: -673, y: -5054 }, { x: -686, y: -5054 },
    { x: -660, y: -5041 }, { x: -673, y: -5041 }, { x: -686, y: -5041 },
    { x: -660, y: -5028 }, { x: -673, y: -5028 }, { x: -686, y: -5028 },
    { x: -660, y: -5015 }, { x: -673, y: -5015 }, { x: -686, y: -5015 },
    { x: -660, y: -5002 }, { x: -673, y: -5002 }, { x: -686, y: -5002 },
    { x: -660, y: -4989 }, { x: -673, y: -4989 }, { x: -686, y: -4989 },
    { x: -660, y: -4976 }, { x: -673, y: -4976 }, { x: -686, y: -4976 },
    { x: -660, y: -4963 }, { x: -673, y: -4963 }, { x: -686, y: -4963 },
    { x: -660, y: -4950 }, { x: -673, y: -4950 }, { x: -686, y: -4950 },
    { x: -660, y: -4937 }, { x: -673, y: -4937 }, { x: -686, y: -4937 },
    { x: -660, y: -4924 }, { x: -673, y: -4924 }, { x: -686, y: -4924 },
    { x: -660, y: -4911 }, { x: -673, y: -4911 }, { x: -686, y: -4911 },
    { x: -660, y: -4898 }, { x: -673, y: -4898 }, { x: -686, y: -4898 },
    { x: -660, y: -4885 }, { x: -673, y: -4885 }, { x: -686, y: -4885 },
    { x: -660, y: -4872 }, { x: -673, y: -4872 }, { x: -686, y: -4872 },
    { x: -660, y: -4859 }, { x: -673, y: -4859 }, { x: -686, y: -4859 },
    { x: -660, y: -4846 }, { x: -673, y: -4846 }, { x: -686, y: -4846 },
    { x: -660, y: -4833 }, { x: -673, y: -4833 }, { x: -686, y: -4833 },
    { x: -660, y: -4820 }, { x: -673, y: -4820 }, { x: -686, y: -4820 },
    { x: -660, y: -4807 }, { x: -673, y: -4807 }, { x: -686, y: -4807 },
    { x: -660, y: -4794 }, { x: -673, y: -4794 }, { x: -686, y: -4794 },
    { x: -660, y: -4781 }, { x: -673, y: -4781 }, { x: -686, y: -4781 },
    { x: -660, y: -4768 }, { x: -673, y: -4768 }, { x: -686, y: -4768 },
    { x: -660, y: -4755 }, { x: -673, y: -4755 }, { x: -686, y: -4755 },
    { x: -660, y: -4742 }, { x: -673, y: -4742 }, { x: -686, y: -4742 },
    { x: -660, y: -4729 }, { x: -673, y: -4729 }, { x: -686, y: -4729 },
    { x: -660, y: -4716 }, { x: -673, y: -4716 }, { x: -686, y: -4716 },
    { x: -660, y: -4703 }, { x: -673, y: -4703 }, { x: -686, y: -4703 },
    { x: -660, y: -4690 }, { x: -673, y: -4690 }, { x: -686, y: -4690 },
    { x: -660, y: -4677 }, { x: -673, y: -4677 }, { x: -686, y: -4677 },
    { x: -660, y: -4664 }, { x: -673, y: -4664 }, { x: -686, y: -4664 },
    { x: -660, y: -4651 }, { x: -673, y: -4651 }, { x: -686, y: -4651 },
    { x: -660, y: -4638 }, { x: -673, y: -4638 }, { x: -686, y: -4638 },
    { x: -660, y: -4625 }, { x: -673, y: -4625 }, { x: -686, y: -4625 },
    { x: -660, y: -4612 }, { x: -673, y: -4612 }, { x: -686, y: -4612 },
    { x: -660, y: -4599 }, { x: -673, y: -4599 }, { x: -686, y: -4599 },
    { x: -660, y: -4586 }, { x: -673, y: -4586 }, { x: -686, y: -4586 },
    { x: -660, y: -4573 }, { x: -673, y: -4573 }, { x: -686, y: -4573 },
    { x: -660, y: -4560 }, { x: -673, y: -4560 }, { x: -686, y: -4560 },
    { x: -660, y: -4547 }, { x: -673, y: -4547 }, { x: -686, y: -4547 },
    { x: -660, y: -4534 }, { x: -673, y: -4534 }, { x: -686, y: -4534 },
    { x: -660, y: -4521 }, { x: -673, y: -4521 }, { x: -686, y: -4521 },
    { x: -660, y: -4510 }, { x: -673, y: -4510 }, { x: -686, y: -4510 },
    // Additional connector points
    { x: 91.32, y: -4958.50 },
    { x: 91.32, y: -4940.50 },
    { x: -576.45, y: -3807.00 },
    { x: -576.45, y: -3827.00 },
    { x: -557.45, y: -3826.00 },
    { x: -576.45, y: -3842.00 },
    { x: -554.45, y: -3840.00 },
    { x: -573.45, y: -3787.00 },
    { x: -557.45, y: -3787.00 },
    // Vertical connector (y: -12682 to -13032)
    { x: -526.34, y: -12682 },
    { x: -526.27, y: -12695 },
    { x: -526.19, y: -12708 },
    { x: -526.12, y: -12721 },
    { x: -526.05, y: -12734 },
    { x: -525.97, y: -12747 },
    { x: -525.90, y: -12760 },
    { x: -525.83, y: -12773 },
    { x: -525.75, y: -12786 },
    { x: -525.68, y: -12799 },
    { x: -525.61, y: -12812 },
    { x: -525.53, y: -12825 },
    { x: -525.46, y: -12838 },
    { x: -525.39, y: -12851 },
    { x: -525.02, y: -12916 },
    { x: -524.95, y: -12929 },
    { x: -524.87, y: -12942 },
    { x: -524.80, y: -12955 },
    { x: -524.72, y: -12968 },
    { x: -524.65, y: -12981 },
    // Replaced vertical connector terminus with new coords
    { x: -531.39, y: -12995.44 },
    { x: -528.28, y: -13007.90 },
    { x: -508.02, y: -13017.25 },
    { x: -512.70, y: -13021.92 },
    { x: -525.16, y: -13025.04 },
    { x: -540.74, y: -13025.04 },
    { x: -542.30, y: -13021.92 },
    // West connector to horizontal path
    { x: -1114.17, y: -13024.06 },
    { x: -1130.35, y: -13025.68 },
    { x: -1146.54, y: -13025.68 },
    { x: -344.90, y: -13043.14 },
    { x: -510.69, y: -12792.56 },
    { x: -342.69, y: -13042.56 },
    { x: -1110.69, y: -13023.56 },
    { x: -1123.69, y: -13024.56 },
    { x: -1142.69, y: -13024.56 },
    { x: -1145.08, y: -13025.95 },
    { x: -1129.08, y: -13022.95 },
    { x: -1111.08, y: -13025.95 },
    { x: -1161.08, y: -13039.95 },
    { x: -1142.08, y: -13040.95 },
    { x: -1132.08, y: -13040.95 },
    { x: -1127.08, y: -13040.95 },
    { x: -1109.08, y: -13042.95 },
    { x: -1093.08, y: -13042.95 },
    { x: -345.08, y: -13041.95 },
    { x: -328.08, y: -13025.95 },
    { x: -445.08, y: -12916.95 },
    // Horizontal path at y≈-12788 (13m spacing, shifted 80m south)
    { x: -494, y: -12787.22 },
    { x: -481, y: -12787.22 },
    { x: -468, y: -12787.22 },
    { x: -455, y: -12787.22 },
    { x: -442, y: -12787.22 },
    { x: -429, y: -12787.22 },
    { x: -416, y: -12787.22 },
    { x: -403, y: -12787.22 },
    { x: -390, y: -12787.41 },
    { x: -377, y: -12787.60 },
    { x: -364, y: -12787.78 },
    { x: -351, y: -12787.96 },
    { x: -338, y: -12788.15 },
    { x: -325, y: -12788.33 },
    { x: -312, y: -12788.51 },
    { x: -299, y: -12788.70 },
    { x: -286, y: -12789.01 },
    { x: -273, y: -12789.45 },
    { x: -260, y: -12789.88 },
    { x: -247, y: -12790.32 },
    { x: -234, y: -12790.75 },
    { x: -221, y: -12791.19 },
    { x: -208, y: -12791.62 },
];

// Inovus-only road stamps (south access to FASE lots)
// Only stamped when _phasesAsLots is true
const INOVUS_CONNECTOR_COORDS = [
    { x: -344.6282421308715, y: -13042.040588503369 },
    { x: -1145.4750313105994, y: -13025.861865489636 },
    { x: -1131.9927621324896, y: -13025.861865489636 },
    { x: -1121.2069467900017, y: -13025.861865489636 },
    { x: -1109.0729045297028, y: -13025.861865489636 },
];

function stampManualConnectors() {
    let stamped = 0;

    // Always stamp base connectors
    for (const coord of MANUAL_CONNECTOR_COORDS) {
        if (stampConnectorCoord(coord)) stamped++;
    }

    if (stamped > 0) {
        log(`[BRIDGE] Manual connectors: ${stamped} cells stamped`);
    }
}

// Stamp/unstamp Inovus-only connector cells
function stampInovusConnectors() {
    _inovusConnectorCells = [];
    for (const coord of INOVUS_CONNECTOR_COORDS) {
        const idx = stampConnectorCoord(coord);
        if (idx !== false) _inovusConnectorCells.push(idx);
    }
    log(`[INOVUS] Stamped ${_inovusConnectorCells.length} Inovus connector cells`);
}

function unstampInovusConnectors() {
    let count = 0;
    for (const coord of INOVUS_CONNECTOR_COORDS) {
        const fx = Math.floor(worldToFieldX(coord.x));
        const fy = Math.floor(worldToFieldY(coord.y));
        if (fx < 0 || fx >= N || fy < 0 || fy >= N) continue;
        const idx = fy * N + fx;

        // Revert to impassable (no road)
        regionMap[idx] = REGION.VOID;
        Kxx[idx] = 0;
        Kyy[idx] = 0;
        // Remove from roadCellIndices
        const roadIdx = roadCellIndices.indexOf(idx);
        if (roadIdx !== -1) roadCellIndices.splice(roadIdx, 1);
        count++;
    }
    log(`[INOVUS] Unstamped ${count} Inovus connector cells`);
    _inovusConnectorCells = [];
}

function stampConnectorCoord(coord) {
    const fx = Math.floor(worldToFieldX(coord.x));
    const fy = Math.floor(worldToFieldY(coord.y));
    if (fx < 0 || fx >= N || fy < 0 || fy >= N) return false;

    const idx = fy * N + fx;

    // Don't touch sinks
    if (regionMap[idx] === REGION.SINK) return false;

    // Stamp as traversable road
    regionMap[idx] = REGION.ROAD;
    Kxx[idx] = Math.max(Kxx[idx], K_CONNECTOR);
    Kyy[idx] = Math.max(Kyy[idx], K_CONNECTOR);

    // Add to roadCellIndices if not present
    if (!roadCellIndices.includes(idx)) {
        roadCellIndices.push(idx);
    }
    return idx;
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL BLOCKERS — Destroy roads/lots, make impassable
// ─────────────────────────────────────────────────────────────────────────────

const MANUAL_BLOCKER_COORDS = [
    { x: -24827.091332469914, y: -4978.500282909994 },
    { x: -24830.091332469914, y: -4965.500282909994 },
    { x: -24838.091332469914, y: -4949.500282909994 },
    { x: -24842.091332469914, y: -4943.500282909994 },
    { x: -24843.091332469914, y: -4933.500282909994 },
    { x: -24849.091332469914, y: -4927.500282909994 },
    { x: -24851.091332469914, y: -4923.500282909994 },
    { x: -24851.091332469914, y: -4923.500282909994 },
    { x: -24835.091332469914, y: -4954.500282909994 },
    { x: -24825.091332469914, y: -4965.500282909994 },
    { x: -24843.091332469914, y: -4907.500282909994 },
    { x: -24838.091332469914, y: -4919.500282909994 },
    { x: -24833.091332469914, y: -4929.500282909994 },
    { x: -24830.091332469914, y: -4933.500282909994 },
    { x: -24827.091332469914, y: -4937.500282909994 },
    { x: -24827.091332469914, y: -4937.500282909994 },
    { x: -24823.091332469914, y: -4946.500282909994 },
    { x: -24823.091332469914, y: -4946.500282909994 },
    { x: -24813.091332469914, y: -4962.500282909994 },
    { x: -24813.091332469914, y: -4962.500282909994 },
    { x: -24827.091332469914, y: -4946.500282909994 },
    { x: -24826.091332469914, y: -4946.500282909994 },
    { x: -24822.091332469914, y: -4949.500282909994 },
    { x: -24813.091332469914, y: -4962.500282909994 },
    { x: -24827.091332469914, y: -4950.500282909994 },
    { x: -24835.091332469914, y: -4942.500282909994 },
    { x: -24843.091332469914, y: -4926.500282909994 },
    { x: -24825.091332469914, y: -4958.500282909994 },
    { x: -24815.091332469914, y: -4969.500282909994 },
    { x: -24815.95022505521, y: -5009.064395814314 },
    { x: -24780.95022505521, y: -5013.064395814314 },
    { x: -24784.95022505521, y: -4984.064395814314 },
    { x: -24849.95022505521, y: -4883.064395814314 },
    { x: -24881.95022505521, y: -4880.064395814314 },
    { x: -24847.95022505521, y: -4845.064395814314 },
    { x: -500.9843778933697, y: -2455.905372452935 },
    { x: -512.9843778933697, y: -2455.905372452935 },
    { x: -512.9843778933697, y: -2432.905372452935 },
    { x: -512.9843778933697, y: -2405.905372452935 },
    { x: -512.9843778933697, y: -2405.905372452935 },
    { x: -512.9843778933697, y: -2383.905372452935 },
    { x: -484.9843778933697, y: -2385.905372452935 },
    { x: -484.9843778933697, y: -2405.905372452935 },
    { x: -6384.094679569168, y: -3582.090307692699 },
    { x: -6350.094679569168, y: -3581.090307692699 },
    // Blocklist area (x ≈ -514 to -712, y ≈ -2642 to -3065)
    { x: -514.0176695489249, y: -2642.3903594226267 },
    { x: -519.6326883313808, y: -2672.337126262392 },
    { x: -648.7781203278672, y: -2945.601373675247 },
    { x: -654.3931391103232, y: -2979.291486369983 },
    { x: -660.0081578927791, y: -3001.7515614998065 },
    { x: -646.9064474003819, y: -3001.7515614998065 },
    { x: -648.7781203278672, y: -3022.339963702145 },
    { x: -652.5214661828379, y: -3054.158403469395 },
    { x: -689.9549247325441, y: -3037.3133471220276 },
    { x: -671.238195457691, y: -3012.9815990647185 },
    { x: -697.4416164424853, y: -3005.4949073547773 },
    { x: -678.7248871676322, y: -2984.9065051524385 },
    { x: -691.8265976600294, y: -2977.4198134424973 },
    { x: -682.4682330226028, y: -2954.959738312674 },
    { x: -682.4682330226028, y: -2932.49966318285 },
    { x: -682.4682330226028, y: -2911.9112609805115 },
    { x: -708.6716540073971, y: -2908.167915125541 },
    { x: -708.6716540073971, y: -2934.3713361103355 },
    { x: -708.6716540073971, y: -2971.804794660042 },
    { x: -712.4149998623678, y: -3005.4949073547773 },
    { x: -712.4149998623678, y: -3039.185020049513 },
    { x: -689.9549247325441, y: -3065.388441034307 },
    { x: -667.4948496027204, y: -3039.185020049513 },
    // Blocklist area (x ≈ -557 to -578, y ≈ -3785 to -3860)
    { x: -577.9153326987698, y: -3785.737661300715 },
    { x: -577.9153326987698, y: -3801.2056600313704 },
    { x: -577.9153326987698, y: -3802.4946599255913 },
    { x: -577.9153326987698, y: -3808.9396593966976 },
    { x: -577.9153326987698, y: -3823.1186582331316 },
    { x: -577.9153326987698, y: -3843.7426565406718 },
    { x: -577.9153326987698, y: -3848.898656117557 },
    { x: -570.1813333334422, y: -3842.4536566464503 },
    { x: -575.3373329103272, y: -3812.8066590793615 },
    { x: -562.4473339681147, y: -3816.6736587620253 },
    { x: -562.4473339681147, y: -3792.1826607718212 },
    { x: -557.2913343912296, y: -3842.4536566464503 },
    { x: -565.0253337565572, y: -3860.499655165548 },
    // Blocker area 1 (x ≈ -24808 to -24893, y ≈ -4895 to -5003)
    { x: -24808.55322390967, y: -4987.342792167735 },
    { x: -24823.42834450086, y: -4988.695075857843 },
    { x: -24861.292287823886, y: -4904.853487071138 },
    { x: -24857.235436753563, y: -4895.387501240381 },
    { x: -24876.167408415076, y: -4903.501203381031 },
    { x: -24893.74709638648, y: -4907.558054451355 },
    { x: -24861.292287823886, y: -4949.4788488447075 },
    { x: -24845.06488354259, y: -4972.467671576545 },
    { x: -24845.06488354259, y: -4990.047359547952 },
    { x: -24845.06488354259, y: -5003.570196449033 },
    // Blocker area 2 (x ≈ -653 to -693, y ≈ -2941 to -3021)
    { x: -693.1684776412785, y: -2961.2718705840325 },
    { x: -676.4873025395916, y: -2967.3377524391913 },
    { x: -690.135536713699, y: -2980.9859866132983 },
    { x: -656.7731865103252, y: -2984.018927540878 },
    { x: -656.7731865103252, y: -2953.6895182650837 },
    { x: -688.6190662499093, y: -3021.930689135621 },
    { x: -678.0037730033813, y: -3021.930689135621 },
    { x: -653.7402455827458, y: -3021.930689135621 },
    { x: -690.135536713699, y: -2953.6895182650837 },
    { x: -693.1684776412785, y: -2941.557754554766 },
    // Blocker area (x ≈ -488 to -512, y ≈ -3644 to -3790)
    { x: -510.4988624655771, y: -3644.8697548039618 },
    { x: -491.4988624655771, y: -3642.8697548039618 },
    { x: -494.4988624655771, y: -3662.8697548039618 },
    { x: -507.4988624655771, y: -3668.8697548039618 },
    { x: -510.4988624655771, y: -3675.8697548039618 },
    { x: -488.4988624655771, y: -3675.8697548039618 },
    { x: -492.4988624655771, y: -3690.8697548039618 },
    { x: -508.4988624655771, y: -3688.8697548039618 },
    { x: -508.4988624655771, y: -3706.8697548039618 },
    { x: -494.4988624655771, y: -3708.8697548039618 },
    { x: -494.4988624655771, y: -3708.8697548039618 },
    { x: -494.4988624655771, y: -3715.8697548039618 },
    { x: -512.4988624655771, y: -3718.8697548039618 },
    { x: -504.4988624655771, y: -3736.8697548039618 },
    { x: -503.4988624655771, y: -3728.8697548039618 },
    { x: -494.4988624655771, y: -3735.8697548039618 },
    // Removed blockers at -3790, -3772 (now connectors)
    // Blocker area (x ≈ 1623 to 1713, y ≈ -9276 to -8971)
    { x: 1623.0514686554998, y: -9275.913905288504 },
    { x: 1641.0514686554998, y: -9275.913905288504 },
    { x: 1655.0514686554998, y: -9275.913905288504 },
    { x: 1712.0514686554998, y: -8971.913905288504 },
    { x: 1711.0514686554998, y: -8985.913905288504 },
    { x: 1709.0514686554998, y: -8971.913905288504 },
    { x: 1708.0514686554998, y: -8993.913905288504 },
    { x: 1713.0514686554998, y: -9009.913905288504 },
    { x: 1708.0514686554998, y: -9004.913905288504 },
    // Blocker area (x ≈ -217 to -241, y ≈ -4887 to -5566)
    { x: -226.8781101139761, y: -4887.068764630037 },
    { x: -224.8781101139761, y: -4901.068764630037 },
    { x: -226.8781101139761, y: -4907.068764630037 },
    { x: -226.8781101139761, y: -4917.068764630037 },
    { x: -226.8781101139761, y: -4923.068764630037 },
    { x: -224.8781101139761, y: -4933.068764630037 },
    { x: -224.8781101139761, y: -4933.068764630037 },
    { x: -223.8781101139761, y: -4944.068764630037 },
    { x: -223.8781101139761, y: -4951.068764630037 },
    { x: -223.8781101139761, y: -4960.068764630037 },
    { x: -223.8781101139761, y: -4971.068764630037 },
    { x: -223.8781101139761, y: -4978.068764630037 },
    { x: -223.8781101139761, y: -4984.068764630037 },
    { x: -221.8781101139761, y: -4990.068764630037 },
    { x: -223.8781101139761, y: -5292.068764630037 },
    { x: -223.8781101139761, y: -5305.068764630037 },
    { x: -223.8781101139761, y: -5313.068764630037 },
    { x: -223.8781101139761, y: -5320.068764630037 },
    { x: -223.8781101139761, y: -5326.068764630037 },
    { x: -221.8781101139761, y: -5336.068764630037 },
    { x: -220.8781101139761, y: -5344.068764630037 },
    { x: -220.8781101139761, y: -5352.068764630037 },
    { x: -219.8781101139761, y: -5357.068764630037 },
    { x: -217.8781101139761, y: -5367.068764630037 },
    { x: -217.8781101139761, y: -5377.068764630037 },
    { x: -217.8781101139761, y: -5381.068764630037 },
    { x: -217.8781101139761, y: -5381.068764630037 },
    { x: -219.8781101139761, y: -5395.068764630037 },
    { x: -223.8781101139761, y: -5395.068764630037 },
    { x: -225.8781101139761, y: -5390.068764630037 },
    { x: -224.8781101139761, y: -5381.068764630037 },
    { x: -224.8781101139761, y: -5365.068764630037 },
    { x: -225.8781101139761, y: -5335.068764630037 },
    { x: -223.8781101139761, y: -5295.068764630037 },
    { x: -240.8781101139761, y: -5451.068764630037 },
    { x: -240.8781101139761, y: -5451.068764630037 },
    { x: -240.8781101139761, y: -5472.068764630037 },
    { x: -241.8781101139761, y: -5482.068764630037 },
    { x: -241.8781101139761, y: -5489.068764630037 },
    { x: -241.8781101139761, y: -5496.068764630037 },
    { x: -241.8781101139761, y: -5509.068764630037 },
    { x: -241.8781101139761, y: -5518.068764630037 },
    { x: -241.8781101139761, y: -5529.068764630037 },
    { x: -239.8781101139761, y: -5549.068764630037 },
    { x: -239.8781101139761, y: -5557.068764630037 },
    { x: -239.8781101139761, y: -5566.068764630037 },
    { x: -237.8781101139761, y: -5473.068764630037 },
    { x: -240.8781101139761, y: -5515.068764630037 },
    { x: -241.8781101139761, y: -5523.068764630037 },
    { x: -241.8781101139761, y: -5526.068764630037 },
    // New exclusion points
    { x: 5.534992868315044, y: -3684.8436055560287 },
    { x: 8.534992868315044, y: -3692.8436055560287 },
    { x: 8.534992868315044, y: -3694.8436055560287 },
    { x: 8.534992868315044, y: -3697.8436055560287 },
    { x: 5.534992868315044, y: -3705.8436055560287 },
    { x: 5.534992868315044, y: -3712.8436055560287 },
    { x: 8.534992868315044, y: -3741.8436055560287 },
    { x: 8.534992868315044, y: -3741.8436055560287 },
    { x: 8.534992868315044, y: -3746.8436055560287 },
    { x: 8.534992868315044, y: -3749.8436055560287 },
    { x: 8.534992868315044, y: -3788.8436055560287 },
    { x: 8.534992868315044, y: -3772.8436055560287 },
    { x: 8.534992868315044, y: -3810.8436055560287 },
    { x: 13.534992868315044, y: -3745.8436055560287 },
    { x: 4.534992868315044, y: -3753.8436055560287 },
    { x: 4.534992868315044, y: -3757.8436055560287 },
    { x: 4.534992868315044, y: -3762.8436055560287 },
    { x: 4.534992868315044, y: -3770.8436055560287 },
    { x: 4.534992868315044, y: -3772.8436055560287 },
    { x: 8.534992868315044, y: -3726.8436055560287 },
    { x: 11.534992868315044, y: -3784.8436055560287 },
    { x: 12.534992868315044, y: -3744.8436055560287 },
    { x: 12.534992868315044, y: -3744.8436055560287 },
    { x: 8.534992868315044, y: -3730.8436055560287 },
    { x: 8.534992868315044, y: -3705.8436055560287 },
    { x: 8.534992868315044, y: -3688.8436055560287 },
    // Additional exclusion points
    { x: 89.13086693096704, y: -4890.285037666161 },
    { x: 90.13086693096704, y: -4908.285037666161 },
    { x: 90.13086693096704, y: -4921.285037666161 },
    { x: 89.13086693096704, y: -4941.285037666161 },
    { x: 89.13086693096704, y: -4952.285037666161 },
    { x: 89.13086693096704, y: -4969.285037666161 },
    { x: -22.869133069032955, y: -4986.285037666161 },
    { x: -6.869133069032955, y: -4986.285037666161 },
    { x: 6.130866930967045, y: -4986.285037666161 },
    { x: 18.130866930967045, y: -4986.285037666161 },
    { x: 30.130866930967045, y: -4986.285037666161 },
    { x: 35.130866930967045, y: -4986.285037666161 },
    { x: 38.130866930967045, y: -4986.285037666161 },
    { x: 45.130866930967045, y: -4986.285037666161 },
    { x: 45.130866930967045, y: -4986.285037666161 },
    { x: 47.130866930967045, y: -4986.285037666161 },
    { x: 51.130866930967045, y: -4986.285037666161 },
    { x: 59.130866930967045, y: -4986.285037666161 },
    { x: 69.13086693096704, y: -4986.285037666161 },
    { x: 69.13086693096704, y: -4986.285037666161 },
    { x: 79.13086693096704, y: -4985.285037666161 },
    { x: 95.13086693096704, y: -4944.285037666161 },
    { x: 91.13086693096704, y: -4932.285037666161 },
    { x: -25.869133069032955, y: -4986.285037666161 },
    { x: -40.869133069032955, y: -4986.285037666161 },
    { x: -26.869133069032955, y: -4982.285037666161 },
    // Blocklist area (x ≈ -359 to -473, y ≈ -5277 to -5311)
    { x: -359, y: -5277 },
    { x: -372, y: -5277 },
    { x: -385, y: -5277 },
    { x: -398, y: -5277 },
    { x: -411, y: -5277 },
    { x: -424, y: -5277 },
    { x: -437, y: -5277 },
    { x: -450, y: -5277 },
    { x: -463, y: -5277 },
    { x: -473, y: -5277 },
    { x: -359, y: -5290 },
    { x: -372, y: -5290 },
    { x: -385, y: -5290 },
    { x: -398, y: -5290 },
    { x: -411, y: -5290 },
    { x: -424, y: -5290 },
    { x: -437, y: -5290 },
    { x: -450, y: -5290 },
    { x: -463, y: -5290 },
    { x: -473, y: -5290 },
    { x: -359, y: -5303 },
    { x: -372, y: -5303 },
    { x: -385, y: -5303 },
    { x: -398, y: -5303 },
    { x: -411, y: -5303 },
    { x: -424, y: -5303 },
    { x: -437, y: -5303 },
    { x: -450, y: -5303 },
    { x: -463, y: -5303 },
    { x: -473, y: -5303 },
    { x: -361, y: -5311 },
    { x: -374, y: -5311 },
    { x: -387, y: -5311 },
    { x: -400, y: -5311 },
    { x: -413, y: -5311 },
    { x: -426, y: -5311 },
    { x: -439, y: -5311 },
    { x: -452, y: -5311 },
    { x: -465, y: -5311 },
    { x: -473, y: -5311 },
    { x: -507.31476305219303, y: -2558.043939326958 },
    { x: -507.31476305219303, y: -2574.043939326958 },
    { x: -509.98, y: -2543.46 },
];

function stampManualBlockers() {
    let blocked = 0;
    for (const coord of MANUAL_BLOCKER_COORDS) {
        const fx = Math.floor(worldToFieldX(coord.x));
        const fy = Math.floor(worldToFieldY(coord.y));
        if (fx < 0 || fx >= N || fy < 0 || fy >= N) continue;

        const idx = fy * N + fx;

        // Don't touch sinks
        if (regionMap[idx] === REGION.SINK) continue;

        // Destroy: make impassable
        regionMap[idx] = REGION.OFFROAD;
        Kxx[idx] = 0;
        Kyy[idx] = 0;

        // Remove from roadCellIndices if present
        const roadIdx = roadCellIndices.indexOf(idx);
        if (roadIdx >= 0) {
            roadCellIndices.splice(roadIdx, 1);
        }
        blocked++;
    }
    if (blocked > 0) {
        log(`[BRIDGE] Manual blockers: ${blocked} cells destroyed`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL INJECTION POINTS — Additional industrial park sources
// ─────────────────────────────────────────────────────────────────────────────

const MANUAL_INJECTION_COORDS = [
    { x: -1545.9268658474755, y: -5652.1531407913335 },
];

// Injection point overrides — move existing injection points to new locations
// { from: {x, y}, to: {x, y}, radius: search radius in world units }
const INJECTION_POINT_OVERRIDES = [
    {
        from: { x: 2856.7638497716225, y: -7240.659348830732 },
        to: { x: 2853.2344380069167, y: -6727.718172360143 },
        radius: 30,
    },
];

function applyInjectionPointOverrides() {
    let moved = 0;
    for (const override of INJECTION_POINT_OVERRIDES) {
        for (const park of _industrialParkInjectionPoints) {
            const wx = fieldToWorldX(park.fieldX);
            const wy = fieldToWorldY(park.fieldY);
            const dx = wx - override.from.x;
            const dy = wy - override.from.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < override.radius) {
                const newFx = Math.floor(worldToFieldX(override.to.x));
                const newFy = Math.floor(worldToFieldY(override.to.y));
                log(`[OVERRIDE] Moving injection point "${park.name}" from (${park.fieldX},${park.fieldY}) to (${newFx},${newFy})`);
                park.fieldX = newFx;
                park.fieldY = newFy;
                moved++;
            }
        }
    }
    if (moved > 0) {
        log(`[OVERRIDE] Moved ${moved} injection points`);
    }
}

function addManualInjectionPoints() {
    let added = 0;
    for (const coord of MANUAL_INJECTION_COORDS) {
        const fx = Math.floor(worldToFieldX(coord.x));
        const fy = Math.floor(worldToFieldY(coord.y));
        if (fx < 0 || fx >= N || fy < 0 || fy >= N) continue;

        // Add to industrial park injection points
        _industrialParkInjectionPoints.push({
            id: `manual_injection_${added}`,
            name: `Manual Injection ${added}`,
            fieldX: fx,
            fieldY: fy,
            areaM2: 10000,  // Nominal area
            zone: 'pharr_bridge',  // Assign to zone for flow distribution
            zoneShare: 0.10,  // 10% of industrial flow
            zoneRatio: 1.0,
        });
        added++;
    }
    if (added > 0) {
        log(`[BRIDGE] Manual injection points: ${added} added`);
    }
}

function bridgeLotsAndParksToRoads() {
    let lotConnectorCells = 0;
    let parkConnectorCells = 0;

    // ─────────────────────────────────────────────────────────────────────────────
    // LOT BRIDGING: Connect each lot to nearest road
    // ─────────────────────────────────────────────────────────────────────────────
    for (let lotIdx = 0; lotIdx < lotToCellIndices.length; lotIdx++) {
        const lotCells = lotToCellIndices[lotIdx];
        if (lotCells.length === 0) continue;

        // Find centroid of lot
        let sumX = 0, sumY = 0;
        for (const idx of lotCells) {
            sumX += idx % N;
            sumY += Math.floor(idx / N);
        }
        const cx = Math.floor(sumX / lotCells.length);
        const cy = Math.floor(sumY / lotCells.length);
        const lotCentroid = cy * N + cx;

        // Check if already adjacent to road
        let needsBridge = true;
        for (let dy = -2; dy <= 2 && needsBridge; dy++) {
            for (let dx = -2; dx <= 2 && needsBridge; dx++) {
                const nx = cx + dx, ny = cy + dy;
                if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                const ni = ny * N + nx;
                if (regionMap[ni] !== REGION.LOT && (Kxx[ni] > K_ROAD_CHECK || Kyy[ni] > K_ROAD_CHECK)) {
                    needsBridge = false;
                }
            }
        }

        if (!needsBridge) continue;

        // BFS from lot centroid to find nearest road
        const bridgeCells = bfsToRoad(lotCentroid, REGION.LOT);
        for (const idx of bridgeCells) {
            stampConnector(idx, CONNECTOR_RADIUS);
            lotConnectorCells++;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // INDUSTRIAL PARK BRIDGING: Connect injection points to road network
    // ─────────────────────────────────────────────────────────────────────────────
    for (const park of _industrialParkInjectionPoints) {
        const parkIdx = park.fieldY * N + park.fieldX;
        if (parkIdx < 0 || parkIdx >= N2) continue;

        const px = park.fieldX;
        const py = park.fieldY;

        // Check if already on/near road
        let needsBridge = true;
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
        const bridgeCells = bfsToRoad(parkIdx, null);  // null = don't avoid any region
        for (const idx of bridgeCells) {
            stampConnector(idx, 2);  // Wider connector for parks
            parkConnectorCells++;
        }

        // Stamp around injection point itself
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const nx = px + dx, ny = py + dy;
                if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                const ni = ny * N + nx;
                stampConnector(ni, 0);
                parkConnectorCells++;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // CORRIDOR ENTRY BRIDGING: Connect corridor entries to road network
    // ─────────────────────────────────────────────────────────────────────────────
    // Note: corridorEntryPoints may not be initialized yet, so we use CORRIDOR_ENTRY_COORDS
    for (const coord of CORRIDOR_ENTRY_COORDS) {
        const fx = Math.floor(worldToFieldX(coord.x));
        const fy = Math.floor(worldToFieldY(coord.y));
        if (fx < 0 || fx >= N || fy < 0 || fy >= N) continue;

        const entryIdx = fy * N + fx;

        // Check if already on road
        if (Kxx[entryIdx] > K_ROAD_CHECK || Kyy[entryIdx] > K_ROAD_CHECK) continue;

        // BFS to find nearest road
        const bridgeCells = bfsToRoad(entryIdx, null);
        for (const idx of bridgeCells) {
            stampConnector(idx, 2);  // Wider connector for entries
        }

        // Stamp around entry point itself
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const nx = fx + dx, ny = fy + dy;
                if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                const ni = ny * N + nx;
                stampConnector(ni, 0);
            }
        }
    }

    if (lotConnectorCells > 0 || parkConnectorCells > 0) {
        log(`[BRIDGE] Lots: ${lotConnectorCells} cells, Parks: ${parkConnectorCells} cells`);
    }
}

function bfsToRoad(startIdx, avoidRegion) {
    const parent = new Map();
    parent.set(startIdx, -1);
    let frontier = [startIdx];
    let foundCell = -1;
    const MAX_BFS_STEPS = 50000;  // Max cells to search (~2km radius at 17m/cell)
    let steps = 0;

    while (foundCell < 0 && frontier.length > 0 && steps < MAX_BFS_STEPS) {
        const nextFrontier = [];
        for (const idx of frontier) {
            steps++;
            const x = idx % N;
            const y = Math.floor(idx / N);
            const neighbors = [];
            if (x > 0) neighbors.push(idx - 1);
            if (x < N - 1) neighbors.push(idx + 1);
            if (y > 0) neighbors.push(idx - N);
            if (y < N - 1) neighbors.push(idx + N);

            for (const ni of neighbors) {
                if (parent.has(ni)) continue;

                // Found road?
                const isRoad = Kxx[ni] > K_ROAD_CHECK || Kyy[ni] > K_ROAD_CHECK;
                const notAvoid = avoidRegion === null || regionMap[ni] !== avoidRegion;
                if (isRoad && notAvoid) {
                    parent.set(ni, idx);
                    foundCell = ni;
                    break;
                }

                // Continue searching
                // First 50 steps: allow traversing anything (to escape starting lot)
                // After 50 steps: avoid the specified region (don't cut through other lots)
                if (steps <= 50 || notAvoid) {
                    parent.set(ni, idx);
                    nextFrontier.push(ni);
                }
            }
            if (foundCell >= 0) break;
        }
        frontier = nextFrontier;
    }

    if (foundCell < 0 && steps >= MAX_BFS_STEPS) {
        logBuild(`[BRIDGE] BFS exhausted ${MAX_BFS_STEPS} steps from cell ${startIdx}, no road found`);
    }

    // Backtrack to build path
    const path = [];
    if (foundCell >= 0) {
        let current = foundCell;
        while (current >= 0 && parent.get(current) !== -1) {
            path.push(current);
            current = parent.get(current);
        }
    }
    return path;
}

function stampConnector(centerIdx, radius) {
    const cx = centerIdx % N;
    const cy = Math.floor(centerIdx / N);
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
            const ni = ny * N + nx;
            // Don't overwrite lots, parks, or sinks
            if (regionMap[ni] === REGION.LOT || regionMap[ni] === REGION.PARK || regionMap[ni] === REGION.SINK) continue;
            // Stamp conductance
            if (Kxx[ni] < K_CONNECTOR) {
                Kxx[ni] = K_CONNECTOR;
                Kyy[ni] = K_CONNECTOR;
            }
            // Mark as road so Dijkstra includes it
            if (regionMap[ni] === REGION.OFFROAD) {
                regionMap[ni] = REGION.ROAD;
            }
        }
    }
}

function pointInPolygon(x, y, coords) {
    let inside = false;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
        const [xi, yi] = coords[i];
        const [xj, yj] = coords[j];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// Point-in-polygon test for zone polygons (uses {x,y} objects)
function pointInZonePolygon(px, py, polygon) {
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

// Find which industrial zone a point belongs to
function findZoneForPoint(x, y) {
    for (const zone of INDUSTRIAL_ZONES) {
        if (pointInZonePolygon(x, y, zone.polygon)) {
            return zone.id;
        }
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INJECTION POINT WEIGHTS FROM BUNDLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize corridor entry points and compute injection weights from bundle.
 */
function initCorridorEntries() {
    corridorEntryPoints = CORRIDOR_ENTRY_COORDS.map((coord) => ({
        worldX: coord.x,
        worldY: coord.y,
        fieldX: Math.floor(worldToFieldX(coord.x)),
        fieldY: Math.floor(worldToFieldY(coord.y)),
        id: coord.id,
    }));

    log('[CORRIDOR ENTRIES] Initialized', corridorEntryPoints.length, 'entry points:',
        corridorEntryPoints.map(e => `${e.id}(${e.worldX.toFixed(0)}, ${e.worldY.toFixed(0)}) -> field(${e.fieldX}, ${e.fieldY})`).join(', '));

    // Compute injection weights from bundle if available
    if (hasScenarioPair()) {
        // Compute ratios for both scenarios
        _baselineInjectionRatios = computeInjectionWeightsFromBundle(getBaseline(), 'baseline');
        _interserranaInjectionRatios = computeInjectionWeightsFromBundle(getInterserrana(), 'interserrana');
        _injectionPointRatios = _baselineInjectionRatios;  // Default to baseline
    } else if (hasBundle()) {
        _baselineInjectionRatios = computeInjectionWeightsFromBundle(getBundle(), 'baseline');
        _injectionPointRatios = _baselineInjectionRatios;
    } else {
        log('[CORRIDOR ENTRIES] No bundle available - corridor ratios will be 0');
    }

    return corridorEntryPoints;
}

/**
 * Compute injection point weight ratios from CIEN bundle.
 * @param {Object} bundle - CIEN bundle
 * @param {string} label - Label for logging (e.g., 'baseline', 'interserrana')
 * @returns {Map<string, number>} injection point id → ratio [0,1]
 */
function computeInjectionWeightsFromBundle(bundle, label = '') {
    if (!bundle) {
        throw new Error('[INJECTION] No bundle provided - CIEN data required');
    }

    if (!bundle.segment_load_kg_by_poe_hs2) {
        throw new Error('[INJECTION] No segment_load_kg_by_poe_hs2 in bundle - CIEN data required');
    }

    // DEBUG: Check what's in bundle
    console.log('[INJECTION DEBUG]', label, {
        hasGeometry: !!bundle.geometry,
        geometryKeys: bundle.geometry ? Object.keys(bundle.geometry) : null,
        _geometryExternal: bundle._geometryExternal,
        bundleKeys: Object.keys(bundle).slice(0, 10),
    });

    // Get segments with world coordinates from the PASSED bundle (not bundleConsumer.currentBundle)
    const rawSegments = bundle.geometry?.segments_in_roi;
    if (!rawSegments || rawSegments.length === 0) {
        throw new Error('[INJECTION] No segments in ROI - check bundle geometry');
    }
    const worldSegments = rawSegments.map(seg => ({
        segment_id: seg.segment_id,
        points: seg.geometry_coordinates.map(([lat, lon]) => latLonToWorld(lat, lon)),
    }));

    // Build injection points array
    const injectionPoints = CORRIDOR_ENTRY_COORDS.map(c => ({
        x: c.x,
        y: c.y,
        id: c.id,
    }));

    // Log flow totals for verification
    const pharrFlowKg = bundle.flow_kg_by_poe?.hidalgo_pharr;
    if (pharrFlowKg) {
        log(`[INJECTION ${label}] Flow totals: hidalgo_pharr = ${(pharrFlowKg / 1e9).toFixed(2)}B kg/year`);
    }

    // Match segments using world coordinates
    const result = computeInjectionPointWeightsFromWorldSegments(
        bundle,
        worldSegments,
        injectionPoints,
        500,  // 500m threshold
        'hidalgo_pharr'
    );

    const totalMatched = result.matched;
    const matchedKg = Array.from(result.weights.values()).reduce((a, b) => a + b, 0);

    log(`[INJECTION ${label}] Matched ${totalMatched} segments (${(matchedKg / 1e9).toFixed(2)}B kg)`);

    // Log per-entry weights
    for (const [id, kg] of result.weights) {
        const pct = matchedKg > 0 ? (kg / matchedKg * 100).toFixed(1) : 0;
        log(`  ${id}: ${(kg / 1e9).toFixed(2)}B kg (${pct}%)`);
    }

    if (totalMatched === 0) {
        throw new Error('[INJECTION] No segments matched corridor entry points - check CORRIDOR_ENTRY_COORDS vs bundle segments');
    }

    const ratios = getInjectionPointRatios(result.weights);
    log(`[INJECTION ${label}] Ratios:`, Object.fromEntries(ratios));
    return ratios;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE COMPUTATION — Where mass enters
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute source injection field using:
 * 1. Corridor entry points with CIEN-derived ratios (64.7% of flow)
 * 2. Industrial park centroids with zone-based ratios (35.3% of flow)
 */
function computeSources() {
    sourceField.fill(0);
    sourceCellIndices = [];
    _cellToSourceType.clear();  // Reset source type mapping
    _sourcePhaseOffset.clear();  // Reset pulse phase offsets

    // sourceField stores SHARES (0-1) that sum to 1.0
    // At runtime, stepInjection multiplies: share × (CIEN_hourly_kg / 3600)

    // Split between corridors and industrial parks
    const hasIndustrialParks = _industrialParkInjectionPoints.length > 0;
    const corridorShare = hasIndustrialParks ? CORRIDOR_TRAFFIC_RATIO : 1.0;  // 64.7% or 100%
    const industrialShare = hasIndustrialParks ? REYNOSA_LOCAL_RATIO : 0;     // 35.3% or 0%

    // 1. Corridor entry points (through-traffic from south)
    if (corridorEntryPoints.length > 0) {
        for (const entry of corridorEntryPoints) {
            // CIEN-derived ratio is required - no fallback
            if (!_injectionPointRatios || !_injectionPointRatios.has(entry.id)) {
                throw new Error(`[SOURCES] Missing CIEN ratio for corridor ${entry.id} - check segment_load_kg_by_poe_hs2`);
            }
            const ratio = _injectionPointRatios.get(entry.id);
            const share = corridorShare * ratio;

            let idx = entry.fieldY * N + entry.fieldX;
            if (idx >= 0 && idx < N2) {
                sourceField[idx] = (sourceField[idx] || 0) + share;
                sourceCellIndices.push(idx);
                // Map source type: MTY (west) or Victoria (east)
                const srcType = entry.id === 'ENTRY_MTY' ? SOURCE_TYPE.CORRIDOR_WEST : SOURCE_TYPE.CORRIDOR_EAST;
                _cellToSourceType.set(idx, srcType);
                // Record pulse phase offset for this corridor
                const phaseOffset = CORRIDOR_PHASE_OFFSETS[entry.id] ?? 0;
                _sourcePhaseOffset.set(idx, phaseOffset);
            }
        }
        log(`[SOURCES] Corridor entries: ${corridorEntryPoints.length} points, ${(corridorShare * 100).toFixed(1)}% of flow`);
    }

    // 2. Industrial park centroids (Reynosa-local exports)
    // Each park gets: industrialShare × zoneShare × zoneRatio
    if (hasIndustrialParks) {
        let parksInjected = 0;
        let parksWired = 0;
        const zoneShares = {};
        for (const park of _industrialParkInjectionPoints) {
            const share = industrialShare * park.zoneShare * park.zoneRatio;
            let idx = park.fieldY * N + park.fieldX;
            if (idx >= 0 && idx < N2) {
                sourceField[idx] = (sourceField[idx] || 0) + share;
                sourceCellIndices.push(idx);
                _cellToSourceType.set(idx, SOURCE_TYPE.INDUSTRIAL);  // Industrial source

                // Record pulse phase offset for this zone
                const phaseOffset = ZONE_PHASE_OFFSETS[park.zone] ?? 0;
                _sourcePhaseOffset.set(idx, phaseOffset);

                // Source cells are now mapped via cellToParkIndex (merged with regular parks)
                // No separate mapping needed

                parksInjected++;
                zoneShares[park.zone] = (zoneShares[park.zone] || 0) + share;
            }
        }
        log(`[SOURCES] Industrial parks: ${parksInjected} points, ${parksWired} wired to holding zones, ${(industrialShare * 100).toFixed(1)}% of flow`);
        for (const [zone, share] of Object.entries(zoneShares)) {
            log(`  ${zone}: ${(share * 100).toFixed(2)}%`);
        }
    }

    // 3. Fallback if no corridor entries and no industrial parks
    if (corridorEntryPoints.length === 0 && !hasIndustrialParks) {
        // Fallback: inject at southern road cells (edge of grid)
        const minDistFromLot = 10;
        for (const idx of roadCellIndices) {
            const x = idx % N;
            const y = Math.floor(idx / N);

            let nearLot = false;
            for (let dy = -minDistFromLot; dy <= minDistFromLot && !nearLot; dy++) {
                for (let dx = -minDistFromLot; dx <= minDistFromLot && !nearLot; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
                    const ni = ny * N + nx;
                    if (regionMap[ni] === REGION.LOT) {
                        nearLot = true;
                    }
                }
            }

            const isEdge = x <= 2 || x >= N - 3 || y <= 2 || y >= N - 3;
            if (!nearLot && isEdge && phi_lots[idx] < PHI_LARGE) {
                sourceCellIndices.push(idx);
                // Fallback sources use zero phase offset (random-ish due to per-source jitter)
                _sourcePhaseOffset.set(idx, 0);
            }
        }

        // Equal shares for fallback sources
        if (sourceCellIndices.length > 0) {
            const perSourceShare = 1.0 / sourceCellIndices.length;
            for (const idx of sourceCellIndices) {
                sourceField[idx] = perSourceShare;
            }
        }
        log(`[SOURCES] Fallback: ${sourceCellIndices.length} edge sources, equal shares`);
    }

    // Log total shares (should sum to ~1.0)
    let totalShare = 0;
    for (const idx of sourceCellIndices) {
        totalShare += sourceField[idx];
    }
    log(`[SOURCES] Total: ${sourceCellIndices.length} sources, shares sum to ${totalShare.toFixed(3)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL SPECIFICATION — Live telemetry with tree breakdowns
// ═══════════════════════════════════════════════════════════════════════════════

// Capitalize zone names for display
function capitalizeZone(zone) {
    const names = {
        'norte': 'Norte',
        'poniente': 'Poniente',
        'san_fernando': 'San Fernando',
        'pharr_bridge': 'Pharr Bridge'
    };
    return names[zone] || zone;
}

/**
 * Live mass counter (for frame-by-frame updates)
 * Returns mass currently in system in metric tonnes
 */
export function getLiveMassInSystemT() {
    return (metrics.injected - metrics.exited) / 1e3;
}

/**
 * Model specification for stacked telemetry overlays.
 * Returns array of { key, value, live?, indent?, tree? } for sequential display.
 *
 * Tree types:
 *   'tree'      → ├ prefix
 *   'tree-last' → └ prefix
 *   'tree-cont' → │ prefix (continuation line)
 */
export function getModelSpec() {
    const shares = getSourceShares();
    const massInSystemKg = metrics.injected - metrics.exited;
    const massInSystemT = massInSystemKg / 1e3;

    // Find corridors by ID
    const corridorMTY = shares.corridors.find(c => c.id === 'ENTRY_MTY');
    const corridorVIC = shares.corridors.find(c => c.id === 'ENTRY_VICTORIA');

    // Build industrial zone breakdown
    const zoneItems = shares.industrialByZone.map((z, i, arr) => ({
        key: `orig_${z.zone}`,
        value: `${capitalizeZone(z.zone)}: ${z.pct}`,
        indent: 2,
        tree: i === arr.length - 1 ? 'tree-last' : 'tree'
    }));

    return [
        // ─── Live counter ───
        { key: 'mass', value: `${massInSystemT.toFixed(0)} t en el sistema`, live: true },

        // ─── Unit ───
        { key: 'unit', value: 'Unidad: Camión (9t)' },

        // ─── Segmentation tree ───
        { key: 'seg_header', value: 'Segmentación:' },
        { key: 'seg_hora', value: 'Hora: 24 pesos horarios', indent: 1, tree: 'tree', syncPoint: 'HOURLY_TABLE_START' },
        { key: 'seg_transfer', value: `NecesidadTransfer: ${(TRANSFER_REQUIREMENT_FRACTION * 100).toFixed(0)}% restringido`, indent: 1, tree: 'tree', syncPoint: 'STATE_MODE_START' },
        { key: 'seg_frio', value: `Frío: ${(COLD_CHAIN_FRACTION * 100).toFixed(0)}% (36-48h)`, indent: 2, tree: 'tree' },
        { key: 'seg_seco', value: `Seco: ${((1 - COLD_CHAIN_FRACTION) * 100).toFixed(0)}% (48-72h)`, indent: 2, tree: 'tree-last', syncPoint: 'STATE_MODE_END' },
        { key: 'seg_hs2', value: 'HS2: 98 códigos', indent: 1, tree: 'tree-last', syncPoint: 'HOURLY_TABLE_END' },

        // ─── Granularity ───
        { key: 'granularity', value: 'Granularidad: Camión × Hora × NecesidadTransfer × HS2' },

        // ─── Origins tree ───
        { key: 'origins_header', value: 'Orígenes:', syncPoint: 'SOURCE_MODE_START' },
        { key: 'orig_mty', value: `Corredor MTY: ${corridorMTY?.pct || '[NO DATA - check console]'}`, indent: 1, tree: 'tree' },
        { key: 'orig_vic', value: `Corredor Victoria: ${corridorVIC?.pct || '[NO DATA - check console]'}`, indent: 1, tree: 'tree' },
        { key: 'orig_local', value: `Manufactura Local: ${(shares.industrialTotal * 100).toFixed(1)}%`, indent: 1, tree: 'tree-last', groupStart: 'manufactura' },
        // Industrial zone breakdown (batched with orig_local)
        ...zoneItems.map((z, i, arr) => ({ ...z, group: 'manufactura', groupEnd: i === arr.length - 1 })),

        // ─── Standard fields ───
        { key: 'assignment', value: 'Asignación: Dijkstra distancia en red', syncPoint: 'PHI_DEBUG_START' },
        { key: 'direction', value: 'Sentido: Sur → Norte' },
        { key: 'period', value: 'Período: 2024–2025', syncPoint: 'PHI_DEBUG_END' },

        // ─── Local-specific ───
        { key: 'resolution', value: `Resolución: ${N}×${N}, ${roi.cellSize.toFixed(1)}m/celda` },
        { key: 'congestion', value: `Congestión: Greenshields p=${CONGESTION_P}`, syncPoint: 'COMMUTER_DEBUG_START' },
        { key: 'calibration', value: 'Calibración: Ingeniería de Tránsito 2023, Contadores Neumáticos', syncPoint: 'COMMUTER_DEBUG_END' },
        // ─── Infraestructura Aduanal Pte Pharr ───
        { key: 'infra_header', value: 'Infraestructura Aduanal Pte Pharr:', syncPoint: 'PHARR_INFRA_START' },
        { key: 'infra_carriles', value: `${Math.floor(3 * _twinSpanCapMult)} carriles Sur a Norte`, indent: 1, tree: 'tree' },
        { key: 'infra_cbp', value: `${getEffectiveLanes()} andenes de inspección CBP`, indent: 1, tree: 'tree-last' },
        { key: 'lots', value: `Lotes: ${lotCapacity.length}, ${(lotCapacity.reduce((a, b) => a + b, 0) / 1e6).toFixed(1)}M kg cap`, syncPoint: 'LOTS' },
    ];
}

/**
 * Flat object version for programmatic access.
 */
export function getModelSpecFlat() {
    return {
        // Scale
        annualMt: dailyTotalKg > 0 ? dailyTotalKg * 365 / 1e12 : 0,
        dailyKg: dailyTotalKg,
        roiSizeKm: roi.sizeM / 1000,
        gridResolution: N,
        cellSizeM: roi.cellSize,

        // Counts
        roadCells: roadCellIndices.length,
        lotCells: lotCellIndices.length,
        parkCells: parkCellIndices.length,
        sourceCells: sourceCellIndices.length,
        lotCount: lotCapacity.length,
        totalLotCapacityKg: lotCapacity.reduce((a, b) => a + b, 0),

        // Particle semantics
        truckKg: TRUCK_KG,

        // Dwell model
        coldChainFraction: COLD_CHAIN_FRACTION,

        // Traffic split
        corridorRatio: CORRIDOR_TRAFFIC_RATIO,
        industrialRatio: REYNOSA_LOCAL_RATIO,
        transferRequirement: TRANSFER_REQUIREMENT_FRACTION,

        // Congestion model
        congestionP: CONGESTION_P,
        freeFlowSpeedKph: FREE_FLOW_SPEED_KPH,

        // Bridge
        cbpLanes: getEffectiveLanes(),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG — Console inspection
// ═══════════════════════════════════════════════════════════════════════════════

export function getMetrics() {
    return {
        ...metrics,
        stalledMassKg: _stalledMassKg,      // Congestion-stalled mass this frame
        stallTonHours: _stallTonHours,       // Accumulated stall-ton-hours
        truckHoursLost: _truckHoursLost,     // Cumulative truck-hours lost to congestion
        truckHoursLostRate: _truckHoursLostRate,  // Current loss rate (truck-hours/sim-hour)
        sinkQueueKg: sinkQueue.length * TRUCK_KG,
        lotQueueKg: conversionQueue.length * TRUCK_KG,
    };
}

/**
 * Phase 1 headless metrics surface.
 * NOTE: injected/exited are ALREADY in kg (increment by TRUCK_KG internally).
 * Do NOT multiply by 9000.
 */
export function getMetricsPhase1() {
    // Count particles currently in DEPARTING state
    let departingCount = 0;
    for (let i = 0; i < _activeParticleCount; i++) {
        if (_activeParticles[i].state === STATE.DEPARTING) {
            departingCount++;
        }
    }

    return {
        injectedKg: metrics.injected,              // kg
        exitedKg: metrics.exited,                  // kg
        activeParticles: _activeParticleCount,     // count
        departingParticles: departingCount,        // count (already in exited, still in activeParticles)
        truckHoursLost: _truckHoursLost,           // cumulative truck-hours
        truckHoursLostRate: _truckHoursLostRate,   // truck-hours / sim-hour
        // Truck-hours lost breakdown (instrumentation)
        truckHoursLostCongestion: _truckHoursLostCongestion,  // normal road congestion
        truckHoursLostLotWait: _truckHoursLostLotWait,        // waiting outside full lots
        truckHoursLostBridgeQueue: _truckHoursLostBridgeQueue, // waiting in CBP queue (pre-service)
        truckHoursLostBridgeService: _truckHoursLostBridgeService, // being serviced in CBP lane
        stallTonHours: _stallTonHours,             // cumulative ton-hours
        simTime: simTime,                          // current sim time (debug)
        // Sink observability (for drain invariant)
        sinkOpen: isBridgeOpen(),
        sinkQueueCount: sinkQueue.length,
        sinkCapKgPerHour: sinkCapKgPerHour,
        cbpLanesInUse: CBP_LANES.filter(l => l.particle !== null).length,
        // Instrumentation counters (for dt-invariance bisection)
        phiRebuilds: _phiRebuildCount,
        lotExclusions: _lotExclusionCount,
        cooldownExpiries: _cooldownExpiryCount,
        cbpCompletions: _cbpCompletionCount,
        spawns: _spawnCount,
        intersectionBlocks: _intersectionBlockCount,
        // Departing particle tracking (invariant: cbpCompletions == departedCount + departingCount)
        departedCount: _departedCount,             // particles that completed departure animation
        departingCount: departingCount,            // particles currently animating departure
        // Lot capacity (static per scenario, for structural comparison)
        totalLotCapacityKg: lotCapacity.reduce((sum, cap) => sum + cap, 0),
        // Per-lot fill ratios (for replay animation)
        lotFillRatios: Array.from(lotMass).map((m, i) =>
            lotCapacity[i] > 0 ? m / lotCapacity[i] : 0),
        // AUDIT: Service time stats (seconds)
        serviceTimeStats: computeServiceTimeStats(),
        // Current SERVICE_TIME_S (for verification)
        currentServiceTimeS: SERVICE_TIME_S,
        effectiveLanes: getEffectiveLanes(),
    };
}

/**
 * Compute mean/p50/p90 for service time arrays.
 * Returns stats in seconds.
 */
function computeServiceTimeStats() {
    const n = _serviceTimeActual.length;
    if (n === 0) {
        return { count: 0, actual: { mean: 0, p50: 0, p90: 0 }, expected: { mean: 0, p50: 0, p90: 0 } };
    }

    const sortedActual = [..._serviceTimeActual].sort((a, b) => a - b);
    const sortedExpected = [..._serviceTimeExpected].sort((a, b) => a - b);

    const meanActual = _serviceTimeActual.reduce((a, b) => a + b, 0) / n;
    const meanExpected = _serviceTimeExpected.reduce((a, b) => a + b, 0) / n;

    const p50Idx = Math.floor(n * 0.5);
    const p90Idx = Math.floor(n * 0.9);

    return {
        count: n,
        actual: {
            mean: meanActual,
            p50: sortedActual[p50Idx],
            p90: sortedActual[p90Idx],
        },
        expected: {
            mean: meanExpected,
            p50: sortedExpected[p50Idx],
            p90: sortedExpected[p90Idx],
        },
    };
}

/**
 * Phase 1 mass invariant assertion.
 * LHS: injected - exited (net kg in system)
 * RHS: activeParticles * particleMass() (computed from particle count)
 * Tolerance: 10,000 kg (allows for in-flight queues)
 */
export function assertMassInvariantPhase1() {
    const lhs = metrics.injected - metrics.exited;
    const rhs = _activeParticleCount * particleMass();
    if (Math.abs(lhs - rhs) > 10000 * _stressMultiplier) {
        throw new Error(`[INVARIANT] Mass violated: injected-exited=${lhs} vs particles*kg=${rhs}`);
    }
}

/**
 * Departing particle invariant assertion.
 * CBP completions = departed count + in-flight DEPARTING particles
 * This ensures 1:1 correspondence between CBP processing and exit animation.
 */
export function assertDepartingInvariant() {
    let departingCount = 0;
    for (let i = 0; i < _activeParticleCount; i++) {
        if (_activeParticles[i].state === STATE.DEPARTING) {
            departingCount++;
        }
    }
    const expected = _departedCount + departingCount;
    if (_cbpCompletionCount !== expected) {
        throw new Error(`[INVARIANT] Departing mismatch: cbpCompletions=${_cbpCompletionCount} != departed=${_departedCount} + inFlight=${departingCount} (${expected})`);
    }
}

export function getLotStats() {
    const result = [];
    for (let i = 0; i < lotCapacity.length; i++) {
        result.push({
            lotIdx: i,
            mass: lotMass[i],
            capacity: lotCapacity[i],
            utilization: lotCapacity[i] > 0 ? lotMass[i] / lotCapacity[i] : 0,
        });
    }
    return result;
}

/**
 * Get aggregated lot state for logging heartbeat.
 * Returns counts of lots by admission state.
 */
export function getLotState() {
    let available = 0, draining = 0, blocked = 0;
    for (let i = 0; i < lotCapacity.length; i++) {
        if (lotCapacity[i] <= 0) continue;
        if (lotDraining.has(i)) {
            draining++;
            continue;
        }
        if (lotCooldownEndSimS[i] > 0 && simTime < lotCooldownEndSimS[i]) {
            blocked++;
            continue;
        }
        const fill = lotMass[i] / lotCapacity[i];
        if (fill >= _lotAdmissionCutoff) {
            blocked++;
        } else {
            available++;
        }
    }
    return { available, draining, blocked };
}

/**
 * Get source injection shares breakdown.
 * Corridors use CIEN hourly profile, Industrial uses 3-shift pattern.
 */
export function getSourceShares() {
    // DIAGNOSTIC - trace what we're working with
    if (corridorEntryPoints.length === 0) {
        console.warn('[getSourceShares] corridorEntryPoints is EMPTY!');
        console.warn('[getSourceShares] This means initCorridorEntries() was not called or failed');
    }

    const currentHour = Math.floor(simTime / 3600) % 24;
    const corridors = [];
    const industrial = [];
    let totalShare = 0;

    // Corridor rates (CIEN hourly)
    const corridorKgPerS = inflowKgPerHour / 3600;

    // Industrial rates (shift pattern)
    const shiftFraction = getIndustrialShiftFraction(currentHour);
    const industrialDailyKg = dailyTotalKg * REYNOSA_LOCAL_RATIO;
    const industrialKgPerS = industrialDailyKg * shiftFraction / 3600;

    // Determine current shift name and progress
    let shiftName = 'night';
    let shiftStart;
    if (currentHour >= 6 && currentHour < 14) {
        shiftName = 'day';
        shiftStart = 6;
    } else if (currentHour >= 14 && currentHour < 22) {
        shiftName = 'evening';
        shiftStart = 14;
    } else {
        shiftStart = (currentHour >= 22) ? 22 : -2;  // Night wraps around midnight
    }

    // Compute trapezoid progress and multiplier
    let progressInShift;
    if (shiftStart === -2) {
        progressInShift = (currentHour + 2) / 8;
    } else if (shiftStart === 22) {
        progressInShift = (currentHour - 22) / 8;
    } else {
        progressInShift = (currentHour - shiftStart) / 8;
    }
    const trapezoidMultiplier = getTrapezoidMultiplier(progressInShift);
    const boundaryBias = getShiftBoundaryBias(currentHour);

    // Interpolate corridor ratios based on scenario alpha
    const hasInterpolation = _baselineInjectionRatios && _interserranaInjectionRatios && _scenarioAlpha > 0;

    for (const entry of corridorEntryPoints) {
        // Compute interpolated ratio for this corridor
        let ratio;
        if (hasInterpolation) {
            const baseRatio = _baselineInjectionRatios.get(entry.id) || 0;
            const interRatio = _interserranaInjectionRatios.get(entry.id) || 0;
            ratio = baseRatio * (1 - _scenarioAlpha) + interRatio * _scenarioAlpha;
        } else {
            ratio = _baselineInjectionRatios?.get(entry.id) || _injectionPointRatios?.get(entry.id) || 0;
        }

        const share = CORRIDOR_TRAFFIC_RATIO * ratio;
        const rateKgS = ratio * corridorKgPerS * CORRIDOR_TRAFFIC_RATIO;
        corridors.push({
            id: entry.id,
            share,
            pct: (share * 100).toFixed(2) + '%',
            cienRatio: ratio,
            rateKgS,
        });
        totalShare += share;
    }

    for (const park of _industrialParkInjectionPoints) {
        const idx = park.fieldY * N + park.fieldX;
        const share = sourceField[idx] || 0;
        const normalizedShare = share / REYNOSA_LOCAL_RATIO;
        const rateKgS = normalizedShare * industrialKgPerS;
        industrial.push({
            zone: park.zone,
            name: park.name,
            share,
            pct: (share * 100).toFixed(2) + '%',
            rateKgS,
        });
        totalShare += share;
    }

    // Group industrial by zone
    const byZone = {};
    for (const p of industrial) {
        if (!byZone[p.zone]) byZone[p.zone] = { share: 0, rateKgS: 0 };
        byZone[p.zone].share += p.share;
        byZone[p.zone].rateKgS += p.rateKgS;
    }

    return {
        currentHour,
        shiftName,
        shiftFraction,
        // Trapezoid and boundary bias components
        progressInShift,
        trapezoidMultiplier,
        boundaryBias,
        // Totals
        corridorTotal: CORRIDOR_TRAFFIC_RATIO,
        industrialTotal: REYNOSA_LOCAL_RATIO,
        corridors,
        industrialByZone: Object.entries(byZone).map(([zone, data]) => ({
            zone,
            share: data.share,
            pct: (data.share * 100).toFixed(2) + '%',
            rateKgS: data.rateKgS,
        })),
        totalShare,
        corridorKgPerS,
        industrialKgPerS,
        dailyTotalKg,
    };
}

/**
 * Print source shares to console in readable format.
 */
export function printSourceShares() {
    const s = getSourceShares();
    console.log('═══════════════════════════════════════════════════════════');
    console.log('SOURCE INJECTION SHARES');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Hour ${s.currentHour} | Shift: ${s.shiftName.toUpperCase()} (${(s.shiftFraction * 100).toFixed(1)}%/hr of daily industrial)`);
    console.log(`Daily total: ${(s.dailyTotalKg / 1e6).toFixed(2)}M kg`);
    console.log('');
    console.log('INDUSTRIAL SHIFT MECHANICS (PRIOR):');
    console.log(`  Progress in shift: ${(s.progressInShift * 100).toFixed(0)}% (0%=start, 100%=end)`);
    console.log(`  Trapezoid mult:    ${s.trapezoidMultiplier.toFixed(2)} (ramp 0→1→0)`);
    console.log(`  Boundary bias:     ${s.boundaryBias.toFixed(2)} (1.0 = no boost, 1.25 = max boost at shift end)`);
    console.log('');
    console.log(`CORRIDORS (${(s.corridorTotal * 100).toFixed(1)}% of daily) - CIEN hourly profile:`);
    console.log(`  Total: ${(s.corridorKgPerS * s.corridorTotal).toFixed(1)} kg/s this hour`);
    for (const c of s.corridors) {
        console.log(`    ${c.id}: ${c.pct} → ${c.rateKgS.toFixed(1)} kg/s`);
    }
    console.log('');
    console.log(`INDUSTRIAL (${(s.industrialTotal * 100).toFixed(1)}% of daily) - 3-shift pattern:`);
    console.log(`  Total: ${s.industrialKgPerS.toFixed(1)} kg/s this hour (${s.shiftName} shift)`);
    for (const z of s.industrialByZone) {
        console.log(`    ${z.zone}: ${z.pct} → ${z.rateKgS.toFixed(1)} kg/s`);
    }
    console.log('');
    console.log(`SHARES SUM: ${(s.totalShare * 100).toFixed(2)}% (should be ~100%)`);
    console.log('═══════════════════════════════════════════════════════════');
}

export function getParticleCount() {
    let count = 0;
    for (let i = 0; i < N2; i++) {
        count += cellParticles[i].length;
    }
    return count;
}

export function getStallStats() {
    const stats = {
        total: 0,
        dead_end: 0,
        lot_full: 0,
        pre_lot_hold: 0,
        road_full: 0,
        moving: 0,
    };
    for (let i = 0; i < N2; i++) {
        for (const p of cellParticles[i]) {
            stats.total++;
            if (p.stallReason === 'dead_end') stats.dead_end++;
            else if (p.stallReason === 'lot_full') stats.lot_full++;
            else if (p.stallReason === 'pre_lot_hold') stats.pre_lot_hold++;
            else if (p.stallReason === 'road_full') stats.road_full++;
            else stats.moving++;
        }
    }
    return stats;
}

export function getTotalMass() {
    let total = 0;
    for (let i = 0; i < N2; i++) {
        total += cellMass[i];
    }
    return total;
}

export function checkAllInvariants() {
    let violations = 0;
    
    for (let i = 0; i < N2; i++) {
        if (cellMass[i] > 0 || cellParticles[i].length > 0) {
            try {
                assertCellInvariant(i, 'check');
            } catch (e) {
                console.error(e.message);
                violations++;
            }
        }
    }
    
    for (let i = 0; i < lotCapacity.length; i++) {
        try {
            assertLotInvariant(i, 'check');
        } catch (e) {
            console.error(e.message);
            violations++;
        }
    }
    
    try {
        assertGlobalInvariant('check');
    } catch (e) {
        console.error(e.message);
        violations++;
    }
    
    console.log(`[CHECK] ${violations} violations`);
    return violations;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESSURE TEST — Verify invariants under stress
// ═══════════════════════════════════════════════════════════════════════════════

export function runPressureTest() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('PRESSURE TEST: Unified Physics');
    console.log('═══════════════════════════════════════════════════════════');
    
    reset();
    
    // Create fake road network (diagonal line)
    for (let i = 0; i < N; i++) {
        const idx = i * N + i;
        Kxx[idx] = 1;
        Kyy[idx] = 1;
        regionMap[idx] = REGION.ROAD;
        roadCellIndices.push(idx);
    }
    
    // Create fake lot at center
    const lotCells = [];
    const centerIdx = Math.floor(N / 2) * N + Math.floor(N / 2);
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            const idx = centerIdx + dy * N + dx;
            lotCells.push(idx);
            cellToLotIndex[idx] = 0;
            regionMap[idx] = REGION.LOT;
            Kxx[idx] = 0.4;
            Kyy[idx] = 0.4;
        }
    }
    lotToCellIndices = [lotCells];
    lotCellIndices = lotCells;
    lotCapacity = new Float32Array([100 * TRUCK_KG]);  // 100 trucks
    lotMass = new Float32Array([0]);
    lotCooldownEndSimS = new Float64Array(1);
    lotDraining.clear();

    // Create sink at corner
    const sinkIdx = (N - 1) * N + (N - 1);
    sinkCellIndices = [sinkIdx];
    regionMap[sinkIdx] = REGION.SINK;
    
    // Build routing (PHARR first for lot sink bias)
    computePotential(sinkCellIndices, phi_pharr, 'PHARR');
    buildNextHop(phi_pharr, nextHop_pharr, 'PHARR');
    computePotential(lotCells, phi_lots, 'LOTS', phi_pharr, LOT_SINK_BIAS_WEIGHT);
    buildNextHop(phi_lots, nextHop_lots);
    
    // Create source at other corner
    const sourceIdx = 0;
    sourceField[sourceIdx] = TRUCK_KG * 10;  // 10 trucks/s
    sourceCellIndices = [sourceIdx];
    
    let passed = 0;
    let failed = 0;
    
    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.error(`✗ ${name}: ${e.message}`);
            failed++;
        }
    }
    
    // Test 1: Injection
    test('Injection creates mass + particle atomically', () => {
        const before = getParticleCount();
        injectParticle(sourceIdx);
        const after = getParticleCount();
        if (after !== before + 1) throw new Error(`Count: ${before} → ${after}`);
        checkAllInvariants();
    });
    
    // Test 2: Movement
    test('Movement preserves mass', () => {
        const beforeMass = getTotalMass();
        for (let i = 0; i < 10; i++) step(0.1);
        const afterMass = getTotalMass();
        if (Math.abs(beforeMass - afterMass) > TRUCK_KG) {
            throw new Error(`Mass: ${beforeMass} → ${afterMass}`);
        }
    });
    
    // Test 3: Lot capacity
    test('Lot capacity is respected', () => {
        // Run until lot should be full
        for (let i = 0; i < 200; i++) step(0.1);
        const stats = getLotStats()[0];
        if (stats.mass > stats.capacity * 1.01) {
            throw new Error(`Lot over capacity: ${stats.mass}/${stats.capacity}`);
        }
    });
    
    // Test 4: No invariant violations
    test('No invariant violations', () => {
        const violations = checkAllInvariants();
        if (violations > 0) throw new Error(`${violations} violations`);
    });
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log('═══════════════════════════════════════════════════════════');
    
    return { passed, failed };
}

// Install console helpers
if (typeof window !== 'undefined') {
    window.reynosaMetrics = getMetrics;
    window.reynosaLots = getLotStats;
    window.reynosaCheck = checkAllInvariants;
    window.reynosaParticles = getParticleCount;
    window.reynosaMass = getTotalMass;
    window.reynosaTest = runPressureTest;
    window.reynosaStalls = getStallStats;
}

// ───────────────────────────────────────────────────────────────────────────────
// COMPATIBILITY EXPORTS (for testbundle.html)
// ───────────────────────────────────────────────────────────────────────────────

let _localScenario = {};
let _phiRebuilding = false;

export function setLocalScenario(scenario) {
    _localScenario = { ..._localScenario, ...scenario };
}

/**
 * Set scenario interpolation alpha (0 = baseline, 1 = interserrana).
 * Call this when the scenario toggle changes.
 */
export function setScenarioAlpha(alpha) {
    _scenarioAlpha = Math.max(0, Math.min(1, alpha));
    // Force reload inflow on next tick
    _lastInflowHour = -1;
    _dailyTotalLoaded = false;
}

/**
 * Set twin span capacity multiplier (1.0 = single span, 2.0 = twin span active).
 * When activated, stamps twin span road cells and enables dual-path routing.
 * When deactivated, unstamps cells and reverts to single-path routing.
 */
export async function setTwinSpanCapacityMultiplier(mult) {
    const newMult = Math.max(1, Math.min(2, mult));
    const wasActive = _twinSpanActive;
    const willBeActive = newMult > 1;

    _twinSpanCapMult = newMult;

    // Stamp/unstamp twin span road when activation changes
    if (willBeActive && !wasActive) {
        stampTwinSpanRoad();
        _twinSpanActive = true;
        log(`[TWIN_SPAN] Activated - ${_twinSpanCellIndices.length} cells, triggering routing rebuild`);
        // Force static routing to recompute
        _staticRoutingReady = false;
        // Actually trigger the routing rebuild
        await buildRouting();
    } else if (!willBeActive && wasActive) {
        unstampTwinSpanRoad();
        _twinSpanActive = false;
        phi_pharr_twin.fill(PHI_LARGE);
        nextHop_pharr_twin.fill(-1);
        log(`[TWIN_SPAN] Deactivated - triggering routing rebuild`);
        _staticRoutingReady = false;
        await buildRouting();
    }

    // Force reload capacity on next tick
    _lastGateCapHour = -1;
}

/**
 * Set twin span road segments for LOCAL view rendering.
 * @param {Array<{x: number, y: number}>[]} segments - Array of polylines (each is array of points)
 * @param {number} alpha - Visibility (0 = hidden, 1 = fully visible)
 */
export function setTwinSpanSegments(segments, alpha) {
    _twinSpanAlpha = Math.max(0, Math.min(1, alpha));

    if (!segments || segments.length === 0 || alpha < 0.01) {
        _twinSpanPath = null;
        _twinSpanSegments = null;
        return;
    }

    // Store segments for offset calculation
    _twinSpanSegments = segments;

    _twinSpanPath = new Path2D();
    for (const seg of segments) {
        if (!seg || seg.length < 2) continue;
        _twinSpanPath.moveTo(seg[0].x, seg[0].y);
        for (let i = 1; i < seg.length; i++) {
            _twinSpanPath.lineTo(seg[i].x, seg[i].y);
        }
    }
}

/**
 * Compute X coordinate on twin span path for a given Y position.
 * Returns the X coordinate on the twin span path, or null if Y is out of range.
 */
function getTwinSpanXAtY(y) {
    if (!_twinSpanSegments || _twinSpanSegments.length === 0) {
        return null;
    }

    // Search all segments for the one containing this Y value
    for (const seg of _twinSpanSegments) {
        if (!seg || seg.length < 2) continue;

        // Find the two points that bracket this Y value
        for (let i = 0; i < seg.length - 1; i++) {
            const p0 = seg[i];
            const p1 = seg[i + 1];
            
            // Check if Y is between these two points (handle both directions)
            const yMin = Math.min(p0.y, p1.y);
            const yMax = Math.max(p0.y, p1.y);
            
            if (y >= yMin && y <= yMax) {
                // Interpolate X based on Y
                const dy = p1.y - p0.y;
                if (Math.abs(dy) < 0.001) {
                    // Nearly horizontal segment, use average X
                    return (p0.x + p1.x) / 2;
                }
                const t = (y - p0.y) / dy;
                const x = p0.x + t * (p1.x - p0.x);
                return x;
            }
        }
    }

    // Y is outside all segments
    return null;
}

// Queue zone: 95m on each side of the bridge approach polyline (190m total width)
// This is the bridge approach geometry - always available, independent of TwinSpan activation
const QUEUE_ZONE_HALF_WIDTH = 95;
const QUEUE_ZONE_SEGMENTS = [
    // Approach segment: south start -> junction
    [
        { x: -363.6711606637666, y: -2694.9719926976927 },   // approach start (south)
        { x: -481.6711606637666, y: -2583.9719926976927 },   // junction
    ],
    // Bridge segment: junction -> north end
    [
        { x: -481.6711606637666, y: -2583.9719926976927 },   // junction
        { x: 236.39229354591248, y: 2212.2113236596624 },    // bridge end (north)
    ],
];

/**
 * Check if a point (x, y) is within the queue zone (within 95m of bridge approach polyline).
 * Uses point-to-segment distance for each segment in the polyline.
 */
function isInQueueZone(x, y) {
    for (const seg of QUEUE_ZONE_SEGMENTS) {
        if (!seg || seg.length < 2) continue;

        for (let i = 0; i < seg.length - 1; i++) {
            const p0 = seg[i];
            const p1 = seg[i + 1];

            // Point-to-segment distance
            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            const lenSq = dx * dx + dy * dy;

            let dist;
            if (lenSq < 0.001) {
                // Degenerate segment (single point)
                dist = Math.sqrt((x - p0.x) ** 2 + (y - p0.y) ** 2);
            } else {
                // Project point onto segment, clamped to [0,1]
                const t = Math.max(0, Math.min(1, ((x - p0.x) * dx + (y - p0.y) * dy) / lenSq));
                const projX = p0.x + t * dx;
                const projY = p0.y + t * dy;
                dist = Math.sqrt((x - projX) ** 2 + (y - projY) ** 2);
            }

            if (dist <= QUEUE_ZONE_HALF_WIDTH) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Set the interserrana scenario adapter for interpolation.
 * Must have same interface as baseline scenario (getPharrInflow, getPharrGateCapacity).
 */
export function setInterserranaScenario(scenario) {
    _interserranaScenario = scenario;
}

/**
 * Update injection ratios from new bundle pair.
 * Call this when switching scenario pairs (e.g., LAYER_A→Baseline to Baseline→Interserrana).
 * @param {Object} baselineBundle - Bundle for α=0
 * @param {Object} interserranaBundle - Bundle for α=1
 */
export function updateInjectionRatios(baselineBundle, interserranaBundle) {
    if (!baselineBundle) {
        console.warn('[INJECTION] updateInjectionRatios: no baseline bundle');
        return;
    }
    _baselineInjectionRatios = computeInjectionWeightsFromBundle(baselineBundle, 'baseline');
    if (interserranaBundle) {
        _interserranaInjectionRatios = computeInjectionWeightsFromBundle(interserranaBundle, 'interserrana');
    } else {
        _interserranaInjectionRatios = null;
    }
    _injectionPointRatios = _baselineInjectionRatios;
    console.log('[INJECTION] Ratios updated:', {
        baseline: Object.fromEntries(_baselineInjectionRatios || []),
        interserrana: _interserranaInjectionRatios ? Object.fromEntries(_interserranaInjectionRatios) : null
    });
}

export function getCorridorEntries() {
    return corridorEntryPoints;
}

export function getPhysicsDebugData() {
    // Build G array from sinkCellIndices (v2 doesn't have continuous sink field)
    const G = new Float32Array(N2);
    for (const idx of sinkCellIndices) {
        G[idx] = 1.0;
    }

    // Build rho from particle counts (v2 uses particles, not continuous density)
    const rho_restricted = new Float32Array(N2);
    const rho_cleared = new Float32Array(N2);
    for (let i = 0; i < N2; i++) {
        const particles = cellParticles[i];
        if (particles) {
            for (const p of particles) {
                if (p.state === STATE.ROAD || p.state === STATE.LOT || p.state === STATE.PARK) {
                    rho_restricted[i] += TRUCK_KG;
                } else if (p.state === STATE.CLEARED) {
                    rho_cleared[i] += TRUCK_KG;
                }
            }
        }
    }

    return {
        // Grid config
        N,
        roi: { ...roi },

        // Sink (PHARR)
        sinkCellIndices: [...sinkCellIndices],
        G,

        // Fields (references - don't modify!)
        phi: phi_pharr,
        phi_pharr,
        phi_lots,
        Kxx,
        Kyy,
        nextHop_pharr,
        nextHop_lots,
        S: sourceField,

        // Density
        rho_restricted,
        rho_cleared,

        // Coordinate transforms
        worldToFieldX,
        worldToFieldY,
        fieldToWorldX,
        fieldToWorldY,

        // Constants
        PHI_LARGE,
        PHI_SINK,

        // Lot data for debug visualization
        regionMap,
        REGION_LOT: REGION.LOT,
        REGION_ROAD: REGION.ROAD,
        REGION_SINK: REGION.SINK,
        cellToLotIndex,
        lotToCellIndices,
        lotCellIndices: [...lotCellIndices],  // Flat array of all lot cell indices
        lotCount: lotToCellIndices.length,
        lotMass,
        lotCapacity,

        // Injection points
        corridorEntryPoints,
        injectionPointRatios: _injectionPointRatios ? Object.fromEntries(_injectionPointRatios) : null,
        industrialParkInjectionPoints: _industrialParkInjectionPoints,
        sourceCellIndices: [...sourceCellIndices],
        roadCellIndices: [...roadCellIndices],
        conductiveCellIndices: [...conductiveCellIndices],
        lotCellIndices: [...lotCellIndices],

        // Flow split
        CORRIDOR_TRAFFIC_RATIO,
        REYNOSA_LOCAL_RATIO,

        // Debug mode
        particleDebugColors: _particleDebugColors,

        // Loop routing (for debug visualization)
        loopCells: LOOP_CELL_SEQUENCE || [],
        loopWaypoints: _loopWaypoints || [],
        loopEnabled: _loopRoutingEnabled,
    };
}

export async function forceRebuildPhiBase() {
    // Delegate to buildRouting() which uses async worker
    console.warn('[PHI] forceRebuildPhiBase → delegating to buildRouting()');
    await buildRouting();
}

export function isPhiRebuilding() {
    return _phiRebuilding;
}

// Cycle particle color mode (M key)
// 0=OFF → 1=STALL → 2=SOURCE → 3=STATE → 0=OFF
export function cycleParticleColorMode() {
    _particleColorMode = (_particleColorMode + 1) % 4;
    const modeName = PARTICLE_COLOR_MODE_NAMES[_particleColorMode];
    console.log(`[PARTICLE] Color mode: ${modeName} (${_particleColorMode}/3)`);
    if (_particleColorMode === 1) {
        console.log('  BLUE=queue, RED=dead_end(NO ROUTE), MAGENTA=lot_full, ORANGE=road_full, CYAN=pre_lot_hold, YELLOW=congested');
    } else if (_particleColorMode === 2) {
        console.log('  RED=West corridor, BLUE=East corridor, GREEN=Industrial parks');
    } else if (_particleColorMode === 3) {
        console.log('  ORANGE=restricted (ROAD/LOT/PARK), CYAN=cleared (heading to bridge)');
    }
    return _particleColorMode;
}

export function getParticleColorMode() {
    return _particleColorMode;
}

export function getParticleColorModeName() {
    return PARTICLE_COLOR_MODE_NAMES[_particleColorMode];
}

// Legacy compatibility
export function toggleParticleDebugClassColors() {
    return cycleParticleColorMode();
}

export function isParticleDebugColors() {
    return _particleColorMode > 0;
}

export function toggleParticleSourceColors() {
    _particleColorMode = 2;  // Jump to source mode
    console.log('[PARTICLE] Color mode: SOURCE');
    return _particleColorMode;
}

export function isParticleSourceColors() {
    return _particleColorMode === 2;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEATMAP EXPORT — For headless PNG generation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get accumulated congestion data for heatmap rendering.
 * Call at end of simulation run to get full-run accumulation.
 */
export function getCongestionHeatmapData() {
    // Compute minX/minY from center-based roi
    const roiExport = {
        minX: roi.centerX - roi.sizeM / 2,
        minY: roi.centerY - roi.sizeM / 2,
        cellSize: roi.cellSize,
        sizeM: roi.sizeM,
    };

    return {
        cellPresenceHours: new Float64Array(cellPresenceHours),
        cellLotDwellHours: new Float64Array(cellLotDwellHours),
        N,
        roi: roiExport,
        roadCellIndices: [...roadCellIndices],
        lotCellIndices: [...lotCellIndices],
        sinkCellIndices: [...sinkCellIndices],
        regionMap: new Uint8Array(regionMap),
        REGION,
    };
}

/**
 * Reset heatmap accumulators. Call at start of each scenario run.
 */
export function resetCongestionAccumulators() {
    cellPresenceHours.fill(0);
    cellLotDwellHours.fill(0);
}

function getParticleSourceColor(p) {
    switch (p.sourceType) {
        case SOURCE_TYPE.CORRIDOR_WEST:
            return '#ff3333';  // Red - SW/West corridor
        case SOURCE_TYPE.CORRIDOR_EAST:
            return '#3366ff';  // Blue - East corridor
        case SOURCE_TYPE.INDUSTRIAL:
            return '#33cc33';  // Green - Industrial parks
        default:
            return '#888888';  // Grey - Unknown
    }
}

export function toggleDarkMode() {
    _darkMode = !_darkMode;
    console.log(`[DARK MODE] ${_darkMode ? 'ON' : 'OFF'}`);
    return _darkMode;
}

export function isDarkMode() {
    return _darkMode;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASES AS LOTS TOGGLE
// Stamps FASE 1 and FASE 2 polygons as lots, rebuilds routing
// ═══════════════════════════════════════════════════════════════════════════════

export async function togglePhasesAsLots() {
    _phasesAsLots = !_phasesAsLots;
    logBuild(`[PHASES] Phases as lots: ${_phasesAsLots ? 'ON' : 'OFF'}`);

    if (_phasesAsLots) {
        // Find exactly "FASE 1" and "FASE 2" (matches allowedNames in layers config)
        const phaseLots = _loadedLots.filter(lot =>
            lot.layer === 'phases' && (lot.name === 'FASE 1' || lot.name === 'FASE 2')
        );

        if (phaseLots.length === 0) {
            logBuild('[PHASES] No FASE 1/FASE 2 polygons found in loaded lots');
            _phasesAsLots = false;
            return false;
        }

        log(`[PHASES] Found ${phaseLots.length} phase polygons`);

        const cellAreaM2 = roi.cellSize * roi.cellSize;
        const baseLotIdx = lotToCellIndices.length;  // Start after existing lots

        _phaseLotIndices = [];
        _phaseLotCells = [];
        _phaseSleepLotIndices = [];  // Reset phase sleep lots
        let phaseLotCount = 0;

        for (let i = 0; i < phaseLots.length; i++) {
            const lot = phaseLots[i];
            const isFase1 = lot.name === 'FASE 1';
            const isFase2 = lot.name === 'FASE 2';
            const cells = [];

            // Rasterize polygon(s) to grid cells
            for (const poly of (lot.polygons || [])) {
                if (!poly.worldCoords || poly.worldCoords.length < 3) continue;

                // Bounding box
                let minX = Infinity, maxX = -Infinity;
                let minY = Infinity, maxY = -Infinity;
                for (const pt of poly.worldCoords) {
                    minX = Math.min(minX, pt.x);
                    maxX = Math.max(maxX, pt.x);
                    minY = Math.min(minY, pt.y);
                    maxY = Math.max(maxY, pt.y);
                }

                // Scan grid cells in bbox
                const fx0 = Math.floor(worldToFieldX(minX));
                const fx1 = Math.ceil(worldToFieldX(maxX));
                const fy0 = Math.floor(worldToFieldY(minY));
                const fy1 = Math.ceil(worldToFieldY(maxY));

                for (let fy = fy0; fy <= fy1; fy++) {
                    for (let fx = fx0; fx <= fx1; fx++) {
                        if (fx < 0 || fx >= N || fy < 0 || fy >= N) continue;

                        const wx = fieldToWorldX(fx + 0.5);
                        const wy = fieldToWorldY(fy + 0.5);

                        if (pointInZonePolygon(wx, wy, poly.worldCoords)) {
                            const idx = fy * N + fx;
                            // Only stamp if not already a lot or sink
                            if (cellToLotIndex[idx] < 0 && regionMap[idx] !== REGION.SINK && regionMap[idx] !== REGION.ROAD) {
                                // Both FASE 1 and FASE 2 are stamped as LOT (but don't overwrite roads)
                                const lotIdx = baseLotIdx + phaseLotCount;
                                cells.push(idx);
                                cellToLotIndex[idx] = lotIdx;
                                regionMap[idx] = REGION.LOT;
                                Kxx[idx] = Math.max(Kxx[idx], 0.4);
                                Kyy[idx] = Math.max(Kyy[idx], 0.4);
                            }
                        }
                    }
                }
            }

            if (cells.length > 0) {
                const lotIdx = baseLotIdx + phaseLotCount;
                phaseLotCount++;

                lotToCellIndices.push(cells);
                lotCellIndices.push(...cells);
                _phaseLotCells.push(...cells);
                _phaseLotIndices.push(lotIdx);

                // FASE 1: sleep lot with 132 trucks, FASE 2: conversion lot with 758 trucks
                let cap;
                if (isFase1) {
                    cap = INOVUS_FASE1_CAPACITY_KG * _inovusCapacityMult;
                    _phaseSleepLotIndices.push(lotIdx);  // Mark as sleep lot
                } else if (isFase2) {
                    cap = INOVUS_FASE2_CAPACITY_KG * _inovusCapacityMult;
                } else {
                    cap = cells.length * cellAreaM2 * LOT_KG_PER_M2;
                }

                // Extend capacity/mass arrays
                const newCap = new Float32Array(lotCapacity.length + 1);
                newCap.set(lotCapacity);
                newCap[lotIdx] = cap;
                lotCapacity = newCap;

                const newMass = new Float32Array(lotMass.length + 1);
                newMass.set(lotMass);
                newMass[lotIdx] = 0;
                lotMass = newMass;

                const newCooldown = new Float64Array(lotCooldownEndSimS.length + 1);
                newCooldown.set(lotCooldownEndSimS);
                newCooldown[lotIdx] = 0;
                lotCooldownEndSimS = newCooldown;

                const lotType = isFase1 ? 'sleep lot' : 'conversion lot';
                log(`[PHASES] ${lot.name}: ${cells.length} cells, ${(cap / 1000).toFixed(0)} t capacity (${lotType})`);
            }
        }

        log(`[PHASES] Stamped ${_phaseLotCells.length} total cells as lots`);
        log(`[PHASES] Sleep lots: ${_phaseSleepLotIndices.length} (indices: ${_phaseSleepLotIndices.join(', ')})`);

        // Stamp Inovus-only road connectors
        stampInovusConnectors();
    } else {
        // Unstamp phase lots
        for (const idx of _phaseLotCells) {
            cellToLotIndex[idx] = -1;
            regionMap[idx] = REGION.ROAD;  // Revert to road
        }

        // Remove phase lot indices from tracking (keep base lots)
        const baseCount = lotToCellIndices.length - _phaseLotIndices.length;
        lotToCellIndices = lotToCellIndices.slice(0, baseCount);
        lotCellIndices = lotCellIndices.filter(idx => !_phaseLotCells.includes(idx));

        // Shrink capacity/mass arrays
        lotCapacity = lotCapacity.slice(0, baseCount);
        lotMass = lotMass.slice(0, baseCount);
        lotCooldownEndSimS = lotCooldownEndSimS.slice(0, baseCount);

        _phaseLotIndices = [];
        _phaseLotCells = [];

        // Unstamp Inovus-only road connectors
        unstampInovusConnectors();

        log(`[PHASES] Unstamped phase lots, reverted to road`);
    }

    // Schedule routing rebuild (async, non-blocking)
    markRoutingDirty('togglePhasesAsLots');
    log(`[PHASES] Routing rebuild scheduled`);

    return _phasesAsLots;
}

export function isPhasesAsLots() {
    return _phasesAsLots;
}

// Inovus capacity multiplier — call BEFORE togglePhasesAsLots()
export function setInovusCapacityMultiplier(mult) {
    _inovusCapacityMult = mult;
    logBuild(`[INOVUS] Capacity multiplier set to ${mult}x (${(INOVUS_FASE2_CAPACITY_KG * mult / 1e6).toFixed(1)}M kg)`);
}

export function getInovusCapacityMultiplier() {
    return _inovusCapacityMult;
}

// Lot admission cutoff (global capacity increase toggle)
// Default: 0.55 (55%) - lots stop admitting at 55% fill
// Can be raised to 0.75 (75%) for Globalcapacityincrease scenario

export function setLotAdmissionCutoff(cutoff) {
    _lotAdmissionCutoff = cutoff;
    log(`[CONFIG] Lot admission cutoff set to ${(cutoff * 100).toFixed(0)}%`);
}

export function getLotAdmissionCutoff() {
    return _lotAdmissionCutoff;
}

// ═══════════════════════════════════════════════════════════════════════════
// REPLAY MODE — Kinematic particle replay under accelerated sim-time
// ═══════════════════════════════════════════════════════════════════════════
//
// When enabled:
//   - Particles move along paths (kinematic only)
//   - All interaction logic is frozen (congestion, queues, routing)
//   - Motion is scaled by REPLAY_TIME_SCALE
//
// Invariants:
//   - Nothing reacts. Nothing emerges. Nothing adapts.
//   - Counters define truth. Particles provide context.
//
let REPLAY_MODE = false;
let REPLAY_TIME_SCALE = 1.0;

export function setReplayMode(enabled, timeScale = 1.0) {
    REPLAY_MODE = enabled;
    REPLAY_TIME_SCALE = timeScale;
    log(`[REPLAY] Mode ${enabled ? 'ENABLED' : 'DISABLED'}, timeScale=${timeScale}x`);
}

export function isReplayMode() {
    return REPLAY_MODE;
}

export function getReplayTimeScale() {
    return REPLAY_TIME_SCALE;
}

// Congestion heatmap toggle
let _showCongestionHeatmap = false;

export function toggleCongestionHeatmap() {
    _showCongestionHeatmap = !_showCongestionHeatmap;
    return _showCongestionHeatmap;
}

export function isShowingCongestionHeatmap() {
    return _showCongestionHeatmap;
}

// Draw congestion heatmap - cyan cells where congestion slows particles
let _congestionDebugFrame = 0;
function drawCongestionHeatmap(ctx, camera) {
    if (!_showCongestionHeatmap) return;

    const cellScreenSize = roi.cellSize * camera.zoom;

    // Debug every 60 frames
    const debug = (++_congestionDebugFrame % 60 === 1);
    if (debug) {
        log(`[CONG] cellScreenSize=${cellScreenSize.toFixed(1)}, N=${N}, roi.cellSize=${roi.cellSize}`);
    }

    // Only draw if cells are visible (not too zoomed out)
    if (cellScreenSize < 2) {
        if (debug) log('[CONG] Skipping - cells too small');
        return;
    }

    const vp = camera.viewportWorld;
    const pad = roi.cellSize * 2;

    let cellsWithMass = 0;
    let cellsDrawn = 0;
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const idx = y * N + x;
            const rho = cellMass[idx];
            if (rho <= 0) continue;
            cellsWithMass++;

            // Skip lot cells (they don't experience congestion)
            if (regionMap[idx] === REGION.LOT) continue;

            const c = congestionFactor(rho);

            const wx = fieldToWorldX(x);
            const wy = fieldToWorldY(y);

            // Viewport culling
            if (wx < vp.minX - pad || wx > vp.maxX + pad) continue;
            if (wy < vp.minY - pad || wy > vp.maxY + pad) continue;

            // Intensity: all cells visible, congestion = brighter
            const intensity = 1 - c;
            const alpha = 0.2 + intensity * 0.7;

            ctx.fillStyle = `rgba(0, 255, 255, ${alpha.toFixed(2)})`;
            const screen = camera.worldToScreen(wx, wy);
            ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
            cellsDrawn++;
        }
    }
    if (debug) {
        log(`[CONG] cellsWithMass=${cellsWithMass}, cellsDrawn=${cellsDrawn}`);
    }
}

/**
 * Draw cell-based congestion visualization (always on).
 * Shows effective congestion = freight mass + commuter friction.
 * Renders BEFORE particles so particles appear on top.
 */
function drawCongestionCells(ctx, camera) {
    // Skip during replay heatmap mode
    if (_flowRenderMode === 'ROAD_HEATMAP') return;

    const cellScreenSize = roi.cellSize * camera.zoom;

    // Skip if cells too small to see
    if (cellScreenSize < 1) return;

    const vp = camera.viewportWorld;
    const pad = roi.cellSize * 2;

    // Iterate only road cells (sparse set)
    for (const idx of roadCellIndices) {
        const freightMass = cellMass[idx];
        const commuterMass = COMMUTER_EQUIV_KG * commuterLoad[idx];
        const effectiveRho = freightMass + commuterMass;

        // Normalize: 0 at onset, 1 at gridlock
        const congestionLevel = (effectiveRho - RHO_CONGESTION_0) / (ROAD_CELL_CAP_KG - RHO_CONGESTION_0);

        // Skip if below visibility threshold
        if (congestionLevel < 0.1) continue;

        const x = idx % N;
        const y = Math.floor(idx / N);
        const wx = fieldToWorldX(x);
        const wy = fieldToWorldY(y);

        // Viewport culling
        if (wx < vp.minX - pad || wx > vp.maxX + pad) continue;
        if (wy < vp.minY - pad || wy > vp.maxY + pad) continue;

        // Magenta fill, alpha proportional to congestion (clamped 0.02-0.08)
        const alpha = 0.02 + Math.min(1, congestionLevel) * 0.06;
        ctx.fillStyle = `rgba(200, 0, 200, ${alpha.toFixed(2)})`;
        const screen = camera.worldToScreen(wx, wy);
        ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUTER DEBUG MODE — Full visibility into friction field effects (T key)
// ═══════════════════════════════════════════════════════════════════════════════

let _showCommuterDebug = false;

export function toggleCommuterDebug() {
    _showCommuterDebug = !_showCommuterDebug;
    console.log(`[COMMUTER] Debug mode: ${_showCommuterDebug ? 'ON' : 'OFF'}`);
    return _showCommuterDebug;
}

export function isShowingCommuterDebug() {
    return _showCommuterDebug;
}

/**
 * Draw commuter friction debug overlay.
 * Shows: heatmap by zone type, intersection markers, stats panel.
 * Colors: Magenta=Arterial, Orange=Approach, Cyan=Aduana
 */
function drawCommuterDebug(ctx, camera) {
    if (!_showCommuterDebug) return;

    const cellScreenSize = roi.cellSize * camera.zoom;
    const vp = camera.viewportWorld;
    const pad = roi.cellSize * 2;

    // Only draw cells if they're visible (threshold lowered for reynosa zoom ~0.044)
    if (cellScreenSize >= 0.5) {
        // Draw commuter zones by type (color-coded)
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const idx = y * N + x;
                const w = baseCommuterWeight[idx];
                if (w <= 0) continue;

                const wx = fieldToWorldX(x);
                const wy = fieldToWorldY(y);

                // Viewport culling
                if (wx < vp.minX - pad || wx > vp.maxX + pad) continue;
                if (wy < vp.minY - pad || wy > vp.maxY + pad) continue;

                // Color by zone type, opacity by weight
                const ctype = commuterType[idx];
                let r, g, b;
                if (ctype === CTYPE_ARTERIAL) {
                    r = 255; g = 0; b = 255;      // Magenta
                } else if (ctype === CTYPE_INDUSTRIAL) {
                    r = 255; g = 140; b = 0;      // Orange
                } else if (ctype === CTYPE_ADUANA) {
                    r = 0; g = 220; b = 220;      // Cyan
                } else if (ctype === CTYPE_URBAN) {
                    r = 255; g = 255; b = 0;      // Yellow
                } else {
                    continue;
                }

                // Opacity from weight (0.2 base + 0.6 scaled by weight)
                const alpha = 0.2 + w * 0.6;
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
                const screen = camera.worldToScreen(wx, wy);
                ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
            }
        }

        // Draw intersection markers (white dots)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const idx = y * N + x;
                if (!isIntersection[idx]) continue;

                const wx = fieldToWorldX(x + 0.5);
                const wy = fieldToWorldY(y + 0.5);

                if (wx < vp.minX - pad || wx > vp.maxX + pad) continue;
                if (wy < vp.minY - pad || wy > vp.maxY + pad) continue;

                const screen = camera.worldToScreen(wx, wy);
                ctx.beginPath();
                ctx.arc(screen.x, screen.y, Math.max(3, cellScreenSize * 0.3), 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    // Draw stats panel (top-right)
    const currentHour = Math.floor(simTime / 3600) % 24;
    const artMult = arterialMultiplier(currentHour);
    const appMult = approachMultiplier(currentHour);
    const aduMult = aduanaMultiplier(currentHour);

    // Count cells by weight
    let arterialCells = 0, approachCells = 0, aduanaCells = 0, activeCells = 0;
    let intersectionCount = 0;
    for (let i = 0; i < N2; i++) {
        if (baseCommuterWeight[i] >= 0.99) arterialCells++;
        else if (baseCommuterWeight[i] >= 0.5) approachCells++;
        else if (baseCommuterWeight[i] >= 0.3) aduanaCells++;
        if (commuterLoad[i] > 0) activeCells++;
        if (isIntersection[i]) intersectionCount++;
    }

    // Compute effective rho contribution for each type
    const artEffectiveKg = COMMUTER_EQUIV_KG * artMult;
    const appEffectiveKg = COMMUTER_EQUIV_KG * appMult;
    const aduEffectiveKg = COMMUTER_EQUIV_KG * aduMult;

    const panelX = ctx.canvas.width - 280;
    const panelY = 20;
    const lineH = 18;

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(panelX - 10, panelY - 5, 270, 310);

    ctx.font = "bold 14px 'IBM Plex Mono', monospace";
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ff00ff';
    ctx.fillText('COMMUTER FRICTION DEBUG [T]', panelX, panelY + lineH);

    ctx.font = "12px 'IBM Plex Mono', monospace";
    ctx.fillStyle = '#fff';

    let y = panelY + lineH * 2.5;

    ctx.fillText(`Hour: ${currentHour.toString().padStart(2, '0')}:00`, panelX, y); y += lineH;
    ctx.fillStyle = '#ff00ff';
    ctx.fillText(`Arterial mult: ${artMult.toFixed(2)}`, panelX, y); y += lineH;
    ctx.fillStyle = '#ff8c00';
    ctx.fillText(`Approach mult: ${appMult.toFixed(2)}`, panelX, y); y += lineH;
    ctx.fillStyle = '#00dcdc';
    ctx.fillText(`Aduana mult:   ${aduMult.toFixed(2)}`, panelX, y); y += lineH;

    y += 5;
    ctx.fillStyle = '#aaa';
    ctx.fillText('Zone Cells:', panelX, y); y += lineH;
    ctx.fillStyle = '#ff00ff';
    ctx.fillText(`  Arterial: ${arterialCells}`, panelX, y); y += lineH;
    ctx.fillStyle = '#ff8c00';
    ctx.fillText(`  Approach: ${approachCells}`, panelX, y); y += lineH;
    ctx.fillStyle = '#00dcdc';
    ctx.fillText(`  Aduana:   ${aduanaCells}`, panelX, y); y += lineH;
    ctx.fillStyle = '#fff';
    ctx.fillText(`  Active:   ${activeCells}`, panelX, y); y += lineH;
    ctx.fillText(`  Intersections: ${intersectionCount}`, panelX, y); y += lineH;

    y += 5;
    ctx.fillStyle = '#aaa';
    ctx.fillText('Effective kg/cell:', panelX, y); y += lineH;
    ctx.fillStyle = '#ff00ff';
    ctx.fillText(`  Arterial: ${artEffectiveKg.toFixed(0)} kg`, panelX, y); y += lineH;
    ctx.fillStyle = '#ff8c00';
    ctx.fillText(`  Approach: ${appEffectiveKg.toFixed(0)} kg`, panelX, y); y += lineH;
    ctx.fillStyle = '#00dcdc';
    ctx.fillText(`  Aduana:   ${aduEffectiveKg.toFixed(0)} kg`, panelX, y); y += lineH;

    // Legend
    y += 10;
    ctx.fillStyle = 'rgba(255, 0, 255, 0.7)';
    ctx.fillRect(panelX, y, 12, 12);
    ctx.fillStyle = '#fff';
    ctx.fillText('Arterial (city roads)', panelX + 18, y + 10);

    y += 16;
    ctx.fillStyle = 'rgba(255, 140, 0, 0.7)';
    ctx.fillRect(panelX, y, 12, 12);
    ctx.fillStyle = '#fff';
    ctx.fillText('Approach (industrial)', panelX + 18, y + 10);

    y += 16;
    ctx.fillStyle = 'rgba(0, 220, 220, 0.7)';
    ctx.fillRect(panelX, y, 12, 12);
    ctx.fillStyle = '#fff';
    ctx.fillText('Aduana (border/customs)', panelX + 18, y + 10);

    y += 16;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.arc(panelX + 6, y + 4, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText('Intersection (stop-go)', panelX + 18, y + 8);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUTER HEATMAP — Simplified congestion visualization for narrative
// ═══════════════════════════════════════════════════════════════════════════════

let _showCommuterHeatmap = false;

export function setCommuterHeatmap(enabled) {
    _showCommuterHeatmap = enabled;
    console.log(`[COMMUTER] Heatmap: ${_showCommuterHeatmap ? 'ON' : 'OFF'}`);
    return _showCommuterHeatmap;
}

export function isShowingCommuterHeatmap() {
    return _showCommuterHeatmap;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHARR INFRASTRUCTURE POLYGON — CBP facility boundary visualization
// ═══════════════════════════════════════════════════════════════════════════════

let _showPharrInfraPolygon = false;

// Polygon vertices in world coordinates (from user specification)
const PHARR_INFRA_POLYGON = [
    { x: 154.70, y: -2503.04 },
    { x: -868.66, y: -2344.36 },
    { x: -54.27, y: 2904.30 },
    { x: 969.10, y: 2745.62 }
];

export function showPharrInfraPolygon() {
    _showPharrInfraPolygon = true;
    console.log('[PHARR] Infrastructure polygon: ON');
}

export function hidePharrInfraPolygon() {
    _showPharrInfraPolygon = false;
    console.log('[PHARR] Infrastructure polygon: OFF');
}

/**
 * Draw PHARR CBP infrastructure polygon.
 * Called from draw() when enabled.
 */
function drawPharrInfraPolygon(ctx, camera) {
    if (!_showPharrInfraPolygon) return;

    const pts = PHARR_INFRA_POLYGON.map(p => camera.worldToScreen(p.x, p.y));

    // Fill with semi-transparent cyan
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 255, 255, 0.15)';
    ctx.fill();

    // Stroke with solid cyan
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
}

/**
 * Draw simplified commuter heatmap — single color gradient by congestion intensity.
 * Green (low) → Yellow → Red (high friction)
 * Intersections shown as small, subtle dots.
 */
function drawCommuterHeatmap(ctx, camera) {
    if (!_showCommuterHeatmap) return;

    const cellScreenSize = roi.cellSize * camera.zoom;
    const vp = camera.viewportWorld;
    const pad = roi.cellSize * 2;

    // Only draw cells if they're visible
    if (cellScreenSize >= 0.5) {
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const idx = y * N + x;
                const load = commuterLoad[idx];
                if (load <= 0) continue;

                const wx = fieldToWorldX(x);
                const wy = fieldToWorldY(y);

                // Viewport culling
                if (wx < vp.minX - pad || wx > vp.maxX + pad) continue;
                if (wy < vp.minY - pad || wy > vp.maxY + pad) continue;

                // Color by congestion intensity: green → yellow → red
                // load typically ranges 0.2 to ~0.8, normalize aggressively
                const t = Math.min(load / 0.5, 1.0);  // 0.5 load = full red
                let r, g, b;
                if (t < 0.5) {
                    // Green to Yellow (0 → 0.5)
                    const t2 = t * 2;
                    r = Math.round(255 * t2);
                    g = 255;
                    b = 0;
                } else {
                    // Yellow to Red (0.5 → 1)
                    const t2 = (t - 0.5) * 2;
                    r = 255;
                    g = Math.round(255 * (1 - t2));
                    b = 0;
                }

                const alpha = 0.3 + load * 0.4;
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
                const screen = camera.worldToScreen(wx, wy);
                ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
            }
        }

        // Draw intersection markers (hollow circles with thick border)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = Math.max(1, cellScreenSize * 0.08);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                const idx = y * N + x;
                if (!isIntersection[idx]) continue;

                const wx = fieldToWorldX(x + 0.5);
                const wy = fieldToWorldY(y + 0.5);

                if (wx < vp.minX - pad || wx > vp.maxX + pad) continue;
                if (wy < vp.minY - pad || wy > vp.maxY + pad) continue;

                const screen = camera.worldToScreen(wx, wy);
                ctx.beginPath();
                ctx.arc(screen.x, screen.y, Math.max(2, cellScreenSize * 0.2), 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPLAY ROAD HEATMAP — Sample-driven visualization during clockMontage
// ═══════════════════════════════════════════════════════════════════════════════

let _flowRenderMode = 'PARTICLES';  // 'PARTICLES' | 'ROAD_HEATMAP'
let _replaySampleData = null;       // Current sample for heatmap rendering

export function setFlowRenderMode(mode) {
    _flowRenderMode = mode;
    console.log(`[FLOW] Render mode: ${_flowRenderMode}`);
    return _flowRenderMode;
}

export function getFlowRenderMode() {
    return _flowRenderMode;
}

export function setReplaySampleData(sampleData) {
    _replaySampleData = sampleData;
}

/**
 * Thermal gradient: blue → cyan → green → yellow → red
 * Same as heatmapExport.js for consistency.
 */
function thermalGradient(t) {
    if (t < 0.25) {
        const s = t / 0.25;
        return { r: 0, g: Math.round(255 * s), b: 255 };
    } else if (t < 0.5) {
        const s = (t - 0.25) / 0.25;
        return { r: 0, g: 255, b: Math.round(255 * (1 - s)) };
    } else if (t < 0.75) {
        const s = (t - 0.5) / 0.25;
        return { r: Math.round(255 * s), g: 255, b: 0 };
    } else {
        const s = (t - 0.75) / 0.25;
        return { r: 255, g: Math.round(255 * (1 - s)), b: 0 };
    }
}

// Replay heatmap frame data (set externally from testBundle)
let _replayHeatmapFrame = null;

/**
 * Reset heatmap state (call when switching scenarios).
 */
export function resetHeatmap() {
    _replayHeatmapFrame = null;
}

/**
 * Set replay heatmap frame data for current sim-time.
 * Called from testBundle during clock montage to provide pre-computed frame data.
 * @param {Object|null} frameData - { roadCellIndices, roadPresence, roi, N } or null to clear
 */
export function setReplayHeatmapFrame(frameData) {
    _replayHeatmapFrame = frameData;
}

/**
 * Draw road heatmap from pre-computed replay data.
 * Only works in REPLAY_MODE with frame data set via setReplayHeatmapFrame().
 */
function drawRoadHeatmap(ctx, camera) {
    if (_flowRenderMode !== 'ROAD_HEATMAP') return;
    if (!_replayHeatmapFrame) return;

    drawReplayHeatmap(ctx, camera, _replayHeatmapFrame);
}

/**
 * Draw replay heatmap from pre-computed frame data.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} camera
 * @param {Object} frameData - { roadCellIndices, roadPresence, roi, N }
 */
function drawReplayHeatmap(ctx, camera, frameData) {
    const { roadCellIndices: frameRoadCells, roadPresence, roi: frameRoi, N: frameN } = frameData;

    // Find max for normalization (p99 for better color range)
    const sortedValues = [...roadPresence].filter(v => v > 0).sort((a, b) => a - b);
    const maxVal = sortedValues.length > 0
        ? sortedValues[Math.floor(sortedValues.length * 0.99)] || sortedValues[sortedValues.length - 1]
        : 1;

    const cellSize = roi.cellSize * camera.zoom * 2;
    const vp = camera.viewportWorld;
    const pad = roi.cellSize * 4;

    let nonZeroCount = 0;
    for (let i = 0; i < frameRoadCells.length; i++) {
        const presence = roadPresence[i];
        if (presence <= 0) continue;
        nonZeroCount++;

        const idx = frameRoadCells[i];
        const cx = idx % frameN;
        const cy = Math.floor(idx / frameN);

        // Convert field coords to world coords using frame's roi
        const wx = frameRoi.minX + (cx + 0.5) * frameRoi.cellSize;
        const wy = frameRoi.minY + (cy + 0.5) * frameRoi.cellSize;

        // Viewport culling
        if (wx < vp.minX - pad || wx > vp.maxX + pad) continue;
        if (wy < vp.minY - pad || wy > vp.maxY + pad) continue;

        // Normalize to [0,1] using p99 max
        const t = Math.min(1, presence / maxVal);
        const color = thermalGradient(t);

        // Bright, fully opaque colors
        ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
        const screen = camera.worldToScreen(wx, wy);
        ctx.fillRect(screen.x - cellSize/2, screen.y - cellSize/2, cellSize, cellSize);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUTER PRESSURE OVERLAY — Subtle magenta visualization of time-varying load
// ═══════════════════════════════════════════════════════════════════════════════

// Cache: pre-computed cells with world coords and fillStyle (updated hourly)
let _commuterPressureCache = [];
let _commuterPressureCacheHour = -1;

/**
 * Update commuter pressure cache when hour changes.
 * Pre-computes world coords and fillStyle for each visible cell.
 * Called from updateCommuterLoad() after commuterLoad is updated.
 */
function updateCommuterPressureCache() {
    const currentHour = Math.floor(simTime / 3600) % 24;
    if (currentHour === _commuterPressureCacheHour) return;
    _commuterPressureCacheHour = currentHour;

    _commuterPressureCache = [];

    for (const idx of _commuterCellIndices) {
        const load = commuterLoad[idx];
        if (load <= 0.05) continue;  // Skip near-zero load

        const x = idx % N;
        const y = Math.floor(idx / N);
        const wx = fieldToWorldX(x);
        const wy = fieldToWorldY(y);

        // Magenta alpha: 3 buckets (subtle)
        // Night (load < 0.3) → 0.02
        // Off-peak (0.3 ≤ load < 0.7) → 0.06
        // Peak (load ≥ 0.7) → 0.12
        const alpha = load < 0.3 ? 0.02 : load < 0.7 ? 0.06 : 0.12;
        const fillStyle = `rgba(200, 0, 200, ${alpha.toFixed(2)})`;

        _commuterPressureCache.push({ wx, wy, fillStyle });
    }
}

/**
 * Draw commuter pressure overlay — subtle magenta cells showing time-varying load.
 *
 * ALWAYS ON — visibility determined by model conditions (time-of-day multipliers).
 * At night: near-invisible (load ~0.1-0.2 → alpha ~0.10)
 * At peak hours: visible magenta glow (load ~0.8-1.2 → alpha ~0.30)
 *
 * Uses pre-computed cache (updated hourly by updateCommuterPressureCache).
 */
function drawCommuterPressure(ctx, camera) {
    if (_overlayMode !== 'COMMUTER') return;
    if (_commuterPressureCache.length === 0) return;

    const cellScreenSize = roi.cellSize * camera.zoom;

    // Skip if cells too small to see
    if (cellScreenSize < 0.5) return;

    const vp = camera.viewportWorld;
    const pad = roi.cellSize * 2;

    // Draw from cache (world coords + fillStyle pre-computed hourly)
    for (const cell of _commuterPressureCache) {
        // Viewport culling
        if (cell.wx < vp.minX - pad || cell.wx > vp.maxX + pad) continue;
        if (cell.wy < vp.minY - pad || cell.wy > vp.maxY + pad) continue;

        ctx.fillStyle = cell.fillStyle;
        const screen = camera.worldToScreen(cell.wx, cell.wy);
        ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERLAY MODE — Cycle between commuter pressure and speed limit visualization
// ═══════════════════════════════════════════════════════════════════════════════
const OVERLAY_MODES = ['OFF', 'COMMUTER', 'SPEED'];
let _overlayMode = 'COMMUTER';  // Default: commuter pressure visible

export function cycleOverlayMode() {
    const idx = OVERLAY_MODES.indexOf(_overlayMode);
    _overlayMode = OVERLAY_MODES[(idx + 1) % OVERLAY_MODES.length];
    console.log(`[OVERLAY] Mode: ${_overlayMode}`);
    return _overlayMode;
}

export function getOverlayMode() {
    return _overlayMode;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPEED LIMIT EDITOR — Drag nodes to adjust polyline positions
// ═══════════════════════════════════════════════════════════════════════════════
let _speedLimitEditMode = false;
let _speedLimitEditData = null;  // Deep copy of SPEED_LIMIT_POLYLINES when editing
let _draggedNode = null;         // { zoneIdx, polylineIdx, pointIdx }
const SPEED_NODE_RADIUS = 10;    // Hit radius in screen pixels

export function toggleSpeedLimitEditMode() {
    _speedLimitEditMode = !_speedLimitEditMode;
    if (_speedLimitEditMode) {
        // Deep copy the polylines for editing
        _speedLimitEditData = SPEED_LIMIT_POLYLINES.map(zone => ({
            speedKph: zone.speedKph,
            name: zone.name,
            polylines: zone.polylines.map(pl => pl.map(pt => [...pt]))
        }));
        console.log('[SPEED EDITOR] ON - drag nodes to adjust, press C to copy');
    } else {
        console.log('[SPEED EDITOR] OFF');
    }
    return _speedLimitEditMode;
}

export function isSpeedLimitEditMode() {
    return _speedLimitEditMode;
}

export function getSpeedLimitEditData() {
    return _speedLimitEditData;
}

/**
 * Hit-test for speed limit nodes. Returns { zoneIdx, polylineIdx, pointIdx } or null.
 */
export function hitTestSpeedNode(screenX, screenY, camera) {
    if (!_speedLimitEditMode || !_speedLimitEditData) return null;

    for (let z = 0; z < _speedLimitEditData.length; z++) {
        const zone = _speedLimitEditData[z];
        for (let p = 0; p < zone.polylines.length; p++) {
            const polyline = zone.polylines[p];
            for (let i = 0; i < polyline.length; i++) {
                const pt = camera.worldToScreen(polyline[i][0], polyline[i][1]);
                const dx = screenX - pt.x;
                const dy = screenY - pt.y;
                if (dx * dx + dy * dy <= SPEED_NODE_RADIUS * SPEED_NODE_RADIUS) {
                    return { zoneIdx: z, polylineIdx: p, pointIdx: i };
                }
            }
        }
    }
    return null;
}

export function startDragSpeedNode(node) {
    _draggedNode = node;
}

export function dragSpeedNode(worldX, worldY) {
    if (!_draggedNode || !_speedLimitEditData) return;
    const { zoneIdx, polylineIdx, pointIdx } = _draggedNode;
    _speedLimitEditData[zoneIdx].polylines[polylineIdx][pointIdx] = [worldX, worldY];
}

export function endDragSpeedNode() {
    _draggedNode = null;
}

export function isDraggingSpeedNode() {
    return _draggedNode !== null;
}

/**
 * Export edited speed limit polylines as JS code ready to paste.
 */
export function copySpeedLimitPolylines() {
    if (!_speedLimitEditData) {
        console.log('[SPEED EDITOR] No edit data - enable edit mode first');
        return null;
    }

    // Format as JS code
    let code = 'const SPEED_LIMIT_POLYLINES = [\n';
    for (const zone of _speedLimitEditData) {
        code += '    {\n';
        code += `        speedKph: ${zone.speedKph},\n`;
        code += `        name: '${zone.name}',\n`;
        code += '        polylines: [\n';
        for (const polyline of zone.polylines) {
            code += '            [\n';
            for (const pt of polyline) {
                code += `                [${pt[0]}, ${pt[1]}],\n`;
            }
            code += '            ],\n';
        }
        code += '        ],\n';
        code += '    },\n';
    }
    code += '];\n';

    return code;
}

/**
 * Find the nearest segment to a screen point. Returns { zoneIdx, polylineIdx, segmentIdx, t, dist } or null.
 * segmentIdx is the index of the first point of the segment (segment goes from segmentIdx to segmentIdx+1).
 * t is the interpolation parameter [0,1] along the segment.
 */
export function findNearestSegment(screenX, screenY, camera, maxDistPx = 50) {
    console.log('[findNearestSegment] editMode:', _speedLimitEditMode, 'hasData:', !!_speedLimitEditData);
    if (!_speedLimitEditMode || !_speedLimitEditData) return null;

    let best = null;
    let bestDist = maxDistPx;
    let closestAnyDist = Infinity;

    for (let z = 0; z < _speedLimitEditData.length; z++) {
        const zone = _speedLimitEditData[z];
        for (let p = 0; p < zone.polylines.length; p++) {
            const polyline = zone.polylines[p];
            for (let i = 0; i < polyline.length - 1; i++) {
                const p1 = camera.worldToScreen(polyline[i][0], polyline[i][1]);
                const p2 = camera.worldToScreen(polyline[i + 1][0], polyline[i + 1][1]);

                // Point-to-segment distance
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const len2 = dx * dx + dy * dy;
                if (len2 < 0.001) continue;

                let t = ((screenX - p1.x) * dx + (screenY - p1.y) * dy) / len2;
                t = Math.max(0, Math.min(1, t));

                const projX = p1.x + t * dx;
                const projY = p1.y + t * dy;
                const dist = Math.hypot(screenX - projX, screenY - projY);

                if (dist < closestAnyDist) closestAnyDist = dist;

                if (dist < bestDist) {
                    bestDist = dist;
                    best = { zoneIdx: z, polylineIdx: p, segmentIdx: i, t, dist };
                }
            }
        }
    }
    console.log('[findNearestSegment] closestDist:', closestAnyDist, 'maxAllowed:', maxDistPx, 'found:', !!best);
    return best;
}

/**
 * Insert a new control point on a segment. The point is inserted at the click position.
 */
export function insertSpeedNode(worldX, worldY, segmentInfo) {
    if (!_speedLimitEditData || !segmentInfo) return false;

    const { zoneIdx, polylineIdx, segmentIdx } = segmentInfo;
    const polyline = _speedLimitEditData[zoneIdx].polylines[polylineIdx];

    // Insert after segmentIdx
    polyline.splice(segmentIdx + 1, 0, [worldX, worldY]);
    console.log(`[SPEED EDITOR] Inserted node at segment ${segmentIdx} in ${_speedLimitEditData[zoneIdx].name}`);
    return true;
}

/**
 * Delete a node from a polyline. Won't delete if it would leave fewer than 2 points.
 */
export function deleteSpeedNode(nodeInfo) {
    if (!_speedLimitEditData || !nodeInfo) return false;

    const { zoneIdx, polylineIdx, pointIdx } = nodeInfo;
    const polyline = _speedLimitEditData[zoneIdx].polylines[polylineIdx];

    if (polyline.length <= 2) {
        console.log('[SPEED EDITOR] Cannot delete - polyline needs at least 2 points');
        return false;
    }

    polyline.splice(pointIdx, 1);
    console.log(`[SPEED EDITOR] Deleted node ${pointIdx} from ${_speedLimitEditData[zoneIdx].name}`);
    return true;
}

// Speed limit colors by kph
const SPEED_COLORS = {
    25: '#ff0000',   // Red - slow zone
    55: '#ffaa00',   // Orange - arterial
    60: '#ffff00',   // Yellow - default (won't be drawn, but for reference)
    80: '#aaff00',   // Yellow-green - fast arterial
    100: '#55ff00',  // Light green - fast road
    110: '#00ff00',  // Green - highway
};

/**
 * Draw speed limit polylines as colored lines.
 * Color indicates speed: red=25, orange=55, green=110 kph.
 * When edit mode is active, draws draggable nodes at each vertex.
 */
function drawSpeedLimitPolylines(ctx, camera) {
    if (_overlayMode !== 'SPEED') return;

    // Use edit data if editing, otherwise use original
    const data = _speedLimitEditMode && _speedLimitEditData ? _speedLimitEditData : SPEED_LIMIT_POLYLINES;

    ctx.save();
    ctx.lineWidth = Math.max(3, camera.zoom * 8);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const zone of data) {
        const color = SPEED_COLORS[zone.speedKph] || '#ffffff';
        ctx.strokeStyle = color;

        for (const polyline of zone.polylines) {
            if (polyline.length < 2) continue;

            ctx.beginPath();
            const start = camera.worldToScreen(polyline[0][0], polyline[0][1]);
            ctx.moveTo(start.x, start.y);

            for (let i = 1; i < polyline.length; i++) {
                const pt = camera.worldToScreen(polyline[i][0], polyline[i][1]);
                ctx.lineTo(pt.x, pt.y);
            }
            ctx.stroke();

            // Draw nodes when in edit mode
            if (_speedLimitEditMode) {
                for (let i = 0; i < polyline.length; i++) {
                    const pt = camera.worldToScreen(polyline[i][0], polyline[i][1]);
                    // Outer ring
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, SPEED_NODE_RADIUS, 0, Math.PI * 2);
                    ctx.fillStyle = '#ffffff';
                    ctx.fill();
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    // Inner dot
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
                    ctx.fillStyle = color;
                    ctx.fill();
                }
                ctx.lineWidth = Math.max(3, camera.zoom * 8);  // restore line width
            }
        }

        // Draw speed label at midpoint of first polyline
        if (zone.polylines.length > 0 && zone.polylines[0].length >= 2) {
            const pl = zone.polylines[0];
            const midIdx = Math.floor(pl.length / 2);
            const midPt = camera.worldToScreen(pl[midIdx][0], pl[midIdx][1]);

            ctx.fillStyle = color;
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${zone.speedKph} kph`, midPt.x, midPt.y - 15);
            ctx.fillStyle = '#ffffff';
            ctx.font = '12px sans-serif';
            ctx.fillText(zone.name, midPt.x, midPt.y + 15);
        }
    }

    // Edit mode indicator
    if (_speedLimitEditMode) {
        ctx.fillStyle = '#00ff00';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('SPEED EDIT: drag=move | dblclick=add | rightclick=delete | C=copy | TAB=exit', 10, 10);
    }

    ctx.restore();
}

// Alias update -> onFrame for compatibility
async function onFrame(camera, time, realDeltaSeconds) {
    // Sync simTime with external time source (testBundle's time object)
    if (time && typeof time.simTimeSeconds === 'number') {
        simTime = time.simTimeSeconds;
    }

    if (state === OverlayState.OFF) return;

    // Skip physics when paused (but still allow rendering)
    if (time && time.paused) {
        _particlesDirty = true;  // Still need to render current state
        return;
    }

    // Track frame DT for metrics panel (convert to ms)
    _dtMs = realDeltaSeconds * 1000;

    // Use time.timeScale if provided (R key speed modes), else default SIM_TIME_SCALE
    const effectiveScale = (time && typeof time.timeScale === 'number') ? time.timeScale : SIM_TIME_SCALE;
    const simDt = realDeltaSeconds * effectiveScale;

    // Debug: log scale changes
    if (window._lastLoggedScale !== effectiveScale) {
        log(`[FIELD] timeScale=${effectiveScale}, simDt=${simDt.toFixed(4)}`);
        window._lastLoggedScale = effectiveScale;
    }

    await step(simDt);
    _particlesDirty = true;
}

export const ReynosaEastOverlay = {
    id: 'reynosa-east-v2',
    onAttach,
    onDetach,
    onFrame,
    draw,
    setCitySegments,
    toggleCongestionHeatmap,
    toggleBlockBridge,
    togglePhasesAsLots,
    isPhasesAsLots,
    SIM_TIME_SCALE,
};

export default ReynosaEastOverlay;

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG VISUALIZATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

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

    // Initialize offscreen canvas once (reuse buffer, not phi values)
    if (!_debugOffscreen) {
        _debugOffscreen = new OffscreenCanvas(N, N);
        _debugImageData = new ImageData(N, N);
    }

    // Write phi values to ImageData buffer (single loop, no canvas calls)
    const data = _debugImageData.data;
    for (let i = 0; i < N2; i++) {
        const val = phi_pharr[i];
        const off = i * 4;
        if (val >= PHI_LARGE) {
            // Unreachable = red
            data[off] = 255;
            data[off + 1] = 0;
            data[off + 2] = 0;
            data[off + 3] = 77;  // 0.3 * 255
        } else {
            // Grayscale: low phi (near sink) = dark, high phi = light
            const gray = Math.floor(255 * Math.min(1, val / maxPhi));
            data[off] = gray;
            data[off + 1] = gray;
            data[off + 2] = gray;
            data[off + 3] = 128;  // 0.5 * 255
        }
    }

    // Single putImageData + drawImage (vs 23M fillRect calls)
    const offCtx = _debugOffscreen.getContext('2d');
    offCtx.putImageData(_debugImageData, 0, 0);

    const topLeft = camera.worldToScreen(roi.originX, roi.originY);
    const screenSize = camera.metersToPixels(roi.cellSize * N);
    ctx.drawImage(_debugOffscreen, topLeft.x, topLeft.y, screenSize, screenSize);

    // Draw sink cells in green
    ctx.fillStyle = 'rgba(0, 255, 0, 0.7)';
    for (const idx of sinkCellIndices) {
        const x = idx % N;
        const y = Math.floor(idx / N);
        const wx = fieldToWorldX(x);
        const wy = fieldToWorldY(y);
        const screen = camera.worldToScreen({ x: wx, y: wy });
        ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
    }

    // Draw source cells in yellow
    ctx.fillStyle = 'rgba(255, 255, 0, 0.7)';
    for (const idx of sourceCellIndices) {
        const x = idx % N;
        const y = Math.floor(idx / N);
        const wx = fieldToWorldX(x);
        const wy = fieldToWorldY(y);
        const screen = camera.worldToScreen({ x: wx, y: wy });
        ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
    }

    // Draw lot cells in magenta
    ctx.fillStyle = 'rgba(255, 0, 255, 0.4)';
    for (const idx of lotCellIndices) {
        const x = idx % N;
        const y = Math.floor(idx / N);
        const wx = fieldToWorldX(x);
        const wy = fieldToWorldY(y);
        const screen = camera.worldToScreen({ x: wx, y: wy });
        ctx.fillRect(screen.x, screen.y, cellScreenSize, cellScreenSize);
    }

    // Draw corridor entry points as large circles
    ctx.fillStyle = '#00ffff';
    for (const entry of corridorEntryPoints) {
        const screen = camera.worldToScreen({ x: entry.worldX, y: entry.worldY });
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.font = '12px monospace';
        ctx.fillText(entry.id, screen.x + 12, screen.y + 4);
        ctx.fillStyle = '#00ffff';
    }

    // Draw industrial park injection points as orange circles
    ctx.fillStyle = '#ff8800';
    for (const park of _industrialParkInjectionPoints) {
        const wx = fieldToWorldX(park.fieldX);
        const wy = fieldToWorldY(park.fieldY);
        const screen = camera.worldToScreen({ x: wx, y: wy });
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 6, 0, Math.PI * 2);
        ctx.fill();
    }

    // Legend
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(10, 10, 200, 140);
    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.fillText('PHI_PHARR DEBUG', 20, 28);
    ctx.fillStyle = '#00ff00'; ctx.fillText('■ Sink (PHARR)', 20, 48);
    ctx.fillStyle = '#ffff00'; ctx.fillText('■ Sources', 20, 64);
    ctx.fillStyle = '#ff00ff'; ctx.fillText('■ Lots', 20, 80);
    ctx.fillStyle = '#00ffff'; ctx.fillText('● Corridor entries', 20, 96);
    ctx.fillStyle = '#ff8800'; ctx.fillText('● Industrial parks', 20, 112);
    ctx.fillStyle = '#ff0000'; ctx.fillText('■ Unreachable', 20, 128);
    ctx.fillStyle = '#888'; ctx.fillText('■ Phi gradient', 20, 144);
}

/**
 * Get region map for visualization/debugging.
 */
export function getRegionMap() {
    return regionMap;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL DEBUG ACCESS (for console and keybindings)
// ═══════════════════════════════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
    window.reynosaFieldDebug = {
        // Potential field stats
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

        // Grid info
        getGridInfo: () => ({
            N,
            N2,
            cellSize: roi.cellSize,
            roiCenter: { x: roi.centerX, y: roi.centerY },
            roiSize: roi.sizeM,
        }),

        // Cell counts
        getCellCounts: () => ({
            road: roadCellIndices.length,
            lot: lotCellIndices.length,
            sink: sinkCellIndices.length,
            source: sourceCellIndices.length,
        }),

        // Particle stats
        getParticleStats: () => {
            let road = 0, lot = 0, cleared = 0, park = 0, industrial = 0, total = 0;
            for (let i = 0; i < N2; i++) {
                for (const p of cellParticles[i]) {
                    total++;
                    if (p.state === STATE.ROAD) road++;
                    else if (p.state === STATE.LOT) lot++;
                    else if (p.state === STATE.CLEARED) cleared++;
                    else if (p.state === STATE.PARK) park++;
                }
            }
            const lanesInUse = CBP_LANES.filter(l => l.particle !== null).length;
            return {
                total, road, lot, cleared, park, industrial,
                sinkQueue: sinkQueue.length,
                sinkCapKgPerHour,
                cbpLanes: getEffectiveLanes(),
                cbpLanesInUse: lanesInUse,
                cbpServiceTimeS: SERVICE_TIME_S,
            };
        },

        // Dump all lot_full stuck particles with full diagnostic info
        dumpLotFullParticles: () => {
            const stuck = [];
            for (let i = 0; i < N2; i++) {
                for (const p of cellParticles[i]) {
                    if (p.stallReason !== 'lot_full') continue;

                    const cx = p.cellIdx % N;
                    const cy = Math.floor(p.cellIdx / N);
                    const nh = nextHop_lots[p.cellIdx];
                    const phiHere = phi_lots[p.cellIdx];

                    // Get neighbor phi values
                    const neighbors = {};
                    if (cx > 0) neighbors.W = { idx: p.cellIdx - 1, phi: phi_lots[p.cellIdx - 1], nh: nextHop_lots[p.cellIdx - 1] };
                    if (cx < N - 1) neighbors.E = { idx: p.cellIdx + 1, phi: phi_lots[p.cellIdx + 1], nh: nextHop_lots[p.cellIdx + 1] };
                    if (cy > 0) neighbors.N = { idx: p.cellIdx - N, phi: phi_lots[p.cellIdx - N], nh: nextHop_lots[p.cellIdx - N] };
                    if (cy < N - 1) neighbors.S = { idx: p.cellIdx + N, phi: phi_lots[p.cellIdx + N], nh: nextHop_lots[p.cellIdx + N] };

                    // Check lot fill at nextHop if it's a lot
                    let nhLotInfo = null;
                    if (nh >= 0 && regionMap[nh] === REGION.LOT) {
                        const lotIdx = cellToLotIndex[nh];
                        if (lotIdx >= 0) {
                            nhLotInfo = {
                                lotIdx,
                                fill: (lotMass[lotIdx] / lotCapacity[lotIdx] * 100).toFixed(1) + '%',
                                draining: lotDraining.has(lotIdx),
                                cooldown: lotCooldownEndSimS[lotIdx] > simTime,
                            };
                        }
                    }

                    // Find all forward neighbors (lower phi)
                    const forwardOptions = [];
                    for (const [dir, n] of Object.entries(neighbors)) {
                        if (n.phi < phiHere && n.phi < PHI_LARGE) {
                            const region = regionMap[n.idx];
                            let blocked = false;
                            let reason = '';
                            if (Kxx[n.idx] < K_THRESHOLD && Kyy[n.idx] < K_THRESHOLD) {
                                blocked = true;
                                reason = 'low_K';
                            } else if (region === REGION.LOT) {
                                const lotIdx = cellToLotIndex[n.idx];
                                if (lotIdx >= 0 && lotMass[lotIdx] / lotCapacity[lotIdx] >= _lotAdmissionCutoff) {
                                    blocked = true;
                                    reason = 'lot_full';
                                }
                            }
                            forwardOptions.push({ dir, idx: n.idx, phi: n.phi, region, blocked, reason });
                        }
                    }

                    stuck.push({
                        id: p.id,
                        x: p.x.toFixed(1),
                        y: p.y.toFixed(1),
                        cellIdx: p.cellIdx,
                        cellXY: `(${cx},${cy})`,
                        state: Object.keys(STATE).find(k => STATE[k] === p.state),
                        region: Object.keys(REGION).find(k => REGION[k] === regionMap[p.cellIdx]),
                        phiHere: phiHere < PHI_LARGE ? phiHere.toFixed(1) : 'UNREACHABLE',
                        nextHop: nh,
                        nextHopRegion: nh >= 0 ? Object.keys(REGION).find(k => REGION[k] === regionMap[nh]) : 'NONE',
                        nhLotInfo,
                        forwardOptions,
                        stalledTime: (p.stalledTime || 0).toFixed(1) + 's',
                        neighbors: Object.fromEntries(
                            Object.entries(neighbors).map(([dir, n]) => [
                                dir,
                                {
                                    phi: n.phi < PHI_LARGE ? n.phi.toFixed(1) : 'X',
                                    region: Object.keys(REGION).find(k => REGION[k] === regionMap[n.idx]) || 'VOID',
                                    K: Kxx[n.idx].toFixed(2),
                                }
                            ])
                        ),
                    });
                }
            }
            return stuck;
        },

        // CAUSAL DEBUGGING: Rebuild event log with full lifecycle
        getRebuildEventLog: () => [..._rebuildEventLog],

        // CAUSAL DEBUGGING: Current routing version
        getRoutingVersion: () => _routingVersion,

        // CAUSAL DEBUGGING: Particles with stale routing (stallStartVersion < current)
        getStaleStalls: () => {
            const stale = [];
            for (let i = 0; i < N2; i++) {
                for (const p of cellParticles[i]) {
                    if (p.stallReason && p.stallStartVersion >= 0 && p.stallStartVersion < _routingVersion) {
                        stale.push({
                            id: p.id,
                            cellIdx: p.cellIdx,
                            stallReason: p.stallReason,
                            stallStartVersion: p.stallStartVersion,
                            currentVersion: _routingVersion,
                            versionsBehind: _routingVersion - p.stallStartVersion,
                            lastRouteCell: p.lastRouteCell,
                            lastRouteNh: p.lastRouteNh,
                            currentNh: nextHop_lots[p.cellIdx],
                            nhChanged: nextHop_lots[p.cellIdx] !== p.lastRouteNh,
                        });
                    }
                }
            }
            return stale;
        },

        // Injection point info
        getInjectionInfo: () => ({
            corridorEntries: corridorEntryPoints.map(e => ({
                id: e.id,
                worldX: e.worldX,
                worldY: e.worldY,
                fieldX: e.fieldX,
                fieldY: e.fieldY,
                ratio: _injectionPointRatios?.get(e.id) ?? 'equal',
            })),
            industrialParks: _industrialParkInjectionPoints.length,
            parksByZone: INDUSTRIAL_ZONES.map(z => ({
                zone: z.id,
                share: z.share,
                parks: _industrialParkInjectionPoints.filter(p => p.zone === z.id).length,
            })),
            corridorRatio: CORRIDOR_TRAFFIC_RATIO,
            localRatio: REYNOSA_LOCAL_RATIO,
        }),

        // Lot stats
        getLotStats: () => {
            const stats = [];
            for (let i = 0; i < lotCapacity.length; i++) {
                stats.push({
                    lotIdx: i,
                    mass: lotMass[i],
                    capacity: lotCapacity[i],
                    utilization: lotCapacity[i] > 0 ? (lotMass[i] / lotCapacity[i] * 100).toFixed(1) + '%' : 'N/A',
                });
            }
            return stats;
        },

        // Metrics
        getMetrics: () => ({ ...metrics }),

        // Rebuild routing
        rebuildPhiBase: async () => {
            await forceRebuildPhiBase();
            log('[FIELD DEBUG] Potentials rebuilt');
        },

        // Toggle debug colors
        toggleParticleColors: () => toggleParticleDebugClassColors(),

        // Toggle dark mode (backtick key)
        toggleDarkMode: () => toggleDarkMode(),

        // Toggle phases as lots (FASE 1, FASE 2 become lots)
        togglePhasesAsLots: () => togglePhasesAsLots(),

        // Current state
        isParticleDebugColors: () => _particleDebugColors,
        isDarkMode: () => _darkMode,
        isPhasesAsLots: () => _phasesAsLots,

        // Lot exclusion state (why lots are excluded from routing)
        getLotExclusionState: () => {
            const state = {
                admissionCutoff: _lotAdmissionCutoff,
                lots: [],
                summary: { available: 0, full: 0, draining: 0, cooldown: 0 },
            };
            for (let i = 0; i < lotCapacity.length; i++) {
                const fill = lotCapacity[i] > 0 ? lotMass[i] / lotCapacity[i] : 0;
                const isDraining = lotDraining.has(i);
                const cooldownRemaining = lotCooldownEndSimS[i] > simTime
                    ? (lotCooldownEndSimS[i] - simTime).toFixed(0) + 's'
                    : null;
                const aboveCutoff = fill >= _lotAdmissionCutoff;

                let status = 'available';
                if (isDraining) {
                    status = 'draining';
                    state.summary.draining++;
                } else if (cooldownRemaining) {
                    status = 'cooldown';
                    state.summary.cooldown++;
                } else if (aboveCutoff) {
                    status = 'full';
                    state.summary.full++;
                } else {
                    state.summary.available++;
                }

                state.lots.push({
                    lotIdx: i,
                    fill: (fill * 100).toFixed(1) + '%',
                    status,
                    isDraining,
                    cooldownRemaining,
                    cellCount: lotToCellIndices[i]?.length || 0,
                });
            }
            return state;
        },

        // Cell debug info at world coordinates
        getCellDebugInfo: (worldX, worldY) => {
            const fx = Math.floor(worldToFieldX(worldX));
            const fy = Math.floor(worldToFieldY(worldY));
            if (fx < 0 || fx >= N || fy < 0 || fy >= N) return null;
            const idx = fy * N + fx;

            return {
                cellIdx: idx,
                fieldXY: `(${fx},${fy})`,
                region: Object.keys(REGION).find(k => REGION[k] === regionMap[idx]) || 'VOID',
                phi_lots: phi_lots[idx] < PHI_LARGE ? phi_lots[idx].toFixed(1) : 'UNREACHABLE',
                phi_pharr: phi_pharr[idx] < PHI_LARGE ? phi_pharr[idx].toFixed(1) : 'UNREACHABLE',
                nextHop_lots: nextHop_lots[idx],
                nextHop_pharr: nextHop_pharr[idx],
                Kxx: Kxx[idx].toFixed(3),
                Kyy: Kyy[idx].toFixed(3),
                mass: cellMass[idx].toFixed(0) + ' kg',
                particleCount: cellParticles[idx].length,
                lotIdx: cellToLotIndex[idx] >= 0 ? cellToLotIndex[idx] : null,
            };
        },

        // Get routing state for specific cell
        getRoutingAtCell: (cellIdx) => {
            if (cellIdx < 0 || cellIdx >= N2) return null;
            const cx = cellIdx % N;
            const cy = Math.floor(cellIdx / N);
            const phiHere = phi_lots[cellIdx];
            const nh = nextHop_lots[cellIdx];

            const neighbors = {};
            if (cx > 0) {
                const ni = cellIdx - 1;
                neighbors.W = {
                    idx: ni,
                    phi: phi_lots[ni] < PHI_LARGE ? phi_lots[ni].toFixed(1) : 'X',
                    nh: nextHop_lots[ni],
                    isForward: phi_lots[ni] < phiHere,
                    K: Kxx[ni].toFixed(2),
                };
            }
            if (cx < N - 1) {
                const ni = cellIdx + 1;
                neighbors.E = {
                    idx: ni,
                    phi: phi_lots[ni] < PHI_LARGE ? phi_lots[ni].toFixed(1) : 'X',
                    nh: nextHop_lots[ni],
                    isForward: phi_lots[ni] < phiHere,
                    K: Kxx[ni].toFixed(2),
                };
            }
            if (cy > 0) {
                const ni = cellIdx - N;
                neighbors.N = {
                    idx: ni,
                    phi: phi_lots[ni] < PHI_LARGE ? phi_lots[ni].toFixed(1) : 'X',
                    nh: nextHop_lots[ni],
                    isForward: phi_lots[ni] < phiHere,
                    K: Kyy[ni].toFixed(2),
                };
            }
            if (cy < N - 1) {
                const ni = cellIdx + N;
                neighbors.S = {
                    idx: ni,
                    phi: phi_lots[ni] < PHI_LARGE ? phi_lots[ni].toFixed(1) : 'X',
                    nh: nextHop_lots[ni],
                    isForward: phi_lots[ni] < phiHere,
                    K: Kyy[ni].toFixed(2),
                };
            }

            return {
                cellIdx,
                cellXY: `(${cx},${cy})`,
                phi_lots: phiHere < PHI_LARGE ? phiHere.toFixed(1) : 'UNREACHABLE',
                nextHop: nh,
                neighbors,
                forwardCount: Object.values(neighbors).filter(n => n.isForward && n.phi !== 'X').length,
            };
        },

        // Dump CBP lane and sink queue state for debugging queue processing issues
        dumpCBPState: () => {
            const lanes = CBP_LANES.map((lane, i) => ({
                laneIdx: i,
                hasParticle: lane.particle !== null,
                particleId: lane.particle?.id ?? null,
                busyUntil: lane.busyUntil,
                busyUntilVsNow: lane.busyUntil - simTime,
                willCompleteThisTick: lane.particle && lane.busyUntil <= simTime,
            }));
            const queuedParticles = sinkQueue.slice(0, 10).map(p => ({
                id: p.id,
                cellIdx: p.cellIdx,
                region: regionMap[p.cellIdx],
                state: Object.keys(STATE).find(k => STATE[k] === p.state),
            }));

            // Count particles by visual classification vs actual sinkQueue
            let inSinkRegion = 0;
            let inQueueZone = 0;
            let visuallyQueued = 0;
            for (let i = 0; i < N2; i++) {
                for (const p of cellParticles[i]) {
                    if (regionMap[p.cellIdx] === REGION.SINK) {
                        inSinkRegion++;
                        visuallyQueued++;
                    } else if (p.renderStalled && isInQueueZone(p.x, p.y)) {
                        inQueueZone++;
                        visuallyQueued++;
                    }
                }
            }

            return {
                simTime,
                SERVICE_TIME_S,
                sinkCapKgPerHour,
                bridgeOpen: isFinite(SERVICE_TIME_S) && sinkCapKgPerHour > 0,
                queueLength: sinkQueue.length,
                queuedParticles,
                lanes,
                lanesInUse: lanes.filter(l => l.hasParticle).length,
                lanesFree: lanes.filter(l => !l.hasParticle).length,
                // Diagnostic: visual vs actual queue
                inSinkRegion,        // Actually in sinkQueue (SINK cells)
                inQueueZone,         // Visually blue but NOT in sinkQueue
                visuallyQueued,      // Total appearing as "in queue"
                mismatch: visuallyQueued !== sinkQueue.length,
            };
        },

        // Full sink approach mechanism analysis
        dumpSinkApproach: () => {
            // 1. Sink cells configuration
            const sinkCells = sinkCellIndices.map(idx => ({
                idx,
                x: idx % N,
                y: Math.floor(idx / N),
                particles: cellParticles[idx].length,
                mass: cellMass[idx],
            }));
            const totalInSink = sinkCells.reduce((sum, c) => sum + c.particles, 0);

            // 2. Find approach cells (cells with nextHop pointing to sink)
            const approachCells = [];
            const sinkSet = new Set(sinkCellIndices);
            for (let idx = 0; idx < N2; idx++) {
                if (sinkSet.has(idx)) continue;
                const nh = nextHop_pharr[idx];
                if (nh >= 0 && sinkSet.has(nh)) {
                    const particles = cellParticles[idx].length;
                    const phi = phi_pharr[idx];
                    const congested = particles > 0 && cellParticles[idx].some(p => p.renderStalled);
                    approachCells.push({
                        idx,
                        x: idx % N,
                        y: Math.floor(idx / N),
                        nextHop: nh,
                        phi: phi.toFixed(2),
                        particles,
                        congested,
                        mass: cellMass[idx],
                    });
                }
            }

            // 3. Particles waiting to enter sink (CLEARED state, approaching)
            let waitingToEnter = 0;
            let congestedApproach = 0;
            for (const cell of approachCells) {
                for (const p of cellParticles[cell.idx]) {
                    if (p.state === STATE.CLEARED) {
                        waitingToEnter++;
                        if (p.renderStalled) congestedApproach++;
                    }
                }
            }

            // 4. Find wider approach zone (2-hop from sink)
            const approachSet = new Set(approachCells.map(c => c.idx));
            const widerApproach = [];
            for (let idx = 0; idx < N2; idx++) {
                if (sinkSet.has(idx) || approachSet.has(idx)) continue;
                const nh = nextHop_pharr[idx];
                if (nh >= 0 && approachSet.has(nh)) {
                    const particles = cellParticles[idx].length;
                    if (particles > 0) {
                        widerApproach.push({
                            idx,
                            x: idx % N,
                            y: Math.floor(idx / N),
                            particles,
                            congested: cellParticles[idx].some(p => p.renderStalled),
                        });
                    }
                }
            }

            // 5. All CLEARED particles and their distance to sink
            const clearedParticles = [];
            for (let i = 0; i < _activeParticleCount; i++) {
                const p = _activeParticles[i];
                if (p.state === STATE.CLEARED) {
                    const phi = phi_pharr[p.cellIdx];
                    const inApproach = approachSet.has(p.cellIdx);
                    const inWider = widerApproach.some(c => c.idx === p.cellIdx);
                    clearedParticles.push({
                        id: p.id,
                        cellIdx: p.cellIdx,
                        phi: phi < 1e8 ? phi.toFixed(1) : 'unreachable',
                        stalled: p.renderStalled,
                        stallReason: p.stallReason,
                        inApproach,
                        inWider,
                    });
                }
            }
            clearedParticles.sort((a, b) => parseFloat(a.phi) - parseFloat(b.phi));

            // 6. CBP lane throughput
            const lanesInUse = CBP_LANES.filter(l => l.particle !== null).length;
            const trucksPerHour = sinkCapKgPerHour / TRUCK_KG;
            const maxTrucksPerHour = trucksPerHour;
            const actualTrucksInLanes = lanesInUse;

            return {
                timestamp: simTime,
                bridgeOpen: isBridgeOpen(),
                sinkCapKgPerHour,
                trucksPerHourCapacity: trucksPerHour.toFixed(0),
                serviceTimeS: SERVICE_TIME_S.toFixed(1),

                // Sink state
                sinkCellCount: sinkCellIndices.length,
                particlesInSink: totalInSink,
                sinkQueueLength: sinkQueue.length,
                cbpLanesInUse: lanesInUse,
                cbpLanesFree: getEffectiveLanes() - lanesInUse,

                // Approach analysis (1-hop from sink)
                approachCellCount: approachCells.length,
                particlesInApproach: waitingToEnter,
                congestedInApproach: congestedApproach,
                approachCells: approachCells.filter(c => c.particles > 0),

                // Wider approach (2-hop from sink)
                widerApproachWithParticles: widerApproach.length,
                particlesInWiderApproach: widerApproach.reduce((sum, c) => sum + c.particles, 0),

                // All CLEARED particles (sorted by phi, closest first)
                clearedTotal: clearedParticles.length,
                clearedStalled: clearedParticles.filter(p => p.stalled).length,
                clearedClosest10: clearedParticles.slice(0, 10),
                clearedUnreachable: clearedParticles.filter(p => p.phi === 'unreachable').length,

                // Bottleneck diagnosis
                diagnosis: (() => {
                    if (!isBridgeOpen()) return 'BRIDGE_CLOSED';
                    if (sinkQueue.length > 5 && lanesInUse < getEffectiveLanes()) return 'QUEUE_NOT_DRAINING';
                    if (waitingToEnter > 0 && sinkQueue.length === 0) return 'APPROACH_CONGESTED';
                    if (clearedParticles.length > 0 && waitingToEnter === 0) return 'UPSTREAM_BOTTLENECK';
                    if (clearedParticles.length === 0) return 'NO_CLEARED_PARTICLES';
                    return 'NOMINAL';
                })(),
            };
        },

        // Get bridge approach region info
        getBridgeApproachRegion: () => {
            if (!_bridgeApproachCache) return { error: 'Cache not initialized' };
            let cellCount = 0;
            let particleCount = 0;
            let congested = 0;
            for (let idx = 0; idx < N2; idx++) {
                if (_bridgeApproachCache[idx] === 1) {
                    cellCount++;
                    const pCount = cellParticles[idx].length;
                    particleCount += pCount;
                    if (pCount > 0 && cellMass[idx] > RHO_CONGESTION_0) congested++;
                }
            }
            return {
                quad: BRIDGE_APPROACH_QUAD,
                cellCount,
                particleCount,
                congestedCells: congested,
                capacityMultiplier: SINK_CAP_MULT * _twinSpanCapMult,
                twinSpanActive: _twinSpanCapMult > 1,
                effectiveCapPerCell: ROAD_CELL_CAP_KG * SINK_CAP_MULT * _twinSpanCapMult,
            };
        },
    };

    log('[ReynosaOverlay v2] Debug API available at window.reynosaFieldDebug');
    log('[ReynosaOverlay v2] Keys: M=debug colors, `=dark mode, D=debug layer, TAB=cycle layers');
    log('[ReynosaOverlay v2] Causal debug: getRebuildEventLog(), getStaleStalls(), getRoutingVersion()');
    log('[ReynosaOverlay v2] CBP debug: dumpCBPState() - diagnose sink queue processing');
}