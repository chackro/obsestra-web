// ═══════════════════════════════════════════════════════════════════════════════
// GEOMETRY QUERIES — Pure geometric predicates
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Point-in-polygon tests, line interpolation, proximity checks.
//

// Queue zone: 95m on each side of the bridge approach polyline (190m total width)
// This is the bridge approach geometry - always available, independent of TwinSpan activation
const QUEUE_ZONE_HALF_WIDTH = 95;
const QUEUE_ZONE_SEGMENTS = [
    // Approach segment: south start -> junction
    [
        { x: -363.6711606637666, y: -2694.9719926976927 },   // approach start (south)
        { x: -481.6711606637666, y: -2583.9719926976927 },   // junction
    ],
    // Bridge segment: junction -> north end
    [
        { x: -481.6711606637666, y: -2583.9719926976927 },   // junction
        { x: 236.39229354591248, y: 2212.2113236596624 },    // bridge end (north)
    ],
];

/**
 * Check if a point is inside the bridge approach quadrilateral.
 * Uses cross-product test (point must be on same side of all 4 edges).
 * @param {number} wx - World X coordinate
 * @param {number} wy - World Y coordinate
 * @param {Array<{x: number, y: number}>} quad - 4-point quadrilateral [p0, p1, p2, p3]
 * @returns {boolean} True if point is inside quad
 */
export function isInBridgeApproach(wx, wy, quad) {
    const q = quad;
    // Check if point is on same side of all 4 edges
    const cross = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const s0 = cross(q[0].x, q[0].y, q[1].x, q[1].y, wx, wy) >= 0;
    const s1 = cross(q[1].x, q[1].y, q[2].x, q[2].y, wx, wy) >= 0;
    const s2 = cross(q[2].x, q[2].y, q[3].x, q[3].y, wx, wy) >= 0;
    const s3 = cross(q[3].x, q[3].y, q[0].x, q[0].y, wx, wy) >= 0;
    return (s0 === s1) && (s1 === s2) && (s2 === s3);
}

/**
 * Interpolate X coordinate on twin span segments for a given Y value.
 * Searches all segments to find one containing the Y value, then interpolates.
 * @param {number} y - Y coordinate to query
 * @param {Array<Array<{x: number, y: number}>>} segments - Twin span segment points
 * @returns {number|null} Interpolated X, or null if Y is outside all segments
 */
export function getTwinSpanXAtY(y, segments) {
    if (!segments || segments.length === 0) {
        return null;
    }

    // Search all segments for the one containing this Y value
    for (const seg of segments) {
        if (!seg || seg.length < 2) continue;

        // Find the two points that bracket this Y value
        for (let i = 0; i < seg.length - 1; i++) {
            const p0 = seg[i];
            const p1 = seg[i + 1];

            // Check if Y is between these two points (handle both directions)
            const yMin = Math.min(p0.y, p1.y);
            const yMax = Math.max(p0.y, p1.y);

            if (y >= yMin && y <= yMax) {
                // Interpolate X based on Y
                const dy = p1.y - p0.y;
                if (Math.abs(dy) < 0.001) {
                    // Nearly horizontal segment, use average X
                    return (p0.x + p1.x) / 2;
                }
                const t = (y - p0.y) / dy;
                const x = p0.x + t * (p1.x - p0.x);
                return x;
            }
        }
    }

    // Y is outside all segments
    return null;
}

/**
 * Check if a point (x, y) is within the queue zone (within 95m of bridge approach polyline).
 * Uses point-to-segment distance for each segment in the polyline.
 * @param {number} x - World X coordinate
 * @param {number} y - World Y coordinate
 * @returns {boolean} True if point is within queue zone
 */
export function isInQueueZone(x, y) {
    for (const seg of QUEUE_ZONE_SEGMENTS) {
        if (!seg || seg.length < 2) continue;

        for (let i = 0; i < seg.length - 1; i++) {
            const p0 = seg[i];
            const p1 = seg[i + 1];

            // Point-to-segment distance
            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            const lenSq = dx * dx + dy * dy;

            let dist;
            if (lenSq < 0.001) {
                // Degenerate segment (single point)
                dist = Math.sqrt((x - p0.x) ** 2 + (y - p0.y) ** 2);
            } else {
                // Project point onto segment, clamped to [0,1]
                const t = Math.max(0, Math.min(1, ((x - p0.x) * dx + (y - p0.y) * dy) / lenSq));
                const projX = p0.x + t * dx;
                const projY = p0.y + t * dy;
                dist = Math.sqrt((x - projX) ** 2 + (y - projY) ** 2);
            }

            if (dist <= QUEUE_ZONE_HALF_WIDTH) {
                return true;
            }
        }
    }

    return false;
}
