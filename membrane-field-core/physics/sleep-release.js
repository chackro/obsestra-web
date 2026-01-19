// ═══════════════════════════════════════════════════════════════════════════════
// SLEEP RELEASE — Bridge schedule and sleep lot wake timing
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Handles overnight sleeping lot release before bridge opens.
//

/**
 * @typedef {Object} BridgeScheduleContext
 * @property {number} simTime - Current simulation time in seconds
 * @property {Object|null} scenario - Scenario with getPharrGateCapacity(hour)
 */

/**
 * Get the next hour when the bridge will be open.
 * Searches forward from current hour to find first open hour.
 * @param {BridgeScheduleContext} ctx - Bridge schedule context
 * @returns {number} Hour (0-23) when bridge opens next
 */
export function getNextBridgeOpenHour(ctx) {
    const currentHour = Math.floor(ctx.simTime / 3600) % 24;
    for (let i = 1; i <= 24; i++) {
        const h = (currentHour + i) % 24;
        if (!ctx.scenario?.getPharrGateCapacity) return currentHour;
        const cap = ctx.scenario.getPharrGateCapacity(h);
        if (cap && cap.cap_kg_per_hour > 0) return h;
    }
    return currentHour;  // Fallback: never opens
}

/**
 * @typedef {Object} SleepReleaseContext
 * @property {number} simTime - Current simulation time in seconds
 * @property {Array} sleepingParticles - Array of sleeping particles
 * @property {Object} STATE - State enum with SLEEPING, CLEARED states
 * @property {function} addToMovingParticles - Function to add particle to moving set
 * @property {function} particleMass - Function returning mass per particle
 * @property {Float32Array} lotMass - Lot mass array
 * @property {boolean} twinSpanActive - Whether twin span is active
 * @property {number} openHour - Next bridge open hour
 */

/**
 * Release sleeping particles before bridge opens.
 * Staggered waves: 25% at 1hr, 45min, 30min, 0min before opening.
 * @param {SleepReleaseContext} ctx - Sleep release context
 */
export function stepSleepRelease(ctx) {
    const { sleepingParticles, simTime, STATE, addToMovingParticles, particleMass, lotMass, twinSpanActive, openHour } = ctx;

    if (sleepingParticles.length === 0) return;

    const currentHour = Math.floor(simTime / 3600) % 24;
    const currentDaySeconds = simTime % (24 * 3600);

    // Calculate target open time (in current day seconds)
    let openTimeS = openHour * 3600;
    if (openHour <= currentHour) {
        // Bridge opens tomorrow - add 24 hours
        openTimeS += 24 * 3600;
    }

    // Release particles whose wake time has arrived
    for (let i = sleepingParticles.length - 1; i >= 0; i--) {
        const p = sleepingParticles[i];
        if (p.state !== STATE.SLEEPING) {
            // Already released somehow - remove from list
            sleepingParticles.splice(i, 1);
            continue;
        }

        const wakeTimeS = openTimeS - p.wakeOffset;
        if (currentDaySeconds >= wakeTimeS || (wakeTimeS > 24 * 3600 && currentDaySeconds + 24 * 3600 >= wakeTimeS)) {
            // Time to wake up
            const lotIdx = p.sleepLotIdx;
            p.state = STATE.CLEARED;
            addToMovingParticles(p);
            // Assign to twin span based on particle ID (deterministic 50/50 split)
            p.useTwinSpan = twinSpanActive && (p.id % 2 === 0);
            p.sleepLotIdx = undefined;
            p.sleepArrivalTime = undefined;
            p.wakeOffset = undefined;
            p.lotParked = false;

            // Decrement lot mass
            if (lotIdx >= 0 && lotIdx < lotMass.length) {
                lotMass[lotIdx] -= particleMass();
                if (lotMass[lotIdx] < 0) lotMass[lotIdx] = 0;
            }

            sleepingParticles.splice(i, 1);
        }
    }
}
