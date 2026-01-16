// ═══════════════════════════════════════════════════════════════════════════════
// WORKER THREAD
// Runs a single scenario in complete isolation (separate V8 isolate).
// ═══════════════════════════════════════════════════════════════════════════════

import { parentPort, workerData } from 'worker_threads';
import { HeadlessSim } from './headlessSim.js';
import { buildScenario, validateScenarioName } from './scenarios.js';
import { exportAnimatedHeatmaps } from './animatedHeatmapExport.js';

// Redirect console to parentPort for worker thread visibility
console.log = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'log', msg: args.join(' ') });
};
console.warn = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'warn', msg: args.join(' ') });
};
console.error = (...args) => {
  parentPort.postMessage({ type: 'log', level: 'error', msg: args.join(' ') });
};

const {
  scenarioName,
  bundlePath,
  duration,
  warmupSeconds,
  dt,
  sampleInterval,
  resultsDir,
  captureHeatmapFrames,
} = workerData;

async function run() {
  // Validate scenario name
  const validation = validateScenarioName(scenarioName);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Build scenario from name
  const scenario = buildScenario(scenarioName);

  // Create sim with scenario applied
  const sim = new HeadlessSim({
    bundlePath,
    applyScenario: scenario.applyScenario,
    scenarioName,
  });
  await sim.init(0);

  // Capture knobs AFTER scenario is applied
  const knobs = scenario.getKnobs();

  // Run simulation using unified loop
  const result = await sim.run({
    duration,
    dt,
    sampleInterval,
    warmupSeconds,
    knobs,
    captureHeatmapFrames,
  });

  // Export heatmap PNGs (if resultsDir provided)
  if (resultsDir) {
    try {
      const basePath = `${resultsDir}/${scenarioName}`;
      sim.exportHeatmapPNGs(basePath);
    } catch (err) {
      console.warn(`[${scenarioName}] Heatmap export failed: ${err.message}`);
    }
  }

  // Export animated GIFs (if captureHeatmapFrames and resultsDir)
  if (captureHeatmapFrames && resultsDir && result.heatmapFrames) {
    try {
      const heatmapData = sim.getHeatmapData();
      exportAnimatedHeatmaps(result.heatmapFrames, heatmapData, scenarioName, resultsDir);
    } catch (err) {
      console.warn(`[${scenarioName}] Animated heatmap export failed: ${err.message}`);
    }
  }

  // Get heatmap data for delta visualization (main thread will compute deltas)
  const heatmapData = sim.getHeatmapData();

  // Send result back to main thread (exclude heatmapFrames - too large to clone)
  const { heatmapFrames, ...resultWithoutFrames } = result;
  parentPort.postMessage({ ...resultWithoutFrames, heatmapData });
}

// Run and handle errors
run().catch(err => {
  console.error(`[${scenarioName}] FAILED: ${err.message}`);
  parentPort.postMessage({
    scenarioName,
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
