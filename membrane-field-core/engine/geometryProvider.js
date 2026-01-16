// ═══════════════════════════════════════════════════════════════════════════════
// GEOMETRY PROVIDER INTERFACE
// Contract for geometry injection into field physics.
// All coordinates must be in world meters (not lat/lon).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} WorldBounds
 * @property {number} width    - Width in meters
 * @property {number} height   - Height in meters
 * @property {number} originX  - Left edge X coordinate in meters
 * @property {number} originY  - Top edge Y coordinate in meters
 */

/**
 * @typedef {Object} Point
 * @property {number} x - X coordinate in world meters
 * @property {number} y - Y coordinate in world meters
 */

/**
 * @typedef {Object} RoadSegment
 * @property {Point[]} points - Polyline vertices in world coords (meters)
 */

/**
 * @typedef {Object} ParkingLot
 * @property {number} x       - Center X in world meters
 * @property {number} y       - Center Y in world meters
 * @property {number} radiusM - Radius in meters
 */

/**
 * @typedef {Object} SourcePoint
 * @property {number} x - X coordinate in world meters
 * @property {number} y - Y coordinate in world meters
 */

/**
 * @typedef {Object} SinkPoint
 * @property {string} id - POE identifier (e.g. 'PHARR', 'NLD')
 * @property {number} x  - X coordinate in world meters
 * @property {number} y  - Y coordinate in world meters
 */

/**
 * @typedef {Object} GeometryProvider
 * @property {function(): WorldBounds} getWorldBounds
 * @property {function(): RoadSegment[]} getRoadSegments
 * @property {function(): ParkingLot[]} getParkingLots
 * @property {function(): SourcePoint[]} getSourcePoints
 * @property {function(): SinkPoint[]} getSinkPoints
 * @property {string[]} POE_NAMES
 */

// ───────────────────────────────────────────────────────────────────────────────
// DEFAULT POE LIST (all 8 POEs for multi-POE capability)
// ───────────────────────────────────────────────────────────────────────────────

export const DEFAULT_POE_NAMES = Object.freeze([
    'NLD',
    'PHARR',
    'PHARR_WEST',
    'DONNA',
    'ANZALDUAS',
    'PROGRESO',
    'LOSINDIOS',
    'LOSTOMATES',
]);

// ───────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Validate that a geometry provider implements the required interface.
 * @param {GeometryProvider} provider
 * @throws {Error} if validation fails
 */
export function validateGeometryProvider(provider) {
    if (!provider) {
        throw new Error('[GeometryProvider] Provider is null or undefined');
    }

    // Required functions
    const requiredFunctions = [
        'getWorldBounds',
        'getRoadSegments',
        'getParkingLots',
        'getSourcePoints',
        'getSinkPoints',
    ];

    for (const fn of requiredFunctions) {
        if (typeof provider[fn] !== 'function') {
            throw new Error(`[GeometryProvider] Missing required function: ${fn}`);
        }
    }

    // POE_NAMES must be an array
    if (!Array.isArray(provider.POE_NAMES)) {
        throw new Error('[GeometryProvider] POE_NAMES must be an array');
    }

    // Validate world bounds structure
    const bounds = provider.getWorldBounds();
    if (!bounds || typeof bounds.width !== 'number' || typeof bounds.height !== 'number' ||
        typeof bounds.originX !== 'number' || typeof bounds.originY !== 'number') {
        throw new Error('[GeometryProvider] getWorldBounds() must return {width, height, originX, originY}');
    }

    // Validate road segments structure
    const segments = provider.getRoadSegments();
    if (!Array.isArray(segments)) {
        throw new Error('[GeometryProvider] getRoadSegments() must return an array');
    }
    for (const seg of segments) {
        if (!Array.isArray(seg.points)) {
            throw new Error('[GeometryProvider] Each road segment must have a points array');
        }
    }

    // Validate parking lots structure
    const lots = provider.getParkingLots();
    if (!Array.isArray(lots)) {
        throw new Error('[GeometryProvider] getParkingLots() must return an array');
    }

    // Validate source points structure
    const sources = provider.getSourcePoints();
    if (!Array.isArray(sources)) {
        throw new Error('[GeometryProvider] getSourcePoints() must return an array');
    }

    // Validate sink points structure
    const sinks = provider.getSinkPoints();
    if (!Array.isArray(sinks)) {
        throw new Error('[GeometryProvider] getSinkPoints() must return an array');
    }
    for (const sink of sinks) {
        if (typeof sink.id !== 'string' || typeof sink.x !== 'number' || typeof sink.y !== 'number') {
            throw new Error('[GeometryProvider] Each sink point must have {id, x, y}');
        }
    }

    return true;
}

// ───────────────────────────────────────────────────────────────────────────────
// FACTORY
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Create a geometry provider from raw data objects.
 * @param {Object} config
 * @param {WorldBounds} config.worldBounds
 * @param {RoadSegment[]} config.roadSegments
 * @param {ParkingLot[]} config.parkingLots
 * @param {SourcePoint[]} config.sourcePoints
 * @param {SinkPoint[]} config.sinkPoints
 * @param {string[]} [config.poeNames]
 * @returns {GeometryProvider}
 */
export function createGeometryProvider(config) {
    const provider = {
        getWorldBounds: () => config.worldBounds,
        getRoadSegments: () => config.roadSegments || [],
        getParkingLots: () => config.parkingLots || [],
        getSourcePoints: () => config.sourcePoints || [],
        getSinkPoints: () => config.sinkPoints || [],
        POE_NAMES: config.poeNames || [...DEFAULT_POE_NAMES],
    };

    validateGeometryProvider(provider);
    return provider;
}
