// ═══════════════════════════════════════════════════════════════════════════════
// PARALLEL RUNNER
// Spawns N worker threads in parallel, one per scenario.
// ═══════════════════════════════════════════════════════════════════════════════

import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { exportDeltaHeatmaps } from './heatmapExport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Run a single scenario in a worker thread.
 * @returns {Promise<Object>} - Scenario result
 */
function runWorker(scenarioName, config, workerPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData: {
        scenarioName,
        bundlePath: config.bundlePath,
        duration: config.duration,
        warmupSeconds: config.warmupSeconds,
        dt: config.dt,
        sampleInterval: config.sampleInterval,
        resultsDir: config.resultsDir,
        captureHeatmapFrames: config.captureHeatmapFrames,
      },
      stdout: true,
      stderr: true,
    });

    worker.on('message', msg => {
      if (msg.type === 'log') {
        // Pass through - logger already adds scenario prefix
        if (msg.level === 'error') {
          console.error(msg.msg);
        } else if (msg.level === 'warn') {
          console.warn(msg.msg);
        } else {
          console.log(msg.msg);
        }
      } else {
        resolve(msg);
      }
    });

    worker.on('error', err => {
      reject(new Error(`Worker ${scenarioName} error: ${err.message}`));
    });

    worker.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`Worker ${scenarioName} exited with code ${code}`));
      }
    });
  });
}

/**
 * Run multiple scenarios in parallel using worker threads.
 * @param {string[]} scenarioNames - List of PascalCase scenario names
 * @param {Object} config - Run configuration
 * @param {string} config.bundlePath - Path to bundle JSON
 * @param {number} config.duration - Simulation duration in seconds
 * @param {number} config.warmupSeconds - Warmup period in seconds
 * @param {number} config.dt - Time step in seconds
 * @param {number} config.sampleInterval - Sample interval in seconds
 * @param {number} [config.maxWorkers=Infinity] - Max concurrent workers
 * @returns {Promise<Object[]>} - Array of scenario results
 */
export async function runScenariosParallel(scenarioNames, config) {
  const workerPath = path.join(__dirname, 'worker.js');
  const maxWorkers = config.maxWorkers || Infinity;
  const staggerDelayMs = config.staggerDelayMs || 20000;

  const concurrencyLabel = maxWorkers === Infinity ? 'unlimited' : maxWorkers;
  console.log(`\n[PERF] Scenarios: ${scenarioNames.length}, Workers: ${concurrencyLabel}, Stagger: ${staggerDelayMs/1000}s`);
  const startTime = Date.now();
  const workerTimes = [];  // Track individual worker durations

  const results = new Array(scenarioNames.length);
  let nextIndex = 0;
  let activeCount = 0;
  let completed = 0;

  await new Promise((resolveAll, rejectAll) => {
    let rejected = false;

    function spawnNext() {
      while (!rejected && nextIndex < scenarioNames.length && activeCount < maxWorkers) {
        const idx = nextIndex++;
        const scenarioName = scenarioNames[idx];
        const workerStart = Date.now();
        activeCount++;

        runWorker(scenarioName, config, workerPath)
          .then(result => {
            const workerElapsed = (Date.now() - workerStart) / 1000;
            workerTimes.push({ scenario: scenarioName, elapsed: workerElapsed });
            results[idx] = result;
            activeCount--;
            completed++;

            if (completed === scenarioNames.length) {
              resolveAll();
            } else {
              setTimeout(spawnNext, staggerDelayMs);
            }
          })
          .catch(err => {
            if (!rejected) {
              rejected = true;
              rejectAll(err);
            }
          });
      }
    }

    spawnNext();
  });

  const elapsed = (Date.now() - startTime) / 1000;
  const sumWorkerTime = workerTimes.reduce((acc, w) => acc + w.elapsed, 0);
  const avgWorkerTime = workerTimes.length > 0 ? sumWorkerTime / workerTimes.length : 0;
  const theoreticalSerial = sumWorkerTime;
  const parallelSpeedup = theoreticalSerial / elapsed;

  console.log(`\n[PERF] ════════════════════════════════════════════════════`);
  console.log(`[PERF] Wall time: ${elapsed.toFixed(1)}s`);
  console.log(`[PERF] Sum worker time: ${sumWorkerTime.toFixed(1)}s (theoretical serial)`);
  console.log(`[PERF] Avg per scenario: ${avgWorkerTime.toFixed(1)}s`);
  console.log(`[PERF] Parallel speedup: ${parallelSpeedup.toFixed(2)}x`);
  console.log(`[PERF] ════════════════════════════════════════════════════\n`);

  // Check for errors
  const errors = results.filter(r => r.error);
  if (errors.length > 0) {
    console.error('\n═══════════════════════════════════════════════════════════');
    console.error('SCENARIO ERRORS');
    console.error('═══════════════════════════════════════════════════════════');
    for (const err of errors) {
      console.error(`\n[${err.scenarioName}] ${err.error}`);
      if (err.stack) console.error(err.stack);
    }
    throw new Error(`${errors.length} scenario(s) failed`);
  }

  // Export delta heatmaps (compare each scenario to baseline = first scenario)
  if (results.length > 1 && config.resultsDir) {
    console.log('\nGenerating delta heatmaps...');
    const baseline = results[0];
    for (let i = 1; i < results.length; i++) {
      const scenario = results[i];
      if (baseline.heatmapData && scenario.heatmapData) {
        exportDeltaHeatmaps(
          baseline.heatmapData,
          scenario.heatmapData,
          scenario.scenarioName,
          baseline.scenarioName,
          config.resultsDir
        );
      }
    }
  }

  // Note: Animated GIFs (per-scenario) are exported directly in worker threads
  // Delta animations are not supported (would require passing large frame arrays across threads)

  return results;
}

/**
 * Compute deltas between scenarios.
 * @param {Object[]} results - Array of scenario results
 * @param {number} baselineIndex - Index of baseline scenario (default: 0)
 * @returns {Object[]} - Array of delta objects
 */
export function computeDeltas(results, baselineIndex = 0) {
  const baseline = results[baselineIndex];
  const deltas = [];

  for (let i = 0; i < results.length; i++) {
    if (i === baselineIndex) continue;

    const treatment = results[i];
    const deltaRate = treatment.summary.truckHoursLostPerHour_mean - baseline.summary.truckHoursLostPerHour_mean;
    const pctChange = baseline.summary.truckHoursLostPerHour_mean !== 0
      ? (deltaRate / baseline.summary.truckHoursLostPerHour_mean) * 100
      : 0;

    const injectedKgDelta = treatment.summary.injectedKg_final - baseline.summary.injectedKg_final;
    const injectedKgPctChange = baseline.summary.injectedKg_final !== 0
      ? (injectedKgDelta / baseline.summary.injectedKg_final) * 100
      : 0;

    deltas.push({
      baseline: baseline.scenarioName,
      treatment: treatment.scenarioName,
      truckHoursLost: treatment.summary.truckHoursLost_final - baseline.summary.truckHoursLost_final,
      truckHoursLostCongestion: treatment.summary.truckHoursLostCongestion_final - baseline.summary.truckHoursLostCongestion_final,
      truckHoursLostLotWait: treatment.summary.truckHoursLostLotWait_final - baseline.summary.truckHoursLostLotWait_final,
      truckHoursLostBridgeQueue: treatment.summary.truckHoursLostBridgeQueue_final - baseline.summary.truckHoursLostBridgeQueue_final,
      truckHoursLostPerHour_mean: deltaRate,
      truckHoursLostPctChange: pctChange,
      exitedKgPerHour_mean: treatment.summary.exitedKgPerHour_mean - baseline.summary.exitedKgPerHour_mean,
      throughputKg: treatment.final.exitedKg - baseline.final.exitedKg,
      sinkQueueCount_mean: treatment.summary.sinkQueueCount_mean - baseline.summary.sinkQueueCount_mean,
      cbpLanesInUse_mean: treatment.summary.cbpLanesInUse_mean - baseline.summary.cbpLanesInUse_mean,
      lotExclusions: treatment.summary.lotExclusions_final - baseline.summary.lotExclusions_final,
      cbpCompletions: treatment.summary.cbpCompletions_final - baseline.summary.cbpCompletions_final,
      // Mass balance deltas
      injectedKg: injectedKgDelta,
      injectedKgPctChange,
      activeParticles: treatment.summary.activeParticles_final - baseline.summary.activeParticles_final,
      // Normalized
      avgDelayPerTruck: treatment.summary.avgDelayPerTruck - baseline.summary.avgDelayPerTruck,
      avgCongestionPerTruck: treatment.summary.avgCongestionPerTruck - baseline.summary.avgCongestionPerTruck,
      avgLotWaitPerTruck: treatment.summary.avgLotWaitPerTruck - baseline.summary.avgLotWaitPerTruck,
      avgBridgeQueuePerTruck: treatment.summary.avgBridgeQueuePerTruck - baseline.summary.avgBridgeQueuePerTruck,
    });
  }

  return deltas;
}
