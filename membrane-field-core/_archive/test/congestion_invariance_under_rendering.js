/**
 * Congestion invariance helper.
 *
 * Usage (pseudo):
 * const { assertCongestionInvariance } = require('./congestion_invariance_under_rendering');
 * assertCongestionInvariance({
 *   withParticles: snapshotA,
 *   withoutParticles: snapshotB,
 *   tolerance: 1e-6,
 * });
 *
 * Snapshots should include:
 * - maxRho: maximum ρ over grid (kg/cell)
 * - backlog: backlog mass near PHARR (kg)
 * - drainRate: drained kg/s over the window
 * - avgSpeed: representative average speed (m/s) derived from field, not particles
 *
 * The test asserts that rendering (particles on/off) does not change congestion-driven physics.
 */
function assertClose(label, a, b, tol) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error(`Non-finite value for ${label}: ${a}, ${b}`);
    }
    const delta = Math.abs(a - b);
    if (delta > tol) {
        throw new Error(`Congestion invariance failed for ${label}: ${a} vs ${b} (tol=${tol})`);
    }
}

function assertCongestionInvariance({ withParticles, withoutParticles, tolerance = 1e-6 }) {
    if (!withParticles || !withoutParticles) {
        throw new Error('Both snapshots are required');
    }

    assertClose('maxRho', withParticles.maxRho, withoutParticles.maxRho, tolerance);
    assertClose('backlog', withParticles.backlog, withoutParticles.backlog, tolerance);
    assertClose('drainRate', withParticles.drainRate, withoutParticles.drainRate, tolerance);
    assertClose('avgSpeed', withParticles.avgSpeed, withoutParticles.avgSpeed, tolerance);
}

module.exports = {
    assertCongestionInvariance,
};

