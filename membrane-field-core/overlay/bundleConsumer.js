/**
 * BUNDLE CONSUMER
 * ================
 * Consumes ReynosaOverlayBundle from CIEN and exposes data to the overlay.
 *
 * This is the ONLY interface between the overlay and CIEN data.
 * The overlay NEVER touches CIEN directly.
 *
 * LOCKED: 2025-12-14
 */

import {
    LOCKED_CONSTANTS,
    PHARR_DEFAULTS,
    RENDERER_TRANSFORM,
    HOURLY_DISTRIBUTION,
    validateBundle,
    assertMassConservation,
    assertCapacityCeiling,
} from '../contracts/ReynosaOverlayBundle.js';

import { getMicroParkingLots } from './microGeometry.js';
import { DEFAULT_POE_NAMES } from '../engine/geometryProvider.js';

// =============================================================================
// STATE
// =============================================================================

let currentBundle = null;
let isLoaded = false;
let _logPrefix = '';
let _verbose = true;  // Set false for headless runs

export function setBundleConsumerLogPrefix(prefix) {
    _logPrefix = prefix ? `[${prefix}] ` : '';
}

export function setBundleConsumerVerbose(v) { _verbose = v; }

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Load a bundle from CIEN.
 * @param {ReynosaOverlayBundle} bundle
 * @throws {Error} if validation fails
 */
export function loadBundle(bundle) {
    validateBundle(bundle);
    currentBundle = bundle;
    isLoaded = true;
    if (_verbose) console.log(_logPrefix + '[BundleConsumer] Bundle loaded:', bundle.metadata.scenario_hash);
}

/**
 * Check if a bundle is loaded.
 */
export function hasBundle() {
    return isLoaded && currentBundle !== null;
}

/**
 * Get the current bundle (for segment weight computation).
 * @returns {ReynosaOverlayBundle|null}
 */
export function getBundle() {
    return currentBundle;
}

/**
 * Get hourly inflow for a given hour.
 * @param {number} hour - Hour (0-23)
 * @returns {{ total_kg: number, by_hs2?: Record<string, number> }}
 */
export function getHourlyInflow(hour) {
    if (!currentBundle) return { total_kg: 0 };

    const h = Math.floor(hour) % 24;
    const total = currentBundle.inflow.hourly_kg[h] || 0;
    const byHs2 = currentBundle.inflow.hourly_kg_by_hs2?.[h];

    return {
        total_kg: total,
        by_hs2: byHs2,
    };
}

/**
 * Get hourly capacity for a given hour.
 * @param {number} hour - Hour (0-23)
 * @returns {number} cap_kg_per_hour (0 when closed)
 */
export function getHourlyCapacity(hour) {
    if (!currentBundle) return 0;

    const h = Math.floor(hour) % 24;
    return currentBundle.capacity.hourly_kg[h] || 0;
}

/**
 * Get PHARR coordinates in world meters.
 * @returns {{ x: number, y: number }}
 */
export function getPharrWorldCoords() {
    if (!currentBundle) {
        // Fallback to defaults
        return latLonToWorld(PHARR_DEFAULTS.coords.lat, PHARR_DEFAULTS.coords.lon);
    }

    const { lat, lon } = currentBundle.geometry.pharr_coords;
    return latLonToWorld(lat, lon);
}

/**
 * Get segments in ROI.
 * @returns {Array<{ segment_id: string, points: Array<{ x: number, y: number }> }>}
 */
export function getSegmentsInROI() {
    if (!currentBundle) return [];

    return currentBundle.geometry.segments_in_roi.map(seg => ({
        segment_id: seg.segment_id,
        points: seg.geometry_coordinates.map(([lat, lon]) => latLonToWorld(lat, lon)),
    }));
}

/**
 * Get the transform for coordinate conversion.
 */
export function getTransform() {
    return currentBundle?.geometry?.transform || RENDERER_TRANSFORM;
}

/**
 * Get metadata.
 */
export function getMetadata() {
    return currentBundle?.metadata || null;
}

/**
 * Get flow totals by POE (annual kg).
 * This is the authoritative source for total mass flowing to each POE.
 * @param {string} [poe] - If provided, return kg for that POE. Otherwise return all.
 * @returns {number|Record<string, number>}
 */
export function getFlowKgByPoe(poe) {
    if (!currentBundle?.flow_kg_by_poe) return poe ? 0 : {};
    if (poe) return currentBundle.flow_kg_by_poe[poe] || 0;
    return currentBundle.flow_kg_by_poe;
}

/**
 * Check if flow totals are available in the bundle.
 */
export function hasFlowTotals() {
    return currentBundle?.flow_kg_by_poe != null && Object.keys(currentBundle.flow_kg_by_poe).length > 0;
}

// =============================================================================
// COORDINATE CONVERSION
// =============================================================================

/**
 * Convert lat/lon to world meters (renderer-local, NOT CIEN truth).
 * @param {number} lat
 * @param {number} lon
 * @returns {{ x: number, y: number }}
 */
export function latLonToWorld(lat, lon) {
    const transform = getTransform();
    return {
        x: (lon - transform.origin_lon) * transform.meters_per_deg_lon,
        y: (lat - transform.origin_lat) * transform.meters_per_deg_lat,
    };
}

/**
 * Convert world meters to lat/lon.
 * @param {number} x
 * @param {number} y
 * @returns {{ lat: number, lon: number }}
 */
export function worldToLatLon(x, y) {
    const transform = getTransform();
    return {
        lat: transform.origin_lat + y / transform.meters_per_deg_lat,
        lon: transform.origin_lon + x / transform.meters_per_deg_lon,
    };
}

// =============================================================================
// INVARIANT ASSERTIONS (re-export for overlay use)
// =============================================================================

export { assertMassConservation, assertCapacityCeiling };

// =============================================================================
// CONSTANTS (re-export for overlay use)
// =============================================================================

export { LOCKED_CONSTANTS, PHARR_DEFAULTS, HOURLY_DISTRIBUTION };

// =============================================================================
// SCENARIO ADAPTER
// =============================================================================

/**
 * Create a scenario adapter that the overlay can use in place of direct CIEN access.
 * This is the ONLY interface the overlay sees.
 */
export function createScenarioAdapter() {
    return {
        getPharrInflow(hour) {
            const { total_kg, by_hs2 } = getHourlyInflow(hour);
            return {
                hs2_kg: by_hs2 || { "99": total_kg },  // Fallback to generic HS2
            };
        },

        getPharrGateCapacity(hour) {
            return {
                cap_kg_per_hour: getHourlyCapacity(hour),
            };
        },
    };
}

/**
 * Create a geometry adapter that the overlay can use.
 */
export function createGeometryAdapter() {
    const pharr = getPharrWorldCoords();
    const segments = getSegmentsInROI();

    return {
        poePoints: {
            PHARR: { x: pharr.x, y: pharr.y },
        },

        roadSegments: segments.map(seg => ({
            points: seg.points,
        })),
    };
}

// =============================================================================
// FIELD GEOMETRY PROVIDER
// =============================================================================

/**
 * ROI window size in meters (16km × 16km)
 */
const ROI_SIZE_M = 16000;

/**
 * Compute injection points along southern boundary of ROI.
 * These represent corridor entry points for the field simulation.
 * @returns {Array<{x: number, y: number}>}
 */
function computeInjectionPoints() {
    const pharr = getPharrWorldCoords();
    const roiCenterY = pharr.y + 6000;  // 6km south of PHARR

    // Injection along southern edge of ROI
    const southY = roiCenterY + ROI_SIZE_M / 2 - 500;  // Near south edge

    // Three injection points representing MTY, Victoria, MMRS corridors
    return [
        { x: pharr.x - 3000, y: southY },  // MTY corridor (west)
        { x: pharr.x, y: southY },          // Victoria corridor (center)
        { x: pharr.x + 3000, y: southY },   // MMRS corridor (east)
    ];
}

/**
 * Compute sink points from bundle.
 * For overlay mode, this is PHARR only.
 * For full-field mode, this would include all POEs.
 * @returns {Array<{id: string, x: number, y: number}>}
 */
function computeSinkPoints() {
    const pharr = getPharrWorldCoords();

    // Overlay mode: PHARR only
    return [
        { id: 'PHARR', x: pharr.x, y: pharr.y },
    ];
}

/**
 * Create a GeometryProvider from CIEN bundle + optional micro layer.
 *
 * This is the SINGLE place where:
 * - CIEN lat/lon → world meters transform occurs
 * - Micro layer parking lots are injected
 * - ROI bounds are computed
 *
 * @param {import('./microGeometry.js').MicroStamps} [microStamps] - Optional micro layer stamps
 * @returns {import('../engine/geometryProvider.js').GeometryProvider}
 */
export function createFieldGeometryProvider(microStamps = null) {
    const pharr = getPharrWorldCoords();

    // ROI centered 6km south of PHARR (Reynosa center)
    const roiCenterX = pharr.x;
    const roiCenterY = pharr.y + 6000;

    return {
        getWorldBounds: () => ({
            width: ROI_SIZE_M,
            height: ROI_SIZE_M,
            originX: roiCenterX - ROI_SIZE_M / 2,
            originY: roiCenterY - ROI_SIZE_M / 2,
        }),

        getRoadSegments: () => {
            const segments = getSegmentsInROI();
            return segments.map(seg => ({
                points: seg.points,
            }));
        },

        // Parking lots come from micro layer (yards are operational detail, not CIEN macro)
        getParkingLots: () => microStamps ? getMicroParkingLots(microStamps) : [],

        getSourcePoints: () => computeInjectionPoints(),

        getSinkPoints: () => computeSinkPoints(),

        POE_NAMES: [...DEFAULT_POE_NAMES],
    };
}

// =============================================================================
// SCENARIO PAIR LOADING
// =============================================================================

import { loadScenarioPair, getInterserrana, hasScenarioPair } from './scenarioPair.js';

/**
 * Load a scenario pair (baseline + interserrana) for α-driven interpolation.
 * This replaces single-bundle loading for interpolated mode.
 *
 * Both bundles must pass validation and be compatible (same PHARR coords,
 * same transforms, append-only geometry delta).
 *
 * @param {ReynosaOverlayBundle} baselineBundle
 * @param {ReynosaOverlayBundle} interserranaBundle
 * @throws {Error} if validation or compatibility check fails
 */
export function loadScenarioPairBundles(baselineBundle, interserranaBundle) {
    loadScenarioPair(baselineBundle, interserranaBundle);
    // Also set current bundle to baseline for getMetadata(), getHourlyInflow(), etc.
    loadBundle(baselineBundle);
    if (_verbose) console.log(_logPrefix + '[BundleConsumer] Scenario pair loaded');
}

/**
 * Create a scenario adapter for the interserrana bundle.
 * Must be called AFTER loadScenarioPairBundles().
 * Returns null if scenario pair not loaded.
 */
export function createInterserranaScenarioAdapter() {
    if (!hasScenarioPair()) return null;
    const bundle = getInterserrana();
    if (!bundle) return null;

    return {
        getPharrInflow(hour) {
            const h = Math.floor(hour) % 24;
            const total_kg = bundle.inflow?.hourly_kg?.[h] ?? 0;
            const by_hs2 = bundle.inflow?.hourly_by_hs2?.[h] ?? null;
            return {
                hs2_kg: by_hs2 || { "99": total_kg },
            };
        },

        getPharrGateCapacity(hour) {
            const h = Math.floor(hour) % 24;
            return {
                cap_kg_per_hour: bundle.capacity?.hourly_kg?.[h] ?? 0,
            };
        },
    };
}
