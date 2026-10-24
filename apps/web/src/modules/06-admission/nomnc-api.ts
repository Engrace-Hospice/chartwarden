// apps/web/src/modules/06-admission/nomnc-api.ts — typed calls for the NOMNC delivery record and the BFCC-QIO expedited
// review (milestone 10a). RECORD-KEEPING ONLY: staff type what the notice or the QIO's call said (a local date AND a
// time of day, plus where it came from) and the server converts it in the organization's zone. The server owns every
// refusal; its message is shown verbatim.
import type { ApiClient } from "@chartwarden/ui";

export type RecipientKind = "beneficiary" | "representative";
export type AcknowledgementKind = "signed" | "refused" | "other";
export type DeadlineKind =
  | "appeal_request"
  | "denc_delivery"
  | "records_to_qio"
  | "qio_decision"
  | "other";
export type DecisionOutcome = "discharge_upheld" | "discharge_reversed" | "other";
export type RequestedByKind = "beneficiary" | "representative" | "unknown";
export type DeadlineStatus = "open" | "due_soon" | "past" | "satisfied" | "closed";

/** A typed local date and time of day. Both stay empty until a person fills them: nothing is prefilled. */
export interface TypedMoment {
  date?: string | null;
  time?: string | null;
}

export interface NoticeView {
  id: string;
  admissionId: string;
  status: "active" | "superseded" | "withdrawn";
  servicesEndOn: string;
  deliveredAt: string;
  recipientKind: RecipientKind;
  representativeName: string | null;
  deliveryNote: string | null;
  acknowledgementKind: AcknowledgementKind | null;
  acknowledgementNote: string | null;
  documentId: string | null;
  sourceNote: string;
  withdrawnReason: string | null;
  version: number;
}

export interface ReviewView {
  id: string;
  admissionId: string;
  nomncNoticeId: string;
  state: "open" | "decided" | "withdrawn";
  qioName: string;
  qioReference: string | null;
  qioNotifiedAt: string;
  requestedByKind: RequestedByKind;
  dencDeliveredAt: string | null;
  recordsSentAt: string | null;
  recordsSentNote: string | null;
  decisionOutcome: DecisionOutcome | null;
  decisionReceivedAt: string | null;
  decisionNote: string | null;
  version: number;
}

export interface DeadlineView {
  id: string;
  subject: "notice" | "review";
  subjectId: string;
  kind: DeadlineKind;
  label: string | null;
  dueAt: string;
  /** What the person typed (`YYYY-MM-DDTHH:MM` in `zone`), shown back verbatim. */
  dueLocal: string;
  zone: string;
  sourceNote: string;
  satisfiedAt: string | null;
  status: DeadlineStatus;
  version: number;
}

export interface Prompt {
  code: string;
  severity: "warn" | "info";
  message: string;
}

export interface NomncOverview {
  admissionId: string;
  timeZone: string;
  activeNotice: NoticeView | null;
  history: NoticeView[];
  review: ReviewView | null;
  deadlines: DeadlineView[];
  prompts: Prompt[];
}

export interface RecordNoticeInput {
  supersedesId?: string | null;
  servicesEndOn: string;
  delivered: TypedMoment;
  recipientKind: RecipientKind;
  representativeName?: string | null;
  deliveryNote?: string | null;
  acknowledgementKind?: AcknowledgementKind | null;
  acknowledgementNote?: string | null;
  sourceNote: string;
}

export interface OpenReviewInput {
  qioName: string;
  qioReference?: string | null;
  qioNotified: TypedMoment;
  requestedByKind: RequestedByKind;
}

export interface ReviewFactsInput {
  dencDelivered?: TypedMoment;
  recordsSent?: TypedMoment;
  recordsSentNote?: string | null;
  decision?: { outcome: DecisionOutcome; received: TypedMoment; note?: string | null };
}

export interface AddDeadlineInput {
  kind: DeadlineKind;
  label?: string | null;
  due: TypedMoment;
  sourceNote: string;
}

export interface NomncApi {
  overview(admissionId: string, dischargeReason?: string): Promise<NomncOverview>;
  recordNotice(admissionId: string, input: RecordNoticeInput): Promise<NoticeView>;
  setAcknowledgement(
    admissionId: string,
    notice: NoticeView,
    kind: AcknowledgementKind | null,
    note: string | null,
  ): Promise<NoticeView>;
  withdrawNotice(admissionId: string, notice: NoticeView, reason: string): Promise<NoticeView>;
  openReview(admissionId: string, notice: NoticeView, input: OpenReviewInput): Promise<ReviewView>;
  recordReviewFacts(
    admissionId: string,
    review: ReviewView,
    input: ReviewFactsInput,
  ): Promise<ReviewView>;
  withdrawReview(admissionId: string, review: ReviewView): Promise<ReviewView>;
  addNoticeDeadline(
    admissionId: string,
    notice: NoticeView,
    input: AddDeadlineInput,
  ): Promise<DeadlineView>;
  addReviewDeadline(
    admissionId: string,
    review: ReviewView,
    input: AddDeadlineInput,
  ): Promise<DeadlineView>;
  editDeadline(
    admissionId: string,
    deadline: DeadlineView,
    patch: { due?: TypedMoment; sourceNote?: string; satisfy?: boolean },
  ): Promise<DeadlineView>;
}

/** The server's own message when present, else a plain fallback. */
export function apiMessage(error: unknown, fallback: string): string {
  const e = error as { message?: unknown; error?: { message?: unknown } } | null | undefined;
  const msg = typeof e?.message === "string" ? e.message : e?.error?.message;
  return typeof msg === "string" && msg.length > 0 ? msg : fallback;
}

/** A refused call. `conflict` = HTTP 409: the record changed (or is no longer in the state the call needs). */
export class NomncApiError extends Error {
  constructor(
    message: string,
    readonly conflict: boolean,
  ) {
    super(message);
    this.name = "NomncApiError";
  }
}

/** True when the server answered 409: reload and rebind instead of retrying blind. */
export const isConflict = (e: unknown): boolean => e instanceof NomncApiError && e.conflict;

function unwrap<T>(
  res: { data?: unknown; error?: unknown; response?: { status?: number } },
  fallback: string,
): T {
  if (res.error || res.data === undefined) {
    throw new NomncApiError(apiMessage(res.error, fallback), res.response?.status === 409);
  }
  return res.data as T;
}

const NOTICE = "/api/v1/admissions/{id}/nomnc/{noticeId}" as const;
const REVIEW = "/api/v1/admissions/{id}/expedited-reviews/{reviewId}" as const;

export function createNomncApi(client: ApiClient): NomncApi {
  const onNotice = (id: string, n: NoticeView) => ({ params: { path: { id, noticeId: n.id } } });
  const onReview = (id: string, r: ReviewView) => ({ params: { path: { id, reviewId: r.id } } });
  return {
    async overview(admissionId, dischargeReason) {
      const o = unwrap<NomncOverview>(
        await client.GET("/api/v1/admissions/{id}/nomnc", {
          params: {
            path: { id: admissionId },
            query: dischargeReason ? { dischargeReason } : {},
          },
        }),
        "Could not load the NOMNC record.",
      );
      if (!Array.isArray(o.history) || !Array.isArray(o.deadlines) || !Array.isArray(o.prompts)) {
        throw new Error("Could not load the NOMNC record.");
      }
      return o;
    },
    async recordNotice(admissionId, input) {
      return unwrap(
        await client.POST("/api/v1/admissions/{id}/nomnc", {
          params: { path: { id: admissionId } },
          body: input,
        }),
        "Could not record the NOMNC.",
      );
    },
    async setAcknowledgement(admissionId, notice, kind, note) {
      return unwrap(
        await client.PATCH(NOTICE, {
          ...onNotice(admissionId, notice),
          body: { ifVersion: notice.version, acknowledgementKind: kind, acknowledgementNote: note },
        }),
        "Could not record the acknowledgement.",
      );
    },
    async withdrawNotice(admissionId, notice, reason) {
      return unwrap(
        await client.POST(`${NOTICE}/withdraw`, {
          ...onNotice(admissionId, notice),
          body: { ifVersion: notice.version, reason },
        }),
        "Could not withdraw the NOMNC record.",
      );
    },
    async openReview(admissionId, notice, input) {
      return unwrap(
        await client.POST(`${NOTICE}/expedited-review`, {
          ...onNotice(admissionId, notice),
          body: input,
        }),
        "Could not open the QIO review.",
      );
    },
    async recordReviewFacts(admissionId, review, input) {
      return unwrap(
        await client.PATCH(REVIEW, {
          ...onReview(admissionId, review),
          body: { ifVersion: review.version, ...input },
        }),
        "Could not save the QIO review.",
      );
    },
    async withdrawReview(admissionId, review) {
      return unwrap(
        await client.POST(`${REVIEW}/withdraw`, {
          ...onReview(admissionId, review),
          body: { ifVersion: review.version },
        }),
        "Could not withdraw the QIO review.",
      );
    },
    async addNoticeDeadline(admissionId, notice, input) {
      return unwrap(
        await client.POST(`${NOTICE}/deadlines`, { ...onNotice(admissionId, notice), body: input }),
        "Could not record the deadline.",
      );
    },
    async addReviewDeadline(admissionId, review, input) {
      return unwrap(
        await client.POST(`${REVIEW}/deadlines`, { ...onReview(admissionId, review), body: input }),
        "Could not record the deadline.",
      );
    },
    async editDeadline(admissionId, deadline, patch) {
      return unwrap(
        await client.PATCH("/api/v1/admissions/{id}/expedited-deadlines/{deadlineId}", {
          params: { path: { id: admissionId, deadlineId: deadline.id } },
          body: { ifVersion: deadline.version, ...patch },
        }),
        "Could not update the deadline.",
      );
    },
  };
}
