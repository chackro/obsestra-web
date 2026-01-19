// ═══════════════════════════════════════════════════════════════════════════════
// Particle Transfer — State transitions when particles cross cells
// ═══════════════════════════════════════════════════════════════════════════════
//
// This module handles all particle state transitions during movement:
// - Out-of-bounds removal
// - Departed particle removal (exited via exit zone)
// - Sink entry (CBP queue)
// - Lot entry (conversion lots)
// - Sleep lot entry (when bridge closed)
// - Park entry
// - Road capacity bounces
// - Normal road-to-road moves
//
// Receives a context object with all dependencies (no module-level globals).
// Mutates state in place (context arrays/queues/metrics).
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} TransferContext
 * @property {number} N - Grid dimension
 * @property {number} simTime - Current simulation time
 *
 * // Grid state (mutable)
 * @property {Array<Array>} cellParticles - Particles per cell
 * @property {Float64Array} cellMass - Mass per cell
 * @property {Set<number>} activeCells - Cells with particles
 * @property {Uint8Array} regionMap - Region type per cell
 *
 * // Lot state (mutable)
 * @property {Int16Array} cellToLotIndex - Cell -> lot index
 * @property {Array<number[]>} lotToCellIndices - Lot -> cell indices
 * @property {Float32Array} lotMass - Current mass per lot
 * @property {Float32Array} lotCapacity - Capacity per lot
 * @property {number} lotAdmissionCutoff - Admission threshold (0.55)
 *
 * // Park state (mutable)
 * @property {Int16Array} cellToParkIndex - Cell -> park index
 * @property {Float32Array} parkMass - Current mass per park
 * @property {Float32Array} parkCapacity - Capacity per park
 *
 * // Queues (mutable)
 * @property {Array} sinkQueue - CBP queue
 * @property {Array} conversionQueue - Lot conversion queue
 * @property {Array} sleepingParticles - Sleep lot particles
 * @property {Array} parkReleaseQueue - Park release queue
 *
 * // Counters (mutable via wrapper)
 * @property {Object} counters - { departedCount: number }
 *
 * // Metrics (mutable)
 * @property {Object} metrics - { violations, enteredLots, enteredParks, moved }
 *
 * // Enums
 * @property {Object} STATE - State enum { ROAD, LOT, CLEARED, PARK, SLEEPING, DEPARTING }
 * @property {Object} REGION - Region enum { VOID, ROAD, LOT, SINK, SOURCE, PARK }
 *
 * // Config
 * @property {number[]} WAKE_OFFSETS - Sleep lot wake offsets [3600, 2700, 1800, 0]
 * @property {number} ROAD_CELL_CAP_KG - Road capacity (27000)
 * @property {number} SINK_CAP_MULT - Sink approach multiplier (3.0)
 *
 * // Functions
 * @property {function} particleMass - Get mass per particle
 * @property {function} removeFromActiveParticles - Remove from active array
 * @property {function} removeFromMovingParticles - Remove from moving array
 * @property {function} removeParticleTrail - Remove trail visualization
 * @property {function} isCellInBridgeApproach - Check if cell is in bridge approach
 * @property {function} isBridgeOpen - Check if bridge is open
 * @property {function} isSleepLot - Check if lot is designated for sleep
 * @property {function} fieldToWorldX - Convert field X to world X
 * @property {function} fieldToWorldY - Convert field Y to world Y
 * @property {function} sampleDwellSeconds - Sample dwell time
 * @property {function} rng - Random number generator [0, 1)
 */

/**
 * Apply a single particle transfer.
 * Handles all transition types: OOB, departed, SINK, LOT, SLEEP_LOT, PARK, road bounce.
 *
 * @param {Object} transfer - { p, from, to, action }
 * @param {TransferContext} ctx - Context with all dependencies
 */
export function applyTransfer({ p, from, to, action }, ctx) {
    const {
        N, simTime,
        cellParticles, cellMass, activeCells, regionMap,
        cellToLotIndex, lotToCellIndices, lotMass, lotCapacity, lotAdmissionCutoff,
        cellToParkIndex, parkMass, parkCapacity,
        sinkQueue, conversionQueue, sleepingParticles, parkReleaseQueue,
        counters, metrics,
        STATE, REGION, WAKE_OFFSETS, ROAD_CELL_CAP_KG, SINK_CAP_MULT,
        particleMass, removeFromActiveParticles, removeFromMovingParticles, removeParticleTrail,
        isCellInBridgeApproach, isBridgeOpen, isSleepLot,
        fieldToWorldX, fieldToWorldY, sampleDwellSeconds, rng,
    } = ctx;

    // Remove from old cell - O(1) swap-and-pop
    const arr = cellParticles[from];
    if (arr.length > 0 && p.slotIdx >= 0 && p.slotIdx < arr.length) {
        const lastP = arr[arr.length - 1];
        arr[p.slotIdx] = lastP;
        lastP.slotIdx = p.slotIdx;
        arr.pop();
        cellMass[from] -= particleMass();
        if (arr.length === 0) {
            activeCells.delete(from);
        }
    }

    // Handle out-of-bounds
    if (action === 'oob') {
        console.warn(`[TRANSFER] Particle ${p.id} went OOB`);
        metrics.violations++;
        removeFromActiveParticles(p);
        removeFromMovingParticles(p);
        removeParticleTrail(p.id);
        return;
    }

    // Handle departed particles (DEPARTING state reached exit zone)
    if (action === 'departed' || to < 0) {
        counters.departedCount++;
        removeFromActiveParticles(p);
        removeFromMovingParticles(p);
        removeParticleTrail(p.id);
        return;
    }

    const region = regionMap[to];

    // ─────────────────────────────────────────────────────────────────────────
    // SINK: Queue particle for CBP lane service
    // Particle stays visible until service completion (stepCBPCompletion)
    // DEPARTING particles are exiting through sink - don't re-queue them
    // ─────────────────────────────────────────────────────────────────────────
    if (region === REGION.SINK && p.state !== STATE.DEPARTING) {
        // Add particle to sink cell (stays visible until CBP service complete)
        p.cellIdx = to;
        p.slotIdx = cellParticles[to].length;
        cellParticles[to].push(p);
        activeCells.add(to);
        cellMass[to] += particleMass();

        // Queue for CBP lane assignment
        sinkQueue.push(p);
        return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LOT ENTRY: Capacity-gated, triggers state change
    // ─────────────────────────────────────────────────────────────────────────
    if (region === REGION.LOT && p.state === STATE.ROAD) {
        const lotIdx = cellToLotIndex[to];
        if (lotIdx < 0) {
            throw new Error(`[INVARIANT:LOT] Cell ${to} is REGION.LOT but cellToLotIndex=${lotIdx}`);
        }
        if (lotIdx >= 0) {
            const fill = lotMass[lotIdx] / lotCapacity[lotIdx];
            const canAdmit = fill < lotAdmissionCutoff && (lotCapacity[lotIdx] - lotMass[lotIdx]) >= particleMass();
            if (canAdmit) {
                // Enter lot - scatter to random cell within lot (physics position, not just render)
                const cells = lotToCellIndices[lotIdx];
                const targetCell = (cells && cells.length > 0)
                    ? cells[Math.floor(rng() * cells.length)]
                    : to;

                p.cellIdx = targetCell;
                p.state = STATE.LOT;
                removeFromMovingParticles(p);
                p.lotIdx = lotIdx;
                p.lotArrivalTime = simTime;
                p.dwellEnd = simTime + sampleDwellSeconds(rng);
                p.renderStalled = false;  // Clear stall - now waiting normally
                p.stallReason = null;     // Clear lot_full stall (instrumentation)
                p.slotIdx = cellParticles[targetCell].length;
                cellParticles[targetCell].push(p);
                activeCells.add(targetCell);
                cellMass[targetCell] += particleMass();
                lotMass[lotIdx] += particleMass();
                // Assert capacity not exceeded
                if (lotMass[lotIdx] > lotCapacity[lotIdx]) {
                    throw new Error(`[INVARIANT:LOT] lot=${lotIdx} mass=${lotMass[lotIdx]} > capacity=${lotCapacity[lotIdx]}`);
                }
                conversionQueue.push(p);
                metrics.enteredLots += particleMass();
                // Set render position to match physics cell
                const cx = targetCell % N;
                const cy = Math.floor(targetCell / N);
                p.x = fieldToWorldX(cx + 0.3 + rng() * 0.4);
                p.y = fieldToWorldY(cy + 0.3 + rng() * 0.4);
                p.lotParked = true;
                return;
            } else {
                // Lot full - bounce back (shouldn't happen if gate works, but safety)
                p.x = p.px;
                p.y = p.py;
                p.slotIdx = cellParticles[from].length;
                cellParticles[from].push(p);
                activeCells.add(from);
                cellMass[from] += particleMass();
                p.renderStalled = true;
                p.stallReason = 'lot_full';
                return;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SLEEP LOT ENTRY: CLEARED particles entering designated lots when bridge closed
    // ─────────────────────────────────────────────────────────────────────────
    if (region === REGION.LOT && p.state === STATE.CLEARED && !isBridgeOpen()) {
        const lotIdx = cellToLotIndex[to];
        if (lotIdx >= 0 && isSleepLot(lotIdx)) {
            const fill = lotMass[lotIdx] / lotCapacity[lotIdx];
            const canAdmit = fill < lotAdmissionCutoff && (lotCapacity[lotIdx] - lotMass[lotIdx]) >= particleMass();
            if (canAdmit) {
                // Enter sleep lot - scatter to random cell within lot (physics position)
                const cells = lotToCellIndices[lotIdx];
                const targetCell = (cells && cells.length > 0)
                    ? cells[Math.floor(rng() * cells.length)]
                    : to;

                p.cellIdx = targetCell;
                p.state = STATE.SLEEPING;
                removeFromMovingParticles(p);
                p.sleepLotIdx = lotIdx;
                p.sleepArrivalTime = simTime;
                p.wakeOffset = WAKE_OFFSETS[Math.floor(rng() * 4)];  // Random wave: 1hr, 45min, 30min, 0
                p.renderStalled = false;
                p.slotIdx = cellParticles[targetCell].length;
                cellParticles[targetCell].push(p);
                activeCells.add(targetCell);
                cellMass[targetCell] += particleMass();
                lotMass[lotIdx] += particleMass();
                sleepingParticles.push(p);
                // Set render position to match physics cell
                const cx = targetCell % N;
                const cy = Math.floor(targetCell / N);
                p.x = fieldToWorldX(cx + 0.3 + rng() * 0.4);
                p.y = fieldToWorldY(cy + 0.3 + rng() * 0.4);
                p.lotParked = true;
                return;
            } else {
                // Sleep lot full - fall back to sink queue
                // Continue to sink entry below
            }
        }
        // Not a sleep lot or full - continue routing to sink (fall through)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PARK ENTRY: Similar to lot but different state
    // ─────────────────────────────────────────────────────────────────────────
    if (region === REGION.PARK && p.state === STATE.ROAD) {
        const parkIdx = cellToParkIndex[to];
        if (parkIdx >= 0) {
            const available = parkCapacity[parkIdx] - parkMass[parkIdx];
            if (available >= particleMass()) {
                // Scatter within 3-cell radius of entry (physics position)
                const entryCx = to % N;
                const entryCy = Math.floor(to / N);
                const offsetX = Math.floor(rng() * 7) - 3;  // -3 to +3
                const offsetY = Math.floor(rng() * 7) - 3;
                const cx = Math.max(0, Math.min(N - 1, entryCx + offsetX));
                const cy = Math.max(0, Math.min(N - 1, entryCy + offsetY));
                const targetCell = cy * N + cx;

                p.cellIdx = targetCell;
                p.state = STATE.PARK;
                removeFromMovingParticles(p);
                p.parkIdx = parkIdx;
                p.parkArrivalTime = simTime;
                p.slotIdx = cellParticles[targetCell].length;
                cellParticles[targetCell].push(p);
                activeCells.add(targetCell);
                cellMass[targetCell] += particleMass();
                parkMass[parkIdx] += particleMass();
                parkReleaseQueue.push(p);
                metrics.enteredParks = (metrics.enteredParks || 0) + particleMass();
                // Set render position to match physics cell
                p.x = fieldToWorldX(cx + 0.4 + rng() * 0.2);
                p.y = fieldToWorldY(cy + 0.4 + rng() * 0.2);
                p.lotParked = true;
                return;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ROAD CAPACITY GATE: Handle deferred-transfer race condition
    // Pre-check passed for multiple particles, first transfer filled cell
    // EXCEPTION: Skip near sink (prevents funnel bottleneck)
    // ─────────────────────────────────────────────────────────────────────────
    const toNearSink = isCellInBridgeApproach(to);
    const toCap = toNearSink ? ROAD_CELL_CAP_KG * SINK_CAP_MULT : ROAD_CELL_CAP_KG;
    if (regionMap[to] === REGION.ROAD && cellMass[to] >= toCap) {
        // Race condition: cell filled by earlier transfer this tick — stall
        p.x = p.px;
        p.y = p.py;
        p.slotIdx = cellParticles[from].length;
        cellParticles[from].push(p);
        activeCells.add(from);
        cellMass[from] += particleMass();
        p.renderStalled = true;
        p.stallReason = 'road_full';
        return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // NORMAL MOVE: Road-to-road or cleared-to-road
    // ─────────────────────────────────────────────────────────────────────────
    p.cellIdx = to;
    p.slotIdx = cellParticles[to].length;
    cellParticles[to].push(p);
    activeCells.add(to);
    cellMass[to] += particleMass();
    metrics.moved += particleMass();
}
