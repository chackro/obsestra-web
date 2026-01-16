// ═══════════════════════════════════════════════════════════════════════════════
// CIEN RENDERER INTERFACES
// Type definitions for what the Reynosa East overlay consumes from the renderer.
// These are contracts - the renderer must provide these; the overlay only reads.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} WorldBounds
 * @property {number} originX - Left edge in meters
 * @property {number} originY - Top edge in meters
 * @property {number} width   - Width in meters
 * @property {number} height  - Height in meters
 */

/**
 * @typedef {Object} Point
 * @property {number} x - X coordinate in world meters
 * @property {number} y - Y coordinate in world meters
 */

/**
 * @typedef {Object} RoadSegment
 * @property {string} id           - Unique segment identifier
 * @property {Point[]} points      - Polyline vertices in world coords
 * @property {boolean} [secondary] - True for local/secondary roads
 */

/**
 * @typedef {Object} CIENGeometry
 * @property {WorldBounds} worldBounds
 * @property {RoadSegment[]} roadSegments
 * @property {Object.<string, Point>} poePoints - e.g. { PHARR: {x, y} }
 */

/**
 * @typedef {Object} ScreenPoint
 * @property {number} x - X in screen pixels
 * @property {number} y - Y in screen pixels
 */

/**
 * @typedef {Object} CIENCamera
 * @property {number} zoom                    - Zoom scalar
 * @property {Point} centerWorld              - Camera center in world coords
 * @property {Object} viewportWorld           - Visible bounds
 * @property {number} viewportWorld.minX
 * @property {number} viewportWorld.minY
 * @property {number} viewportWorld.maxX
 * @property {number} viewportWorld.maxY
 *
 * REQUIRED FOR RENDERING:
 * @property {function(number, number): ScreenPoint} worldToScreen
 *           - Converts world coords (meters) to screen coords (pixels)
 * @property {function(number): number} metersToPixels
 *           - Converts a distance in meters to pixels at current zoom
 */

/**
 * @typedef {Object} CIENTime
 * @property {number} simTimeSeconds - Simulation time in seconds
 * @property {number} currentHour    - floor(simTime / 3600) % 24
 * @property {string} scenarioId     - Active scenario identifier
 */

/**
 * @typedef {Object} HourlyInflow
 * @property {Object.<string, number>} hs2_kg - e.g. { "07": 30000, "85": 120000 }
 */

/**
 * @typedef {Object} HourlyCapacity
 * @property {number} cap_kg_per_hour
 */

/**
 * @typedef {Object} CIENScenarioData
 * @property {function(number): HourlyInflow} getPharrInflow
 * @property {function(number): HourlyCapacity} getPharrGateCapacity
 */

// ───────────────────────────────────────────────────────────────────────────────
// OVERLAY INTERFACE
// ───────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RendererContext
 * @property {CIENGeometry} geometry
 * @property {CIENScenarioData} scenario
 */

/**
 * Interface that overlays must implement.
 * The renderer manages lifecycle; overlays just respond to hooks.
 *
 * @typedef {Object} CIENOverlay
 * @property {string} id
 * @property {function(RendererContext): void} onAttach
 * @property {function(): void} onDetach
 * @property {function(CIENCamera, CIENTime): void} onFrame
 * @property {function(CanvasRenderingContext2D, CIENCamera): void} draw
 *           - Draw receives camera for worldToScreen transforms
 */

// ───────────────────────────────────────────────────────────────────────────────
// ACTIVATION CONSTANTS
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Reynosa activation parameters.
 * The overlay activates when camera is zoomed in AND near Reynosa.
 */
export const REYNOSA_ACTIVATION = {
    // Center point for activation check (south of PHARR)
    CENTER_OFFSET_Y: -15000,  // meters south of PHARR (shifted to cover injection points)

    // Zoom thresholds (pixels per meter)
    // At 0.010 px/m, the 16km ROI is ~160px wide
    Z_WARM: 0.003,  // Start warming (simulate but don't draw)
    Z_ON: 0.008,    // Full activation (simulate + draw)

    // Proximity radius for activation
    RADIUS_M: 50000,  // 50km from Reynosa center (covers injection points far south)
};

// ───────────────────────────────────────────────────────────────────────────────
// OVERLAY STATES
// ───────────────────────────────────────────────────────────────────────────────

export const OverlayState = {
    OFF: 'OFF',     // Not simulated, not drawn
    WARM: 'WARM',   // Simulated at low rate, not drawn (prevents pop-in)
    ON: 'ON',       // Simulated + rendered
};

// ───────────────────────────────────────────────────────────────────────────────
// COMPUTE WINDOW DEFAULTS
// ───────────────────────────────────────────────────────────────────────────────

export const COMPUTE_WINDOW = {
    SIZE_M: 80000,      // 80km × 80km ROI (expanded to cover injection points)
    RESOLUTION: 4800,   // 4800 × 4800 grid (~17m/cell) - fine grid for lot scatter
};

// ───────────────────────────────────────────────────────────────────────────────
// HS2 CLASS MAPPING
// Maps HS2 codes to behavior classes for differentiated simulation.
// ───────────────────────────────────────────────────────────────────────────────

export const HS2_CLASS = {
    // Fast (time-sensitive, perishables)
    "07": "fast",   // Vegetables
    "08": "fast",   // Fruits
    "02": "fast",   // Meat
    "03": "fast",   // Fish
    "04": "fast",   // Dairy

    // Standard (most freight)
    "85": "std",    // Electronics
    "84": "std",    // Machinery
    "87": "std",    // Vehicles
    "94": "std",    // Furniture
    "39": "std",    // Plastics
    "90": "std",    // Instruments

    // Bulk (heavy, low VOT)
    "72": "bulk",   // Iron/steel
    "27": "bulk",   // Fuels
    "25": "bulk",   // Salt, stone
    "73": "bulk",   // Iron articles
    "76": "bulk",   // Aluminum
};

// Default class for unmapped HS2 codes
export const DEFAULT_HS2_CLASS = "std";

/**
 * Get behavior class for an HS2 code
 * @param {string} hs2 - Two-digit HS code
 * @returns {string} - "fast", "std", or "bulk"
 */
export function getHs2Class(hs2) {
    return HS2_CLASS[hs2] || DEFAULT_HS2_CLASS;
}

// ───────────────────────────────────────────────────────────────────────────────
// FRICTION ZONE TYPES
// ───────────────────────────────────────────────────────────────────────────────

export const FrictionZoneType = {
    TIER3_SCATTER: 'TIER3_SCATTER',   // High friction (informal lots)
    TRANSFER_YARD: 'TRANSFER_YARD',   // Medium friction
    INOVUS_T1: 'INOVUS_T1',           // Low friction + buffering
    TOLL_BOTTLENECK: 'TOLL_BOTTLENECK', // Point friction
};

export const FRICTION_COEFFICIENTS = {
    TIER3_SCATTER: 0.7,    // 70% velocity reduction
    TRANSFER_YARD: 0.4,    // 40% velocity reduction
    INOVUS_T1: 0.15,       // 15% velocity reduction (efficient)
    TOLL_BOTTLENECK: 0.5,  // 50% velocity reduction
};

// ───────────────────────────────────────────────────────────────────────────────
// SCENARIO TOGGLES (local to Reynosa East)
// These don't change CIEN's POE choice - they change local throughput.
// ───────────────────────────────────────────────────────────────────────────────

export const LocalScenarioDefaults = {
    inovusEnabled: false,
    yardFormalization: 0.0,    // 0-1: how much chaos is reduced
    tollLoopMitigation: false,
    newConnectorRoad: false,
};
