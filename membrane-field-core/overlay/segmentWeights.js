// ═══════════════════════════════════════════════════════════════════════════════
// SEGMENT WEIGHTS
// Extracts and normalizes segment load weights from CIEN bundle.
//
// CIEN decides routing and shares. Field never re-routes.
// This module is READ-ONLY extraction of CIEN's authoritative weights.
//
// Weights are normalized to [0,1] for conductance scaling.
// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────────
// CONSTANTS / HELPERS
// ───────────────────────────────────────────────────────────────────────────────

// Weight exponent: 1.0 = linear (CIEN truth), >1 = exaggerate hierarchy
// CIEN weights are authoritative - show them as they are
const WEIGHT_EXPONENT = 1.0;

function listPoeKeys(segmentLoad, poeFilter) {
    if (!segmentLoad) return [];
    if (poeFilter === null || poeFilter === undefined) return Object.keys(segmentLoad);
    if (typeof poeFilter === 'string') return segmentLoad[poeFilter] ? [poeFilter] : [];
    if (Array.isArray(poeFilter)) return poeFilter.filter(k => segmentLoad[k]);
    return [];
}

// ───────────────────────────────────────────────────────────────────────────────
// WEIGHT EXTRACTION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Extract segment weights from bundle for a specific HS2 code.
 * Weights are normalized to [0,1] where 1 = max load segment.
 *
 * @param {import('../contracts/ReynosaOverlayBundle.js').ReynosaOverlayBundle} bundle
 * @param {string} hs2Code - HS2 code (e.g., "07", "85")
 * @returns {Map<string, number>} segment_id → weight [0,1]
 */
export function extractWeightsByHs2(bundle, hs2Code, poeFilter = null) {
    const weights = new Map();

    const segmentLoad = bundle.segment_load_kg_by_poe_hs2;
    if (!segmentLoad) {
        return weights;
    }

    // Aggregate across POEs (or a single POE filter)
    const totals = new Map();
    const poeKeys = listPoeKeys(segmentLoad, poeFilter);
    for (const poeKey of poeKeys) {
        const poeData = segmentLoad[poeKey];
        const hs2Data = poeData?.[hs2Code];
        if (!hs2Data) continue;
        for (const segId in hs2Data) {
            totals.set(segId, (totals.get(segId) || 0) + hs2Data[segId]);
        }
    }
    if (totals.size === 0) return weights;

    // Find max for normalization
    let maxKg = 0;
    for (const kg of totals.values()) {
        if (kg > maxKg) maxKg = kg;
    }

    if (maxKg === 0) return weights;

    // Normalize with power-law contrast
    for (const [segId, kg] of totals) {
        weights.set(segId, Math.pow(kg / maxKg, WEIGHT_EXPONENT));
    }

    return weights;
}

/**
 * Extract aggregate segment weights (sum across all HS2 codes).
 * Weights are normalized to [0,1] where 1 = max load segment.
 *
 * @param {import('../contracts/ReynosaOverlayBundle.js').ReynosaOverlayBundle} bundle
 * @returns {Map<string, number>} segment_id → weight [0,1]
 */
export function extractAggregateWeights(bundle, poeFilter = null) {
    const totals = new Map();

    const segmentLoad = bundle.segment_load_kg_by_poe_hs2;
    if (!segmentLoad) {
        return totals;
    }

    const poeKeys = listPoeKeys(segmentLoad, poeFilter);
    for (const poeKey of poeKeys) {
        const poeData = segmentLoad[poeKey];
        if (!poeData) continue;
        // Sum across all HS2 codes
        for (const hs2Code in poeData) {
            const hs2Data = poeData[hs2Code];
            for (const segId in hs2Data) {
                const prev = totals.get(segId) || 0;
                totals.set(segId, prev + hs2Data[segId]);
            }
        }
    }

    // Find max for normalization
    let maxKg = 0;
    for (const kg of totals.values()) {
        if (kg > maxKg) maxKg = kg;
    }

    if (maxKg === 0) return new Map();

    // Normalize with power-law contrast
    const weights = new Map();
    for (const [segId, kg] of totals) {
        weights.set(segId, Math.pow(kg / maxKg, WEIGHT_EXPONENT));
    }

    return weights;
}

/**
 * Extract weights with optional HS2 filter.
 * If hs2Filter is null/undefined, returns aggregate weights.
 * If hs2Filter is a string, returns weights for that HS2 only.
 * If hs2Filter is an array, returns aggregate of those HS2 codes.
 *
 * @param {import('../contracts/ReynosaOverlayBundle.js').ReynosaOverlayBundle} bundle
 * @param {string|string[]|null} [hs2Filter] - HS2 code(s) to filter by
 * @returns {Map<string, number>} segment_id → weight [0,1]
 */
export function extractWeights(bundle, hs2Filter = null, poeFilter = null) {
    if (hs2Filter === null || hs2Filter === undefined) {
        return extractAggregateWeights(bundle, poeFilter);
    }

    if (typeof hs2Filter === 'string') {
        return extractWeightsByHs2(bundle, hs2Filter, poeFilter);
    }

    if (Array.isArray(hs2Filter)) {
        // Aggregate specified HS2 codes
        const totals = new Map();
        const segmentLoad = bundle.segment_load_kg_by_poe_hs2;

        if (!segmentLoad) {
            return totals;
        }

        const poeKeys = listPoeKeys(segmentLoad, poeFilter);
        for (const poeKey of poeKeys) {
            const poeData = segmentLoad[poeKey];
            if (!poeData) continue;
            for (const hs2Code of hs2Filter) {
                const hs2Data = poeData[hs2Code];
                if (!hs2Data) continue;
                for (const segId in hs2Data) {
                    const prev = totals.get(segId) || 0;
                    totals.set(segId, prev + hs2Data[segId]);
                }
            }
        }

        // Find max for normalization
        let maxKg = 0;
        for (const kg of totals.values()) {
            if (kg > maxKg) maxKg = kg;
        }

        if (maxKg === 0) return new Map();

        // Normalize with power-law contrast
        const weights = new Map();
        for (const [segId, kg] of totals) {
            weights.set(segId, Math.pow(kg / maxKg, WEIGHT_EXPONENT));
        }

        return weights;
    }

    return new Map();
}

// ───────────────────────────────────────────────────────────────────────────────
// WEIGHT MAP CACHE
// ───────────────────────────────────────────────────────────────────────────────

let _baselineWeights = null;
let _interserranaWeights = null;
let _currentHs2Filter = null;

/**
 * Load weight maps from scenario pair.
 * Call this after loadScenarioPair().
 *
 * @param {import('../contracts/ReynosaOverlayBundle.js').ReynosaOverlayBundle} baselineBundle
 * @param {import('../contracts/ReynosaOverlayBundle.js').ReynosaOverlayBundle} interserranaBundle
 * @param {string|string[]|null} [hs2Filter] - HS2 code(s) to filter by
 */
export function loadWeightMaps(baselineBundle, interserranaBundle, options = null) {
    const hs2Filter = options?.hs2Filter ?? null;
    const poeFilter = options?.poeFilter ?? null;
    _baselineWeights = extractWeights(baselineBundle, hs2Filter, poeFilter);
    _interserranaWeights = extractWeights(interserranaBundle, hs2Filter, poeFilter);
    _currentHs2Filter = hs2Filter;

    console.log('[SegmentWeights] Loaded:', {
        baseline: _baselineWeights.size,
        interserrana: _interserranaWeights.size,
        hs2Filter: hs2Filter,
        poeFilter: poeFilter,
    });
}

/**
 * Get baseline weight for a segment.
 * @param {string} segmentId
 * @returns {number} weight [0,1], 0 if not found
 */
export function getBaselineWeight(segmentId) {
    return _baselineWeights?.get(segmentId) || 0;
}

/**
 * Get interserrana weight for a segment.
 * @param {string} segmentId
 * @returns {number} weight [0,1], 0 if not found
 */
export function getInterserranaWeight(segmentId) {
    return _interserranaWeights?.get(segmentId) || 0;
}

/**
 * Get interpolated weight for a segment at given alpha.
 * weight(α) = baseline + α * (interserrana - baseline)
 *
 * @param {string} segmentId
 * @param {number} alpha - interpolation factor [0,1]
 * @returns {number} weight [0,1]
 */
export function getInterpolatedWeight(segmentId, alpha) {
    const wA = getBaselineWeight(segmentId);
    const wB = getInterserranaWeight(segmentId);
    return wA + alpha * (wB - wA);
}

/**
 * Check if weight maps are loaded.
 */
export function hasWeightMaps() {
    return _baselineWeights !== null && _interserranaWeights !== null;
}

/**
 * Get current HS2 filter.
 */
export function getCurrentHs2Filter() {
    return _currentHs2Filter;
}

/**
 * Clear weight maps (for reset/detach).
 */
export function clearWeightMaps() {
    _baselineWeights = null;
    _interserranaWeights = null;
    _currentHs2Filter = null;
}

/**
 * Get set of segment IDs that carry traffic for a specific POE.
 * @param {object} bundle
 * @param {string} poe - POE key (e.g., "PHARR")
 * @returns {Set<string>}
 */
export function getSegmentIdsForPoe(bundle, poe) {
    const ids = new Set();
    const poeData = bundle.segment_load_kg_by_poe_hs2?.[poe];
    if (!poeData) return ids;
    for (const hs2Code in poeData) {
        for (const segId in poeData[hs2Code]) {
            ids.add(segId);
        }
    }
    return ids;
}

/**
 * Get per-segment POE weight distribution from a single bundle.
 * Returns a Map where each segment ID maps to an array of {poe, weight} with cumulative probabilities.
 * Used for probabilistic POE assignment when spawning particles.
 *
 * @param {object} bundle
 * @returns {Map<string, {poes: Array<{poe: string, cumWeight: number}>, totalWeight: number}>}
 */
export function getSegmentPoeDistribution(bundle) {
    const result = new Map();
    const segmentLoad = bundle.segment_load_kg_by_poe_hs2;
    if (!segmentLoad) return result;

    // First pass: aggregate weight per segment per POE
    // segTotals: segId → Map<poe, totalKg>
    const segTotals = new Map();

    for (const poe in segmentLoad) {
        const poeData = segmentLoad[poe];
        for (const hs2Code in poeData) {
            const hs2Data = poeData[hs2Code];
            for (const segId in hs2Data) {
                if (!segTotals.has(segId)) {
                    segTotals.set(segId, new Map());
                }
                const poeMap = segTotals.get(segId);
                poeMap.set(poe, (poeMap.get(poe) || 0) + hs2Data[segId]);
            }
        }
    }

    // Second pass: convert to cumulative weight arrays for fast sampling
    for (const [segId, poeMap] of segTotals) {
        const poes = [];
        let cumWeight = 0;
        for (const [poe, weight] of poeMap) {
            cumWeight += weight;
            poes.push({ poe, cumWeight });
        }
        result.set(segId, { poes, totalWeight: cumWeight });
    }

    return result;
}

/**
 * Merge POE distributions from multiple bundles.
 * For segments that exist in multiple bundles, combines their POE weights.
 * This ensures segments that only exist in one scenario (e.g., Interserrana) are included.
 *
 * @param  {...object} bundles - Bundles to merge
 * @returns {Map<string, {poes: Array<{poe: string, cumWeight: number}>, totalWeight: number}>}
 */
export function getMergedSegmentPoeDistribution(...bundles) {
    // segTotals: segId → Map<poe, totalKg>
    const segTotals = new Map();

    for (const bundle of bundles) {
        if (!bundle) continue;
        const segmentLoad = bundle.segment_load_kg_by_poe_hs2;
        if (!segmentLoad) continue;

        for (const poe in segmentLoad) {
            const poeData = segmentLoad[poe];
            for (const hs2Code in poeData) {
                const hs2Data = poeData[hs2Code];
                for (const segId in hs2Data) {
                    if (!segTotals.has(segId)) {
                        segTotals.set(segId, new Map());
                    }
                    const poeMap = segTotals.get(segId);
                    poeMap.set(poe, (poeMap.get(poe) || 0) + hs2Data[segId]);
                }
            }
        }
    }

    // Convert to cumulative weight arrays for fast sampling
    const result = new Map();
    for (const [segId, poeMap] of segTotals) {
        const poes = [];
        let cumWeight = 0;
        for (const [poe, weight] of poeMap) {
            cumWeight += weight;
            poes.push({ poe, cumWeight });
        }
        result.set(segId, { poes, totalWeight: cumWeight });
    }

    return result;
}

// ───────────────────────────────────────────────────────────────────────────────
// INJECTION POINT WEIGHT MAPPING
// Maps CIEN segment weights to injection points based on geometry matching.
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Compute the weight (kg) for each injection point by matching CIEN segment
 * geometry to the injection point locations.
 *
 * Algorithm:
 * 1. For each segment with weight in segment_load_kg_by_poe_hs2
 * 2. Convert segment geometry to world coords
 * 3. Find the injection point that the segment passes through (within threshold)
 * 4. Assign segment weight to that injection point
 *
 * @param {object} bundle - ReynosaOverlayBundle
 * @param {Array<{x: number, y: number, id: string}>} injectionPoints - Injection point world coords
 * @param {function} latLonToWorld - Coordinate converter (lat, lon) => {x, y}
 * @param {number} [matchThreshold=500] - Distance threshold in meters for geometry matching
 * @param {string} [poeFilter='hidalgo_pharr'] - POE to extract weights for
 * @returns {{
 *   weights: Map<string, number>,  // injection point id → annual kg
 *   unmatched: Array<{segmentId: string, weight: number, reason: 'no_match', nearestDist: number, nearestPoint: string}>,  // segments too far from any injection point
 *   matched: number,  // count of matched segments
 * }}
 * @throws {Error} if any segment in segment_load_kg_by_poe_hs2 has no geometry in segments_in_roi
 */
export function computeInjectionPointWeights(
    bundle,
    injectionPoints,
    latLonToWorld,
    matchThreshold = 500,
    poeFilter = 'hidalgo_pharr'
) {
    const weights = new Map();
    const unmatched = [];
    let matched = 0;

    // Initialize weights to 0
    for (const pt of injectionPoints) {
        weights.set(pt.id, 0);
    }

    // Get segment weights (annual kg, not normalized)
    const segmentLoad = bundle.segment_load_kg_by_poe_hs2;
    if (!segmentLoad || !segmentLoad[poeFilter]) {
        console.warn('[SegmentWeights] No segment load data for POE:', poeFilter);
        return { weights, unmatched, matched: 0 };
    }

    // Build segment → total kg map (across all HS2)
    const segmentKg = new Map();
    const poeData = segmentLoad[poeFilter];
    for (const hs2Code in poeData) {
        for (const segId in poeData[hs2Code]) {
            segmentKg.set(segId, (segmentKg.get(segId) || 0) + poeData[hs2Code][segId]);
        }
    }

    // Build segment geometry lookup
    const segmentGeom = new Map();
    if (bundle.geometry?.segments_in_roi) {
        for (const seg of bundle.geometry.segments_in_roi) {
            if (seg.geometry_coordinates && seg.geometry_coordinates.length > 0) {
                segmentGeom.set(seg.segment_id, seg.geometry_coordinates);
            }
        }
    }

    // Match each weighted segment to an injection point
    for (const [segId, kg] of segmentKg) {
        const coords = segmentGeom.get(segId);
        if (!coords || coords.length === 0) {
            // No geometry for this segment - this is a contract violation
            // Mass would silently disappear without geometry
            throw new Error(
                `[SegmentWeights] Contract violation: segment "${segId}" has ${kg.toFixed(0)} kg ` +
                `in segment_load_kg_by_poe_hs2 but no geometry in segments_in_roi. ` +
                `CIEN must export geometry for all weighted segments.`
            );
        }

        // Convert to world coords
        const worldPoints = coords.map(([lat, lon]) => latLonToWorld(lat, lon));

        // Find which injection point this segment passes through
        let bestMatch = null;
        let bestDist = Infinity;

        for (const pt of injectionPoints) {
            for (const wp of worldPoints) {
                const dx = wp.x - pt.x;
                const dy = wp.y - pt.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestMatch = pt;
                }
            }
        }

        if (bestMatch && bestDist <= matchThreshold) {
            weights.set(bestMatch.id, weights.get(bestMatch.id) + kg);
            matched++;
        } else {
            unmatched.push({
                segmentId: segId,
                weight: kg,
                reason: 'no_match',
                nearestDist: bestDist,
                nearestPoint: bestMatch?.id,
            });
        }
    }

    return { weights, unmatched, matched };
}

/**
 * Compute injection point weights using pre-transformed segments.
 * This uses the same world coords as MACRO view rendering.
 *
 * @param {object} bundle - ReynosaOverlayBundle with segment_load_kg_by_poe_hs2
 * @param {Array<{segment_id: string, points: Array<{x: number, y: number}>}>} worldSegments - Segments with world coords (from getSegmentsInROI)
 * @param {Array<{x: number, y: number, id: string}>} injectionPoints - Injection point coords
 * @param {number} [matchThreshold=500] - Distance threshold in meters
 * @param {string} [poeFilter='hidalgo_pharr'] - POE to filter segment weights
 * @returns {{
 *   weights: Map<string, number>,
 *   unmatched: Array<{segmentId: string, weight: number, reason: 'no_match', nearestDist: number, nearestPoint: string}>,
 *   matched: number
 * }}
 * @throws {Error} if any segment in segment_load_kg_by_poe_hs2 has no geometry in worldSegments
 */
export function computeInjectionPointWeightsFromWorldSegments(
    bundle,
    worldSegments,
    injectionPoints,
    matchThreshold = 500,
    poeFilter = 'hidalgo_pharr'
) {
    const weights = new Map();
    const unmatched = [];
    let matched = 0;

    // Initialize weights to 0
    for (const pt of injectionPoints) {
        weights.set(pt.id, 0);
    }

    // Get segment weights (annual kg)
    const segmentLoad = bundle.segment_load_kg_by_poe_hs2;
    if (!segmentLoad || !segmentLoad[poeFilter]) {
        console.warn('[SegmentWeights] No segment load data for POE:', poeFilter);
        return { weights, unmatched, matched: 0 };
    }

    // Build segment → total kg map (across all HS2)
    const segmentKg = new Map();
    const poeData = segmentLoad[poeFilter];
    for (const hs2Code in poeData) {
        for (const segId in poeData[hs2Code]) {
            segmentKg.set(segId, (segmentKg.get(segId) || 0) + poeData[hs2Code][segId]);
        }
    }

    // Build segment geometry lookup from pre-transformed world coords
    const segmentGeom = new Map();
    for (const seg of worldSegments) {
        if (seg.points && seg.points.length > 0) {
            segmentGeom.set(seg.segment_id, seg.points);
        }
    }

    // Match each weighted segment to an injection point
    for (const [segId, kg] of segmentKg) {
        const points = segmentGeom.get(segId);
        if (!points || points.length === 0) {
            // No geometry for this segment - this is a contract violation
            // Mass would silently disappear without geometry
            throw new Error(
                `[SegmentWeights] Contract violation: segment "${segId}" has ${kg.toFixed(0)} kg ` +
                `in segment_load_kg_by_poe_hs2 but no geometry in worldSegments. ` +
                `CIEN must export geometry for all weighted segments.`
            );
        }

        // Find which injection point this segment passes through
        let bestMatch = null;
        let bestDist = Infinity;

        for (const pt of injectionPoints) {
            for (const wp of points) {
                const dx = wp.x - pt.x;
                const dy = wp.y - pt.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestMatch = pt;
                }
            }
        }

        if (bestMatch && bestDist <= matchThreshold) {
            weights.set(bestMatch.id, weights.get(bestMatch.id) + kg);
            matched++;
        } else {
            unmatched.push({
                segmentId: segId,
                weight: kg,
                reason: 'no_match',
                nearestDist: bestDist,
                nearestPoint: bestMatch?.id,
            });
        }
    }

    return { weights, unmatched, matched };
}

/**
 * Get injection point weight ratios (normalized to sum to 1).
 *
 * @param {Map<string, number>} weights - From computeInjectionPointWeights
 * @returns {Map<string, number>} injection point id → ratio [0,1]
 */
export function getInjectionPointRatios(weights) {
    const total = Array.from(weights.values()).reduce((a, b) => a + b, 0);

    if (total === 0) {
        throw new Error('[INJECTION] No segment weights found - CIEN data required, no fallback');
    }

    const ratios = new Map();
    for (const [id, kg] of weights) {
        ratios.set(id, kg / total);
    }

    return ratios;
}
