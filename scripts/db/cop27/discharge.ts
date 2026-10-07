/**
 * COP27 API seed — leaving hospice: live discharge with the 418.26(b) physician discharge order, for-cause
 * discharge completed by the physician cosign, death discharge with place of death, and revocation.
 *
 * `GET /admissions/:id/discharge-order` is the read model for all of them (reason, status, order, cosigner).
 */
import { type AdmissionHandle, pickSigner, readAdmission, requirePhysician } from "./admission";
import type { SeedContext } from "./context";
import type { SeedCalendar } from "./dates";
import { ApiError, SkipStep, asAnyone, readAsAnyone } from "./http";
import type { ScenarioRun } from "./run";

interface DischargeOrderView {
  discharge: {
    dischargeEventId: string;
    reason: string;
    status: string;
    dischargeDate: string;
    orderRequired: boolean;
    order: { signedByName: string | null; capacity: string; signedAt: string } | null;
    cosigner: { name: string; npi: string; cosignedAt: string | null } | null;
  } | null;
}

export async function readDischarge(
  ctx: SeedContext,
  admissionId: string,
): Promise<DischargeOrderView["discharge"]> {
  const r = await readAsAnyone<DischargeOrderView>("read discharge order", ctx.sessions, (s) =>
    s.client.GET("/api/v1/admissions/{id}/discharge-order", {
      params: { path: { id: admissionId } },
    }),
  );
  return r?.discharge ?? null;
}

const describe = (d: NonNullable<DischargeOrderView["discharge"]>): string =>
  `${d.reason} ${d.status} ${d.dischargeDate}${d.order ? ` order by ${d.order.signedByName ?? "?"} (${d.order.capacity})` : ""}${d.cosigner ? ` cosigned by ${d.cosigner.name}` : ""}`;

/** Live discharge — the patient is no longer terminally ill; the physician order rides with the filing. */
export async function ensureLiveDischarge(
  run: ScenarioRun,
  ctx: SeedContext,
  cal: SeedCalendar,
  adm: AdmissionHandle,
): Promise<void> {
  await run.ensure(
    "live discharge with physician order (418.26(b))",
    () => readDischarge(ctx, adm.id),
    async () => {
      const signer = await pickSigner(ctx, adm.id);
      await asAnyone("discharge (no longer terminal)", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/discharge", {
          params: { path: { id: adm.id } },
          body: {
            reason: "no_longer_terminal",
            dischargeDate: cal.today,
            narrative:
              "DEMO DATA — sustained improvement over two benefit periods: weight stable, PPS up to 60%, " +
              "no hospitalizations; the IDG agrees the prognosis now exceeds six months.",
            dischargeOrder: {
              signedByUserId: signer.userId,
              signedAt: new Date(Date.now() - 120_000).toISOString(),
              capacity: signer.capacity,
              orderText: "Discharge from hospice: no longer terminally ill (42 CFR 418.26(a)(2)).",
              orderReference: "DEMO-ORDER-LIVE",
            },
          },
        }),
      );
      const d = await readDischarge(ctx, adm.id);
      if (!d) throw new Error("no discharge after filing");
      return d;
    },
    describe,
  );
}

/** For-cause discharge: filed by the hospice, completed when the physician cosigns the order. */
export async function ensureForCauseDischarge(
  run: ScenarioRun,
  ctx: SeedContext,
  cal: SeedCalendar,
  adm: AdmissionHandle,
): Promise<void> {
  const filed = await run.ensure(
    "for-cause discharge filed",
    () => readDischarge(ctx, adm.id),
    async () => {
      await asAnyone("discharge (for cause)", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/discharge", {
          params: { path: { id: adm.id } },
          body: {
            reason: "for_cause",
            dischargeDate: cal.today,
            narrative:
              "DEMO DATA — repeated unsafe-environment incidents documented over three weeks; the hospice " +
              "followed its discharge-for-cause policy and notified the patient and the state survey agency.",
            forCauseReason:
              "DEMO DATA — the safety of staff could not be assured after documented threats despite a care " +
              "plan to resolve the problem (42 CFR 418.26(a)(3)).",
          },
        }),
      );
      const d = await readDischarge(ctx, adm.id);
      if (!d) throw new Error("no discharge after filing");
      return d;
    },
    describe,
  );
  await run.ensure(
    "for-cause discharge cosigned by physician",
    async () => {
      const d = await readDischarge(ctx, adm.id);
      return d?.cosigner?.cosignedAt ? d : null;
    },
    async () => {
      const physician = requirePhysician(ctx);
      const signer = await pickSigner(ctx, adm.id);
      const details = await asAnyone<{ version?: number; discharge?: { version?: number } }>(
        "read discharge details",
        ctx.sessions,
        (s) =>
          s.client.GET("/api/v1/admissions/{id}/discharge-details", {
            params: { path: { id: adm.id } },
          }),
      );
      const ifVersion = details.discharge?.version ?? details.version ?? 0;
      const cosign = asAnyone("cosign for-cause discharge", [physician], (s) =>
        s.client.POST("/api/v1/discharges/{id}/cosign-for-cause", {
          params: { path: { id: filed.dischargeEventId } },
          body: {
            cosignerName: signer.name,
            cosignerNpi: ctx.hospiceMd?.npi ?? "1003000001",
            capacity: signer.capacity,
            orderText: "Discharge for cause approved (42 CFR 418.26(a)(3)).",
            orderReference: "DEMO-ORDER-CAUSE",
            ifVersion,
          },
        }),
      );
      await cosign.catch((err: unknown) => {
        if (err instanceof ApiError && err.code === "DISCHARGE_COSIGNER_IS_FILER") {
          throw new SkipStep(
            "the physician account filed this discharge (the admin could not reach the sited admission), and the filer may not cosign; a second medical director, or an admin with provider-entity scope filing it, is needed",
          );
        }
        throw err;
      });
      const d = await readDischarge(ctx, adm.id);
      if (!d) throw new Error("discharge vanished");
      return d;
    },
    describe,
  );
}

/** Death discharge with the place of death (claim status 40/41/42). */
export async function ensureDeathDischarge(
  run: ScenarioRun,
  ctx: SeedContext,
  cal: SeedCalendar,
  adm: AdmissionHandle,
): Promise<void> {
  await run.ensure(
    "death discharge (place of death: home)",
    () => readDischarge(ctx, adm.id),
    async () => {
      await asAnyone("discharge (death)", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/discharge", {
          params: { path: { id: adm.id } },
          body: {
            reason: "death",
            dischargeDate: cal.today,
            narrative:
              "DEMO DATA — died peacefully at home with family present; hospice RN pronounced.",
            ...(ctx.hospiceMd ? { deathCertifierId: ctx.hospiceMd.id } : {}),
            placeOfDeath: "home",
          },
        }),
      );
      const d = await readDischarge(ctx, adm.id);
      if (!d) throw new Error("no discharge after filing");
      return d;
    },
    describe,
  );
}

/** Revocation signed by the patient (seeking curative treatment). */
export async function ensureRevocation(
  run: ScenarioRun,
  ctx: SeedContext,
  cal: SeedCalendar,
  adm: AdmissionHandle,
): Promise<void> {
  await run.ensure(
    "revocation (patient-signed)",
    async () => {
      const a = await readAdmission(ctx, adm.id);
      return a && a.state !== "active" && a.state !== "pending" ? a.state : null;
    },
    async () => {
      await asAnyone("revoke election", ctx.sessions, (s) =>
        s.client.POST("/api/v1/admissions/{id}/revocation", {
          params: { path: { id: adm.id } },
          body: {
            revocationDate: cal.today,
            narrative:
              "DEMO DATA — after an oncology consult the patient chose to pursue a clinical trial; revocation " +
              "counseling completed and the effect on benefits explained.",
            signingPatientName: adm.patient.displayName,
            signingRole: "patient",
            revocationReason: "seek_curative_treatment",
          },
        }),
      );
      return "revoked";
    },
    (state) => `state ${state}`,
  );
}
