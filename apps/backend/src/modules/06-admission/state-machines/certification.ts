// apps/backend/src/modules/06-admission/state-machines/certification.ts — M6-T04 (§2.3.3).
//
// The CertificationOfTerminalIllness (CTI) lifecycle: drafted → awaiting_hospice_md →
// (awaiting_attending →) signed → superseded|voided. The branch after hospice-MD sign depends on
// period 1 + an attending physician on file (§2.3.3). Pure transition over already-resolved facts
// (the M38 ICD-10 check, the M40 NPI match, the §2.4 CTI validators).
import type { LocalDate } from "@wardenx/types";
import { AdmissionStateError, require_ } from "./errors";
import { type TransitionResult, result } from "./effects";
import {
  CTI_SUBMIT_WINDOW,
  TEXT_MINIMUMS,
  checkAttendingSignature,
  checkTerminalDxAllowable,
  daysBetween,
} from "./validation";

/** The §2.3.3 CTI states. */
export type CertificationState =
  | "drafted"
  | "awaiting_hospice_md"
  | "awaiting_attending"
  | "signed"
  | "superseded"
  | "voided";

/** The §2.3.3 CTI events. */
export type CertificationEvent =
  | {
      readonly type: "submitToHospiceMd";
      readonly narrative: string;
      readonly isValidIcd10: boolean;
      readonly isHospiceAllowable: boolean;
      readonly periodStart: LocalDate;
      readonly today: LocalDate;
    }
  | {
      readonly type: "signByHospiceMd";
      readonly sequence: number;
      readonly patientHasAttending: boolean;
      readonly signerMatchesHospiceMd: boolean;
      readonly hospiceMdSignedAt: LocalDate;
      readonly periodStart: LocalDate;
      readonly lateReason?: string;
    }
  | { readonly type: "signByAttending"; readonly signerNpiMatchesAttending: boolean; readonly withinFourteenDays: boolean }
  | { readonly type: "createNew" }
  | { readonly type: "void"; readonly hasVoidPermission: boolean; readonly periodNotYetActive: boolean };

export type CertificationTransition = TransitionResult<CertificationState, CertificationEvent["type"]>;

/** The legal §2.3.3 transition graph. */
export const CERTIFICATION_GRAPH: Readonly<
  Record<CertificationState, ReadonlyArray<CertificationEvent["type"]>>
> = {
  drafted: ["submitToHospiceMd"],
  awaiting_hospice_md: ["signByHospiceMd"],
  awaiting_attending: ["signByAttending"],
  signed: ["createNew", "void"],
  superseded: [],
  voided: [],
};

/**
 * Apply a CTI event (§2.3.3). The hospice-MD sign branches to `awaiting_attending` (period 1 + the
 * patient has an attending) or straight to `signed` (period ≥ 2 OR no attending).
 */
export function transitionCertification(
  from: CertificationState,
  event: CertificationEvent,
): CertificationTransition {
  if (!CERTIFICATION_GRAPH[from].includes(event.type)) {
    throw new AdmissionStateError(
      "ILLEGAL_TRANSITION",
      `CTI cannot ${event.type} from '${from}'`,
    );
  }

  switch (event.type) {
    case "submitToHospiceMd": {
      require_(
        event.narrative.trim().length >= TEXT_MINIMUMS.ctiNarrative,
        "CTI_NARRATIVE_TOO_SHORT",
        `CTI narrative must be ≥ ${TEXT_MINIMUMS.ctiNarrative} characters`,
      );
      checkTerminalDxAllowable({ isValidIcd10: event.isValidIcd10, isHospiceAllowable: event.isHospiceAllowable });
      const offset = daysBetween(event.today, event.periodStart);
      require_(
        offset >= -CTI_SUBMIT_WINDOW.backDays && offset <= CTI_SUBMIT_WINDOW.forwardDays,
        "CTI_PERIOD_START_OUT_OF_WINDOW",
        "CTI period_start is outside the [today-14d, today+30d] submission window",
      );
      return result(from, event.type, "awaiting_hospice_md", [
        { kind: "audit" },
        { kind: "outbox", event: "m6.cti.drafted" },
      ]);
    }
    case "signByHospiceMd": {
      require_(event.signerMatchesHospiceMd, "CTI_SIGNER_MISMATCH", "signing user does not match hospice_md_id");
      // R-CTI-01: signed after period_start → signed_late=true AND a late_reason is required.
      const signedLate = daysBetween(event.periodStart, event.hospiceMdSignedAt) > 0;
      if (signedLate) {
        require_(
          (event.lateReason ?? "").trim().length > 0,
          "CTI_LATE_REASON_REQUIRED",
          "a late_reason is required when the hospice MD signs after period_start",
        );
      }
      const goesToAttending = event.sequence === 1 && event.patientHasAttending;
      const effects: CertificationTransition["effects"] = [
        { kind: "set_timestamp", field: "hospice_md_signed_at", at: event.hospiceMdSignedAt },
        { kind: "audit" },
        ...(signedLate
          ? ([{ kind: "set_flag", field: "signed_late" }, { kind: "outbox", event: "m6.cti.late_flagged" }] as CertificationTransition["effects"])
          : []),
      ];
      return result(from, event.type, goesToAttending ? "awaiting_attending" : "signed", [
        ...effects,
        ...(goesToAttending ? [] : ([{ kind: "outbox", event: "m6.cti.signed" }] as CertificationTransition["effects"])),
      ]);
    }
    case "signByAttending": {
      // R-CTI-03: the attending's NPI must match (verified via M40); signed within 14d of the MD sig.
      checkAttendingSignature({ sequence: 1, patientHasAttending: true, attendingSigned: event.signerNpiMatchesAttending });
      require_(event.withinFourteenDays, "ATTENDING_SIGNATURE_REQUIRED", "attending signature is outside the 14-day window");
      return result(from, event.type, "signed", [
        { kind: "audit" },
        { kind: "outbox", event: "m6.cti.signed" },
      ]);
    }
    case "createNew": {
      // Recert: the prior signed CTI is superseded by a fresh one for the next period.
      return result(from, event.type, "superseded", [{ kind: "audit" }]);
    }
    case "void": {
      require_(event.hasVoidPermission, "CTI_VOID_FORBIDDEN", "actor lacks cti.void");
      require_(event.periodNotYetActive, "CTI_VOID_FORBIDDEN", "cannot void a CTI whose election period is already active");
      return result(from, event.type, "voided", [
        { kind: "audit" },
        { kind: "outbox", event: "m6.cti.voided" },
      ]);
    }
  }
}
