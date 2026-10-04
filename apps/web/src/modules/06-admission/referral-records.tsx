import { Button, EmptyState, LoadingSpinner, Modal, SelectField, StatusPill, t } from "@wardenx/ui";
import type { ApiClient, StatusTone } from "@wardenx/ui";
import { useApiClient } from "@wardenx/ui";
// apps/web/src/modules/06-admission — the referral page's "Records" tab (F-238). Intake starts with the
// referral: the records a referral source faxes, emails or hands over on paper are filed AGAINST the
// referral and read by DocLens (M22) — the batch takes the referral's patient once M6 has resolved one.
//
// Reads `GET /api/v1/intake/referral-batches?referralId=` — strictly the batches filed against THIS
// referral (statuses + counts, never an extracted value); the server checks the caller can read the
// referral. "Add records" files a file the same way the intake pipeline does: the checksum-verified
// upload (`verifiedUpload`, shared shell) → `POST /api/v1/intake/uploads { documentId, referralId,
// sourceChannel }` → `POST …/{id}/extraction/run`. The server owns every gate (ADR-0030); a run the
// server refuses (DocLens off for the tenant, no queue) leaves the batch filed and says so.
//
// Module boundary: M22 depends on M6, so this M6 screen cannot import `22-documents/*` (an M6→M22 edge
// would cycle the module graph). The status tone comes from the shared shell (`lifecycleTone`, which
// M22's lantern re-exports); the short status / channel labels below mirror `22-documents/doclens-model`.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link } from "react-router-dom";
import { lifecycleTone } from "../../shell/document-lifecycle-tone";
import { IntakeUploadDialog } from "../../shell/intake-upload-dialog";
import { ReferralRecordsRequests } from "./referral-records-requests";

type ReferralBatch = {
  id: string;
  referralId: string;
  patientId: string | null;
  status: string;
  sourceChannel: string;
  identityStatus: string | null;
  sudStatus: "not_detected" | "detected" | "confirmed" | "rejected";
  /** F-238 — a records-request code on the fax names another referral / patient (not moved). */
  recordsRequestConflict: {
    code: string;
    kind: "code_names_another_referral" | "code_names_another_patient";
  } | null;
  pages: number;
  documents: number;
  candidates: number;
  review: { id: string; status: string; decided: number } | null;
  uploadedAt: string;
  createdAt: string;
};

// Mirrors 22-documents/doclens-model.ts (see the module-boundary note above).
const BATCH_STATUS_LABEL: Record<string, string> = {
  uploaded: "Uploaded",
  docling_complete: "Reading pages",
  classifier_complete: "Classified",
  extraction_complete: "Ready for review",
  in_review: "In review",
  writeback_complete: "Complete",
  discarded: "Discarded",
  split_into_children: "Split",
  split_resolved_no_split: "Not split",
  parse_failed: "Could not read",
};
const CHANNEL_LABEL: Record<string, string> = {
  fax: "Fax",
  email_ingest: "Email",
  portal_upload: "Portal",
  admin_upload: "Scanned upload",
  api: "API",
};
const IDENTITY: Record<string, { label: string; tone: StatusTone }> = {
  match: { label: "Identity matches", tone: "success" },
  possible: { label: "Identity: check", tone: "warning" },
  mismatch: { label: "Identity mismatch", tone: "critical" },
  unverified: { label: "Identity unverified", tone: "neutral" },
  no_target: { label: "No patient to check", tone: "neutral" },
};
const SUD_PILL: Partial<Record<ReferralBatch["sudStatus"], { label: string; tone: StatusTone }>> = {
  detected: { label: "SUD flag — unresolved", tone: "critical" },
  confirmed: { label: "SUD confirmed", tone: "warning" },
};
const CONFLICT_LABEL: Record<NonNullable<ReferralBatch["recordsRequestConflict"]>["kind"], string> =
  {
    code_names_another_referral: "Request code is for another referral",
    code_names_another_patient: "Request code is for another patient",
  };
/** Statuses with extracted fields to open in the side-by-side review. */
const REVIEWABLE = new Set(["extraction_complete", "in_review", "writeback_complete"]);

const words = (v: string): string => v.replace(/_/g, " ");
const statusLabel = (v: string): string => BATCH_STATUS_LABEL[v] ?? words(v);
const channelLabel = (v: string): string => CHANNEL_LABEL[v] ?? words(v);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
const receivedAt = (v: string): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};
const errorText = (err: unknown, fallback: string): string => {
  const e = err as { error?: { message?: string }; message?: string } | undefined;
  return e?.error?.message ?? e?.message ?? fallback;
};

export function ReferralRecords({
  referralId,
  patientId,
}: {
  referralId: string;
  patientId: string | null;
}): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<ReferralBatch[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(false);
    const r = await client
      .GET("/api/v1/intake/referral-batches", { params: { query: { referralId } } })
      .catch(() => null);
    if (!r || r.error || !r.data) {
      setItems(null);
      setError(true);
      return;
    }
    setItems([...(r.data.items as ReferralBatch[])]);
    setCursor(r.data.hasMore ? r.data.nextCursor : null);
  }, [client, referralId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (!cursor || !items) return;
    const r = await client
      .GET("/api/v1/intake/referral-batches", { params: { query: { referralId, cursor } } })
      .catch(() => null);
    if (!r || r.error || !r.data) return;
    setItems([...items, ...(r.data.items as ReferralBatch[])]);
    setCursor(r.data.hasMore ? r.data.nextCursor : null);
  }

  return (
    <div style={stack}>
      <section style={section} aria-label="Intake records">
        <div style={sectionHead}>
          <div>
            <h2 style={heading}>Records</h2>
            <p style={muted}>
              Faxes, emailed and scanned records for this referral. WardenLens reads them; a
              reviewer checks every field against the page before anything reaches the chart.
            </p>
          </div>
          <Button onClick={() => setUploadOpen(true)}>Add records</Button>
        </div>

        {notice ? (
          <output style={noticeBox} aria-live="polite">
            {notice}
          </output>
        ) : null}

        {error ? (
          <EmptyState
            title="Records unavailable"
            description="The intake records for this referral could not be loaded."
            action={
              <Button tone="secondary" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        ) : items === null ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <EmptyState
            title="No records yet"
            description="Nothing has been filed against this referral. Add the faxed, emailed or scanned records the referral source sent."
          />
        ) : (
          <ul style={list} aria-label="Intake batches">
            {items.map((b) => (
              <BatchRow key={b.id} batch={b} />
            ))}
          </ul>
        )}
        {cursor ? (
          <div>
            <Button tone="tertiary" onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        ) : null}
      </section>

      <ReferralRecordsRequests referralId={referralId} />

      <IntakeUploadDialog
        open={uploadOpen}
        client={client}
        referralId={referralId}
        patientId={patientId}
        onClose={() => setUploadOpen(false)}
        onFiled={(message) => {
          setUploadOpen(false);
          setNotice(message);
          void load();
        }}
      />
    </div>
  );
}

function BatchRow({ batch: b }: { batch: ReferralBatch }): JSX.Element {
  const identity = b.identityStatus ? IDENTITY[b.identityStatus] : undefined;
  const sud = SUD_PILL[b.sudStatus];
  const conflict = b.recordsRequestConflict;
  const reviewable = REVIEWABLE.has(b.status);
  return (
    <li style={row}>
      <div style={rowMain}>
        <strong>
          {channelLabel(b.sourceChannel)} · received {receivedAt(b.uploadedAt)}
        </strong>
        <span style={muted}>
          {b.pages > 0 ? plural(b.pages, "page") : "Pages not read yet"}
          {b.documents > 0 ? ` · ${plural(b.documents, "document")}` : ""}
          {b.candidates > 0
            ? ` · ${b.review ? `${b.review.decided} of ${b.candidates}` : `0 of ${b.candidates}`} fields reviewed`
            : ""}
        </span>
        <div style={pills}>
          <StatusPill label={statusLabel(b.status)} tone={lifecycleTone(b.status)} />
          {identity ? <StatusPill label={identity.label} tone={identity.tone} /> : null}
          {sud ? <StatusPill label={sud.label} tone={sud.tone} /> : null}
          {conflict ? (
            <StatusPill
              label={`${CONFLICT_LABEL[conflict.kind]} (${conflict.code})`}
              tone="critical"
            />
          ) : null}
        </div>
      </div>
      <Link
        to={reviewable ? `/intake/${b.id}/review` : `/intake/${b.id}`}
        className={reviewable ? "wx-btn-primary" : undefined}
        aria-label={`${reviewable ? "Review" : "View"} ${channelLabel(b.sourceChannel)} received ${receivedAt(b.uploadedAt)}`}
      >
        {reviewable ? "Review" : "View"}
      </Link>
    </li>
  );
}

const stack: CSSProperties = { display: "grid", gap: "1rem", minWidth: 0 };
const section: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  background: "var(--color-surface)",
  padding: "1rem",
  display: "grid",
  gap: "0.85rem",
};
const sectionHead: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
  flexWrap: "wrap",
};
const heading: CSSProperties = { margin: 0, fontSize: "1rem" };
const muted: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.875rem",
};
const list: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.6rem",
};
const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  padding: "0.75rem",
};
const rowMain: CSSProperties = { display: "grid", gap: "0.3rem", minWidth: 0 };
const pills: CSSProperties = { display: "flex", gap: "0.4rem", flexWrap: "wrap" };
const noticeBox: CSSProperties = {
  display: "block",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  padding: "0.6rem 0.8rem",
  fontSize: "0.875rem",
};
