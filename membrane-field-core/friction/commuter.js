// ═══════════════════════════════════════════════════════════════════════════════
// Commuter Friction — Time-of-day capacity theft modeling
// ═══════════════════════════════════════════════════════════════════════════════
//
// This module models commuter traffic as "capacity theft" — the effective
// reduction in road capacity due to light vehicles sharing lanes with trucks.
//
// NO cars, NO buses, NO new particles. This is capacity theft, not traffic sim.
//
// Source: MetroCount pneumatic tube study, Colonial corridor, March 2023
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUTER FORCING CURVE — Field calibrated hourly multipliers
// ═══════════════════════════════════════════════════════════════════════════════
//
// Source: MetroCount P1 light-vehicle hourly volumes, normalized to peak (6am = 1.0)
// Modulates effective density / friction seen by trucks
//
export const COMMUTER_MULT_24 = [
    0.342, 0.300, 0.300, 0.352, 0.439, 0.853, 1.000, 0.816,  // 00:00-07:00
    0.728, 0.642, 0.710, 0.784, 0.812, 0.779, 0.721, 0.767,  // 08:00-15:00
    0.821, 0.839, 0.746, 0.599, 0.518, 0.485, 0.451, 0.383   // 16:00-23:00
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUTER EQUIVALENT MASS — Field calibrated
// ═══════════════════════════════════════════════════════════════════════════════
//
// CALIBRATION FORMULA:
//   COMMUTER_EQUIV_KG = (occ_target × ROAD_CELL_CAP_KG) / L_peak
//
// Where:
//   occ_target = 0.35 (measured capacity theft at 35% pre-truck occupancy)
//   ROAD_CELL_CAP_KG = 27,000 (grid-derived)
//   L_peak = 1.0 (Colonial corridor at 6am)
//
// Result: COMMUTER_EQUIV_KG = 0.35 × 27,000 / 1.0 = 9,450 ≈ 9,000
//
export const COMMUTER_EQUIV_KG = 9000;

// Visual/secondary effects
export const COMMUTER_LANE_SHRINK = 0.35;    // Lane narrowing visual factor
export const COMMUTER_SPEED_PENALTY = 0.15;  // Direct friction (weaving/yielding)

// ═══════════════════════════════════════════════════════════════════════════════
// TIME-OF-DAY MULTIPLIER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Arterial multiplier: peaks at 7:30AM, 2PM, 8PM.
 * Peak: 1.2, Medium: 0.6 (daytime), Low: 0.24 (night)
 *
 * @param {number} hour - Hour of day (0-23)
 * @returns {number} Multiplier [0.24, 1.2]
 */
export function arterialMultiplier(hour) {
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
 * ============================================================
 *
 * @param {number} hour - Hour of day (0-23)
 * @returns {number} Multiplier from COMMUTER_MULT_24
 */
export function approachMultiplier(hour) {
    return COMMUTER_MULT_24[hour % 24];
}

/**
 * Urban arterial multiplier: peak at 7PM only, otherwise clear.
 * Peak: 1.0 at 19:00, shoulder at 18-20, otherwise 0.
 *
 * @param {number} hour - Hour of day (0-23)
 * @returns {number} Multiplier [0, 1.0]
 */
export function urbanMultiplier(hour) {
    if (hour === 19) return 1.0;
    if (hour === 18 || hour === 20) return 0.5;
    return 0;
}

/**
 * Aduana (customs/border) multiplier: dual peaks at shift boundaries.
 * Peak at 6AM and 4PM (shift start/end), medium at 10AM and 8PM.
 *
 * @param {number} hour - Hour of day (0-23)
 * @returns {number} Multiplier [0.15, 1.0]
 */
export function aduanaMultiplier(hour) {
    // Peak: 6AM, 4PM (1.0)
    if (hour === 6 || hour === 16) return 1.0;
    if (hour === 5 || hour === 7 || hour === 15 || hour === 17) return 0.8;
    // Medium: 10AM, 8PM (0.5)
    if (hour === 10 || hour === 20) return 0.5;
    if (hour === 9 || hour === 11 || hour === 19 || hour === 21) return 0.35;
    // Daytime base
    if (hour >= 8 && hour <= 18) return 0.25;
    // Night
    return 0.15;
}

/**
 * Legacy wrapper for compatibility.
 * Alias for approachMultiplier.
 *
 * @param {number} hour - Hour of day (0-23)
 * @returns {number} Multiplier from COMMUTER_MULT_24
 */
export function commuterMultiplier(hour) {
    return approachMultiplier(hour);
}
