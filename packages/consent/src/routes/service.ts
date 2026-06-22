// @wardenx/consent — the ConsentRouteService (M39-T07 §4.1 route backend slice).
//
// The injectable surface the M39 routes compose over: create-draft → sign → revoke lifecycle (the
// §2.2.1 status machine), patient-scoped consent lists, the catalog read, and the cursor-paginated
// consent_eval_audit query (§4.12 — opaque cursor, never offset). In-memory in the slice; the
// Drizzle-backed implementation (T09) replaces it without changing the route layer. The deeper
// regulatory flows (revocation cascade, DPOA chain, post-death) compose the T04 engine in T09; this
// service is the thin transactional shell the routes + integration tests exercise.
import type { ConsentCaptureMethod, ConsentGrantorKind, ConsentTypeKey } from "../interfaces/kinds";
import { nextConsentStatus } from "../lifecycle/status-machine";
import { validateRevocation } from "../validation/rules";

export interface ConsentRecordView {
  id: string;
  organizationId: string;
  patientId: string;
  typeKey: ConsentTypeKey;
  grantorKind: ConsentGrantorKind;
  captureMethod: ConsentCaptureMethod;
  scopeDescriptor: unknown;
  status: "draft" | "active" | "superseded" | "revoked" | "expired";
  version: number;
  effectiveAt: string | null;
  expiresAt: string | null;
  signedAt: string | null;
  createdById: string;
}

export interface CreateConsentDraftInput {
  patientId: string;
  typeKey: ConsentTypeKey;
  grantorKind: ConsentGrantorKind;
  captureMethod: ConsentCaptureMethod;
  scopeDescriptor: unknown;
  createdById: string;
}

export interface RevokeConsentInput {
  actorIsStaff: boolean;
  revokedByKind:
    | "patient_self_via_portal"
    | "staff"
    | "dpoa_agent"
    | "court_order"
    | "platform_admin_break_glass";
  reasonText: string;
  evidenceDocumentId: string | null;
  revokedById: string;
}

export interface EvalAuditRow {
  id: string;
  organizationId: string;
  patientId: string;
  consentRecordId: string | null;
  typeKey: ConsentTypeKey;
  allowed: boolean;
  denyReason: string | null;
  callerModule: string;
  evaluatedAt: string; // ISO; the cursor key (with id as tiebreak)
}

export interface CursorPage<T> {
  rows: T[];
  nextCursor: string | null;
}

export class ConsentRouteError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_transition" | "validation",
    message: string,
  ) {
    super(message);
    this.name = "ConsentRouteError";
  }
}

/** A value the routes `await`: the in-memory slice returns it synchronously; the Drizzle-backed
 *  production impl (FB-T03, `consent-store-db.ts`) returns a Promise. Widening to this union lets the
 *  one route layer drive both backends without forcing the in-memory slice (+ its M39 acceptance
 *  tests, which read `.id`/`.status` synchronously) onto Promises. */
export type Awaitable<T> = T | Promise<T>;

/** Wrap every method's return type in {@link Awaitable} — the awaitable view of a service interface a
 *  Drizzle backend can implement while the in-memory slice still returns synchronously. */
export type AwaitableService<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => infer R ? (...args: A) => Awaitable<R> : S[K];
};

export interface ConsentCatalogView {
  typeKey: ConsentTypeKey;
  displayNameEn: string;
  scopeDiscriminator: string;
  isPerRecipient: boolean;
}

/** The SYNCHRONOUS consent route backend — the canonical method shapes. The in-memory slice (+ its
 *  M39 acceptance tests, which chain `.id`/`.status` synchronously) implements this directly. */
export interface SyncConsentRouteService {
  readCatalog(organizationId: string): ConsentCatalogView[];
  listConsentsForPatient(organizationId: string, patientId: string): ConsentRecordView[];
  getConsent(organizationId: string, consentId: string): ConsentRecordView | null;
  createDraft(organizationId: string, input: CreateConsentDraftInput): ConsentRecordView;
  signConsent(
    organizationId: string,
    consentId: string,
    signerId: string,
    nowIso: string,
  ): ConsentRecordView;
  revokeConsent(
    organizationId: string,
    consentId: string,
    input: RevokeConsentInput,
    nowIso: string,
  ): ConsentRecordView;
  /** §4.12 cursor-paginated consent-decision audit, by consent or by patient. */
  listEvalAudit(
    organizationId: string,
    filter: { consentId?: string; patientId?: string },
    page: { cursor?: string; pageSize: number },
  ): CursorPage<EvalAuditRow>;
}

/** What the routes consume: the awaitable view of {@link SyncConsentRouteService}. The in-memory slice
 *  (sync) is assignable to it (a `T` satisfies `T | Promise<T>`); the Drizzle-backed production impl
 *  (FB-T03) returns Promises. The one route layer `await`s either. */
export type ConsentRouteService = AwaitableService<SyncConsentRouteService>;

export interface InMemoryConsentRouteData {
  records: ConsentRecordView[];
  evalAudit: EvalAuditRow[];
  catalog: ConsentCatalogView[];
}

const DEFAULT_CATALOG: ConsentCatalogView[] = [
  {
    typeKey: "hipaa_release",
    displayNameEn: "HIPAA Authorization",
    scopeDiscriminator: "per_recipient",
    isPerRecipient: true,
  },
  {
    typeKey: "42_cfr_part_2_release",
    displayNameEn: "42 CFR Part 2 Release",
    scopeDiscriminator: "per_recipient",
    isPerRecipient: true,
  },
  {
    typeKey: "portal_access",
    displayNameEn: "Portal Access",
    scopeDiscriminator: "categorical",
    isPerRecipient: false,
  },
  {
    typeKey: "dpoa_healthcare",
    displayNameEn: "DPOA — Healthcare",
    scopeDiscriminator: "per_named_agent",
    isPerRecipient: false,
  },
];

/** Encode/decode the opaque cursor (base64 of `evaluatedAt|id`). Never an offset (§4.12). */
function encodeCursor(row: EvalAuditRow): string {
  return Buffer.from(`${row.evaluatedAt}|${row.id}`, "utf8").toString("base64url");
}
function decodeCursor(cursor: string): { evaluatedAt: string; id: string } | null {
  try {
    const [evaluatedAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!evaluatedAt || !id) return null;
    return { evaluatedAt, id };
  } catch {
    return null;
  }
}

let idSeq = 0;
function newId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq.toString(16).padStart(8, "0")}`;
}

// The in-memory service is typed `SyncConsentRouteService` (NOT the awaitable `ConsentRouteService`)
// so the existing M39 route/workflow acceptance tests read `service.createDraft(...).id`
// synchronously. The sync service is still structurally assignable to the awaitable
// `ConsentRouteService` the routes consume (a `T` satisfies `T | Promise<T>`).
export function createInMemoryConsentRouteService(data: Partial<InMemoryConsentRouteData> = {}): {
  service: SyncConsentRouteService;
  data: InMemoryConsentRouteData;
} {
  const store: InMemoryConsentRouteData = {
    records: data.records ?? [],
    evalAudit: data.evalAudit ?? [],
    catalog: data.catalog ?? DEFAULT_CATALOG,
  };

  const find = (organizationId: string, consentId: string): ConsentRecordView | null =>
    store.records.find((r) => r.organizationId === organizationId && r.id === consentId) ?? null;

  const service: SyncConsentRouteService = {
    readCatalog() {
      return [...store.catalog];
    },

    listConsentsForPatient(organizationId, patientId) {
      return store.records.filter(
        (r) =>
          r.organizationId === organizationId && r.patientId === patientId && r.status === "active",
      );
    },

    getConsent(organizationId, consentId) {
      return find(organizationId, consentId);
    },

    createDraft(organizationId, input) {
      const record: ConsentRecordView = {
        id: newId("consent"),
        organizationId,
        patientId: input.patientId,
        typeKey: input.typeKey,
        grantorKind: input.grantorKind,
        captureMethod: input.captureMethod,
        scopeDescriptor: input.scopeDescriptor,
        status: "draft",
        version: 0,
        effectiveAt: null,
        expiresAt: null,
        signedAt: null,
        createdById: input.createdById,
      };
      store.records.push(record);
      return record;
    },

    signConsent(organizationId, consentId, signerId, nowIso) {
      const record = find(organizationId, consentId);
      if (!record) throw new ConsentRouteError("not_found", "consent not found");
      const t = nextConsentStatus(record.status, "sign");
      if (!t.ok) throw new ConsentRouteError("invalid_transition", t.message);
      record.status = "active";
      record.effectiveAt = nowIso;
      record.signedAt = nowIso;
      return record;
    },

    revokeConsent(organizationId, consentId, input, nowIso) {
      const record = find(organizationId, consentId);
      if (!record) throw new ConsentRouteError("not_found", "consent not found");
      const v = validateRevocation({
        actorIsStaff: input.actorIsStaff,
        reasonText: input.reasonText,
        evidenceDocumentId: input.evidenceDocumentId,
      });
      if (!v.ok) throw new ConsentRouteError("validation", v.message);
      const t = nextConsentStatus(record.status, "revoke");
      if (!t.ok) throw new ConsentRouteError("invalid_transition", t.message);
      record.status = "revoked";
      void nowIso;
      return record;
    },

    listEvalAudit(organizationId, filter, page) {
      let rows = store.evalAudit
        .filter((r) => r.organizationId === organizationId)
        .filter((r) => (filter.consentId ? r.consentRecordId === filter.consentId : true))
        .filter((r) => (filter.patientId ? r.patientId === filter.patientId : true))
        // newest first, stable by id
        .sort((a, b) =>
          b.evaluatedAt === a.evaluatedAt
            ? b.id.localeCompare(a.id)
            : b.evaluatedAt.localeCompare(a.evaluatedAt),
        );

      if (page.cursor) {
        const c = decodeCursor(page.cursor);
        if (c) {
          rows = rows.filter(
            (r) =>
              r.evaluatedAt < c.evaluatedAt || (r.evaluatedAt === c.evaluatedAt && r.id < c.id),
          );
        }
      }
      const pageRows = rows.slice(0, page.pageSize);
      const nextCursor =
        rows.length > page.pageSize ? encodeCursor(pageRows[pageRows.length - 1]!) : null;
      return { rows: pageRows, nextCursor };
    },
  };

  return { service, data: store };
}
