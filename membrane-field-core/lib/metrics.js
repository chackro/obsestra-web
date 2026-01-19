// ═══════════════════════════════════════════════════════════════════════════════
// METRICS — Statistics computation for service time and throughput
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// Pure statistics functions. Data collection stays in the main module.
//

/**
 * @typedef {Object} PercentileStats
 * @property {number} mean - Arithmetic mean
 * @property {number} p50 - 50th percentile (median)
 * @property {number} p90 - 90th percentile
 */

/**
 * @typedef {Object} ServiceTimeStats
 * @property {number} count - Number of samples
 * @property {PercentileStats} actual - Actual service time stats
 * @property {PercentileStats} expected - Expected service time stats
 */

/**
 * Compute mean/p50/p90 for service time arrays.
 * Returns stats in seconds.
 * @param {number[]} actualTimes - Array of actual service times (seconds)
 * @param {number[]} expectedTimes - Array of expected service times (seconds)
 * @returns {ServiceTimeStats} Statistics object
 */
export function computeServiceTimeStats(actualTimes, expectedTimes) {
    const n = actualTimes.length;
    if (n === 0) {
        return { count: 0, actual: { mean: 0, p50: 0, p90: 0 }, expected: { mean: 0, p50: 0, p90: 0 } };
    }

    const sortedActual = [...actualTimes].sort((a, b) => a - b);
    const sortedExpected = [...expectedTimes].sort((a, b) => a - b);

    const meanActual = actualTimes.reduce((a, b) => a + b, 0) / n;
    const meanExpected = expectedTimes.reduce((a, b) => a + b, 0) / n;

    const p50Idx = Math.floor(n * 0.5);
    const p90Idx = Math.floor(n * 0.9);

    return {
        count: n,
        actual: {
            mean: meanActual,
            p50: sortedActual[p50Idx],
            p90: sortedActual[p90Idx],
        },
        expected: {
            mean: meanExpected,
            p50: sortedExpected[p50Idx],
            p90: sortedExpected[p90Idx],
        },
    };
}
