// ═══════════════════════════════════════════════════════════════════════════════
// Potential Field — Dijkstra-based routing with capacity-aware lot penalties
// ═══════════════════════════════════════════════════════════════════════════════

import { MinHeap } from '../lib/MinHeap.js';
import { getNeighbors4 } from '../lib/grid.js';
import { PHI_LARGE, PHI_SINK, K_THRESHOLD, REGION_LOT } from '../lib/constants.js';

/**
 * Compute potential field from sinks using Dijkstra's algorithm.
 * 
 * Potential flows "uphill" from sinks (low φ) to sources (high φ).
 * Particles follow negative gradient (toward lower φ).
 * 
 * @param {Object} config
 * @param {number[]} config.sinkIndices - Cell indices of sinks (exits)
 * @param {number} config.N - Grid dimension
 * @param {number} config.N2 - Total cells (N²)
 * @param {number} config.edgeCost - Base cost per cell traversal
 * @param {Float32Array} config.Kxx - X-conductance per cell
 * @param {Float32Array} config.Kyy - Y-conductance per cell
 * @param {Uint8Array} config.regionMap - Region type per cell
 * @param {Int16Array} config.cellToLotIndex - Lot index per cell (-1 if not lot)
 * @param {number[]} config.drainingLots - Lot indices currently draining (blocked)
 * @param {Float32Array} config.lotCapacity - Capacity per lot
 * @param {Float32Array} config.lotMass - Current mass per lot
 * @param {string} config.label - Field label ('PHARR' or 'LOTS')
 * @param {Float32Array} [config.sinkBias] - Optional bias toward certain sinks
 * @param {number} [config.biasWeight] - Weight for sink bias
 * @param {Float32Array} [config.cellCost] - Optional per-cell cost multiplier
 * 
 * @returns {{phi: Float32Array, reachable: number}}
 */
export function computePotential(config) {
    const {
        sinkIndices, N, N2, edgeCost,
        Kxx, Kyy, regionMap, cellToLotIndex,
        drainingLots, lotCapacity, lotMass,
        label, sinkBias, biasWeight, cellCost
    } = config;

    const phi = new Float32Array(N2);
    phi.fill(PHI_LARGE);

    if (sinkIndices.length === 0) {
        return { phi, reachable: 0 };
    }

    const heap = new MinHeap();
    const visited = new Uint8Array(N2);
    const drainingSet = new Set(drainingLots);

    // Initialize sinks
    for (const idx of sinkIndices) {
        let initCost = PHI_SINK;
        if (sinkBias && biasWeight > 0 && sinkBias[idx] < PHI_LARGE) {
            initCost += biasWeight * sinkBias[idx];
        }
        phi[idx] = initCost;
        heap.push([initCost, idx]);
    }

    let reachable = 0;

    // Dijkstra main loop
    while (!heap.isEmpty()) {
        const [cost, idx] = heap.pop();
        if (visited[idx]) continue;
        visited[idx] = 1;
        reachable++;

        const neighbors = getNeighbors4(idx, N);

        for (const ni of neighbors) {
            // Skip impassable cells
            if (Kxx[ni] < K_THRESHOLD && Kyy[ni] < K_THRESHOLD) continue;

            // Skip draining lots (they're temporarily closed)
            if (regionMap[ni] === REGION_LOT) {
                const lotIdx = cellToLotIndex[ni];
                if (lotIdx >= 0 && drainingSet.has(lotIdx)) continue;
            }

            // PHARR field: prevent roads from getting phi VIA lots
            // This keeps lot phi valid for exit routing while roads use road-only paths
            if (label === 'PHARR' && regionMap[idx] === REGION_LOT && regionMap[ni] !== REGION_LOT) {
                continue;
            }

            // Capacity penalty for LOTS field
            let capacityPenalty = 1.0;
            if (label === 'LOTS' && regionMap[ni] === REGION_LOT) {
                const lotIdx = cellToLotIndex[ni];
                if (lotIdx >= 0 && lotCapacity[lotIdx] > 0) {
                    const util = lotMass[lotIdx] / lotCapacity[lotIdx];
                    // Cubic penalty: gentle at low utilization, steep near capacity
                    capacityPenalty = 1.0 + 4.0 * Math.pow(util, 3);
                }
            }

            const cellCostMult = cellCost ? cellCost[ni] : 1.0;
            const newCost = cost + edgeCost * capacityPenalty * cellCostMult;

            if (newCost < phi[ni]) {
                phi[ni] = newCost;
                heap.push([newCost, ni]);
            }
        }
    }

    return { phi, reachable };
}

/**
 * Build next-hop routing table from potential field.
 * 
 * For each cell, find the neighbor with lowest potential.
 * Particles use this to route without recomputing gradients.
 * 
 * @param {Float32Array} phi - Potential field
 * @param {number} N - Grid dimension
 * @param {number} N2 - Total cells
 * @param {Uint8Array} regionMap - Region type per cell
 * @param {string} label - Field label ('PHARR' or 'LOTS')
 * 
 * @returns {Int32Array} Next-hop index per cell (-1 if none)
 */
export function buildNextHop(phi, N, N2, regionMap, label) {
    const nextHop = new Int32Array(N2);
    nextHop.fill(-1);

    for (let idx = 0; idx < N2; idx++) {
        if (phi[idx] >= PHI_LARGE) continue;

        const neighbors = getNeighbors4(idx, N);
        let bestNh = -1;
        let bestPhi = phi[idx];

        // PHARR: non-lot cells cannot route through lots
        const skipLots = (label === 'PHARR' && regionMap[idx] !== REGION_LOT);

        for (const ni of neighbors) {
            if (skipLots && regionMap[ni] === REGION_LOT) continue;
            if (phi[ni] < bestPhi) {
                bestPhi = phi[ni];
                bestNh = ni;
            }
        }

        nextHop[idx] = bestNh;
    }

    return nextHop;
}

/**
 * Compute both potential field and next-hop table.
 * Convenience function for full routing rebuild.
 * 
 * @param {Object} config - Same as computePotential
 * @returns {{phi: Float32Array, nextHop: Int32Array, reachable: number}}
 */
export function computeRouting(config) {
    const { phi, reachable } = computePotential(config);
    const nextHop = buildNextHop(phi, config.N, config.N2, config.regionMap, config.label);
    return { phi, nextHop, reachable };
}
