// apps/web/src/shell/hospice-coverage.tsx — COP27 (42 CFR 418.24(c)) hospice coverage determination UI,
// shared by M12 (medication orders) and M21 (dme / supply requests). Lives in the shell because two modules
// render it and web modules do not import each other.
//
// The server is authoritative (reason required when not covered → 422 COVERAGE_REASON_REQUIRED; kit kinds
// refused); `validateCoverageForm` mirrors that rule so the clinician sees it before the round-trip.
// Styling: the redesign kit (SelectField / TextAreaField / Button / StatusPill / InlineAlert) inside a flat
// `wx-clinical-section` with label/value rows — no inline styles, tokens only.
import {
  Button,
  Glyph,
  InlineAlert,
  SelectField,
  StatusPill,
  type StatusTone,
  TextAreaField,
} from "@wardenx/ui";
import { useId, useState } from "react";
import type { JSX } from "react";

export type HospiceCoverage = "covered_related" | "not_covered_unrelated" | "not_covered_other";

/** Mirrors the server's `COVERAGE_REASON_MAX_LENGTH`. */
export const COVERAGE_REASON_MAX = 2000;

export const HOSPICE_COVERAGE_LABEL: Record<HospiceCoverage, string> = {
  covered_related: "Covered — related",
  not_covered_unrelated: "Not covered — unrelated",
  not_covered_other: "Not covered — other",
};

const TONE: Record<HospiceCoverage, StatusTone> = {
  covered_related: "success",
  not_covered_unrelated: "warning",
  not_covered_other: "warning",
};

const OPTIONS = (Object.keys(HOSPICE_COVERAGE_LABEL) as HospiceCoverage[]).map((value) => ({
  value,
  label: HOSPICE_COVERAGE_LABEL[value],
}));

export function isNotCovered(value: HospiceCoverage): boolean {
  return value !== "covered_related";
}

/** Client-side mirror of the server rule. Returns the message to show, or null when valid. */
export function validateCoverageForm(value: HospiceCoverage, reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length > COVERAGE_REASON_MAX)
    return `Reason must be at most ${COVERAGE_REASON_MAX} characters.`;
  if (isNotCovered(value) && trimmed.length === 0)
    return "A reason is required when the hospice does not cover this item (42 CFR 418.24(c)(6)).";
  return null;
}

/** List badge: only not-covered rows get a pill (covered is the quiet default). */
export function HospiceCoverageBadge({
  coverage,
  showCovered = false,
}: {
  coverage: HospiceCoverage | null | undefined;
  showCovered?: boolean;
}): JSX.Element | null {
  if (!coverage || (!isNotCovered(coverage) && !showCovered)) return null;
  return <StatusPill label={HOSPICE_COVERAGE_LABEL[coverage]} tone={TONE[coverage]} />;
}

export interface CoverageDraft {
  readonly hospiceCoverage: HospiceCoverage;
  readonly reason: string;
}

/** The select + conditional reason, for embedding in a create/edit form. */
export function HospiceCoverageFields({
  value,
  onChange,
  error,
  disabled,
}: {
  value: CoverageDraft;
  onChange: (next: CoverageDraft) => void;
  error?: string | null;
  disabled?: boolean;
}): JSX.Element {
  const id = useId();
  return (
    <div className="wx-coverage-fields">
      <SelectField
        id={`${id}-coverage`}
        label="Hospice coverage"
        hint="Unrelated drugs, equipment and supplies are listed on the patient's election addendum."
        options={OPTIONS}
        value={value.hospiceCoverage}
        disabled={disabled}
        onChange={(e) =>
          onChange({ ...value, hospiceCoverage: e.currentTarget.value as HospiceCoverage })
        }
      />
      {isNotCovered(value.hospiceCoverage) ? (
        <TextAreaField
          id={`${id}-reason`}
          label="Reason (shared with the patient)"
          hint="Plain-language clinical explanation of why the hospice does not cover it."
          required
          maxLength={COVERAGE_REASON_MAX}
          value={value.reason}
          disabled={disabled}
          error={error ?? undefined}
          onChange={(e) => onChange({ ...value, reason: e.currentTarget.value })}
        />
      ) : error ? (
        <InlineAlert>{error}</InlineAlert>
      ) : null}
    </div>
  );
}

function dateTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        parsed,
      );
}

export interface CoverageDetermination {
  readonly hospiceCoverage: HospiceCoverage;
  readonly coverageReason: string | null;
  readonly coverageDeterminedAt: string | null;
  readonly coverageDeterminedBy: string | null;
}

/**
 * The "Hospice coverage" section on a detail screen: read-only label/value rows, an Edit action that swaps
 * in {@link HospiceCoverageFields}, and Save/Cancel. `onSave` resolves to an error message or null.
 */
export function HospiceCoverageSection({
  current,
  onSave,
  readOnlyNote,
}: {
  current: CoverageDetermination;
  onSave: (draft: { hospiceCoverage: HospiceCoverage; reason: string | null }) => Promise<
    string | null
  >;
  /** When set, the section is read-only and shows this note instead of the Edit action. */
  readOnlyNote?: string;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CoverageDraft>({
    hospiceCoverage: current.hospiceCoverage,
    reason: current.coverageReason ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft({ hospiceCoverage: current.hospiceCoverage, reason: current.coverageReason ?? "" });
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const invalid = validateCoverageForm(draft.hospiceCoverage, draft.reason);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    const failure = await onSave({
      hospiceCoverage: draft.hospiceCoverage,
      reason: draft.reason.trim() || null,
    });
    setSaving(false);
    if (failure) setError(failure);
    else setEditing(false);
  };

  return (
    <section className="wx-clinical-section" aria-label="Hospice coverage">
      <header>
        <span className="wx-clinical-section-icon" aria-hidden>
          <Glyph name="shield-check" size={22} strokeWidth={1.6} />
        </span>
        <div className="wx-coverage-head">
          <h3>Hospice coverage</h3>
          <p>Election statement addendum · 42 CFR 418.24(c)</p>
        </div>
        <div className="wx-clinical-section-aside">
          {!editing && !readOnlyNote ? (
            <Button tone="secondary" size="sm" onClick={startEdit}>
              Edit
            </Button>
          ) : null}
        </div>
      </header>
      <div className="wx-clinical-section-body">
        {editing ? (
          <div className="wx-coverage-form">
            <HospiceCoverageFields
              value={draft}
              onChange={(next) => {
                setDraft(next);
                setError(null);
              }}
              error={error}
              disabled={saving}
            />
            <div className="wx-coverage-actions">
              <Button tone="tertiary" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save determination"}
              </Button>
            </div>
          </div>
        ) : (
          <dl className="wx-coverage-rows">
            <div>
              <dt>Determination</dt>
              <dd>
                <HospiceCoverageBadge coverage={current.hospiceCoverage} showCovered />
              </dd>
            </div>
            {current.coverageReason ? (
              <div>
                <dt>Reason</dt>
                <dd>{current.coverageReason}</dd>
              </div>
            ) : null}
            <div>
              <dt>Determined</dt>
              <dd>
                {current.coverageDeterminedAt
                  ? dateTime(current.coverageDeterminedAt)
                  : "Not reviewed — presumed related"}
              </dd>
            </div>
            {current.coverageDeterminedBy ? (
              <div>
                <dt>Determined by</dt>
                <dd className="wx-data-md">{current.coverageDeterminedBy}</dd>
              </div>
            ) : null}
            {readOnlyNote ? (
              <div>
                <dt>Note</dt>
                <dd>{readOnlyNote}</dd>
              </div>
            ) : null}
          </dl>
        )}
      </div>
    </section>
  );
}
