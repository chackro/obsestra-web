// ═══════════════════════════════════════════════════════════════════════════════
// ROUTING WORKER — Universal (Web Worker + Node.js worker_threads)
// ═══════════════════════════════════════════════════════════════════════════════

// Environment detection
const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
let parentPort = null;

if (isNode) {
    // Node.js worker_threads
    const { parentPort: pp } = require('worker_threads');
    parentPort = pp;
}

class MinHeap {
    constructor() { this.data = []; }
    push(item) {
        this.data.push(item);
        let i = this.data.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.data[parent][0] <= this.data[i][0]) break;
            [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
            i = parent;
        }
    }
    pop() {
        if (this.data.length === 0) return null;
        const result = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            let i = 0;
            while (true) {
                let smallest = i;
                const left = 2 * i + 1, right = 2 * i + 2;
                if (left < this.data.length && this.data[left][0] < this.data[smallest][0]) smallest = left;
                if (right < this.data.length && this.data[right][0] < this.data[smallest][0]) smallest = right;
                if (smallest === i) break;
                [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
                i = smallest;
            }
        }
        return result;
    }
    isEmpty() { return this.data.length === 0; }
}

const PHI_LARGE = 1e9;
const PHI_SINK = 0.01;
const K_THRESHOLD = 0.01;
const REGION_LOT = 2;

function computePotential(config) {
    const { sinkIndices, N, N2, edgeCost, Kxx, Kyy, regionMap, cellToLotIndex,
            drainingLots, lotCapacity, lotMass, label, sinkBias, biasWeight } = config;

    const phi = new Float32Array(N2);
    phi.fill(PHI_LARGE);

    if (sinkIndices.length === 0) return { phi, reachable: 0 };

    const heap = new MinHeap();
    const visited = new Uint8Array(N2);
    const drainingSet = new Set(drainingLots);

    for (const idx of sinkIndices) {
        let initCost = PHI_SINK;
        if (sinkBias && biasWeight > 0 && sinkBias[idx] < PHI_LARGE) {
            initCost += biasWeight * sinkBias[idx];
        }
        phi[idx] = initCost;
        heap.push([initCost, idx]);
    }

    let reachable = 0;

    while (!heap.isEmpty()) {
        const [cost, idx] = heap.pop();
        if (visited[idx]) continue;
        visited[idx] = 1;
        reachable++;

        const x = idx % N;
        const y = Math.floor(idx / N);
        const neighbors = [];
        if (x > 0) neighbors.push(idx - 1);
        if (x < N - 1) neighbors.push(idx + 1);
        if (y > 0) neighbors.push(idx - N);
        if (y < N - 1) neighbors.push(idx + N);

        for (const ni of neighbors) {
            if (Kxx[ni] < K_THRESHOLD && Kyy[ni] < K_THRESHOLD) continue;

            if (regionMap[ni] === REGION_LOT) {
                const lotIdx = cellToLotIndex[ni];
                if (lotIdx >= 0 && drainingSet.has(lotIdx)) continue;
            }

            // PHARR: prevent roads from getting phi VIA lots (keeps lot phi valid for exit)
            // Block LOT→ROAD propagation so roads use road-only paths, but lots still get phi from roads
            if (label === 'PHARR' && regionMap[idx] === REGION_LOT && regionMap[ni] !== REGION_LOT) continue;

            let capacityPenalty = 1.0;
            if (label === 'LOTS' && regionMap[ni] === REGION_LOT) {
                const lotIdx = cellToLotIndex[ni];
                if (lotIdx >= 0 && lotCapacity[lotIdx] > 0) {
                    const util = lotMass[lotIdx] / lotCapacity[lotIdx];
                    capacityPenalty = 1.0 + 4.0 * Math.pow(util, 3);
                }
            }

            const newCost = cost + edgeCost * capacityPenalty;
            if (newCost < phi[ni]) {
                phi[ni] = newCost;
                heap.push([newCost, ni]);
            }
        }
    }

    return { phi, reachable };
}

function buildNextHop(phi, N, N2, regionMap, label) {
    const nextHop = new Int32Array(N2);
    nextHop.fill(-1);

    for (let idx = 0; idx < N2; idx++) {
        if (phi[idx] >= PHI_LARGE) continue;

        const x = idx % N;
        const y = Math.floor(idx / N);
        const neighbors = [];
        if (x > 0) neighbors.push(idx - 1);
        if (x < N - 1) neighbors.push(idx + 1);
        if (y > 0) neighbors.push(idx - N);
        if (y < N - 1) neighbors.push(idx + N);

        let bestNh = -1;
        let bestPhi = phi[idx];

        // PHARR: non-lot cells cannot pick lot neighbors
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

function handleMessage(data) {
    const { id, token, cmd, config } = data;

    if (cmd === 'computeRouting') {
        // Reconstruct TypedArrays from transferred buffers
        config.Kxx = new Float32Array(config.Kxx);
        config.Kyy = new Float32Array(config.Kyy);
        config.regionMap = new Uint8Array(config.regionMap);
        config.cellToLotIndex = new Int16Array(config.cellToLotIndex);
        config.lotCapacity = new Float32Array(config.lotCapacity);
        config.lotMass = new Float32Array(config.lotMass);
        if (config.sinkBias) config.sinkBias = new Float32Array(config.sinkBias);

        const { phi, reachable } = computePotential(config);
        const nextHop = buildNextHop(phi, config.N, config.N2, config.regionMap, config.label);

        return { id, token, phi: phi.buffer, nextHop: nextHop.buffer, reachable };
    }
    return null;
}

// Wire up message handling for both environments
if (isNode && parentPort) {
    // Node.js worker_threads
    parentPort.on('message', (data) => {
        const result = handleMessage(data);
        if (result) {
            parentPort.postMessage(result, [result.phi, result.nextHop]);
        }
    });
} else if (typeof self !== 'undefined' && typeof self.onmessage !== 'undefined') {
    // Browser Web Worker
    self.onmessage = function(e) {
        const result = handleMessage(e.data);
        if (result) {
            self.postMessage(result, [result.phi, result.nextHop]);
        }
    };
}
