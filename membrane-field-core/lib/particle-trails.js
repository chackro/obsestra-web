// ═══════════════════════════════════════════════════════════════════════════════
// PARTICLE TRAILS — Motion visualization for replay mode
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from reynosaOverlay_v2.js
// At 168x replay speed, particles move too fast to see. Trails show motion by
// keeping the last N positions of each particle and rendering them as fading streaks.
//

const TRAIL_LENGTH = 8;                            // Number of past positions to keep
const _particleTrails = new Map();                 // particle.id → [{x, y}, ...]  (ring buffer)
let _trailsEnabled = false;                        // Whether to render trails

/**
 * Enable or disable particle trails for replay mode.
 * @returns {boolean} Whether dirty flag should be set
 */
export function setTrailsEnabled(enabled) {
    _trailsEnabled = enabled;
    if (!enabled) {
        _particleTrails.clear();
    }
    return true;  // Signal caller to set dirty flag
}

/**
 * Get whether trails are currently enabled.
 * @returns {boolean}
 */
export function getTrailsEnabled() {
    return _trailsEnabled;
}

/**
 * Get the particle trails map (for rendering).
 * @returns {Map<number, Array<{x: number, y: number}>>}
 */
export function getParticleTrails() {
    return _particleTrails;
}

/**
 * @typedef {Object} TrailsContext
 * @property {boolean} replayMode - Whether in replay mode
 * @property {number} activeParticleCount - Number of active particles
 * @property {Array} activeParticles - Active particle array
 * @property {Object} STATE - State enum with LOT, PARK states
 */

/**
 * Update trail history for all active particles.
 * Should be called each tick during REPLAY_MODE before position updates.
 * @param {TrailsContext} ctx - Trails context
 */
export function updateParticleTrails(ctx) {
    if (!_trailsEnabled || !ctx.replayMode) return;

    for (let i = 0; i < ctx.activeParticleCount; i++) {
        const p = ctx.activeParticles[i];

        // Skip particles in lots (they don't move, no trail needed)
        if (p.state === ctx.STATE.LOT || p.state === ctx.STATE.PARK) continue;

        let trail = _particleTrails.get(p.id);
        if (!trail) {
            trail = [];
            _particleTrails.set(p.id, trail);
        }

        // Add current position to trail
        trail.push({ x: p.x, y: p.y });

        // Keep only last TRAIL_LENGTH positions
        if (trail.length > TRAIL_LENGTH) {
            trail.shift();
        }
    }
}

/**
 * Clear all particle trails.
 * Call when replay ends or trails are disabled.
 * @returns {boolean} Whether dirty flag should be set
 */
export function clearParticleTrails() {
    _particleTrails.clear();
    return true;  // Signal caller to set dirty flag
}

/**
 * Remove trail for a specific particle (call when particle exits).
 * @param {number} particleId - Particle ID to remove
 */
export function removeParticleTrail(particleId) {
    _particleTrails.delete(particleId);
}
