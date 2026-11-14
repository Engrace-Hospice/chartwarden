// The facts of step 7 are one list in two voices: an operator reads about "the tenant", the tenant about "your organization". The wording
// is the lane's; the rule (what is met, what is pending) is the model's.
import { describe, expect, it } from "vitest";
import {
  type ClearinghouseSharedView,
  type ClearinghouseWording,
  OPERATOR_WORDING,
  clearinghouseFacts,
  isChosen,
  testOutcomeText,
} from "./clearinghouse-model";

const TENANT_WORDING: ClearinghouseWording = {
  platformEnvDetail: "none is recorded for your organization",
  outsideDetail: "ChartWarden will not send claims for your organization.",
  baaRecordedLabel: "You recorded your vendor BAA",
  baaNotRecordedDetail: "Record the BAA your organization holds with this vendor.",
  baaVerifiedLabel: "ChartWarden verified your vendor BAA",
};

const claimMd: ClearinghouseSharedView = {
  vendor: "claimmd",
  mode: "production",
  status: "draft",
  source: "tenant",
  hasSecret: true,
  verifiableBy: "connection_test",
  verification: null,
  lastTest: { outcome: "credential_rejected", at: "2026-11-04T00:00:00.000Z" },
  baaRequired: true,
  baa: null,
  activatedAt: null,
  version: 3,
  updatedAt: null,
};

describe("clearinghouseFacts wording", () => {
  it("speaks to an operator by default", () => {
    const labels = clearinghouseFacts(claimMd).map((f) => f.label);
    expect(labels).toContain(OPERATOR_WORDING.baaRecordedLabel);
    expect(labels).toContain("An operator verified the vendor BAA");
  });

  it("speaks the lane's words and keeps the same facts in the same states", () => {
    const operator = clearinghouseFacts(claimMd);
    const tenant = clearinghouseFacts(claimMd, TENANT_WORDING);
    expect(tenant.map((f) => [f.key, f.state])).toEqual(operator.map((f) => [f.key, f.state]));
    expect(tenant.find((f) => f.key === "baa-recorded")).toMatchObject({
      label: "You recorded your vendor BAA",
      detail: "Record the BAA your organization holds with this vendor.",
    });
  });

  it("uses the lane's words for billing outside and for the deployment's shared setting", () => {
    const outside = { ...claimMd, vendor: "outside" as const };
    expect(clearinghouseFacts(outside, TENANT_WORDING)[0]?.detail).toBe(
      TENANT_WORDING.outsideDetail,
    );
    const shared = { ...claimMd, source: "platform_env" as const };
    expect(clearinghouseFacts(shared, TENANT_WORDING)[0]?.detail).toBe(
      "none is recorded for your organization",
    );
  });

  it("names the last connection test that did not pass, whatever the voice", () => {
    expect(
      clearinghouseFacts(claimMd, TENANT_WORDING).find((f) => f.key === "connection")?.detail,
    ).toContain(testOutcomeText("credential_rejected"));
    expect(isChosen(claimMd)).toBe(true);
  });
});
