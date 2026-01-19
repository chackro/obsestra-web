// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING WORKER — Thin wrapper for background routing computation
// ═══════════════════════════════════════════════════════════════════════════════
//
// This worker runs Dijkstra off the main thread to avoid blocking rendering.
// All logic lives in routing/potential.js — this file just handles messaging.
//
// USAGE (browser):
//   const worker = new Worker('engine/routingWorker.js', { type: 'module' });
//
// USAGE (Node.js):
//   const { Worker } = require('worker_threads');
//   const worker = new Worker('./engine/routingWorker.js');
//
// ═══════════════════════════════════════════════════════════════════════════════

import { computePotential, buildNextHop } from '../routing/potential.js';

// Environment detection
const isNode = typeof process !== 'undefined' && process.versions?.node;

let parentPort = null;
if (isNode) {
    const { parentPort: pp } = await import('worker_threads');
    parentPort = pp;
}

/**
 * Handle incoming routing request.
 * Reconstructs TypedArrays from transferred buffers, runs Dijkstra, returns results.
 */
function handleMessage(data) {
    const { id, token, cmd, config } = data;

    if (cmd !== 'computeRouting') {
        return null;
    }

    // Reconstruct TypedArrays from transferred ArrayBuffers
    config.Kxx = new Float32Array(config.Kxx);
    config.Kyy = new Float32Array(config.Kyy);
    config.regionMap = new Uint8Array(config.regionMap);
    config.cellToLotIndex = new Int16Array(config.cellToLotIndex);
    config.lotCapacity = new Float32Array(config.lotCapacity);
    config.lotMass = new Float32Array(config.lotMass);
    if (config.sinkBias) config.sinkBias = new Float32Array(config.sinkBias);
    if (config.cellCost) config.cellCost = new Float32Array(config.cellCost);

    // Run the actual computation
    const { phi, reachable } = computePotential(config);
    const nextHop = buildNextHop(phi, config.N, config.N2, config.regionMap, config.label);

    // Return results with transferable buffers
    return {
        id,
        token,
        phi: phi.buffer,
        nextHop: nextHop.buffer,
        reachable
    };
}

// Wire up message handling
if (isNode && parentPort) {
    // Node.js worker_threads
    parentPort.on('message', (data) => {
        const result = handleMessage(data);
        if (result) {
            parentPort.postMessage(result, [result.phi, result.nextHop]);
        }
    });
} else if (typeof self !== 'undefined') {
    // Browser Web Worker (module mode)
    self.onmessage = (e) => {
        const result = handleMessage(e.data);
        if (result) {
            self.postMessage(result, [result.phi, result.nextHop]);
        }
    };
}
