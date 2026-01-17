// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO PAIR
// Two-bundle interpolation system for baseline → interserrana transition.
//
// NOT toggles. NOT switching. Continuous interpolation via α(t).
//
// Uses ScenarioPairContract for validation - single source of truth.
// ═══════════════════════════════════════════════════════════════════════════════

import { validateBundle } from '../contracts/ReynosaOverlayBundle.js';
import { assertValidScenarioPair, computeScenarioDelta } from '../contracts/ScenarioPairContract.js';

// ───────────────────────────────────────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────────────────────────────────────

let _baseline = null;
let _interserrana = null;
let _isLoaded = false;
let _verbose = true;  // Set false for headless runs
export function setScenarioPairVerbose(v) { _verbose = v; }

// ───────────────────────────────────────────────────────────────────────────────
// LOADING
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Load scenario pair from CIEN.
 * Both bundles must be complete and compatible per ScenarioPairContract.
 * @param {ReynosaOverlayBundle} baselineBundle
 * @param {ReynosaOverlayBundle} interserranaBundle
 * @throws {Error} if validation fails
 */
export function loadScenarioPair(baselineBundle, interserranaBundle) {
    // Validate individual bundles
    validateBundle(baselineBundle);
    validateBundle(interserranaBundle);

    // Validate pair compatibility using canonical contract
    assertValidScenarioPair(baselineBundle, interserranaBundle);

    // GUARDRAIL: Warn if baseline slot contains observer layer (LAYER_A) after init
    // This is OK during Phase 1 (init), but unexpected during Phase 2 transitions
    const baselineHash = baselineBundle.metadata?.scenario_hash || '';
    if (baselineHash.includes('layer_a') || baselineHash.includes('LAYER_A')) {
        console.warn('[ScenarioPair] GUARDRAIL: Observer layer in baseline slot. Expected only during init phase.');
    }

    _baseline = baselineBundle;
    _interserrana = interserranaBundle;
    _isLoaded = true;

    // Compute and log delta for diagnostics
    const delta = computeScenarioDelta(baselineBundle, interserranaBundle);

    if (_verbose) {
        console.log('[ScenarioPair] Loaded:', {
            baseline: baselineBundle.metadata.scenario_hash,
            interserrana: interserranaBundle.metadata.scenario_hash,
            addedSegments: delta.geometry.addedSegmentCount,
            dailyInflowDelta: `${(delta.inflow.dailyDelta / 1e6).toFixed(2)}M kg`,
        });
        console.log('[ScenarioPair] loadScenarioPairBundles returning');
    }
}

/**
 * Check if scenario pair is loaded.
 */
export function hasScenarioPair() {
    return _isLoaded && _baseline !== null && _interserrana !== null;
}

/**
 * Get baseline bundle (for fallback/inspection).
 */
export function getBaseline() {
    return _baseline;
}

/**
 * Get interserrana bundle (for inspection).
 */
export function getInterserrana() {
    return _interserrana;
}

/**
 * GUARDRAIL: Assert baseline slot contains actual baseline bundle.
 * Call this after Phase 2 transition to verify semantic integrity.
 * @param {ReynosaOverlayBundle} expectedBaseline - The literal baseline bundle for comparison
 * @returns {boolean} true if baseline slot matches, false otherwise (logs warning)
 */
export function assertBaselineIsBaseline(expectedBaseline) {
    if (!_baseline || !expectedBaseline) return false;
    const currentHash = _baseline.metadata?.scenario_hash || '';
    const expectedHash = expectedBaseline.metadata?.scenario_hash || '';
    if (currentHash !== expectedHash) {
        console.warn(`[ScenarioPair] GUARDRAIL VIOLATION: Baseline slot has "${currentHash}", expected "${expectedHash}"`);
        return false;
    }
    return true;
}

// ───────────────────────────────────────────────────────────────────────────────
// INTERPOLATION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Get interpolated inflow for hour h at alpha.
 * inflow(α, h) = baseline[h] + α * (interserrana[h] - baseline[h])
 *
 * @param {number} alpha - Interpolation factor [0,1]
 * @param {number} hour - Hour of day (0-23)
 * @returns {number} Interpolated inflow in kg/hour
 */
export function getInterpolatedInflow(alpha, hour) {
    if (!_isLoaded) return 0;

    const h = Math.floor(hour) % 24;
    const inflowA = _baseline.inflow.hourly_kg[h] || 0;
    const inflowB = _interserrana.inflow.hourly_kg[h] || 0;

    return inflowA + alpha * (inflowB - inflowA);
}

/**
 * Get interpolated capacity for hour h at alpha.
 * capacity(α, h) = baseline[h] + α * (interserrana[h] - baseline[h])
 *
 * @param {number} alpha - Interpolation factor [0,1]
 * @param {number} hour - Hour of day (0-23)
 * @returns {number} Interpolated capacity in kg/hour (0 when closed)
 */
export function getInterpolatedCapacity(alpha, hour) {
    if (!_isLoaded) return 0;

    const h = Math.floor(hour) % 24;
    const capA = _baseline.capacity.hourly_kg[h] || 0;
    const capB = _interserrana.capacity.hourly_kg[h] || 0;

    // Preserve closed hours: if both are 0, result is 0
    return capA + alpha * (capB - capA);
}

// ───────────────────────────────────────────────────────────────────────────────
// GEOMETRY DELTA
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Get geometry delta segments (those in interserrana but not baseline).
 * @returns {Array<{segment_id: string, geometry_coordinates: Array}>}
 */
export function getGeometryDelta() {
    if (!_isLoaded) return [];

    const baselineIds = new Set(_baseline.geometry.segments_in_roi.map(s => s.segment_id));
    return _interserrana.geometry.segments_in_roi.filter(s => !baselineIds.has(s.segment_id));
}

/**
 * Get visible segments at given alpha.
 * - All baseline segments always visible
 * - Delta segments appear at α >= alphaGeomThreshold (binary)
 *
 * @param {number} alpha - Current interpolation factor [0,1]
 * @param {number} [alphaGeomThreshold=0.1] - Threshold for delta segment appearance
 * @returns {Array<{segment_id: string, geometry_coordinates: Array}>}
 */
export function getVisibleSegments(alpha, alphaGeomThreshold = 0.1) {
    if (!_isLoaded) return [];

    // Below threshold: baseline only
    if (alpha < alphaGeomThreshold) {
        return _baseline.geometry.segments_in_roi;
    }

    // At or above threshold: full interserrana set (superset of baseline)
    return _interserrana.geometry.segments_in_roi;
}

/**
 * Check if geometry has changed between two alpha values.
 * Used to detect when K tensor needs re-baking.
 *
 * @param {number} prevAlpha
 * @param {number} currAlpha
 * @param {number} [alphaGeomThreshold=0.1]
 * @returns {boolean}
 */
export function hasGeometryChanged(prevAlpha, currAlpha, alphaGeomThreshold = 0.1) {
    const prevVisible = prevAlpha >= alphaGeomThreshold;
    const currVisible = currAlpha >= alphaGeomThreshold;
    return prevVisible !== currVisible;
}

// ───────────────────────────────────────────────────────────────────────────────
// ACCESSORS FOR BASELINE PROPERTIES
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Get PHARR coordinates (same in both bundles per validation).
 */
export function getPharrCoords() {
    if (!_isLoaded) return null;
    return _baseline.geometry.pharr_coords;
}

/**
 * Get transform (same in both bundles per validation).
 */
export function getTransform() {
    if (!_isLoaded) return null;
    return _baseline.geometry.transform;
}
