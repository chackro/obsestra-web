// ═══════════════════════════════════════════════════════════════════════════════
// INJECTION CORE — Particle injection into the simulation
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Core injection functions for spawning particles.
//

/**
 * @typedef {Object} InjectContext
 * @property {function} createParticle - Factory function for particles
 * @property {Map} cellToSourceType - Map of cell index to source type
 * @property {Object} SOURCE_TYPE - Source type enum
 * @property {Array<Array>} cellParticles - Particles per cell
 * @property {Set} activeCells - Set of cells with particles
 * @property {function} addToActiveParticles - Add to active array
 * @property {function} addToMovingParticles - Add to moving array
 * @property {Float32Array} cellMass - Cell mass array
 * @property {function} particleMass - Get mass per particle
 * @property {Object} metrics - Metrics object
 * @property {function} assertCellInvariant - Invariant check
 * @property {Object} STATE - State enum
 */

/**
 * Inject a particle at the given cell.
 * AUTHORIZED WRITE: cellMass += TRUCK_KG ONLY here.
 * @param {number} cellIdx - Cell to inject into
 * @param {number} state - Particle state
 * @param {InjectContext} ctx - Injection context
 * @returns {Object} Created particle
 */
export function injectParticle(cellIdx, state, ctx) {
    const { createParticle, cellToSourceType, SOURCE_TYPE, cellParticles,
            activeCells, addToActiveParticles, addToMovingParticles,
            cellMass, particleMass, metrics, assertCellInvariant, STATE } = ctx;

    // Lookup source type from cell mapping
    const sourceType = cellToSourceType.get(cellIdx) || SOURCE_TYPE.UNKNOWN;
    const p = createParticle(cellIdx, state, sourceType);
    p.slotIdx = cellParticles[cellIdx].length;
    cellParticles[cellIdx].push(p);
    activeCells.add(cellIdx);
    addToActiveParticles(p);  // Flat array for GPU sync
    if (state === STATE.ROAD || state === STATE.CLEARED) {
        addToMovingParticles(p);  // Only moving particles need drift iteration
    }
    cellMass[cellIdx] += particleMass();
    metrics.injected += particleMass();
    assertCellInvariant(cellIdx, 'injectParticle');
    return p;
}

/**
 * @typedef {Object} InjectionStepContext
 * @property {number} simTime - Current simulation time
 * @property {number} inflowKgPerHour - Corridor inflow rate
 * @property {number} dailyTotalKg - Daily total kg
 * @property {number} localRatio - Industrial/local traffic ratio
 * @property {number} corridorRatio - Corridor traffic ratio
 * @property {function} getIndustrialShiftFraction - Shift fraction function
 * @property {Set} sourceCellIndices - Set of source cell indices
 * @property {Float32Array} sourceField - Source share field
 * @property {Map} cellToSourceType - Map of cell to source type
 * @property {Object} SOURCE_TYPE - Source type enum
 * @property {Map} sourcePhaseOffset - Phase offsets per source
 * @property {function} getPulseMultiplier - Pulse multiplier function
 * @property {number} industrialPulseDamping - Damping factor for industrial
 * @property {number} truckKg - Mass per truck
 * @property {number} stressMultiplier - Stress mode multiplier
 * @property {Map} injectionAccumulator - Accumulated kg per source
 * @property {function} injectWithSplit - Function to inject with state split
 * @property {function} log - Logging function
 */

/**
 * Step injection: accumulate kg and spawn particles when threshold reached.
 * @param {number} dt - Time step in seconds
 * @param {InjectionStepContext} ctx - Step context
 */
export function stepInjection(dt, ctx) {
    const { simTime, inflowKgPerHour, dailyTotalKg, localRatio, corridorRatio,
            getIndustrialShiftFraction, sourceCellIndices, sourceField, cellToSourceType,
            SOURCE_TYPE, sourcePhaseOffset, getPulseMultiplier, industrialPulseDamping,
            truckKg, stressMultiplier, injectionAccumulator, injectWithSplit } = ctx;

    const currentHour = Math.floor(simTime / 3600) % 24;

    // CORRIDORS: Follow CIEN hourly profile (demand-driven)
    const corridorKgPerS = inflowKgPerHour / 3600;

    // INDUSTRIAL: Follow 3-shift pattern (production-driven)
    // shiftFraction = what fraction of DAILY industrial production happens THIS HOUR
    const shiftFraction = getIndustrialShiftFraction(currentHour);
    const industrialDailyKg = dailyTotalKg * localRatio;
    const industrialKgPerS = industrialDailyKg * shiftFraction / 3600;

    if (corridorKgPerS <= 0 && industrialKgPerS <= 0) return;

    for (const idx of sourceCellIndices) {
        const share = sourceField[idx];  // This source's share (0-1)
        if (share <= 0) continue;

        // Determine rate based on source type
        const sourceType = cellToSourceType.get(idx);
        let baseRate;
        if (sourceType === SOURCE_TYPE.INDUSTRIAL) {
            // Industrial source: share is its portion of localRatio
            const normalizedShare = share / localRatio;
            baseRate = normalizedShare * industrialKgPerS;
        } else {
            // Corridor source: share is its portion of corridorRatio
            const normalizedShare = share / corridorRatio;
            baseRate = normalizedShare * corridorKgPerS * corridorRatio;
        }

        // PULSE INJECTION: Modulate rate by organic pulse multiplier.
        const phaseOffset = sourcePhaseOffset.get(idx) ?? 0;
        const rawPulse = getPulseMultiplier(simTime, phaseOffset, idx);
        const pulseMultiplier = (sourceType === SOURCE_TYPE.INDUSTRIAL)
            ? 1.0 + (rawPulse - 1.0) * industrialPulseDamping  // Damp to ±15%
            : rawPulse;                                         // Full ±88%
        const rate = baseRate * pulseMultiplier;

        let acc = (injectionAccumulator.get(idx) || 0) + rate * dt;
        const threshold = truckKg / stressMultiplier;  // Stress: 5x more particles
        while (acc >= threshold) {
            injectWithSplit(idx);  // 65% restricted, 35% cleared
            acc -= threshold;
        }
        injectionAccumulator.set(idx, acc);
    }
}
