// ═══════════════════════════════════════════════════════════════════════════════
// LOT CONVERSION — Lot dwell completion and admission state
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Handles particle conversion after lot dwell and lot admission state tracking.
//

/**
 * @typedef {Object} ConversionContext
 * @property {Array} conversionQueue - Queue of particles waiting for conversion
 * @property {number} simTime - Current simulation time
 * @property {Object} STATE - State enum with LOT state
 * @property {function} convertParticle - Function to convert a particle
 * @property {function} isLotConversionAllowed - Gate check for conversion
 */

/**
 * Process conversion queue, converting particles whose dwell time has elapsed.
 * @param {ConversionContext} ctx - Conversion context
 */
export function stepConversion(ctx) {
    const { conversionQueue, simTime, STATE, convertParticle, isLotConversionAllowed } = ctx;

    // Gate: don't convert if bridge closes in <1hr
    if (!isLotConversionAllowed()) return;

    // Scan queue for any ready particles (dwell times vary per particle)
    // Process in queue order but don't assume ordering by readiness
    let i = 0;
    while (i < conversionQueue.length) {
        const p = conversionQueue[i];

        // Check particle still valid
        if (p.state !== STATE.LOT) {
            // Remove invalid particle, don't increment i
            conversionQueue.splice(i, 1);
            continue;
        }

        // Check if dwell complete
        if (simTime >= p.dwellEnd) {
            // Convert and remove from queue
            convertParticle(p);
            conversionQueue.splice(i, 1);
            // Don't increment i, next particle now at this index
        } else {
            // Not ready, move to next
            i++;
        }
    }
}

/**
 * @typedef {Object} LotAdmissionContext
 * @property {boolean} phiRebuilding - Whether routing rebuild is in progress
 * @property {Float32Array} lotCapacity - Lot capacities
 * @property {Float32Array} lotMass - Current lot masses
 * @property {Set} lotDraining - Set of lots currently draining
 * @property {Float32Array} lotCooldownEndSimS - Cooldown end times
 * @property {number} simTime - Current simulation time
 * @property {number} cooldownS - Cooldown duration in seconds
 * @property {number} admissionCutoff - Fill ratio to trigger draining
 * @property {number} admittedLotCount - Previous admitted count
 * @property {function} log - Logging function
 * @property {function} markRoutingDirty - Function to mark routing dirty
 * @property {function} recordAdmitLots - Tracking function for admission changes
 * @property {function} ctrlPhi - Phi control logging function
 */

/**
 * @typedef {Object} LotAdmissionResult
 * @property {boolean} needsRebuild - Whether routing rebuild is needed
 * @property {number} admittedCount - New admitted lot count
 * @property {number} exclusionCount - Number of new exclusions
 * @property {number} cooldownExpiryCount - Number of cooldown expirations
 */

/**
 * Update lot admission state machine: draining, cooldown, re-admission.
 * Tracks state transitions but does NOT trigger rebuilds inline.
 * @param {LotAdmissionContext} ctx - Admission context
 * @returns {LotAdmissionResult} Result with counts and rebuild flag
 */
export function updateLotAdmissionState(ctx) {
    const { phiRebuilding, lotCapacity, lotMass, lotDraining, lotCooldownEndSimS,
            simTime, cooldownS, admissionCutoff, admittedLotCount,
            log, markRoutingDirty, recordAdmitLots, ctrlPhi } = ctx;

    // Guard: skip if routing rebuild is in progress (state may be stale)
    if (phiRebuilding) {
        return { needsRebuild: false, admittedCount: admittedLotCount, exclusionCount: 0, cooldownExpiryCount: 0 };
    }

    let needsRebuild = false;
    let exclusionCount = 0;
    let cooldownExpiryCount = 0;

    // Process lot draining/cooldown state machine
    for (let i = 0; i < lotCapacity.length; i++) {
        if (lotCapacity[i] <= 0) continue;

        const fill = lotMass[i] / lotCapacity[i];
        const isEmpty = lotMass[i] <= 0;

        // Check if lot crossed cutoff → mark as draining
        if (fill >= admissionCutoff && !lotDraining.has(i)) {
            lotDraining.add(i);
            exclusionCount++;
            log(`[LOT] Lot ${i} started draining (fill=${(fill * 100).toFixed(0)}%)`);
            needsRebuild = true;
        }

        // Check if draining lot is now empty → start cooldown (sim-time based)
        if (lotDraining.has(i) && isEmpty) {
            lotDraining.delete(i);
            lotCooldownEndSimS[i] = simTime + cooldownS;
            log(`[LOT] Lot ${i} empty, cooldown started (${cooldownS}s sim-time)`);
        }

        // Check if cooldown expired → lot can accept again (sim-time based)
        if (lotCooldownEndSimS[i] > 0 && simTime >= lotCooldownEndSimS[i]) {
            lotCooldownEndSimS[i] = 0;
            cooldownExpiryCount++;
            log(`[LOT] Lot ${i} cooldown expired, now accepting`);
            needsRebuild = true;
        }
    }

    // Count currently admitted lots (below cutoff, not draining, not cooldown)
    let admitted = 0;
    for (let i = 0; i < lotCapacity.length; i++) {
        if (lotCapacity[i] > 0) {
            if (lotDraining.has(i)) continue;
            if (lotCooldownEndSimS[i] > 0 && simTime < lotCooldownEndSimS[i]) continue;
            const fill = lotMass[i] / lotCapacity[i];
            if (fill < admissionCutoff) admitted++;
        }
    }

    // Trigger: admitted count changed (a lot was excluded or re-admitted)
    if (admitted !== admittedLotCount) {
        const phiState = recordAdmitLots(admitted);
        ctrlPhi('ADMIT_CHANGE', {
            from: admittedLotCount,
            to: admitted,
            delta: admitted - admittedLotCount,
            phiState,
        });
        needsRebuild = true;
    }

    // Mark dirty when rebuild needed; let scheduleRoutingRebuild handle rate limiting
    if (needsRebuild) {
        markRoutingDirty('lot admission changed');
    }

    return { needsRebuild, admittedCount: admitted, exclusionCount, cooldownExpiryCount };
}
