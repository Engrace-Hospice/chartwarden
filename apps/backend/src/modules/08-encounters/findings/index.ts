// apps/backend/src/modules/08-encounters/findings — WF09: the per-visit findings of module 8 (ADLs, nutrition, weight history).
export * from "./adl";
export * from "./nutrition";
export * from "./weight-history";
export * from "./findings-guards";
export * from "./findings-service";
export * from "./findings-typebox";
export * from "./findings-memory";
export {
  type FindingsServiceDeps,
  createDrizzleFindingsService,
  loadRecordedFindings,
  loadRecordedRecords,
} from "./findings-drizzle";
export { type FindingsRouteDeps, registerFindingsRoutes } from "./findings-routes";
