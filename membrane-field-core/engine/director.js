/**
 * Director Module
 *
 * Executes scripted viewport/camera animations and effects.
 * Designed for cinematic sequences in the CIEN/FIELD viewer.
 */

// Easing functions
const Easing = {
    linear: t => t,
    smoothstep: t => t * t * (3 - 2 * t),
    easeInQuad: t => t * t,
    easeOutQuad: t => 1 - (1 - t) * (1 - t),
    easeInOutQuad: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
    easeInCubic: t => t * t * t,
    easeOutCubic: t => 1 - Math.pow(1 - t, 3),
    easeInOutCubic: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
};

/**
 * Instruction Types:
 *
 * { type: 'wait', duration: 1000 }
 *   - Wait for duration (ms) before next instruction
 *
 * { type: 'panTo', x: 0, y: 80000, duration: 2000, easing: 'smoothstep' }
 *   - Animate camera center to world coords (x, y)
 *
 * { type: 'zoomTo', zoom: 0.01, duration: 1500, easing: 'easeInOutCubic' }
 *   - Animate zoom level
 *
 * { type: 'flyTo', x: 0, y: 6000, zoom: 0.01, duration: 2500, easing: 'smoothstep' }
 *   - Combined pan + zoom animation
 *
 * { type: 'focusMacro', duration: 2000, easing: 'smoothstep' }
 *   - Fly to macro view (corridors)
 *
 * { type: 'focusLocal', duration: 2000, easing: 'smoothstep' }
 *   - Fly to local view (Reynosa)
 *
 * { type: 'setHour', hour: 8 }
 *   - Instantly set simulation hour
 *
 * { type: 'pause', pause: true }
 *   - Pause or unpause sim time
 *
 * { type: 'call', fn: () => {} }
 *   - Execute arbitrary callback
 *
 * { type: 'showSinkLabels', topN: 10 }
 *   - Show top N US destination cities with labels
 *
 * { type: 'showSourceLabels', topN: 10 }
 *   - Show top N Mexican origin cities with labels
 *
 * { type: 'showPoeLabels' }
 *   - Show POE hierarchy labels (Nuevo Laredo #1, Pharr #2)
 *
 * { type: 'hideLabels' }
 *   - Hide all orientation labels
 *
 * { type: 'overlay', text: '56.0 Mt/año', position: 'top-left', style: 'monospace', indent: 0, treeType: null }
 *   - Show telemetry overlay (staggered metrics in corner)
 *   - indent: 0, 1, or 2 for tree depth
 *   - treeType: 'tree' (├), 'tree-last' (└), 'tree-cont' (│), or null
 *
 * { type: 'overlayLive', text: '0 t en el sistema', indent: 0, treeType: null }
 *   - Show live counter overlay that updates every frame via onUpdateLiveOverlay callback
 *
 * { type: 'clearOverlays' }
 *   - Remove all overlay texts and stop live updates
 *
 * { type: 'setScenarioAlpha', alpha: 1.0 }
 *   - Instantly set scenario interpolation alpha (0=baseline, 1=target)
 *
 * { type: 'transitionAlpha', from: 0, to: 1, duration: 6000, easing: 'smoothstep' }
 *   - Animate scenario alpha transition over duration (for bundle reprojection)
 *
 * { type: 'label', name: 'intro' }
 *   - Named marker for jumps
 *
 * { type: 'loop', toLabel: 'intro' }
 *   - Jump back to a label
 *
 * { type: 'setParticleColorMode', mode: 2 }
 *   - Set particle color mode (0=OFF, 1=STALL, 2=SOURCE)
 *
 * { type: 'advanceEpoch' }
 *   - Advance scenario epoch counter (gates magenta highlighting to current-epoch particles only)
 *
 * { type: 'togglePhysicsDebug' }
 *   - Toggle physics debug overlay (D key)
 *
 * { type: 'cycleDebugLayer' }
 *   - Cycle debug layer (TAB key when debug active)
 */

export class Director {
    constructor(camera, time, options = {}) {
        this.camera = camera;
        this.time = time;

        // Callbacks
        this.onPlay = options.onPlay || (() => { });
        this.onPause = options.onPause || (() => { });
        this.onStop = options.onStop || (() => { });
        this.onInstructionStart = options.onInstructionStart || (() => { });
        this.onInstructionEnd = options.onInstructionEnd || (() => { });
        this.onText = options.onText || (() => { });
        this.onFadeText = options.onFadeText || (() => { });
        this.onSimPause = options.onSimPause || (() => { });
        this.onMacroPause = options.onMacroPause || (() => { });
        this.onHideParticles = options.onHideParticles || (() => { });
        // Dimension stack callbacks
        this.onShowDim = options.onShowDim || (() => { });
        this.onFadeDims = options.onFadeDims || (() => { });
        this.onTypeDesc = options.onTypeDesc || (() => { });
        this.onHideDims = options.onHideDims || (() => { });
        this.onShiftDims = options.onShiftDims || (() => { });

        // Orientation label callbacks
        this.onShowSinkLabels = options.onShowSinkLabels || (() => { });
        this.onShowSinkLabel = options.onShowSinkLabel || (() => { });
        this.onShowSourceLabels = options.onShowSourceLabels || (() => { });
        this.onShowPoeLabels = options.onShowPoeLabels || (() => { });
        this.onShowPoeLabel = options.onShowPoeLabel || (() => { });
        this.onHideLabels = options.onHideLabels || (() => { });
        this.onShowFramingSquare = options.onShowFramingSquare || (() => { });
        this.onHideFramingSquare = options.onHideFramingSquare || (() => { });
        this.onShowInterserranaBox = options.onShowInterserranaBox || (() => { });
        this.onHideInterserranaBox = options.onHideInterserranaBox || (() => { });
        this.onSetCorridorLabelPos = options.onSetCorridorLabelPos || (() => { });
        this.onShowLayerTransitionSquare = options.onShowLayerTransitionSquare || (() => { });
        this.onHideLayerTransitionSquare = options.onHideLayerTransitionSquare || (() => { });
        this.onDevStartComparison = options.onDevStartComparison || (() => { });
        this.onDevStopComparison = options.onDevStopComparison || (() => { });
        this.onSnapToFrame = options.onSnapToFrame || (() => { });
        this.onStartSim = options.onStartSim || (() => { });
        this.onHighlightCorridors = options.onHighlightCorridors || (() => { });
        this.onClearCorridorHighlight = options.onClearCorridorHighlight || (() => { });
        this.onHideNonHighlighted = options.onHideNonHighlighted || (() => { });
        this.onShowNonHighlighted = options.onShowNonHighlighted || (() => { });
        this.onDimNonHighlighted = options.onDimNonHighlighted || (() => { });
        this.onSetCorridorColor = options.onSetCorridorColor || (() => { });
        this.onOverlay = options.onOverlay || (() => { });
        this.onClearOverlays = options.onClearOverlays || (() => { });
        this.onUpdateLiveOverlay = options.onUpdateLiveOverlay || (() => { });
        this.onSetScenarioAlpha = options.onSetScenarioAlpha || (() => { });
        this.onSwitchToInterserrana = options.onSwitchToInterserrana || (() => { });
        this.onSetParticleColorMode = options.onSetParticleColorMode || (() => { });
        this.onEnableLayerB = options.onEnableLayerB || (() => { });
        this.onSetLayerBAlpha = options.onSetLayerBAlpha || (() => { });
        this.onSwitchToLayerB = options.onSwitchToLayerB || (() => { });  // Layer A → Layer B weight regime switch
        this.onSetPoeMode = options.onSetPoeMode || (() => { });  // Switch POE distribution for particle coloring
        this.onAdvanceEpoch = options.onAdvanceEpoch || (() => { });  // Advance scenario epoch for highlight gating
        this.onDimNonHighlighted = options.onDimNonHighlighted || (() => { });
        this.onSetCorridorColor = options.onSetCorridorColor || (() => { });
        this.onTogglePhysicsDebug = options.onTogglePhysicsDebug || (() => { });
        this.onCycleDebugLayer = options.onCycleDebugLayer || (() => { });
        this.onStartQueuePhase = options.onStartQueuePhase || (() => { });
        this.onSetQueueHour = options.onSetQueueHour || (() => { });
        this.onEndQueuePhase = options.onEndQueuePhase || (() => { });
        this.onStartLocalSimIntro = options.onStartLocalSimIntro || (() => { });
        this.onStartLocalSimIntroThenScenarios = options.onStartLocalSimIntroThenScenarios || (() => { });

        // Scenario comparison callbacks
        this.onScenarioIntervention = options.onScenarioIntervention || (() => { });
        this.onVisualChange = options.onVisualChange || (() => { });
        this.onClockMontageStart = options.onClockMontageStart || (() => { });
        this.onClockMontageDay = options.onClockMontageDay || (() => { });
        this.onClockMontageEnd = options.onClockMontageEnd || (() => { });
        this.onShowMetrics = options.onShowMetrics || (() => { });
        this.onClearMetrics = options.onClearMetrics || (() => { });
        this.onResetSim = options.onResetSim || (() => { });
        this.onShowComparisonTable = options.onShowComparisonTable || (() => { });
        this.onSetMacroParticleDensity = options.onSetMacroParticleDensity || (() => { });
        this.onForceMacroRender = options.onForceMacroRender || (() => { });
        this.onEnterLocalField = options.onEnterLocalField || (() => { });
        this.onPreloadLocalSim = options.onPreloadLocalSim || (() => { });
        this.onShowLiveLogs = options.onShowLiveLogs || (() => { });
        this.onHighlightLots = options.onHighlightLots || (() => { });
        this.onClearLotHighlight = options.onClearLotHighlight || (() => { });
        this.onSetCommuterDebug = options.onSetCommuterDebug || (() => { });
        this.onSetCommuterHeatmap = options.onSetCommuterHeatmap || (() => { });
        this.onShowHourlyTable = options.onShowHourlyTable || (() => { });
        this.onHideHourlyTable = options.onHideHourlyTable || (() => { });
        this.onShowPharrInfraPolygon = options.onShowPharrInfraPolygon || (() => { });
        this.onHidePharrInfraPolygon = options.onHidePharrInfraPolygon || (() => { });

        // Scenario presentation callbacks
        this.onBlurBackground = options.onBlurBackground || (() => { });
        this.onFadeScene = options.onFadeScene || (() => { });
        this.onScenarioCard = options.onScenarioCard || (() => { });
        this.onSetFlowRenderMode = options.onSetFlowRenderMode || (() => { });

        // POE Overlay (bleed visualization)
        this.onSetPoeOverlay = options.onSetPoeOverlay || (() => { });

        // Replay callbacks (temporal projection from terminal state)
        this.onStartReplay = options.onStartReplay || (() => { });
        this.onCommitToLedger = options.onCommitToLedger || (() => { });
        this.onResetLedger = options.onResetLedger || (() => { });
        this.onSetReplayMode = options.onSetReplayMode || (() => { });

        // Pharr world coords getter (for focusLocal)
        this.getPharrCoords = options.getPharrCoords || (() => ({ x: 0, y: 6000 }));

        // Frame target getter (for world-space frame fitting)
        // Returns { x, y, zoom } computed from frame name and current viewport
        this.getFrameTarget = options.getFrameTarget || ((frameName) => {
            // Fallback if not provided - use hardcoded defaults
            const defaults = {
                macro: { x: 9880, y: 382686, zoom: 0.00043 },
                reynosa: { x: -8491, y: -5982, zoom: 0.044 },
            };
            return defaults[frameName] || defaults.reynosa;
        });

        // State
        this.script = [];
        this.instructionIndex = 0;
        this.playing = false;
        this.currentInstruction = null;
        this.instructionStartTime = 0;
        this.instructionProgress = 0;
        this._liveOverlayActive = false;

        // For animations
        this.startState = null;
        this.targetState = null;

        // Label index for jumps
        this.labels = {};
    }

    /**
     * Load a script (array of instructions)
     */
    load(script) {
        this.script = script;
        this.instructionIndex = 0;
        this.playing = false;
        this.currentInstruction = null;

        // Build label index
        this.labels = {};
        script.forEach((instr, i) => {
            if (instr.type === 'label') {
                this.labels[instr.name] = i;
            }
        });

        return this;
    }

    /**
     * Start playback
     */
    play() {
        if (this.script.length === 0) return this;

        this.playing = true;
        this.onPlay();

        // Start first instruction if not already running
        if (!this.currentInstruction) {
            this._startInstruction(0);
        }

        return this;
    }

    /**
     * Pause playback (keeps current position)
     */
    pause() {
        this.playing = false;
        this.onPause();
        return this;
    }

    /**
     * Stop playback and reset to beginning
     */
    stop() {
        this.playing = false;
        this.instructionIndex = 0;
        this.currentInstruction = null;
        this.instructionProgress = 0;
        this.onStop();
        return this;
    }

    /**
     * Check if playing
     */
    isPlaying() {
        return this.playing;
    }

    /**
     * Get current progress (0-1 through entire script)
     */
    getProgress() {
        if (this.script.length === 0) return 0;
        return this.instructionIndex / this.script.length;
    }

    /**
     * Called every frame with delta time (ms)
     */
    tick(dtMs, now = performance.now()) {
        // Update live overlay every frame if active
        if (this._liveOverlayActive) {
            this.onUpdateLiveOverlay();
        }

        if (!this.playing || !this.currentInstruction) return;

        const instr = this.currentInstruction;
        const elapsed = now - this.instructionStartTime;

        switch (instr.type) {
            case 'wait':
                if (elapsed >= instr.duration) {
                    this._nextInstruction(now);
                }
                break;

            case 'panTo':
                this._animateCamera(elapsed, instr, now, true, false);
                break;

            case 'zoomTo':
                this._animateCamera(elapsed, instr, now, false, true);
                break;

            case 'flyTo':
                this._animateCamera(elapsed, instr, now, true, true);
                break;

            case 'focusMacro':
            case 'focusLocal':
            case 'flyToFrame':
                this._animateCamera(elapsed, instr, now, true, true);
                break;

            case 'setHour':
                this.time.setHour(instr.hour);
                this._nextInstruction(now);
                break;

            case 'pause':
                this.time.paused = instr.pause !== false;
                this.onSimPause(this.time.paused);
                this._nextInstruction(now);
                break;

            case 'call':
                if (typeof instr.fn === 'function') {
                    instr.fn();
                }
                this._nextInstruction(now);
                break;

            case 'label':
                // Labels are just markers, skip immediately
                this._nextInstruction(now);
                break;

            case 'loop':
                if (instr.toLabel && this.labels[instr.toLabel] !== undefined) {
                    this._startInstruction(this.labels[instr.toLabel], now);
                } else {
                    this._nextInstruction(now);
                }
                break;

            case 'text':
                this.onText(instr.text, instr.centered);
                this._nextInstruction(now);
                break;

            case 'fadeText':
                this.onFadeText();
                this._nextInstruction(now);
                break;

            case 'macroPause':
                this.onMacroPause(instr.pause !== false);
                this._nextInstruction(now);
                break;

            case 'hideParticles':
                this.onHideParticles(instr.hidden !== false);
                this._nextInstruction(now);
                break;

            case 'showDim':
                this.onShowDim(instr.dim, instr.text);
                this._nextInstruction(now);
                break;

            case 'fadeDims':
                this.onFadeDims(instr.dims);
                this._nextInstruction(now);
                break;

            case 'typeDesc':
                this.onTypeDesc(instr.text);
                this._nextInstruction(now);
                break;

            case 'hideDims':
                this.onHideDims();
                this._nextInstruction(now);
                break;

            case 'shiftDims':
                this.onShiftDims();
                this._nextInstruction(now);
                break;

            // Orientation label instructions
            case 'showSinkLabels':
                this.onShowSinkLabels(instr.topN || 10);
                this._nextInstruction(now);
                break;

            case 'showSinkLabel':
                this.onShowSinkLabel(instr.rank);
                this._nextInstruction(now);
                break;

            case 'showSourceLabels':
                this.onShowSourceLabels(instr.topN || 10);
                this._nextInstruction(now);
                break;

            case 'showPoeLabels':
                this.onShowPoeLabels();
                this._nextInstruction(now);
                break;

            case 'showPoeLabel':
                this.onShowPoeLabel(instr.poe);
                this._nextInstruction(now);
                break;

            case 'hideLabels':
                this.onHideLabels();
                this._nextInstruction(now);
                break;

            case 'showFramingSquare':
                this.onShowFramingSquare(instr.target || 'reynosa');
                this._nextInstruction(now);
                break;

            case 'hideFramingSquare':
                this.onHideFramingSquare();
                this._nextInstruction(now);
                break;

            case 'showInterserranaBox':
                this.onShowInterserranaBox();
                this._nextInstruction(now);
                break;

            case 'hideInterserranaBox':
                this.onHideInterserranaBox();
                this._nextInstruction(now);
                break;

            case 'setCorridorLabelPos':
                this.onSetCorridorLabelPos(instr.corridor, instr.x, instr.y);
                this._nextInstruction(now);
                break;

            case 'showLayerTransitionSquare':
                this.onShowLayerTransitionSquare();
                this._nextInstruction(now);
                break;

            case 'hideLayerTransitionSquare':
                this.onHideLayerTransitionSquare();
                this._nextInstruction(now);
                break;

            case 'devStartComparison':
                this.onDevStartComparison();
                this._nextInstruction(now);
                break;

            case 'devStopComparison':
                this.onDevStopComparison();
                this._nextInstruction(now);
                break;

            case 'snapToFrame':
                this.onSnapToFrame(instr.target || 'reynosa');
                this._nextInstruction(now);
                break;

            case 'startSim':
                this.onStartSim();
                this._nextInstruction(now);
                break;

            case 'highlightCorridors':
                this.onHighlightCorridors(instr.poes || [], instr.equalBrightness || false);
                this._nextInstruction(now);
                break;

            case 'clearCorridorHighlight':
                this.onClearCorridorHighlight();
                this._nextInstruction(now);
                break;

            case 'hideNonHighlighted':
                this.onHideNonHighlighted();
                this._nextInstruction(now);
                break;

            case 'showNonHighlighted':
                this.onShowNonHighlighted();
                this._nextInstruction(now);
                break;

            case 'dimNonHighlighted':
                this.onDimNonHighlighted(instr.dimAlpha || 0.3, instr.highlightAlpha || 1.0);
                this._nextInstruction(now);
                break;

            case 'setCorridorColor':
                this.onSetCorridorColor(instr.poe, instr.color);
                this._nextInstruction(now);
                break;

            case 'dimNonHighlighted':
                this.onDimNonHighlighted(instr.dimAlpha || 0.3, instr.highlightAlpha || 1.0);
                this._nextInstruction(now);
                break;

            case 'setCorridorColor':
                this.onSetCorridorColor(instr.poe, instr.color);
                this._nextInstruction(now);
                break;

            case 'overlay':
                this.onOverlay(
                    instr.text,
                    instr.position || 'top-left',
                    instr.style || 'monospace',
                    instr.indent || 0,
                    instr.treeType || null,
                    instr.colorClass || null
                );
                this._nextInstruction(now);
                break;

            case 'overlayLive':
                // Create live counter element and start updating
                this.onOverlay(
                    instr.text,
                    instr.position || 'top-left',
                    instr.style || 'monospace',
                    instr.indent || 0,
                    instr.treeType || null,
                    instr.colorClass || null
                );
                this._liveOverlayActive = true;
                this._nextInstruction(now);
                break;

            case 'clearOverlays':
                this.onClearOverlays();
                this._liveOverlayActive = false;  // Stop live updates
                this._nextInstruction(now);
                break;

            case 'setScenarioAlpha':
                this.onSetScenarioAlpha(instr.alpha);
                this._nextInstruction(now);
                break;

            case 'switchToInterserrana':
                this.onSwitchToInterserrana();
                this._nextInstruction(now);
                break;

            case 'switchToLayerB':
                // Regime switch: Layer A (geometry) → Layer B (queue equilibrium)
                // Updates weight maps only, does NOT affect overlay scenario (baseline/interserrana)
                this.onSwitchToLayerB();
                this._nextInstruction(now);
                break;

            case 'setPoeMode':
                // Switch POE distribution for particle coloring (independent of routing α)
                // mode: 'baseline' = both slots baseline, 'interserrana' = baseline→interserrana
                this.onSetPoeMode(instr.mode);
                this._nextInstruction(now);
                break;

            case 'advanceEpoch':
                // Advance scenario epoch (gates magenta highlighting to current-epoch particles only)
                this.onAdvanceEpoch();
                this._nextInstruction(now);
                break;

            case 'transitionAlpha':
                this._animateAlpha(elapsed, instr, now);
                break;

            case 'setParticleColorMode':
                this.onSetParticleColorMode(instr.mode);
                this._nextInstruction(now);
                break;

            case 'togglePhysicsDebug':
                this.onTogglePhysicsDebug();
                this._nextInstruction(now);
                break;

            case 'cycleDebugLayer':
                this.onCycleDebugLayer();
                this._nextInstruction(now);
                break;



            case 'startQueuePhase':
                this.onStartQueuePhase();
                this._nextInstruction(now);
                break;

            case 'animateQueueCycle':
                this._animateQueueCycle(elapsed, instr, now);
                break;

            case 'endQueuePhase':
                this.onEndQueuePhase();
                this._nextInstruction(now);
                break;

            case 'preloadLocalSim':
                // Fire and forget - starts loading in background
                this.onPreloadLocalSim();
                this._nextInstruction(now);
                break;

            case 'startLocalSimIntro':
                this.onStartLocalSimIntro();
                // Don't advance - callback will load new script
                break;

            case 'startLocalSimIntroThenScenarios':
                this.onStartLocalSimIntroThenScenarios();
                // Don't advance - callback will load new script
                break;

            // ═══════════════════════════════════════════════════════════
            // SCENARIO COMPARISON INSTRUCTIONS
            // ═══════════════════════════════════════════════════════════

            case 'scenarioIntervention':
                this.onScenarioIntervention(instr.name, instr.intervention);
                this._nextInstruction(now);
                break;

            case 'visualChange':
                this.onVisualChange(instr.effect);
                this._nextInstruction(now);
                break;

            case 'clockMontage':
                this._animateClockMontage(elapsed, instr, now);
                break;

            case 'showMetrics':
                this.onShowMetrics(instr.scenario);
                this._nextInstruction(now);
                break;

            case 'clearMetrics':
                this.onClearMetrics();
                this._nextInstruction(now);
                break;

            case 'resetSim':
                this.onResetSim();
                this._nextInstruction(now);
                break;

            case 'showComparisonTable':
                this.onShowComparisonTable();
                this._nextInstruction(now);
                break;

            // ─── Replay instructions (temporal projection) ───
            case 'startReplay':
                this.onStartReplay(instr.scenario, instr.days || 7);
                this._nextInstruction(now);
                break;

            case 'commitToLedger':
                this.onCommitToLedger(instr.scenario);
                this._nextInstruction(now);
                break;

            case 'resetLedger':
                this.onResetLedger();
                this._nextInstruction(now);
                break;

            case 'setReplayMode':
                // Kinematic replay mode: particles move, interactions frozen
                this.onSetReplayMode(instr.enabled, instr.timeScale || 1);
                this._nextInstruction(now);
                break;

            case 'setMacroParticleDensity':
                this.onSetMacroParticleDensity(instr.multiplier);
                this._nextInstruction(now);
                break;

            case 'forceMacroRender':
                this.onForceMacroRender(instr.enabled);
                this._nextInstruction(now);
                break;

            case 'enterLocalField':
                this.onEnterLocalField();
                this._nextInstruction(now);
                break;

            case 'showLiveLogs':
                this.onShowLiveLogs();
                this._nextInstruction(now);
                break;

            case 'highlightLots':
                this.onHighlightLots();
                this._nextInstruction(now);
                break;

            case 'clearLotHighlight':
                this.onClearLotHighlight();
                this._nextInstruction(now);
                break;

            case 'setCommuterDebug':
                this.onSetCommuterDebug(instr.enabled);
                this._nextInstruction(now);
                break;

            case 'setCommuterHeatmap':
                this.onSetCommuterHeatmap(instr.enabled);
                this._nextInstruction(now);
                break;

            case 'showHourlyTable':
                this.onShowHourlyTable();
                this._nextInstruction(now);
                break;

            case 'hideHourlyTable':
                this.onHideHourlyTable();
                this._nextInstruction(now);
                break;

            case 'showPharrInfraPolygon':
                this.onShowPharrInfraPolygon();
                this._nextInstruction(now);
                break;

            case 'hidePharrInfraPolygon':
                this.onHidePharrInfraPolygon();
                this._nextInstruction(now);
                break;

            case 'setPoeOverlay':
                this.onSetPoeOverlay(instr.enabled, instr.options || {});
                this._nextInstruction(now);
                break;

            // ─── Scenario presentation instructions ───
            case 'blurBackground':
                this.onBlurBackground(instr.enabled);
                this._nextInstruction(now);
                break;

            case 'fadeScene':
                this.onFadeScene(instr.alpha);
                this._nextInstruction(now);
                break;

            case 'scenarioCard':
                this.onScenarioCard(instr.title, instr.toggles || []);
                this._nextInstruction(now);
                break;

            case 'setFlowRenderMode':
                this.onSetFlowRenderMode(instr.mode);
                this._nextInstruction(now);
                break;

            default:
                console.warn(`[Director] Unknown instruction type: ${instr.type}`);
                this._nextInstruction(now);
        }
    }

    /**
     * Animate camera pan/zoom
     */
    _animateCamera(elapsed, instr, now, doPan, doZoom) {
        const duration = instr.duration || 1000;
        const easingFn = Easing[instr.easing] || Easing.smoothstep;

        const t = Math.min(1, elapsed / duration);
        const eased = easingFn(t);

        this.instructionProgress = t;

        if (doPan) {
            const x = this.startState.x + (this.targetState.x - this.startState.x) * eased;
            const y = this.startState.y + (this.targetState.y - this.startState.y) * eased;
            this.camera.centerWorld.x = x;
            this.camera.centerWorld.y = y;
        }

        if (doZoom) {
            // Logarithmic interpolation for zoom (feels more natural)
            const logStart = Math.log(this.startState.zoom);
            const logEnd = Math.log(this.targetState.zoom);
            const logCurrent = logStart + (logEnd - logStart) * eased;
            this.camera.zoom = Math.exp(logCurrent);
        }

        this.camera._updateViewport();

        if (t >= 1) {
            this._nextInstruction(now);
        }
    }

    /**
     * Animate scenario alpha transition
     */
    _animateAlpha(elapsed, instr, now) {
        const duration = instr.duration || 6000;
        const easingFn = Easing[instr.easing] || Easing.smoothstep;

        const t = Math.min(1, elapsed / duration);
        const eased = easingFn(t);

        this.instructionProgress = t;

        const fromAlpha = instr.from ?? 0;
        const toAlpha = instr.to ?? 1;
        const currentAlpha = fromAlpha + (toAlpha - fromAlpha) * eased;

        this.onSetScenarioAlpha(currentAlpha);

        if (t >= 1) {
            this._nextInstruction(now);
        }
    }



    /**
     * Animate through 24-hour queue cycle
     * Hours advance from 0 to 23, calling onSetQueueHour for each
     */
    _animateQueueCycle(elapsed, instr, now) {
        const duration = instr.duration || 12000;  // 12s for full 24h cycle

        const t = Math.min(1, elapsed / duration);
        this.instructionProgress = t;

        // Calculate current hour (0-23)
        const hour = Math.floor(t * 24);
        const clampedHour = Math.min(23, hour);

        // Only call if hour changed
        if (this._lastQueueHour !== clampedHour) {
            this._lastQueueHour = clampedHour;
            this.onSetQueueHour(clampedHour);
        }

        if (t >= 1) {
            this._lastQueueHour = null;
            this._nextInstruction(now);
        }
    }

    /**
     * Animate clock montage (N days compressed to wallSeconds)
     * Fires onClockMontageStart, onClockMontageDay (per hour change), onClockMontageEnd
     *
     * Duration config: wallSeconds controls total duration
     * Each day = wallSeconds / days
     * Each hour = wallSeconds / (days * 24)
     */
    _animateClockMontage(elapsed, instr, now) {
        const days = instr.days || 7;
        const wallMs = (instr.wallSeconds || 10) * 1000;
        const sampleInterval = instr.sampleInterval || 300;  // Default 5min between samples

        const t = Math.min(1, elapsed / wallMs);
        this.instructionProgress = t;

        // Apply easing for non-linear time progression (slow start, fast finish)
        const easingFn = Easing[instr.easing] || Easing.linear;
        const eased = easingFn(t);

        // Fire start callback once
        if (!this._montageFired) {
            this._montageFired = true;
            this._montageLastDay = 0;
            this._montageLastHour = -1;
            this._montageLastSampleIndex = -1;
            this.onClockMontageStart(days);
        }

        // Calculate current day (1-indexed for display) and hour (0-23)
        // Uses eased time for non-linear progression
        const totalHours = eased * days * 24;
        const currentDay = Math.min(days, Math.floor(totalHours / 24) + 1);
        const currentHour = Math.floor(totalHours % 24);

        // Calculate sample index (samples at sampleInterval seconds)
        const totalSeconds = totalHours * 3600;
        const sampleIndex = Math.floor(totalSeconds / sampleInterval);

        // Fire callback when hour OR day changes (drives both clock and day counter)
        // Also pass sample index for data binding
        if (currentHour !== this._montageLastHour || currentDay !== this._montageLastDay) {
            this._montageLastDay = currentDay;
            this._montageLastHour = currentHour;
            this._montageLastSampleIndex = sampleIndex;
            this.onClockMontageDay(currentDay, days, currentHour, sampleIndex);
        }

        if (t >= 1) {
            this._montageFired = false;
            this._montageLastDay = 0;
            this._montageLastHour = -1;
            this._montageLastSampleIndex = -1;
            this.onClockMontageEnd();
            this._nextInstruction(now);
        }
    }

    /**
     * Start a specific instruction
     */
    _startInstruction(index, now = performance.now()) {
        if (index >= this.script.length) {
            // Script complete
            this.playing = false;
            this.currentInstruction = null;
            this.onStop();
            return;
        }

        this.instructionIndex = index;
        this.currentInstruction = this.script[index];
        this.instructionStartTime = now;
        this.instructionProgress = 0;

        const instr = this.currentInstruction;

        // Capture start state for animations
        this.startState = {
            x: this.camera.centerWorld.x,
            y: this.camera.centerWorld.y,
            zoom: this.camera.zoom,
        };

        // Compute target state
        switch (instr.type) {
            case 'panTo':
                this.targetState = { x: instr.x, y: instr.y, zoom: this.camera.zoom };
                break;

            case 'zoomTo':
                this.targetState = { ...this.startState, zoom: instr.zoom };
                break;

            case 'flyTo':
                this.targetState = { x: instr.x, y: instr.y, zoom: instr.zoom };
                break;

            case 'focusMacro':
                this.targetState = this.getFrameTarget('macro');
                break;

            case 'focusLocal':
                this.targetState = this.getFrameTarget('reynosa');
                break;

            case 'flyToFrame': {
                // Animated transition to a named world-space frame
                const target = this.getFrameTarget(instr.frame);
                this.targetState = target;
                break;
            }

            default:
                this.targetState = { ...this.startState };
        }

        this.onInstructionStart(instr, index);
    }

    /**
     * Move to next instruction
     */
    _nextInstruction(now) {
        this.onInstructionEnd(this.currentInstruction, this.instructionIndex);
        this._startInstruction(this.instructionIndex + 1, now);
    }

    /**
     * Skip current instruction (dev tool)
     */
    skip() {
        if (!this.playing) return;
        this._nextInstruction(performance.now());
    }
}

/**
 * Helper to create common scripts
 */
export const Scripts = {
    /**
     * A simple intro sequence: starts macro, waits, zooms to local
     */
    intro(waitTime = 3000) {
        return [
            { type: 'focusMacro', duration: 0 },
            { type: 'wait', duration: waitTime },
            { type: 'focusLocal', duration: 3000, easing: 'easeInOutCubic' },
        ];
    },

    /**
     * Narrative intro: 5 beats + orientation labels + framing snap
     */
    narrativeIntro() {
        return [
            // Beat 1-2: Centered intro text
            { type: 'text', text: 'Este sistema observa 56 millones de toneladas de carga exportadas por camión de México a Estados Unidos.', centered: true },
            { type: 'wait', duration: 7500 },
            { type: 'text', text: 'La logística binacional se describe en tres dimensiones.', centered: true },
            { type: 'wait', duration: 7500 },
            { type: 'fadeText' },
            { type: 'wait', duration: 500 },

            // Phase 1: Show three dimension names centered
            { type: 'showDim', dim: 1, text: 'Distancia efectiva' },
            { type: 'wait', duration: 2500 },
            { type: 'showDim', dim: 2, text: 'Infraestructura de los cruces' },
            { type: 'wait', duration: 2500 },
            { type: 'showDim', dim: 3, text: 'Relaciones institucionales' },
            { type: 'wait', duration: 6000 },

            // Phase 2: Shift dims to right, then particles on
            { type: 'shiftDims' },
            { type: 'wait', duration: 1200 },
            { type: 'macroPause', pause: false },
            { type: 'wait', duration: 1500 },

            // Phase 3: Fade dims 2 & 3, keep dim 1 bright
            { type: 'fadeDims', dims: [2, 3] },
            { type: 'wait', duration: 10000 },

            // Phase 4: Typewriter description under dim 1
            { type: 'typeDesc', text: 'Recursos' },
            { type: 'wait', duration: 1400 },
            { type: 'typeDesc', text: ', esfuerzo' },
            { type: 'wait', duration: 1400 },
            { type: 'typeDesc', text: ' y <span class="bold">tiempo</span>.' },
            { type: 'wait', duration: 3000 },

            // Phase 5: Origin/destination nodes (top 10 each, weighted circles)
            { type: 'showSourceLabels', topN: 10 },
            { type: 'showSinkLabels', topN: 10 },
            { type: 'wait', duration: 12000 },
            { type: 'hideLabels' },
            { type: 'wait', duration: 500 },

            // Phase 6: Corridor highlight - magenta on laredo/pharr, others stay normal
            { type: 'highlightCorridors', poes: ['hidalgo_pharr', 'hidalgo_pharr'] },
            { type: 'wait', duration: 5000 },

            // Phase 7: Hide other particles + show POE labels (simultaneous)
            { type: 'hideNonHighlighted' },
            { type: 'showPoeLabels' },
            { type: 'wait', duration: 5000 },

            // Phase 8: Hide labels (keep magenta + hidden particles)
            { type: 'hideLabels' },
            { type: 'wait', duration: 3000 },

            // Phase 9: Draw framing square + start sim (silent, magenta still on)
            { type: 'showFramingSquare', target: 'reynosa' },
            { type: 'startSim' },
            { type: 'wait', duration: 3000 },

            // Phase 10: Instant snap to Reynosa frame + restore normal view
            { type: 'hideFramingSquare' },
            { type: 'snapToFrame', target: 'reynosa' },
            { type: 'clearCorridorHighlight' },
        ];
    },

    /**
     * Macro tour: pan across corridor network
     */
    corridorTour(panDuration = 4000) {
        return [
            { type: 'focusMacro', duration: 1500, easing: 'smoothstep' },
            { type: 'wait', duration: 1000 },
            { type: 'panTo', x: -50000, y: 120000, duration: panDuration, easing: 'smoothstep' },
            { type: 'wait', duration: 500 },
            { type: 'panTo', x: 50000, y: 40000, duration: panDuration, easing: 'smoothstep' },
            { type: 'wait', duration: 500 },
            { type: 'focusMacro', duration: 2000, easing: 'smoothstep' },
        ];
    },

    /**
     * Zoom cycle: macro -> local -> macro
     */
    zoomCycle(holdTime = 5000) {
        return [
            { type: 'label', name: 'start' },
            { type: 'focusMacro', duration: 2000, easing: 'smoothstep' },
            { type: 'wait', duration: holdTime },
            { type: 'focusLocal', duration: 3000, easing: 'easeInOutCubic' },
            { type: 'wait', duration: holdTime },
            { type: 'loop', toLabel: 'start' },
        ];
    },

    /**
     * Day timelapse: cycle through hours
     */
    dayTimelapse(hourDuration = 500) {
        const instructions = [
            { type: 'setHour', hour: 0 },
            { type: 'pause', pause: false },
        ];
        for (let h = 0; h < 24; h++) {
            instructions.push({ type: 'setHour', hour: h });
            instructions.push({ type: 'wait', duration: hourDuration });
        }
        return instructions;
    },

    /**
     * Alien Observer mode: cold mechanical observation.
     * No narration. State changes and silence only.
     *
     * Full sequence:
     *   Phase 0-4: Macro view with telemetry overlays
     *   Phase 5: Transition to local sim (Reynosa corridor)
     *   Phase 6: Local sim intro with model spec telemetry
     *   Phase 7: Scenario comparison with temporal replay
     *     - Baseline, Twinspan, Interserrana, Inovus
     *     - Kinematic particle replay (REPLAY_MODE)
     *     - Counter interpolation from pre-computed results
     *     - Cumulative ledger commits
     */
    alienObserver() {
        return [
            // ─────────────────────────────────────────────────────────────
            // PHASE 0: Immediate gravity field visualization (0–3s)
            // Particles flow, gravity wells active (no labels yet)
            // ─────────────────────────────────────────────────────────────
            { type: 'snapToFrame', target: 'opening' },
            { type: 'macroPause', pause: false },
            { type: 'showSourceLabels', topN: 100 },  // All sources - gravity wells active
            { type: 'wait', duration: 3000 },

            // ─────────────────────────────────────────────────────────────
            // PHASE 1: Telemetry appears over living field (30–81s)
            // Overlays stack lightly. Hard cut, no animation, corners only.
            // Layer A block: model parameters, not narrative.
            // ─────────────────────────────────────────────────────────────
            { type: 'overlay', text: '56.0 Mt / año', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Unidad: Flujo (30t)', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Composición: Origen × Cruce × Destino × HS2', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Orígenes: 41', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Destinos: 105', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Modo: Dijkstra distancia en red', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Asignación: Flujo determinista no divisible', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Sentido: Sur → Norte', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Período: 2024–2025', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 6000 },

            // ─────────────────────────────────────────────────────────────
            // PHASE 1: Clear text, show destination labels
            // Metrics fade, destination labels appear
            // ─────────────────────────────────────────────────────────────
            { type: 'clearOverlays' },
            { type: 'showSinkLabels', topN: 5 },      // Top 5 US destinations with labels
            { type: 'wait', duration: 15000 },
            { type: 'hideLabels' },
            { type: 'wait', duration: 1000 },

            // ─────────────────────────────────────────────────────────────
            // PHASE 2: Bleed on Adapted Geometry (α=1)
            // ─────────────────────────────────────────────────────────────
            // SEMANTIC: "After adaptation, these stress points remain."
            // Bleed is a stress fracture diagram showing where pressure concentrates.
            // Rays enabled BEFORE alpha switch so they're visible through transition.
            // ─────────────────────────────────────────────────────────────
            // Beat 1: Feasibility rays (dashed) — enabled before alpha switch
            { type: 'setPoeOverlay', enabled: true, options: { nodes: false, bleedRays: true, ghostTrails: false, textAnchor: false, flipClassFilter: 'feasibility' } },
            { type: 'wait', duration: 2000 },

            // Switch to baseline routing (α=1) with rays visible
            { type: 'setScenarioAlpha', alpha: 1.0 },
            { type: 'setPoeMode', mode: 'baseline' },  // Particles respawn with baseline POEs
            { type: 'wait', duration: 2000 },

            // Beat 2: Congestion rays (solid) — capacity saturation
            { type: 'setPoeOverlay', enabled: true, options: { nodes: false, bleedRays: true, ghostTrails: false, textAnchor: false, flipClassFilter: 'congestion' } },
            { type: 'wait', duration: 4000 },

            // Turn off rays
            { type: 'setPoeOverlay', enabled: false },
            { type: 'wait', duration: 1000 },

            // ─────────────────────────────────────────────────────────────
            // PHASE 3: Corridor highlight - magenta on laredo/pharr
            // ─────────────────────────────────────────────────────────────
            // Both corridors magenta, same alpha; others dimmed (not hidden)
            { type: 'advanceEpoch' },
            { type: 'highlightCorridors', poes: ['hidalgo_pharr', 'hidalgo_pharr'], equalBrightness: true },
            { type: 'dimNonHighlighted', dimAlpha: 0.8 },
            { type: 'wait', duration: 5000 },

            // Show POE label (Pharr only, no Laredo)
            { type: 'showPoeLabel', poe: 'hidalgo_pharr' },
            { type: 'wait', duration: 5000 },

            // Laredo → white (pharr remains sole magenta)
            { type: 'setCorridorColor', poe: 'laredo', color: 'white' },
            { type: 'wait', duration: 3000 },

            // Framing square + start sim
            { type: 'showFramingSquare', target: 'reynosa' },
            { type: 'startSim' },
            { type: 'wait', duration: 3000 },

            // Snap to local view
            { type: 'hideFramingSquare' },
            { type: 'snapToFrame', target: 'localSimIntro' },
            { type: 'clearCorridorHighlight' },

            // Chain to local sim intro + scenario comparison (full sequence)
            { type: 'startLocalSimIntroThenScenarios' },
        ];
    },

    /**
     * Local sim intro: stacked telemetry with tree breakdowns and sync points.
     * Requires getModelSpec() from reynosaOverlay_v2.js.
     *
     * ModelSpec items have:
     *   - key: string identifier
     *   - value: display text
     *   - live?: boolean (updates every frame)
     *   - indent?: 1 or 2 (tree depth)
     *   - tree?: 'tree' | 'tree-last' | 'tree-cont'
     *   - syncPoint?: 'SOURCE_MODE_START' | 'SOURCE_MODE_END' | 'LOTS'
     *   - groupStart?: string (start batching items - no wait until groupEnd)
     *   - group?: string (continue batching - no wait)
     *   - groupEnd?: boolean (end batch - add single wait)
     */
    localSimIntro(modelSpec) {
        if (!modelSpec || !Array.isArray(modelSpec)) {
            console.warn('[Director] localSimIntro requires modelSpec array');
            return [];
        }

        const BEAT = 4000;
        const instructions = [];
        let inGroup = null;  // Track active group name
        let stateColorActive = false;   // Track STATE mode for orange coloring
        let sourceColorActive = false;  // Track SOURCE mode for corridor coloring

        // Start with the local sim intro frame and enter LOCAL_FIELD state
        instructions.push({ type: 'snapToFrame', target: 'localSimIntro' });
        instructions.push({ type: 'enterLocalField' });

        for (const item of modelSpec) {
            // Check if this item STARTS a color mode (set BEFORE overlay so it gets the color)
            if (item.syncPoint === 'STATE_MODE_START') stateColorActive = true;
            if (item.syncPoint === 'SOURCE_MODE_START') sourceColorActive = true;

            // Determine color class based on active mode and item key
            // Uses CSS classes so colors can sync with particle mode changes
            let colorClass = null;
            if (stateColorActive && item.key === 'seg_transfer') {
                colorClass = 'color-state';  // Orange only for NecesidadTransfer
            } else if (sourceColorActive) {
                if (item.key === 'orig_mty') colorClass = 'color-source-mty';       // Red
                else if (item.key === 'orig_vic') colorClass = 'color-source-vic';  // Blue
                else if (item.key?.startsWith('orig_')) colorClass = 'color-source-local';  // Green
            }

            // Add overlay instruction
            if (item.live) {
                instructions.push({
                    type: 'overlayLive',
                    text: item.value,
                    indent: item.indent || 0,
                    treeType: item.tree || null,
                    colorClass: colorClass
                });
            } else {
                instructions.push({
                    type: 'overlay',
                    text: item.value,
                    position: 'top-left',
                    style: 'monospace',
                    indent: item.indent || 0,
                    treeType: item.tree || null,
                    colorClass: colorClass
                });
            }

            // Check if this item ENDS a color mode (AFTER overlay so the ending item still gets color)
            if (item.syncPoint === 'STATE_MODE_END') stateColorActive = false;
            if (item.syncPoint === 'SOURCE_MODE_END' || item.syncPoint === 'PHI_DEBUG_START') sourceColorActive = false;

            // Handle group batching
            if (item.groupStart) {
                inGroup = item.groupStart;
            }

            // Handle sync points
            if (item.syncPoint === 'SOURCE_MODE_START') {
                instructions.push({ type: 'setParticleColorMode', mode: 2 });      // SOURCE mode ON
                instructions.push({ type: 'showSourceLabels', topN: 3 });          // Corridor + Industrial labels
                instructions.push({ type: 'wait', duration: BEAT });
            } else if (item.syncPoint === 'SOURCE_MODE_END') {
                instructions.push({ type: 'setParticleColorMode', mode: 0 });      // SOURCE mode OFF
                instructions.push({ type: 'hideLabels' });
                instructions.push({ type: 'wait', duration: BEAT });
            } else if (item.syncPoint === 'STATE_MODE_START') {
                instructions.push({ type: 'setParticleColorMode', mode: 3 });      // STATE mode ON (orange=restricted, cyan=cleared)
                instructions.push({ type: 'wait', duration: BEAT });
            } else if (item.syncPoint === 'STATE_MODE_END') {
                instructions.push({ type: 'setParticleColorMode', mode: 0 });      // STATE mode OFF
                instructions.push({ type: 'wait', duration: BEAT });
            } else if (item.syncPoint === 'PHI_DEBUG_START') {
                // End source mode + show φ_base cost gradient (Dijkstra potential field)
                instructions.push({ type: 'setParticleColorMode', mode: 0 });      // SOURCE mode OFF
                instructions.push({ type: 'hideLabels' });
                instructions.push({ type: 'togglePhysicsDebug' });                 // Debug ON
                instructions.push({ type: 'cycleDebugLayer' });                    // Layer 0 → 1 (φ_base)
                instructions.push({ type: 'wait', duration: BEAT });
            } else if (item.syncPoint === 'PHI_DEBUG_END') {
                // Keep debug visible through this item, then turn off
                instructions.push({ type: 'wait', duration: BEAT });
                instructions.push({ type: 'togglePhysicsDebug' });                 // Debug OFF
            } else if (item.syncPoint === 'COMMUTER_DEBUG_START') {
                instructions.push({ type: 'setCommuterHeatmap', enabled: true });  // Commuter heatmap ON
                instructions.push({ type: 'wait', duration: BEAT });
            } else if (item.syncPoint === 'COMMUTER_DEBUG_END') {
                instructions.push({ type: 'wait', duration: BEAT });
                instructions.push({ type: 'setCommuterHeatmap', enabled: false }); // Commuter heatmap OFF
            } else if (item.syncPoint === 'PHARR_INFRA_START') {
                // Show PHARR CBP infrastructure polygon
                instructions.push({ type: 'showPharrInfraPolygon' });
                instructions.push({ type: 'wait', duration: BEAT });
            } else if (item.syncPoint === 'LOTS') {
                instructions.push({ type: 'hidePharrInfraPolygon' });  // Hide before lots highlight
                instructions.push({ type: 'highlightLots' });
                instructions.push({ type: 'wait', duration: BEAT });
                instructions.push({ type: 'clearLotHighlight' });
            } else if (item.syncPoint === 'HOURLY_TABLE_START') {
                instructions.push({ type: 'showHourlyTable' });
                instructions.push({ type: 'wait', duration: BEAT });
            } else if (item.syncPoint === 'HOURLY_TABLE_END') {
                instructions.push({ type: 'wait', duration: BEAT });
                instructions.push({ type: 'hideHourlyTable' });
            } else if (inGroup && !item.groupEnd) {
                // Inside a group but not the last item - skip wait
                // (items appear together without stagger)
            } else if (item.groupEnd) {
                // End of group - add single wait for the whole batch
                instructions.push({ type: 'wait', duration: BEAT });
                inGroup = null;
            } else {
                // Normal item - add wait
                instructions.push({ type: 'wait', duration: BEAT });
            }
        }

        // Final phases - clean state for scenario comparison handoff
        instructions.push({ type: 'wait', duration: 2000 });
        instructions.push({ type: 'clearOverlays' });
        instructions.push({ type: 'setParticleColorMode', mode: 0 });       // Reset to default (no coloring)
        instructions.push({ type: 'wait', duration: 3000 });

        return instructions;
    },

    /**
     * @deprecated Use alienObserver() instead — it now includes scenario comparison.
     *
     * Legacy duplicate kept for backwards compatibility.
     */
    alienObserverWithScenarios() {
        return [
            // ─────────────────────────────────────────────────────────────
            // PHASE 0-4: Same as alienObserver()
            // ─────────────────────────────────────────────────────────────
            { type: 'snapToFrame', target: 'opening' },
            { type: 'macroPause', pause: false },
            { type: 'showSourceLabels', topN: 100 },
            { type: 'wait', duration: 3000 },

            // Phase 1: Telemetry
            // Start loading local sim in background (takes ~500-1000ms)
            { type: 'preloadLocalSim' },
            { type: 'overlay', text: '56.0 Mt / año', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Unidad: Flujo (30t)', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Composición: Origen × Cruce × Destino × HS2', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Orígenes: 41', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Destinos: 105', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Modo: Dijkstra distancia en red', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Asignación: Flujo determinista no divisible', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Sentido: Sur → Norte', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 5000 },
            { type: 'overlay', text: 'Período: 2024–2025', position: 'top-left', style: 'monospace' },
            { type: 'wait', duration: 6000 },

            // Phase 1: Destination labels
            { type: 'clearOverlays' },
            { type: 'showSinkLabels', topN: 5 },
            { type: 'wait', duration: 15000 },
            { type: 'hideLabels' },
            { type: 'wait', duration: 1000 },

            // Phase 2: Bleed on Adapted Geometry (α=1)
            // SEMANTIC: "After adaptation, these stress points remain."
            // Switch to baseline routing (α=1)
            { type: 'setScenarioAlpha', alpha: 1.0 },
            // Dual Rays (Feasibility + Congestion)
            { type: 'setPoeOverlay', enabled: true, options: { nodes: false, bleedRays: true, ghostTrails: false, textAnchor: false, flipClassFilter: null } },
            { type: 'wait', duration: 6000 },

            // Turn off rays
            { type: 'setPoeOverlay', enabled: false },
            { type: 'wait', duration: 1000 },

            // ─────────────────────────────────────────────────────────────
            // PHASE 3: Corridor highlight - magenta on laredo/pharr
            // ─────────────────────────────────────────────────────────────
            // Both corridors magenta, same alpha; others dimmed (not hidden)
            { type: 'advanceEpoch' },
            { type: 'highlightCorridors', poes: ['hidalgo_pharr', 'hidalgo_pharr'], equalBrightness: true },
            { type: 'dimNonHighlighted', dimAlpha: 0.8 },
            { type: 'wait', duration: 5000 },

            // Show POE label (Pharr only, no Laredo)
            { type: 'showPoeLabel', poe: 'hidalgo_pharr' },
            { type: 'wait', duration: 5000 },

            // Laredo → white (pharr remains sole magenta)
            { type: 'setCorridorColor', poe: 'laredo', color: 'white' },
            { type: 'wait', duration: 3000 },

            // Framing square + start sim
            { type: 'showFramingSquare', target: 'reynosa' },
            { type: 'startSim' },
            { type: 'wait', duration: 3000 },

            // Snap to local view
            { type: 'hideFramingSquare' },
            { type: 'snapToFrame', target: 'localSimIntro' },
            { type: 'clearCorridorHighlight' },

            // Chain to local sim intro, then scenario comparison
            { type: 'startLocalSimIntroThenScenarios' },
        ];
    },

    /**
     * Scenario Comparison sequence (Temporal Replay)
     *
     * Runs after local sim intro completes.
     * Each scenario is presented as a time-compressed replay:
     * - Counters start at 0, interpolate to final values during clockMontage
     * - Results are committed to cumulative ledger (irreversible)
     *
     * FIXED NARRATIVE ORDER — scenarios are additive layers, not alternatives:
     *   1. Baseline
     *   2. Twinspan
     *   3. Interserrana + Twinspan
     *   4. Interserrana + Twinspan + Inovus
     */
    scenarioComparison() {
        return [
            // ─────────────────────────────────────────────────────────────
            // PHASE 6: SCENARIO COMPARISON (temporal replay from results)
            // FIXED ORDER — additive infrastructure layers
            // Replay uses sampled data, not live sim - clear all particles
            // ─────────────────────────────────────────────────────────────

            // Clear and pause local sim - replay is a separate system
            { type: 'resetSim' },
            { type: 'pause', pause: true },        // Pause local sim physics
            { type: 'macroPause', pause: true },

            // Reset ledger for fresh comparison
            { type: 'resetLedger' },

            // Snap to tighter frame for scenario runs
            { type: 'snapToFrame', target: 'scenarioRun' },

            // ═══════════════════════════════════════════════════════════
            // LAYER 0: BASELINE — current state
            // ═══════════════════════════════════════════════════════════

            // Scenario card (cognitive hard cut)
            { type: 'blurBackground', enabled: true },
            { type: 'fadeScene', alpha: 0.4 },
            { type: 'scenarioCard', title: 'Baseline', toggles: [] },
            { type: 'wait', duration: 2000 },
            { type: 'blurBackground', enabled: false },
            { type: 'fadeScene', alpha: 1.0 },
            { type: 'wait', duration: 2000 },  // Pre-replay hold

            { type: 'scenarioIntervention', name: 'BASELINE', intervention: null },
            { type: 'startReplay', scenario: 'Baseline', days: 7 },
            { type: 'setReplayMode', enabled: true, timeScale: 168 },
            { type: 'setFlowRenderMode', mode: 'ROAD_HEATMAP' },
            { type: 'clockMontage', days: 7, wallSeconds: 16, easing: 'easeInQuad' },
            { type: 'setFlowRenderMode', mode: 'PARTICLES' },
            { type: 'commitToLedger', scenario: 'Baseline' },
            { type: 'setReplayMode', enabled: false },
            { type: 'wait', duration: 4000 },  // Post-replay hold
            { type: 'clearMetrics' },
            { type: 'setHour', hour: 0 },          // Reset clock to start

            // ═══════════════════════════════════════════════════════════
            // LAYER 1: TWINSPAN — CBP capacity doubled
            // ═══════════════════════════════════════════════════════════

            // Scenario card
            { type: 'blurBackground', enabled: true },
            { type: 'fadeScene', alpha: 0.4 },
            { type: 'scenarioCard', title: 'Twinspan', toggles: ['Twinspan'] },
            { type: 'wait', duration: 2000 },
            { type: 'blurBackground', enabled: false },
            { type: 'fadeScene', alpha: 1.0 },

            { type: 'scenarioIntervention', name: 'TWINSPAN', intervention: '+ CBP ×2' },

            // Fly to bridge detail, activate Twinspan, then return
            { type: 'snapToFrame', target: 'twinspan' },
            { type: 'wait', duration: 3000 },
            { type: 'visualChange', effect: 'cbpLanesDouble' },
            { type: 'wait', duration: 5000 },
            { type: 'snapToFrame', target: 'scenarioRun' },

            { type: 'startReplay', scenario: 'Twinspan', days: 7 },
            { type: 'setReplayMode', enabled: true, timeScale: 168 },
            { type: 'setFlowRenderMode', mode: 'ROAD_HEATMAP' },
            { type: 'clockMontage', days: 7, wallSeconds: 16, easing: 'easeInQuad' },
            { type: 'setFlowRenderMode', mode: 'PARTICLES' },
            { type: 'commitToLedger', scenario: 'Twinspan' },
            { type: 'setReplayMode', enabled: false },
            { type: 'wait', duration: 4000 },
            { type: 'clearMetrics' },
            { type: 'setHour', hour: 0 },          // Reset clock to start

            // ═══════════════════════════════════════════════════════════
            // LAYER 2: InovusTwinspan — Twinspan + Inovus lots
            // ═══════════════════════════════════════════════════════════

            // Scenario card
            { type: 'blurBackground', enabled: true },
            { type: 'fadeScene', alpha: 0.4 },
            { type: 'scenarioCard', title: 'Twinspan + Inovus', toggles: ['Twinspan', 'Inovus'] },
            { type: 'wait', duration: 2000 },
            { type: 'blurBackground', enabled: false },
            { type: 'fadeScene', alpha: 1.0 },

            { type: 'scenarioIntervention', name: 'InovusTwinspan', intervention: '+ Patios Inovus' },
            { type: 'visualChange', effect: 'inovusFull' },
            { type: 'wait', duration: 3000 },
            { type: 'startReplay', scenario: 'InovusTwinspan', days: 7 },
            { type: 'setReplayMode', enabled: true, timeScale: 168 },
            { type: 'setFlowRenderMode', mode: 'ROAD_HEATMAP' },
            { type: 'clockMontage', days: 7, wallSeconds: 16, easing: 'easeInQuad' },
            { type: 'setFlowRenderMode', mode: 'PARTICLES' },
            { type: 'commitToLedger', scenario: 'InovusTwinspan' },
            { type: 'setReplayMode', enabled: false },
            { type: 'wait', duration: 4000 },
            { type: 'clearMetrics' },
            { type: 'setHour', hour: 0 },          // Reset clock to start

            // ═══════════════════════════════════════════════════════════
            // LAYER 3: InovusTwinspanInterserrana — full stack + routing
            // ═══════════════════════════════════════════════════════════

            // Scenario card
            { type: 'blurBackground', enabled: true },
            { type: 'fadeScene', alpha: 0.4 },
            { type: 'scenarioCard', title: 'Full Stack', toggles: ['Twinspan', 'Inovus', 'Interserrana'] },
            { type: 'wait', duration: 2000 },
            { type: 'blurBackground', enabled: false },
            { type: 'fadeScene', alpha: 1.0 },

            { type: 'scenarioIntervention', name: 'InovusTwinspanInterserrana', intervention: '+ Interserrana' },

            // Show routing change visually (zoom out to show Pharr + Laredo corridors)
            { type: 'macroPause', pause: false },  // Resume macro particles for corridor visualization
            { type: 'forceMacroRender', enabled: true },
            { type: 'setMacroParticleDensity', multiplier: 2.5 },
            { type: 'setMacroParticleDensity', multiplier: 2.5 },
            { type: 'advanceEpoch' },
            { type: 'setPoeMode', mode: 'interserrana' },                        // Particles respawn with interserrana POEs
            // Pharr highlighted (magenta) immediately on entering Layer 3
            { type: 'highlightCorridors', poes: ['hidalgo_pharr', 'hidalgo_pharr'], equalBrightness: true },
            { type: 'setCorridorColor', poe: 'laredo', color: 'white' },
            { type: 'dimNonHighlighted', dimAlpha: 0.8 },
            { type: 'snapToFrame', target: 'interserrana' },                     // Immediate snap to wide view
            { type: 'wait', duration: 8000 },                                    // 8s hold
            { type: 'showInterserranaBox' },                                     // Show box 2s before activation
            { type: 'wait', duration: 2000 },                                    // 2s with box visible
            { type: 'setScenarioAlpha', alpha: 1.0 },                            // Trigger routing change
            { type: 'wait', duration: 4000 },                                    // 4s after activation (3s total box)
            { type: 'hideInterserranaBox' },                                     // Hide box
            { type: 'wait', duration: 14000 },                                   // 14s remaining hold
            { type: 'snapToFrame', target: 'scenarioRun' },                      // Immediate snap back
            { type: 'clearCorridorHighlight' },                                  // Restore normal corridors
            { type: 'setMacroParticleDensity', multiplier: 1.0 },
            { type: 'forceMacroRender', enabled: false },

            // ═══════════════════════════════════════════════════════════
            // POST-INTERSERRANA SOURCE MODE — Show corridor split at new position
            // ═══════════════════════════════════════════════════════════
            { type: 'wait', duration: 2000 },                                        // 2s after zoom back
            { type: 'setCorridorLabelPos', corridor: 'ENTRY_MTY', x: -11772.40, y: -15007.48 },
            { type: 'setParticleColorMode', mode: 2 },                              // SOURCE mode ON
            { type: 'showSourceLabels', topN: 3 },                                  // Show corridor labels
            { type: 'wait', duration: 8000 },                                       // Hold for 8s
            { type: 'setParticleColorMode', mode: 0 },                              // SOURCE mode OFF
            { type: 'hideLabels' },
            { type: 'setCorridorLabelPos', corridor: 'ENTRY_MTY', x: null, y: null }, // Clear override

            // Replay 7 days
            { type: 'startReplay', scenario: 'InovusTwinspanInterserrana', days: 7 },
            { type: 'setReplayMode', enabled: true, timeScale: 168 },
            { type: 'setFlowRenderMode', mode: 'ROAD_HEATMAP' },
            { type: 'clockMontage', days: 7, wallSeconds: 16, easing: 'easeInQuad' },
            { type: 'setFlowRenderMode', mode: 'PARTICLES' },
            { type: 'commitToLedger', scenario: 'InovusTwinspanInterserrana' },
            { type: 'setReplayMode', enabled: false },
            { type: 'wait', duration: 4000 },
            { type: 'clearMetrics' },

            // ═══════════════════════════════════════════════════════════
            // SYNTHESIS — show final ledger
            // ═══════════════════════════════════════════════════════════
            { type: 'wait', duration: 2000 },
            // Ledger is already visible from cumulative commits
            // Final pause for review
            { type: 'wait', duration: 10000 },

            // Reset sim to clean state (replay corrupted physics state)
            { type: 'resetSim' },
        ];
    },

    /**
     * Quarantined copy from narrativeIntro.
     * For investor decks, grant submissions, political briefings.
     * Never rendered at runtime.
     */
    copyArchive: {
        intro_1: 'Este sistema observa 56 millones de toneladas de carga exportadas por camión de México a Estados Unidos.',
        intro_2: 'La logística binacional se describe en tres dimensiones.',
        dim_1: 'Distancia efectiva',
        dim_2: 'Infraestructura de los cruces',
        dim_3: 'Relaciones institucionales',
        typewriter: ['Recursos', ', esfuerzo', ' y <span class="bold">tiempo</span>.'],
    },
};

export { Easing };
