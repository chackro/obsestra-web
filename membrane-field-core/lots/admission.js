// ═══════════════════════════════════════════════════════════════════════════════
// Lot Admission — Dwell sampling and capacity constants
// ═══════════════════════════════════════════════════════════════════════════════
//
// This module contains pure functions and constants for lot admission:
// - Dwell time sampling (bimodal distribution: cold chain vs non-cold)
// - Park and lot timing constants
//
// NO STATE. These are pure functions that require an RNG to be passed in.
//
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// DWELL TIME CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
// Source: BTS HS2 x POE x direction x transport mode query (Pharr-specific)
// 64% cold chain (shorter dwell), 36% non-cold (longer dwell)

export const DWELL_HOURS_MEAN = 46;              // Approximate mean (for documentation only)
export const DWELL_S_MEAN = DWELL_HOURS_MEAN * 3600;

export const COLD_CHAIN_FRACTION = 0.64;

// ═══════════════════════════════════════════════════════════════════════════════
// PARK TIMING CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

export const PARK_DWELL_HOURS = 4;               // Hours in park before release to lot
export const PARK_DWELL_S = PARK_DWELL_HOURS * 3600;     // Dwell time in seconds
export const PARK_DWELL_24H_S = 24 * 3600;       // 24-hour dwell for industrial park particles

// Park capacity density (kg per m² of park area)
export const PARK_KG_PER_M2 = 4.0;               // Higher than lots - staging is denser

// ═══════════════════════════════════════════════════════════════════════════════
// LOT COOLDOWN
// ═══════════════════════════════════════════════════════════════════════════════

export const LOT_COOLDOWN_S = 60;                // 60 sim-seconds after empty (dt-invariant)

// ═══════════════════════════════════════════════════════════════════════════════
// DWELL SAMPLING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Triangular distribution: bounded, has mode, easy to reason about.
 * @param {number} min - Minimum value
 * @param {number} mode - Most likely value
 * @param {number} max - Maximum value
 * @param {function} rng - Random number generator returning [0, 1)
 * @returns {number} Sampled value
 */
export function triangular(min, mode, max, rng) {
    const u = rng();
    const f = (mode - min) / (max - min);
    if (u < f) {
        return min + Math.sqrt(u * (max - min) * (mode - min));
    } else {
        return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    }
}

/**
 * Sample dwell time in seconds (bimodal distribution).
 * Cold chain: 36-48 hours, mode 40h
 * Non-cold: 48-72 hours, mode 54h
 *
 * @param {function} rng - Random number generator returning [0, 1)
 * @returns {number} Dwell time in seconds
 */
export function sampleDwellSeconds(rng) {
    if (rng() < COLD_CHAIN_FRACTION) {
        return triangular(36, 40, 48, rng) * 3600;
    } else {
        return triangular(48, 54, 72, rng) * 3600;
    }
}
