// @wardenx/reporting · export — the direct chunked-response CSV streamer (M33 §4.8 `report.export.csv` /
// W-R-08 / D10).
//
// CSV is the ONE export that takes NO M22 hop: M33 streams the resolved snapshot directly to the response as
// chunked CSV. The query is aggregate-by-default (D6) so the streamed rows carry NO row-level PHI — only the
// translator's whitelisted dimension/measure output columns. The handler opens a server-side cursor (the
// injected row-source port runs `DECLARE c CURSOR …; FETCH 1000` under `withReportSession` on the read replica),
// streams 1000-row chunks to a writable sink with backpressure honoured (the sink's `write` resolves only once
// drained), and never buffers the full result in memory.
//
// FAIL-CLOSED CAPS (W-R-08): a pre-flight estimate over the 250,000-row cap refuses with
// {@link CsvExportRowCapExceeded} (the route surfaces 413 — recommend refining filters or XLSX) BEFORE any byte
// streams. A statement-timeout mid-stream is NOT an error to the client — the partial CSV is closed with a
// trailer line `# WARNING: Export truncated at row N due to timeout`. A deny-stub translation (a not-yet-
// materialized base) streams a header-only empty CSV.
//
// PURE port-injected orchestration: every fact/effect is an injected port (the cursor source + the writable
// sink + the telemetry outbox + an optional statement-timeout classifier). No clock/RNG/Drizzle/BullMQ import;
// the CSV-cell/line/header builders are total pure functions unit-asserted independently of the I/O.
import type { SqlRow, Translation } from "../translator";

/** §4.8 / W-R-08: the hard CSV row cap. A query estimated above this refuses with 413 before streaming. */
export const CSV_EXPORT_ROW_CAP = 250_000 as const;

/** The server-side cursor `FETCH` size (§4.8 / W-R-08) — the streamer pushes one CSV chunk per fetched batch. */
export const CSV_FETCH_CHUNK_ROWS = 1_000 as const;

/** The telemetry event emitted once a CSV stream completes (§4.10 — `rowCount` for the export counter). */
export const M33_CSV_EXPORT_STREAMED = "m33.export.csv_streamed" as const;

// ── injected ports ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The server-side cursor over the resolved snapshot (§4.8 — bound at boot to a `withReportSession` `export`-tier
 * session on the read replica that runs `DECLARE c CURSOR …; FETCH ${CSV_FETCH_CHUNK_ROWS}`). Yields row batches;
 * a thrown error mid-iteration is classified by {@link CsvExportPorts.isStatementTimeout} (timeout → graceful
 * truncation; anything else → rethrown).
 */
export interface CsvRowSourcePort {
  /** Async-iterate the cursor in fetch-sized batches (each ≤ {@link CSV_FETCH_CHUNK_ROWS} rows). */
  fetchChunks(): AsyncIterable<readonly SqlRow[]>;
}

/** The writable response sink (§4.8 — `Transfer-Encoding: chunked`). `write` MUST resolve only once the chunk is
 *  drained so the streamer honours backpressure (Node stream API); `end` flushes + closes the response. */
export interface CsvWritableSinkPort {
  write(chunk: string): Promise<void>;
  end(): Promise<void>;
}

/** The §4.10 telemetry emit once the stream completes (the injected outbox; a fail-closed thunk until P2C). */
export interface CsvExportOutboxPort {
  emitCsvStreamed(payload: {
    readonly viewId: string;
    readonly actorMembershipId: string;
    readonly rowCount: number;
    readonly organizationId: string;
  }): Promise<void>;
}

/** The ports the CSV streamer composes over. */
export interface CsvExportPorts {
  readonly source: CsvRowSourcePort;
  readonly sink: CsvWritableSinkPort;
  readonly outbox: CsvExportOutboxPort;
  /** Classify a cursor error as a statement-timeout (→ graceful truncation). Default: nothing is a timeout. */
  isStatementTimeout?(err: unknown): boolean;
}

// ── the request ───────────────────────────────────────────────────────────────────────────────────────────

/** One CSV export request: the translated snapshot + the identity for audit/telemetry + an optional pre-flight
 *  row estimate (when known, drives the §4.8 413 cap refusal before streaming). */
export interface CsvExportRequest {
  readonly translation: Translation;
  readonly viewId: string;
  readonly organizationId: string;
  readonly actorMembershipId: string;
  /** A pre-flight `COUNT(*)`/planner estimate; when over the cap the export refuses before streaming. */
  readonly estimatedRowCount?: number;
  /** Override the §4.8 cap (default {@link CSV_EXPORT_ROW_CAP}). */
  readonly rowCap?: number;
}

/** What one CSV export reported. */
export type CsvExportResult =
  /** A deny-stub base (not yet materialized) — a header-less empty CSV was streamed. */
  | { readonly kind: "empty_deny_stub" }
  /** The full result streamed within the cap + timeout. */
  | { readonly kind: "streamed"; readonly rowCount: number }
  /** The cursor exceeded its statement timeout — a partial CSV with the truncation trailer was streamed. */
  | { readonly kind: "truncated_timeout"; readonly rowCount: number }
  /** The hard row cap was hit mid-stream (defensive — the pre-flight estimate should have refused) — partial
   *  CSV with the cap trailer. */
  | { readonly kind: "truncated_cap"; readonly rowCount: number };

/** Raised when a CSV export's pre-flight estimate exceeds the §4.8 cap — the route surfaces 413
 *  `EXPORT_ROW_CAP_EXCEEDED` BEFORE any byte streams (fail-closed; no partial response). */
export class CsvExportRowCapExceeded extends Error {
  constructor(
    public readonly estimatedRowCount: number,
    public readonly cap: number = CSV_EXPORT_ROW_CAP,
  ) {
    super(
      `EXPORT_ROW_CAP_EXCEEDED: estimated ${estimatedRowCount} rows exceeds the CSV cap of ${cap} — refine filters or use XLSX`,
    );
    this.name = "CsvExportRowCapExceeded";
  }
}

// ── pure CSV builders (RFC-4180 minimal-quote, total) ─────────────────────────────────────────────────────

/**
 * Render one cell to its CSV field (PURE). `null`/`undefined` → empty; `Date` → ISO-8601; everything else →
 * `String(value)`. A field containing a comma, double-quote, CR, or LF is wrapped in double-quotes with embedded
 * quotes doubled (RFC-4180). Defends against CSV-injection by NOT prefixing formula leads — these are aggregate
 * numeric/label cells (D6), never tenant free-text, but the quoting keeps a stray delimiter from breaking rows.
 */
export function csvEscapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

/** Join already-escaped cells into one CRLF-terminated CSV line (PURE, RFC-4180 line ending). */
export function csvLine(cells: readonly string[]): string {
  return `${cells.join(",")}\r\n`;
}

/** Build the CSV header line from the translation's ordered output columns (PURE). */
export function csvHeaderLine(columns: readonly { readonly outputKey: string }[]): string {
  return csvLine(columns.map((c) => csvEscapeCell(c.outputKey)));
}

/** Project + escape one SQL row to a CSV line over exactly the translation's output keys (PURE) — defence
 *  against an MV exposing more columns than the catalog whitelists (mirrors `result-shaper.ts`). */
export function csvRowLine(row: SqlRow, outputKeys: readonly string[]): string {
  return csvLine(outputKeys.map((key) => csvEscapeCell(row[key])));
}

// ── the streamer ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Stream one saved view's resolved snapshot as chunked CSV (§4.8 / W-R-08). For a deny-stub base, streams an
 * empty CSV and returns `empty_deny_stub`. Otherwise: refuses over-cap up front (413), writes the header, then
 * streams cursor batches with backpressure until exhausted, the hard cap, or a statement-timeout (each terminal
 * truncation writes its `# WARNING` trailer). Emits `m33.export.csv_streamed` with the final `rowCount`.
 *
 * Aggregate-only (D6): the streamed columns are the translator's whitelisted output keys — no row-level PHI.
 *
 * @throws {CsvExportRowCapExceeded} the pre-flight estimate exceeds the cap (before any byte streams)
 */
export async function handleCsvExport(
  request: CsvExportRequest,
  ports: CsvExportPorts,
): Promise<CsvExportResult> {
  const cap = request.rowCap ?? CSV_EXPORT_ROW_CAP;

  // Deny-stub: a not-yet-materialized base streams an empty CSV (no columns to head) and emits 0-row telemetry.
  if (request.translation.kind === "deny_stub") {
    await ports.sink.end();
    await ports.outbox.emitCsvStreamed({
      viewId: request.viewId,
      actorMembershipId: request.actorMembershipId,
      rowCount: 0,
      organizationId: request.organizationId,
    });
    return { kind: "empty_deny_stub" };
  }

  // §4.8 cap: refuse over-cap BEFORE streaming a single byte (the route maps this to 413, no partial response).
  if (request.estimatedRowCount !== undefined && request.estimatedRowCount > cap) {
    throw new CsvExportRowCapExceeded(request.estimatedRowCount, cap);
  }

  const outputKeys = request.translation.columns.map((c) => c.outputKey);
  await ports.sink.write(csvHeaderLine(request.translation.columns));

  let rowCount = 0;
  let cappedMidStream = false;

  try {
    for await (const chunk of ports.source.fetchChunks()) {
      for (const row of chunk) {
        if (rowCount >= cap) {
          cappedMidStream = true;
          break;
        }
        await ports.sink.write(csvRowLine(row, outputKeys));
        rowCount += 1;
      }
      if (cappedMidStream) break;
    }
  } catch (err) {
    // A statement-timeout is a graceful truncation, NOT a client error: close with the W-R-08 trailer.
    if (ports.isStatementTimeout?.(err) === true) {
      await ports.sink.write(`# WARNING: Export truncated at row ${rowCount} due to timeout\r\n`);
      await ports.sink.end();
      await ports.outbox.emitCsvStreamed({
        viewId: request.viewId,
        actorMembershipId: request.actorMembershipId,
        rowCount,
        organizationId: request.organizationId,
      });
      return { kind: "truncated_timeout", rowCount };
    }
    // Anything else is a genuine failure — the response is already mid-stream, so rethrow for the host to abort.
    throw err;
  }

  if (cappedMidStream) {
    await ports.sink.write(`# WARNING: Export truncated at row ${rowCount} due to the ${cap}-row cap\r\n`);
  }
  await ports.sink.end();
  await ports.outbox.emitCsvStreamed({
    viewId: request.viewId,
    actorMembershipId: request.actorMembershipId,
    rowCount,
    organizationId: request.organizationId,
  });
  return cappedMidStream ? { kind: "truncated_cap", rowCount } : { kind: "streamed", rowCount };
}
