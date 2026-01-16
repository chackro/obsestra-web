// ═══════════════════════════════════════════════════════════════════════════════
// MICRO GEOMETRY
// Reynosa-specific friction zones, yards, and operational elements.
// These AUGMENT CIEN geometry - they do not replace or modify CIEN truth.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Micro geometry produces STAMPS, not geometry.
 * Returns operations that modify field tensors.
 *
 * PLACEHOLDER STRUCTURE - zones to be populated later.
 *
 * CONSTRAINTS (enforced by design):
 * - Cannot change CIEN inflow totals
 * - Cannot change PHARR capacity totals (CBP-side)
 * - Cannot create new macro roads
 * - Deterministic given same config
 */

// ───────────────────────────────────────────────────────────────────────────────
// ZONE TYPES
// ───────────────────────────────────────────────────────────────────────────────

export const MicroZoneType = Object.freeze({
    TIER3_SCATTER: 'TIER3_SCATTER',     // High friction (informal lots)
    TRANSFER_YARD: 'TRANSFER_YARD',     // Medium friction (formal transfer)
    INOVUS_T1: 'INOVUS_T1',             // Low friction + buffering (efficient)
    TOLL_BOTTLENECK: 'TOLL_BOTTLENECK', // Point friction
    PARKING_LOT: 'PARKING_LOT',         // Yard for staging
});

// ───────────────────────────────────────────────────────────────────────────────
// DEFAULT FRICTION COEFFICIENTS
// ───────────────────────────────────────────────────────────────────────────────

export const DEFAULT_FRICTION = Object.freeze({
    [MicroZoneType.TIER3_SCATTER]: 0.7,    // 70% velocity reduction
    [MicroZoneType.TRANSFER_YARD]: 0.4,    // 40% velocity reduction
    [MicroZoneType.INOVUS_T1]: 0.15,       // 15% velocity reduction (efficient)
    [MicroZoneType.TOLL_BOTTLENECK]: 0.5,  // 50% velocity reduction
    [MicroZoneType.PARKING_LOT]: 0.4,      // 40% velocity reduction (staging delay)
});

// ───────────────────────────────────────────────────────────────────────────────
// MICRO CONFIG
// ───────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CircleZone
 * @property {number} x       - Center X in world meters
 * @property {number} y       - Center Y in world meters
 * @property {number} radiusM - Radius in meters
 * @property {string} [label] - Optional label for debugging
 */

/**
 * @typedef {Object} FrictionZone
 * @property {string} type    - Zone type from MicroZoneType
 * @property {CircleZone} zone - Zone geometry
 * @property {number} [factor] - Friction factor override (default from DEFAULT_FRICTION)
 */

/**
 * @typedef {Object} ConductanceZone
 * @property {CircleZone} zone - Zone geometry
 * @property {number} factor   - Conductance multiplier (0-1 reduces, >1 increases)
 */

/**
 * @typedef {Object} ParkingLot
 * @property {number} x       - Center X in world meters
 * @property {number} y       - Center Y in world meters
 * @property {number} radiusM - Radius in meters
 * @property {string} [label] - Optional label
 */

/**
 * @typedef {Object} MicroConfig
 * @property {boolean} enabled
 * @property {boolean} inovusEnabled
 * @property {ParkingLot[]} parkingLots
 * @property {FrictionZone[]} frictionZones
 * @property {ConductanceZone[]} conductanceZones
 */

/**
 * Create a micro configuration with defaults.
 * @param {Partial<MicroConfig>} options
 * @returns {MicroConfig}
 */
export function createMicroConfig(options = {}) {
    return {
        enabled: options.enabled ?? true,
        inovusEnabled: options.inovusEnabled ?? false,
        // Placeholder arrays - populate with actual zone definitions
        parkingLots: options.parkingLots ?? [],
        frictionZones: options.frictionZones ?? [],
        conductanceZones: options.conductanceZones ?? [],
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// MICRO STAMPS
// ───────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} MicroStamps
 * @property {ParkingLot[]} parkingLots
 * @property {FrictionZone[]} frictionZones
 * @property {ConductanceZone[]} conductanceMultipliers
 */

/**
 * Create micro stamps from config.
 * @param {MicroConfig} config
 * @returns {MicroStamps}
 */
export function createMicroStamps(config) {
    if (!config.enabled) {
        return {
            parkingLots: [],
            frictionZones: [],
            conductanceMultipliers: [],
        };
    }

    // Process parking lots
    const parkingLots = config.parkingLots.map(lot => ({
        x: lot.x,
        y: lot.y,
        radiusM: lot.radiusM,
        label: lot.label,
    }));

    // Process friction zones with default factors
    const frictionZones = config.frictionZones.map(zone => ({
        type: zone.type,
        zone: zone.zone,
        factor: zone.factor ?? DEFAULT_FRICTION[zone.type] ?? 0.5,
    }));

    // Add Inovus zone if enabled
    if (config.inovusEnabled) {
        // Placeholder: Inovus T1 zone would be defined here
        // frictionZones.push({
        //     type: MicroZoneType.INOVUS_T1,
        //     zone: { x: ???, y: ???, radiusM: ??? },
        //     factor: DEFAULT_FRICTION[MicroZoneType.INOVUS_T1],
        // });
    }

    return {
        parkingLots,
        frictionZones,
        conductanceMultipliers: config.conductanceZones || [],
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// ACCESSORS FOR GEOMETRY PROVIDER
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Get parking lots from micro stamps for use in GeometryProvider.
 * @param {MicroStamps} microStamps
 * @returns {Array<{x: number, y: number, radiusM: number}>}
 */
export function getMicroParkingLots(microStamps) {
    if (!microStamps) return [];
    return microStamps.parkingLots.map(lot => ({
        x: lot.x,
        y: lot.y,
        radiusM: lot.radiusM,
    }));
}

/**
 * Get friction zones from micro stamps for velocity modification.
 * @param {MicroStamps} microStamps
 * @returns {FrictionZone[]}
 */
export function getMicroFrictionZones(microStamps) {
    if (!microStamps) return [];
    return microStamps.frictionZones;
}

/**
 * Get conductance multipliers for K tensor modification.
 * @param {MicroStamps} microStamps
 * @returns {ConductanceZone[]}
 */
export function getMicroConductanceZones(microStamps) {
    if (!microStamps) return [];
    return microStamps.conductanceMultipliers;
}

// ───────────────────────────────────────────────────────────────────────────────
// EMPTY CONFIG (for "pure CIEN" mode)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Create a disabled micro config that produces no stamps.
 * Use this to run in "pure CIEN" mode without micro layer augmentation.
 * @returns {MicroConfig}
 */
export function createEmptyMicroConfig() {
    return createMicroConfig({ enabled: false });
}
