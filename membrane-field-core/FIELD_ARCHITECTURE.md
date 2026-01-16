# FIELD Constitution

> **Purpose:** Explains what FIELD is and why it exists.
> **Audience:** Architects, stakeholders, future maintainers checking intent.
> **Rule:** This document may explain, but never arbitrate. No file paths, no constants, no formulas.

---

## 0. Preamble: Why FIELD Exists

### The Problem CIEN Cannot Explain

CIEN allocates mass across a continental network. It answers: "Given demand, infrastructure, and behavioral parameters, how much cargo chooses each port of entry?"

But CIEN cannot explain what happens *after* the choice. When 4,000 trucks per day commit to crossing at PHARR, CIEN says "the queue is 2 hours." It does not say:

- Where does the backlog physically accumulate?
- Why does Reynosa East become chaos while Laredo stays orderly?
- How does a capacity constraint at the bridge propagate backward into Mexican streets?

These are spatial questions. CIEN is aspatial.

### Why Reynosa Requires a Local Physical Layer

Reynosa East is not a queue. It is a pressure vessel.

Trucks do not wait in a line. They scatter across transfer yards, parking lots, and informal staging areas. When capacity at PHARR drops, this mass does not simply "wait longer" — it spreads. It occupies space. It creates friction. It blocks other traffic.

A queue model cannot represent this. A physics model can.

### What Kind of System FIELD Must Be

FIELD is a **local physical compliance engine**.

It does not decide where cargo goes. CIEN decides.
It does not predict behavior. CIEN predicts.
It does not optimize anything. Nothing is being minimized.

FIELD converts CIEN's allocation into observable physical consequences: backlog accumulation, pressure propagation, spillback extent, throughput constraints.

It answers: "Given what CIEN already decided, what does Reynosa look like?"

---

## 1. Identity Lock: What FIELD Is

### Formal Identity

FIELD is a continuous-space, aggregate-flow model that evolves density under capacity constraints. It receives committed mass from CIEN and demonstrates how that mass distributes spatially before crossing.

### Relationship to CIEN

| Role | CIEN | FIELD |
|------|------|-------|
| Scale | Continental | Local (16km × 16km) |
| Unit | Trucks, kg | Density (kg/cell) |
| Mechanism | Discrete choice, M/M/s queues | Continuous advection, pressure |
| Output | POE allocation, wait times | Spatial backlog, spillback |
| Decision authority | Yes | No |

**One-sentence lock:**

> CIEN is the allocator. FIELD is the converter.

FIELD never contradicts CIEN. If CIEN says 4,000 trucks choose PHARR, FIELD shows what 4,000 trucks look like on the ground. It does not re-route them. It does not second-guess the choice. It demonstrates consequences.

---

## 2. Authority Boundary: CIEN vs FIELD

### What CIEN Decides (FIELD Accepts)

- How much mass is committed to each POE (hourly schedule)
- What capacity exists at each gate (throughput ceiling)
- Which road segments carry which HS2 products
- When infrastructure scenarios activate

FIELD receives these as inputs. They are not negotiable.

### What FIELD Enforces (CIEN Does Not See)

- How density distributes spatially within the local window
- Where backlog accumulates when inflow exceeds capacity
- How pressure propagates upstream from the gate
- What friction zones create local hotspots

CIEN does not know these things. FIELD computes them.

### Forbidden Responsibilities

FIELD must never:

- Re-route traffic (routing is CIEN's job)
- Infer demand (demand comes from CIEN)
- Model individual vehicles (aggregate flow only)
- Predict future behavior (it shows current consequences)
- Emit southbound flows (northbound story only)
- Query CIEN at runtime (bundles loaded at initialization)

---

## 3. Causal Story: From Allocation to Congestion

This section explains the physical intuition. No equations.

### Step 1: Mass Commitment

CIEN runs. A choice model determines: "Given costs, delays, and product characteristics, 4,000 trucks per day will cross at PHARR."

This is *committed mass*. These trucks are not considering alternatives. They have already decided.

### Step 2: Arrival at the Local Window

The committed mass enters Reynosa East from multiple corridors: MTY highway, Victoria highway, MMRS industrial area. FIELD receives this inflow as a rate: kilograms per second entering the local window.

### Step 3: Finite Space

The local window is 16km × 16km. Mass that enters must go somewhere. If it cannot immediately exit through the bridge, it occupies space. Space is finite.

### Step 4: Backpressure

When mass accumulates near the gate, it creates pressure. This pressure is not a metaphor — it represents congestion, blocked access, slower movement. High density raises local "potential," which pushes flow away from the congested area.

This is the backpressure mechanism. Without it, the model would show trucks piling infinitely at the gate. With it, congestion propagates backward.

### Step 5: Spillback

As pressure increases near PHARR, mass spreads upstream. Transfer yards fill. Parking lots saturate. Streets in Reynosa East become occupied. This is spillback — the spatial footprint of congestion.

### Step 6: Capacity Constraint

The gate has a maximum throughput. Even if infinite mass waits, only so much can cross per hour. This ceiling determines the equilibrium: when inflow equals outflow, backlog stabilizes. When inflow exceeds capacity, backlog grows indefinitely.

### Step 7: Clean Flow vs Chaos

Two regimes exist:

**Under-capacity:** Inflow < throughput. Mass flows through without significant accumulation. Reynosa East looks orderly.

**Over-capacity:** Inflow > throughput. Backlog grows. Pressure increases. Spillback extends. Reynosa East looks like chaos.

FIELD shows both. The difference is visible.

---

## 4. Conceptual Physics

This section describes what the model computes. No formulas — those belong in the Authority document.

### Density: Backlog, Not Vehicles

Density represents accumulated cargo mass per cell. It is not a vehicle count. High density means "a lot of freight is stuck here." Low density means "this area is clear."

Density is conserved. Mass that enters the system must exit through the gate or remain inside. Nothing disappears. Nothing appears from nowhere.

### Potential: Pressure, Not Intent

Potential is a scalar field that drives flow. Think of it as "pressure" or "cost to reach the gate." Mass flows from high potential to low potential.

Near the gate, potential is low (the destination). Far from the gate, potential is higher. But when density accumulates, potential rises locally. This creates the backpressure effect: congestion makes an area harder to enter.

### Conductance: Spatial Permission

Conductance describes how easily mass can flow through space. Roads have high conductance — flow moves freely along them. Off-road areas have low conductance — flow is impeded.

Conductance is anisotropic: a north-south road permits north-south flow but restricts east-west flow. This is represented as a tensor, not a scalar.

### Velocity: Flow Direction and Speed

Velocity is derived from potential and conductance. Mass moves down the potential gradient, modulated by conductance. The resulting velocity field shows both direction and speed of flow at every point.

### Capacity: Hard Reality

The gate has a maximum throughput. This is not a soft limit. It is a hard ceiling imposed by CIEN's capacity schedule. FIELD cannot drain more mass than capacity allows, regardless of how much waits.

---

## 4.5 Mass Classes and Conversion

### Why Classes Exist

Not all cargo is equal at the border. Some freight can cross immediately. Some requires inspection, paperwork, or transfer operations before it becomes eligible to cross.

CIEN knows this at the product level (HS2 differentiation). FIELD represents it spatially: mass exists in different states of "clearance" that determine where it can go.

### Classes Are Not Types of Cargo

Classes represent eligibility states, not commodity categories. "Restricted" does not mean "electronics" — it means "not yet cleared to cross." The same physical cargo transitions from restricted to cleared through a conversion process.

### Conversion Is Not Movement

Conversion changes a mass's class without moving it spatially. It represents:

- Trailer swap completion
- Paperwork processing
- Compliance verification
- Inspection clearance

These are real operations that take time. But FIELD does not simulate the operations — it models the eligibility change as a rate or dwell time.

### Where Conversion Happens

Conversion occurs only in designated regions. A "yard" region permits conversion. A "corridor" region does not.

This is Inovus's core mechanism: the Membrane Yard is a region where restricted mass converts to cleared mass. Without the yard, restricted mass has nowhere to become eligible. It backs up on roads. With the yard, conversion happens in organized space.

### The Two-Class Minimal Model

FIELD v1 uses exactly two classes:

**Restricted:** Can flow on corridors, can enter yards, cannot exit at Pharr sink.

**Cleared:** Can flow on corridors, can enter yards, can exit at Pharr sink.

This is sufficient to demonstrate: "organized conversion in a yard vs chaotic spillback on roads."

---

## 5. What FIELD Observes and Produces

### Inputs (Conceptual)

- **Committed inflow:** How much mass enters per hour (from CIEN)
- **Gate capacity:** Maximum throughput per hour (from CIEN)
- **Road geometry:** Where roads exist (from CIEN)
- **Segment weights:** Which roads carry which products (from CIEN)
- **Scenario pair:** Baseline and alternative configurations (from CIEN)

### Outputs (Conceptual)

- **Density distribution:** Where backlog accumulates spatially
- **Spillback extent:** How far congestion reaches from the gate
- **Throughput rate:** How much mass actually exits
- **Backlog metrics:** Total mass waiting, delay proxy

### What FIELD Never Emits

- Routing decisions
- Demand forecasts
- Behavioral predictions
- Optimization recommendations
- Individual vehicle trajectories

FIELD shows consequences. It does not advise.

---

## 6. Stability Doctrine

### Why Monotonicity Matters

The scenario interpolation parameter (α) must never decrease. If α goes from baseline to interserrana, it must do so monotonically. Oscillation is forbidden.

Why? Because FIELD shows a transition, not a comparison. The viewer watches Reynosa evolve from one state to another. Reversing would break causality.

### Why Oscillations Are Forbidden

Density should evolve smoothly. If the field "flickers" or oscillates rapidly, something is wrong: numerical instability, incorrect parameters, or violated assumptions.

A well-behaved FIELD shows gradual accumulation and gradual drainage. Rapid oscillation means the model is lying.

### What "Lying" Means

FIELD lies when it shows something physically impossible:

- Mass appearing from nowhere
- Mass disappearing into nothing (except through the gate)
- Density going negative
- Backlog decreasing while inflow exceeds capacity
- Spillback vanishing instantly

These are conservation violations. They invalidate the model.

### Conservation Per Class

Mass conservation applies to each class independently, plus conversion flows:

- Restricted mass can only decrease via: drainage (if eligible), conversion to cleared, or leaving the window
- Cleared mass can only increase via: injection as cleared, conversion from restricted
- Total mass (all classes) is conserved: injection = drainage + accumulation

If restricted mass disappears without conversion, the model is lying.
If cleared mass appears without injection or conversion, the model is lying.

---

## 7. Growth Path ("Puberty Plan")

FIELD grows by adding classes, regions, and conversions — not by adding new physics.

### Phase 0: Single Aggregate (Historical)

- Single density layer (aggregate kg)
- Single POE (PHARR only)
- No class differentiation
- No conversion mechanics

This was sufficient for demonstrating raw congestion physics. It is now superseded.

### Phase 1: Two-Class Model (Current Target)

- Two classes: restricted, cleared
- Two region types: corridor, yard
- One sink: pharr_main (cleared only)
- One conversion: restricted → cleared (in yard, time-based)

This demonstrates: "What happens when mass must convert before crossing, and conversion only happens in designated space?"

### Phase 2: Three-Class Model (Future)

- Three classes: fast (perishables), standard (general), bulk (heavy)
- Each with distinct conductance and sink priority
- Maps to CIEN's HS2 differentiation

This unlocks cargo-type visualization without memory explosion.

### Phase 3: Multi-Sink (Future)

- Additional POEs (ANZALDUAS, ROMA) as secondary sinks
- Each sink has class eligibility rules
- Local pressure redistribution between gates

### What Will Never Happen

These extensions are explicitly forbidden:

- Individual vehicle simulation (violates aggregate identity)
- Behavioral prediction (violates CIEN authority)
- Runtime optimization (violates compliance role)
- Per-truck routing decisions (classes are not agents)
- Conversion logic beyond rate/dwell (no process simulation)

If someone proposes these, they are proposing a different system.

---

## 8. Failure Interpretation Guide

### If FIELD Contradicts CIEN

CIEN says 2-hour wait. FIELD shows minimal backlog.

**Interpretation:** FIELD's capacity ceiling is too high, or inflow rate is miscalibrated. Check that gate capacity and hourly inflow match CIEN's assumptions.

### If FIELD Shows Congestion Where CIEN Predicts None

CIEN says PHARR is under-capacity. FIELD shows massive spillback.

**Interpretation:** Either CIEN's capacity estimate is wrong, or FIELD's hourly injection exceeds what CIEN actually assigned. Verify the inflow schedule matches CIEN's POE allocation.

### If FIELD Looks "Too Smooth"

No visible backlog even at peak hours. Everything flows perfectly.

**Interpretation:** Backpressure coupling may be too weak, or conductance is too uniform. The model should show friction where friction exists.

### If FIELD Looks "Too Smart"

Mass seems to "know" where to go. Flow appears optimized.

**Interpretation:** Conductance may be over-tuned to match expected patterns. FIELD should show physics, not planning. Reduce segment weight influence if flow looks implausibly efficient.

---

## 9. Defense: How to Explain FIELD to Skeptics

### "Isn't this just a visualization?"

No. A visualization shows data. FIELD computes consequences.

A visualization might color roads by traffic volume. FIELD takes CIEN's allocation and *derives* where backlog accumulates. The spatial distribution is computed, not displayed.

### "Why not use agents?"

Agents model individual decisions. FIELD models aggregate flow.

Reynosa does not need 4,000 simulated trucks making 4,000 decisions. It needs to show what happens when 4,000 trucks worth of mass enters finite space. Agents would be slower, harder to calibrate, and no more informative.

### "Why not use queues here too?"

CIEN already uses M/M/s queues at the continental scale. Adding queues locally would duplicate theory.

More importantly, queues are aspatial. "Average wait time" does not explain *where* trucks wait. FIELD shows the spatial footprint that queues cannot capture.

### "Why not make predictions?"

FIELD shows consequences of CIEN's current allocation. Prediction would require re-running CIEN with different assumptions.

FIELD's value is not forecasting — it is explanation. "Given what CIEN says, this is what Reynosa looks like." That causal clarity is the product.

---

## 10. Non-Goals (Architectural)

FIELD will never:

| Non-goal | Reason |
|----------|--------|
| Replace CIEN | CIEN is the allocator; FIELD is the converter |
| Model individual behavior | Aggregate flow is the identity |
| Optimize routing | No objective function exists |
| Predict demand shifts | Demand comes from CIEN |
| Handle real-time feeds | Bundles are loaded at initialization |
| Extend beyond local window | Continental scale is CIEN's domain |
| Show southbound flows | Northbound story only |
| Advise operators | FIELD demonstrates; it does not recommend |

If a feature requires violating these, it belongs in a different system.

---

## Appendix: Reading This Document

This document is the Constitution. It explains identity and intent. It answers:

- What is FIELD allowed to be?
- Why does it exist?
- What causal story does it assert?
- How do CIEN and FIELD relate?

For canonical formulas, constants, file ownership, and enforcement rules, see **FIELD_AUTHORITY.md**.

If this document changes, FIELD's identity has changed.
If FIELD_AUTHORITY.md changes, FIELD's maintenance rules have changed.

One persuades. One governs.
