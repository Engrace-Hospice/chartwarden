import {
  Button,
  Glyph,
  InlineAlert,
  Modal,
  ReverifyLink,
  SelectField,
  TextAreaField,
  TextField,
  focusFirstInvalid,
  useApiClient,
} from "@chartwarden/ui";
// apps/admin/src/modules/23-billing-medicare — PLATFORM WAGE-INDEX LOAD (M23 §4.1 #42, GAP-144). The annual CMS
// hospice wage index into the PLATFORM-SHARED table, by a ChartWarden platform administrator:
//
//   POST /api/v1/admin/billing/wage-indexes/load — `billing.rule_config.platform_admin` + a fresh step-up + no AI
//                                                  actor + `Idempotency-Key`; all-or-nothing; NO PHI.
//
// The operator downloads the CMS file and pastes or uploads the table; the rows travel in the body (the server never
// fetches the source URI — SSRF/egress) and `sourceReference` records where they came from. The route has no dry run,
// so this screen previews the parse with the route's own per-row patterns and refuses to send a file with a problem;
// the server validates every row again and loads nothing if one is bad. The tenant-entered per-CCN values live in
// apps/web (Billing → Wage Index); this is the platform table claim assembly falls back to.
//
// A stale session gets 403 STEP_UP_REQUIRED: the confirm dialog offers a Re-verify link to the console's /step-up
// page, which comes back here. The form (table, fiscal year, source reference) is stashed for that round trip
// (wage-index-load-draft.ts) and restored on mount, so the operator does not have to paste the file again.
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import {
  clearWageIndexDraft,
  readWageIndexDraft,
  saveWageIndexDraft,
} from "./wage-index-load-draft";
import {
  type LoadErrorView,
  SOURCE_REFERENCE_MAX,
  type WageIndexLoadResult,
  fiscalYearLabel,
  fiscalYearStartingOf,
  loadErrorView,
  parseWageIndexTable,
} from "./wage-index-load-model";

const PREVIEW_ROWS = 12;
const PROBLEMS_SHOWN = 20;
const NOW_FY = fiscalYearStartingOf(new Date());
const FY_OPTIONS = [NOW_FY + 1, NOW_FY, NOW_FY - 1].map((fy) => ({
  value: String(fy),
  label: `${fiscalYearLabel(fy)} (Oct ${fy} – Sep ${fy + 1})`,
}));

/** A local file's text via FileReader (supported everywhere the console runs, unlike `Blob.text()` in older engines). */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("unreadable file"));
    reader.readAsText(file);
  });
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The fiscal year to restore from a draft, only when it is still one of the offered options. */
function restoredFiscalYear(fiscalYearStarting: number | undefined): number {
  const offered = FY_OPTIONS.some((o) => o.value === String(fiscalYearStarting));
  return offered && fiscalYearStarting !== undefined ? fiscalYearStarting : NOW_FY + 1;
}

export function WageIndexLoad(): JSX.Element {
  // Read once on mount (a render-safe read: it does not clear, so StrictMode's double initialiser is harmless;
  // the effect below clears it after the first render).
  const [draft] = useState(() => readWageIndexDraft());
  const [fy, setFy] = useState(() => restoredFiscalYear(draft?.fiscalYearStarting));
  const [sourceReference, setSourceReference] = useState(draft?.sourceReference ?? "");
  const [table, setTable] = useState(draft?.table ?? "");
  // A draft is restored once: clear it now, so a later visit (or a reload) does not claim to restore it again.
  useEffect(() => {
    if (draft) clearWageIndexDraft();
  }, [draft]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<WageIndexLoadResult | null>(null);

  const parsed = useMemo(() => parseWageIndexTable(table), [table]);
  const source = sourceReference.trim();
  const ready = parsed.rows.length > 0 && parsed.problems.length === 0 && source.length > 0;
  const [attempted, setAttempted] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const sourceError = attempted && !source ? "Enter the source reference to load." : undefined;
  // The per-line problems are listed under the preview; the field itself only points there.
  const tableError = !attempted
    ? undefined
    : parsed.problems.length > 0
      ? "Fix the lines listed under the preview."
      : parsed.rows.length === 0
        ? "Paste or upload at least one row."
        : undefined;

  function review(): void {
    setAttempted(true);
    if (!ready) {
      focusFirstInvalid(pageRef.current);
      return;
    }
    setConfirming(true);
  }

  async function readFile(file: File | null): Promise<void> {
    setFileError(null);
    if (!file) return;
    try {
      setTable(await readText(file));
      setResult(null);
    } catch {
      setFileError("The file could not be read. Paste the table instead.");
    }
  }

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main" ref={pageRef}>
        <header className="wx-page-head">
          <div>
            <h1>Wage index load</h1>
            <p>
              Load the annual CMS hospice wage index into the platform table claim assembly prices
              from. The whole file loads in one transaction — one bad row loads nothing.
            </p>
          </div>
        </header>

        <fieldset className="wx-work-summary" aria-label="Load summary">
          <div className="wx-stat-card">
            <div>
              <span className="wx-stat-label">Fiscal year</span>
              <span className="wx-stat-value">{fiscalYearLabel(fy)}</span>
              <span className="wx-row-sub">{`Oct ${fy} – Sep ${fy + 1}`}</span>
            </div>
          </div>
          <div className="wx-stat-card">
            <div>
              <span className="wx-stat-label">Rows ready</span>
              <span
                className={
                  parsed.rows.length > 0 && parsed.problems.length === 0
                    ? "wx-stat-value wx-nums wx-text-success"
                    : "wx-stat-value wx-nums"
                }
              >
                {parsed.rows.length.toLocaleString("en-US")}
              </span>
              <span className="wx-row-sub">Up to 7,000 per load</span>
            </div>
          </div>
          <div className="wx-stat-card">
            <div>
              <span className="wx-stat-label">Problems</span>
              <span
                className={
                  parsed.problems.length > 0
                    ? "wx-stat-value wx-nums wx-text-error"
                    : "wx-stat-value wx-nums"
                }
              >
                {parsed.problems.length.toLocaleString("en-US")}
              </span>
              <span className="wx-row-sub">Fix every one before loading</span>
            </div>
          </div>
        </fieldset>

        {draft ? (
          <InlineAlert tone="info">
            Restored the table, fiscal year and source reference from before you re-verified.
          </InlineAlert>
        ) : null}
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h2>Source</h2>
          </div>
          <p className="wx-source-line">
            Which fiscal year this table is for, and where it was published.
          </p>
          <div className="wx-form-grid">
            <SelectField
              label="Fiscal year"
              value={String(fy)}
              options={FY_OPTIONS}
              onChange={(e) => {
                setFy(Number(e.target.value));
                setResult(null);
              }}
            />
            <TextField
              label="Source reference"
              placeholder="CMS FY hospice wage index file / Federal Register notice"
              value={sourceReference}
              maxLength={SOURCE_REFERENCE_MAX}
              hint="Recorded with every row. The server does not download it."
              error={sourceError}
              required
              onChange={(e) => {
                setSourceReference(e.target.value);
                setResult(null);
              }}
            />
          </div>
        </section>

        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h2>Wage-index table</h2>
          </div>
          <p className="wx-source-line">
            One row per CCN: CCN, wage index — or CCN, CBSA, wage index. Comma, tab or semicolon
            separated; a header row is skipped.
          </p>
          <div className="wx-form-stack">
            <TextField
              type="file"
              label="Upload a CSV"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              error={fileError ?? undefined}
              onChange={(e) => void readFile(e.target.files?.[0] ?? null)}
            />
            <TextAreaField
              label="Paste the table"
              rows={8}
              value={table}
              error={tableError}
              placeholder={"CCN,CBSA,Wage Index\n381588,38900,1.0342"}
              onChange={(e) => {
                setTable(e.target.value);
                setResult(null);
              }}
            />
          </div>
        </section>

        <PreviewPanel parsed={parsed} />

        {result ? <LoadResult result={result} /> : null}

        <div className="wx-form-actions">
          <Button onClick={review}>Review and load</Button>
        </div>
      </div>

      {confirming ? (
        <ConfirmLoadModal
          fiscalYearStarting={fy}
          sourceReference={source}
          parsed={parsed}
          onClose={() => setConfirming(false)}
          onReverify={() => saveWageIndexDraft({ fiscalYearStarting: fy, sourceReference, table })}
          onLoaded={(loaded) => {
            clearWageIndexDraft();
            setConfirming(false);
            setResult(loaded);
          }}
        />
      ) : null}
    </div>
  );
}

type Parsed = ReturnType<typeof parseWageIndexTable>;

function PreviewPanel({ parsed }: { readonly parsed: Parsed }): JSX.Element {
  const shown = parsed.rows.slice(0, PREVIEW_ROWS);
  return (
    <section className="wx-drawer-card">
      <div className="wx-drawer-card-head">
        <h2>Preview</h2>
      </div>
      {parsed.rows.length > PREVIEW_ROWS ? (
        <p className="wx-source-line">
          {`First ${PREVIEW_ROWS} of ${plural(parsed.rows.length, "row")}.`}
        </p>
      ) : null}
      {parsed.problems.length > 0 ? (
        // One live region holds the summary and the list, so the problems are announced with it (the alert text is a <p>,
        // which cannot hold the list; `live={false}` keeps the summary from announcing a second time).
        <div role="alert">
          <InlineAlert tone="error" live={false}>
            <strong>{plural(parsed.problems.length, "problem")} in the table</strong>
          </InlineAlert>
          <ul className="wx-bullet-list">
            {parsed.problems.slice(0, PROBLEMS_SHOWN).map((p) => (
              <li key={`${p.line}-${p.message}`}>
                Line {p.line}: {p.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {shown.length === 0 ? (
        <div className="wx-list-state">
          <Glyph name="eye" size={24} />
          <strong>No rows yet</strong>
          <span className="wx-row-sub">Upload or paste the CMS table to preview it here.</span>
        </div>
      ) : (
        <div className="wx-list-table-wrap">
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">Wage-index rows to load</caption>
            <thead>
              <tr>
                <th scope="col" className="wx-num-col">
                  Line
                </th>
                <th scope="col">CCN</th>
                <th scope="col">CBSA</th>
                <th scope="col" className="wx-num-col">
                  Wage index
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => (
                <tr key={row.ccn + String(parsed.sourceLines[i])}>
                  <td className="wx-nums wx-num-col">{parsed.sourceLines[i]}</td>
                  <td className="wx-data-md">{row.ccn}</td>
                  <td className="wx-nums">{row.cbsaCode ?? "—"}</td>
                  <td className="wx-nums wx-num-col">{row.factorDecimal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LoadResult({ result }: { readonly result: WageIndexLoadResult }): JSX.Element {
  return (
    <InlineAlert tone="success">
      <strong>Loaded {fiscalYearLabel(result.fiscalYearStarting)}:</strong>{" "}
      {plural(result.inserted, "new value")}, {result.updated.toLocaleString("en-US")} updated.
      Source: {result.sourceReference}
    </InlineAlert>
  );
}

interface ConfirmLoadModalProps {
  readonly fiscalYearStarting: number;
  readonly sourceReference: string;
  readonly parsed: Parsed;
  readonly onClose: () => void;
  /** Called as the operator leaves for /step-up, to keep the form for the return trip. */
  readonly onReverify: () => void;
  readonly onLoaded: (result: WageIndexLoadResult) => void;
}

function ConfirmLoadModal({
  fiscalYearStarting,
  sourceReference,
  parsed,
  onClose,
  onReverify,
  onLoaded,
}: ConfirmLoadModalProps): JSX.Element {
  const client = useApiClient();
  // One key per confirmation: a retry of the SAME submission (a timeout, a 5xx) replays safely; a new review is new.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<LoadErrorView | null>(null);
  const count = parsed.rows.length;

  async function submit(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const res = await client.POST("/api/v1/admin/billing/wage-indexes/load", {
        body: { fiscalYearStarting, sourceReference, rows: [...parsed.rows] },
        headers: { "Idempotency-Key": idempotencyKey },
      });
      setBusy(false);
      if (res.error || !res.data) {
        setFailure(loadErrorView(res.response?.status ?? null, res.error, parsed.sourceLines));
        return;
      }
      onLoaded(res.data);
    } catch {
      setBusy(false);
      setFailure(loadErrorView(null, undefined, parsed.sourceLines));
    }
  }

  return (
    <Modal open onClose={busy ? undefined : onClose} ariaLabel="Load wage index" width="32rem">
      <div className="wx-modal-body">
        <h2>Load wage index</h2>
        <p>
          Load {plural(count, "row")} into the platform wage index for{" "}
          <strong>{fiscalYearLabel(fiscalYearStarting)}</strong>. An existing value for the same CCN
          and fiscal year is replaced; every tenant's next claim assembly uses the new values.
        </p>
        <p>Source: {sourceReference}</p>
        {failure ? (
          // The alert text is a <p>, which cannot hold the detail list: one live region wraps both so the details are announced.
          <div role="alert">
            <InlineAlert tone="error" live={false}>
              <strong>{failure.title}</strong> {failure.message}
            </InlineAlert>
            {failure.details.length > 0 ? (
              <ul className="wx-bullet-list">
                {failure.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {failure?.stepUp ? (
          <div className="wx-drawer-actions">
            <ReverifyLink onNavigate={onReverify}>Re-verify and come back</ReverifyLink>
          </div>
        ) : null}
        <div className="wx-modal-actions">
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} disabled={busy} onClick={() => void submit()}>
            {`Load ${plural(count, "row")}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
