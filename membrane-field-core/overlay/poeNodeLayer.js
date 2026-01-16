/**
 * POE Node Layer
 * ===============
 * Renders POE nodes + bleed rays for capacity-driven loss visualization.
 * 
 * SEMANTIC COMMITMENT:
 * Bleed rays represent equilibrium reallocation caused by congestion,
 * not a time-resolved queue profile.
 */

import { canonicalize, canonicalizeKeys, getDisplayName, CANONICAL_COORDINATES } from './poeCanonical.js';
import { latLonToWorld } from './bundleConsumer.js';

// =============================================================================
// CONSTANTS
// =============================================================================

// =============================================================================
// NODE CONSTANTS — Semantic Hierarchy
// =============================================================================
// State 1: Neutral POE — dim gray, static
// State 2: Bleeding POE — dimmer core + contracting halo
// State 3: Capturing POE — bright glow + inflation (must be unmistakable)
// =============================================================================

const NODE_BASE_RADIUS = 8;           // px at base λ
const NODE_RADIUS_SCALE = 4;          // multiplier for log(λ)

// State 1: Neutral
const NODE_NEUTRAL_OPACITY = 0.35;    // dim gray
const NODE_COLOR = '#999';            // neutral gray

// State 2: Bleeding (losing flows)
const NODE_LOSING_OPACITY = 0.15;     // very dim — collapse visual
const LOSING_HALO_COLOR = '#775555';  // muted dying ember
const LOSING_HALO_WIDTH = 1;          // thin, contracting feel

// State 3: Capturing (gaining flows) — MUST BE UNMISTAKABLE
const CAPTURE_GLOW_COLOR = '#aaddff'; // cool bright glow
const CAPTURE_GLOW_OPACITY = 0.7;     // prominent
const CAPTURE_RADIUS_BOOST = 1.4;     // noticeable inflation
const CAPTURE_PULSE_DURATION = 800;   // ms — longer pulse for visibility
const CAPTURE_GLOW_RING_WIDTH = 3;    // px — outer glow ring

// =============================================================================
// RAY CONSTANTS — Dual-Axis Stress Vectors
// =============================================================================
// AXIS 1 (Magnitude): Thickness ∝ kg_lost (linear, continuous)
// AXIS 2 (Cause): Texture — dashed for feasibility, solid for congestion
// =============================================================================

const RAY_MAX_THICKNESS = 12;         // px at origin for largest loss
const RAY_MIN_THICKNESS = 1.5;        // px at origin for smallest loss
const RAY_TAPER_RATIO = 0.08;         // end thickness = start * this (aggressive taper)
const RAY_TRAVEL_FRACTION = 0.55;     // stop at 55% — die before destination
const RAY_COLOR = '#888';             // desaturated gray
const RAY_JITTER_DEG = 3;             // degrees of angular offset
const RAY_STEM_LENGTH = 3;            // px solid stem at origin (anchor point)
const RAY_DASH_RATIO = 0.03;          // dash length as fraction of ray length

// Ghost Intention Trails (spec §7)
const GHOST_TRAIL_DURATION = 2000;    // ms - short-lived
const GHOST_TRAIL_OPACITY = 0.15;     // very faint
const GHOST_TRAIL_COLOR = '#666';     // neutral gray
const GHOST_TRAIL_LENGTH = 60;        // px - inward arrow length
const GHOST_TRAIL_COUNT = 4;          // number of radial lines

// =============================================================================
// POE NODE LAYER CLASS
// =============================================================================

export class POENodeLayer {
    constructor() {
        this.enabled = false;
        this.options = {
            nodes: true,
            bleedRays: true,
            ghostTrails: false,  // OFF by default
            textAnchor: false,   // OFF by default
            flipClassFilter: null,  // null = all, 'feasibility' or 'congestion' to filter
        };

        // Data (canonicalized)
        this.poeLocations = {};      // poe_id → { x, y } in world coords
        this.tippingSummary = {};    // poe_id → { flows_lost, kg_lost, destinations, ... }
        this.lambdaTotals = {};      // poe_id → λ_total (for pressure encoding)

        // Derived state
        this.capturedKg = {};        // poe_id → kg captured from other POEs
        this.capturePulseStart = {}; // poe_id → timestamp of first capture
        this.ghostTrailStart = {};   // poe_id → timestamp when ghost trail triggered
        this.primaryLoser = null;    // Single most significant losing POE (for text anchor)

        // Text anchor callback
        this.onShowTippingText = null;  // fn(poe, displayName) → show transient text
        this._textShown = false;         // Only show text once per enable cycle

        // Initialize immediately from Canonical SST
        this.initializeLocations();
    }

    /**
     * Initialize POE locations from the canonical Single Source of Truth.
     * STRICT: Use poeCanonical.js CANONICAL_COORDINATES only.
     */
    initializeLocations() {
        this.poeLocations = {};
        for (const [key, coords] of Object.entries(CANONICAL_COORDINATES)) {
            const canonical = canonicalize(key);
            if (coords.lat !== undefined && coords.lon !== undefined) {
                this.poeLocations[canonical] = latLonToWorld(coords.lat, coords.lon);
            }
        }
        console.log(`[POENodeLayer] Initialized ${Object.keys(this.poeLocations).length} POE nodes from Canonical SST`);
    }

    /**
     * Load tipping summary from bundle.
     * @param {Object} tippingSummary - { poe_id: { flows_lost, kg_lost, destinations, ... } }
     */
    setTippingSummary(tippingSummary) {
        this.tippingSummary = canonicalizeKeys(tippingSummary);
        this._computeCapturedKg();
        this._validateCoverage();
        this._checkLambdaAnomalies();
        console.log(`[POENodeLayer] Loaded tipping summary for ${Object.keys(this.tippingSummary).length} POEs`);
    }

    /**
     * Set λ totals for pressure encoding.
     * @param {Object} lambdaTotals - { poe_id: λ_total }
     */
    setLambdaTotals(lambdaTotals) {
        this.lambdaTotals = canonicalizeKeys(lambdaTotals);
    }

    /**
     * Compute captured kg per POE from destinations.
     * Also determines the PRIMARY LOSER (single most significant for text anchor).
     * @private
     */
    _computeCapturedKg() {
        this.capturedKg = {};
        this.primaryLoser = null;
        let maxKgLost = 0;

        for (const [loser, summary] of Object.entries(this.tippingSummary)) {
            // Track primary loser (highest kg_lost)
            const kgLost = summary.kg_lost || 0;
            if (kgLost > maxKgLost) {
                maxKgLost = kgLost;
                this.primaryLoser = loser;
            }

            // Compute captured kg
            if (!summary.destinations) continue;
            for (const [capturer, kg] of Object.entries(summary.destinations)) {
                const capturerCanon = canonicalize(capturer);
                this.capturedKg[capturerCanon] = (this.capturedKg[capturerCanon] || 0) + kg;
            }
        }

        if (this.primaryLoser) {
            console.log(`[POENodeLayer] Primary loser: ${this.primaryLoser} (${(maxKgLost / 1e9).toFixed(2)} Mt)`);
        }
    }

    /**
     * Validate location coverage: every key in tippingSummary must exist in poeLocations.
     * @private
     */
    _validateCoverage() {
        const missing = [];
        for (const poe of Object.keys(this.tippingSummary)) {
            if (!this.poeLocations[poe]) {
                missing.push(poe);
            }
        }
        if (missing.length > 0) {
            console.error(`[POENodeLayer] MISSING LOCATIONS: ${missing.join(', ')}`);
        }

        // Also check destinations
        for (const summary of Object.values(this.tippingSummary)) {
            if (!summary.destinations) continue;
            for (const capturer of Object.keys(summary.destinations)) {
                const capturerCanon = canonicalize(capturer);
                if (!this.poeLocations[capturerCanon] && !missing.includes(capturerCanon)) {
                    missing.push(capturerCanon);
                }
            }
        }
        if (missing.length > 0) {
            console.error(`[POENodeLayer] MISSING LOCATIONS (incl destinations): ${missing.join(', ')}`);
        }
    }

    /**
     * Check for λ=0 anomalies that indicate timing bugs.
     * @private
     */
    _checkLambdaAnomalies() {
        for (const [poe, summary] of Object.entries(this.tippingSummary)) {
            const flowsLost = summary.flows_lost || 0;
            const lambda = summary.first_flip_lambda_total || 0;
            if (flowsLost > 10000 && lambda < 0.01) {
                console.warn(`[POENodeLayer] TIMING BUG LIKELY: ${poe} flipped at λ≈0 with ${flowsLost} flows`);
            }
        }
    }

    /**
     * Enable/disable the overlay.
     * @param {boolean} enabled
     * @param {Object} [options] - { nodes, bleedRays, ghostTrails, textAnchor, flipClassFilter }
     */
    setEnabled(enabled, options = {}) {
        this.enabled = enabled;
        if (options.nodes !== undefined) this.options.nodes = options.nodes;
        if (options.bleedRays !== undefined) this.options.bleedRays = options.bleedRays;
        if (options.ghostTrails !== undefined) this.options.ghostTrails = options.ghostTrails;
        if (options.textAnchor !== undefined) this.options.textAnchor = options.textAnchor;
        if (options.flipClassFilter !== undefined) this.options.flipClassFilter = options.flipClassFilter;

        // Reset text anchor state on enable (allows re-showing on next enable)
        if (enabled) {
            this._textShown = false;
        }

        console.log(`[POENodeLayer] ${enabled ? 'Enabled' : 'Disabled'}`, this.options);
    }

    /**
     * Draw the overlay.
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} camera - { worldToScreen, zoom }
     * @param {number} now - Current timestamp (for animations)
     */
    draw(ctx, camera, now = performance.now()) {
        if (!this.enabled) return;
        if (!camera?.worldToScreen) return;

        ctx.save();

        // DEBUG DIAGNOSTICS (Once per session)
        if (!this._hasLoggedDraw) {
            const locCount = Object.keys(this.poeLocations).length;
            const sumCount = Object.keys(this.tippingSummary).length;
            console.log(`[POENodeLayer] DRAW CHECK: enabled=${this.enabled} nodes=${this.options.nodes} rays=${this.options.bleedRays}`);
            console.log(`[POENodeLayer] DATA: ${locCount} locations, ${sumCount} tipping summaries`);

            if (locCount > 0) {
                const sampleKey = Object.keys(this.poeLocations)[0];
                const world = this.poeLocations[sampleKey];
                const screen = camera.worldToScreen(world.x, world.y);
                console.log(`[POENodeLayer] COORD SAMPLE (${sampleKey}): World(${world.x.toFixed(0)}, ${world.y.toFixed(0)}) -> Screen(${screen.x.toFixed(0)}, ${screen.y.toFixed(0)})`);
            } else {
                console.error('[POENodeLayer] FATAL: No locations loaded!');
            }
            this._hasLoggedDraw = true;
        }

        // Draw ghost trails first (very faint, underneath everything)
        if (this.options.ghostTrails) {
            this._drawGhostTrails(ctx, camera, now);
        }

        // Draw bleed rays — the primary visual. Nodes removed.
        if (this.options.bleedRays) {
            this._drawBleedRays(ctx, camera);
        }

        // Trigger text anchor for primary loser (even without nodes)
        if (this.options.textAnchor && this.onShowTippingText && !this._textShown && this.primaryLoser) {
            this._textShown = true;
            this.onShowTippingText(this.primaryLoser, getDisplayName(this.primaryLoser));
        }

        ctx.restore();
    }

    /**
     * Draw POE nodes with semantic hierarchy.
     * State 1: Neutral — dim gray, static
     * State 2: Bleeding — dimmer core, contracting halo (dying)
     * State 3: Capturing — bright glow, inflated, unmistakable
     * @private
     */
    _drawNodes(ctx, camera, now) {
        for (const [poe, worldCoords] of Object.entries(this.poeLocations)) {
            const screen = camera.worldToScreen(worldCoords.x, worldCoords.y);
            const lambda = this.lambdaTotals[poe] || 0;
            const summary = this.tippingSummary[poe];
            const captured = this.capturedKg[poe] || 0;
            const isLosing = summary && summary.flows_lost > 0;
            const isCapturing = captured > 0 && !isLosing;

            // Base radius from λ pressure
            let radius = NODE_BASE_RADIUS + NODE_RADIUS_SCALE * Math.log10(1 + lambda);

            // Capture pulse timing
            if (isCapturing && !this.capturePulseStart[poe]) {
                this.capturePulseStart[poe] = now;
            }
            const pulseStart = this.capturePulseStart[poe];
            let pulsePhase = 0;
            if (pulseStart && now - pulseStart < CAPTURE_PULSE_DURATION) {
                pulsePhase = 1 - (now - pulseStart) / CAPTURE_PULSE_DURATION;
            }

            // ─────────────────────────────────────────────────────────────
            // STATE 3: CAPTURING — Must be unmistakable
            // ─────────────────────────────────────────────────────────────
            if (isCapturing) {
                // Inflation: noticeable size boost
                const captureBoost = 1 + 0.15 * Math.log10(1 + captured / 1e9);
                radius *= Math.max(CAPTURE_RADIUS_BOOST, captureBoost);

                // Outer glow ring (always visible for capturers)
                ctx.beginPath();
                ctx.arc(screen.x, screen.y, radius + CAPTURE_GLOW_RING_WIDTH + 2, 0, Math.PI * 2);
                ctx.strokeStyle = CAPTURE_GLOW_COLOR;
                ctx.lineWidth = CAPTURE_GLOW_RING_WIDTH + pulsePhase * 2;
                ctx.globalAlpha = 0.4 + pulsePhase * 0.3;
                ctx.stroke();

                // Bright core
                ctx.beginPath();
                ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = CAPTURE_GLOW_COLOR;
                ctx.globalAlpha = CAPTURE_GLOW_OPACITY;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
            // ─────────────────────────────────────────────────────────────
            // STATE 2: BLEEDING — Dim, collapsing, dying
            // ─────────────────────────────────────────────────────────────
            else if (isLosing) {
                // Dim core (nearly invisible)
                ctx.beginPath();
                ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = NODE_COLOR;
                ctx.globalAlpha = NODE_LOSING_OPACITY;
                ctx.fill();

                // Contracting halo — thin dying ring
                ctx.beginPath();
                ctx.arc(screen.x, screen.y, radius + 2, 0, Math.PI * 2);
                ctx.strokeStyle = LOSING_HALO_COLOR;
                ctx.lineWidth = LOSING_HALO_WIDTH;
                ctx.globalAlpha = 0.4;
                ctx.stroke();
                ctx.globalAlpha = 1;

                // Trigger ghost trail on first tipping (all losers)
                if (!summary._tippingTriggered) {
                    summary._tippingTriggered = true;
                    this.ghostTrailStart[poe] = now;
                }

                // Text anchor: ONLY for the PRIMARY LOSER (single most significant)
                // Spec §8: "One fixed-position line of text. Appears once per major POE tipping."
                if (this.options.textAnchor && this.onShowTippingText && !this._textShown) {
                    if (poe === this.primaryLoser) {
                        this._textShown = true;
                        this.onShowTippingText(poe, getDisplayName(poe));
                    }
                }
            }
            // ─────────────────────────────────────────────────────────────
            // STATE 1: NEUTRAL — Dim gray, static, background
            // ─────────────────────────────────────────────────────────────
            else {
                ctx.beginPath();
                ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = NODE_COLOR;
                ctx.globalAlpha = NODE_NEUTRAL_OPACITY;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        }
    }

    /**
     * Draw bleed rays as DUAL-AXIS STRESS VECTORS.
     * AXIS 1 (Magnitude): Thickness ∝ kg_lost (linear, continuous)
     * AXIS 2 (Cause): Texture — dashed for feasibility, solid for congestion
     *
     * Visual properties:
     * - Solid stem at origin (anchor point)
     * - Aggressive taper (thick→thin)
     * - Die at 55% (stress vector, not route)
     * - 3° angular jitter
     * @private
     */
    _drawBleedRays(ctx, camera) {
        // First pass: find max kg lost for linear normalization
        let maxKgLost = 0;
        for (const summary of Object.values(this.tippingSummary)) {
            if (!summary.destinations) continue;
            for (const kg of Object.values(summary.destinations)) {
                if (kg > maxKgLost) maxKgLost = kg;
            }
        }
        if (maxKgLost === 0) return;  // No rays to draw

        // Seeded jitter for consistent per-pair offsets
        let jitterSeed = 0;

        for (const [loser, summary] of Object.entries(this.tippingSummary)) {
            if (!summary.destinations) continue;
            const loserCoords = this.poeLocations[loser];
            if (!loserCoords) continue;

            const loserScreen = camera.worldToScreen(loserCoords.x, loserCoords.y);

            // Calculate Split Shares
            const totalLost = summary.kg_lost || 1;
            const fMass = summary.kg_lost_feasibility || 0;
            const cMass = summary.kg_lost_congestion || 0;

            // Normalize to shares (defaults to 100% congestion if legacy data)
            let fShare = 0;
            let cShare = 1;

            if (fMass + cMass > 0) {
                const splitTotal = fMass + cMass;
                fShare = fMass / splitTotal;
                cShare = cMass / splitTotal;
            } else {
                // Fallback to dominant class if detailed mass missing
                if (summary.flip_class === 'feasibility') {
                    fShare = 1; cShare = 0;
                } else {
                    fShare = 0; cShare = 1;
                }
            }

            // Filter by flip class if specified (still respects the filter)
            // If filtering 'feasibility', we only draw the feasibility component
            if (this.options.flipClassFilter === 'feasibility') cShare = 0;
            if (this.options.flipClassFilter === 'congestion') fShare = 0;

            for (const [capturer, kgCaptured] of Object.entries(summary.destinations)) {
                const capturerCanon = canonicalize(capturer);
                const capturerCoords = this.poeLocations[capturerCanon];
                if (!capturerCoords) {
                    console.warn(`[BleedRay] No coords for capturer: ${capturer} → ${capturerCanon}`);
                    continue;
                }

                const capturerScreen = camera.worldToScreen(capturerCoords.x, capturerCoords.y);

                // Base Vector (Loser -> Capturer)
                const dx = capturerScreen.x - loserScreen.x;
                const dy = capturerScreen.y - loserScreen.y;
                const fullLen = Math.sqrt(dx * dx + dy * dy);
                if (fullLen < 10) {
                    continue;  // Too short to render
                }

                const baseAngle = Math.atan2(dy, dx);

                // Jitter Base (Deterministic)
                jitterSeed++;
                const jitterRad = ((jitterSeed * 7) % 17 - 8) * (RAY_JITTER_DEG * Math.PI / 180);

                // ─────────────────────────────────────────────────────────────
                // Helper: Draw Single Ray Component
                // ─────────────────────────────────────────────────────────────
                const drawRayComponent = (mass, isDashed, angleOffset) => {
                    if (mass <= 0) return;

                    const rayAngle = baseAngle + jitterRad + angleOffset;

                    // Ray dies at 55% of the way
                    const rayLen = fullLen * RAY_TRAVEL_FRACTION;

                    // AXIS 1: Thickness ∝ mass
                    const proportion = mass / maxKgLost;
                    const startThickness = RAY_MIN_THICKNESS + (RAY_MAX_THICKNESS - RAY_MIN_THICKNESS) * proportion;
                    const endThickness = startThickness * RAY_TAPER_RATIO;

                    // Dash pattern
                    const dashLen = Math.max(4, rayLen * RAY_DASH_RATIO);
                    const gapLen = dashLen * 0.6;

                    // 1. Draw Stem (Solid Anchor)
                    ctx.setLineDash([]);
                    ctx.beginPath();
                    ctx.moveTo(loserScreen.x, loserScreen.y);
                    ctx.lineTo(
                        loserScreen.x + Math.cos(rayAngle) * RAY_STEM_LENGTH,
                        loserScreen.y + Math.sin(rayAngle) * RAY_STEM_LENGTH
                    );
                    ctx.strokeStyle = RAY_COLOR;
                    ctx.lineWidth = startThickness;
                    ctx.globalAlpha = 0.8;
                    ctx.stroke();

                    // 2. Draw Body
                    if (isDashed) {
                        ctx.setLineDash([dashLen, gapLen]);
                    } else {
                        ctx.setLineDash([]);
                    }

                    const segments = 10;
                    const stemFraction = RAY_STEM_LENGTH / rayLen;

                    for (let i = 0; i < segments; i++) {
                        const t0 = stemFraction + (1 - stemFraction) * (i / segments);
                        const t1 = stemFraction + (1 - stemFraction) * ((i + 1) / segments);

                        const x0 = loserScreen.x + Math.cos(rayAngle) * rayLen * t0;
                        const y0 = loserScreen.y + Math.sin(rayAngle) * rayLen * t0;
                        const x1 = loserScreen.x + Math.cos(rayAngle) * rayLen * t1;
                        const y1 = loserScreen.y + Math.sin(rayAngle) * rayLen * t1;

                        const taperT = t0 * t0;
                        const segThickness = startThickness * (1 - taperT) + endThickness * taperT;
                        const segAlpha = 0.7 * (1 - t0 * 0.6); // Fade out

                        ctx.beginPath();
                        ctx.moveTo(x0, y0);
                        ctx.lineTo(x1, y1);
                        ctx.lineWidth = Math.max(0.5, segThickness);
                        ctx.globalAlpha = segAlpha;
                        ctx.stroke();
                    }
                    ctx.globalAlpha = 1;
                    ctx.setLineDash([]);
                };

                // ─────────────────────────────────────────────────────────────
                // Draw Two Rays (if both exist)
                // ─────────────────────────────────────────────────────────────
                // Calculate masses for this strand
                const fKg = kgCaptured * fShare;
                const cKg = kgCaptured * cShare;

                // Offset strategy:
                // If only one exists -> 0 offset
                // If both exist -> separation of ~2 degrees
                let fOffset = 0;
                let cOffset = 0;

                if (fKg > 0 && cKg > 0) {
                    fOffset = -0.02; // Roughly -1 deg
                    cOffset = 0.02; // Roughly +1 deg
                }

                // Draw Congestion (Solid)
                drawRayComponent(cKg, false, cOffset);

                // Draw Feasibility (Dashed)
                drawRayComponent(fKg, true, fOffset);
            }
        }
    }

    /**
     * Draw ghost intention trails for tipping POEs.
     * Spec §7: Very faint, short-lived, appear only at first tipping.
     * Shows geometric (pre-congestion) intention as inward-pointing lines.
     * @private
     */
    _drawGhostTrails(ctx, camera, now) {
        for (const [poe, startTime] of Object.entries(this.ghostTrailStart)) {
            const elapsed = now - startTime;
            if (elapsed > GHOST_TRAIL_DURATION) continue;  // Expired

            const worldCoords = this.poeLocations[poe];
            if (!worldCoords) continue;

            const screen = camera.worldToScreen(worldCoords.x, worldCoords.y);

            // Fade out over duration
            const fadeProgress = elapsed / GHOST_TRAIL_DURATION;
            const alpha = GHOST_TRAIL_OPACITY * (1 - fadeProgress);

            // Draw radial lines pointing inward (representing traffic that WANTED to cross here)
            // Lines come from outside, pointing toward the POE
            ctx.strokeStyle = GHOST_TRAIL_COLOR;
            ctx.lineWidth = 1;
            ctx.globalAlpha = alpha;

            for (let i = 0; i < GHOST_TRAIL_COUNT; i++) {
                // Evenly distributed angles, offset by 45° to avoid cardinal directions
                const angle = (i / GHOST_TRAIL_COUNT) * Math.PI * 2 + Math.PI / 4;

                // Start point (outside the POE)
                const startX = screen.x + Math.cos(angle) * GHOST_TRAIL_LENGTH;
                const startY = screen.y + Math.sin(angle) * GHOST_TRAIL_LENGTH;

                // End point (at POE center, but stop short to not overlap node)
                const endX = screen.x + Math.cos(angle) * 12;
                const endY = screen.y + Math.sin(angle) * 12;

                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(endX, endY);
                ctx.stroke();

                // Small arrowhead pointing inward
                const arrowSize = 4;
                const arrowAngle = angle + Math.PI;  // Pointing inward
                ctx.beginPath();
                ctx.moveTo(endX, endY);
                ctx.lineTo(
                    endX - arrowSize * Math.cos(arrowAngle - Math.PI / 6),
                    endY - arrowSize * Math.sin(arrowAngle - Math.PI / 6)
                );
                ctx.moveTo(endX, endY);
                ctx.lineTo(
                    endX - arrowSize * Math.cos(arrowAngle + Math.PI / 6),
                    endY - arrowSize * Math.sin(arrowAngle + Math.PI / 6)
                );
                ctx.stroke();
            }

            ctx.globalAlpha = 1;
        }
    }
}
