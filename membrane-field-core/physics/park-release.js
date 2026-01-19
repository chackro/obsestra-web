// ═══════════════════════════════════════════════════════════════════════════════
// PARK RELEASE — Park waiting zone release logic
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Park dwell timing and release transitions.
//

/**
 * @typedef {Object} ParkReleaseContext
 * @property {Object} STATE - State enum with PARK, ROAD states
 * @property {Float32Array} parkMass - Park mass array
 * @property {function} particleMass - Function returning mass per particle
 * @property {function} addToMovingParticles - Function to add particle to moving set
 * @property {Object} metrics - Metrics object with releasedFromParks counter
 */

/**
 * Release a particle from park waiting zone.
 * AUTHORIZED WRITE: particle released from park ONLY here.
 * @param {Object} p - Particle to release
 * @param {ParkReleaseContext} ctx - Release context
 * @returns {number} Mass released
 */
export function releasePark(p, ctx) {
    const { STATE, parkMass, particleMass, addToMovingParticles, metrics } = ctx;

    if (p.state !== STATE.PARK) {
        throw new Error(`[INVARIANT:RELEASE] Cannot release particle in state ${p.state}`);
    }

    // Release from park mass accounting
    if (p.parkIdx >= 0) {
        parkMass[p.parkIdx] -= particleMass();
    }

    // Transition to ROAD state (will seek lot or exit via normal flow)
    p.state = STATE.ROAD;
    addToMovingParticles(p);
    p.parkIdx = -1;
    p.parkArrivalTime = 0;
    p.parkDwell24h = false;

    metrics.releasedFromParks = (metrics.releasedFromParks || 0) + particleMass();

    return particleMass();
}

/**
 * @typedef {Object} ParkStepContext
 * @property {Array} parkReleaseQueue - Queue of particles waiting to be released
 * @property {number} simTime - Current simulation time
 * @property {number} dwellS - Standard dwell time in seconds
 * @property {number} dwell24hS - 24-hour dwell time in seconds
 * @property {Object} STATE - State enum
 * @property {Float32Array} parkMass - Park mass array
 * @property {function} particleMass - Function returning mass per particle
 * @property {function} addToMovingParticles - Function to add particle to moving set
 * @property {Object} metrics - Metrics object
 */

/**
 * Process park release queue, releasing particles whose dwell time has elapsed.
 * @param {ParkStepContext} ctx - Step context
 */
export function stepParkRelease(ctx) {
    const { parkReleaseQueue, simTime, dwellS, dwell24hS, STATE, parkMass, particleMass, addToMovingParticles, metrics } = ctx;

    // Scan queue for any ready particles (dwell times vary: 4h vs 24h)
    // Process in queue order but don't assume ordering by readiness
    let i = 0;
    while (i < parkReleaseQueue.length) {
        const p = parkReleaseQueue[i];

        // Check particle still valid (still in park state)
        if (p.state !== STATE.PARK) {
            parkReleaseQueue.splice(i, 1);
            continue;
        }

        // Check dwell time (24-hour for industrial park particles, 4-hour for others)
        const waited = simTime - p.parkArrivalTime;
        const requiredDwell = p.parkDwell24h ? dwell24hS : dwellS;

        if (waited >= requiredDwell) {
            // Release and remove from queue
            releasePark(p, { STATE, parkMass, particleMass, addToMovingParticles, metrics });
            parkReleaseQueue.splice(i, 1);
        } else {
            i++;
        }
    }
}
