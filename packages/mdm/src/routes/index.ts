// @wardenx/mdm — the route service + shared in-memory backend (M40-T07, §4.1, §7.6).
// The write/admin surface the backend routes call (reads go through the MdmEntityProvider seam),
// plus the one in-memory backend that produces both an MdmStore and the service over shared state.
export {
  createInMemoryMdmBackend,
  type MdmRouteService,
  type MergeRequestRow,
  type BaaRegisterEntry,
  type NppesSyncRun,
  type InMemoryMdmBackendSeed,
} from "./service";
