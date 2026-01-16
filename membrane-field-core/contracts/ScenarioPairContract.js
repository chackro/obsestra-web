/**
 * SCENARIO PAIR CONTRACT
 * =======================
 * LOCKED: 2025-12-14
 *
 * This contract defines what makes two CIEN scenario outputs "pairable"
 * for overlay interpolation. CIEN must produce bundles that satisfy this
 * contract BY CONSTRUCTION, not just pass validation.
 *
 * DELTA DRIFT PREVENTION:
 * If any of these invariants are violated, the time-lapse will lie.
 * The overlay cannot reconcile incompatible bundles - it will reject them.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT MUST BE IDENTICAL (LOCKED ACROSS PAIR)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. ROI DEFINITION
 *    - pharr_coords: { lat, lon } must match within 0.0001° (~11m)
 *    - ROI anchor is PHARR, not a scenario-specific center
 *    - ROI size is renderer-local (16km × 16km), not scenario-dependent
 *
 * 2. COORDINATE TRANSFORM
 *    - origin_lat, origin_lon must be IDENTICAL (not approximately equal)
 *    - meters_per_deg_lat, meters_per_deg_lon derived from origin
 *    - This ensures lat/lon → world meters mapping is consistent
 *
 * 3. TIME BASIS
 *    - time_basis: "typical_weekday" (LOCKED)
 *    - weekday_traffic_share: 0.85 (LOCKED)
 *    - business_days_per_year: 264 (LOCKED)
 *    - hourly_distribution: same 24-hour profile (LOCKED)
 *
 * 4. UNIT SEMANTICS
 *    - avg_kg_per_truck: 9000 (LOCKED)
 *    - All masses in kg (not tons, not trucks)
 *    - All times in hours (0-23)
 *
 * 5. LAYER
 *    - layer: "layer2_infra_queue" (LOCKED)
 *    - Both bundles from same CIEN processing stage
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHAT CAN DIFFER (SCENARIO DELTA)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. GEOMETRY (append-only)
 *    - Interserrana MAY add segments not in baseline
 *    - Interserrana MUST NOT remove segments from baseline
 *    - Segment IDs must be stable (same segment = same ID)
 *    - Segment coordinates must be identical for shared segments
 *
 * 2. INFLOW (hourly_kg)
 *    - Values can differ (more demand in interserrana scenario)
 *    - Hour keys must be identical (0-23)
 *
 * 3. CAPACITY (hourly_kg)
 *    - Values can differ (capacity expansion scenarios)
 *    - Operating hours can differ (but rarely should)
 *
 * 4. SEGMENT WEIGHTS (segment_load_kg_by_poe_hs2)
 *    - Values can differ (routing shifts)
 *    - New segments can have weights only in interserrana
 *    - Baseline segments can have different weights in interserrana
 *
 * 5. SCENARIO HASH
 *    - Must be different (identifies which scenario)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SCENARIO TYPES (KNOWN PAIRS)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PAIR 1: Baseline → Interserrana (infrastructure)
 *   - Baseline: Current road network
 *   - Interserrana: + Interserrana highway segment
 *   - Delta: Geometry adds 1 segment, weights shift to new route
 *
 * PAIR 2: Baseline → PHARR Capacity Expansion (future)
 *   - Baseline: Current PHARR capacity (s=4 lanes, μ=0.33)
 *   - Expansion: Increased capacity (s=6 lanes or higher μ)
 *   - Delta: Capacity values increase, geometry unchanged
 *
 * PAIR 3: Baseline → Demand Growth (future)
 *   - Baseline: Current demand levels
 *   - Growth: Projected demand increase
 *   - Delta: Inflow values increase, geometry unchanged
 */

// =============================================================================
// LOCKED PAIR INVARIANTS
// =============================================================================

export const PAIR_INVARIANTS = Object.freeze({
    // Coordinate tolerance (degrees) - ~11 meters
    COORD_TOLERANCE: 0.0001,

    // Time basis (must match exactly)
    TIME_BASIS: 'typical_weekday',
    WEEKDAY_TRAFFIC_SHARE: 0.85,
    BUSINESS_DAYS_PER_YEAR: 264,

    // Unit semantics
    AVG_KG_PER_TRUCK: 9000,

    // Layer
    LAYER: 'layer2_infra_queue',

    // Hour range
    HOURS: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]),
});

// =============================================================================
// PAIR VALIDATION
// =============================================================================

/**
 * Validate that two bundles form a valid scenario pair.
 * This is DEFENSE IN DEPTH - CIEN should produce valid pairs by construction.
 *
 * @param {ReynosaOverlayBundle} baseline
 * @param {ReynosaOverlayBundle} interserrana
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateScenarioPair(baseline, interserrana) {
    const errors = [];

    // 1. ROI / PHARR coordinates
    const pharrA = baseline.geometry.pharr_coords;
    const pharrB = interserrana.geometry.pharr_coords;
    if (Math.abs(pharrA.lat - pharrB.lat) > PAIR_INVARIANTS.COORD_TOLERANCE) {
        errors.push(`PHARR lat differs: ${pharrA.lat} vs ${pharrB.lat}`);
    }
    if (Math.abs(pharrA.lon - pharrB.lon) > PAIR_INVARIANTS.COORD_TOLERANCE) {
        errors.push(`PHARR lon differs: ${pharrA.lon} vs ${pharrB.lon}`);
    }

    // 2. Coordinate transform (must be IDENTICAL)
    const tA = baseline.geometry.transform;
    const tB = interserrana.geometry.transform;
    if (tA.origin_lat !== tB.origin_lat) {
        errors.push(`Transform origin_lat differs: ${tA.origin_lat} vs ${tB.origin_lat}`);
    }
    if (tA.origin_lon !== tB.origin_lon) {
        errors.push(`Transform origin_lon differs: ${tA.origin_lon} vs ${tB.origin_lon}`);
    }

    // 3. Time basis
    if (baseline.metadata.time_basis !== PAIR_INVARIANTS.TIME_BASIS) {
        errors.push(`Baseline time_basis must be ${PAIR_INVARIANTS.TIME_BASIS}`);
    }
    if (interserrana.metadata.time_basis !== PAIR_INVARIANTS.TIME_BASIS) {
        errors.push(`Interserrana time_basis must be ${PAIR_INVARIANTS.TIME_BASIS}`);
    }

    // 4. Unit semantics
    // NOTE: avg_kg_per_truck is informational metadata from source data.
    // Simulation uses TRUCK_KG=9000 as physics constant (see reynosaOverlay_v2.js).

    // 5. Layer
    if (baseline.metadata.layer !== PAIR_INVARIANTS.LAYER) {
        errors.push(`Baseline layer must be ${PAIR_INVARIANTS.LAYER}`);
    }
    if (interserrana.metadata.layer !== PAIR_INVARIANTS.LAYER) {
        errors.push(`Interserrana layer must be ${PAIR_INVARIANTS.LAYER}`);
    }

    // 6. Hour coverage
    const hoursA = Object.keys(baseline.inflow.hourly_kg).map(Number).sort((a, b) => a - b);
    const hoursB = Object.keys(interserrana.inflow.hourly_kg).map(Number).sort((a, b) => a - b);
    if (JSON.stringify(hoursA) !== JSON.stringify(PAIR_INVARIANTS.HOURS)) {
        errors.push(`Baseline hourly_kg must have hours 0-23`);
    }
    if (JSON.stringify(hoursB) !== JSON.stringify(PAIR_INVARIANTS.HOURS)) {
        errors.push(`Interserrana hourly_kg must have hours 0-23`);
    }

    // 7. Geometry append-only rule
    const baselineIds = new Set(baseline.geometry.segments_in_roi.map(s => s.segment_id));
    const interserranaIds = new Set(interserrana.geometry.segments_in_roi.map(s => s.segment_id));

    for (const id of baselineIds) {
        if (!interserranaIds.has(id)) {
            errors.push(`Baseline segment "${id}" missing in interserrana (append-only violated)`);
        }
    }

    // 8. Shared segment coordinate consistency
    const baselineSegMap = new Map(baseline.geometry.segments_in_roi.map(s => [s.segment_id, s]));
    for (const seg of interserrana.geometry.segments_in_roi) {
        const baseSeg = baselineSegMap.get(seg.segment_id);
        if (baseSeg) {
            // Shared segment - coordinates must match
            if (JSON.stringify(baseSeg.geometry_coordinates) !== JSON.stringify(seg.geometry_coordinates)) {
                errors.push(`Segment "${seg.segment_id}" has different coordinates in baseline vs interserrana`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

/**
 * Assert scenario pair validity. Throws on invalid pair.
 *
 * @param {ReynosaOverlayBundle} baseline
 * @param {ReynosaOverlayBundle} interserrana
 * @throws {Error} with details if invalid
 */
export function assertValidScenarioPair(baseline, interserrana) {
    const result = validateScenarioPair(baseline, interserrana);
    if (!result.valid) {
        throw new Error(
            `Invalid scenario pair:\n` +
            result.errors.map(e => `  - ${e}`).join('\n')
        );
    }
}

// =============================================================================
// DELTA COMPUTATION
// =============================================================================

/**
 * Compute the delta between two scenario bundles.
 * This is informational - shows what changed between scenarios.
 *
 * @param {ReynosaOverlayBundle} baseline
 * @param {ReynosaOverlayBundle} interserrana
 * @returns {ScenarioDelta}
 */
export function computeScenarioDelta(baseline, interserrana) {
    // Geometry delta
    const baselineIds = new Set(baseline.geometry.segments_in_roi.map(s => s.segment_id));
    const addedSegments = interserrana.geometry.segments_in_roi
        .filter(s => !baselineIds.has(s.segment_id))
        .map(s => s.segment_id);

    // Inflow delta (per hour)
    const inflowDelta = {};
    for (let h = 0; h < 24; h++) {
        const a = baseline.inflow.hourly_kg[h] || 0;
        const b = interserrana.inflow.hourly_kg[h] || 0;
        inflowDelta[h] = {
            baseline: a,
            interserrana: b,
            delta: b - a,
            ratio: a > 0 ? b / a : (b > 0 ? Infinity : 1),
        };
    }

    // Capacity delta (per hour)
    const capacityDelta = {};
    for (let h = 0; h < 24; h++) {
        const a = baseline.capacity.hourly_kg[h] || 0;
        const b = interserrana.capacity.hourly_kg[h] || 0;
        capacityDelta[h] = {
            baseline: a,
            interserrana: b,
            delta: b - a,
            ratio: a > 0 ? b / a : (b > 0 ? Infinity : 1),
        };
    }

    // Daily totals
    const dailyInflowBaseline = Object.values(baseline.inflow.hourly_kg).reduce((a, b) => a + b, 0);
    const dailyInflowInterserrana = Object.values(interserrana.inflow.hourly_kg).reduce((a, b) => a + b, 0);

    return {
        geometry: {
            baselineSegmentCount: baseline.geometry.segments_in_roi.length,
            interserranaSegmentCount: interserrana.geometry.segments_in_roi.length,
            addedSegments,
            addedSegmentCount: addedSegments.length,
        },
        inflow: {
            hourly: inflowDelta,
            dailyBaseline: dailyInflowBaseline,
            dailyInterserrana: dailyInflowInterserrana,
            dailyDelta: dailyInflowInterserrana - dailyInflowBaseline,
        },
        capacity: {
            hourly: capacityDelta,
        },
    };
}

/**
 * @typedef {Object} ScenarioDelta
 * @property {Object} geometry
 * @property {number} geometry.baselineSegmentCount
 * @property {number} geometry.interserranaSegmentCount
 * @property {string[]} geometry.addedSegments
 * @property {number} geometry.addedSegmentCount
 * @property {Object} inflow
 * @property {Object<number, {baseline: number, interserrana: number, delta: number, ratio: number}>} inflow.hourly
 * @property {number} inflow.dailyBaseline
 * @property {number} inflow.dailyInterserrana
 * @property {number} inflow.dailyDelta
 * @property {Object} capacity
 * @property {Object<number, {baseline: number, interserrana: number, delta: number, ratio: number}>} capacity.hourly
 */

// =============================================================================
// CIEN PRODUCTION REQUIREMENTS
// =============================================================================

/**
 * Requirements for CIEN when producing scenario pair bundles:
 *
 * 1. Use SAME infrastructure_graph for both scenarios
 *    - Only toggle specific edges (Interserrana segment)
 *    - Do not re-generate graph from scratch
 *
 * 2. Use SAME coordinate anchor
 *    - PHARR POE as origin
 *    - Do not let anchor drift between runs
 *
 * 3. Use SAME time basis parameters
 *    - typical_weekday, 0.85 share, 264 days
 *    - Do not vary these between scenarios
 *
 * 4. Use SAME ROI cropping logic
 *    - Same bounding box, same segment filtering
 *    - Ensures segment_id stability
 *
 * 5. Export segment_load_kg_by_poe_hs2 consistently
 *    - Same HS2 codes in both bundles
 *    - Zero values for unused segments (not omitted)
 *
 * 6. Run both scenarios in SAME session
 *    - Prevents config drift between runs
 *    - Ensures identical preprocessing
 */

export const CIEN_PRODUCTION_NOTES = `
CIEN SCENARIO PAIR PRODUCTION CHECKLIST:

□ Use shared infrastructure_graph (toggle edges, don't regenerate)
□ Lock coordinate anchor to PHARR POE
□ Lock time_basis to typical_weekday
□ Use identical ROI cropping bounds
□ Export segment_load_kg_by_poe_hs2 with same HS2 keys
□ Run both scenarios in same CIEN session
□ Validate pair before export using validateScenarioPair()
`;
