/**
 * CREATE TEST BUNDLE
 * ===================
 * Creates a contract-compliant ReynosaOverlayBundle for testing.
 * This demonstrates the exact shape CIEN must produce.
 */

import {
    LOCKED_CONSTANTS,
    PHARR_DEFAULTS,
    RENDERER_TRANSFORM,
    HOURLY_DISTRIBUTION,
    validateBundle,
} from '../contracts/ReynosaOverlayBundle.js';

// =============================================================================
// TEST DATA
// =============================================================================

// Simulate annual PHARR kg from Layer 2 (10 billion kg/year)
const ANNUAL_PHARR_KG = 10_000_000_000;

// Hourly inflow profile multipliers (peaks at 7-10, 14-16)
const INFLOW_PROFILE = [
    0.2, 0.15, 0.1, 0.1, 0.15, 0.3,   // 0-5
    0.5, 0.8, 1.0, 1.0, 0.9, 0.85,    // 6-11
    0.8, 0.85, 0.95, 1.0, 0.9, 0.7,   // 12-17
    0.5, 0.4, 0.35, 0.3, 0.25, 0.2,   // 18-23
];

// =============================================================================
// BUNDLE CREATION
// =============================================================================

/**
 * Create a test bundle that conforms to the contract.
 * @returns {ReynosaOverlayBundle}
 */
export function createTestBundle() {
    const { weekday_traffic_share, business_days_per_year, avg_kg_per_truck } = LOCKED_CONSTANTS;

    // Calculate daily kg (typical weekday)
    const dailyKg = ANNUAL_PHARR_KG * weekday_traffic_share / business_days_per_year;

    // Build hourly inflow
    const hourlyKg = {};
    for (let h = 0; h < 24; h++) {
        hourlyKg[h] = dailyKg * HOURLY_DISTRIBUTION[h];
    }

    // Build hourly inflow by HS2 (split across commodities)
    const hourlyKgByHs2 = {};
    const hs2Shares = {
        "85": 0.25,  // Electronics
        "87": 0.20,  // Vehicles
        "84": 0.15,  // Machinery
        "39": 0.10,  // Plastics
        "72": 0.10,  // Steel
        "07": 0.08,  // Vegetables
        "94": 0.07,  // Furniture
        "90": 0.05,  // Instruments
    };

    for (let h = 0; h < 24; h++) {
        hourlyKgByHs2[h] = {};
        for (const [hs2, share] of Object.entries(hs2Shares)) {
            hourlyKgByHs2[h][hs2] = hourlyKg[h] * share;
        }
    }

    // Build hourly capacity
    const { s, mu, open_start, open_end } = PHARR_DEFAULTS;
    const capKgPerHour = s * mu * 60 * avg_kg_per_truck;

    const hourlyCapKg = {};
    for (let h = 0; h < 24; h++) {
        // PHARR open 6-24 (midnight)
        if (h >= open_start && h < open_end) {
            hourlyCapKg[h] = capKgPerHour;
        } else {
            hourlyCapKg[h] = 0;
        }
    }

    // Build fake road segments in ROI
    const segmentsInRoi = [
        {
            segment_id: "test_mty_corridor",
            geometry_coordinates: [
                [25.90, -98.30],  // South
                [26.00, -98.25],
                [26.05, -98.21],
                [26.067, -98.205],  // PHARR
            ],
        },
        {
            segment_id: "test_victoria_corridor",
            geometry_coordinates: [
                [25.85, -98.10],  // Southeast
                [25.95, -98.15],
                [26.03, -98.19],
                [26.067, -98.205],  // PHARR
            ],
        },
        {
            segment_id: "test_local_road_1",
            geometry_coordinates: [
                [25.95, -98.30],
                [25.95, -98.20],
                [25.95, -98.10],
            ],
        },
        {
            segment_id: "test_local_road_2",
            geometry_coordinates: [
                [26.00, -98.28],
                [26.00, -98.18],
            ],
        },
    ];

    const bundle = {
        metadata: {
            scenario_hash: "test_baseline_2025",
            layer: "layer2_infra_queue",
            time_basis: "typical_weekday",
            avg_kg_per_truck: LOCKED_CONSTANTS.AVG_KG_PER_TRUCK,
            weekday_traffic_share: LOCKED_CONSTANTS.WEEKDAY_TRAFFIC_SHARE,
            business_days_per_year: LOCKED_CONSTANTS.BUSINESS_DAYS_PER_YEAR,
            generated_at: new Date().toISOString(),
        },
        inflow: {
            hourly_kg: hourlyKg,
            hourly_kg_by_hs2: hourlyKgByHs2,
        },
        capacity: {
            hourly_kg: hourlyCapKg,
            params: {
                s: PHARR_DEFAULTS.s,
                mu: PHARR_DEFAULTS.mu,
                open_start: PHARR_DEFAULTS.open_start,
                open_end: PHARR_DEFAULTS.open_end,
            },
        },
        geometry: {
            pharr_coords: PHARR_DEFAULTS.coords,
            transform: { ...RENDERER_TRANSFORM },
            segments_in_roi: segmentsInRoi,
        },
    };

    return bundle;
}

/**
 * Validate and log bundle stats.
 */
export function validateTestBundle(bundle) {
    try {
        validateBundle(bundle);
        console.log('[createTestBundle] ✓ Bundle validation passed');
    } catch (e) {
        console.error('[createTestBundle] ✗ Bundle validation failed:', e.message);
        return false;
    }

    // Log stats
    const dailyInflowKg = Object.values(bundle.inflow.hourly_kg).reduce((a, b) => a + b, 0);
    const peakHour = Object.entries(bundle.inflow.hourly_kg)
        .sort((a, b) => b[1] - a[1])[0];
    const peakCap = Math.max(...Object.values(bundle.capacity.hourly_kg));

    console.log('[createTestBundle] Bundle stats:');
    console.log(`  Daily inflow: ${(dailyInflowKg / 1e6).toFixed(1)} Mt`);
    console.log(`  Peak hour: ${peakHour[0]}:00 → ${(peakHour[1] / 1e6).toFixed(2)} Mt`);
    console.log(`  Capacity (open): ${(peakCap / 1e6).toFixed(2)} Mt/hr`);
    console.log(`  Segments in ROI: ${bundle.geometry.segments_in_roi.length}`);

    return true;
}

// Export for use in test harness
export { LOCKED_CONSTANTS, HOURLY_DISTRIBUTION };
