// apps/backend/src/modules/31-portal/seams/index.ts — M31-T06 barrel for the seven published reader seams.
//
// The §4.3 data ports (./stores), the seam impls (./readers), and the boot registration + §4.4 consumed
// contract (./registration). The composition root (T07) binds Drizzle-backed stores, builds the impls with
// `createM31PublishedSeamImpls`, and calls `registerM31PublishedSeams` into the M1 SeamRegistry.
export * from "./stores";
export * from "./readers";
export * from "./registration";
