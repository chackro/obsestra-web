// ═══════════════════════════════════════════════════════════════════════════════
// STUB GEOMETRY PROVIDER
// Test geometry/scenario context for running reynosaOverlay.js without CIEN bundles.
// ═══════════════════════════════════════════════════════════════════════════════

import { DEFAULT_POE_NAMES } from '../engine/geometryProvider.js';

// ───────────────────────────────────────────────────────────────────────────────
// STUB GEOMETRY DATA
// PHARR at (0, 0) as world origin. Roads extend south into Mexico.
// ───────────────────────────────────────────────────────────────────────────────

const STUB_WORLD_BOUNDS = {
    width: 80000,   // 80km (matches COMPUTE_WINDOW.SIZE_M)
    height: 80000,
    originX: -40000,
    originY: -40000,
};

// PHARR POE location (world origin)
const PHARR_COORDS = { x: 0, y: 0 };

// Road segments with IDs (reynosaOverlay expects { id, points })
const STUB_ROAD_SEGMENTS = [
    // Main corridor from south (MTY direction) - enters ROI from south
    {
        id: 'CORRIDOR_MTY',
        points: [
            { x: -5000, y: -30000 },  // Entry point (south of ROI center)
            { x: -3000, y: -20000 },
            { x: -1000, y: -10000 },
            { x: 0, y: -5000 },
            { x: 0, y: 0 },           // PHARR
        ],
    },
    // Western corridor
    {
        id: 'CORRIDOR_WEST',
        points: [
            { x: -35000, y: -15000 }, // Entry point (west)
            { x: -25000, y: -10000 },
            { x: -15000, y: -5000 },
            { x: -5000, y: -2000 },
            { x: 0, y: 0 },           // PHARR
        ],
    },
    // Local Reynosa roads (grid)
    {
        id: 'LOCAL_EW_1',
        points: [
            { x: -10000, y: -5000 },
            { x: -5000, y: -5000 },
            { x: 0, y: -5000 },
            { x: 5000, y: -5000 },
        ],
    },
    {
        id: 'LOCAL_EW_2',
        points: [
            { x: -10000, y: -10000 },
            { x: -5000, y: -10000 },
            { x: 0, y: -10000 },
            { x: 5000, y: -10000 },
        ],
    },
    {
        id: 'LOCAL_NS_1',
        points: [
            { x: -5000, y: -15000 },
            { x: -5000, y: -10000 },
            { x: -5000, y: -5000 },
            { x: -5000, y: 0 },
        ],
    },
];

// Source injection points (corridor entries into ROI)
const STUB_SOURCE_POINTS = [
    { x: -5000, y: -30000 },   // MTY entry
    { x: -35000, y: -15000 },  // West entry
];

// All POE sink points
const STUB_SINK_POINTS = [
    { id: 'PHARR', x: 0, y: 0 },
];

// ───────────────────────────────────────────────────────────────────────────────
// STUB SCENARIO ADAPTER
// Provides hourly inflow and gate capacity for testing
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Create a stub scenario adapter for testing.
 * @param {Object} [options]
 * @param {number} [options.inflowKgPerHour=10000] - Total inflow kg/hr
 * @param {number} [options.capacityKgPerHour=15000] - Gate capacity kg/hr
 * @returns {Object} Scenario adapter
 */
function createStubScenarioAdapter(options = {}) {
    const inflowKgPerHour = options.inflowKgPerHour ?? 10000;
    const capacityKgPerHour = options.capacityKgPerHour ?? 15000;

    return {
        getPharrInflow(hour) {
            return {
                total_kg: inflowKgPerHour,
                hs2_kg: { '85': inflowKgPerHour }, // All electronics for simplicity
            };
        },
        getPharrGateCapacity(hour) {
            return {
                cap_kg_per_hour: capacityKgPerHour,
            };
        },
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// REYNOSA OVERLAY CONTEXT FACTORY
// Creates the context object expected by reynosaOverlay.onAttach()
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Create a renderer context for reynosaOverlay testing.
 * @param {Object} [options]
 * @param {number} [options.inflowKgPerHour=10000] - Total inflow kg/hr
 * @param {number} [options.capacityKgPerHour=15000] - Gate capacity kg/hr
 * @returns {Object} Renderer context for onAttach()
 */
export function createTestRendererContext(options = {}) {
    return {
        geometry: {
            worldBounds: { ...STUB_WORLD_BOUNDS },
            poePoints: {
                PHARR: { ...PHARR_COORDS },
            },
            roadSegments: STUB_ROAD_SEGMENTS.map(seg => ({
                id: seg.id,
                points: seg.points.map(p => ({ ...p })),
            })),
        },
        scenario: createStubScenarioAdapter(options),
    };
}

/**
 * Create a mock camera for testing onFrame().
 * @param {Object} [options]
 * @param {number} [options.zoom=0.01] - Zoom level (px/m)
 * @returns {Object} Mock camera
 */
export function createMockCamera(options = {}) {
    const zoom = options.zoom ?? 0.01; // LOCAL_FIELD threshold
    return {
        zoom,
        centerWorld: { x: 0, y: -10000 }, // South of PHARR (in ROI)
        worldToScreen: (wx, wy) => ({ x: wx * zoom, y: -wy * zoom }),
        metersToPixels: (m) => m * zoom,
    };
}

/**
 * Create a mock time object for testing onFrame().
 * @param {Object} [options]
 * @param {number} [options.hour=8] - Current hour (0-23)
 * @param {number} [options.timeScale=60] - Sim min per real sec
 * @returns {Object} Mock time
 */
export function createMockTime(options = {}) {
    const hour = options.hour ?? 8;
    return {
        currentHour: hour,
        simTimeHours: hour,
        simTimeSeconds: hour * 3600,
        timeScale: options.timeScale ?? 60,
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// LEGACY GEOMETRY PROVIDER (for backward compatibility with type definitions)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Create a legacy stub geometry provider.
 * @deprecated Use createTestRendererContext() for reynosaOverlay tests
 * @param {Object} [options]
 * @returns {import('../engine/geometryProvider.js').GeometryProvider}
 */
export function createStubGeometryProvider(options = {}) {
    const pharrOnly = options.pharrOnly ?? true;

    return {
        getWorldBounds: () => ({ ...STUB_WORLD_BOUNDS }),
        getRoadSegments: () => STUB_ROAD_SEGMENTS.map(seg => ({
            points: seg.points.map(p => ({ ...p })),
        })),
        getParkingLots: () => [],
        getSourcePoints: () => STUB_SOURCE_POINTS.map(p => ({ ...p })),
        getSinkPoints: () => pharrOnly
            ? [{ ...STUB_SINK_POINTS[0] }]
            : STUB_SINK_POINTS.map(s => ({ ...s })),
        POE_NAMES: [...DEFAULT_POE_NAMES],
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ───────────────────────────────────────────────────────────────────────────────

export {
    STUB_WORLD_BOUNDS,
    STUB_ROAD_SEGMENTS,
    STUB_SOURCE_POINTS,
    STUB_SINK_POINTS,
    PHARR_COORDS,
    createStubScenarioAdapter,
};
