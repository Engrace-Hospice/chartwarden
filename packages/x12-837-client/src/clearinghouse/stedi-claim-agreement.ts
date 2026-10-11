// @wardenx/x12-837-client — proves the raw X12 and the Stedi JSON built from the SAME claim input agree on the
// money, dates and codes that decide payment (ADR-0053 D9). Pure and content-free: it returns the names of the
// fields that disagree, never their values (PHI-safe, loggable).
import { tokenizeInterchange } from "../eligibility/x12-envelope";
import type { StediClaimJson } from "./stedi-claim-json";

type Segment = readonly string[];

/** "1500.00" / "38900" → integer cents, or null when not a plain decimal. */
function cents(value: string | undefined): number | null {
  if (value === undefined || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole = "0", frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Agreement on a list that carries amounts: an unreadable (null) amount is never "equal" to another one. */
const sameWithAmounts = (
  a: readonly (readonly unknown[])[],
  b: readonly (readonly unknown[])[],
): boolean => !a.concat(b).some((row) => row.includes(null)) && same(a, b);

/** The component values of every HI element carrying `qualifier`, in order. */
function hiValues(segments: readonly Segment[], qualifier: string, component: string): string[][] {
  return segments
    .filter((s) => s[0] === "HI")
    .flatMap((s) => s.slice(1))
    .map((el) => el.split(component))
    .filter((parts) => parts[0] === qualifier)
    .map((parts) => parts.slice(1));
}

/**
 * Fields on which `json` and the single claim in `raw` disagree (empty = they agree). Throws `X12FormatError` for an
 * unreadable interchange, like every reader here.
 */
export function compareStediClaimJsonToX12(json: StediClaimJson, raw: string): string[] {
  const { segments, delimiters } = tokenizeInterchange(raw);
  const comp = delimiters.component;
  const first = (id: string): Segment => segments.find((s) => s[0] === id) ?? [];
  const dtp = (q: string): Segment => segments.find((s) => s[0] === "DTP" && s[1] === q) ?? [];
  const clm = first("CLM");
  const cl1 = first("CL1");
  const info = json.claimInformation;
  const bad: string[] = [];
  const expect = (field: string, ok: boolean): void => {
    if (!ok) bad.push(field);
  };

  const count = (id: string, q?: string): number =>
    segments.filter((s) => s[0] === id && (q === undefined || s[1] === q)).length;
  expect(
    "claim.structure",
    count("CLM") === 1 &&
      count("CL1") === 1 &&
      count("DTP", "434") === 1 &&
      count("DTP", "435") === 1,
  );
  const isa = first("ISA");
  expect("envelope.usage", isa[15] === json.usageIndicator);
  const nm1 = (q: string): Segment => segments.find((s) => s[0] === "NM1" && s[1] === q) ?? [];
  expect("billingProvider.npi", nm1("85")[9] === json.billing.npi);
  expect("attendingPhysician.npi", nm1("71")[9] === json.attending.npi);
  expect("subscriber.mbi", nm1("IL")[9] === json.subscriber.memberId);
  expect("payer.payerId", nm1("PR")[9] === json.tradingPartnerServiceId);
  expect(
    "billingProvider.taxId",
    segments.find((s) => s[0] === "REF" && s[1] === "EI")?.[2] === json.billing.employerId,
  );
  const dmg = first("DMG");
  expect("subscriber.birthDate", dmg[2] === json.subscriber.dateOfBirth);
  expect("subscriber.sex", dmg[3] === json.subscriber.gender);
  expect("claim.facilityType", clm[5]?.split(comp)[0] === info.placeOfServiceCode);
  expect("claim.controlNumber", clm[1] === info.patientControlNumber);
  expect("claim.frequency", clm[5]?.split(comp)[2] === info.claimFrequencyCode);
  const [from, through] = (dtp("434")[3] ?? "").split("-");
  expect("claim.statementFromDate", from === info.claimDateInformation.statementBeginDate);
  expect("claim.statementThroughDate", through === info.claimDateInformation.statementEndDate);
  expect("claim.admissionDate", dtp("435")[3] === info.claimDateInformation.admissionDateAndHour);
  expect("claim.dischargeHour", dtp("096")[3] === info.claimDateInformation.dischargeHour);
  expect("claim.admissionSource", cl1[2] === info.claimCodeInformation.admissionSourceCode);
  expect("claim.patientStatus", cl1[3] === info.claimCodeInformation.patientStatusCode);
  const refF8 = segments.find((s) => s[0] === "REF" && s[1] === "F8")?.[2];
  expect(
    "claim.payerClaimControlNumber",
    refF8 === info.claimSupplementalInformation?.claimControlNumber,
  );

  const principal = hiValues(segments, "ABK", comp).map((p) => p[0]);
  expect(
    "claim.principalDiagnosis",
    same(principal, [info.principalDiagnosis.principalDiagnosisCode]),
  );
  const others = hiValues(segments, "ABF", comp).map((p) => p[0]);
  expect(
    "claim.otherDiagnoses",
    same(
      others,
      (info.otherDiagnosisInformationList ?? []).flat().map((d) => d.otherDiagnosisCode),
    ),
  );
  const occurrences = hiValues(segments, "BH", comp).map((p) => [p[0], p[2]]);
  expect(
    "claim.occurrenceCodes",
    same(
      occurrences,
      (info.occurrenceInformationList ?? [])
        .flat()
        .map((o) => [o.occurrenceSpanCode, o.occurrenceSpanCodeDate]),
    ),
  );
  const rawValues = hiValues(segments, "BE", comp).map((p) => [p[0], cents(p[3])]);
  expect(
    "claim.valueCodes",
    sameWithAmounts(
      rawValues,
      (info.valueInformationList ?? []).flat().map((v) => [v.valueCode, cents(v.valueCodeAmount)]),
    ),
  );
  const conditions = hiValues(segments, "BG", comp).map((p) => p[0]);
  expect(
    "claim.conditionCodes",
    same(
      conditions,
      (info.conditionCodesList ?? []).flat().map((c) => c.conditionCode),
    ),
  );

  const rawLines = segments.flatMap((s, i) =>
    s[0] === "SV2"
      ? [
          {
            rev: s[1],
            proc: (s[2] ?? "").split(comp),
            charge: cents(s[3]),
            units: s[5],
            date:
              segments[i + 1]?.[0] === "DTP" && segments[i + 1]?.[1] === "472"
                ? segments[i + 1]?.[3]
                : undefined,
          },
        ]
      : [],
  );
  const jsonLines = info.serviceLines.map((l) => ({
    rev: l.institutionalService.serviceLineRevenueCode,
    proc: [
      "HC",
      l.institutionalService.procedureCode,
      ...(l.institutionalService.procedureModifiers ?? []),
    ],
    charge: cents(l.institutionalService.lineItemChargeAmount),
    units: l.institutionalService.serviceUnitCount,
    date: l.serviceDate,
  }));
  expect("claim.lines", same(rawLines, jsonLines));
  const total = cents(info.claimChargeAmount);
  const lineSum = jsonLines.reduce((sum, l) => sum + (l.charge ?? Number.NaN), 0);
  expect("claim.totalCharge", total !== null && total === cents(clm[2]) && total === lineSum);

  return [...new Set(bad)];
}
