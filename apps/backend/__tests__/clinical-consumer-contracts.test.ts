import { describe, expect, it } from "vitest";
import type { OutboxConsumerBinding } from "../src/bootstrap/outbox-dispatcher";
import { buildOutboxRoutingPlan } from "../src/bootstrap/outbox-dispatcher";
import { M7_IDG_DECISION_CONSUMER } from "../src/modules/07-care-plan/index";
import { M8_VISIT_PUBLISHED_CONSUMER } from "../src/modules/08-encounters/index";
import { M11_IDG_DECISION_CONSUMER } from "../src/modules/11-orders/index";
import { M12_IDG_DECISION_CONSUMER } from "../src/modules/12-dosespot/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M16_IDG_DECISION_CONSUMER } from "../src/modules/16-bereavement/index";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/index";
import { M18_VISIT_PUBLISHED_CONSUMER } from "../src/modules/18-evv/index";

function binding(
  consumerModule: OutboxConsumerBinding["consumerModule"],
  contract: { readonly eventName: string; readonly consumerName: string },
): OutboxConsumerBinding {
  return {
    consumerModule,
    consumerName: contract.consumerName,
    eventTypes: [contract.eventName],
    async handle() {},
  };
}

describe("clinical outbox consumer contract reconciliation", () => {
  it("fully binds the four M14 decision command consumers", () => {
    const entry = M14_OUTBOX_EVENTS.find(
      (candidate) => String(candidate.eventName) === "idg.decision_recorded",
    );
    if (!entry) throw new Error("missing idg.decision_recorded catalog entry");
    expect(entry.declaredConsumers).toEqual(["m7", "m11", "m12", "m16"]);
    const plan = buildOutboxRoutingPlan(new Map([[entry.eventName, entry]]), [
      binding("m7", M7_IDG_DECISION_CONSUMER),
      binding("m11", M11_IDG_DECISION_CONSUMER),
      binding("m12", M12_IDG_DECISION_CONSUMER),
      binding("m16", M16_IDG_DECISION_CONSUMER),
    ]);
    expect(plan.live.get(entry.eventName)).toHaveLength(4);
    expect(plan.deferred.has(entry.eventName)).toBe(false);
  });

  // F-043/#103 — M20 is the THIRD consumer of a visit publication: `m20.materialize-cadence` is the only
  // producer of `safety_check_in_schedule` rows on the platform. It was absent from `declaredConsumers`
  // while `M20_SUBSCRIBED_EVENT_NAMES` had named the topic since M20-T01, so the relay routed the
  // publication to M8 and M18 and to nobody in M20. This assertion is what keeps the three in step: the
  // list is pinned EXACTLY, so adding a fourth consumer without a binding fails here rather than deferring
  // every publication silently.
  it("fully binds the three M17 visit-publication command consumers", () => {
    const entry = M17_OUTBOX_EVENTS.find(
      (candidate) => candidate.eventName === "m17.visit.published",
    );
    if (!entry) throw new Error("missing m17.visit.published catalog entry");
    expect(entry.declaredConsumers).toEqual(["m8", "m18", "m20"]);
    const plan = buildOutboxRoutingPlan(new Map([[entry.eventName, entry]]), [
      binding("m8", M8_VISIT_PUBLISHED_CONSUMER),
      binding("m18", M18_VISIT_PUBLISHED_CONSUMER),
      binding("m20", {
        eventName: "m17.visit.published",
        consumerName: "m20.materialize-cadence",
      }),
    ]);
    expect(plan.live.get(entry.eventName)).toHaveLength(3);
    expect(plan.deferred.has(entry.eventName)).toBe(false);
  });
});
