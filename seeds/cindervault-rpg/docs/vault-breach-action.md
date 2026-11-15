# Action Resolution: Breaching a Ward-Sealed Threshold

> **Illustrative Prototype Specification:** All rules, character names, dice formulas, and encounter structures in this repository belong to the fictional prototype setting *Cindervault*. They are synthetic sample content for testing this documentation workspace and do not represent or modify any real game project.

When a delve team confronts a ward-sealed doorway inside an ancient vault, resolving the breach requires clear handoffs between the **Player**, the **Rules Engine**, and the **Encounter Model**. Ambiguity around when resources lock—or whether partial success advances room danger clocks immediately—causes frustration at the table and desynchronization in automated tooling.

## Actor Responsibility Matrix

Each phase of the `Breach Seal` action has a single authoritative owner so neither the UI nor an encounter referee applies duplicate penalties:

| Beat | Authoritative Owner | Input Consumed | Guaranteed Output |
| :--- | :--- | :--- | :--- |
| 1. Inspect & Declare | Player | Target doorway ID, Rigging toolset | Previewed modifier without resource spend |
| 2. Lock Stakes | Rules Engine | Committed Lantern Oil (`0` to `2` charges) | Atomic oil deduction; rollback disabled |
| 3. Roll & Classify | Rules Engine | `2d6` (or `keepHigh2(3d6)`) + net modifier | Outcome band (`10+`, `7–9`, or `≤6`) |
| 4. Mutate Room State | Encounter Model | Outcome band + active Ward Tier | Door latch state and Ward Resonance clock delta |
| 5. Resolve Cost Choice | Player + Model | Selected `7–9` trade-off option | Finalized room alert or secondary oil vent |

## State Transitions and Failure Consequences

Explore the valid state transitions below. Notice that withdrawing an action is legal during `Intent Declared`, whereas once Lantern Oil charges lock into the copper coil, the check must finish resolving:

```embed
src: embeds/state-explorer/index.html
title: Ward-Breach State & Transition Explorer
height: 350
props: {"initialState":"declare_intent"}
```

### Threshold Bands and Clock Rules

- **Clean Breach (`10+`):** The ward unlatches without harmonic discharge. Door state flips to `Open`, and the room's Ward Resonance clock remains unchanged.
- **Strained Entry (`7–9`):** The seal parts under audible copper strain. The Encounter Model immediately advances Ward Resonance by `+1`, and the acting player chooses between venting `1` additional Lantern Oil or advancing the hallway patrol clock.
- **Ward Backlash (`≤6`):** When the delve team fails a Breach check on a `6` or lower, the Ward-Seal fractures into unstable resonance before the iron doors unlatch, adding `+2` segments to the room clock and jamming the physical bolt.

### Resource Caps and Assumptions

To keep mid-delve tension predictable, each breach attempt caps committed Lantern Oil at two charges per action regardless of pack capacity. Assisted leverage from a second character adds a third six-sided die and keeps the highest two dice rather than stacking flat numeric bonuses.

## Step-Through Encounter Trace

Step through the five resolution beats below to inspect how player intent, engine arithmetic, and encounter clocks interact during a sample delve at the *Sunken Reliquary*:

```embed
src: embeds/turn-walkthrough/index.html
title: Sunken Reliquary Step-Through Walkthrough
height: 340
props: {"initialBeat":0}
```

## Outcome Probability Playground

Adjust Rigging rating, spent Lantern Oil, Ward Seal tier, and assisted pry-bar leverage to inspect exact combinatorial odds across all 36 (or 216) dice permutations:

```embed
src: embeds/difficulty-playground/index.html
title: Stat & Ward Difficulty Outcome Playground
height: 320
props: {"defaultRigging":2,"defaultOil":1,"defaultTierPenalty":1}
```

## Reference Resolution Snippet

```ts
export type BreachBand = 'clean_breach' | 'strained_entry' | 'ward_backlash';

export function classifyBreachRoll(diceSum: number, rigging: number, oil: number, wardPenalty: number): BreachBand {
  const total = diceSum + rigging + oil - wardPenalty;
  if (total >= 10) return 'clean_breach';
  if (total >= 7) return 'strained_entry';
  return 'ward_backlash';
}
```

<details>
<summary>Preserved Playtest Note (Raw HTML Block Example)</summary>
This collapsible HTML block demonstrates lossless round-trip preservation of constructs outside standard rich-text toolbar formatting.
</details>

For environmental clock overflow definitions, see [Consequence Ledger](docs/consequence-ledger.md). To add new interactive tools to this repository, follow [Authoring Project Embeds](docs/embed-authoring.md).
