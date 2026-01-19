// ═══════════════════════════════════════════════════════════════════════════════
// FRICTION UPDATE — Congestion factor and commuter load calculations
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Congestion physics calculations.
//

/**
 * Build congestion lookup table for fast factor calculation.
 * Uses power law: factor = 1 / (1 + (rho/rho0)^p)
 * @param {number} size - LUT size (typically 1024)
 * @param {number} p - Congestion power exponent
 * @returns {Float32Array} Lookup table
 */
export function buildCongestionLUT(size, p) {
    const lut = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        lut[i] = 1 / (1 + Math.pow(i / 100, p));
    }
    return lut;
}

/**
 * Compute congestion factor from density using lookup table.
 * Returns value in (0, 1] where 1 = free flow, →0 = stalled.
 * @param {number} rho - Local mass density (kg per cell)
 * @param {Float32Array} lut - Congestion lookup table
 * @param {number} lutSize - LUT size
 * @param {number} rhoOnset - Onset density (kg)
 * @returns {number} Congestion factor
 */
export function congestionFactor(rho, lut, lutSize, rhoOnset) {
    if (rho <= 0) return 1.0;
    // LUT lookup: ratio * 100 gives index (0.01 precision)
    const idx = Math.min(lutSize - 1, (rho / rhoOnset * 100) | 0);
    return lut[idx];
}

/**
 * @typedef {Object} CommuterUpdateContext
 * @property {number} currentHour - Current simulation hour (0-23)
 * @property {Float32Array} baseCommuterWeight - Base spatial weights
 * @property {Float32Array} commuterLoad - Output load array to update
 * @property {Uint8Array} commuterType - Cell commuter type codes
 * @property {Set|Array} commuterCellIndices - Sparse set of cells with commuter weight
 * @property {function} arterialMultiplier - Hour multiplier for arterial
 * @property {function} approachMultiplier - Hour multiplier for approach
 * @property {function} aduanaMultiplier - Hour multiplier for aduana
 * @property {function} urbanMultiplier - Hour multiplier for urban
 * @property {number} CTYPE_ARTERIAL - Type code for arterial
 * @property {number} CTYPE_INDUSTRIAL - Type code for industrial
 * @property {number} CTYPE_ADUANA - Type code for aduana
 * @property {number} CTYPE_URBAN - Type code for urban
 */

/**
 * Update commuterLoad array based on current hour and spatial weights.
 * @param {CommuterUpdateContext} ctx - Update context
 */
export function updateCommuterLoad(ctx) {
    const { currentHour, baseCommuterWeight, commuterLoad, commuterType, commuterCellIndices,
            arterialMultiplier, approachMultiplier, aduanaMultiplier, urbanMultiplier,
            CTYPE_ARTERIAL, CTYPE_INDUSTRIAL, CTYPE_ADUANA, CTYPE_URBAN } = ctx;

    const artMult = arterialMultiplier(currentHour);
    const appMult = approachMultiplier(currentHour);
    const aduMult = aduanaMultiplier(currentHour);
    const urbMult = urbanMultiplier(currentHour);

    // Sparse iteration — only cells with non-zero weight
    for (const i of commuterCellIndices) {
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
}
