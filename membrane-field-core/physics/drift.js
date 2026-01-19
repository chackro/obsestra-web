// ═══════════════════════════════════════════════════════════════════════════════
// Physics: Particle Drift — Core particle movement logic
// ═══════════════════════════════════════════════════════════════════════════════
//
// This module handles the inner loop of particle movement:
//   - Routing decision (which next-hop to use)
//   - Capacity gates (lot full, road gridlock)
//   - Congestion-scaled velocity
//   - Cell boundary crossing
//
// Receives `ctx` context object with all dependencies explicitly passed.
// Returns transfer list and accumulator deltas (pure computation, no mutation).
//
// ═══════════════════════════════════════════════════════════════════════════════

import { getNeighbors4 } from '../lib/grid.js';
import { K_THRESHOLD, PHI_LARGE } from '../lib/constants.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DIRECTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get direction from cell a to cell b (4-connected neighbors only).
 * @param {number} a - Source cell index
 * @param {number} b - Target cell index
 * @param {number} N - Grid dimension
 * @returns {number} Direction (0=W, 1=E, 2=N, 3=S) or -1 if not neighbors
 */
export function dirFromTo(a, b, N) {
    const d = b - a;
    if (d === -1) return 0;      // W
    if (d === +1) return 1;      // E
    if (d === -N) return 2;      // N
    if (d === +N) return 3;      // S
    return -1;  // not 4-neighbor
}

/**
 * Get opposite direction.
 * @param {number} dir - Direction (0-3)
 * @returns {number} Opposite direction
 */
export function oppositeDir(dir) {
    // W(0) <-> E(1), N(2) <-> S(3)
    return dir ^ 1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRIFT CONTEXT — All dependencies for stepDriftAndTransferInner
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} DriftContext
 *
 * @property {number} N - Grid dimension
 * @property {number} dt - Time step (seconds)
 * @property {number} simTime - Current simulation time (seconds)
 *
 * // Grid arrays
 * @property {Uint8Array} regionMap - Region type per cell
 * @property {Float64Array} cellMass - Mass per cell (kg)
 * @property {Array<Array>} cellParticles - Particles per cell
 * @property {Float32Array} Kxx - X conductance
 * @property {Float32Array} Kyy - Y conductance
 * @property {Float32Array} commuterLoad - Commuter friction per cell
 * @property {Uint8Array} isIntersection - Intersection markers
 * @property {Float32Array} speedLimitMS - Speed limit per cell (m/s)
 * @property {Float32Array} sourceField - Source injection rate per cell
 * @property {Float32Array} cellCenterX - Cell center X coords
 * @property {Float32Array} cellCenterY - Cell center Y coords
 *
 * // Routing arrays
 * @property {Int32Array} nextHop_lots - Next hop toward lots
 * @property {Int32Array} nextHop_pharr - Next hop toward PHARR
 * @property {Int32Array} nextHop_pharr_twin - Next hop via twin span
 * @property {Int32Array} nextHop_sleepLots - Next hop toward sleep lots
 * @property {Float32Array} phi_lots - Potential to lots
 *
 * // Lot state
 * @property {Int16Array} cellToLotIndex - Cell to lot mapping
 * @property {Float32Array} lotMass - Lot mass
 * @property {Float32Array} lotCapacity - Lot capacity
 *
 * // Particles
 * @property {Array} movingParticles - Moving particles array
 * @property {number} movingParticleCount - Number of moving particles
 *
 * // Buffers (reused)
 * @property {Uint16Array} outCount4 - Outflow counts (N2 * 4)
 * @property {Array} touchedCells - Touched cell indices
 * @property {Uint8Array} touchedMark - Touched cell markers
 *
 * // Config
 * @property {Object} STATE - Particle state enum
 * @property {Object} REGION - Region type enum
 * @property {number} TRUCK_KG - Mass per truck
 * @property {number} ROAD_CELL_CAP_KG - Road cell capacity
 * @property {number} SINK_CAP_MULT - Sink area capacity multiplier
 * @property {number} STALL_CUTOFF - Congestion stall threshold
 * @property {number} COMMUTER_EQUIV_KG - Commuter equivalent mass
 * @property {number} COMMUTER_SPEED_PENALTY - Commuter speed penalty
 * @property {number} VISUAL_SPEED_MS - Base visual speed (m/s)
 * @property {Object} EXIT_ZONE - Exit zone config {x, y, radiusCells, maxTimeS}
 * @property {boolean} REPLAY_MODE - Replay mode flag
 * @property {number} REPLAY_TIME_SCALE - Replay time scale
 * @property {boolean} DEBUG_PAIRWISE_CANCELLATION - Debug flag
 *
 * // Module state
 * @property {Object} roi - Region of interest {cellSize}
 * @property {boolean} twinSpanActive - Twin span active flag
 * @property {number} routingVersion - Current routing version
 * @property {number} lotAdmissionCutoff - Lot admission cutoff
 * @property {boolean} verbose - Verbose logging flag
 *
 * // Helper functions
 * @property {function} isBridgeOpen - Check if bridge is open
 * @property {function} isCellInBridgeApproach - Check if cell is in bridge approach
 * @property {function} getLoopNextHop - Get loop next hop for particle
 * @property {function} congestionFactor - Compute congestion factor
 * @property {function} worldToFieldX - Convert world X to field X
 * @property {function} worldToFieldY - Convert world Y to field Y
 */

// ═══════════════════════════════════════════════════════════════════════════════
// ACCUMULATOR DELTAS — Returned instead of mutating module state
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} DriftAccumulators
 * @property {number} truckHoursLost - Total truck-hours lost
 * @property {number} truckHoursLostBridgeService - Lost in bridge service
 * @property {number} truckHoursLostBridgeQueue - Lost in bridge queue
 * @property {number} truckHoursLostCongestion - Lost to congestion
 * @property {number} truckHoursLostLotWait - Lost waiting for lots
 * @property {number} stalledMassKg - Stalled mass (kg*s)
 * @property {number} intersectionBlockCount - Intersection blocks
 */

/**
 * Create zero-initialized accumulators.
 * @returns {DriftAccumulators}
 */
export function createAccumulators() {
    return {
        truckHoursLost: 0,
        truckHoursLostBridgeService: 0,
        truckHoursLostBridgeQueue: 0,
        truckHoursLostCongestion: 0,
        truckHoursLostLotWait: 0,
        stalledMassKg: 0,
        intersectionBlockCount: 0,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTFLOW COUNTING (Pass A)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build directed outflow counts for O(P) pairwise cancellation.
 * For each moving particle, increment outCount4[cellIdx * 4 + dir].
 * Loop particles are EXCLUDED (exempt from congestion).
 *
 * @param {DriftContext} ctx - Drift context
 */
export function buildOutflowCounts(ctx) {
    const {
        N,
        movingParticles,
        movingParticleCount,
        regionMap,
        nextHop_lots,
        nextHop_pharr,
        nextHop_pharr_twin,
        nextHop_sleepLots,
        isBridgeOpen,
        twinSpanActive,
        STATE,
        REGION,
        outCount4,
        touchedCells,
        touchedMark,
    } = ctx;

    for (let i = 0; i < movingParticleCount; i++) {
        const p = movingParticles[i];

        // Skip particles waiting in sink queue
        if (p.state === STATE.CLEARED && regionMap[p.cellIdx] === REGION.SINK) continue;

        // Skip loop particles (exempt from congestion)
        if (p.loopTargetIdx !== undefined && p.loopTargetIdx >= 0) continue;

        // Compute nh using same logic as main loop
        let nh;
        if (p.state === STATE.ROAD) {
            nh = nextHop_lots[p.cellIdx];
        } else if (p.state === STATE.CLEARED) {
            if (!isBridgeOpen() && nextHop_sleepLots[p.cellIdx] >= 0) {
                nh = nextHop_sleepLots[p.cellIdx];
            } else if (p.useTwinSpan && twinSpanActive && nextHop_pharr_twin[p.cellIdx] >= 0) {
                nh = nextHop_pharr_twin[p.cellIdx];
            } else {
                nh = nextHop_pharr[p.cellIdx];
            }
        } else {
            continue;
        }

        if (nh < 0) continue;

        const dir = dirFromTo(p.cellIdx, nh, N);
        if (dir >= 0) {
            outCount4[p.cellIdx * 4 + dir]++;
            if (!touchedMark[p.cellIdx]) {
                touchedMark[p.cellIdx] = 1;
                touchedCells.push(p.cellIdx);
            }
        }
    }
}

/**
 * Reset outflow counts for touched cells only (sparse reset).
 * @param {DriftContext} ctx - Drift context
 */
export function resetOutflowCounts(ctx) {
    const { outCount4, touchedCells, touchedMark } = ctx;
    for (let k = 0; k < touchedCells.length; k++) {
        const c = touchedCells[k];
        const base = c * 4;
        outCount4[base] = outCount4[base + 1] = outCount4[base + 2] = outCount4[base + 3] = 0;
        touchedMark[c] = 0;
    }
    touchedCells.length = 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DRIFT LOOP (Pass B)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Main particle drift loop.
 * Processes all moving particles: routing, capacity gates, movement, transfers.
 *
 * @param {DriftContext} ctx - Drift context
 * @returns {{ transfers: Array, accumulators: DriftAccumulators }}
 */
export function driftParticles(ctx) {
    const {
        N, dt, simTime,
        // Grid
        regionMap, cellMass, cellParticles, Kxx, Kyy, commuterLoad,
        isIntersection, speedLimitMS, sourceField, cellCenterX, cellCenterY,
        // Routing
        nextHop_lots, nextHop_pharr, nextHop_pharr_twin, nextHop_sleepLots, phi_lots,
        // Lots
        cellToLotIndex, lotMass, lotCapacity,
        // Particles
        movingParticles, movingParticleCount,
        // Buffers
        outCount4,
        // Config
        STATE, REGION, TRUCK_KG, ROAD_CELL_CAP_KG, SINK_CAP_MULT, STALL_CUTOFF,
        COMMUTER_EQUIV_KG, COMMUTER_SPEED_PENALTY, VISUAL_SPEED_MS,
        EXIT_ZONE, REPLAY_MODE, REPLAY_TIME_SCALE, DEBUG_PAIRWISE_CANCELLATION,
        // State
        roi, twinSpanActive, routingVersion, lotAdmissionCutoff, verbose,
        // Functions
        isBridgeOpen, isCellInBridgeApproach, getLoopNextHop, congestionFactor,
        worldToFieldX, worldToFieldY,
    } = ctx;

    const transfers = [];
    const acc = createAccumulators();

    for (let i = 0; i < movingParticleCount; i++) {
        const p = movingParticles[i];
        const cellIdx = p.cellIdx;

        // Age particle
        p.age += dt;

        // Stuck detection
        if (p.px !== undefined && p.x === p.px && p.y === p.py) {
            p.stalledTime = (p.stalledTime || 0) + dt;
            const STUCK_THRESHOLD_S = 72 * 3600;
            if (p.stalledTime >= STUCK_THRESHOLD_S && !p.stuckLogged) {
                p.stuckLogged = true;
                const nh = (p.state === STATE.CLEARED ? nextHop_pharr : nextHop_lots)[p.cellIdx];
                if (verbose) console.log(`[STUCK >72h] id=${p.id} cell=${p.cellIdx} nh=${nh} state=${p.state} region=${regionMap[p.cellIdx]} reason=${p.stallReason}`);
            }
        } else {
            p.stalledTime = 0;
            p.stuckLogged = false;
        }

        // Skip particles in CBP area
        if (p.state === STATE.CLEARED && regionMap[cellIdx] === REGION.SINK) {
            acc.truckHoursLost += dt;
            if (p._cbpLane) {
                acc.truckHoursLostBridgeService += dt;
            } else {
                acc.truckHoursLostBridgeQueue += dt;
            }
            continue;
        }

        // Early exit zone check for DEPARTING particles
        if (p.state === STATE.DEPARTING) {
            const edx = p.x - EXIT_ZONE.x;
            const edy = p.y - EXIT_ZONE.y;
            const exitDist2 = edx * edx + edy * edy;
            const exitRadiusM = EXIT_ZONE.radiusCells * roi.cellSize;
            const timedOut = (simTime - p.departureTime) > EXIT_ZONE.maxTimeS;
            if (exitDist2 < exitRadiusM * exitRadiusM || timedOut) {
                transfers.push({ p, from: cellIdx, to: -1, action: 'departed' });
                continue;
            }
        }

        // Get routing table for this particle's state
        let nh;
        if (p.state === STATE.ROAD) {
            nh = nextHop_lots[p.cellIdx];
        } else if (p.state === STATE.CLEARED) {
            if (!isBridgeOpen() && nextHop_sleepLots[p.cellIdx] >= 0) {
                nh = nextHop_sleepLots[p.cellIdx];
            } else if (p.useTwinSpan && twinSpanActive && nextHop_pharr_twin[p.cellIdx] >= 0) {
                nh = nextHop_pharr_twin[p.cellIdx];
            } else {
                nh = nextHop_pharr[p.cellIdx];
            }
        } else if (p.state === STATE.DEPARTING) {
            // DEPARTURE ROUTING: Move toward exit zone
            const cx = cellIdx % N;
            const cy = Math.floor(cellIdx / N);
            const myX = cellCenterX[cellIdx];
            const myY = cellCenterY[cellIdx];
            const myDist2 = (myX - EXIT_ZONE.x) ** 2 + (myY - EXIT_ZONE.y) ** 2;
            let bestDist2 = myDist2;
            nh = -1;
            // Check all 4 neighbors
            if (cx > 0 && (Kxx[cellIdx - 1] > 0 || Kyy[cellIdx - 1] > 0)) {
                const nx = cellCenterX[cellIdx - 1], ny = cellCenterY[cellIdx - 1];
                const d2 = (nx - EXIT_ZONE.x) ** 2 + (ny - EXIT_ZONE.y) ** 2;
                if (d2 < bestDist2) { bestDist2 = d2; nh = cellIdx - 1; }
            }
            if (cx < N - 1 && (Kxx[cellIdx + 1] > 0 || Kyy[cellIdx + 1] > 0)) {
                const nx = cellCenterX[cellIdx + 1], ny = cellCenterY[cellIdx + 1];
                const d2 = (nx - EXIT_ZONE.x) ** 2 + (ny - EXIT_ZONE.y) ** 2;
                if (d2 < bestDist2) { bestDist2 = d2; nh = cellIdx + 1; }
            }
            if (cy > 0 && (Kxx[cellIdx - N] > 0 || Kyy[cellIdx - N] > 0)) {
                const nx = cellCenterX[cellIdx - N], ny = cellCenterY[cellIdx - N];
                const d2 = (nx - EXIT_ZONE.x) ** 2 + (ny - EXIT_ZONE.y) ** 2;
                if (d2 < bestDist2) { bestDist2 = d2; nh = cellIdx - N; }
            }
            if (cy < N - 1 && (Kxx[cellIdx + N] > 0 || Kyy[cellIdx + N] > 0)) {
                const nx = cellCenterX[cellIdx + N], ny = cellCenterY[cellIdx + N];
                const d2 = (nx - EXIT_ZONE.x) ** 2 + (ny - EXIT_ZONE.y) ** 2;
                if (d2 < bestDist2) { bestDist2 = d2; nh = cellIdx + N; }
            }
        } else {
            continue;
        }

        // LOOP OVERRIDE
        const loopNh = getLoopNextHop(p);
        if (loopNh >= 0) {
            nh = loopNh;
        }

        if (nh < 0) {
            p.renderStalled = true;
            p.stallReason = 'dead_end';
            if (p.stallStartVersion < 0) p.stallStartVersion = routingVersion;
            acc.truckHoursLost += dt;
            acc.truckHoursLostCongestion += dt;
            continue;
        }

        // Clear stall tracking
        p.renderStalled = false;
        p.stallReason = null;
        p.stallStartVersion = -1;
        p.routingVersion = routingVersion;
        p.lastRouteCell = cellIdx;
        p.lastRouteNh = nh;

        // CAPACITY GATE: Full lot
        if (!REPLAY_MODE && p.state === STATE.ROAD && regionMap[nh] === REGION.LOT) {
            const lotIdx = cellToLotIndex[nh];
            if (lotIdx >= 0) {
                const fill = lotMass[lotIdx] / lotCapacity[lotIdx];
                if (fill >= lotAdmissionCutoff) {
                    const currentPhi = phi_lots[cellIdx];
                    let altNh = -1, altPhi = currentPhi;
                    let backtrackNh = -1, backtrackPhi = Infinity;
                    const neighbors = getNeighbors4(cellIdx, N);

                    for (const ni of neighbors) {
                        if (ni === nh) continue;
                        if (Kxx[ni] < K_THRESHOLD && Kyy[ni] < K_THRESHOLD) continue;
                        if (phi_lots[ni] >= PHI_LARGE) continue;
                        if (regionMap[ni] === REGION.LOT) {
                            const niLotIdx = cellToLotIndex[ni];
                            if (niLotIdx >= 0 && lotMass[niLotIdx] / lotCapacity[niLotIdx] >= lotAdmissionCutoff) continue;
                        }
                        if (phi_lots[ni] < currentPhi) {
                            if (phi_lots[ni] < altPhi) { altPhi = phi_lots[ni]; altNh = ni; }
                        } else {
                            if (phi_lots[ni] < backtrackPhi) { backtrackPhi = phi_lots[ni]; backtrackNh = ni; }
                        }
                    }

                    if (altNh >= 0) {
                        nh = altNh;
                    } else if (backtrackNh >= 0) {
                        nh = backtrackNh;
                        p.stallReason = 'backtrack';
                    } else {
                        if (p.stallStartVersion < 0) {
                            p.stallStartVersion = routingVersion;
                            p.lastRouteCell = cellIdx;
                            p.lastRouteNh = nh;
                        }
                        if (routingVersion > p.stallStartVersion) {
                            console.error(`[REROUTE FAILURE] Particle ${p.id} stalled at v${p.stallStartVersion}, now v${routingVersion}`);
                        }
                        p.renderStalled = true;
                        p.stallReason = 'lot_full';
                        p.routingVersion = routingVersion;
                        acc.truckHoursLost += dt;
                        acc.truckHoursLostLotWait += dt;
                        continue;
                    }
                }
            }
        }

        // CAPACITY GATE: Road gridlock
        const nearSink = isCellInBridgeApproach(nh);
        const nhCap = nearSink ? ROAD_CELL_CAP_KG * SINK_CAP_MULT : ROAD_CELL_CAP_KG;
        if (!REPLAY_MODE && regionMap[nh] === REGION.ROAD && cellMass[nh] >= nhCap) {
            if (p.state === STATE.ROAD) {
                const currentPhi = phi_lots[cellIdx];
                let altNh = -1, altCongestion = Infinity;
                const neighbors = getNeighbors4(cellIdx, N);

                for (const ni of neighbors) {
                    if (ni === nh) continue;
                    if (phi_lots[ni] >= currentPhi) continue;
                    if (Kxx[ni] < K_THRESHOLD && Kyy[ni] < K_THRESHOLD) continue;
                    const niNearSink = isCellInBridgeApproach(ni);
                    const niCap = niNearSink ? ROAD_CELL_CAP_KG * SINK_CAP_MULT : ROAD_CELL_CAP_KG;
                    if (regionMap[ni] === REGION.ROAD && cellMass[ni] >= niCap) continue;
                    if (cellMass[ni] < altCongestion) { altCongestion = cellMass[ni]; altNh = ni; }
                }

                if (altNh >= 0) {
                    nh = altNh;
                } else {
                    p.renderStalled = true;
                    p.stallReason = 'road_full';
                    acc.truckHoursLost += dt;
                    acc.truckHoursLostCongestion += dt;
                    continue;
                }
            } else {
                p.renderStalled = true;
                p.stallReason = 'road_full';
                acc.truckHoursLost += dt;
                acc.truckHoursLostCongestion += dt;
                continue;
            }
        }

        // CONTINUOUS DRIFT
        const targetX = cellCenterX[nh];
        const targetY = cellCenterY[nh];
        const dx = targetX - p.x;
        const dy = targetY - p.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < 0.000001) continue;

        // Pairwise cancellation
        const dirAB = dirFromTo(cellIdx, nh, N);
        let opposingMass = 0;
        if (dirAB >= 0) {
            const dirBA = oppositeDir(dirAB);
            opposingMass = outCount4[nh * 4 + dirBA] * TRUCK_KG;
        }

        const rho = Math.max(0, cellMass[nh] - opposingMass);
        const commuterFriction = COMMUTER_EQUIV_KG * commuterLoad[nh];
        const rho_eff = rho + commuterFriction;
        const isSourceCell = sourceField[cellIdx] > 0;
        const isOnLoop = p.loopTargetIdx !== undefined && p.loopTargetIdx >= 0;
        const c = REPLAY_MODE ? 1.0 : ((regionMap[nh] === REGION.LOT || isSourceCell || isOnLoop) ? 1.0 : congestionFactor(rho_eff));

        if (c < STALL_CUTOFF) {
            acc.stalledMassKg += TRUCK_KG * dt;
        }

        const loss = 1 - c;
        acc.truckHoursLost += loss * dt;
        if (p.stallReason === 'lot_full') {
            acc.truckHoursLostLotWait += loss * dt;
        } else {
            acc.truckHoursLostCongestion += loss * dt;
        }

        // Intersection stop-go
        const cellLoad = commuterLoad[cellIdx];
        if (!REPLAY_MODE && isIntersection[cellIdx] && cellLoad > 0.6) {
            if (p._intersectionHoldUntil !== undefined) {
                if (simTime < p._intersectionHoldUntil) {
                    acc.truckHoursLost += dt;
                    acc.truckHoursLostCongestion += dt;
                    continue;
                } else {
                    p._intersectionHoldUntil = undefined;
                }
            } else {
                const phase = (cellIdx * 7919) % 1000 / 1000 * Math.PI * 2;
                const theta = simTime * 0.3 + phase;
                if (Math.sin(theta) > 0.85) {
                    const ASIN_085 = 1.0160;
                    const exitAngle = Math.PI - ASIN_085;
                    const thetaMod = theta % (2 * Math.PI);
                    const timeToExit = thetaMod < exitAngle
                        ? (exitAngle - thetaMod) / 0.3
                        : (2 * Math.PI - thetaMod + exitAngle) / 0.3;
                    p._intersectionHoldUntil = simTime + timeToExit;
                    acc.intersectionBlockCount++;
                    acc.truckHoursLost += dt;
                    acc.truckHoursLostCongestion += dt;
                    continue;
                }
            }
        }

        // Velocity jitter
        const jitterSeed = ((p.id * 7919) ^ Math.floor(simTime)) % 1000;
        const velJitter = cellLoad > 0
            ? Math.min(1.0, (1 - COMMUTER_SPEED_PENALTY * cellLoad) * (0.95 + jitterSeed * 0.0001))
            : 1.0;

        // Move
        const baseSpeed = speedLimitMS[cellIdx] > 0 ? speedLimitMS[cellIdx] : VISUAL_SPEED_MS;
        const moveDistance = baseSpeed * c * velJitter * dt * (REPLAY_MODE ? REPLAY_TIME_SCALE : 1.0);

        if (!REPLAY_MODE && moveDistance > 0.9 * roi.cellSize) {
            throw new Error(`[CFL] moveDistance=${moveDistance.toFixed(1)}m > limit=${(0.9 * roi.cellSize).toFixed(1)}m`);
        }

        p.px = p.x;
        p.py = p.y;

        if (moveDistance * moveDistance >= dist2) {
            p.x = targetX;
            p.y = targetY;
        } else {
            const dist = Math.sqrt(dist2);
            p.x += (dx / dist) * moveDistance;
            p.y += (dy / dist) * moveDistance;
        }

        // Exit zone check for DEPARTING
        if (p.state === STATE.DEPARTING) {
            const edx = p.x - EXIT_ZONE.x;
            const edy = p.y - EXIT_ZONE.y;
            const exitDist2 = edx * edx + edy * edy;
            const exitRadiusM = EXIT_ZONE.radiusCells * roi.cellSize;
            const timedOut = (simTime - p.departureTime) > EXIT_ZONE.maxTimeS;
            if (exitDist2 < exitRadiusM * exitRadiusM || timedOut) {
                transfers.push({ p, from: cellIdx, to: -1, action: 'departed' });
                continue;
            }
        }

        // Boundary check
        const newCellX = Math.floor(worldToFieldX(p.x));
        const newCellY = Math.floor(worldToFieldY(p.y));

        if (newCellX < 0 || newCellX >= N || newCellY < 0 || newCellY >= N) {
            transfers.push({ p, from: cellIdx, to: -1, action: 'oob' });
            continue;
        }

        const newIdx = newCellY * N + newCellX;
        if (newIdx !== p.cellIdx) {
            if (p.loopTargetIdx !== undefined && p.loopTargetIdx >= 0) {
                transfers.push({ p, from: cellIdx, to: newIdx });
            } else if (p.state === STATE.DEPARTING) {
                if (Kxx[newIdx] > 0 || Kyy[newIdx] > 0) {
                    transfers.push({ p, from: cellIdx, to: newIdx });
                }
            } else {
                const hasRoute = (p.state === STATE.CLEARED)
                    ? ((p.useTwinSpan && twinSpanActive ? nextHop_pharr_twin[newIdx] >= 0 : nextHop_pharr[newIdx] >= 0) || regionMap[newIdx] === REGION.SINK)
                    : (nextHop_lots[newIdx] >= 0 || regionMap[newIdx] === REGION.LOT);

                if (hasRoute) {
                    transfers.push({ p, from: cellIdx, to: newIdx });
                } else if (nh >= 0 && nh !== p.cellIdx) {
                    transfers.push({ p, from: cellIdx, to: nh });
                }
            }
        }
    }

    return { transfers, accumulators: acc };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute one drift substep.
 * Builds outflow counts, drifts particles, resets counts.
 *
 * @param {DriftContext} ctx - Drift context
 * @returns {{ transfers: Array, accumulators: DriftAccumulators }}
 */
export function stepDrift(ctx) {
    buildOutflowCounts(ctx);
    const result = driftParticles(ctx);
    resetOutflowCounts(ctx);
    return result;
}
