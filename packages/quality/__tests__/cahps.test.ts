// @wardenx/quality — M30 §4.5 / §4.13 / §7.2 CAHPS unit tests (PURE; no DB).
//
// Covers the platform-side CAHPS pipeline + the pluggable vendor adapters:
//   (a) the decedent SAMPLER (WF-04): CMS exclusion priority, the monthly window guard, and the §4.13
//       `deathSource` marker that is carried platform-side but NEVER forwarded to a vendor;
//   (b) the result-INGEST min-cell suppression (WF-06): the CMS ≤30-respondent small-cell protection;
//   (c) the @wardenx/cahps-vendors SHP + manual adapters (renderExport CSV shape, manual `no_push`,
//       parseResultIngest) and the three Phase-2 stub adapters' fail-closed NOT_YET_IMPLEMENTED behavior.
//
// Both packages are M30 codePaths (intra-module edge), so importing @wardenx/cahps-vendors from this
// quality test is an allowed boundary. The PURE design (no I/O) is asserted by injecting plain values.
import { describe, expect, it } from "vitest";
import { WardenXError } from "@wardenx/types";
import {
  type CahpsDecedentSampleRow,
  type CahpsSampleCandidate,
  type CahpsSamplePeriod,
  type ParsedCahpsResultRow,
  applyMinimumCellSuppression,
  sampleDecedents,
} from "@wardenx/quality";
import {
  CAHPS_ADAPTER_FACTORIES,
  DeytaCahpsAdapter,
  HealthcarefirstCahpsAdapter,
  ManualCahpsAdapter,
  MANUAL_RESULT_COLUMNS,
  PressGaneyCahpsAdapter,
  renderCsv,
  SHP_DECEDENT_COLUMNS,
  ShpCahpsAdapter,
  shpExportFilename,
  SUPPORTED_CAHPS_VENDOR_IDS,
} from "@wardenx/cahps-vendors";

// ── shared fixtures ────────────────────────────────────────────────────────────────────────────────────

/** A January-2025 sample period — the prior calendar month, inclusive both ends. */
const JAN_2025: CahpsSamplePeriod = { start: "2025-01-01", end: "2025-01-31" };

/** An eligible candidate (≥48h stay, caregiver reachable, supported language, no prior opt-out). */
function eligibleCandidate(overrides: Partial<CahpsSampleCandidate> = {}): CahpsSampleCandidate {
  return {
    deceasedPatientId: "patient-1",
    deceasedAdmissionId: "adm-1",
    providerEntityId: "pe-1",
    deathDate: "2025-01-15",
    admissionStartAt: "2025-01-01T00:00:00Z",
    deathAt: "2025-01-15T00:00:00Z",
    deathSource: "admission_discharge",
    caregiverAvailable: true,
    languageSupported: true,
    priorSurveyOptOut: false,
    ...overrides,
  };
}

// ── (a) the decedent sampler (WF-04 + §4.13) ─────────────────────────────────────────────────────────────

describe("CAHPS decedent sampler — eligibility + §4.13 source marking", () => {
  it("classifies a clean decedent as survey-eligible (exclusionReason null) and stamps the cycle month", () => {
    const [row] = sampleDecedents([eligibleCandidate()], JAN_2025);
    expect(row?.eligible).toBe(true);
    expect(row?.exclusionReason).toBeNull();
    // cycle month is the first day of the period-start month.
    expect(row?.samplingCycleMonth).toBe("2025-01-01");
  });

  it("excludes a <48h hospice stay with the coded reason", () => {
    const [row] = sampleDecedents(
      [
        eligibleCandidate({
          admissionStartAt: "2025-01-15T00:00:00Z",
          deathAt: "2025-01-16T00:00:00Z", // 24h < 48h
        }),
      ],
      JAN_2025,
    );
    expect(row?.eligible).toBe(false);
    expect(row?.exclusionReason).toBe("hospice_stay_under_48h");
  });

  it("a stay of EXACTLY 48h is NOT excluded (the <48h boundary is strict)", () => {
    const [row] = sampleDecedents(
      [
        eligibleCandidate({
          admissionStartAt: "2025-01-13T00:00:00Z",
          deathAt: "2025-01-15T00:00:00Z", // exactly 48h
        }),
      ],
      JAN_2025,
    );
    expect(row?.eligible).toBe(true);
    expect(row?.exclusionReason).toBeNull();
  });

  it("excludes for caregiver-unavailable / unsupported-language / prior opt-out", () => {
    const caregiver = sampleDecedents([eligibleCandidate({ caregiverAvailable: false })], JAN_2025);
    expect(caregiver[0]?.exclusionReason).toBe("caregiver_unavailable");

    const language = sampleDecedents([eligibleCandidate({ languageSupported: false })], JAN_2025);
    expect(language[0]?.exclusionReason).toBe("language_not_supported");

    const optOut = sampleDecedents([eligibleCandidate({ priorSurveyOptOut: true })], JAN_2025);
    expect(optOut[0]?.exclusionReason).toBe("prior_survey_opt_out");
  });

  it("applies the CMS exclusion rules in deterministic priority order (<48h beats caregiver)", () => {
    const [row] = sampleDecedents(
      [
        eligibleCandidate({
          admissionStartAt: "2025-01-15T00:00:00Z",
          deathAt: "2025-01-16T00:00:00Z", // <48h
          caregiverAvailable: false, // also excludable — but stay rule wins
        }),
      ],
      JAN_2025,
    );
    expect(row?.exclusionReason).toBe("hospice_stay_under_48h");
  });

  it("carries the §4.13 deathSource marker through onto every sampled row", () => {
    const rows = sampleDecedents(
      [
        eligibleCandidate({ deceasedPatientId: "p-int", deathSource: "admission_discharge" }),
        eligibleCandidate({ deceasedPatientId: "p-ext", deathSource: "external_import" }),
        eligibleCandidate({ deceasedPatientId: "p-man", deathSource: "manual_entry" }),
      ],
      JAN_2025,
    );
    expect(rows.map((r) => r.deathSource)).toEqual([
      "admission_discharge",
      "external_import",
      "manual_entry",
    ]);
  });

  it("accepts deaths on the inclusive window boundaries and rejects an out-of-window death", () => {
    const onBoundaries = sampleDecedents(
      [
        eligibleCandidate({ deceasedPatientId: "start", deathDate: "2025-01-01" }),
        eligibleCandidate({ deceasedPatientId: "end", deathDate: "2025-01-31" }),
      ],
      JAN_2025,
    );
    expect(onBoundaries).toHaveLength(2);

    expect(() =>
      sampleDecedents([eligibleCandidate({ deathDate: "2025-02-01" })], JAN_2025),
    ).toThrowError(WardenXError);
  });

  it("rejects an inverted stay interval (death before admission)", () => {
    expect(() =>
      sampleDecedents(
        [
          eligibleCandidate({
            admissionStartAt: "2025-01-20T00:00:00Z",
            deathAt: "2025-01-10T00:00:00Z",
            deathDate: "2025-01-10",
          }),
        ],
        JAN_2025,
      ),
    ).toThrowError(/deathAt precedes admissionStartAt/);
  });
});

// ── (b) result-ingest minimum-cell-size suppression (WF-06) ──────────────────────────────────────────────

describe("CAHPS result-ingest minimum-cell-size suppression (CMS ≤30 small-cell protection)", () => {
  function parsedRow(overrides: Partial<ParsedCahpsResultRow> = {}): ParsedCahpsResultRow {
    return {
      providerEntityId: "pe-1",
      reportingPeriodStart: "2025-01-01",
      reportingPeriodEnd: "2025-03-31",
      vendorAdapterId: "shp",
      topBoxPercentages: { q1: 88.5 },
      compositeScores: { communication: 91 },
      responseCount: 40,
      attemptedSampleCount: 100,
      responseRate: 0.4,
      vendorResponsePayloadHash: "deadbeef",
      ...overrides,
    };
  }

  it("suppresses score payloads AT the minimum cell size (responseCount === 30, minSize 30 ⇒ ≤)", () => {
    const { inputs, suppressed } = applyMinimumCellSuppression([parsedRow({ responseCount: 30 })], 30);
    const [row] = inputs;
    expect(row?.topBoxPercentages).toEqual({});
    expect(row?.compositeScores).toEqual({});
    // …but the aggregate counts + dedup hash survive so the row is still an auditable "ingested" record.
    expect(row?.responseCount).toBe(30);
    expect(row?.attemptedSampleCount).toBe(100);
    expect(row?.vendorResponsePayloadHash).toBe("deadbeef");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({ providerEntityId: "pe-1", responseCount: 30 });
  });

  it("does NOT suppress a cell just above the threshold (responseCount === 31)", () => {
    const { inputs, suppressed } = applyMinimumCellSuppression([parsedRow({ responseCount: 31 })], 30);
    expect(inputs[0]?.topBoxPercentages).toEqual({ q1: 88.5 });
    expect(inputs[0]?.compositeScores).toEqual({ communication: 91 });
    expect(suppressed).toHaveLength(0);
  });

  it("mixed batch: suppresses only the under-sized cells, passes the rest through intact", () => {
    const { inputs, suppressed } = applyMinimumCellSuppression(
      [
        parsedRow({ providerEntityId: "small", responseCount: 12, attemptedSampleCount: 50 }),
        parsedRow({ providerEntityId: "big", responseCount: 75 }),
      ],
      30,
    );
    expect(suppressed.map((s) => s.providerEntityId)).toEqual(["small"]);
    expect(inputs[0]?.topBoxPercentages).toEqual({}); // small ⇒ blanked
    expect(inputs[1]?.topBoxPercentages).toEqual({ q1: 88.5 }); // big ⇒ intact
  });

  it("fails closed on a non-positive minimum cell size and on impossible counts", () => {
    expect(() => applyMinimumCellSuppression([parsedRow()], 0)).toThrowError(WardenXError);
    expect(() => applyMinimumCellSuppression([parsedRow()], 2.5)).toThrowError(/positive integer/);
    expect(() =>
      applyMinimumCellSuppression([parsedRow({ responseCount: 60, attemptedSampleCount: 50 })], 30),
    ).toThrowError(/cannot exceed attemptedSampleCount/);
    expect(() =>
      applyMinimumCellSuppression([parsedRow({ responseCount: -1 })], 30),
    ).toThrowError(/non-negative integer/);
  });
});

// ── (c) the SHP adapter (platform default) ───────────────────────────────────────────────────────────────

function decedentRow(overrides: Partial<CahpsDecedentSampleRow> = {}): CahpsDecedentSampleRow {
  return {
    decedentId: "dec-1",
    deceasedDate: "2025-01-15",
    primaryCaregiverName: "Smith, Jane", // the comma forces RFC-4180 quoting
    primaryCaregiverPhone: "555-0100",
    primaryCaregiverEmail: null,
    exclusionReason: null,
    languagePreference: "en",
    ...overrides,
  };
}

describe("SHP CAHPS adapter (§4.5 platform default)", () => {
  const adapter = new ShpCahpsAdapter();

  it("renderExport produces the fixed SHP CSV layout (header + CRLF rows, text/csv, dated filename)", async () => {
    const file = await adapter.renderExport("org-1", JAN_2025, [decedentRow()]);
    expect(file.mimeType).toBe("text/csv");
    expect(file.filename).toBe("shp_cahps_decedents_2025-01-01_2025-01-31.csv");
    expect(file.filename).toBe(shpExportFilename(JAN_2025));

    const text = file.bytes.toString("utf8");
    const [headerLine, firstRow] = text.split("\r\n");
    expect(headerLine).toBe(SHP_DECEDENT_COLUMNS.join(","));
    // a comma-bearing caregiver name is RFC-4180 quoted; a null email renders as an empty cell.
    expect(firstRow).toContain('"Smith, Jane"');
  });

  it("NEVER forwards the §4.13 platform-only death_source marker into the vendor CSV", async () => {
    const file = await adapter.renderExport("org-1", JAN_2025, [decedentRow()]);
    const headerLine = file.bytes.toString("utf8").split("\r\n")[0] ?? "";
    expect(headerLine).not.toContain("death_source");
    expect(SHP_DECEDENT_COLUMNS as readonly string[]).not.toContain("death_source");
  });

  it("parseResultIngest maps a normalized SHP aggregate to vendor-of-record 'shp' with a stable dedup hash", async () => {
    const payload = Buffer.from(
      JSON.stringify([
        {
          providerEntityId: "pe-1",
          reportingPeriodStart: "2025-01-01",
          reportingPeriodEnd: "2025-03-31",
          topBoxPercentages: { q1: 90 },
          compositeScores: { communication: 88 },
          responseCount: 55,
          attemptedSampleCount: 120,
          responseRate: 0.458,
        },
      ]),
      "utf8",
    );
    const [row] = await adapter.parseResultIngest(payload);
    expect(row?.vendorAdapterId).toBe("shp");
    expect(row?.providerEntityId).toBe("pe-1");
    expect(row?.responseCount).toBe(55);
    expect(row?.topBoxPercentages).toEqual({ q1: 90 });
    // the dedup hash is SHA-256 hex over the raw payload — same bytes ⇒ same hash (idempotent ingest).
    expect(row?.vendorResponsePayloadHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await adapter.parseResultIngest(payload);
    expect(again[0]?.vendorResponsePayloadHash).toBe(row?.vendorResponsePayloadHash);
  });

  it("validateConfig requires apiKey + apiSecret; minimumCellSize is the CMS floor of 30", async () => {
    expect(adapter.minimumCellSize()).toBe(30);
    expect(await adapter.validateConfig({ apiKey: "k", apiSecret: "s" })).toEqual({ ok: true });
    const bad = await adapter.validateConfig({});
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.map((e) => e.field).sort()).toEqual(["apiKey", "apiSecret"]);
    }
  });

  it("pushExport fails closed (422) when the binding config lacks apiKey/apiSecret", async () => {
    const file = { filename: "f.csv", mimeType: "text/csv", bytes: Buffer.from("x") };
    await expect(adapter.pushExport("org-1", file, {})).rejects.toThrowError(WardenXError);
  });
});

// ── (c) the manual (no-contract) adapter ─────────────────────────────────────────────────────────────────

describe("manual CAHPS adapter (§4.5 no-contract path)", () => {
  const adapter = new ManualCahpsAdapter();

  it("pushExport NEVER pushes — it returns { status: 'no_push', reason: 'manual_vendor' }", async () => {
    const result = await adapter.pushExport(
      "org-1",
      { filename: "f.csv", mimeType: "text/csv", bytes: Buffer.from("x") },
      {},
    );
    expect(result).toEqual({ status: "no_push", reason: "manual_vendor" });
  });

  it("validateConfig accepts any config (even {}) and minimumCellSize is 30", async () => {
    expect(await adapter.validateConfig({})).toEqual({ ok: true });
    expect(adapter.minimumCellSize()).toBe(30);
  });

  it("renderExport + parseResultIngest round-trips a manual aggregate CSV into 'manual' inputs", async () => {
    // Build the aggregate CSV the coordinator would upload back, escaped via the shared renderCsv helper.
    const csv = renderCsv(MANUAL_RESULT_COLUMNS, [
      [
        "pe-9",
        "2025-01-01",
        "2025-03-31",
        JSON.stringify({ q1: 88.5 }),
        JSON.stringify({ communication: 91 }),
        "42",
        "100",
        "0.42",
      ],
    ]);
    const [row] = await adapter.parseResultIngest(csv);
    expect(row?.vendorAdapterId).toBe("manual");
    expect(row?.providerEntityId).toBe("pe-9");
    expect(row?.topBoxPercentages).toEqual({ q1: 88.5 });
    expect(row?.compositeScores).toEqual({ communication: 91 });
    expect(row?.responseCount).toBe(42);
    expect(row?.attemptedSampleCount).toBe(100);
    expect(row?.responseRate).toBe(0.42);
    expect(row?.vendorResponsePayloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parseResultIngest rejects a CSV missing a required column", () => {
    const csv = renderCsv(["provider_entity_id"], [["pe-9"]]);
    // NB: validation throws SYNCHRONOUSLY (the row map runs before the Promise.resolve wrapper), so the
    // throw surfaces at call time rather than as a rejected promise.
    expect(() => adapter.parseResultIngest(csv)).toThrowError(/missing column/);
  });
});

// ── (c) the three Phase-2 stub adapters ──────────────────────────────────────────────────────────────────

describe("Phase-2 CAHPS stub adapters fail closed (NOT_YET_IMPLEMENTED)", () => {
  const stubs = [
    new PressGaneyCahpsAdapter(),
    new DeytaCahpsAdapter(),
    new HealthcarefirstCahpsAdapter(),
  ];

  for (const stub of stubs) {
    it(`${stub.vendor}: validateConfig reports unavailable so org boot refuses to bind it`, async () => {
      const result = await stub.validateConfig({ apiKey: "k" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.reason).toMatch(/not yet implemented/);
      }
      expect(stub.minimumCellSize()).toBe(30);
    });

    it(`${stub.vendor}: every operating method throws vendor_adapter_not_implemented (503)`, () => {
      const file = { filename: "f.csv", mimeType: "text/csv", bytes: Buffer.from("x") };
      for (const call of [
        () => stub.renderExport("org-1", JAN_2025, [decedentRow()]),
        () => stub.pushExport("org-1", file, {}),
        () => stub.parseResultIngest(Buffer.from("[]")),
      ]) {
        let thrown: unknown;
        try {
          call();
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(WardenXError);
        expect((thrown as WardenXError).code).toBe("vendor_adapter_not_implemented");
        expect((thrown as WardenXError).statusCode).toBe(503);
      }
    });
  }
});

// ── the §4.5 factory resolution map ──────────────────────────────────────────────────────────────────────

describe("CAHPS adapter factory resolution map (§4.5)", () => {
  it("is total over every supported vendor id and resolves the right concrete class", () => {
    expect(SUPPORTED_CAHPS_VENDOR_IDS.sort()).toEqual(
      ["deyta", "healthcarefirst", "manual", "press_ganey", "shp"].sort(),
    );
    expect(CAHPS_ADAPTER_FACTORIES.shp({ apiKey: "k", apiSecret: "s" }).vendor).toBe("SHP");
    expect(CAHPS_ADAPTER_FACTORIES.manual({}).vendor).toBe("manual");
    expect(CAHPS_ADAPTER_FACTORIES.press_ganey({}).vendor).toBe("Press_Ganey");
  });
});
