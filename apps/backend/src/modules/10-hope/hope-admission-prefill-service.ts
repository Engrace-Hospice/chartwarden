import { type DbClient, schema } from "@wardenx/db";
import type {
  PatientAddressReader,
  PatientCoverage,
  PatientCoverageReader,
  PatientHopeAdmissionPrefillFacts,
  PatientHopeAdmissionPrefillReader,
} from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";
import { buildFoundationSiteReader } from "../../bootstrap/foundation-site-reader";
import { getSeam } from "../../bootstrap/index";
import { createHopeApplicabilityEngine } from "./spec/applicability-registry";
import type { HopeIsc } from "./hope-spec-registry";

type AssessmentRow = typeof schema.hopeAssessments.$inferSelect;
type SpecItemRow = typeof schema.hopeSpecItems.$inferSelect;
type AnswerSource = "patient_prefill" | "admission_prefill";

export interface HopePrefillAnswer {
  readonly itemCode: string;
  readonly value: string;
  readonly source: AnswerSource;
}

export interface HopeAdmissionPrefillResult {
  readonly assessmentId: string;
  readonly prefilledItemCodes: readonly string[];
}

const RACE_MAP: Record<string, string> = {
  "2106-3": "A1010A",
  "2054-5": "A1010B",
  "1002-5": "A1010C",
  "2028-9": "A1010D",
  "2029-7": "A1010D",
  "2034-7": "A1010E",
  "2036-2": "A1010F",
  "2039-6": "A1010G",
  "2040-4": "A1010H",
  "2047-9": "A1010I",
  "2076-8": "A1010K",
  "2080-0": "A1010L",
  "2081-8": "A1010M",
  ASKU: "A1010X",
  ASKD: "A1010Y",
};
const ETHNICITY_MAP: Record<string, string> = {
  "2186-5": "A1005A",
  "2148-5": "A1005B",
  "2180-8": "A1005C",
  "2182-4": "A1005D",
  "2135-2": "A1005E",
  ASKU: "A1005X",
  ASKD: "A1005Y",
};
const PAYER_ITEM_BY_COVERAGE_KIND: Record<string, string> = {
  medicare_ffs: "A1400A",
  medicare_advantage: "A1400B",
  medicaid: "A1400C",
  medicaid_managed_care: "A1400D",
  commercial: "A1400H",
  private_insurance: "A1400H",
  private_managed_care: "A1400I",
  self_pay: "A1400J",
  no_payor: "A1400K",
  other: "A1400Y",
};

export function isHopeCoverageInForceOn(
  coverage: PatientCoverage,
  onDate: string,
): boolean {
  return (
    coverage.effectiveFrom <= onDate &&
    (coverage.effectiveTo === null || coverage.effectiveTo >= onDate)
  );
}

function add(
  out: HopePrefillAnswer[],
  itemCode: string,
  value: string | null | undefined,
  source: AnswerSource,
): void {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed) out.push({ itemCode, value: trimmed, source });
}

export function mapHopeSexAssignedAtBirth(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "M" || normalized === "MALE") return "1";
  if (normalized === "F" || normalized === "FEMALE") return "2";
  return null;
}

export function mapHopeRaceCodes(
  codes: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const code of codes) {
    const mapped = RACE_MAP[code.trim()];
    if (mapped) out[mapped] = "1";
  }
  return out;
}

export function mapHopeEthnicityCodes(
  codes: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const code of codes) {
    const mapped = ETHNICITY_MAP[code.trim()];
    if (mapped) out[mapped] = "1";
  }
  return out;
}

export function mapHopePreferredLanguage(
  code: string | null | undefined,
): string | null {
  const normalized = code?.trim();
  return normalized ? normalized : null;
}

export function mapHopeCoverageKind(coverageKind: string): string | null {
  return PAYER_ITEM_BY_COVERAGE_KIND[coverageKind] ?? null;
}

export function mapHopeResidenceSite(
  kind: string | null | undefined,
  facilityId: string | null | undefined,
): string | null {
  if (kind === "home") return "01";
  if (kind === "facility" && facilityId) return null;
  return null;
}

export function shouldApplyHopeAdmissionPrefill(
  existingSource: string | null | undefined,
): boolean {
  return existingSource !== "user";
}

function activeMbi(
  patient: PatientHopeAdmissionPrefillFacts,
  admissionDate: string,
): string | null {
  const identifiers = patient.identifiers
    .filter(
      (identifier) =>
        identifier.kind === "mbi" &&
        identifier.value &&
        identifier.effectiveFrom <= admissionDate,
    )
    .filter(
      (identifier) =>
        identifier.effectiveTo === null ||
        identifier.effectiveTo >= admissionDate,
    )
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return identifiers[0]?.value ?? null;
}

function coverageSubscriberId(
  coverages: readonly PatientCoverage[],
  coverageKinds: readonly string[],
): string | null {
  const coverage = [...coverages]
    .filter(
      (row) =>
        coverageKinds.includes(row.coverageKind) && row.subscriberId?.trim(),
    )
    .sort((a, b) => a.rank - b.rank)[0];

  return coverage?.subscriberId?.trim() || null;
}

export function buildHopeAdmissionPrefillAnswers(input: {
  readonly patient: PatientHopeAdmissionPrefillFacts;
  readonly admissionDate: string;
  readonly postalCode: string | null;
  readonly residenceSite: string | null;
  readonly coverages: readonly PatientCoverage[];
  readonly providerNpi: string | null;
  readonly providerCcn: string | null;
}): HopePrefillAnswer[] {
  const out: HopePrefillAnswer[] = [];
  add(out, "A0100A", input.providerNpi, "admission_prefill");
  add(out, "A0100B", input.providerCcn, "admission_prefill");
  add(out, "A0220", input.admissionDate, "admission_prefill");
  add(out, "A0500A", input.patient.legalFirstName, "patient_prefill");
  add(
    out,
    "A0500B",
    input.patient.legalMiddleName?.slice(0, 1) ?? null,
    "patient_prefill",
  );
  add(out, "A0500C", input.patient.legalLastName, "patient_prefill");
  add(out, "A0500D", input.patient.legalNameSuffix, "patient_prefill");
  add(
    out,
    "A0600B",
    activeMbi(input.patient, input.admissionDate) ??
      coverageSubscriberId(input.coverages, [
        "medicare_ffs",
        "medicare_advantage",
      ]),
    "patient_prefill",
  );
  add(
    out,
    "A0700",
    coverageSubscriberId(input.coverages, [
      "medicaid",
      "medicaid_managed_care",
    ]),
    "patient_prefill",
  );
  add(
    out,
    "A0810",
    mapHopeSexAssignedAtBirth(input.patient.sexAssignedAtBirth),
    "patient_prefill",
  );
  add(out, "A0900", input.patient.dob, "patient_prefill");
  add(out, "A0550", input.postalCode, "patient_prefill");
  add(out, "A0215", input.residenceSite, "patient_prefill");
  add(
    out,
    "A1110A",
    mapHopePreferredLanguage(input.patient.preferredLanguageCode),
    "patient_prefill",
  );
  for (const [itemCode, value] of Object.entries(
    mapHopeRaceCodes(input.patient.raceCodes),
  ))
    add(out, itemCode, value, "patient_prefill");
  for (const [itemCode, value] of Object.entries(
    mapHopeEthnicityCodes(input.patient.ethnicityCodes),
  ))
    add(out, itemCode, value, "patient_prefill");
  const payerItems = new Set(
    input.coverages
      .map((coverage) => mapHopeCoverageKind(coverage.coverageKind))
      .filter((item): item is string => Boolean(item)),
  );
  for (const itemCode of payerItems) add(out, itemCode, "1", "patient_prefill");
  return out;
}

export interface HopeAdmissionPrefillService {
  prefillAdmission(input: {
    readonly tx: DbClient;
    readonly organizationId: string;
    readonly assessment: AssessmentRow;
    readonly specVersionCode: string;
    readonly admissionDate: string;
  }): Promise<HopeAdmissionPrefillResult>;
}

export function createHopeAdmissionPrefillService(): HopeAdmissionPrefillService {
  const A = schema.hopeAssessments;
  const ITEM = schema.hopeSpecItems;
  const ISC = schema.hopeSpecItemIsc;
  const OPTION = schema.hopeSpecItemOptions;
  const ANSWER = schema.hopeAssessmentAnswers;
  // M1 owns `provider_entity` — its NPI/CCN come through M1's foundation reader, on this same tx.
  const foundationSites = buildFoundationSiteReader();

  async function specItems(
    tx: DbClient,
    specVersionId: string,
    isc: HopeIsc,
    itemCodes: readonly string[],
  ) {
    if (itemCodes.length === 0) return new Map<string, SpecItemRow>();
    const rows = await tx
      .select({ item: ITEM })
      .from(ITEM)
      .innerJoin(ISC, eq(ISC.specItemId, ITEM.id))
      .where(
        and(
          eq(ITEM.specVersionId, specVersionId),
          inArray(ITEM.itemCode, [...itemCodes]),
          eq(ISC.isc, isc),
          eq(ISC.active, true),
        ),
      );
    return new Map(rows.map((row) => [row.item.itemCode, row.item]));
  }

  async function validValue(
    tx: DbClient,
    item: SpecItemRow,
    value: string,
  ): Promise<boolean> {
    const options = await tx
      .select()
      .from(OPTION)
      .where(eq(OPTION.specItemId, item.id));
    if (options.length === 0) return true;
    if (
      options.some(
        (option) =>
          option.valueCode === "Text" ||
          option.valueCode === "YYYYMMDD" ||
          option.valueCode === "YYYYMM" ||
          option.valueCode === "YYYY",
      )
    )
      return true;
    return options.some((option) => option.valueCode === value);
  }

  async function answersByItem(
    tx: DbClient,
    assessmentId: string,
    items: readonly SpecItemRow[],
  ) {
    const rows = await tx
      .select()
      .from(ANSWER)
      .where(
        and(
          eq(ANSWER.hopeAssessmentId, assessmentId),
          inArray(
            ANSWER.specItemId,
            items.map((item) => item.id),
          ),
        ),
      );
    return new Map(rows.map((answer) => [answer.specItemId, answer]));
  }

  async function reconcileApplicability(input: {
    readonly tx: DbClient;
    readonly assessment: AssessmentRow;
    readonly specVersionCode: string;
  }) {
    const { tx, assessment, specVersionCode } = input;
    const rows = await tx
      .select({ item: ITEM })
      .from(ITEM)
      .innerJoin(ISC, eq(ISC.specItemId, ITEM.id))
      .where(
        and(
          eq(ITEM.specVersionId, assessment.specVersionId!),
          eq(ISC.isc, assessment.isc as HopeIsc),
          eq(ISC.active, true),
          eq(ITEM.kind, "assessment"),
        ),
      );
    const items = rows.map((row) => row.item);
    const byId = new Map(items.map((item) => [item.id, item]));
    const current = await answersByItem(tx, assessment.id, items);
    const answerMap = new Map<
      string,
      { state: "answered" | "skipped"; value: unknown | null }
    >();
    for (const [itemId, answer] of current) {
      const item = byId.get(itemId);
      if (item)
        answerMap.set(item.itemCode, {
          state: answer.state,
          value: answer.value as unknown | null,
        });
    }
    const applicability = createHopeApplicabilityEngine(
      specVersionCode,
    ).evaluate({
      isc: assessment.isc as HopeIsc,
      activeItemCodes: items.map((item) => item.itemCode),
      answers: answerMap,
    });
    for (const item of items) {
      const state = applicability.items.get(item.itemCode);
      if (state?.applicability === "not_applicable") {
        const existing = current.get(item.id);
        if (existing?.source === "user") continue;
        await tx
          .insert(ANSWER)
          .values({
            organizationId: assessment.organizationId,
            providerEntityId: assessment.providerEntityId,
            locationId: assessment.locationId,
            hopeAssessmentId: assessment.id,
            specVersionId: assessment.specVersionId!,
            specItemId: item.id,
            state: "skipped",
            value: null,
            source: "derived",
            sourceReference: state.reason
              ? { reason: "skip_pattern", ...state.reason }
              : { reason: "skip_pattern" },
            answeredAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [ANSWER.hopeAssessmentId, ANSWER.specItemId],
            set: {
              state: "skipped",
              value: null,
              source: "derived",
              sourceReference: state.reason
                ? { reason: "skip_pattern", ...state.reason }
                : { reason: "skip_pattern" },
              updatedAt: new Date(),
            },
          });
      } else {
        const existing = current.get(item.id);
        if (existing?.state === "skipped" && existing.source === "derived") {
          await tx
            .delete(ANSWER)
            .where(
              and(
                eq(ANSWER.hopeAssessmentId, assessment.id),
                eq(ANSWER.specItemId, item.id),
              ),
            );
        }
      }
    }
  }

  return {
    async prefillAdmission({
      tx,
      organizationId,
      assessment,
      specVersionCode,
      admissionDate,
    }) {
      if (
        !assessment.specVersionId ||
        !assessment.isc ||
        assessment.status !== "draft"
      ) {
        return { assessmentId: assessment.id, prefilledItemCodes: [] };
      }
      const patientReader = getSeam(
        "PatientHopeAdmissionPrefillReader",
      ) as PatientHopeAdmissionPrefillReader;
      const addressReader = getSeam(
        "PatientAddressReader",
      ) as PatientAddressReader;
      const coverageReader = getSeam(
        "PatientCoverageReader",
      ) as PatientCoverageReader;
      const patient = await patientReader.factsForHopeAdmissionPrefill({
        organizationId,
        patientId: assessment.patientId,
      });
      if (!patient || patient.organizationId !== organizationId)
        return { assessmentId: assessment.id, prefilledItemCodes: [] };
      const residence = await addressReader.residenceAt(
        organizationId,
        assessment.patientId,
        admissionDate,
      );
      const coverages = (
        await coverageReader.coveragesForPatient({
          organizationId,
          patientId: assessment.patientId,
        })
      ).filter((coverage) => isHopeCoverageInForceOn(coverage, admissionDate));
      const provider = assessment.providerEntityId
        ? await foundationSites.providerEntityIdentifiers(
            tx,
            organizationId,
            assessment.providerEntityId,
          )
        : null;
      const answers = buildHopeAdmissionPrefillAnswers({
        patient,
        admissionDate,
        postalCode: residence?.postalCode ?? null,
        residenceSite: mapHopeResidenceSite(
          residence?.kind,
          residence?.facilityId,
        ),
        coverages,
        providerNpi: provider?.npi ?? null,
        providerCcn: provider?.ccn ?? null,
      });
      const items = await specItems(
        tx,
        assessment.specVersionId,
        assessment.isc as HopeIsc,
        answers.map((answer) => answer.itemCode),
      );
      const existing = await answersByItem(tx, assessment.id, [
        ...items.values(),
      ]);
      const written: string[] = [];
      for (const answer of answers) {
        const item = items.get(answer.itemCode);
        if (!item || !(await validValue(tx, item, answer.value))) continue;
        const current = existing.get(item.id);
        if (!shouldApplyHopeAdmissionPrefill(current?.source)) continue;
        await tx
          .insert(ANSWER)
          .values({
            organizationId,
            providerEntityId: assessment.providerEntityId,
            locationId: assessment.locationId,
            hopeAssessmentId: assessment.id,
            specVersionId: assessment.specVersionId!,
            specItemId: item.id,
            state: "answered",
            value: answer.value,
            source: answer.source,
            sourceReference: { reason: "admission_prefill_snapshot" },
            answeredAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [ANSWER.hopeAssessmentId, ANSWER.specItemId],
            set: {
              state: "answered",
              value: answer.value,
              source: answer.source,
              sourceReference: { reason: "admission_prefill_snapshot" },
              updatedAt: new Date(),
            },
          });
        written.push(answer.itemCode);
      }
      await reconcileApplicability({ tx, assessment, specVersionCode });
      await tx
        .update(A)
        .set({ updatedAt: new Date() })
        .where(eq(A.id, assessment.id));
      return { assessmentId: assessment.id, prefilledItemCodes: written };
    },
  };
}
