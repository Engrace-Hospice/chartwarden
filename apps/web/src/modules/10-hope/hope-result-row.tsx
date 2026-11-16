// apps/web/src/modules/10-hope — one row of the "Record CMS result" table (split from the dialog, which is about the whole result), and the
// words that name rows. A cell the dialog refuses, or that the server's last refusal named, is marked for assistive technology and with a
// red border; its description is the alert that names its row (or, for several rows, lists them), so what it says is true for the cell.
import type { CSSProperties, JSX } from "react";
import { type CmsItemOutcome, normalizeOutcome } from "./cms-result-parser";
import { MAX_RESULT_MESSAGE, MAX_RESULT_TOKEN } from "./hope-report-reference";

export interface RowState {
  /** "" until the user (or the pasted report) sets it: nothing defaults to Accepted, because a result is final. */
  status: CmsItemOutcome | "";
  code: string;
  itemCode: string;
  message: string;
}

export const BLANK_ROW: RowState = { status: "", code: "", itemCode: "", message: "" };

export const OUTCOME_OPTIONS: ReadonlyArray<{ value: CmsItemOutcome; label: string }> = [
  { value: "accepted", label: "Accepted" },
  { value: "accepted_with_warnings", label: "Accepted with warnings" },
  { value: "rejected", label: "Rejected" },
];

/** The DOM id of one typed cell of a row (the server's row index is the item's index), so a refusal can take focus to it. */
export const cellIdOf = (base: string, row: number, token: string): string =>
  `${base}-${row}-${token}`;

/** The cells a refusal can name that the dialog has an input for. */
export const CELL_TOKENS: ReadonlySet<string> = new Set(["code", "itemCode", "message"]);

/** The red border of a refused cell: the table's inputs sit outside the shared `.wx-form-field [aria-invalid]` rule, so it is drawn here. */
const invalidCell: CSSProperties = { borderColor: "var(--color-error)" };

/** How many row numbers an alert lists before it says "and N more". */
const MAX_ROWS_LISTED = 5;

/** "Row 2", "Rows 2, 3", "Rows 1, 2, 3, 4, 5 and 7 more": row NUMBERS only (1-based, as the table shows them), never any typed text. */
export function describeRows(numbers: readonly number[]): string {
  if (numbers.length === 1) return `Row ${numbers[0]}`;
  const listed = numbers.slice(0, MAX_ROWS_LISTED).join(", ");
  const more = numbers.length - MAX_ROWS_LISTED;
  return more > 0 ? `Rows ${listed} and ${more} more` : `Rows ${listed}`;
}

export interface ResultRowProps {
  /** Prefix of the cells' DOM ids (see {@link cellIdOf}). */
  readonly idBase: string;
  /** The row's 0-based index, as the server counts the rows it is sent; the table shows it plus one. */
  readonly index: number;
  readonly label: string;
  readonly state: RowState;
  readonly onPatch: (patch: Partial<RowState>) => void;
  /** The dialog refuses this value (it would be refused by the server). */
  readonly codeRefused: boolean;
  readonly itemRefused: boolean;
  readonly messageRefused: boolean;
  /** The cell of THIS row that the server's last refusal named, if any. */
  readonly serverRefusedToken: string | null;
  /** The alerts that describe a refused cell: the dialog's own (naming every offending row) and the server's. */
  readonly codeErrorId: string;
  readonly messageErrorId: string;
  readonly serverErrorId: string;
}

export function ResultRow({
  idBase,
  index,
  label,
  state,
  onPatch,
  codeRefused,
  itemRefused,
  messageRefused,
  serverRefusedToken,
  codeErrorId,
  messageErrorId,
  serverErrorId,
}: ResultRowProps): JSX.Element {
  // Labels can repeat (same patient + RFA): the row number keeps each accessible name unique.
  const name = `${label}, row ${index + 1}`;
  const textCell = (
    token: "code" | "itemCode" | "message",
    cellLabel: string,
    refusedByDialog: boolean,
    dialogErrorId: string,
    max: number,
  ): JSX.Element => {
    const refusedByServer = serverRefusedToken === token;
    const invalid = refusedByDialog || refusedByServer;
    return (
      <td>
        <input
          id={cellIdOf(idBase, index, token)}
          className="wx-select"
          aria-label={`${cellLabel} for ${name}`}
          aria-invalid={invalid || undefined}
          aria-describedby={
            refusedByDialog ? dialogErrorId : refusedByServer ? serverErrorId : undefined
          }
          style={invalid ? invalidCell : undefined}
          value={state[token]}
          maxLength={max}
          onChange={(e) => onPatch({ [token]: e.target.value })}
        />
      </td>
    );
  };
  return (
    <tr>
      <td>{index + 1}</td>
      <td>{label}</td>
      <td>
        <select
          className="wx-select"
          aria-label={`Outcome for ${name}`}
          value={state.status}
          onChange={(e) => onPatch({ status: normalizeOutcome(e.target.value) ?? "" })}
        >
          <option value="">Select outcome</option>
          {OUTCOME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </td>
      {textCell("code", "CMS code", codeRefused, codeErrorId, MAX_RESULT_TOKEN)}
      {textCell("itemCode", "Item", itemRefused, codeErrorId, MAX_RESULT_TOKEN)}
      {textCell("message", "Message", messageRefused, messageErrorId, MAX_RESULT_MESSAGE)}
    </tr>
  );
}
