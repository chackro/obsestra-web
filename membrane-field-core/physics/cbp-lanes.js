// ═══════════════════════════════════════════════════════════════════════════════
// CBP LANES — Customs and Border Protection lane model
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Particles exit ONLY on service completion, never by budget math.
//

/**
 * @typedef {Object} CBPLane
 * @property {Object|null} particle - Particle in lane, or null if empty
 * @property {number} busyUntil - simTime when lane becomes free
 */

/**
 * @typedef {Object} CBPContext
 * @property {number} serviceTimeS - Seconds per truck per lane (Infinity = closed)
 * @property {number} simTime - Current simulation time
 * @property {Array<CBPLane>} lanes - CBP inspection lanes
 * @property {Object} metrics - Metrics object with exited counter
 * @property {function} particleMass - Function returning mass per particle
 * @property {Array} sinkQueue - Particles waiting for CBP
 * @property {Object} STATE - State enum with DEPARTING state
 * @property {Array} serviceTimeActual - Array to push actual service times
 * @property {Array} serviceTimeExpected - Array to push expected service times
 * @property {Array} serviceTimeAssignSim - Array to push assignment times
 * @property {Object} counters - Object with cbpCompletionCount to increment
 */

/**
 * Process CBP lane completions and assignments for the time window [simTime-dt, simTime].
 * Handles multiple completions per lane per tick when dt > SERVICE_TIME_S.
 * This is the ONLY place particles exit the system.
 *
 * @param {number} dt - Time step in seconds
 * @param {CBPContext} ctx - CBP context
 */
export function stepCBPLanes(dt, ctx) {
    const { serviceTimeS, simTime, lanes, metrics, particleMass, sinkQueue, STATE,
            serviceTimeActual, serviceTimeExpected, serviceTimeAssignSim, counters } = ctx;

    // Closed hours or blocked: do nothing
    if (!isFinite(serviceTimeS)) return;

    const tickStart = simTime - dt;
    const tickEnd = simTime;

    for (const lane of lanes) {
        // Process all completions that should happen within [tickStart, tickEnd]
        while (lane.particle && lane.busyUntil <= tickEnd) {
            const p = lane.particle;

            // === AUTHORITATIVE EXIT ===
            // Particle is officially processed - count it as exited
            metrics.exited += particleMass();
            counters.cbpCompletionCount++;

            // AUDIT: Record actual vs expected service time
            if (p._cbpAssignTime !== undefined) {
                const actualServiceTime = simTime - p._cbpAssignTime;
                serviceTimeActual.push(actualServiceTime);
                serviceTimeExpected.push(p._cbpExpectedServiceTime || 0);
                serviceTimeAssignSim.push(p._cbpAssignTime);
            }

            // Transition to DEPARTING state for exit animation
            // Particle stays in sink cell, drift loop will move it out
            // Note: particle is already in movingParticles (was CLEARED, entered SINK but never removed)
            p.state = STATE.DEPARTING;
            p.departureTime = simTime;

            // Lane becomes free at busyUntil time (not simTime)
            const laneFreeTime = lane.busyUntil;
            lane.particle = null;

            // Immediately assign next particle if queue has particles
            if (sinkQueue.length > 0) {
                const next = sinkQueue.shift();
                lane.particle = next;
                // busyUntil starts from when lane became free, not simTime
                lane.busyUntil = laneFreeTime + serviceTimeS;
                next._cbpLane = lane;
                next._cbpEndTime = lane.busyUntil;
                // AUDIT: Record assignment time and expected service time
                next._cbpAssignTime = laneFreeTime;
                next._cbpExpectedServiceTime = serviceTimeS;
            } else {
                break;  // No more particles to process in queue
            }
        }

        // Also assign to lanes that were empty at start of tick
        if (lane.particle === null && sinkQueue.length > 0) {
            const p = sinkQueue.shift();
            lane.particle = p;
            // Service starts at beginning of tick window
            lane.busyUntil = tickStart + serviceTimeS;
            p._cbpLane = lane;
            p._cbpEndTime = lane.busyUntil;
            // AUDIT: Record assignment time and expected service time
            p._cbpAssignTime = tickStart;
            p._cbpExpectedServiceTime = serviceTimeS;
        }
    }
}

/**
 * Get number of active lanes (used for twin span calculations).
 * @param {Array<CBPLane>} lanes - CBP inspection lanes
 * @returns {number} Number of lanes with active particles
 */
export function getLanesInUse(lanes) {
    return lanes.filter(l => l.particle !== null).length;
}
