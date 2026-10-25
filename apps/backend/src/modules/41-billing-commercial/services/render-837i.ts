// apps/backend/src/modules/41-billing-commercial/services/render-837i.ts — render a READY commercial claim to the 005010X223A2
// 837I through the shared builder in `@chartwarden/x12-837-client` (ADR-0100 D6, issue #722).
//
// The member id, group number and subscriber demographics are read transiently through ports for ONE build and are never
// stored or logged: the stored claim carries coverage row ids only. A builder refusal comes back as a gap naming the FIELD
// (never a value). Nothing is invented: a missing party or identity is a typed gap. Submitting the rendered claim is the
// submission slice (it routes through `ClearinghouseTransport`, ADR-0100 D4); this file only produces the payload.
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  COMMERCIAL_ERROR_CODES,
  ChartWardenError,
  ConflictError,
  NotFoundError,
  type PatientCoverageReader,
} from "@chartwarden/types";
import {
  type Claim837iInput,
  type ClaimOtherPayer,
  type StediClaimJson,
  type X12Address,
  X12BuildError,
  build837iClaim,
  buildStediClaimJson,
} from "@chartwarden/x12-837-client";
import { and, asc, eq } from "drizzle-orm";
import { assertRowReachable } from "./scope-guard";
import type { CommercialActor, CommercialClaimSeams, CommercialDb } from "./types";
import { evaluateClaim } from "./validation-runner";

/** The patient demographics one build needs (name, birth date, sex, address). Never persisted or logged. */
export interface CommercialSubscriberIdentity {
  readonly lastName: string;
  readonly firstName: string;
  readonly dateOfBirth: string;
  readonly sex: "M" | "F";
  readonly address: X12Address;
}

export interface CommercialRenderParties {
  readonly submitter: Claim837iInput["submitter"];
  readonly receiver: Claim837iInput["receiver"] & { readonly applicationCode: string };
  readonly billingProvider: Claim837iInput["billingProvider"];
  /** The primary payer's name as the clearinghouse knows it. */
  readonly payerName: string;
  /** The Medicare / Medicaid payer behind the primary, when the claim declares one. */
  readonly secondaryPayer: { readonly name: string; readonly payerId: string } | null;
}

export interface CommercialRenderPorts {
  readonly coverage: Pick<PatientCoverageReader, "coveragesForPatient">;
  readonly caseload: CommercialClaimSeams["caseload"];
  readonly identity: {
    identityFor(args: {
      organizationId: string;
      patientId: string;
    }): Promise<CommercialSubscriberIdentity | null>;
  };
  readonly parties: {
    partiesFor(args: {
      organizationId: string;
      providerEntityId: string;
      clearinghousePayerId: string;
      secondaryPayerKind: "medicare" | "medicaid" | null;
    }): Promise<CommercialRenderParties | null>;
  };
}

export interface Render837iArgs {
  readonly claimId: string;
  readonly interchangeControlNumber: number;
  readonly usage: "P" | "T";
  readonly createdAt: Date;
}

export type Render837iResult =
  | {
      readonly ok: true;
      /** Contains the member id: transmit it, never store or log it. */
      readonly x12: string;
      /** Stedi's JSON for the same claim; `null` when it cannot carry it (other payer, or a line without a procedure code). */
      readonly stediJson: StediClaimJson | null;
    }
  | { readonly ok: false; readonly gaps: readonly string[] };

const gap = (...fields: string[]): Render837iResult => ({ ok: false, gaps: fields });

export function buildCommercial837iRenderer(db: CommercialDb, ports: CommercialRenderPorts) {
  return {
    async render(actor: CommercialActor, args: Render837iArgs): Promise<Render837iResult> {
      if (actor.actorKind.startsWith("ai_")) {
        throw new ChartWardenError("AI_ACTOR_FORBIDDEN", "AI actors may not render a claim", 403);
      }
      const loaded = await withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          const [claim] = await tx
            .select()
            .from(schema.commercialClaims)
            .where(
              and(
                eq(schema.commercialClaims.id, args.claimId),
                eq(schema.commercialClaims.organizationId, actor.organizationId),
              ),
            );
          if (!claim) throw new NotFoundError("commercial claim");
          await assertRowReachable(actor, ports.caseload, claim);
          // Re-evaluate on the CURRENT facts: a ready claim whose authorization was voided (or route ended) since is not renderable.
          const blocking = (await evaluateClaim(tx, claim)).filter((r) => r.blocking);
          if (blocking.length > 0) {
            throw new ChartWardenError(
              COMMERCIAL_ERROR_CODES.claimBlocked,
              `The claim cannot be rendered: ${blocking.map((b) => b.message).join(" ")}`,
              409,
            );
          }
          // the state is checked in the same transaction as the evaluation (a draft or void claim is never rendered)
          if (claim.state !== "ready") {
            throw new ConflictError(
              "only a ready claim can be rendered; validate and clear every block first",
            );
          }
          const lines = await tx
            .select()
            .from(schema.commercialClaimLines)
            .where(eq(schema.commercialClaimLines.claimId, claim.id))
            .orderBy(asc(schema.commercialClaimLines.lineNumber));
          return { claim, lines };
        },
      );
      const { claim, lines } = loaded;
      if (claim.clearinghousePayerId === null) return gap("payer.payerId");
      if (
        claim.attendingNpi === null ||
        claim.attendingFirstName === null ||
        claim.attendingLastName === null
      ) {
        return gap("attendingPhysician");
      }
      const diagnoses = (
        claim.diagnoses as { icd10Code: string; sequence: number; qualifier: "ABK" | "ABF" }[]
      )
        .slice()
        .sort((a, b) => a.sequence - b.sequence);
      const principal = diagnoses.find((d) => d.qualifier === "ABK") ?? diagnoses[0];
      if (!principal) return gap("claim.principalDiagnosis");
      if (claim.admissionTypeCode === null) return gap("claim.admissionTypeCode");
      if (claim.admissionSourceCode === null) return gap("claim.admissionSource");

      const coverages = await ports.coverage.coveragesForPatient({
        organizationId: actor.organizationId,
        patientId: claim.patientId,
      });
      const primary = coverages.find((c) => c.id === claim.primaryPatientPayerId);
      if (!primary) return gap("subscriber.memberId");
      const identity = await ports.identity.identityFor({
        organizationId: actor.organizationId,
        patientId: claim.patientId,
      });
      if (!identity) return gap("subscriber");
      const parties = await ports.parties.partiesFor({
        organizationId: actor.organizationId,
        providerEntityId: claim.providerEntityId,
        clearinghousePayerId: claim.clearinghousePayerId,
        secondaryPayerKind: claim.secondaryPayerKind as "medicare" | "medicaid" | null,
      });
      if (!parties) return gap("parties");

      const otherPayers: ClaimOtherPayer[] = [];
      if (claim.secondaryPatientPayerId !== null) {
        const secondary = coverages.find((c) => c.id === claim.secondaryPatientPayerId);
        if (!secondary || parties.secondaryPayer === null) return gap("claim.otherPayers");
        otherPayers.push({
          responsibility: "S",
          claimFilingIndicator: claim.secondaryPayerKind === "medicare" ? "MA" : "MC",
          memberId: secondary.subscriberId,
          payerName: parties.secondaryPayer.name,
          payerId: parties.secondaryPayer.payerId,
        });
      }

      const input: Claim837iInput = {
        envelope: {
          senderId: parties.submitter.id,
          receiverId: parties.receiver.id,
          applicationReceiverCode: parties.receiver.applicationCode,
          interchangeControlNumber: args.interchangeControlNumber,
          usage: args.usage,
          createdAt: args.createdAt,
        },
        submitter: parties.submitter,
        receiver: { name: parties.receiver.name, id: parties.receiver.id },
        billingProvider: parties.billingProvider,
        subscriber: {
          lastName: identity.lastName,
          firstName: identity.firstName,
          mbi: primary.subscriberId, // the plan MEMBER ID on a commercial claim (see Parties837i.commercial)
          address: identity.address,
          birthDate: identity.dateOfBirth,
          sex: identity.sex,
        },
        payer: { name: parties.payerName, payerId: claim.clearinghousePayerId },
        commercial: {
          claimFilingIndicator: claim.claimFilingIndicator,
          groupNumber: primary.groupNumber,
        },
        attendingPhysician: {
          lastName: claim.attendingLastName,
          firstName: claim.attendingFirstName,
          npi: claim.attendingNpi,
        },
        claim: {
          controlNumber: claim.claimControlNumber,
          frequency: claim.frequencyCode,
          statementFromDate: claim.serviceFrom,
          statementThroughDate: claim.serviceTo,
          admissionDate: claim.admissionDate,
          admissionTypeCode: claim.admissionTypeCode,
          admissionSource: claim.admissionSourceCode,
          patientStatus: claim.patientStatusCode,
          principalDiagnosis: principal.icd10Code,
          otherDiagnoses: diagnoses.filter((d) => d !== principal).map((d) => d.icd10Code),
          conditionCodes: [],
          occurrenceCodes: [],
          valueCodes: [],
          otherPayers,
          lines: lines.map((l) => ({
            revenueCode: l.revenueCode,
            ...(l.hcpcsCode === null ? {} : { hcpcs: l.hcpcsCode }),
            chargeCents: l.lineChargeCents,
            units: l.units,
            serviceDate: l.serviceFrom,
            ...(l.serviceTo === l.serviceFrom ? {} : { serviceThroughDate: l.serviceTo }),
          })),
        },
      };
      try {
        const x12 = build837iClaim(input);
        let stediJson: StediClaimJson | null = null;
        try {
          stediJson = buildStediClaimJson(input);
        } catch (e) {
          if (!(e instanceof X12BuildError)) throw e; // unsupported shape for the JSON route: the raw X12 still stands
        }
        return { ok: true, x12, stediJson };
      } catch (e) {
        if (e instanceof X12BuildError) return gap(e.field);
        throw e;
      }
    },
  };
}
