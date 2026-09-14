# Mining algorithm

1. Use logical schematic pins/nets if present; otherwise map PCB pads via verified part-footprint associations.
2. Detect U/IC references with >=3 parsed pins; DNP anchors are excluded. This is a conservative heuristic, not semantic proof.
3. Classify pin names and explicit power electrical types. VOUT alone is never POWER (AD9837 VOUT is analog).
4. MCU families split into CLOCK/RESET/SWD/USB/etc; other ICs yield a CORE candidate.
5. Expand from group seed nets through passives for at most three stages. Stop expansion on power, ground, high fanout, other anchors and connectors.
6. Score candidates by stage depth, shared-IC exclusivity and available PCB distance. Shared-rail capacitors are only review candidates, never automatically attributed by rail name alone. >=.75 included; .45–.75 review; lower scores boundary.
7. Derive external ports from boundary-crossing/public nets. Preserve original identifiers and source references. No inferred voltage/current ratings.
8. Relative position is board-frame dx/dy from the anchor; rotation/side retain PCB source convention. No critical-loop or placement-rule inference.
9. Manual member changes recompute ports. All ambiguous members must be resolved before approval. Structural parser gaps prevent approval. Publication requires approved state and current revision.

Confidence values are heuristic dimensions, not calibrated accuracy metrics. Public-rail stop rules trade recall for reduced cross-block contamination. Validate against manually annotated real projects before unattended use.
