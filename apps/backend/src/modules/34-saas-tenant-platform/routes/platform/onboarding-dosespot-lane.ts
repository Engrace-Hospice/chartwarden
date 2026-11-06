// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-dosespot-lane.ts — the DoseSpot lane of the platform
// onboarding-data service (tenant onboarding slice 4, ADR-0110): an operator registers a tenant's DoseSpot clinic through M12's
// own service, on the TENANT pool under the target org's RLS (the `write()` wrapper supplies the shared onboarding lock, the
// status gate, the go-live void and the audit row; M12's port supplies the rules). Kept beside, not inside, the main service so
// that file stays a reviewable size.
//
// The two vendor calls never hold a transaction: `verify` and a prescriber's `enroll` read first on their own short transaction,
// call DoseSpot with nothing open, and only then enter `write()` to record the result (a tenant that stopped being onboarding in
// between costs one vendor call and is refused, audited).
import { ChartWardenError } from "@chartwarden/types";
import type {
  OnboardingDoseSpotPort,
  OnboardingWriteScope,
} from "../../../../bootstrap/onboarding-dosespot-port";
import {
  ONBOARDING_DATA_AUDIT_EVENTS as EVENTS,
  type OnboardingAuditEvent,
  type OnboardingAuditTarget,
  type OnboardingOperator,
} from "./onboarding-data-audit";
import type { OnboardingDataService, OnboardingFields } from "./onboarding-data-service";

const KIND = "dosespot_clinic_registration";
const PRESCRIBER_KIND = "dosespot_prescriber";

export type DoseSpotLaneMethods = Pick<
  OnboardingDataService,
  | "getDoseSpot"
  | "putDoseSpot"
  | "verifyDoseSpot"
  | "activateDoseSpot"
  | "deactivateDoseSpot"
  | "listDoseSpotPrescribers"
  | "enrollDoseSpotPrescriber"
>;

/** The pieces of the main service this lane reuses; no behaviour of its own is duplicated. */
export interface DoseSpotLaneHelpers {
  readonly port: () => OnboardingDoseSpotPort | undefined;
  readonly targetOf: (orgSlug: string) => Promise<OnboardingAuditTarget>;
  readonly scopeOf: (op: OnboardingOperator, organizationId: string) => OnboardingWriteScope;
  readonly write: <T>(
    op: OnboardingOperator,
    orgSlug: string,
    spec: {
      readonly event: OnboardingAuditEvent;
      readonly resourceKind: string;
      readonly reason: string;
      readonly anyTenantStatus?: boolean;
    },
    run: (
      tx: import("@chartwarden/db").DbClient,
      target: OnboardingAuditTarget,
    ) => Promise<{
      readonly value: T;
      readonly resourceId: string;
      readonly changedFields?: readonly string[];
      readonly detail?: Readonly<Record<string, string | number | boolean>>;
    }>,
  ) => Promise<T>;
  readonly read: <T extends { items: unknown[] }>(
    op: OnboardingOperator,
    orgSlug: string,
    resourceKind: string,
    run: (target: OnboardingAuditTarget) => Promise<T>,
  ) => Promise<T>;
  /** Post-commit, best effort: the advance pass that settles the wizard step. */
  readonly settle: <T>(organizationId: string, result: T) => Promise<T>;
  readonly logError?: (cause: unknown, context: { organizationId: string }) => void;
}

export function buildDoseSpotLane(h: DoseSpotLaneHelpers): DoseSpotLaneMethods {
  /** The bound DoseSpot adapter, or a typed 503 (the other lanes' posture). */
  function port(): OnboardingDoseSpotPort {
    const bound = h.port();
    if (!bound) {
      throw new ChartWardenError(
        "ONBOARDING_DOSESPOT_UNBOUND",
        "the DoseSpot adapter is not bound in this deployment",
        503,
      );
    }
    return bound;
  }

  /** Run what the port said must follow the commit (the lost-service alert); never fails the write. */
  async function afterCommit(
    organizationId: string,
    fn: (() => Promise<void>) | undefined,
  ): Promise<void> {
    if (!fn) return;
    try {
      await fn();
    } catch (cause) {
      h.logError?.(cause, { organizationId });
    }
  }

  return {
    async getDoseSpot(op, orgSlug) {
      const { items } = await h.read(op, orgSlug, KIND, async (t) => ({
        items: [await port().get(h.scopeOf(op, t.organizationId))],
      }));
      return items[0];
    },

    async putDoseSpot(op, orgSlug, fields: OnboardingFields, reason, expectedVersion) {
      let organizationId = "";
      let after: (() => Promise<void>) | undefined;
      const result = await h.write(
        op,
        orgSlug,
        { event: EVENTS.dosespotSet, resourceKind: KIND, reason },
        async (tx, t) => {
          organizationId = t.organizationId;
          const done = await port().put(
            tx,
            h.scopeOf(op, t.organizationId),
            fields,
            expectedVersion,
          );
          after = done.afterCommit;
          return {
            value: { created: done.created === true, view: done.view },
            resourceId: done.resourceId,
            ...(done.changedFields ? { changedFields: done.changedFields } : {}),
          };
        },
      );
      await afterCommit(organizationId, after);
      return h.settle(organizationId, result);
    },

    async verifyDoseSpot(op, orgSlug, reason) {
      // The probe is a network call: it runs with NO transaction open (and no row lock held). Step 1 reads and unseals the
      // candidate credential on its own short read, step 2 is the token mint, step 3 is the audited write transaction, which
      // compare-and-sets on the version step 1 read (409 when the registration moved meanwhile).
      const target = await h.targetOf(orgSlug);
      const scope = h.scopeOf(op, target.organizationId);
      const dosespot = port();
      const plan = await dosespot.prepareVerify(scope);
      const outcome = await dosespot.runProbe(plan);
      let organizationId = "";
      const result = await h.write(
        op,
        orgSlug,
        { event: EVENTS.dosespotVerified, resourceKind: KIND, reason },
        async (tx, t) => {
          organizationId = t.organizationId;
          const done = await dosespot.completeVerify(tx, scope, plan, outcome);
          return {
            value: { config: done.view, test: done.test ?? null },
            resourceId: done.resourceId,
            ...(done.detail ? { detail: done.detail } : {}),
          };
        },
      );
      return h.settle(organizationId, result);
    },

    async activateDoseSpot(op, orgSlug, reason) {
      let organizationId = "";
      const view = await h.write(
        op,
        orgSlug,
        { event: EVENTS.dosespotActivated, resourceKind: KIND, reason },
        async (tx, t) => {
          organizationId = t.organizationId;
          const done = await port().activate(tx, h.scopeOf(op, t.organizationId));
          return { value: done.view, resourceId: done.resourceId };
        },
      );
      return h.settle(organizationId, view);
    },

    async deactivateDoseSpot(op, orgSlug, reason) {
      let organizationId = "";
      let after: (() => Promise<void>) | undefined;
      const view = await h.write(
        op,
        orgSlug,
        { event: EVENTS.dosespotDeactivated, resourceKind: KIND, reason, anyTenantStatus: true },
        async (tx, t) => {
          organizationId = t.organizationId;
          const done = await port().deactivate(tx, h.scopeOf(op, t.organizationId));
          after = done.afterCommit;
          return { value: done.view, resourceId: done.resourceId };
        },
      );
      await afterCommit(organizationId, after);
      return h.settle(organizationId, view);
    },

    async listDoseSpotPrescribers(op, orgSlug) {
      return h.read(op, orgSlug, PRESCRIBER_KIND, async (t) => ({
        items: [...(await port().listPrescribers(h.scopeOf(op, t.organizationId)))],
      }));
    },

    async enrollDoseSpotPrescriber(op, orgSlug, membershipId, fields, reason) {
      const target = await h.targetOf(orgSlug);
      const scope = h.scopeOf(op, target.organizationId);
      const dosespot = port();
      const plan = await dosespot.prepareEnroll(scope, membershipId, fields);
      const vendorId = await dosespot.callVendor(plan);
      return h.write(
        op,
        orgSlug,
        { event: EVENTS.dosespotPrescriberEnrolled, resourceKind: PRESCRIBER_KIND, reason },
        async (tx) => {
          const done = await dosespot.completeEnroll(tx, scope, plan, vendorId);
          return {
            value: done.view,
            resourceId: done.resourceId,
            changedFields: ["dosespotPrescriberId", "npi"],
          };
        },
      );
    },
  };
}
