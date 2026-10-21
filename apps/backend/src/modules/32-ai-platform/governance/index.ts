// apps/backend/src/modules/32-ai-platform/governance — M32-T03's governance surface.
//
//   · ./store          the two data ports (platform-shared registry / tenant-scoped consent) + the
//                      in-memory implementation the slice tests run against
//   · ./store-drizzle  the real stores: audited `withPlatformContext` writes for the platform-shared
//                      half, `withOrgContext` for every tenant-scoped read and write
//   · ./service        the commands that sequence `@chartwarden/ai-platform`'s pure rules over the ports
//
// Nothing here is mounted: M32-T07 adds the §4.1 routes, §4.6 permission keys and §4.7 predicates that
// decide who may call any of it, and M32-T06 binds the seams. Until then these are functions with no
// caller, which is the intended end-state of this task.
export * from "./store";
export * from "./store-drizzle";
export * from "./service";
