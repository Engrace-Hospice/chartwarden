// M32-T02 — the §3.7 AI-provenance erasers' orchestration contract. The Drizzle store is exercised by
// the live RLS suite; what is asserted here is the ORDER, the SPLIT and the ARITHMETIC — the parts a
// destruction certificate depends on and none of which a type checker can see.
import { describe, expect, it } from "vitest";
import { getEraser } from "../src/bootstrap/index";
import {
  AI_INTAKE_CAPABILITY_PREFIX,
  type AiProvenanceEraseStore,
  type AiProvenanceScope,
  createAiProvenanceEraser,
  createInMemoryAiProvenanceEraseStore,
  eraseAiProvenance,
  registerAiProvenanceErasers,
} from "../src/modules/32-ai-platform/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "77777777-0000-0000-0000-000000000001";

describe("M32-T02 §3.7 AI-provenance erasers", () => {
  it("locks the patient BEFORE shredding, so a concurrent invocation write cannot interleave", async () => {
    const calls: string[] = [];
    const store: AiProvenanceEraseStore = {
      async lockPatient() {
        calls.push("lock");
      },
      async shredInvocationPayloads() {
        calls.push("shred");
        return 4;
      },
    };
    const out = await eraseAiProvenance(ORG, PATIENT, "clinical_record", store);
    expect(calls).toEqual(["lock", "shred"]);
    expect(out.counts.invocationsShredded).toBe(4);
  });

  it("counts rows SHREDDED, not rows deleted — the ledger rows survive", async () => {
    // §3.7: `ai_invocation` is the §164.528 evidence, so the erase destroys ciphertext in place. A tally
    // of deletions would be zero for a patient with a hundred shredded invocations, which reads as
    // "nothing to destroy" on the certificate.
    const { store } = createInMemoryAiProvenanceEraseStore({ clinicalRecord: 12 });
    const { erased, counts } = await eraseAiProvenance(ORG, PATIENT, "clinical_record", store);
    expect(erased).toBe(12);
    expect(counts.invocationsShredded).toBe(12);
  });

  it("keeps the two halves DISJOINT, so registering both is not a double-shred", async () => {
    const seen: AiProvenanceScope[] = [];
    const store: AiProvenanceEraseStore = {
      async lockPatient() {},
      async shredInvocationPayloads(_org, _patient, scope) {
        seen.push(scope);
        return scope === "intake" ? 3 : 9;
      },
    };
    const intake = await eraseAiProvenance(ORG, PATIENT, "intake", store);
    const clinical = await eraseAiProvenance(ORG, PATIENT, "clinical_record", store);
    expect(seen).toEqual(["intake", "clinical_record"]);
    // Different counts because the capability filters partition the patient's invocations; neither
    // erase can reach the other's rows.
    expect(intake.erased).toBe(3);
    expect(clinical.erased).toBe(9);
  });

  it("splits on the doclens_ capability prefix — the intake documents vs the chart", () => {
    // The rule §3.7 states in prose, as the value the Drizzle store actually filters on.
    expect(AI_INTAKE_CAPABILITY_PREFIX).toBe("doclens_");
    expect("doclens_extract".startsWith(AI_INTAKE_CAPABILITY_PREFIX)).toBe(true);
    expect("hearthnote_layer2".startsWith(AI_INTAKE_CAPABILITY_PREFIX)).toBe(false);
  });

  it("is idempotent — a second destruction certificate finds the ciphers already destroyed", async () => {
    const { store } = createInMemoryAiProvenanceEraseStore({ clinicalRecord: 7, intake: 2 });
    const first = await eraseAiProvenance(ORG, PATIENT, "clinical_record", store);
    const second = await eraseAiProvenance(ORG, PATIENT, "clinical_record", store);
    expect(first.erased).toBe(7);
    expect(second.erased).toBe(0);
    // The intake half is untouched by the clinical erase and still has its rows to shred.
    const intake = await eraseAiProvenance(ORG, PATIENT, "intake", store);
    expect(intake.erased).toBe(2);
  });

  it("passes the M4 scope's org through and locks on the subject patient", async () => {
    const { store, locked } = createInMemoryAiProvenanceEraseStore({ clinicalRecord: 3 });
    const eraser = createAiProvenanceEraser("clinical_record", store);
    await expect(eraser.erase({ orgId: ORG }, PATIENT)).resolves.toEqual({ erased: 3 });
    expect(locked).toEqual([PATIENT]);
  });

  it("registers BOTH classes over the Phase-0 deny-stubs — neither may stay a silent no-op", async () => {
    const { store } = createInMemoryAiProvenanceEraseStore({ clinicalRecord: 5, intake: 1 });
    registerAiProvenanceErasers({ store });
    await expect(
      getEraser("clinical_record_ai_provenance").erase({ orgId: ORG }, PATIENT),
    ).resolves.toEqual({ erased: 5 });
    await expect(getEraser("intake_ai_provenance").erase({ orgId: ORG }, PATIENT)).resolves.toEqual(
      {
        erased: 1,
      },
    );
  });
});
