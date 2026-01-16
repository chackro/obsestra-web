// ═══════════════════════════════════════════════════════════════════════════════
// CLASS SYSTEM
// Defines mass classes, regions, sinks, and conversion rules for FIELD.
//
// CIEN decides WHERE mass goes. Classes determine WHAT mass can do when it arrives.
// Classes are eligibility states, not cargo types.
//
// This file is DATA ONLY. No physics computations.
// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────────
// SCHEMA: ClassDef
// ───────────────────────────────────────────────────────────────────────────────

/**
 * A mass class represents an eligibility state.
 * Same physical cargo can transition between classes via conversion.
 *
 * @typedef {Object} ClassDef
 * @property {string} id - Unique identifier (e.g., "restricted", "cleared")
 * @property {string} description - Human-readable explanation
 * @property {number} conductance_scale - Multiplier on K(x), default 1.0
 * @property {Object.<string, boolean>} sink_eligibility - sink_id → can drain?
 * @property {Object.<string, RegionAccess>} region_access - region_id → access rules
 */

/**
 * @typedef {Object} RegionAccess
 * @property {boolean} allowed - Can this class enter the region?
 * @property {number} conductance_multiplier - K multiplier in this region (default 1.0)
 */

/**
 * Create a ClassDef with defaults.
 * @param {Partial<ClassDef> & {id: string}} config
 * @returns {ClassDef}
 */
export function createClassDef(config) {
    return {
        id: config.id,
        description: config.description || '',
        conductance_scale: config.conductance_scale ?? 1.0,
        sink_eligibility: config.sink_eligibility || {},
        region_access: config.region_access || {},
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// SCHEMA: RegionDef
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Region types determine behavior.
 */
export const RegionType = Object.freeze({
    CORRIDOR: 'CORRIDOR',   // Flow-through, no storage, no conversion
    YARD: 'YARD',           // Storage allowed, conversion allowed
    BARRIER: 'BARRIER',     // No flow (K=0)
});

/**
 * A region is a spatial zone with specific properties.
 * Regions own conversion rules - conversion only happens in designated regions.
 *
 * @typedef {Object} RegionDef
 * @property {string} id - Unique identifier (e.g., "corridor", "yard_main")
 * @property {string} type - RegionType value
 * @property {string} description - Human-readable explanation
 * @property {number} base_conductance - K multiplier for this region (1.0 = full, 0.0 = barrier)
 * @property {boolean} is_storage - Can mass accumulate here without spreading?
 * @property {number|null} capacity_kg - Max density (null = unlimited)
 * @property {string[]} conversion_rule_ids - Which conversions apply here
 */

/**
 * Create a RegionDef with defaults.
 * @param {Partial<RegionDef> & {id: string, type: string}} config
 * @returns {RegionDef}
 */
export function createRegionDef(config) {
    return {
        id: config.id,
        type: config.type,
        description: config.description || '',
        base_conductance: config.base_conductance ?? 1.0,
        is_storage: config.is_storage ?? false,
        capacity_kg: config.capacity_kg ?? null,
        conversion_rule_ids: config.conversion_rule_ids || [],
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// SCHEMA: SinkDef
// ───────────────────────────────────────────────────────────────────────────────

/**
 * A sink removes mass from the field (e.g., bridge crossing).
 * Sinks have class eligibility - only eligible classes can drain.
 *
 * @typedef {Object} SinkDef
 * @property {string} id - Unique identifier (e.g., "pharr_main")
 * @property {string} description - Human-readable explanation
 * @property {string[]} eligible_classes - Class IDs that can drain here
 * @property {boolean} uses_bundle_capacity - If true, capacity comes from CIEN bundle
 * @property {number|null} fixed_capacity_kg_per_hour - If not using bundle, fixed cap
 */

/**
 * Create a SinkDef with defaults.
 * @param {Partial<SinkDef> & {id: string}} config
 * @returns {SinkDef}
 */
export function createSinkDef(config) {
    return {
        id: config.id,
        description: config.description || '',
        eligible_classes: config.eligible_classes || [],
        uses_bundle_capacity: config.uses_bundle_capacity ?? true,
        fixed_capacity_kg_per_hour: config.fixed_capacity_kg_per_hour ?? null,
    };
}

// ───────────────────────────────────────────────────────────────────────────────
// SCHEMA: ConversionRule
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Conversion modes.
 */
export const ConversionMode = Object.freeze({
    TIME: 'TIME',   // Convert based on dwell time: T = ρ_from / dwell_time
    RATE: 'RATE',   // Convert at fixed rate: T = min(ρ_from/dt, max_rate)
});

/**
 * A conversion rule transfers mass from one class to another.
 * Conversion only occurs in the designated region.
 *
 * @typedef {Object} ConversionRule
 * @property {string} id - Unique identifier (e.g., "yard_transfer")
 * @property {string} description - Human-readable explanation
 * @property {string} from_class - Source class ID
 * @property {string} to_class - Destination class ID
 * @property {string} region_id - Only active in this region
 * @property {string} mode - ConversionMode value
 * @property {number|null} dwell_time_s - Seconds (if mode=TIME)
 * @property {number|null} max_rate_kg_per_s - kg/s (if mode=RATE)
 * @property {boolean} enabled - Can be toggled for scenarios
 */

/**
 * Create a ConversionRule with defaults.
 * @param {Partial<ConversionRule> & {id: string, from_class: string, to_class: string, region_id: string}} config
 * @returns {ConversionRule}
 */
export function createConversionRule(config) {
    return {
        id: config.id,
        description: config.description || '',
        from_class: config.from_class,
        to_class: config.to_class,
        region_id: config.region_id,
        mode: config.mode || ConversionMode.TIME,
        dwell_time_s: config.dwell_time_s ?? null,
        max_rate_kg_per_s: config.max_rate_kg_per_s ?? null,
        enabled: config.enabled ?? true,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// V1 CONFIGURATION: Two-Class Minimal Model
// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────────
// V1 CLASSES
// ───────────────────────────────────────────────────────────────────────────────

/**
 * RESTRICTED: Mass that cannot yet cross at Pharr.
 * - Can flow on corridors
 * - Can enter yards
 * - CANNOT exit at pharr_main
 */
export const CLASS_RESTRICTED = createClassDef({
    id: 'restricted',
    description: 'Mass not yet cleared to cross. Must convert before exiting.',
    conductance_scale: 1.0,
    sink_eligibility: {
        pharr_main: false,
    },
    region_access: {
        corridor: { allowed: true, conductance_multiplier: 1.0 },
        yard_main: { allowed: true, conductance_multiplier: 1.0 },
        lot: { allowed: true, conductance_multiplier: 1.0 },
    },
});

/**
 * CLEARED: Mass that can cross at Pharr.
 * - Can flow on corridors
 * - Can enter yards
 * - CAN exit at pharr_main
 */
export const CLASS_CLEARED = createClassDef({
    id: 'cleared',
    description: 'Mass cleared to cross. Can exit at Pharr.',
    conductance_scale: 1.0,
    sink_eligibility: {
        pharr_main: true,
    },
    region_access: {
        corridor: { allowed: true, conductance_multiplier: 1.0 },
        yard_main: { allowed: true, conductance_multiplier: 1.0 },
        lot: { allowed: true, conductance_multiplier: 1.0 },
    },
});

/**
 * V1 class registry.
 */
export const V1_CLASSES = Object.freeze({
    restricted: CLASS_RESTRICTED,
    cleared: CLASS_CLEARED,
});

/**
 * V1 class IDs for iteration.
 */
export const V1_CLASS_IDS = Object.freeze(['restricted', 'cleared']);

// ───────────────────────────────────────────────────────────────────────────────
// V1 REGIONS
// ───────────────────────────────────────────────────────────────────────────────

/**
 * CORRIDOR: Default region. Flow-through, no conversion.
 */
export const REGION_CORRIDOR = createRegionDef({
    id: 'corridor',
    type: RegionType.CORRIDOR,
    description: 'Road network. Flow-through, no storage, no conversion.',
    base_conductance: 1.0,
    is_storage: false,
    capacity_kg: null,
    conversion_rule_ids: [],
});

/**
 * YARD_MAIN: Inovus Membrane Yard. Storage and conversion.
 * @deprecated Use REGION_LOT for polygon-based lots
 */
export const REGION_YARD_MAIN = createRegionDef({
    id: 'yard_main',
    type: RegionType.YARD,
    description: 'Membrane yard. Storage allowed, conversion enabled.',
    base_conductance: 0.3,  // Slower flow in yard (staging, maneuvering)
    is_storage: true,
    capacity_kg: null,      // Unlimited for v1
    conversion_rule_ids: ['yard_transfer'],
});

/**
 * LOT: Generic conversion zone from KMZ polygon data.
 * All 85 lots share this single definition.
 * Conversion: restricted → cleared (same as yard_main)
 */
export const REGION_LOT = createRegionDef({
    id: 'lot',
    type: RegionType.YARD,
    description: 'Transfer/storage lot from KMZ. Conversion enabled.',
    base_conductance: 0.4,  // Slower than road (1.0), faster than old yard (0.3)
    is_storage: true,
    capacity_kg: null,      // Unlimited for v1
    conversion_rule_ids: ['lot_transfer'],
});

/**
 * V1 region registry.
 */
export const V1_REGIONS = Object.freeze({
    corridor: REGION_CORRIDOR,
    yard_main: REGION_YARD_MAIN,
    lot: REGION_LOT,
});

/**
 * V1 region IDs for iteration.
 */
export const V1_REGION_IDS = Object.freeze(['corridor', 'yard_main', 'lot']);

/**
 * Default region ID (assigned to cells with no explicit region).
 */
export const DEFAULT_REGION_ID = 'corridor';

// ───────────────────────────────────────────────────────────────────────────────
// V1 SINKS
// ───────────────────────────────────────────────────────────────────────────────

/**
 * PHARR_MAIN: Primary border crossing sink.
 * Only cleared mass can exit.
 */
export const SINK_PHARR_MAIN = createSinkDef({
    id: 'pharr_main',
    description: 'Pharr-Reynosa bridge crossing. Cleared mass only.',
    eligible_classes: ['cleared'],
    uses_bundle_capacity: true,
    fixed_capacity_kg_per_hour: null,
});

/**
 * V1 sink registry.
 */
export const V1_SINKS = Object.freeze({
    pharr_main: SINK_PHARR_MAIN,
});

/**
 * V1 sink IDs for iteration.
 */
export const V1_SINK_IDS = Object.freeze(['pharr_main']);

// ───────────────────────────────────────────────────────────────────────────────
// V1 CONVERSIONS
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Conversion dwell time in seconds (30 minutes).
 * Represents: trailer swap, paperwork, inspection clearance.
 */
export const DWELL_TIME_YARD_S = 1800;

/**
 * YARD_TRANSFER: restricted → cleared in yard_main.
 * Time-based: average dwell of 30 minutes.
 * @deprecated Use LOT_TRANSFER for polygon-based lots
 */
export const CONVERSION_YARD_TRANSFER = createConversionRule({
    id: 'yard_transfer',
    description: 'Transfer operation in yard. Restricted becomes cleared after dwell.',
    from_class: 'restricted',
    to_class: 'cleared',
    region_id: 'yard_main',
    mode: ConversionMode.TIME,
    dwell_time_s: DWELL_TIME_YARD_S,
    max_rate_kg_per_s: null,
    enabled: true,
});

/**
 * LOT_TRANSFER: restricted → cleared in lot regions.
 * Time-based: average dwell of 30 minutes (same as yard_transfer).
 */
export const CONVERSION_LOT_TRANSFER = createConversionRule({
    id: 'lot_transfer',
    description: 'Transfer operation in lot. Restricted becomes cleared after dwell.',
    from_class: 'restricted',
    to_class: 'cleared',
    region_id: 'lot',
    mode: ConversionMode.TIME,
    dwell_time_s: DWELL_TIME_YARD_S,
    max_rate_kg_per_s: null,
    enabled: true,
});

/**
 * V1 conversion registry.
 */
export const V1_CONVERSIONS = Object.freeze({
    yard_transfer: CONVERSION_YARD_TRANSFER,
    lot_transfer: CONVERSION_LOT_TRANSFER,
});

/**
 * V1 conversion IDs for iteration.
 */
export const V1_CONVERSION_IDS = Object.freeze(['yard_transfer', 'lot_transfer']);

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate a ClassDef.
 * @param {ClassDef} classDef
 * @throws {Error} if invalid
 */
export function validateClassDef(classDef) {
    if (!classDef.id || typeof classDef.id !== 'string') {
        throw new Error('ClassDef must have string id');
    }
    if (typeof classDef.conductance_scale !== 'number' || classDef.conductance_scale < 0) {
        throw new Error(`ClassDef ${classDef.id}: conductance_scale must be non-negative number`);
    }
    return true;
}

/**
 * Validate a RegionDef.
 * @param {RegionDef} regionDef
 * @throws {Error} if invalid
 */
export function validateRegionDef(regionDef) {
    if (!regionDef.id || typeof regionDef.id !== 'string') {
        throw new Error('RegionDef must have string id');
    }
    if (!Object.values(RegionType).includes(regionDef.type)) {
        throw new Error(`RegionDef ${regionDef.id}: invalid type ${regionDef.type}`);
    }
    if (typeof regionDef.base_conductance !== 'number' || regionDef.base_conductance < 0) {
        throw new Error(`RegionDef ${regionDef.id}: base_conductance must be non-negative number`);
    }
    return true;
}

/**
 * Validate a SinkDef.
 * @param {SinkDef} sinkDef
 * @throws {Error} if invalid
 */
export function validateSinkDef(sinkDef) {
    if (!sinkDef.id || typeof sinkDef.id !== 'string') {
        throw new Error('SinkDef must have string id');
    }
    if (!Array.isArray(sinkDef.eligible_classes)) {
        throw new Error(`SinkDef ${sinkDef.id}: eligible_classes must be array`);
    }
    return true;
}

/**
 * Validate a ConversionRule.
 * @param {ConversionRule} rule
 * @throws {Error} if invalid
 */
export function validateConversionRule(rule) {
    if (!rule.id || typeof rule.id !== 'string') {
        throw new Error('ConversionRule must have string id');
    }
    if (!rule.from_class || !rule.to_class) {
        throw new Error(`ConversionRule ${rule.id}: must have from_class and to_class`);
    }
    if (rule.from_class === rule.to_class) {
        throw new Error(`ConversionRule ${rule.id}: from_class cannot equal to_class`);
    }
    if (!rule.region_id) {
        throw new Error(`ConversionRule ${rule.id}: must have region_id`);
    }
    if (!Object.values(ConversionMode).includes(rule.mode)) {
        throw new Error(`ConversionRule ${rule.id}: invalid mode ${rule.mode}`);
    }
    if (rule.mode === ConversionMode.TIME && (rule.dwell_time_s === null || rule.dwell_time_s <= 0)) {
        throw new Error(`ConversionRule ${rule.id}: TIME mode requires positive dwell_time_s`);
    }
    if (rule.mode === ConversionMode.RATE && (rule.max_rate_kg_per_s === null || rule.max_rate_kg_per_s <= 0)) {
        throw new Error(`ConversionRule ${rule.id}: RATE mode requires positive max_rate_kg_per_s`);
    }
    return true;
}

/**
 * Validate entire v1 configuration.
 * @throws {Error} if any validation fails
 */
export function validateV1Config() {
    // Validate all classes
    for (const classDef of Object.values(V1_CLASSES)) {
        validateClassDef(classDef);
    }

    // Validate all regions
    for (const regionDef of Object.values(V1_REGIONS)) {
        validateRegionDef(regionDef);
    }

    // Validate all sinks
    for (const sinkDef of Object.values(V1_SINKS)) {
        validateSinkDef(sinkDef);
        // Check eligible classes exist
        for (const classId of sinkDef.eligible_classes) {
            if (!V1_CLASSES[classId]) {
                throw new Error(`SinkDef ${sinkDef.id}: eligible class ${classId} not found`);
            }
        }
    }

    // Validate all conversions
    for (const rule of Object.values(V1_CONVERSIONS)) {
        validateConversionRule(rule);
        // Check classes exist
        if (!V1_CLASSES[rule.from_class]) {
            throw new Error(`ConversionRule ${rule.id}: from_class ${rule.from_class} not found`);
        }
        if (!V1_CLASSES[rule.to_class]) {
            throw new Error(`ConversionRule ${rule.id}: to_class ${rule.to_class} not found`);
        }
        // Check region exists
        if (!V1_REGIONS[rule.region_id]) {
            throw new Error(`ConversionRule ${rule.id}: region_id ${rule.region_id} not found`);
        }
        // Check region references this conversion
        const region = V1_REGIONS[rule.region_id];
        if (!region.conversion_rule_ids.includes(rule.id)) {
            throw new Error(`ConversionRule ${rule.id}: region ${rule.region_id} does not reference this rule`);
        }
    }

    // Check class sink_eligibility references valid sinks
    for (const classDef of Object.values(V1_CLASSES)) {
        for (const sinkId of Object.keys(classDef.sink_eligibility)) {
            if (!V1_SINKS[sinkId]) {
                throw new Error(`ClassDef ${classDef.id}: sink_eligibility references unknown sink ${sinkId}`);
            }
        }
    }

    // Check class region_access references valid regions
    for (const classDef of Object.values(V1_CLASSES)) {
        for (const regionId of Object.keys(classDef.region_access)) {
            if (!V1_REGIONS[regionId]) {
                throw new Error(`ClassDef ${classDef.id}: region_access references unknown region ${regionId}`);
            }
        }
    }

    console.log('[ClassSystem] V1 configuration validated successfully');
    return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a class can drain at a sink.
 * @param {string} classId
 * @param {string} sinkId
 * @returns {boolean}
 */
export function canClassDrainAtSink(classId, sinkId) {
    const classDef = V1_CLASSES[classId];
    if (!classDef) return false;
    return classDef.sink_eligibility[sinkId] === true;
}

/**
 * Check if a class can enter a region.
 * @param {string} classId
 * @param {string} regionId
 * @returns {boolean}
 */
export function canClassEnterRegion(classId, regionId) {
    const classDef = V1_CLASSES[classId];
    if (!classDef) return false;
    const access = classDef.region_access[regionId];
    return access?.allowed !== false;  // Default true if not specified
}

/**
 * Get conductance multiplier for a class in a region.
 * @param {string} classId
 * @param {string} regionId
 * @returns {number}
 */
export function getClassRegionConductance(classId, regionId) {
    const classDef = V1_CLASSES[classId];
    const regionDef = V1_REGIONS[regionId];
    if (!classDef || !regionDef) return 0;

    const classScale = classDef.conductance_scale;
    const regionBase = regionDef.base_conductance;
    const accessMultiplier = classDef.region_access[regionId]?.conductance_multiplier ?? 1.0;

    return classScale * regionBase * accessMultiplier;
}

/**
 * Get conversion rules active in a region.
 * @param {string} regionId
 * @returns {ConversionRule[]}
 */
export function getConversionsInRegion(regionId) {
    const regionDef = V1_REGIONS[regionId];
    if (!regionDef) return [];

    return regionDef.conversion_rule_ids
        .map(ruleId => V1_CONVERSIONS[ruleId])
        .filter(rule => rule && rule.enabled);
}

/**
 * Get all eligible classes for a sink.
 * @param {string} sinkId
 * @returns {string[]}
 */
export function getEligibleClassesForSink(sinkId) {
    const sinkDef = V1_SINKS[sinkId];
    if (!sinkDef) return [];
    return sinkDef.eligible_classes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

// Validate on module load (fail fast)
try {
    validateV1Config();
} catch (e) {
    console.error('[ClassSystem] V1 configuration validation failed:', e.message);
    throw e;
}
