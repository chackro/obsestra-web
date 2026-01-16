// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO REGISTRY
// Supports N scenarios via PascalCase combinators: Baseline, Inovus, InovusTwinspan, etc.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  togglePhasesAsLots,
  isPhasesAsLots,
  setInovusCapacityMultiplier,
  getInovusCapacityMultiplier,
  setTwinSpanCapacityMultiplier,
  setScenarioAlpha,
  setLotAdmissionCutoff,
  getLotAdmissionCutoff,
} from '../overlay/reynosaOverlay_v2.js';

// ═══════════════════════════════════════════════════════════════════════════════
// BASE TOGGLES (atomic operations)
// ═══════════════════════════════════════════════════════════════════════════════

const TOGGLES = {
  Inovus: {
    apply: async () => {
      setInovusCapacityMultiplier(1.0);
      if (!isPhasesAsLots()) await togglePhasesAsLots();
    },
    unapply: async () => {
      if (isPhasesAsLots()) await togglePhasesAsLots();
      setInovusCapacityMultiplier(1.0);
    },
    getKnobs: () => ({
      inovusEnabled: isPhasesAsLots(),
      inovusCapMult: getInovusCapacityMultiplier(),
    }),
  },

  Twinspan: {
    apply: async () => {
      setTwinSpanCapacityMultiplier(2.0);
    },
    unapply: async () => {
      setTwinSpanCapacityMultiplier(1.0);
    },
    getKnobs: () => ({
      twinspanMult: 2.0,
    }),
  },

  Interserrana: {
    apply: async () => {
      setScenarioAlpha(1.0);
    },
    unapply: async () => {
      setScenarioAlpha(0.0);
    },
    getKnobs: () => ({
      scenarioAlpha: 1.0,
    }),
  },

  Globalcapacityincrease: {
    apply: async () => {
      setLotAdmissionCutoff(0.75);  // Raise from 55% to 75%
    },
    unapply: async () => {
      setLotAdmissionCutoff(0.55);  // Reset to default 55%
    },
    getKnobs: () => ({
      lotAdmissionCutoff: getLotAdmissionCutoff(),
    }),
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// PARSER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse PascalCase scenario name into toggle names.
 * "InovusTwinspan" -> ['Inovus', 'Twinspan']
 * "Baseline" -> []
 */
export function parseScenarioName(name) {
  if (name === 'Baseline') return [];
  // Split PascalCase: "InovusTwinspan" -> ["Inovus", "Twinspan"]
  const parts = name.match(/[A-Z][a-z]+/g) || [];
  return parts.filter(t => TOGGLES[t]);
}

/**
 * Get list of available toggle names.
 */
export function getAvailableToggles() {
  return Object.keys(TOGGLES);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCENARIO BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a scenario object from a PascalCase name.
 * @param {string} name - e.g., "Baseline", "Inovus", "InovusTwinspan"
 * @returns {{ name, description, applyScenario, getKnobs }}
 */
export function buildScenario(name) {
  const toggleNames = parseScenarioName(name);

  return {
    name,
    description: toggleNames.length ? toggleNames.join(' + ') : 'Baseline (no toggles)',

    applyScenario: async () => {
      // First reset all toggles to baseline state
      for (const toggle of Object.values(TOGGLES)) {
        await toggle.unapply();
      }
      // Then apply requested toggles in order
      for (const toggleName of toggleNames) {
        await TOGGLES[toggleName].apply();
      }
    },

    getKnobs: () => {
      const knobs = { toggles: toggleNames };
      for (const toggleName of toggleNames) {
        Object.assign(knobs, TOGGLES[toggleName].getKnobs());
      }
      return knobs;
    },
  };
}

/**
 * Validate a scenario name.
 * @param {string} name
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateScenarioName(name) {
  if (name === 'Baseline') return { valid: true };

  const parts = name.match(/[A-Z][a-z]+/g) || [];
  if (parts.length === 0) {
    return { valid: false, error: `Invalid scenario name: ${name} (must be PascalCase)` };
  }

  const unknown = parts.filter(t => !TOGGLES[t]);
  if (unknown.length > 0) {
    return {
      valid: false,
      error: `Unknown toggles in ${name}: ${unknown.join(', ')}. Available: ${Object.keys(TOGGLES).join(', ')}`
    };
  }

  return { valid: true };
}
