/**
 * REYNOSA OVERLAY CONSUMPTION CONTRACT
 * =====================================
 * LOCKED: 2025-12-14
 *
 * This is the ONLY interface between CIEN and the Reynosa overlay.
 * Anything not defined here does not exist to the overlay.
 *
 * FROZEN SEMANTICS:
 * - Units: kg, 9000 kg/truck
 * - Time: typical weekday (0.85 share, 264 business days)
 * - Layer: layer2_infra_queue (post-equilibrium)
 * - Transform: renderer-local (not CIEN truth)
 */

// =============================================================================
// TYPE DEFINITIONS (JSDoc for JS consumption)
// =============================================================================

/**
 * @typedef {Object} BundleMetadata
 * @property {string} scenario_hash - Infrastructure scenario hash
 * @property {"layer2_infra_queue"} layer - LOCKED: always layer2
 * @property {"typical_weekday"} time_basis - LOCKED: always typical_weekday
 * @property {9000} avg_kg_per_truck - LOCKED: 9000 kg
 * @property {0.85} weekday_traffic_share - LOCKED: 0.85
 * @property {264} business_days_per_year - LOCKED: 264
 * @property {string} generated_at - ISO timestamp
 */

/**
 * @typedef {Object} InflowData
 * @property {Record<number, number>} hourly_kg - hour (0-23) → kg (point estimate)
 * @property {Record<number, number>} [hourly_kg_min] - hour (0-23) → kg lower bound (P10)
 * @property {Record<number, number>} [hourly_kg_max] - hour (0-23) → kg upper bound (P90)
 * @property {Record<number, Record<string, number>>} [hourly_kg_by_hs2] - hour → hs2 → kg
 * @property {Record<number, Record<string, Record<"MTY"|"VICTORIA"|"INTERIOR", number>>>} [hourly_kg_by_hs2_by_corridor]
 */

/**
 * @typedef {Object} CapacityParams
 * @property {number} s - lanes
 * @property {number} mu - service rate (trucks/min/lane)
 * @property {number} open_start - opening hour (0-23)
 * @property {number} open_end - closing hour (0-24, 24=midnight)
 */

/**
 * @typedef {Object} CapacityData
 * @property {Record<number, number>} hourly_kg - hour → cap_kg (0 when closed)
 * @property {CapacityParams} params
 */

/**
 * @typedef {Object} GeometryTransform
 * @property {number} origin_lat
 * @property {number} origin_lon
 * @property {number} meters_per_deg_lat - ~111320 at equator
 * @property {number} meters_per_deg_lon - ~111320 * cos(lat) at reference
 */

/**
 * @typedef {Object} SegmentGeometry
 * @property {string} segment_id
 * @property {Array<[number, number]>} geometry_coordinates - [[lat, lon], ...]
 */

/**
 * @typedef {Object} GeometryData
 * @property {{lat: number, lon: number}} pharr_coords
 * @property {GeometryTransform} transform
 * @property {SegmentGeometry[]} segments_in_roi
 */

/**
 * Segment load data from CIEN routing.
 * Structure: POE → HS2 → segment_id → kg (annual)
 *
 * CIEN decides routing and shares. Field never re-routes.
 * This data is READ-ONLY for the overlay.
 *
 * @typedef {Record<string, Record<string, Record<string, number>>>} SegmentLoadByPoeHs2
 * @example
 * {
 *   "hidalgo_pharr": {
 *     "07": { "123456": 187500, "234567": 95000 },
 *     "85": { "123456": 42000 }
 *   }
 * }
 */

/**
 * Flow totals by POE (annual kg).
 * This is the AUTHORITATIVE source for total mass flowing to each POE.
 * Used for injection instead of segment geometry matching.
 *
 * @typedef {Record<string, number>} FlowKgByPoe
 * @example
 * {
 *   "hidalgo_pharr": 478000000000,  // 478B kg/year to Pharr
 *   "donna": 12000000000
 * }
 */

/**
 * @typedef {Object} ReynosaOverlayBundle
 * @property {BundleMetadata} metadata
 * @property {InflowData} inflow
 * @property {CapacityData} capacity
 * @property {GeometryData} geometry
 * @property {SegmentLoadByPoeHs2} [segment_load_kg_by_poe_hs2] - Segment weights from CIEN (for visualization)
 * @property {FlowKgByPoe} [flow_kg_by_poe] - Authoritative flow totals by POE (for injection)
 */

// =============================================================================
// CONSTANTS (FROZEN)
// =============================================================================

export const LOCKED_CONSTANTS = Object.freeze({
    AVG_KG_PER_TRUCK: 9000,
    WEEKDAY_TRAFFIC_SHARE: 0.85,
    BUSINESS_DAYS_PER_YEAR: 264,
    LAYER: "layer2_infra_queue",
    TIME_BASIS: "typical_weekday",
});

// =============================================================================
// PHARR DEFAULTS (from poe_queue_params.py)
// =============================================================================

export const PHARR_DEFAULTS = Object.freeze({
    s: 4,
    mu: 0.33,
    open_start: 6,
    open_end: 24,  // midnight
    coords: { lat: 26.06669701044433, lon: -98.20517760083658 },
});

// =============================================================================
// TRANSFORM (renderer-local, not CIEN truth)
// =============================================================================

export const RENDERER_TRANSFORM = Object.freeze({
    origin_lat: PHARR_DEFAULTS.coords.lat,
    origin_lon: PHARR_DEFAULTS.coords.lon,
    meters_per_deg_lat: 111320,
    meters_per_deg_lon: 111320 * Math.cos(PHARR_DEFAULTS.coords.lat * Math.PI / 180),
});

// =============================================================================
// HOURLY DISTRIBUTION (from poe_queue.py, normalized)
// =============================================================================

// HOURLY_DISTRIBUTION from poe_queue.py (normalized, sums to 1.0)
// Raw values before normalization:
// 0-5:  0.02, 0.02, 0.02, 0.02, 0.03, 0.05
// 6-11: 0.08, 0.10, 0.10, 0.09, 0.08, 0.07
// 12-17: 0.07, 0.07, 0.10, 0.09, 0.08, 0.05
// 18-23: 0.03, 0.02, 0.02, 0.02, 0.02, 0.02
// Sum = 1.27 → divide by 1.27 to normalize
export const HOURLY_DISTRIBUTION = Object.freeze({
    0: 0.01575, 1: 0.01575, 2: 0.01575, 3: 0.01575, 4: 0.02362, 5: 0.03937,
    6: 0.06299, 7: 0.07874, 8: 0.07874, 9: 0.07087, 10: 0.06299, 11: 0.05512,
    12: 0.05512, 13: 0.05512, 14: 0.07874, 15: 0.07087, 16: 0.06299, 17: 0.03937,
    18: 0.02362, 19: 0.01575, 20: 0.01575, 21: 0.01575, 22: 0.01575, 23: 0.01575,
});

// =============================================================================
// VALIDATION (runtime assertions)
// =============================================================================

/**
 * Validate a bundle conforms to the contract.
 * @param {ReynosaOverlayBundle} bundle
 * @throws {Error} if validation fails
 */
export function validateBundle(bundle) {
    // Metadata checks
    // NOTE: avg_kg_per_truck is informational metadata from source data.
    // Simulation uses TRUCK_KG=9000 as physics constant (see reynosaOverlay_v2.js).
    if (bundle.metadata.layer !== "layer2_infra_queue") {
        throw new Error(`Contract violation: layer must be layer2_infra_queue, got ${bundle.metadata.layer}`);
    }
    if (bundle.metadata.time_basis !== "typical_weekday") {
        throw new Error(`Contract violation: time_basis must be typical_weekday, got ${bundle.metadata.time_basis}`);
    }

    // Inflow checks
    const inflowHours = Object.keys(bundle.inflow.hourly_kg).map(Number);
    if (inflowHours.length !== 24 || !inflowHours.every(h => h >= 0 && h < 24)) {
        throw new Error("Contract violation: hourly_kg must have exactly 24 hours (0-23)");
    }

    // Capacity checks
    const { open_start, open_end } = bundle.capacity.params;
    for (let h = 0; h < 24; h++) {
        const isOpen = (open_end > open_start)
            ? (h >= open_start && h < open_end)
            : (h >= open_start || h < open_end);

        if (!isOpen && bundle.capacity.hourly_kg[h] > 0) {
            throw new Error(`Contract violation: capacity must be 0 when closed (hour ${h})`);
        }
    }

    // Geometry checks
    if (!bundle.geometry.pharr_coords || !bundle.geometry.transform) {
        throw new Error("Contract violation: geometry must include pharr_coords and transform");
    }

    // Segment geometry consistency check
    validateSegmentGeometryConsistency(bundle);

    return true;
}

/**
 * Validate that all segment_ids in segment_load_kg_by_poe_hs2 have corresponding
 * geometry in segments_in_roi. Orphaned segments (weight without geometry) are
 * a contract violation - mass would silently disappear from visualization.
 *
 * @param {ReynosaOverlayBundle} bundle
 * @throws {Error} if segments have weights but no geometry
 */
export function validateSegmentGeometryConsistency(bundle) {
    const segmentLoad = bundle.segment_load_kg_by_poe_hs2;
    if (!segmentLoad) {
        return; // No segment weights to validate
    }

    // Build set of segment_ids that have geometry
    const geometryIds = new Set();
    if (bundle.geometry?.segments_in_roi) {
        for (const seg of bundle.geometry.segments_in_roi) {
            if (seg.segment_id) {
                geometryIds.add(seg.segment_id);
            }
        }
    }

    // Collect all segment_ids from load data and their total weights
    const orphanedSegments = [];
    let totalOrphanedKg = 0;

    for (const poe in segmentLoad) {
        const poeData = segmentLoad[poe];
        for (const hs2Code in poeData) {
            const hs2Data = poeData[hs2Code];
            for (const segId in hs2Data) {
                if (!geometryIds.has(segId)) {
                    const kg = hs2Data[segId];
                    orphanedSegments.push({ segId, poe, hs2Code, kg });
                    totalOrphanedKg += kg;
                }
            }
        }
    }

    if (orphanedSegments.length > 0) {
        // Dedupe by segment_id for cleaner error message
        const uniqueOrphans = [...new Set(orphanedSegments.map(o => o.segId))];
        const sampleOrphans = uniqueOrphans.slice(0, 5);
        const moreCount = uniqueOrphans.length - sampleOrphans.length;

        throw new Error(
            `Contract violation: ${uniqueOrphans.length} segment(s) in segment_load_kg_by_poe_hs2 ` +
            `have no geometry in segments_in_roi. ` +
            `Total orphaned mass: ${(totalOrphanedKg / 1e9).toFixed(3)}B kg. ` +
            `Orphaned segment_ids: [${sampleOrphans.join(', ')}]` +
            (moreCount > 0 ? ` and ${moreCount} more.` : '.') +
            ` CIEN must export geometry for all weighted segments.`
        );
    }
}

// =============================================================================
// OVERLAY INVARIANTS (assert during simulation)
// =============================================================================

/**
 * Assert mass conservation (call after each tick).
 * @param {number} totalInjected - cumulative kg injected
 * @param {number} totalDrained - cumulative kg drained
 * @param {number} currentMass - current field mass
 * @param {number} tolerance - acceptable drift (default 0.01 = 1%)
 */
export function assertMassConservation(totalInjected, totalDrained, currentMass, tolerance = 0.01) {
    const expected = totalInjected - totalDrained;
    const drift = Math.abs(currentMass - expected) / Math.max(expected, 1);
    if (drift > tolerance) {
        console.warn(`Mass conservation drift: ${(drift * 100).toFixed(2)}% (expected ${expected.toFixed(0)} kg, have ${currentMass.toFixed(0)} kg)`);
    }
}

/**
 * Assert capacity ceiling (call during drain).
 * @param {number} drainRateKgPerSec - instantaneous drain rate
 * @param {number} capacityKgPerHour - current hour's capacity
 */
export function assertCapacityCeiling(drainRateKgPerSec, capacityKgPerHour) {
    const maxRatePerSec = capacityKgPerHour / 3600;
    if (drainRateKgPerSec > maxRatePerSec * 1.001) {  // 0.1% tolerance
        throw new Error(`Capacity ceiling violated: draining ${drainRateKgPerSec.toFixed(2)} kg/s > cap ${maxRatePerSec.toFixed(2)} kg/s`);
    }
}

// =============================================================================
// CORRIDOR MAPPING
// =============================================================================

export const CORRIDOR_MAP = Object.freeze({
    "Nuevo Leon": "MTY",
    "Tamaulipas": "VICTORIA",  // can be refined by origin_city
    // Everything else → "INTERIOR"
});

/**
 * Map origin_state to corridor.
 * @param {string} originState
 * @param {string} [originCity] - optional for Tamaulipas refinement
 * @returns {"MTY"|"VICTORIA"|"INTERIOR"}
 */
export function mapCorridor(originState, originCity) {
    if (originState === "Nuevo Leon") return "MTY";
    if (originState === "Tamaulipas") return "VICTORIA";
    return "INTERIOR";
}
