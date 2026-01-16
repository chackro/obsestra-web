# FIELD Class System Implementation Tracker

> **Created:** 2025-12-15
> **Goal:** Transform single-density FIELD into two-class (restricted/cleared) system with conversion
> **Target:** Demonstrate "organized yard vs chaotic spillback" value proposition
>
> **NOTE:** `engine/fieldPhysics.js` was DELETED. All physics is now in `overlay/reynosaOverlay.js`.
> References to fieldPhysics.js below are historical records of planning/implementation work.

---

## Current State Summary

| Layer | Status | Notes |
|-------|--------|-------|
| K tensor pipeline | ✅ DONE | segment weights → interpolated K |
| Alpha driver | ✅ DONE | monotonic α(t), curves work |
| Scenario pairs | ✅ DONE | load, validate, interpolate |
| Single-density physics | ✅ DONE | advection, inject, drain |
| Geometry provider | ✅ DONE | bounds, roads, sinks |
| Multi-class density | ❌ TODO | need ρ_c arrays |
| Class definitions | ❌ TODO | need ClassDef schema |
| Region definitions | ❌ TODO | need RegionDef, is_storage |
| Conversion operator | ❌ TODO | T_{c→d} mechanics |
| Class-aware drain | ❌ TODO | eligibility check |

---

## Implementation Phases

### Phase 1: Schemas & Configs ✅ COMPLETE
*Define the data structures before any physics changes*

| Task | File | Status | Notes |
|------|------|--------|-------|
| 1.1 ClassDef schema | `engine/classSystem.js` | ✅ | id, conductance_scale, sink_eligibility, region_access |
| 1.2 RegionDef schema | `engine/classSystem.js` | ✅ | id, type, is_storage, conversion_rule_ids |
| 1.3 SinkDef schema | `engine/classSystem.js` | ✅ | id, eligible_classes, uses_bundle_capacity |
| 1.4 ConversionRule schema | `engine/classSystem.js` | ✅ | from/to class, region, mode, dwell_time_s |
| 1.5 V1_CLASSES config | `engine/classSystem.js` | ✅ | restricted (can't drain), cleared (can drain) |
| 1.6 V1_REGIONS config | `engine/classSystem.js` | ✅ | corridor (K=1.0), yard_main (K=0.3, storage) |
| 1.7 V1_SINKS config | `engine/classSystem.js` | ✅ | pharr_main (cleared only) |
| 1.8 V1_CONVERSIONS config | `engine/classSystem.js` | ✅ | yard_transfer: restricted→cleared, 30min dwell |

**Acceptance:** ✅ File exports schemas and v1 configs. Validation passes. Helpers work.

---

### Phase 2: Multi-Class Field Arrays ✅ COMPLETE
*Add per-class density arrays to fieldPhysics.js*

| Task | File | Status | Notes |
|------|------|--------|-------|
| 2.1 Add ρ_c arrays | `engine/fieldPhysics.js` | ✅ | _classRho Map<classId, Float32Array> |
| 2.2 Add class registry | `engine/fieldPhysics.js` | ✅ | _activeClassIds, _classScratch |
| 2.3 Init function accepts classes | `engine/fieldPhysics.js` | ✅ | init(geom, {classIds, multiClass}) |
| 2.4 Total density helper | `engine/fieldPhysics.js` | ✅ | getTotalRho(), computeTotalRhoInto() |
| 2.5 Per-class getters | `engine/fieldPhysics.js` | ✅ | getRhoByClass(), getClassMass() |

**Acceptance:** ✅ Multiple density arrays exist. Single-class mode backward-compatible.

---

### Phase 3: Region System ✅ COMPLETE
*Cells know which region they belong to*

| Task | File | Status | Notes |
|------|------|--------|-------|
| 3.1 Region cell mask | `engine/fieldPhysics.js` | ✅ | Uint8Array regionMap per cell |
| 3.2 stampRegions() | `engine/fieldPhysics.js` | ✅ | stampRegion(id, x, y, radiusM) |
| 3.3 Region lookup | `engine/fieldPhysics.js` | ✅ | getRegionAt(cellIdx) |
| 3.4 Corridor region default | `engine/fieldPhysics.js` | ✅ | All cells start as corridor |
| 3.5 Yard region stamp | `engine/fieldPhysics.js` | ✅ | Can stamp yard_main anywhere |

**Acceptance:** ✅ Every cell has a region. Yard cells distinguishable from corridor.

---

### Phase 4: Per-Class Physics ✅ COMPLETE
*Evolve each class with its own conductance*

| Task | File | Status | Notes |
|------|------|--------|-------|
| 4.1 computeClassVelocity(classId) | `engine/fieldPhysics.js` | ✅ | Shared velocity from total ρ |
| 4.2 advectClassDensity(classId) | `engine/fieldPhysics.js` | ✅ | advectClass() per class |
| 4.3 Per-class injection | `engine/fieldPhysics.js` | ✅ | injectIntoClass(classId, rate) |
| 4.4 Update loop iterates classes | `engine/fieldPhysics.js` | ✅ | updateMultiClass() |
| 4.5 Potential uses total density | `engine/fieldPhysics.js` | ✅ | computePotentialMultiClass() |

**Acceptance:** ✅ Two classes evolve independently. Shared velocity from total density.

---

### Phase 5: Conversion Operator ✅ COMPLETE
*Mass changes class in designated regions*

| Task | File | Status | Notes |
|------|------|--------|-------|
| 5.1 applyConversions(dt) | `engine/fieldPhysics.js` | ✅ | applyConversions() |
| 5.2 Time-based conversion | `engine/fieldPhysics.js` | ✅ | T = ρ_from / dwell_time_s * DT_S |
| 5.3 Region check | `engine/fieldPhysics.js` | ✅ | Only convert where regionMap matches |
| 5.4 Mass transfer | `engine/fieldPhysics.js` | ✅ | fromRho -= T, toRho += T |
| 5.5 Conservation assertion | `engine/fieldPhysics.js` | ⬜ | TODO: Add explicit check |

**Acceptance:** ✅ restricted mass in yard converts to cleared over time.

---

### Phase 6: Class-Aware Drain ✅ COMPLETE
*Only eligible classes can exit at sink*

| Task | File | Status | Notes |
|------|------|--------|-------|
| 6.1 drainSink checks eligibility | `engine/fieldPhysics.js` | ✅ | drainSinksMultiClass() |
| 6.2 Proportional drain across classes | `engine/fieldPhysics.js` | ✅ | Each eligible class drains |
| 6.3 Metrics per class | `engine/fieldPhysics.js` | ✅ | classBacklog in getMetrics() |

**Acceptance:** ✅ restricted mass does NOT drain at pharr_main. cleared mass does.

---

### Phase 7: Overlay Integration
*reynosaOverlay.js uses new class system*

| Task | File | Status | Notes |
|------|------|--------|-------|
| 7.1 Import classSystem | `overlay/reynosaOverlay.js` | ⬜ | Import v1 configs |
| 7.2 Pass classes to init | `overlay/reynosaOverlay.js` | ⬜ | fieldPhysics.init(..., classes) |
| 7.3 Inject as restricted | `overlay/reynosaOverlay.js` | ⬜ | All inflow → ρ_restricted |
| 7.4 Yard region from microGeometry | `overlay/reynosaOverlay.js` | ⬜ | Inovus yard → region stamp |
| 7.5 Render total or per-class | `overlay/reynosaOverlay.js` | ⬜ | Heatmap shows Σρ or toggle |

**Acceptance:** Overlay runs with two-class system. Visual output meaningful.

---

### Phase 8: Tests
*Verify correctness*

| Task | File | Status | Notes |
|------|------|--------|-------|
| 8.1 Class conservation test | `test/class_conservation.js` | ⬜ | Σρ_c constant under advection |
| 8.2 Conversion test | `test/conversion.js` | ⬜ | restricted→cleared in yard only |
| 8.3 Eligibility test | `test/eligibility.js` | ⬜ | restricted cannot drain |
| 8.4 Total conservation | `test/total_conservation.js` | ⬜ | inject = drain + accumulate |
| 8.5 No conversion outside yard | `test/conversion.js` | ⬜ | corridor has no conversion |

**Acceptance:** All tests pass. No mass leaks. No eligibility violations.

---

### Phase 9: Demo Scenario
*Show the value proposition*

| Task | File | Status | Notes |
|------|------|--------|-------|
| 9.1 Baseline scenario | demo config | ⬜ | No yard, restricted backs up on roads |
| 9.2 Inovus scenario | demo config | ⬜ | Yard exists, restricted converts |
| 9.3 Visual comparison | demo | ⬜ | Same inflow, different footprint |
| 9.4 Metrics comparison | demo | ⬜ | Spillback extent baseline vs yard |

**Acceptance:** Viewer sees: "With yard, congestion footprint shrinks."

---

## File Change Map

| File | Changes | Status |
|------|---------|--------|
| `engine/classSystem.js` | **NEW** - schemas + v1 configs | ✅ Created |
| `engine/fieldPhysics.js` | Multi-class arrays, per-class velocity, conversion, class-aware drain | ✅ Updated |
| `engine/fieldUnits.js` | Add DWELL_TIME_YARD constant | ⬜ (using classSystem constant) |
| `overlay/reynosaOverlay.js` | Import classSystem, pass to init, inject as restricted | ⬜ TODO |
| `overlay/microGeometry.js` | Export yard as RegionDef (optional, or keep separate) | ⬜ Optional |
| `spec/renderer_interfaces.js` | Add ClassDef, RegionDef types (optional) | ⬜ Optional |
| `test/class_conservation.js` | **NEW** | ⬜ TODO |
| `test/conversion.js` | **NEW** | ⬜ TODO |
| `test/eligibility.js` | **NEW** | ⬜ TODO |

---

## Invariants (Must Hold Throughout)

1. **Total mass conservation:** Σ_c ρ_c changes only by injection - drain
2. **Per-class conservation:** ρ_c changes only by advection, conversion, injection, drain
3. **Eligibility enforcement:** restricted never drains at pharr_main
4. **Conversion locality:** restricted→cleared only in yard region
5. **Non-negativity:** ρ_c[i] ≥ 0 always
6. **Monotonic alpha:** α(t+dt) ≥ α(t)

---

## Done Criteria

- [x] Phase 1 complete (schemas exist)
- [x] Phase 2 complete (multi-class arrays)
- [x] Phase 3 complete (region system)
- [x] Phase 4 complete (per-class physics)
- [x] Phase 5 complete (conversion works)
- [x] Phase 6 complete (eligibility enforced)
- [ ] Phase 7 complete (overlay integrated)
- [ ] Phase 8 complete (tests pass)
- [ ] Phase 9 complete (demo shows value)

---

## Notes & Decisions

*Record design decisions as we go*

| Date | Decision | Rationale |
|------|----------|-----------|
| 2025-12-15 | Two classes only for v1 | Minimal proof of concept |
| 2025-12-15 | Time-based conversion (not rate) | Simpler, represents dwell time |
| 2025-12-15 | All inflow as restricted | Represents uncommitted state |
| 2025-12-15 | Single yard region for v1 | Inovus Membrane Yard |
| 2025-12-15 | Shared velocity field | All classes use same v from total ρ |
| 2025-12-15 | Phases 2-6 combined in fieldPhysics.js | Clean implementation, all pieces needed together |

---

## Current Focus

**Next Task:** Phase 7.1 - Import classSystem into reynosaOverlay.js

---

## Quick Reference: The Equation

```
∂ρ_c/∂t = -∇·(ρ_c·v_c) + S_c - Σ_s G_{c,s} + Σ_d T_{d→c} - Σ_e T_{c→e}

Where:
  v_c = -K_c·∇φ           (class-specific velocity)
  φ = φ_base + β·Σ_c ρ_c  (potential from TOTAL density)
  G_{c,s} = 0 if class c not eligible for sink s
  T_{d→c} = ρ_d / τ       (conversion into c, time-based)
```

**Four operators only:** Injection, Transport, Conversion, Removal
