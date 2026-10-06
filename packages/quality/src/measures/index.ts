// @wardenx/quality — M30 measure-calculator subtree barrel (§3.1). Pure domain — no IO.
//
// The public surface of `measures/**`: the shared result/input kernel, the per-FY period boundaries +
// period math, the measure registry/catalog, and the four calculator families (HCI, HVLDL, HOPE-derived,
// operational). Every calculator is a PURE function over an already-fetched per-measure input type; the
// upstream-seam data fetch + snapshot hashing + `quality_measure_value` persistence is the worker phase.
//
// The shared `QualityMeasureValueResult` + `ComputeMeasureInput` types and the `ratioResult` reduction
// live in `./result` and are RE-EXPORTED here (so they are available "from measures/index.ts" as the
// public contract) — kept in a leaf rather than inline so the calculator subtree can import them without
// an import cycle back into this barrel (the repo `no-circular` rule).
export * from "./result";
export * from "./periods";
export * from "./registry";
export * from "./hci/index";
export * from "./ssvi/index";
export * from "./registrations";
export * from "./hvldl/index";
export * from "./hope_derived/index";
export * from "./operational/index";
