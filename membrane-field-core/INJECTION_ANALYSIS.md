# Injection Weight Analysis

## The Math

```
Total flow to Pharr:     8.83B kg/year  (from flow_kg_by_poe)
Entry corridor segments: 5.71B kg       (3 matched segments)
─────────────────────────────────────────
Reynosa-local:           3.12B kg       (35% of total)
```

The 3 matched segments are the **entry choke points**. Each through-flow crosses them exactly once. So 5.71B kg = through-traffic (no double counting at the entry point).

The missing 3.12B kg must be Reynosa-local exports that go directly to Pharr without passing through the southern entry corridors.

## Current Split

Through-traffic (65%):
- ENTRY_EAST: 89.4% of 5.71B = 5.10B kg
- ENTRY_WEST: 10.6% of 5.71B = 0.61B kg

Reynosa-local (35%):
- 3.12B kg - needs separate injection

## What We Need

1. **Verify the 3.12B is Reynosa-local**: Check if unmatched segments are geographically inside Reynosa city (not upstream)

2. **Decide how to inject Reynosa-local**:
   - Distributed across city?
   - Single point near industrial zone?
   - Third entry point?

## Verification Approach

The 992 unmatched segments are all in-ROI (upstream=0). If we can confirm they're inside Reynosa city bounds, that confirms the Reynosa-local hypothesis.

Can check by looking at their coordinates relative to Pharr.
