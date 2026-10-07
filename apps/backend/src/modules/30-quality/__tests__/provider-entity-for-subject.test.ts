// GAP-154 — a patient-linked M30 write is stamped with the provider entity of the SUBJECT's admission, not the
// org's "primary" entity (a multi-CCN org would otherwise merge outbreak clusters and misattribute CAHPS).
import { describe, expect, it, vi } from "vitest";
import {
  type SubjectProviderEntityPort,
  resolveProviderEntityForSubject,
} from "../routes/provider-entity-for-subject";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const PRIMARY = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const SUBJECT_PE = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
const tx = {} as never;

const primary = (): SubjectProviderEntityPort["primaryProviderEntityId"] =>
  vi.fn(async () => PRIMARY);

describe("resolveProviderEntityForSubject", () => {
  it("uses the subject's admission provider entity when the seam resolves one", async () => {
    const port: SubjectProviderEntityPort = {
      primaryProviderEntityId: primary(),
      providerEntityIdForPatient: async () => SUBJECT_PE,
    };
    await expect(resolveProviderEntityForSubject(port, tx, ORG, PATIENT)).resolves.toBe(SUBJECT_PE);
  });

  it("falls back to the primary entity when the patient has no sited admission", async () => {
    const port: SubjectProviderEntityPort = {
      primaryProviderEntityId: primary(),
      providerEntityIdForPatient: async () => null,
    };
    await expect(resolveProviderEntityForSubject(port, tx, ORG, PATIENT)).resolves.toBe(PRIMARY);
  });

  it("uses the primary entity for a subject-less write without consulting the seam", async () => {
    const providerEntityIdForPatient = vi.fn(async () => SUBJECT_PE);
    const port: SubjectProviderEntityPort = {
      primaryProviderEntityId: primary(),
      providerEntityIdForPatient,
    };
    await expect(resolveProviderEntityForSubject(port, tx, ORG, null)).resolves.toBe(PRIMARY);
    expect(providerEntityIdForPatient).not.toHaveBeenCalled();
  });

  it("keeps the primary-entity behaviour when no subject seam is bound", async () => {
    const port: SubjectProviderEntityPort = { primaryProviderEntityId: primary() };
    await expect(resolveProviderEntityForSubject(port, tx, ORG, PATIENT)).resolves.toBe(PRIMARY);
  });
});
