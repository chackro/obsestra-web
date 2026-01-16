import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  onAttach,
  reset,
  step,
  setSimTime,
  getMetricsPhase1,
  setVerbose,
  setQuietMode,
  setLogPrefix,
  setInterserranaScenario,
  getCongestionHeatmapData,
  resetCongestionAccumulators,
  getLotState,
} from '../overlay/reynosaOverlay_v2.js';

import {
  initLogger,
  setSimTime as setLoggerSimTime,
  heartbeat,
  consumeHeartbeatFlag,
  epochDayStart,
  endSummary,
  getRebuildsInWindow,
  setQuietMode as setLoggerQuietMode,
} from './logger.js';

import { exportHeatmaps } from './heatmapExport.js';

import {
  loadBundle,
  loadScenarioPairBundles,
  createScenarioAdapter,
  createInterserranaScenarioAdapter,
  createFieldGeometryProvider,
  latLonToWorld,
  getPharrWorldCoords,
  setBundleConsumerLogPrefix,
  setBundleConsumerVerbose,
} from '../overlay/bundleConsumer.js';

import { setLotsLoaderVerbose } from '../overlay/lotsLoader.js';
import { setScenarioPairVerbose } from '../overlay/scenarioPair.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const TRUCK_KG = 9000;
const MASS_TOL = 10000;
const SINK_CAP_FLOOR = 0.80;
const SINK_FLATLINE_SAMPLES = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// HEADLESS SIM
// ═══════════════════════════════════════════════════════════════════════════════

export class HeadlessSim {
  constructor({ bundlePath, applyScenario = null, scenarioName = null } = {}) {
    this.bundlePath = bundlePath ?? path.resolve(__dirname, '../test/bundle_baseline.json');
    this.applyScenario = applyScenario;
    this.scenarioName = scenarioName;
    this.simTime = 0;
  }

  async init(startSimTime = 0) {
    const initStart = Date.now();

    // Set log prefix for this worker (before any logging)
    if (this.scenarioName) {
      setLogPrefix(this.scenarioName);
      setBundleConsumerLogPrefix(this.scenarioName);
    }
    // Initialize structured logger
    initLogger(this.scenarioName);

    // Suppress verbose logs during headless runs
    setVerbose(false);
    setQuietMode(true);  // Suppress BUILD/INIT/ROUTING logs in overlay
    setLoggerQuietMode(true);  // Suppress CTRL logs in logger
    setLotsLoaderVerbose(false);
    setBundleConsumerVerbose(false);
    setScenarioPairVerbose(false);

    // Load baseline bundle
    const baselineBundle = JSON.parse(fs.readFileSync(this.bundlePath, 'utf-8'));

    // Load interserrana bundle for scenario pair interpolation
    const interserranaBundlePath = path.resolve(__dirname, '../test/interserrana_bundle.json');
    let interserranaBundle = null;
    try {
      interserranaBundle = JSON.parse(fs.readFileSync(interserranaBundlePath, 'utf-8'));
    } catch (e) {
      // Interserrana bundle not found - Interserrana toggle will be a no-op
    }

    // Load as scenario pair if both bundles available, otherwise single bundle
    if (interserranaBundle) {
      loadScenarioPairBundles(baselineBundle, interserranaBundle);
      const interserranaAdapter = createInterserranaScenarioAdapter();
      if (interserranaAdapter) {
        setInterserranaScenario(interserranaAdapter);
      }
    } else {
      loadBundle(baselineBundle);
    }

    // Load Reynosa city network for road segments
    const cityBundlePath = path.resolve(__dirname, '../test/reynosa_city_bundle.json');
    let citySegments = [];
    try {
      const cityBundle = JSON.parse(fs.readFileSync(cityBundlePath, 'utf-8'));
      citySegments = cityBundle.geometry?.segments_in_roi || [];
    } catch (e) {
      // No city bundle, using CIEN segments only
    }

    // Create geometry provider and transform segments
    const geometryProvider = createFieldGeometryProvider();
    const cienSegments = geometryProvider.getRoadSegments();

    // Transform city segments from lat/lon to world meters
    const citySegmentsTransformed = citySegments.map(seg => ({
      id: seg.segment_id,
      points: seg.geometry_coordinates.map(([lat, lon]) => latLonToWorld(lat, lon)),
    }));

    const allSegments = [...cienSegments, ...citySegmentsTransformed];

    // Build context like testBundle.html does
    const context = {
      geometry: {
        worldBounds: geometryProvider.getWorldBounds(),
        poePoints: { PHARR: getPharrWorldCoords() },
        roadSegments: allSegments,
      },
      scenario: createScenarioAdapter(),
    };

    await onAttach(context);

    if (this.applyScenario) {
      await this.applyScenario();
    }

    // Initialize simTime AFTER scenario applied, BEFORE reset
    this.simTime = startSimTime;
    setSimTime(this.simTime);
    reset();
    resetCongestionAccumulators();  // Clear heatmap accumulators for this run

    const initElapsed = ((Date.now() - initStart) / 1000).toFixed(1);
    console.warn(`[${this.scenarioName || 'sim'}] Init complete: ${allSegments.length} segments (${initElapsed}s)`);
  }

  async step(dt) {
    setSimTime(this.simTime);
    await step(dt);
    this.simTime += dt;
  }

  getMetricsRaw() {
    return { ...getMetricsPhase1() };
  }

  getMetrics() {
    return { t: this.simTime, ...this.getMetricsRaw() };
  }

  /**
   * Export congestion heatmap PNGs (thermal gradient).
   * Call at end of run to export accumulated presence and stall data.
   * @param {string} basePath - Base path without extension (e.g., "./results/Baseline")
   */
  exportHeatmapPNGs(basePath) {
    const data = getCongestionHeatmapData();
    exportHeatmaps(data, basePath);
  }

  /**
   * Get raw heatmap data for delta visualization.
   * Returns a copy of the accumulated presence/dwell data.
   * @returns {Object} - Heatmap data object
   */
  getHeatmapData() {
    return getCongestionHeatmapData();
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // UNIFIED RUN — Step loop with sampling, invariants, and summary
  // ═══════════════════════════════════════════════════════════════════════════════

  async run({ duration, dt, sampleInterval, warmupSeconds, knobs = {}, captureHeatmapFrames = false }) {
    const startWall = Date.now();
    const start = this.getMetricsRaw();
    const totalDays = Math.ceil(duration / 86400);
    let lastLoggedDay = -1;

    let prev = null;
    let prevRaw = null;
    let prevT = 0;
    const samples = [];
    const violations = [];
    const heatmapFrames = [];

    let nextSample = 0;
    let sinkFlatlineCount = 0;

    // Animation frame capture at lower frequency (1 hour) to conserve memory
    // 7 days = 168 frames at 1h interval
    const animFrameInterval = 3600;  // 1 hour
    let nextAnimFrame = 0;

    while (this.simTime < duration) {
      await this.step(dt);
      setLoggerSimTime(this.simTime);

      // Epoch marker at day boundaries
      const currentDay = Math.min(Math.floor(this.simTime / 86400) + 1, totalDays);
      if (currentDay !== lastLoggedDay) {
        epochDayStart(currentDay);
        lastLoggedDay = currentDay;
      }

      // Heartbeat every 6 sim-hours (clock-driven via setLoggerSimTime)
      if (consumeHeartbeatFlag()) {
        const raw = this.getMetricsRaw();
        const lotState = getLotState();
        heartbeat({
          day: this.simTime / 86400,
          totalDays,
          particles: raw.activeParticles,
          throughputMt: raw.exitedKg / 1e6,
          avgDelay: raw.cbpCompletions > 0 ? raw.truckHoursLost / raw.cbpCompletions : 0,
          lots: lotState,
          rebuildsLastWindow: getRebuildsInWindow(),
        });
      }

      // Sampling
      if (this.simTime >= nextSample) {
        const raw = this.getMetricsRaw();
        const t = this.simTime;
        const pastWarmup = t >= warmupSeconds;

        // Delta-derived rates
        let exitedKgPerHour = 0;
        let truckHoursLostPerHour = 0;
        if (prevRaw && t > prevT) {
          const deltaT = t - prevT;
          exitedKgPerHour = ((raw.exitedKg - prevRaw.exitedKg) / deltaT) * 3600;
          truckHoursLostPerHour = ((raw.truckHoursLost - prevRaw.truckHoursLost) / deltaT) * 3600;
        }

        // === INVARIANTS (only after warmup) ===
        if (pastWarmup) {
          // Mass invariant (departing particles are in activeParticles but already counted in exitedKg)
          const effectiveParticles = raw.activeParticles - (raw.departingParticles || 0);
          const massError = Math.abs(
            (raw.injectedKg - raw.exitedKg) - (effectiveParticles * TRUCK_KG)
          );
          if (massError > MASS_TOL) {
            violations.push({ type: 'mass', t, error: massError });
          }

          // Rate bound invariant
          if (truckHoursLostPerHour > raw.activeParticles + 1) {
            violations.push({
              type: 'rateBound',
              t,
              deltaRate: truckHoursLostPerHour,
              overlayRate: raw.truckHoursLostRate,
              particles: raw.activeParticles
            });
          }

          // Sink drain invariant
          if (raw.sinkOpen && raw.sinkQueueCount > 5) {
            const cap = raw.sinkCapKgPerHour;

            if (cap > 0 && exitedKgPerHour < cap * SINK_CAP_FLOOR) {
              throw new Error(`[SINK DRAIN INVARIANT] below_capacity at t=${t}s (hour ${(t/3600).toFixed(1)})
  sinkOpen: ${raw.sinkOpen}
  sinkQueueCount: ${raw.sinkQueueCount}
  cbpLanesInUse: ${raw.cbpLanesInUse}/7
  sinkCapKgPerHour: ${cap}
  exitedKgPerHour: ${exitedKgPerHour.toFixed(0)}
  floor (80%): ${(cap * SINK_CAP_FLOOR).toFixed(0)}
  activeParticles: ${raw.activeParticles}`);
            }

            const dExited = prevRaw ? (raw.exitedKg - prevRaw.exitedKg) : 1;
            if (dExited <= 0) {
              sinkFlatlineCount++;
              if (sinkFlatlineCount >= SINK_FLATLINE_SAMPLES) {
                throw new Error(`[SINK DRAIN INVARIANT] flatline at t=${t}s (hour ${(t/3600).toFixed(1)})
  consecutiveZeroSamples: ${sinkFlatlineCount}
  sinkOpen: ${raw.sinkOpen}
  sinkQueueCount: ${raw.sinkQueueCount}
  cbpLanesInUse: ${raw.cbpLanesInUse}`);
              }
            } else {
              sinkFlatlineCount = 0;
            }
          } else {
            sinkFlatlineCount = 0;
          }
        }

        // Sample record (cumulative from start)
        const curr = {
          t,
          injectedKg: raw.injectedKg - start.injectedKg,
          exitedKg: raw.exitedKg - start.exitedKg,
          activeParticles: raw.activeParticles,
          truckHoursLost: raw.truckHoursLost - start.truckHoursLost,
          truckHoursLostRate: raw.truckHoursLostRate,
          truckHoursLostCongestion: raw.truckHoursLostCongestion - start.truckHoursLostCongestion,
          truckHoursLostLotWait: raw.truckHoursLostLotWait - start.truckHoursLostLotWait,
          truckHoursLostBridgeQueue: raw.truckHoursLostBridgeQueue - start.truckHoursLostBridgeQueue,
          truckHoursLostBridgeService: raw.truckHoursLostBridgeService - start.truckHoursLostBridgeService,
          stallTonHours: raw.stallTonHours - start.stallTonHours,
          sinkQueueCount: raw.sinkQueueCount,
          cbpLanesInUse: raw.cbpLanesInUse,
          lotExclusions: raw.lotExclusions - start.lotExclusions,
          cbpCompletions: raw.cbpCompletions - start.cbpCompletions,
          exitedKgPerHour,
          truckHoursLostPerHour,
          lotFillRatios: raw.lotFillRatios ? [...raw.lotFillRatios] : null,
          totalLotCapacityKg: raw.totalLotCapacityKg,
          spawns: raw.spawns - start.spawns,
          departedCount: raw.departedCount - start.departedCount,
          departingCount: raw.departingCount,
          // AUDIT: Service time instrumentation
          serviceTimeStats: raw.serviceTimeStats,
          currentServiceTimeS: raw.currentServiceTimeS,
          effectiveLanes: raw.effectiveLanes,
        };

        // Monotonicity check
        if (pastWarmup && prev && curr.truckHoursLost < prev.truckHoursLost) {
          violations.push({ type: 'monotonicLoss', t });
        }

        samples.push(curr);
        prev = curr;
        prevRaw = raw;
        prevT = t;
        nextSample += sampleInterval;
      }

      // Capture heatmap frame for animation (separate, lower-frequency interval)
      if (captureHeatmapFrames && this.simTime >= nextAnimFrame) {
        const heatmapData = getCongestionHeatmapData();
        heatmapFrames.push({
          t: this.simTime,
          cellPresenceHours: heatmapData.cellPresenceHours,
          cellLotDwellHours: heatmapData.cellLotDwellHours,
        });
        nextAnimFrame += animFrameInterval;
      }
    }

    // Compute summary statistics
    const elapsedSeconds = (Date.now() - startWall) / 1000;
    const final = samples.at(-1);
    const postWarmup = samples.filter(s => s.t >= warmupSeconds);

    const exitedKgPerHourSum = postWarmup.reduce((acc, s) => acc + s.exitedKgPerHour, 0);
    const truckHoursLostPerHourSum = postWarmup.reduce((acc, s) => acc + s.truckHoursLostPerHour, 0);
    const exitedKgPerHour_mean = postWarmup.length > 0 ? exitedKgPerHourSum / postWarmup.length : 0;
    const truckHoursLostPerHour_mean = postWarmup.length > 0 ? truckHoursLostPerHourSum / postWarmup.length : 0;

    const overlayRateSum = postWarmup.reduce((acc, s) => acc + s.truckHoursLostRate, 0);
    const overlayRate_mean = postWarmup.length > 0 ? overlayRateSum / postWarmup.length : 0;

    const sinkQueueSum = postWarmup.reduce((acc, s) => acc + s.sinkQueueCount, 0);
    const cbpLanesSum = postWarmup.reduce((acc, s) => acc + s.cbpLanesInUse, 0);
    const sinkQueueCount_mean = postWarmup.length > 0 ? sinkQueueSum / postWarmup.length : 0;
    const cbpLanesInUse_mean = postWarmup.length > 0 ? cbpLanesSum / postWarmup.length : 0;

    const postWarmupHours = (duration - warmupSeconds) / 3600;

    // Slope: change in stallTonHours over last 48 hours
    const samplesPerHour = 3600 / sampleInterval;
    const slopeWindow = Math.min(48 * samplesPerHour, samples.length - 1);
    const slopeRef = samples.at(-slopeWindow - 1);
    const stallTonHoursSlope = slopeRef
      ? (final.stallTonHours - slopeRef.stallTonHours) / (slopeWindow * sampleInterval / 3600)
      : 0;

    const summary = {
      truckHoursLost_final: final.truckHoursLost,
      truckHoursLostCongestion_final: final.truckHoursLostCongestion,
      truckHoursLostLotWait_final: final.truckHoursLostLotWait,
      truckHoursLostBridgeQueue_final: final.truckHoursLostBridgeQueue,
      truckHoursLostBridgeService_final: final.truckHoursLostBridgeService,
      exitedKgPerHour_mean,
      truckHoursLostPerHour_mean,
      truckHoursLostRate_mean: overlayRate_mean,
      throughputKgPerHour: final.exitedKg / postWarmupHours,
      stallTonHoursSlope,
      sinkQueueCount_mean,
      cbpLanesInUse_mean,
      lotExclusions_final: final.lotExclusions,
      cbpCompletions_final: final.cbpCompletions,
      totalLotCapacityKg: final.totalLotCapacityKg,
      injectedKg_final: final.injectedKg,
      exitedKg_final: final.exitedKg,
      activeParticles_final: final.activeParticles,
      massInSystem_final: final.injectedKg - final.exitedKg,
      injectedKgPerHour_mean: final.injectedKg / (duration / 3600),
      massBalanceError: Math.abs((final.injectedKg - final.exitedKg) - ((final.activeParticles - (final.departingParticles || 0)) * TRUCK_KG)),
      avgDelayPerTruck: final.cbpCompletions > 0 ? (final.truckHoursLost / final.cbpCompletions) : 0,
      avgCongestionPerTruck: final.cbpCompletions > 0 ? (final.truckHoursLostCongestion / final.cbpCompletions) : 0,
      avgLotWaitPerTruck: final.cbpCompletions > 0 ? (final.truckHoursLostLotWait / final.cbpCompletions) : 0,
      avgBridgeQueuePerTruck: final.cbpCompletions > 0 ? (final.truckHoursLostBridgeQueue / final.cbpCompletions) : 0,
      avgBridgeServicePerTruck: final.cbpCompletions > 0 ? (final.truckHoursLostBridgeService / final.cbpCompletions) : 0,
      // AUDIT: Per-completion service time stats (seconds)
      serviceTimeStats: final.serviceTimeStats,
      currentServiceTimeS: final.currentServiceTimeS,
      effectiveLanes: final.effectiveLanes,
    };

    // Structured end summary
    endSummary({
      simDays: duration / 86400,
      wallTime: elapsedSeconds,
      throughputMt: summary.exitedKg_final / 1e6,
      totalTruckHoursLost: summary.truckHoursLost_final,
      avgDelayPerTruck: summary.avgDelayPerTruck,
      violations: violations.length,
    });

    return {
      scenarioName: this.scenarioName,
      knobs,
      config: { duration, warmupSeconds, dt, sampleInterval },
      final,
      summary,
      samples,
      violations,
      passed: violations.length === 0,
      elapsedSeconds,
      heatmapFrames: captureHeatmapFrames ? heatmapFrames : null,
    };
  }
}
