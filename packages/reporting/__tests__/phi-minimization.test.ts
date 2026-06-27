// @wardenx/reporting — PHI-MINIMIZATION UNIT TESTS (M33 D6 / §8.5, the §164.502(b) minimum-necessary rule).
//
// The architectural crown jewel of M33: NO row-level PHI ever leaves M33's own SQL. This suite drives the
// REAL code paths — the translator (`src/translator/*`), the CSV streamer (`src/export/csv-stream.ts`), and the
// drilldown audit writer (`src/drilldown/audit-writer.ts`) — and proves the three-layer enforcement of D6:
//
//   1. The translator is AGGREGATE-ONLY + WHITELISTED: a spec can only name catalog dimensions/measures (the
//      catalog never lists a raw patient-identifier column); a PHI key is rejected before any SQL is built, and
//      a compiled SELECT projects ONLY whitelisted, GROUP-BY'd / aggregated output columns.
//   2. The CSV exporter streams ONLY the translator's whitelisted output keys — even if the underlying MV row
//      smuggles extra patient-identifier columns, they are projected away and never reach a single CSV byte.
//   3. The ONLY path that may carry a patient identifier is the drilldown, and there it is ENVELOPE-ENCRYPTED
//      (`query_filters_cipher`) + audited — the cleartext identifier never lands in the row column nor the
//      outbox event; a DEK failure DENIES the drilldown rather than persist plaintext (fail-closed).
//
// These suites are pure — they NEVER touch a DB; effects (cursor source, response sink, DEK, audit append,
// outbox) are injected fakes.
import { schema } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import {
  type CsvExportPorts,
  type CsvExportRequest,
  CSV_EXPORT_ROW_CAP,
  csvHeaderLine,
  csvRowLine,
  handleCsvExport,
} from "../src/export/csv-stream";
import {
  type DrilldownAuditInput,
  type DrilldownAuditPorts,
  DrilldownDekUnavailable,
  type DrilldownEmittedPayload,
  writeDrilldownAudit,
} from "../src/drilldown/audit-writer";
import {
  shapeTileResult,
  type SqlRow,
  type TileShapeContext,
} from "../src/translator/result-shaper";
import {
  type ReportableScopeEnvelope,
  type Translation,
  type TranslatorBaseCatalog,
  translateSpec,
} from "../src/translator/index";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

const ORG_ID = "00000000-0000-0000-0000-000000000aaa";

/** The platform-shipped base catalog lists ONLY aggregate-safe dimensions/measures — NO raw PHI column
 *  (`patient.first_name`, `mrn`, `ssn`, `address`) is ever offered as a dimension or measure (D6 / §8.5). */
const DIMENSIONS: schema.DimensionCatalog[] = [
  { dimensionKey: "service_date", displayName: "Service Date", dataType: "date" },
  { dimensionKey: "team_name", displayName: "Team", dataType: "string" },
];

const MEASURES: schema.MeasureCatalog[] = [
  { measureKey: "census_count", displayName: "Census", metricKey: "m.census", unit: "count", aggregation: "sum" },
  { measureKey: "avg_los", displayName: "Avg LOS", metricKey: "m.los", unit: "days", aggregation: "avg" },
];

function makeBase(overrides: Partial<TranslatorBaseCatalog> = {}): TranslatorBaseCatalog {
  return {
    baseKey: "census_daily",
    status: "active",
    mvKey: "census_daily",
    mvSchemaName: "report_mv",
    mvStatus: "active",
    dimensions: DIMENSIONS,
    measures: MEASURES,
    maxRowLimit: 5000,
    drilldownUrlTemplate: "/patients?date={service_date}",
    ...overrides,
  };
}

function makeSpec(overrides: Partial<schema.ReportDefinitionSpec> = {}): schema.ReportDefinitionSpec {
  return {
    dimensions: [{ dimensionKey: "team_name" }],
    measures: [{ measureKey: "census_count" }],
    filters: [],
    ...overrides,
  };
}

const ORG_SCOPE: ReportableScopeEnvelope = { scopeKind: "org", organizationId: ORG_ID };

/** Identifier columns that must NEVER appear in any M33 output (header, cell, shaped result, or event). */
const PHI_TOKENS = ["first_name", "last_name", "patient_name", "mrn", "ssn", "address", "Jane Doe", "123-45-6789"];

// ── (A) translator — aggregate-only + whitelisted: no PHI column can be requested or projected ─────

describe("translator (D6) — no row-level PHI column is requestable or projected", () => {
  it("rejects a spec that names a patient-identifier dimension (not in the catalog) BEFORE any SQL", () => {
    for (const phiKey of ["patient_name", "mrn", "ssn", "first_name", "address"]) {
      expect(() => translateSpec(makeSpec({ dimensions: [{ dimensionKey: phiKey }] }), makeBase(), ORG_SCOPE))
        .toThrowError(expect.objectContaining({ code: "DIMENSION_NOT_IN_BASE", statusCode: 422 }));
    }
  });

  it("rejects a spec that names a patient-identifier measure (not in the catalog)", () => {
    expect(() => translateSpec(makeSpec({ measures: [{ measureKey: "patient_name" }] }), makeBase(), ORG_SCOPE))
      .toThrowError(expect.objectContaining({ code: "MEASURE_NOT_IN_BASE", statusCode: 422 }));
  });

  it("rejects a FILTER on a patient-identifier column (not in the catalog)", () => {
    const spec = makeSpec({ filters: [{ dimensionKey: "mrn", comparator: "eq", value: "X1" }] });
    expect(() => translateSpec(spec, makeBase(), ORG_SCOPE)).toThrowError(
      expect.objectContaining({ code: "DIMENSION_NOT_IN_BASE" }),
    );
  });

  it("compiles a valid spec to a SELECT that GROUP BYs dimensions + aggregates measures (no raw row column)", () => {
    const t = translateSpec(makeSpec(), makeBase(), ORG_SCOPE);
    if (t.kind !== "sql") throw new Error("expected sql");
    // Every measure is wrapped in an aggregate (no un-aggregated row-level projection can leak PHI).
    expect(t.sql).toContain('SUM(t."census_count")');
    expect(t.sql).toContain('GROUP BY t."team_name"');
    // The SQL text mentions NO patient table / identifier column — only the whitelisted catalog identifiers.
    for (const token of PHI_TOKENS) expect(t.sql).not.toContain(token);
    expect(t.sql).not.toMatch(/patient/i);
  });

  it("result-shaper projects rows down to ONLY the translator's output keys (smuggled PHI is dropped)", () => {
    const t = translateSpec(makeSpec(), makeBase(), ORG_SCOPE);
    if (t.kind !== "sql") throw new Error("expected sql");
    // A hostile/buggy MV row carrying extra identifier columns beyond the whitelist.
    const smuggled: SqlRow[] = [
      { team_name: "Alpha", census_count: 12, patient_name: "Jane Doe", mrn: "MRN-1", ssn: "123-45-6789" },
    ];
    const ctx: TileShapeContext = {
      tileKey: "tile-1",
      dataFreshnessSeconds: 4,
      asOf: "2026-06-25T00:00:00.000Z",
      scopeApplied: { scopeKind: "org", narrowedFromRequested: false },
    };
    const shaped = shapeTileResult(t, smuggled, ctx);
    expect(shaped.rowCount).toBe(1);
    const row = shaped.result[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(["census_count", "team_name"]);
    for (const token of PHI_TOKENS) expect(JSON.stringify(shaped)).not.toContain(token);
  });
});

// ── (B) CSV exporter (D6) — streams ONLY whitelisted aggregate columns, never row-level PHI ────────

/** A row-source whose underlying MV rows ALSO carry smuggled patient-identifier columns — the streamer must
 *  project them away (it writes only the translation's output keys). */
function smugglingSource(rows: readonly SqlRow[]) {
  return {
    async *fetchChunks(): AsyncIterable<readonly SqlRow[]> {
      yield rows;
    },
  };
}

function capturingPorts(rows: readonly SqlRow[]): {
  ports: CsvExportPorts;
  written: string[];
  emitted: { rowCount: number }[];
} {
  const written: string[] = [];
  const emitted: { rowCount: number }[] = [];
  const ports: CsvExportPorts = {
    source: smugglingSource(rows),
    sink: {
      async write(chunk: string) {
        written.push(chunk);
      },
      async end() {},
    },
    outbox: {
      async emitCsvStreamed(p) {
        emitted.push({ rowCount: p.rowCount });
      },
    },
  };
  return { ports, written, emitted };
}

function makeTranslation(): Translation {
  // The genuine translator output for the canonical spec — its `columns` are the whitelist the streamer honours.
  return translateSpec(makeSpec(), makeBase(), ORG_SCOPE);
}

describe("CSV exporter (D6) — only whitelisted aggregate columns reach the stream", () => {
  const translation = makeTranslation();
  if (translation.kind !== "sql") throw new Error("fixture must be sql");
  const outputKeys = translation.columns.map((c) => c.outputKey);

  const baseRequest: Omit<CsvExportRequest, "estimatedRowCount"> = {
    translation,
    viewId: "view-1",
    organizationId: ORG_ID,
    actorMembershipId: "mem-1",
  };

  it("streams a header of ONLY the translator's whitelisted output keys", async () => {
    const rows: SqlRow[] = [{ team_name: "Alpha", census_count: 7 }];
    const { ports, written } = capturingPorts(rows);
    const result = await handleCsvExport({ ...baseRequest }, ports);
    expect(result.kind).toBe("streamed");
    expect(written[0]).toBe(csvHeaderLine(translation.columns));
    // Header carries exactly the whitelisted keys — no identifier column.
    expect(written[0]).toBe(`${outputKeys.join(",")}\r\n`);
    for (const token of PHI_TOKENS) expect(written[0]).not.toContain(token);
  });

  it("projects away smuggled PHI columns — not one identifier byte reaches the CSV", async () => {
    const rows: SqlRow[] = [
      { team_name: "Alpha", census_count: 7, patient_name: "Jane Doe", mrn: "MRN-1", ssn: "123-45-6789", address: "1 Main St" },
      { team_name: "Bravo", census_count: 3, first_name: "John", last_name: "Roe" },
    ];
    const { ports, written, emitted } = capturingPorts(rows);
    const result = await handleCsvExport({ ...baseRequest }, ports);
    expect(result).toEqual({ kind: "streamed", rowCount: 2 });
    const allOutput = written.join("");
    for (const token of PHI_TOKENS) expect(allOutput).not.toContain(token);
    // Each data line carries exactly the two whitelisted aggregate cells.
    expect(written).toContain(csvRowLine(rows[0]!, outputKeys));
    expect(written.some((l) => l === "Alpha,7\r\n")).toBe(true);
    expect(written.some((l) => l === "Bravo,3\r\n")).toBe(true);
    expect(emitted).toEqual([{ rowCount: 2 }]);
  });

  it("csvRowLine (pure) ignores keys outside the whitelist — defence-in-depth against MV drift", () => {
    const row: SqlRow = { team_name: "Alpha", census_count: 7, mrn: "MRN-9", ssn: "123-45-6789" };
    const line = csvRowLine(row, outputKeys);
    expect(line).toBe("Alpha,7\r\n");
    expect(line).not.toContain("MRN-9");
    expect(line).not.toContain("123-45-6789");
  });

  it("a pre-flight estimate over the 250k cap refuses BEFORE streaming a byte (no partial PHI exposure)", async () => {
    const { ports, written } = capturingPorts([{ team_name: "Alpha", census_count: 1 }]);
    await expect(
      handleCsvExport({ ...baseRequest, estimatedRowCount: CSV_EXPORT_ROW_CAP + 1 }, ports),
    ).rejects.toThrowError(/EXPORT_ROW_CAP_EXCEEDED/);
    expect(written).toEqual([]); // nothing streamed
  });
});

// ── (C) drilldown — the ONLY patient-identifier path: envelope-encrypted + audited, fail-closed ────

const PATIENT_ID = "11111111-1111-1111-1111-111111111111";

function makeDrilldownInput(overrides: Partial<DrilldownAuditInput> = {}): DrilldownAuditInput {
  return {
    organizationId: ORG_ID,
    actorMembershipId: "mem-1",
    reportViewId: "view-1",
    sourceTileKey: "tile.census",
    drilldownTargetModule: 8,
    drilldownTargetSurface: "late-entry-register",
    // The ONE place a patient identifier may travel — and it is encrypted at rest.
    queryFilters: { patientId: PATIENT_ID, service_date: "2026-06-25" },
    isConsentNarrowed: false,
    consentNarrowingReason: null,
    ...overrides,
  };
}

function makeDrilldownPorts(opts: { dekThrows?: boolean } = {}): {
  ports: DrilldownAuditPorts;
  encryptCalls: { organizationId: string; plaintext: string }[];
  appended: schema.NewReportDrilldownAudit[];
  events: DrilldownEmittedPayload[];
} {
  const encryptCalls: { organizationId: string; plaintext: string }[] = [];
  const appended: schema.NewReportDrilldownAudit[] = [];
  const events: DrilldownEmittedPayload[] = [];
  const ports: DrilldownAuditPorts = {
    encryption: {
      async encryptFilters(input) {
        encryptCalls.push(input);
        if (opts.dekThrows) throw new Error("DEK service unreachable");
        // A stand-in envelope cipher — opaque, NOT the plaintext.
        return `enc:v1:${Buffer.from(input.plaintext).toString("base64")}`;
      },
    },
    audit: {
      async append(row) {
        appended.push(row);
      },
    },
    outbox: {
      async emitDrilldown(p) {
        events.push(p);
      },
    },
    newRowId: () => "row-1",
    newTraceId: () => "trace-1",
    now: () => new Date("2026-06-25T12:00:00.000Z"),
  };
  return { ports, encryptCalls, appended, events };
}

describe("drilldown audit (D6 / §3.6) — patient identifier is envelope-encrypted, never plaintext", () => {
  it("encrypts the filter context under the per-tenant DEK and stores ONLY the cipher (no plaintext id)", async () => {
    const { ports, encryptCalls, appended } = makeDrilldownPorts();
    const res = await writeDrilldownAudit(makeDrilldownInput(), ports);
    expect(res.outcome).toBe("emitted");
    // The DEK was consulted with the org + the cleartext filter blob (containing the patient id).
    expect(encryptCalls).toHaveLength(1);
    expect(encryptCalls[0]!.organizationId).toBe(ORG_ID);
    expect(encryptCalls[0]!.plaintext).toContain(PATIENT_ID);
    // The persisted row carries the CIPHER, not the cleartext patient id.
    expect(appended).toHaveLength(1);
    const row = appended[0]!;
    expect(row.queryFiltersCipher).toMatch(/^enc:v1:/);
    expect(row.queryFiltersCipher).not.toContain(PATIENT_ID);
    // No other column on the audit row carries the cleartext patient id.
    const rowSansCipher = { ...row, queryFiltersCipher: "" };
    expect(JSON.stringify(rowSansCipher)).not.toContain(PATIENT_ID);
  });

  it("the emitted m33.drilldown event carries NO patient identifier (cipher stays in the row)", async () => {
    const { ports, events } = makeDrilldownPorts();
    await writeDrilldownAudit(makeDrilldownInput(), ports);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(PATIENT_ID);
    expect(events[0]!.drilldownTraceId).toBe("trace-1");
  });

  it("FAILS CLOSED — a DEK failure DENIES the drilldown and writes NOTHING (never plaintext at rest)", async () => {
    const { ports, appended, events } = makeDrilldownPorts({ dekThrows: true });
    await expect(writeDrilldownAudit(makeDrilldownInput(), ports)).rejects.toBeInstanceOf(DrilldownDekUnavailable);
    expect(appended).toEqual([]); // nothing persisted
    expect(events).toEqual([]); // nothing emitted
  });

  it("a pure-aggregate drilldown (no patient id) still encrypts its filter context before persisting", async () => {
    const { ports, appended } = makeDrilldownPorts();
    await writeDrilldownAudit(
      makeDrilldownInput({ queryFilters: { service_date: "2026-06-25" } }),
      ports,
    );
    expect(appended[0]!.queryFiltersCipher).toMatch(/^enc:v1:/);
  });
});
