/**
 * Potential Field Module
 *
 * Creates Gaussian potential wells for US destinations.
 * Particles visually "flow downhill" into these wells.
 * MACRO CIEN view only.
 */

export class PotentialField {
    constructor(sinks) {
        // sinks = [{ x, y, depth, sigma, name }, ...]
        this.sinks = sinks;
    }

    /**
     * Sample Z (depth) at world coordinates.
     * Returns negative values (wells pull down).
     */
    sampleZ(x, y) {
        let z = 0;
        for (const s of this.sinks) {
            const dx = x - s.x;
            const dy = y - s.y;
            const distSq = dx * dx + dy * dy;
            z += s.depth * Math.exp(-distSq / (2 * s.sigma * s.sigma));
        }
        return z;
    }

    /**
     * Get gradient at world coordinates (for heading bias).
     * Returns { gx, gy } pointing toward steepest descent.
     */
    gradient(x, y) {
        let gx = 0;
        let gy = 0;
        for (const s of this.sinks) {
            const dx = x - s.x;
            const dy = y - s.y;
            const distSq = dx * dx + dy * dy;
            const sigma2 = s.sigma * s.sigma;
            const g = s.depth * Math.exp(-distSq / (2 * sigma2));
            // Gradient of Gaussian: -depth * exp(...) * (x - cx) / sigma^2
            gx += g * (-dx / sigma2);
            gy += g * (-dy / sigma2);
        }
        return { gx, gy };
    }
}

/**
 * Build potential field from validation data and destination coordinates.
 *
 * @param {Object} validationData - From mexican_export_validation_results.json
 * @param {Object} destCoords - From us_destinations.json
 * @param {Function} latLonToWorld - Coordinate converter
 * @returns {PotentialField}
 */
export function buildPotentialField(validationData, destCoords, latLonToWorld) {
    const cityWeights = validationData.faf_region_city_totals_kg;
    if (!cityWeights) {
        console.warn('[PotentialField] No faf_region_city_totals_kg in validation data');
        return new PotentialField([]);
    }

    const kgValues = Object.values(cityWeights);
    const kgMin = Math.min(...kgValues);
    const kgMax = Math.max(...kgValues);

    // Tuning constants
    const K = 3;             // Depth scale (log multiplier)
    const S_BASE = 150000;   // Base sigma in meters for max city (150km)

    const sinks = [];
    for (const [city, kg] of Object.entries(cityWeights)) {
        // Map "Dallas" -> "dallas", "San Francisco" -> "san_francisco"
        const key = city.toLowerCase().replace(/ /g, '_');
        const coords = destCoords[key];

        if (!coords) {
            // Skip cities without coordinates
            continue;
        }

        const world = latLonToWorld(coords.lat, coords.lon);

        // Log-scaled depth (prevents top cities from dominating)
        const depth = -K * Math.log(kg / kgMin);

        // Sigma scaled by sqrt of relative weight
        const sigma = S_BASE * Math.sqrt(kg / kgMax);

        sinks.push({
            x: world.x,
            y: world.y,
            depth,
            sigma,
            name: city,
            kg
        });
    }

    console.log(`[PotentialField] Built with ${sinks.length} sinks`);
    return new PotentialField(sinks);
}
