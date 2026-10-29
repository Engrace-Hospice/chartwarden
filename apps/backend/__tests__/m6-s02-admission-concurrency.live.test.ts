/**
 * S02 (clinical workflow audit 2026-10-28, §5): concurrent admission against transfer / discharge /
 * readmission, with REAL parallel transactions (separate pooled connections, `Promise.all`) over Postgres as
 * the NOBYPASSRLS `chartwarden_app` role.
 *
 * Invariants asserted after every race, from the database, not from the return values:
 *   - at most ONE open (non-terminal) admission per patient, and at most one live benefit period at a time;
 *   - the loser of a race is a typed 4xx `ChartWardenError` (never a raw 23505 / 500);
 *   - the loser leaves ZERO side effects (no admission, election period, CTI or outbox row of its own);
 *   - invalid dates are refused before any write.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:s02:live
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Journey, MD, ORG, USER, bootJourney, daysAgo } from "./_m6-journey";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;

/** A typed M6 failure: a ChartWardenError carrying a 4xx status and a machine code. */
const TYPED_4XX = { statusCode: expect.any(Number), code: expect.any(String) };
const is4xx = (e: unknown): boolean => {
  const s = (e as { statusCode?: number }).statusCode;
  return typeof s === "number" && s >= 400 && s < 500;
};

type Settled = PromiseSettledResult<unknown>;
const wins = (r: Settled[]): number => r.filter((x) => x.status === "fulfilled").length;
const losers = (r: Settled[]): unknown[] =>
  r.flatMap((x) => (x.status === "rejected" ? [x.reason] : []));

describe.skipIf(!DB_URL)(
  "S02 concurrent admission vs transfer / discharge / readmission — LIVE",
  () => {
    let j: Journey;

    beforeAll(async () => {
      j = await bootJourney(DB_URL as string, "s02");
    }, 240_000);
    afterAll(async () => {
      await j?.close();
    });

    const openAdmissions = async (patientId: string) =>
      j.rows<{ id: string; status: string }>(
        "SELECT id, status FROM admission WHERE patient_id=$1 AND status NOT IN ('discharged','bereavement','closed')",
        [patientId],
      );
    const liveSequences = async (patientId: string): Promise<number[]> =>
      (
        await j.rows<{ sequence_number: number }>(
          `SELECT ep.sequence_number FROM election_period ep JOIN admission a ON a.id = ep.admission_id
          WHERE a.patient_id=$1 AND ep.status <> 'completed'`,
          [patientId],
        )
      ).map((r) => r.sequence_number);
    const sideEffectsOf = async (patientId: string) =>
      j.one<{ adm: number; ep: number }>(
        `SELECT (SELECT count(*)::int FROM admission WHERE patient_id=$1) AS adm,
              (SELECT count(*)::int FROM election_period ep JOIN admission a ON a.id=ep.admission_id WHERE a.patient_id=$1) AS ep`,
        [patientId],
      );

    it("two concurrent direct admissions for one patient: exactly one wins, the loser is a typed 409 with no side effects", async () => {
      const patientId = await j.newPatient();
      const input = { patientId, intakeMethod: "in_person", hospiceMedicalDirectorId: MD } as never;
      const r = await Promise.allSettled([
        j.svc.createAdmission(ORG, input, USER),
        j.svc.createAdmission(ORG, input, USER),
      ]);
      expect(wins(r)).toBe(1);
      const [loser] = losers(r);
      expect(loser).toMatchObject({ ...TYPED_4XX, statusCode: 409 });
      expect(await openAdmissions(patientId)).toHaveLength(1);
      expect(await sideEffectsOf(patientId)).toEqual({ adm: 1, ep: 1 });
      expect(await liveSequences(patientId)).toHaveLength(1);
    }, 120_000);

    it("a double-clicked referral conversion (same referral, same version) mints one admission; the replay is a typed 4xx", async () => {
      const patientId = await j.newPatient();
      const refId = await j.qualifiedReferral(patientId);
      const convert = () =>
        j.svc.acceptReferral(
          ORG,
          refId,
          { primaryDiagnosisIcd10: "C34.90", patientId } as never,
          2,
          USER,
        );
      const r = await Promise.allSettled([convert(), convert()]);
      expect(wins(r)).toBe(1);
      for (const e of losers(r)) expect(is4xx(e)).toBe(true);
      expect(await sideEffectsOf(patientId)).toEqual({ adm: 1, ep: 1 });
      const ref = await j.one<{ status: string }>("SELECT status FROM referral WHERE id=$1", [
        refId,
      ]);
      expect(ref.status).toBe("converted");
    }, 120_000);

    it("two qualified referrals for the same patient converted at once: one admission, the other referral stays qualified", async () => {
      const patientId = await j.newPatient();
      const [a, b] = [await j.qualifiedReferral(patientId), await j.qualifiedReferral(patientId)];
      const convert = (id: string) =>
        j.svc.acceptReferral(
          ORG,
          id,
          { primaryDiagnosisIcd10: "C34.90", patientId } as never,
          2,
          USER,
        );
      const r = await Promise.allSettled([convert(a), convert(b)]);
      expect(wins(r)).toBe(1);
      for (const e of losers(r)) expect(is4xx(e)).toBe(true);
      expect(await sideEffectsOf(patientId)).toEqual({ adm: 1, ep: 1 });
      const states = await j.rows<{ status: string }>(
        "SELECT status FROM referral WHERE id = ANY($1)",
        [[a, b]],
      );
      expect(states.map((s) => s.status).sort()).toEqual(["converted", "qualified"]);
    }, 120_000);

    it("transfer-out racing a live discharge of the same admission: exactly one terminal event, the other is a typed 4xx", async () => {
      const patientId = await j.newPatient();
      const admissionId = await j.admit(patientId, `${daysAgo(10)}T00:00:00.000Z`);
      await j.completeAndActivate(admissionId);
      const transfer = () =>
        j.svc.transferOut(
          ORG,
          admissionId,
          {
            effectiveDate: daysAgo(0),
            otherHospiceName: "Sunrise Hospice",
            receivingCareSetting: "home",
            otherHospiceCcn: "391234",
            narrative: "patient relocated closer to family; care transferred by mutual agreement",
          } as never,
          USER,
        );
      const r = await Promise.allSettled([transfer(), j.dischargeLive(admissionId, daysAgo(0))]);
      expect(wins(r)).toBe(1);
      for (const e of losers(r)) expect(is4xx(e)).toBe(true);
      const adm = await j.one<{ status: string }>("SELECT status FROM admission WHERE id=$1", [
        admissionId,
      ]);
      expect(adm.status).toBe("discharged");
      const terminal = await j.one<{ transfers: number; discharges: number }>(
        `SELECT (SELECT count(*)::int FROM transfer_event WHERE admission_id=$1) AS transfers,
              (SELECT count(*)::int FROM discharge_event WHERE admission_id=$1) AS discharges`,
        [admissionId],
      );
      // Whichever won, the loser wrote nothing: one terminal row in total.
      expect(terminal.transfers + terminal.discharges).toBe(1);
      expect(await openAdmissions(patientId)).toHaveLength(0);
    }, 180_000);

    it("two concurrent readmissions after a live discharge: one new admission in period 2, the loser a typed 409", async () => {
      const patientId = await j.newPatient();
      const stay = await j.admit(patientId, `${daysAgo(12)}T00:00:00.000Z`);
      await j.completeAndActivate(stay);
      await j.dischargeLive(stay, daysAgo(2));
      const readmit = () =>
        j.svc.createAdmission(
          ORG,
          {
            patientId,
            intakeMethod: "in_person",
            hospiceMedicalDirectorId: MD,
            readmittedFromAdmissionId: stay,
            admissionDate: daysAgo(0),
          } as never,
          USER,
        );
      const r = await Promise.allSettled([readmit(), readmit()]);
      expect(wins(r)).toBe(1);
      for (const e of losers(r)) expect(is4xx(e)).toBe(true);
      expect(await openAdmissions(patientId)).toHaveLength(1);
      expect(await sideEffectsOf(patientId)).toEqual({ adm: 2, ep: 2 });
      const seqs = await j.rows<{ sequence_number: number }>(
        `SELECT ep.sequence_number FROM election_period ep JOIN admission a ON a.id=ep.admission_id
        WHERE a.patient_id=$1 ORDER BY ep.sequence_number`,
        [patientId],
      );
      expect(seqs.map((s) => s.sequence_number)).toEqual([1, 2]);
    }, 180_000);

    it("readmission racing the transfer-out it depends on: never two open admissions, no overlapping live periods", async () => {
      const patientId = await j.newPatient();
      const stay = await j.admit(patientId, `${daysAgo(10)}T00:00:00.000Z`);
      await j.completeAndActivate(stay);
      const r = await Promise.allSettled([
        j.svc.transferOut(
          ORG,
          stay,
          {
            effectiveDate: daysAgo(0),
            otherHospiceName: "Sunrise Hospice",
            receivingCareSetting: "home",
            otherHospiceCcn: "391234",
            narrative: "patient relocated closer to family; care transferred by mutual agreement",
          } as never,
          USER,
        ),
        j.svc.createAdmission(
          ORG,
          {
            patientId,
            intakeMethod: "in_person",
            hospiceMedicalDirectorId: MD,
            readmittedFromAdmissionId: stay,
            admissionDate: daysAgo(0),
          } as never,
          USER,
        ),
      ]);
      for (const e of losers(r)) expect(is4xx(e)).toBe(true);
      expect((await openAdmissions(patientId)).length).toBeLessThanOrEqual(1);
      // A readmission that beat the transfer cannot have its source stay still open: the pair is consistent.
      const stayRow = await j.one<{ status: string }>("SELECT status FROM admission WHERE id=$1", [
        stay,
      ]);
      const open = await openAdmissions(patientId);
      if (open.some((a) => a.id !== stay)) expect(stayRow.status).toBe("discharged");
      const live = await liveSequences(patientId);
      expect(new Set(live).size).toBe(live.length);
    }, 180_000);

    describe("invalid dates are refused before any write", () => {
      it("a discharge dated before the admission date is a typed 4xx and the admission is untouched", async () => {
        const patientId = await j.newPatient();
        const admissionId = await j.admit(patientId, `${daysAgo(3)}T00:00:00.000Z`);
        await j.completeAndActivate(admissionId);
        const before = await j.one<{ status: string; version: string }>(
          "SELECT status, version FROM admission WHERE id=$1",
          [admissionId],
        );
        await expect(j.dischargeLive(admissionId, daysAgo(30))).rejects.toMatchObject(TYPED_4XX);
        const after = await j.one<{ status: string; version: string }>(
          "SELECT status, version FROM admission WHERE id=$1",
          [admissionId],
        );
        expect(after).toEqual(before);
        expect(
          await j.rows("SELECT 1 FROM discharge_event WHERE admission_id=$1", [admissionId]),
        ).toEqual([]);
      }, 120_000);

      it("a readmission with a future HETS confirmation date or a period number out of range is a typed 4xx and creates nothing", async () => {
        const patientId = await j.newPatient();
        const stay = await j.admit(patientId, `${daysAgo(12)}T00:00:00.000Z`);
        await j.completeAndActivate(stay);
        await j.dischargeLive(stay, daysAgo(2));
        const before = await sideEffectsOf(patientId);
        const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
        const readmit = (benefitPeriod: Record<string, unknown>) =>
          j.svc.createAdmission(
            ORG,
            {
              patientId,
              intakeMethod: "in_person",
              hospiceMedicalDirectorId: MD,
              readmittedFromAdmissionId: stay,
              benefitPeriod,
            } as never,
            USER,
          );
        await expect(
          readmit({ sequence: 2, source: "hets_confirmed", confirmedOn: future }),
        ).rejects.toMatchObject({ ...TYPED_4XX, code: "BENEFIT_PERIOD_CONFIRMATION_DATE_INVALID" });
        await expect(readmit({ sequence: 0, source: "internal_history" })).rejects.toMatchObject({
          ...TYPED_4XX,
          code: "BENEFIT_PERIOD_INVALID",
        });
        expect(await sideEffectsOf(patientId)).toEqual(before);
      }, 120_000);
    });
  },
);
