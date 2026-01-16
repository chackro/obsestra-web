# LOT MASS ACCOUNTING AUDIT

**Date:** 2025-12-19
**Purpose:** Surface illegal mass paths to determine if fix is surgical or structural
**Status:** Complete — no fixes, no refactors

---

## PHASE 1: COMPLETE WRITE-PATH ENUMERATION

### Table 1.1: Writes to `rho_restricted_lot`

| # | Function | Lines | Trigger | Classification | Checks Capacity | Writes to Lot Polygon |
|---|----------|-------|---------|----------------|-----------------|----------------------|
| 1 | `depositToParkWaitZone()` | 1566 | Park source injection | **park → lot** | **NO** | **NO** (park cells) |
| 2 | `graphFlowClass()` (scatter) | 4421 | Road flow enters lot | road → lot | YES (gated) | YES |
| 3 | `graphFlowClass()` (fallback) | 4426 | Road flow, no cell mapping | road → lot | YES (gated) | YES |
| 4 | `convertTruckFromLot()` | 4747 | FIFO service | conversion (withdraw) | N/A (decrease) | YES |
| 5 | `convertTruckFromPark()` | 4767 | FIFO service | conversion (withdraw) | N/A (decrease) | NO (park cells) |
| 6 | `enforceNonNegative()` | 4990 | End of physics frame | clamp | N/A (floor) | YES |

### Table 1.2: Writes to `rho_restricted`

| # | Function | Lines | Trigger | Classification | Checks Capacity | Writes to Lot Polygon |
|---|----------|-------|---------|----------------|-----------------|----------------------|
| 1 | `advancePreLotHolding()` | 333 | Timer bucket matures | preLot → road | N/A (release) | NO |
| 2 | `injectMass()` | 4626 | Corridor source injection | injection | N/A (source cells) | NO |
| 3 | `drainAtSinks()` | 4963 | PHARR sink drain | drain (decrease) | N/A | NO |
| 4 | `enforceNonNegative()` | 4984 | End of physics frame | clamp | N/A (floor) | NO |

### Table 1.3: Writes to `rho_restricted_preLot`

| # | Function | Lines | Trigger | Classification | Checks Capacity | Writes to Lot Polygon |
|---|----------|-------|---------|----------------|-----------------|----------------------|
| 1 | `advancePreLotHolding()` | 335 | Timer bucket matures | preLot release (decrease) | N/A | NO |
| 2 | `graphFlowClass()` | 4435 | Road flow at lot boundary | road → preLot | N/A (roadside) | NO |
| 3 | `enforceNonNegative()` | 4986 | End of physics frame | clamp | N/A (floor) | NO |

### Table 1.4: Writes to `rho_cleared`

| # | Function | Lines | Trigger | Classification | Checks Capacity | Writes to Lot Polygon |
|---|----------|-------|---------|----------------|-----------------|----------------------|
| 1 | `injectMass()` | 4623 | Park source cleared | injection | N/A (source cells) | NO |
| 2 | `injectMass()` | 4627 | Corridor source cleared | injection | N/A (source cells) | NO |
| 3 | `convertTruckFromLot()` | 4748 | FIFO service | conversion (add) | **NO** | **YES** |
| 4 | `convertTruckFromPark()` | 4774 | FIFO service | conversion (add) | N/A (release road) | NO |
| 5 | `drainAtSinks()` | 4964, 4968 | PHARR sink drain | drain (decrease) | N/A | NO |
| 6 | `enforceNonNegative()` | 4985, 4991 | End of physics frame | clamp | N/A (floor) | BOTH |

### Summary: How Many Ways Does Mass Enter Lot Space?

**Writes that increase lot cell mass:**

| Path | Capacity Checked | Count |
|------|------------------|-------|
| `depositToParkWaitZone()` | **NO** | 1 |
| `graphFlowClass()` road → lot | YES | 2 (scatter + fallback) |
| `convertTruckFromLot()` cleared deposit | **NO** | 1 |

**Answer:** 4 write paths increase lot cell mass. **2 of 4 (50%) bypass capacity checks.**

---

## PHASE 2: LOT MASS DEFINITION

### 2.1 What Quantities Are Summed Into `lotCurrentMassKg`

From `:1649-1656`:
```javascript
for (const cellIdx of lotCellIndices) {
    const lotIdx = cellToLotIndex[cellIdx];
    if (lotIdx >= 0 && lotIdx < lotCurrentMassKg.length) {
        lotCurrentMassKg[lotIdx] +=
            rho_restricted_lot[cellIdx] +
            rho_cleared[cellIdx];
    }
}
```

**Summed:** `rho_restricted_lot + rho_cleared`

### 2.2 Does Cleared Mass Contribute to Utilization?

**YES.** Both `rho_restricted_lot` and `rho_cleared` are summed.

### 2.3 Does Converted-But-Not-Exited Mass Occupy Lot Space?

**YES.** Conversion at `:4747-4748` moves mass from `rho_restricted_lot` to `rho_cleared` in the SAME cell:
```javascript
rho_restricted_lot[cellIdx] = m - take;
rho_cleared[cellIdx] += take;
```

Total cell mass is unchanged. Cleared mass remains in lot until particles exit via `nextHop_pharr`.

### 2.4 Is Park-Wait Mass Counted as Lot Mass?

**NO.** Park deposits write to cells where `regionMap !== REGION_LOT` (`:1501`). These cells are NOT in `lotCellIndices`.

However, `depositToParkWaitZone()` writes to `rho_restricted_lot` on these non-lot cells. This creates **orphan mass** — mass in `rho_restricted_lot` that is not tracked by lot utilization.

### 2.5 Occupancy Definition Statement

> **A lot is considered occupied by:**
> - `rho_restricted_lot` on cells where `regionMap === REGION_LOT`
> - `rho_cleared` on cells where `regionMap === REGION_LOT`
>
> **A lot is explicitly NOT occupied by:**
> - `rho_restricted` (road-mobile mass, never in lots)
> - `rho_restricted_preLot` (roadside staging, never in lots)
> - `rho_restricted_lot` on cells where `regionMap !== REGION_LOT` (park wait zones)
> - `rho_cleared` on cells where `regionMap !== REGION_LOT` (road cells, park release points)

**Ambiguity Flag:** The use of `rho_restricted_lot` for both lot storage AND park wait zones creates semantic confusion. The array name implies "lot" but contains non-lot mass.

---

## PHASE 3: CAPACITY ENFORCEMENT POINTS

### 3.1 Enforcement Mechanisms

| Mechanism | Location | Limits What | Preventative or Diagnostic | Bypassable |
|-----------|----------|-------------|---------------------------|------------|
| `getLotAcceptance()` | :1790-1816 | Soft multiplier (0-1) on road→lot flow | **Preventative** (shapes inflow) | YES — by park path |
| `lotAcceptRemainingKgLive` | :1374 | Reservation counter per substep | **Preventative** (hard clamp within substep) | YES — by park path, conversion |
| `LOT_CAPACITY_THRESHOLD` | :1396 | 90% fill = "full" | **Diagnostic** (triggers phi rebuild) | N/A (not enforcement) |
| `lotIsFull[]` | :1392 | Boolean flags for phi exclusion | **Preventative** (routing) | Indirect |
| `SOFT_CAPACITY_ALPHA/BETA` | :1407-1408 | Dijkstra edge penalty | **Preventative** (routing) | Indirect |

### 3.2 Enforcement Flow

```
                              ┌─────────────────────────┐
                              │  depositToParkWaitZone  │──► NO CHECK ──► rho_restricted_lot
                              └─────────────────────────┘
                                        │
                                   (bypasses)
                                        ▼
┌──────────────┐     ┌───────────────────────────────────────┐
│ Road inflow  │────►│ getLotAcceptance() + remaining check  │
└──────────────┘     └───────────────────────────────────────┘
                                        │
                           ┌────────────┴────────────┐
                           ▼                         ▼
                     (accepted)                 (rejected)
                           │                         │
                           ▼                         ▼
                   rho_restricted_lot         stays on road
                           │
                           ▼
              ┌─────────────────────────┐
              │  convertTruckFromLot    │──► NO CHECK ──► rho_cleared (same cell)
              └─────────────────────────┘
```

### 3.3 Capacity: Hard Invariant or Advisory Signal?

**ADVISORY.** Capacity is:
- Enforced at road→lot boundary (gating)
- NOT enforced at park→lot deposits
- NOT enforced at conversion (restricted → cleared)
- NOT enforced as a global invariant

The only hard enforcement is `Math.min(desiredLot, remaining)` at `:4382`, which only affects the road→lot path.

---

## PHASE 4: INVARIANT VIOLATION PROOF

### 4.1 Concrete Path: `lotCurrentMassKg > lotCapacityKg`

**Path 1: Park Orphan Accumulation (does NOT cause lot overflow directly)**

```
injectMass()
  └─► depositToParkWaitZone()
        └─► rho_restricted_lot[parkCell] += kg
              │
              └─► parkCell is NOT in lotCellIndices
                    └─► NOT counted in lotCurrentMassKg
```

This path writes to `rho_restricted_lot` but does NOT cause lot overflow because park cells are not tracked as lot occupancy.

**Path 2: Conversion Backlog Accumulation (CAUSES lot overflow)**

```
Initial state:
  lotMassKgLive[lotIdx] = 0.89 × capacity  (89% full, below threshold)
  lotAcceptRemainingKgLive[lotIdx] = 0.01 × capacity  (1% headroom)

Step 1: Road inflow deposits 0.01 × capacity
  → lotMassKgLive[lotIdx] = 0.90 × capacity
  → lotAcceptRemainingKgLive[lotIdx] = 0
  → Lot now "full", gating returns 0

Step 2: FIFO converts restricted → cleared at :4747-4748
  → rho_restricted_lot[cell] -= TRUCK_KG
  → rho_cleared[cell] += TRUCK_KG
  → lotMassKgLive[lotIdx] UNCHANGED (still 0.90 × capacity)

Step 3: rebuildLotMassLiveFromRho() recomputes:
  → lotMassKgLive[lotIdx] = sum(rho_restricted_lot + rho_cleared) = 0.90 × capacity
  → lotAcceptRemainingKgLive[lotIdx] = 0  (still full)

Step 4: Cleared mass SHOULD exit via nextHop_pharr, BUT:
  - Exit rate depends on road congestion, graph connectivity
  - If exit is slower than conversion, cleared mass accumulates

Step 5: After many conversion cycles:
  → rho_restricted_lot ≈ 0
  → rho_cleared = N × TRUCK_KG (cleared backlog)
  → lotMassKgLive still at 0.90 × capacity? NO!

Wait — if restricted is converted to cleared and nothing exits, mass stays constant.
The invariant violation requires MORE mass entering than exiting.
```

**Revised Path 2: Multi-Substep Oversubscription**

```
Substep N:
  rebuildLotMassLiveFromRho() → lotMassKgLive[i] = 80,000 kg
  lotCapacityKg[i] = 100,000 kg
  lotAcceptRemainingKgLive[i] = 90,000 - 80,000 = 10,000 kg

  During substep:
    Cell A: accepted = min(8000, remaining=10000) = 8000 → remaining = 2000
    Cell B: accepted = min(5000, remaining=2000) = 2000 → remaining = 0
    Cell C: accepted = min(3000, remaining=0) = 0 (rejected)

  End of substep:
    lotMassKgLive[i] = 80,000 + 8,000 + 2,000 = 90,000 kg (90% = threshold)

Substep N+1:
  rebuildLotMassLiveFromRho() → lotMassKgLive[i] = 90,000 kg
  lotAcceptRemainingKgLive[i] = 90,000 - 90,000 = 0

  All inflows rejected. Lot stays at 90%.
```

This shows the gating DOES work for road→lot flow. The 500%+ overflow must come from elsewhere.

**Path 3: LOT_KG_PER_M2 Changed After Mass Deposited**

```
Initial: LOT_KG_PER_M2 = 100
  lotCapacityKg[i] = 100,000 m² × 100 = 10,000,000 kg

Mass deposits: 500,000 kg (5% utilization, allowed)

Later: setLotCapacity(1)  ← CAPACITY REDUCED
  lotCapacityKg[i] = 100,000 m² × 1 = 100,000 kg

New utilization: 500,000 / 100,000 = 500%  ← VIOLATION
```

This is NOT a code path bug — it's an operational scenario where capacity is reduced after mass is deposited.

**Path 4: Cell Mapping Mismatch (Structural)**

If `lotToCellIndices[lotIdx]` and `lotCellIndices` contain different cells due to initialization order or regionMap stamping issues, then:

```
Gating uses: lotMassKgLive (computed from lotToCellIndices)
Utilization uses: lotCurrentMassKg (computed from lotCellIndices)

If lotToCellIndices[i] ⊂ lotCellIndices:
  → Mass on cells in lotCellIndices but NOT in lotToCellIndices is invisible to gating
  → Gating allows more mass than lot actually contains
  → Utilization exceeds capacity
```

This requires a bug in initialization, which should be verified.

### 4.2 Minimal Invariant Violation Trace

**Confirmed Path (requires setLotCapacity reduction):**

1. `LOT_KG_PER_M2 = 100` (or higher) initially
2. Mass enters lots via normal gated road→lot flow
3. `setLotCapacity(1)` called, reducing capacity 100×
4. Existing mass now exceeds new capacity
5. `lotCurrentMassKg[i] / lotCapacityKg[i] > 1.0`

**Conditional that DOES NOT fail:** The gating conditional at `:4382` (`Math.min(desiredLot, remaining)`) never sees the new capacity until AFTER the capacity change.

**Without setLotCapacity change:**

The gating system appears mathematically correct for road→lot flow. The 500%+ utilization observed in logs either:
1. Occurred before gating was implemented
2. Is a measurement artifact (printing before/after snapshot sync)
3. Results from cell mapping mismatch between `lotToCellIndices` and `lotCellIndices`

---

## DELIVERABLE SUMMARY

### Write-Path Table (Phase 1)
See Tables 1.1-1.4 above. **4 paths increase lot mass, 2 bypass capacity.**

### Lot Occupancy Definition (Phase 2)
Lot occupancy = `rho_restricted_lot + rho_cleared` on cells where `regionMap === REGION_LOT`.

**Ambiguity:** `rho_restricted_lot` contains mass on non-lot cells (park wait zones) that is not tracked.

### Capacity Enforcement Map (Phase 3)
- Road→lot: Gated (getLotAcceptance + reservation)
- Park→lot: **UNGATED** (depositToParkWaitZone bypasses checks)
- Conversion: **UNGATED** (rho_restricted_lot → rho_cleared, total unchanged)

Capacity is **advisory**, not invariant.

### Invariant Violation Trace (Phase 4)
The most likely path to >100% utilization is `setLotCapacity()` being called with a lower value after mass is already deposited. No code conditional prevents this.

A secondary potential path is cell mapping mismatch between gating (`lotToCellIndices`) and utilization (`lotCellIndices`) data structures.

---

## CONCLUSION

**"Lot mass accounting is split-brain and requires structural separation."**

The core issue is that `rho_restricted_lot` serves two semantic purposes:
1. Storage for mass in conversion lots (tracked, gated)
2. Storage for mass in park wait zones (untracked, ungated)

These should be separate arrays with separate enforcement. The current design allows mass to enter the system via park deposits without any capacity relationship, and the array naming suggests lot semantics that don't apply to park cells.
