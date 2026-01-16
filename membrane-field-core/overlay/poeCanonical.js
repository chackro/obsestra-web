/**
 * POE Canonical Keyspace
 * ======================
 * Single source of truth for POE identity mapping.
 * Both tipping_summary and poe_locations keys must be canonicalized before use.
 */

// Canonical POE IDs (lowercase, underscored)
export const CANONICAL_POES = [
    'laredo',
    'hidalgo_pharr',
    'brownsville',
    'eagle_pass',
    'del_rio',
    'roma',
    'progreso',
    'rio_grande_city',
    'otay_mesa',
    'calexico_east',
    'nogales',
    'douglas',
    'san_luis',
    'tecate',
    'santa_teresa',
    'ysleta',
    'el_paso',
    'presidio',
];

// Alias → Canonical mapping
const ALIASES = {
    // --- Canonical Name ---      // --- Known Aliases ---
    'brownsville': 'brownsville',
    'brownsville_bridge': 'brownsville',
    'matamoros': 'brownsville',
    '2301': 'brownsville',
    'brownsville_tx': 'brownsville',
    'los_indios': 'brownsville',
    'los_indios_bridge': 'brownsville',

    'calexico': 'calexico',
    '2503': 'calexico',
    'calexico_ca': 'calexico',

    'calexico_east': 'calexico_east',
    'calexico_east_bridge': 'calexico_east',
    '2507': 'calexico_east',
    'calexico_east_ca': 'calexico_east',

    'columbus': 'columbus',
    '2406': 'columbus',
    'columbus_nm': 'columbus',

    'del_rio': 'del_rio',
    'del_rio_bridge': 'del_rio',
    '2302': 'del_rio',
    'del_rio_tx': 'del_rio',

    'douglas': 'douglas',
    'douglas_bridge': 'douglas',
    '2601': 'douglas',
    'douglas_az': 'douglas',

    'eagle_pass': 'eagle_pass',
    'eagle_pass_bridge': 'eagle_pass',
    '2303': 'eagle_pass',
    'eagle_pass_tx': 'eagle_pass',

    'el_paso': 'el_paso',
    'el_paso_bridge': 'el_paso',
    '2402': 'el_paso',
    'el_paso_tx': 'el_paso',

    'fabens': 'fabens',
    'fabens_bridge': 'fabens',
    '2404': 'fabens',

    'hidalgo_pharr': 'hidalgo_pharr',
    'hidalgo_pharr_bridge': 'hidalgo_pharr',
    'pharr': 'hidalgo_pharr',
    '2305': 'hidalgo_pharr',
    'hidalgo_pharr_tx': 'hidalgo_pharr',

    'laredo': 'laredo',
    'laredo_bridge': 'laredo',
    'laredo_world_trade_bridge': 'laredo',
    '2304': 'laredo',
    'laredo_tx': 'laredo',

    'laredo_colombia': 'laredo_colombia',
    'laredo_colombia_solidarity': 'laredo_colombia',
    'laredo_colombia_solidarity_bridge': 'laredo_colombia',
    'colombia_bridge': 'laredo_colombia',
    '230403': 'laredo_colombia',
    'laredo_colombia_tx': 'laredo_colombia',

    'lukeville': 'lukeville',
    '2602': 'lukeville',
    'lukeville_az': 'lukeville',

    'naco': 'naco',
    '2603': 'naco',
    'naco_az': 'naco',

    'nogales': 'nogales',
    'nogales_bridge': 'nogales',
    '2604': 'nogales',
    'nogales_az': 'nogales',

    'otay_mesa': 'otay_mesa',
    'otay_mesa_bridge': 'otay_mesa',
    '2506': 'otay_mesa',
    'otay_mesa_ca': 'otay_mesa',

    'presidio': 'presidio',
    'presidio_bridge': 'presidio',
    '2403': 'presidio',
    'presidio_tx': 'presidio',

    'progreso': 'progreso',
    'progreso_bridge': 'progreso',
    '2309': 'progreso',
    'progreso_tx': 'progreso',

    'rio_grande_city': 'rio_grande_city',
    'rio_grande_city_bridge': 'rio_grande_city',
    '2307': 'rio_grande_city',
    'rio_grande_city_tx': 'rio_grande_city',

    'roma': 'roma',
    'roma_bridge': 'roma',
    '2310': 'roma',
    'roma_tx': 'roma',

    'san_luis': 'san_luis',
    'san_luis_bridge': 'san_luis',
    '2608': 'san_luis',
    'san_luis_az': 'san_luis',

    'san_ysidro': 'san_ysidro',
    'san_ysidro_bridge': 'san_ysidro',
    '2504': 'san_ysidro',
    'san_ysidro_ca': 'san_ysidro',

    'santa_teresa': 'santa_teresa',
    'santa_teresa_bridge': 'santa_teresa',
    '2408': 'santa_teresa',
    'santa_teresa_nm': 'santa_teresa',

    'tecate': 'tecate',
    'tecate_bridge': 'tecate',
    '2505': 'tecate',
    'tecate_ca': 'tecate',

    'ysleta': 'ysleta',
    'ysleta_bridge': 'ysleta',
    'zaragoza': 'ysleta',
    '2401': 'ysleta',
    'ysleta_tx': 'ysleta',
};

// Authoritative Coordinates (from od_mapping.py PORT_COORDINATES)
// Coordinates are NB (Northbound) entry points.
export const CANONICAL_COORDINATES = {
    'laredo': { lat: 27.5971489, lon: -99.5369402 },
    'laredo_colombia': { lat: 27.70094, lon: -99.74374 },  // Laredo Colombia Solidarity
    'hidalgo_pharr': { lat: 26.0666970, lon: -98.2051776 },
    'brownsville': { lat: 25.8919545, lon: -97.5045579 },
    'eagle_pass': { lat: 28.7053829, lon: -100.5128600 },
    'del_rio': { lat: 29.3268517, lon: -100.9275481 },
    'roma': { lat: 26.4029371, lon: -99.0206141 },
    'progreso': { lat: 26.0620245, lon: -97.9500056 },
    'rio_grande_city': { lat: 26.3623249, lon: -98.8064229 },
    'otay_mesa': { lat: 32.5496517, lon: -116.9383684 },
    'calexico_east': { lat: 32.6703707, lon: -115.3835395 },
    'calexico': { lat: 32.6647019, lon: -115.4982327 },
    'nogales': { lat: 31.3380724, lon: -110.9675708 },
    'douglas': { lat: 31.3339549, lon: -109.5602054 },
    'san_luis': { lat: 32.4850451, lon: -114.7822130 },
    'tecate': { lat: 32.5765003, lon: -116.6260143 },
    'santa_teresa': { lat: 31.7839981, lon: -106.6794771 },
    'ysleta': { lat: 31.6708864, lon: -106.3404310 },
    'el_paso': { lat: 31.7644031, lon: -106.4512000 },
    'presidio': { lat: 29.5607696, lon: -104.3965277 },
    'fabens': { lat: 31.4327146, lon: -106.1479896 },
    'lukeville': { lat: 31.8790737, lon: -112.8185441 },
    'naco': { lat: 31.3324321, lon: -109.9484194 },
    'san_ysidro': { lat: 32.5438367, lon: -117.0302525 },
};

// Display names for UI
export const POE_DISPLAY_NAMES = {
    'laredo': 'Laredo',
    'hidalgo_pharr': 'Hidalgo–Pharr',
    'brownsville': 'Brownsville',
    'eagle_pass': 'Eagle Pass',
    'del_rio': 'Del Rio',
    'roma': 'Roma',
    'progreso': 'Progreso',
    'rio_grande_city': 'Rio Grande City',
    'otay_mesa': 'Otay Mesa',
    'calexico_east': 'Calexico East',
    'nogales': 'Nogales',
    'douglas': 'Douglas',
    'san_luis': 'San Luis',
    'tecate': 'Tecate',
    'santa_teresa': 'Santa Teresa',
    'ysleta': 'Ysleta',
    'el_paso': 'El Paso',
    'presidio': 'Presidio',
};

/**
 * Canonicalize a POE key to the standard format.
 * @param {string} poeKey - Any POE identifier
 * @returns {string} Canonical POE ID (lowercase, underscored)
 */
export function canonicalize(poeKey) {
    if (!poeKey) return '';
    const lower = poeKey.toLowerCase().trim();
    return ALIASES[lower] || lower;
}

/**
 * Canonicalize all keys in an object.
 * @param {Object} obj - Object with POE keys
 * @returns {Object} New object with canonical keys
 */
export function canonicalizeKeys(obj) {
    if (!obj || typeof obj !== 'object') return {};
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        result[canonicalize(key)] = value;
    }
    return result;
}

/**
 * Get display name for a POE.
 * @param {string} poeKey - POE identifier
 * @returns {string} Human-readable display name
 */
export function getDisplayName(poeKey) {
    const canonical = canonicalize(poeKey);
    return POE_DISPLAY_NAMES[canonical] || canonical;
}
