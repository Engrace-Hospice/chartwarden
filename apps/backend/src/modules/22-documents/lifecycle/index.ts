// apps/backend/src/modules/22-documents/lifecycle/index.ts — M22-T03 (§2.2 document lifecycle).
//
// The pure M22 document-lifecycle domain: versioning (D2), retention classes + disposition + legal-hold
// override (D9 / D23), the legal-hold place/release + destruction-tombstone machine (D12), the access-log
// append, and the patient-merge redirect-on-fetch (§2.4). Every machine is an injectable pure function
// over facts — no DB, no MinIO client (D1 storage is the injected DocumentStorageProvider port). The
// service + worker layers (later M22 tasks) execute the returned §2.4 side-effect descriptors.
export {
  DocumentStateError,
  M22_LIFECYCLE_ERROR_STATUS,
  require_,
  type M22LifecycleErrorCode,
} from "./errors";
export {
  result,
  type DocumentSideEffect,
  type DocumentTransitionResult,
} from "./effects";
export {
  deriveObjectFilename,
  deriveObjectKey,
  deriveTenantBucket,
  planSignedUrl,
  SIGNED_URL_TTL_SECONDS,
} from "./storage";
export {
  applyRetentionChange,
  assertPart2NotMutated,
  deriveDispositionDate,
  isDestructionEligible,
  promoteOnWriteback,
  resolveInsertRetentionClass,
  RETENTION_FLOOR_DAYS,
  type DispositionVerdict,
} from "./retention";
export {
  assertNotTombstoned,
  DOCUMENT_GRAPH,
  planDestructionForDocument,
  transitionDocument,
  type DocumentEvent,
  type DocumentLifecycleTransition,
  type DocumentState,
} from "./document";
export {
  assertActiveVersionBelongs,
  assertMonotonicVersion,
  assertSha256Immutable,
  planAddVersion,
  type AddVersionPlan,
} from "./version";
export {
  planAccessLog,
  type AccessLogPlan,
  type DocumentAccessLogEntry,
} from "./access-log";
export {
  applyPatientMergeCascade,
  MAX_MERGE_HOPS,
  resolvePatientRedirect,
  type MergeFacts,
  type PatientRedirectResult,
} from "./merge-redirect";
