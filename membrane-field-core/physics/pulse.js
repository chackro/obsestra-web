// ═══════════════════════════════════════════════════════════════════════════════
// PULSE — Injection pulse modulation and shift scheduling
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Industrial shift patterns and injection pulse modulation for organic arrival waves.
//

// ───────────────────────────────────────────────────────────────────────────────
// INDUSTRIAL SHIFT PATTERN (3-shift manufacturing schedule)
//
// PRIOR — not empirically measured.
// Industrial parks produce on shift schedules, NOT following CIEN demand.
// Corridors follow CIEN hourly profile (demand-driven, empirical).
// Industrial follows shift pattern (production-driven, assumed).
// ───────────────────────────────────────────────────────────────────────────────

export const PRIOR_INDUSTRIAL_SHIFT_SHARES = {
    day:     0.45,  // 06:00-14:00: 45% — highest staffing, fresh workers
    evening: 0.35,  // 14:00-22:00: 35% — moderate
    night:   0.20,  // 22:00-06:00: 20% — skeleton crew, maintenance windows
};

// Shift boundaries (end times where release bias peaks)
export const SHIFT_END_HOURS = [6, 14, 22];
export const SHIFT_BIAS_WINDOW = 1.5;    // Hours before/after shift end
export const SHIFT_BIAS_MAX = 0.25;      // Max +25% boost at shift boundary

// Industrial pulse damping (smoother than corridors)
export const INDUSTRIAL_PULSE_DAMPING = 0.17;  // ±15% range (vs corridor's full ±88%)

/**
 * Compute trapezoid multiplier for within-shift density.
 * Ramp up first 20%, flat middle 60%, ramp down last 20%.
 * @param {number} progressInShift - 0.0 to 1.0 progress through 8-hour shift
 * @returns {number} Multiplier (0.0 to 1.0, averages ~0.8 for mass conservation)
 */
export function getTrapezoidMultiplier(progressInShift) {
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
export function getShiftBoundaryBias(hour) {
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
export function getIndustrialShiftFraction(hour) {
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

/**
 * Smooth ramp function: rises from 0 to 1 over rampWidth hours centered at peakHour.
 * @param {number} hour - Current hour
 * @param {number} peakHour - Hour at peak
 * @param {number} rampWidth - Width of ramp in hours
 * @param {number} peakValue - Value at peak
 * @param {number} baseValue - Value outside ramp
 * @returns {number} Smoothstepped value
 */
export function smoothPulse(hour, peakHour, rampWidth, peakValue, baseValue) {
    const dist = Math.abs(hour - peakHour);
    if (dist >= rampWidth) return baseValue;
    // Cosine smoothstep: smooth rise and fall
    const t = 1 - dist / rampWidth;
    const smooth = t * t * (3 - 2 * t);  // smoothstep
    return baseValue + (peakValue - baseValue) * smooth;
}

// Phase offsets for different source types (creates staggered waves)
export const CORRIDOR_PHASE_OFFSETS = {
    'ENTRY_VICTORIA': 0,
    'ENTRY_MTY': 1350,  // 22.5 min offset (half period - maximally out of phase)
};

export const ZONE_PHASE_OFFSETS = {
    'norte': 450,         // 7.5 min offset
    'poniente': 1800,     // 30 min offset
    'san_fernando': 900,  // 15 min offset
    'pharr_bridge': 2250, // 37.5 min offset
};

/**
 * Get pulse multiplier for injection at given sim time.
 * Uses overlapping sine waves at incommensurate periods for organic variation.
 * Always some flow (never fully off), peaks and troughs vary naturally.
 * Average multiplier ≈ 1.0 to preserve hourly totals.
 *
 * @param {number} simTimeS - Current simulation time in seconds
 * @param {number} phaseOffset - Base phase offset for this source type
 * @param {number} sourceIdx - Source cell index (adds per-source micro-variation)
 * @returns {number} Pulse multiplier (min 0.12)
 */
export function getPulseMultiplier(simTimeS, phaseOffset = 0, sourceIdx = 0) {
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
