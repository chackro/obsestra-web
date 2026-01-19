// ═══════════════════════════════════════════════════════════════════════════════
// LOOP ROUTING — Waypoint-based particle routing on loop paths
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Directs particles along predefined waypoint sequences.
//

// Loop capture radius for entry point detection
export const LOOP_CAPTURE_RADIUS_M = 100;

// Waypoint capture radius for advancing along loop
export const LOOP_WAYPOINT_RADIUS_M = 50;

/**
 * @typedef {Object} LoopContext
 * @property {boolean} enabled - Whether loop routing is enabled
 * @property {Array<{x: number, y: number}>} waypoints - Loop waypoints
 * @property {function} worldToFieldX - World to field X conversion
 * @property {function} worldToFieldY - World to field Y conversion
 * @property {number} N - Grid dimension
 */

/**
 * Check if particle should enter the loop (near entry point).
 * @param {Object} p - Particle
 * @param {Array<{x: number, y: number}>} waypoints - Loop waypoints
 * @returns {boolean} True if particle entered loop
 */
export function checkLoopEntry(p, waypoints) {
    if (!waypoints || waypoints.length < 2) return false;
    if (p.loopTargetIdx !== undefined && p.loopTargetIdx >= 0) return false;

    const entry = waypoints[0];
    const dx = p.x - entry.x;
    const dy = p.y - entry.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < LOOP_CAPTURE_RADIUS_M) {
        p.loopTargetIdx = 1;  // Start heading to waypoint 1
        return true;
    }
    return false;
}

/**
 * Check if particle reached current waypoint and should advance.
 * @param {Object} p - Particle
 * @param {Array<{x: number, y: number}>} waypoints - Loop waypoints
 * @returns {boolean} True if particle exited loop (reached end)
 */
export function advanceWaypoint(p, waypoints) {
    if (p.loopTargetIdx < 0 || p.loopTargetIdx >= waypoints.length) return true;

    const target = waypoints[p.loopTargetIdx];
    const dx = p.x - target.x;
    const dy = p.y - target.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < LOOP_WAYPOINT_RADIUS_M) {
        p.loopTargetIdx++;
        if (p.loopTargetIdx >= waypoints.length) {
            // Exited the loop
            p.loopTargetIdx = -1;
            return true;
        }
    }
    return false;
}

/**
 * Get the next hop cell for a particle on the loop.
 * Returns cell index to move toward, or -1 if not on loop / exiting loop.
 * @param {Object} p - Particle
 * @param {LoopContext} ctx - Loop context
 * @returns {number} Cell index or -1
 */
export function getLoopNextHop(p, ctx) {
    const { enabled, waypoints, worldToFieldX, worldToFieldY, N } = ctx;

    if (!enabled || !waypoints || waypoints.length < 2) return -1;

    // Check if particle should enter the loop (near entry point)
    if (p.loopTargetIdx === undefined || p.loopTargetIdx < 0) {
        if (!checkLoopEntry(p, waypoints)) {
            return -1;  // Not on loop
        }
    }

    // Check if reached current target waypoint
    if (advanceWaypoint(p, waypoints)) {
        return -1;  // Exited loop
    }

    // Return cell index of current target waypoint
    if (p.loopTargetIdx >= 0 && p.loopTargetIdx < waypoints.length) {
        const wp = waypoints[p.loopTargetIdx];
        const fx = Math.floor(worldToFieldX(wp.x));
        const fy = Math.floor(worldToFieldY(wp.y));
        if (fx >= 0 && fx < N && fy >= 0 && fy < N) {
            return fy * N + fx;
        }
    }

    return -1;
}
