// ═══════════════════════════════════════════════════════════════════════════════
// ALPHA DRIVER
// Controls scenario interpolation over synthetic simulation time.
//
// α(t) ∈ [0,1], monotonic, deterministic
// Encodes entire narrative: constrained → unconstrained
//
// NOT user-controlled. NOT toggleable. Pure function of sim time.
// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────────
// CURVE TYPES
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Alpha curve types for different narrative shapes.
 */
export const AlphaCurve = Object.freeze({
    LINEAR: 'LINEAR',             // α = t (constant rate)
    SMOOTHSTEP: 'SMOOTHSTEP',     // Hermite smoothstep (eases in/out)
    PLATEAU_RAMP: 'PLATEAU_RAMP', // Hold at 0, then ramp
});

// ───────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AlphaConfig
 * @property {string} curve - Curve type from AlphaCurve
 * @property {number} startHour - Sim hour when α starts increasing
 * @property {number} endHour - Sim hour when α reaches 1.0
 * @property {number} [plateauUntil] - For PLATEAU_RAMP: hold at 0 until this hour
 */

const DEFAULT_CONFIG = Object.freeze({
    curve: AlphaCurve.SMOOTHSTEP,
    startHour: 0,    // α starts rising at midnight
    endHour: 24,     // α reaches 1.0 at end of day (full 24hr ramp)
});

let _config = { ...DEFAULT_CONFIG };

// ───────────────────────────────────────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────────────────────────────────────

let _lastAlpha = 0;      // For monotonicity enforcement
let _lastSimHour = 0;    // For debugging/inspection

// ───────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Configure alpha driver.
 * Resets state when called.
 *
 * @param {Partial<AlphaConfig>} config
 */
export function configureAlpha(config) {
    _config = { ...DEFAULT_CONFIG, ...config };
    _lastAlpha = 0;
    _lastSimHour = 0;

    console.log('[AlphaDriver] Configured:', _config);
}

/**
 * Compute α(t) for given simulation hour.
 *
 * INVARIANT: Result is monotonically non-decreasing.
 * INVARIANT: Result ∈ [0, 1].
 *
 * @param {number} simHour - Simulation time in hours (can be fractional)
 * @returns {number} Alpha value in [0, 1]
 */
export function computeAlpha(simHour) {
    const { curve, startHour, endHour, plateauUntil } = _config;

    // Normalize time to [0, 1] range within the ramp window
    let t;
    if (simHour <= startHour) {
        t = 0;
    } else if (simHour >= endHour) {
        t = 1;
    } else {
        t = (simHour - startHour) / (endHour - startHour);
    }

    // Apply curve transformation
    let alpha;
    switch (curve) {
        case AlphaCurve.LINEAR:
            alpha = t;
            break;

        case AlphaCurve.SMOOTHSTEP:
            // Hermite smoothstep: 3t² - 2t³
            // Smooth acceleration at start, smooth deceleration at end
            alpha = t * t * (3 - 2 * t);
            break;

        case AlphaCurve.PLATEAU_RAMP:
            // Hold at 0 until plateauUntil, then linear ramp
            const plateau = plateauUntil ?? startHour;
            if (simHour < plateau) {
                alpha = 0;
            } else if (simHour >= endHour) {
                alpha = 1;
            } else {
                const rampT = (simHour - plateau) / (endHour - plateau);
                alpha = Math.max(0, Math.min(1, rampT));
            }
            break;

        default:
            alpha = t;
    }

    // Clamp to [0, 1]
    alpha = Math.max(0, Math.min(1, alpha));

    // Enforce monotonicity: α can only increase or stay same
    if (alpha < _lastAlpha) {
        // This would be a violation - log warning but enforce monotonicity
        console.warn(
            `[AlphaDriver] Monotonicity enforcement: raw α=${alpha.toFixed(4)} ` +
            `< lastα=${_lastAlpha.toFixed(4)} at hour=${simHour.toFixed(2)}`
        );
        alpha = _lastAlpha;
    }

    _lastAlpha = alpha;
    _lastSimHour = simHour;

    return alpha;
}

/**
 * Reset alpha state (for re-running simulation from start).
 */
export function resetAlpha() {
    _lastAlpha = 0;
    _lastSimHour = 0;
}

/**
 * Get current alpha without advancing (for inspection).
 * @returns {number}
 */
export function getCurrentAlpha() {
    return _lastAlpha;
}

/**
 * Get current configuration (for inspection).
 * @returns {AlphaConfig}
 */
export function getAlphaConfig() {
    return { ..._config };
}

/**
 * Get last simulation hour that alpha was computed for.
 * @returns {number}
 */
export function getLastSimHour() {
    return _lastSimHour;
}

// ───────────────────────────────────────────────────────────────────────────────
// UTILITY: PREVIEW ALPHA CURVE
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Preview alpha values over a range of hours (for debugging/visualization).
 * Does NOT modify state.
 *
 * @param {number} [startHour=0]
 * @param {number} [endHour=24]
 * @param {number} [steps=24]
 * @returns {Array<{hour: number, alpha: number}>}
 */
export function previewAlphaCurve(startHour = 0, endHour = 24, steps = 24) {
    const { curve, startHour: configStart, endHour: configEnd, plateauUntil } = _config;
    const result = [];

    for (let i = 0; i <= steps; i++) {
        const hour = startHour + (endHour - startHour) * (i / steps);

        // Compute alpha without modifying state (duplicate logic)
        let t;
        if (hour <= configStart) {
            t = 0;
        } else if (hour >= configEnd) {
            t = 1;
        } else {
            t = (hour - configStart) / (configEnd - configStart);
        }

        let alpha;
        switch (curve) {
            case AlphaCurve.LINEAR:
                alpha = t;
                break;
            case AlphaCurve.SMOOTHSTEP:
                alpha = t * t * (3 - 2 * t);
                break;
            case AlphaCurve.PLATEAU_RAMP:
                const plateau = plateauUntil ?? configStart;
                if (hour < plateau) {
                    alpha = 0;
                } else if (hour >= configEnd) {
                    alpha = 1;
                } else {
                    alpha = (hour - plateau) / (configEnd - plateau);
                }
                break;
            default:
                alpha = t;
        }

        result.push({ hour, alpha: Math.max(0, Math.min(1, alpha)) });
    }

    return result;
}
