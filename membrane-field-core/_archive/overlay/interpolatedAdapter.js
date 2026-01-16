// ═══════════════════════════════════════════════════════════════════════════════
// INTERPOLATED ADAPTER
// Wraps scenarioPair + alphaDriver to provide scenario interfaces
// that reynosaOverlay expects.
//
// This is the bridge between α-driven interpolation and the existing APIs.
// ═══════════════════════════════════════════════════════════════════════════════

import {
    getInterpolatedInflow,
    getInterpolatedCapacity,
    getVisibleSegments,
    getPharrCoords,
    getTransform,
    getBaseline,
    hasScenarioPair,
} from './scenarioPair.js';

import { getCurrentAlpha } from './alphaDriver.js';
import { getMicroParkingLots } from './microGeometry.js';
import { DEFAULT_POE_NAMES } from '../engine/geometryProvider.js';
import { RENDERER_TRANSFORM } from '../contracts/ReynosaOverlayBundle.js';

// ───────────────────────────────────────────────────────────────────────────────
// COORDINATE CONVERSION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Convert lat/lon to world meters using scenario pair transform.
 * @param {number} lat
 * @param {number} lon
 * @returns {{ x: number, y: number }}
 */
function latLonToWorld(lat, lon) {
    const transform = getTransform() || RENDERER_TRANSFORM;
    return {
        x: (lon - transform.origin_lon) * transform.meters_per_deg_lon,
        y: (lat - transform.origin_lat) * transform.meters_per_deg_lat,
    };
}

/**
 * Get PHARR world coordinates from scenario pair.
 * @returns {{ x: number, y: number }}
 */
function getPharrWorldCoords() {
    const coords = getPharrCoords();
    if (!coords) {
        // Fallback to PHARR defaults
        return { x: 0, y: 0 };
    }
    return latLonToWorld(coords.lat, coords.lon);
}

// ───────────────────────────────────────────────────────────────────────────────
// ROI CONFIGURATION
// ───────────────────────────────────────────────────────────────────────────────

const ROI_SIZE_M = 16000;  // 16km × 16km
const ROI_CENTER_OFFSET_Y = 6000;  // 6km south of PHARR

// ───────────────────────────────────────────────────────────────────────────────
// INTERPOLATED SCENARIO ADAPTER
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Create interpolated scenario adapter.
 * This replaces the single-bundle createScenarioAdapter() for α-driven mode.
 *
 * The adapter reads current α from alphaDriver and returns interpolated values.
 *
 * @returns {Object} Scenario adapter with getPharrInflow and getPharrGateCapacity
 */
export function createInterpolatedScenarioAdapter() {
    return {
        /**
         * Get PHARR inflow for given hour, interpolated by current α.
         * @param {number} hour
         * @returns {{ hs2_kg: Record<string, number> }}
         */
        getPharrInflow(hour) {
            const alpha = getCurrentAlpha();
            const totalKg = getInterpolatedInflow(alpha, hour);

            // Return as aggregate (no per-HS2 interpolation)
            return {
                hs2_kg: { "99": totalKg },
            };
        },

        /**
         * Get PHARR gate capacity for given hour, interpolated by current α.
         * @param {number} hour
         * @returns {{ cap_kg_per_hour: number }}
         */
        getPharrGateCapacity(hour) {
            const alpha = getCurrentAlpha();
            return {
                cap_kg_per_hour: getInterpolatedCapacity(alpha, hour),
            };
        },
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// INTERPOLATED GEOMETRY PROVIDER
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Compute injection points along southern boundary of ROI.
 * @returns {Array<{x: number, y: number}>}
 */
function computeInjectionPoints() {
    const pharr = getPharrWorldCoords();
    const roiCenterY = pharr.y + ROI_CENTER_OFFSET_Y;

    // Injection along southern edge of ROI
    const southY = roiCenterY + ROI_SIZE_M / 2 - 500;

    // Three injection points representing corridors
    return [
        { x: pharr.x - 3000, y: southY },  // MTY corridor (west)
        { x: pharr.x, y: southY },          // Victoria corridor (center)
        { x: pharr.x + 3000, y: southY },   // MMRS corridor (east)
    ];
}

/**
 * Compute sink points.
 * For overlay mode, this is PHARR only.
 * @returns {Array<{id: string, x: number, y: number}>}
 */
function computeSinkPoints() {
    const pharr = getPharrWorldCoords();
    return [
        { id: 'PHARR', x: pharr.x, y: pharr.y },
    ];
}

/**
 * Create interpolated geometry provider for field physics.
 * Handles geometry delta (Interserrana segment appearing at α threshold).
 *
 * This provider's getRoadSegments() returns different segments based on current α.
 *
 * @param {Object} [microStamps] - Optional micro layer stamps for parking lots
 * @param {number} [alphaGeomThreshold=0.1] - α threshold for geometry delta
 * @returns {import('../engine/geometryProvider.js').GeometryProvider}
 */
export function createInterpolatedGeometryProvider(microStamps = null, alphaGeomThreshold = 0.1) {
    const pharr = getPharrWorldCoords();
    const roiCenterX = pharr.x;
    const roiCenterY = pharr.y + ROI_CENTER_OFFSET_Y;

    return {
        getWorldBounds: () => ({
            width: ROI_SIZE_M,
            height: ROI_SIZE_M,
            originX: roiCenterX - ROI_SIZE_M / 2,
            originY: roiCenterY - ROI_SIZE_M / 2,
        }),

        getRoadSegments: () => {
            const alpha = getCurrentAlpha();
            const segments = getVisibleSegments(alpha, alphaGeomThreshold);

            return segments.map(seg => ({
                points: seg.geometry_coordinates.map(([lat, lon]) => latLonToWorld(lat, lon)),
            }));
        },

        // Parking lots from micro layer (operational detail, not CIEN)
        getParkingLots: () => microStamps ? getMicroParkingLots(microStamps) : [],

        getSourcePoints: () => computeInjectionPoints(),

        getSinkPoints: () => computeSinkPoints(),

        POE_NAMES: [...DEFAULT_POE_NAMES],
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// GEOMETRY HASH FOR RE-BAKE DETECTION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Compute a hash of segment IDs for detecting geometry changes.
 * Used to trigger K tensor re-bake when Interserrana segment appears.
 *
 * @param {Array<{segment_id: string}>} segments
 * @returns {string}
 */
export function computeGeometryHash(segments) {
    if (!segments || segments.length === 0) return 'empty';

    const ids = segments
        .map(s => s.segment_id)
        .sort()
        .join('|');

    return ids;
}

/**
 * Get current geometry hash based on alpha.
 * @param {number} [alphaGeomThreshold=0.1]
 * @returns {string}
 */
export function getCurrentGeometryHash(alphaGeomThreshold = 0.1) {
    const alpha = getCurrentAlpha();
    const segments = getVisibleSegments(alpha, alphaGeomThreshold);
    return computeGeometryHash(segments);
}

// ───────────────────────────────────────────────────────────────────────────────
// CONTEXT CREATION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Create a renderer context for the overlay using interpolated adapters.
 * This is equivalent to createRendererContext() but uses α-driven interpolation.
 *
 * @param {number} [alphaGeomThreshold=0.1]
 * @returns {{ geometry: Object, scenario: Object }}
 */
export function createInterpolatedRendererContext(alphaGeomThreshold = 0.1) {
    if (!hasScenarioPair()) {
        throw new Error('[InterpolatedAdapter] No scenario pair loaded');
    }

    const pharr = getPharrWorldCoords();
    const alpha = getCurrentAlpha();
    const segments = getVisibleSegments(alpha, alphaGeomThreshold);

    return {
        geometry: {
            poePoints: {
                PHARR: { x: pharr.x, y: pharr.y },
            },
            roadSegments: segments.map(seg => ({
                id: seg.segment_id,
                points: seg.geometry_coordinates.map(([lat, lon]) => latLonToWorld(lat, lon)),
            })),
            worldBounds: {
                originX: pharr.x - ROI_SIZE_M / 2,
                originY: pharr.y + ROI_CENTER_OFFSET_Y - ROI_SIZE_M / 2,
                width: ROI_SIZE_M,
                height: ROI_SIZE_M,
            },
        },
        scenario: createInterpolatedScenarioAdapter(),
    };
}
