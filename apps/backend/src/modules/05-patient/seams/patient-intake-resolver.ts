import crypto from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  PatientCreateFromIntakeInput,
  PatientIdentity,
  PatientIntakeResolver,
  PatientIntakeSubject,
} from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import { runMatch, type MatchCandidate } from "../matching/matcher";
import { normalizeSubject } from "../matching/normalize";
import { createDrizzlePatientReaderStore } from "./drizzle-stores";
import { createPatientReader } from "./patient-reader";

const P = schema.patients;
const ID = schema.patientIdentifiers;
const SEAM_SYSTEM_USER_ID = "";

function splitReceiptName(name: string): { firstName: string; lastName: string } {
  const cleaned = name.trim().replace(/\s+/g, " ");
  const comma = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  if (comma.length >= 2) return { lastName: comma[0]!, firstName: comma[1]!.split(" ")[0] ?? "Unknown" };
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "Unknown" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

function subjectFor(input: PatientIntakeSubject) {
  const name = splitReceiptName(input.patientNameAtReceipt);
  return {
    firstName: name.firstName,
    lastName: name.lastName,
    dob: input.patientDobAtReceipt ?? "1900-01-01",
  };
}

function toIdentity(row: {
  id: string;
  organizationId: string;
  mrn: string;
  legalFirstName: string;
  legalLastName: string;
  dob: string;
  sexAssignedAtBirth: string;
  providerEntityId: string | null;
}): PatientIdentity {
  return {
    id: row.id,
    organizationId: row.organizationId,
    mrn: row.mrn,
    externalMrns: [],
    firstName: row.legalFirstName,
    lastName: row.legalLastName,
    dateOfBirth: row.dob,
    administrativeSex: row.sexAssignedAtBirth,
    providerEntityId: row.providerEntityId,
  };
}

export function createDbPatientIntakeResolver(db: DbClient): PatientIntakeResolver {
  const reader = createPatientReader(createDrizzlePatientReaderStore(db));

  return {
    async findPatientCandidates(input) {
      if (!input.patientDobAtReceipt) return { outcome: "no_match", candidates: [] };
      return withOrgContext(db, { organizationId: input.organizationId, userId: SEAM_SYSTEM_USER_ID }, async (tx) => {
        const subject = subjectFor(input);
        const rows = await tx
          .select({
            id: P.id,
            lastName: P.legalLastName,
            firstName: P.legalFirstName,
            dob: P.dob,
            mbi: ID.value,
          })
          .from(P)
          .leftJoin(ID, and(eq(ID.patientId, P.id), eq(ID.kind, "mbi")))
          .where(eq(P.organizationId, input.organizationId));
        const candidates: MatchCandidate[] = rows.map((r) => ({
          ...normalizeSubject({ lastName: r.lastName, firstName: r.firstName, dob: r.dob, mbi: r.mbi }),
          id: r.id,
        }));
        const result = runMatch(normalizeSubject(subject), candidates);
        if (result.outcome === "hard_block") {
          return {
            outcome: "deterministic_match",
            candidates: [
              {
                patientId: result.existingPatientId,
                confidence: "deterministic",
                matchedOn: result.matchedOn,
                score: result.score,
              },
            ],
          };
        }
        if (result.outcome === "soft_review") {
          return {
            outcome: "possible_match",
            candidates: result.reviewCandidates.map((c) => ({
              patientId: c.id,
              confidence: "probable",
              score: c.score,
            })),
          };
        }
        return { outcome: "no_match", candidates: [] };
      });
    },

    confirmPatient(input) {
      return reader.findById({ organizationId: input.organizationId, id: input.patientId });
    },

    async createPatientFromIntake(input: PatientCreateFromIntakeInput) {
      const name = splitReceiptName(input.patientNameAtReceipt);
      const dob = input.patientDobAtReceipt;
      if (!dob) throw new Error("patient DOB is required to create a canonical patient from intake");
      return withOrgContext(db, { organizationId: input.organizationId, userId: SEAM_SYSTEM_USER_ID }, async (tx) => {
        const mrn = `MRN-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
        const today = new Date().toISOString().slice(0, 10);
        const [row] = await tx
          .insert(P)
          .values({
            organizationId: input.organizationId,
            mrn,
            legalFirstName: name.firstName,
            legalLastName: name.lastName,
            dob,
            sexAssignedAtBirth: input.administrativeSex ?? "U",
            status: "prospective",
          })
          .returning({
            id: P.id,
            organizationId: P.organizationId,
            mrn: P.mrn,
            legalFirstName: P.legalFirstName,
            legalLastName: P.legalLastName,
            dob: P.dob,
            sexAssignedAtBirth: P.sexAssignedAtBirth,
            providerEntityId: P.providerEntityId,
          });
        if (!row) throw new Error("patient insert returned no row");
        await tx.insert(ID).values({
          patientId: row.id,
          organizationId: input.organizationId,
          kind: "mrn",
          value: mrn,
          effectiveFrom: today,
        });
        return toIdentity(row);
      });
    },
  };
}
