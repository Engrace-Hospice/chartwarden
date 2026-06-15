// @wardenx/audit — Audit query & reporting surface (M4-T06, M4 spec §2.1, §4.1–4.3).
//
// The permissioned search over the M1-owned, append-only `audit_event` log: the data behind
// "who touched this chart?" (§10.2), the Compliance event search (§4.2 GET /audit/events), and
// the per-patient internal access history. `audit_event` is HELPER-ONLY (manifest
// HELPER_ONLY_TABLES) — this package is its only sanctioned reader, so the query primitives live
// here and the M4 backend module consumes the typed `AuditQuery` port (never a direct schema
// SELECT). The §164.528 accounting-of-disclosures query + scope differentiation extend this
// surface in M4-T09 (§7); the retention/integrity/export layers are M4-T08/T11.
//
// All list reads are cursor-paginated (newest-first): the opaque cursor encodes the last row's
// (createdAt, id) so pagination is stable across the partitioned table. The in-memory adapter
// here is the reusable, infra-free implementation every consumer's tests run against; the
// production Drizzle adapter (org-scoped by RLS inside withOrgContext) is a tracked follow-up.

/** Read view of one `audit_event` row (a DTO — never the raw Drizzle row). */
export interface AuditEventRecord {
  readonly id: string;
  /** ISO-8601 timestamp; the partition key + the newest-first sort key. */
  readonly createdAt: string;
  readonly organizationId: string | null;
  readonly actorUserId: string | null;
  readonly actorKind: string;
  readonly actorRole: string | null;
  readonly eventType: string;
  readonly resourceKind: string;
  readonly resourceId: string | null;
  readonly outcome: "success" | "failure" | "denied";
  readonly severity: "info" | "warn" | "critical";
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly context: Record<string, unknown>;
  readonly retentionClass:
    | "operational"
    | "compliance"
    | "legal_hold"
    | "compliance_42cfr_part2";
}

/** Filters for the §4.2 audit-event search (every field optional; AND-combined). */
export interface AuditEventFilter {
  readonly actorUserId?: string;
  /** Matches events that TOUCH this patient — `context.patientId` or a `patient`-kind row. */
  readonly patientId?: string;
  readonly resourceKind?: string;
  readonly eventType?: string;
  readonly outcome?: string;
  readonly severity?: string;
  /** Inclusive lower bound on `createdAt` (ISO-8601). */
  readonly from?: string;
  /** Inclusive upper bound on `createdAt` (ISO-8601). */
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** A cursor-paginated page (newest-first). `nextCursor` is null on the last page. */
export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** Filters for the per-patient access history (§10.2 "who touched this chart"). */
export interface PatientAccessFilter {
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** One internal access / external disclosure of a patient's chart (§10.2). */
export interface PatientAccessEntry {
  readonly eventId: string;
  readonly at: string;
  readonly actorUserId: string | null;
  readonly actorRole: string | null;
  readonly eventType: string;
  /** Field NAMES surfaced by the read (never values) — from the read-capture `context.fields`. */
  readonly fields: string[];
  /** True when the access was made under an open break-glass grant (§7.4). */
  readonly viaBreakGlass: boolean;
}

/**
 * The §164.528 / 42 CFR §2.13 accounting scope (M4-T09, §7). `hipaa_528` is the regulated
 * disclosure accounting (external `*.disclosed` only, 6-year lookback); `part_2_13` is the
 * broader SUD right (Part 2 disclosures over the patient's lifetime, no clamp); `all` is the
 * union (gated by the dedicated `audit.disclosure_report_all_scopes` permission).
 */
export type AccountingScope = "hipaa_528" | "part_2_13" | "all";

/**
 * The resolved accounting window + scope the query reads against. The route computes `from`/`to`
 * per scope (the route owns the 6-year clamp vs. lifetime decision, §7.1) and the query simply
 * filters disclosures into that window.
 */
export interface AccountingFilter {
  readonly scope: AccountingScope;
  /** Inclusive lower bound on `createdAt` (ISO-8601) — the computed lookback floor. */
  readonly from: string;
  /** Inclusive upper bound on `createdAt` (ISO-8601) — normally "now". */
  readonly to: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** One disclosure line in a patient's accounting report (§4.3 / §7). Metadata only — never PHI. */
export interface DisclosureEntry {
  readonly date: string;
  readonly recipient: string;
  readonly purpose: string;
  readonly description: string;
  readonly eventId: string;
  /**
   * The rationale text on a `sud.unredact.exercise` event — surfaced ONLY for Part 2 scopes,
   * where 42 CFR §2.13 makes the requester's rationale part of the patient's right to know
   * (the §4.6.4 exception: rationale is NOT scrubbed for Part 2). Absent for HIPAA scope.
   */
  readonly rationale?: string;
}

/** A patient accounting-of-disclosures report (§4.3 response; §164.528(a)(1) TPO-exclusion note). */
export interface AccountingReport {
  readonly patientId: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly disclosures: DisclosureEntry[];
  /** The §164.528(a)(1) statement that routine treatment/payment/operations access is excluded. */
  readonly note: string;
  readonly nextCursor: string | null;
}

/**
 * The permissioned query surface over `audit_event`. `orgId` scopes every read to the tenant
 * (the production adapter relies on RLS on `app.org_id`; the in-memory adapter filters by it).
 */
export interface AuditQuery {
  searchEvents(orgId: string, filter: AuditEventFilter): Promise<Page<AuditEventRecord>>;
  getEvent(orgId: string, id: string): Promise<AuditEventRecord | null>;
  patientAccess(
    orgId: string,
    patientId: string,
    filter: PatientAccessFilter,
  ): Promise<Page<PatientAccessEntry>>;
  /** §164.528 / §2.13 accounting of disclosures for one patient, scoped + windowed (M4-T09, §7). */
  accounting(
    orgId: string,
    patientId: string,
    filter: AccountingFilter,
  ): Promise<AccountingReport>;
}

/**
 * The §164.528(a)(1) statement returned with every accounting report: routine treatment,
 * payment, and health-care-operations access is excluded (it is the broader `/access` view's
 * concern, not the patient's regulated accounting). Constant — no PHI.
 */
export const ACCOUNTING_TPO_EXCLUSION_NOTE =
  "Per 45 CFR §164.528(a)(1), this accounting excludes disclosures made for treatment, " +
  "payment, and health-care operations, and other categories exempt under §164.528(a)(1)(i)–(ix).";

/** Page-size policy: default 50, hard cap 200 (matches the §4.3 `limit` schema bound). */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** Clamp a requested limit into the [1, MAX] range, defaulting when absent. */
export function resolveLimit(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(requested)));
}

/** Encode the opaque, newest-first pagination cursor from a row's (createdAt, id). */
export function encodeCursor(row: { createdAt: string; id: string }): string {
  return Buffer.from(`${row.createdAt}|${row.id}`, "utf8").toString("base64url");
}

/** Decode a cursor back to its (createdAt, id); returns null when malformed (treated as "start"). */
export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep <= 0) return null;
    return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

/** Newest-first ordering: createdAt desc, then id desc (stable across equal timestamps). */
function compareNewestFirst(a: AuditEventRecord, b: AuditEventRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** True when `record` is strictly older than the cursor position (newest-first paging). */
function isAfterCursor(record: AuditEventRecord, cursor: { createdAt: string; id: string }): boolean {
  if (record.createdAt !== cursor.createdAt) return record.createdAt < cursor.createdAt;
  return record.id < cursor.id;
}

/** True when an event touches `patientId` — via `context.patientId` or a `patient`-kind row. */
export function eventTouchesPatient(record: AuditEventRecord, patientId: string): boolean {
  if (record.context.patientId === patientId) return true;
  return record.resourceKind === "patient" && record.resourceId === patientId;
}

/** True when an event represents an ACCESS (read, disclosure, or under-glass access) — §10.2. */
export function isAccessEvent(record: AuditEventRecord): boolean {
  const t = record.eventType;
  if (t.endsWith(".viewed") || t.endsWith(".disclosed") || t.endsWith(".list_viewed")) return true;
  if (t.endsWith(".access") || t.includes("breakglass.access")) return true;
  return typeof record.context.breakGlassEventId === "string";
}

/** True when an event is an external DISCLOSURE (`<kind>.disclosed`) — the §164.528 unit. */
function isDisclosureEvent(record: AuditEventRecord): boolean {
  return record.eventType.endsWith(".disclosed");
}

/** True when an event carries the Part 2 retention class (a SUD-class disclosure/action, §6). */
function isPartTwoEvent(record: AuditEventRecord): boolean {
  return record.retentionClass === "compliance_42cfr_part2";
}

/** True for a SUD privileged-unredact exercise (`sud.unredact.exercise`) — Part 2 accountable. */
function isUnredactExerciseEvent(record: AuditEventRecord): boolean {
  return record.eventType === "sud.unredact.exercise";
}

/**
 * Whether an event belongs in the accounting set for `scope` (§7, §4.3):
 *   • `hipaa_528` — external `*.disclosed` events only (routine `*.viewed` TPO is excluded).
 *   • `part_2_13` — disclosures of SUD-class (`compliance_42cfr_part2`) records + every
 *     `sud.unredact.exercise`; the route windows these over the patient's lifetime (no clamp).
 *   • `all` — the union (any disclosure + any unredact exercise).
 */
export function inAccountingScope(record: AuditEventRecord, scope: AccountingScope): boolean {
  const disclosure = isDisclosureEvent(record);
  switch (scope) {
    case "hipaa_528":
      return disclosure;
    case "part_2_13":
      return (disclosure && isPartTwoEvent(record)) || isUnredactExerciseEvent(record);
    case "all":
      return disclosure || isUnredactExerciseEvent(record);
  }
}

/** Coerce a context string field, or `undefined` when absent/ill-typed. */
function contextString(context: Record<string, unknown>, field: string): string | undefined {
  const value = context[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Project an in-scope event into one accounting disclosure line (metadata only, never PHI). */
function toDisclosureEntry(record: AuditEventRecord, scope: AccountingScope): DisclosureEntry {
  const disclosure = record.context.disclosure as
    | { to?: unknown; purpose?: unknown }
    | undefined;
  const recipient =
    (typeof disclosure?.to === "string" && disclosure.to) ||
    contextString(record.context, "recipient") ||
    "internal";
  const purpose =
    (typeof disclosure?.purpose === "string" && disclosure.purpose) ||
    contextString(record.context, "purpose") ||
    record.eventType;
  const rawFields = record.context.fields;
  const fields = Array.isArray(rawFields)
    ? rawFields.filter((f): f is string => typeof f === "string")
    : [];
  const description = fields.length > 0 ? `${record.resourceKind}: ${fields.join(", ")}` : record.resourceKind;
  // §4.6.4: the unredact rationale is patient-accessible under Part 2 — surface it for Part 2
  // scopes only (HIPAA accounting never carries it).
  const rationale = scope !== "hipaa_528" ? contextString(record.context, "rationale") : undefined;
  return {
    date: record.createdAt,
    recipient,
    purpose,
    description,
    eventId: record.id,
    ...(rationale !== undefined ? { rationale } : {}),
  };
}

/** Apply the §4.2 filter to one record (org scope is applied by the caller). */
function matchesFilter(record: AuditEventRecord, filter: AuditEventFilter): boolean {
  if (filter.actorUserId && record.actorUserId !== filter.actorUserId) return false;
  if (filter.resourceKind && record.resourceKind !== filter.resourceKind) return false;
  if (filter.eventType && record.eventType !== filter.eventType) return false;
  if (filter.outcome && record.outcome !== filter.outcome) return false;
  if (filter.severity && record.severity !== filter.severity) return false;
  if (filter.from && record.createdAt < filter.from) return false;
  if (filter.to && record.createdAt > filter.to) return false;
  if (filter.patientId && !eventTouchesPatient(record, filter.patientId)) return false;
  return true;
}

/** Sort newest-first, page past the cursor, and take `limit` (+1 lookahead for `nextCursor`). */
function paginate<T extends AuditEventRecord>(
  records: T[],
  cursor: string | undefined,
  limit: number,
): { page: T[]; nextCursor: string | null } {
  const sorted = [...records].sort(compareNewestFirst);
  const start = cursor ? decodeCursor(cursor) : null;
  const windowed = start ? sorted.filter((r) => isAfterCursor(r, start)) : sorted;
  const page = windowed.slice(0, limit);
  const nextCursor =
    windowed.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null;
  return { page, nextCursor };
}

/** Project an access record into the §10.2 patient-access entry. */
function toPatientAccessEntry(record: AuditEventRecord): PatientAccessEntry {
  const rawFields = record.context.fields;
  const fields = Array.isArray(rawFields)
    ? rawFields.filter((f): f is string => typeof f === "string")
    : [];
  const viaBreakGlass =
    typeof record.context.breakGlassEventId === "string" ||
    record.eventType.includes("breakglass");
  return {
    eventId: record.id,
    at: record.createdAt,
    actorUserId: record.actorUserId,
    actorRole: record.actorRole,
    eventType: record.eventType,
    fields,
    viaBreakGlass,
  };
}

/**
 * In-memory `AuditQuery` over a seeded record set — the reusable, infra-free adapter the route
 * tests run against (the production Drizzle adapter that SELECTs `audit_event` inside
 * `withOrgContext` is a tracked follow-up). Reads are org-scoped: a tenant query never sees
 * another org's rows (and never the org-NULL platform/system events).
 */
export function createInMemoryAuditQuery(seed: readonly AuditEventRecord[] = []): {
  query: AuditQuery;
  add(record: AuditEventRecord): void;
} {
  const records: AuditEventRecord[] = [...seed];
  const inOrg = (orgId: string) => records.filter((r) => r.organizationId === orgId);

  const query: AuditQuery = {
    searchEvents(orgId, filter) {
      const matched = inOrg(orgId).filter((r) => matchesFilter(r, filter));
      const { page, nextCursor } = paginate(matched, filter.cursor, resolveLimit(filter.limit));
      return Promise.resolve({ items: page, nextCursor });
    },
    getEvent(orgId, id) {
      return Promise.resolve(inOrg(orgId).find((r) => r.id === id) ?? null);
    },
    patientAccess(orgId, patientId, filter) {
      const matched = inOrg(orgId).filter(
        (r) => eventTouchesPatient(r, patientId) && isAccessEvent(r),
      );
      const { page, nextCursor } = paginate(matched, filter.cursor, resolveLimit(filter.limit));
      return Promise.resolve({ items: page.map(toPatientAccessEntry), nextCursor });
    },
    accounting(orgId, patientId, filter) {
      const matched = inOrg(orgId).filter(
        (r) =>
          eventTouchesPatient(r, patientId) &&
          inAccountingScope(r, filter.scope) &&
          r.createdAt >= filter.from &&
          r.createdAt <= filter.to,
      );
      const { page, nextCursor } = paginate(matched, filter.cursor, resolveLimit(filter.limit));
      return Promise.resolve({
        patientId,
        period: { from: filter.from, to: filter.to },
        disclosures: page.map((r) => toDisclosureEntry(r, filter.scope)),
        note: ACCOUNTING_TPO_EXCLUSION_NOTE,
        nextCursor,
      });
    },
  };

  return { query, add: (record) => void records.push(record) };
}
