import { describe, expect, it } from "vitest";
import { buildOutboxRoutingPlan } from "../src/bootstrap/outbox-dispatcher";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import { M10_M6_ADMISSION_WORKFLOW_CONSUMER } from "../src/modules/10-hope/index";

describe("M10 M6 workflow consumer contract", () => {
  it("is declared on the M6 activation and discharge catalog entries", () => {
    for (const eventName of M10_M6_ADMISSION_WORKFLOW_CONSUMER.eventTypes) {
      const entry = M6_OUTBOX_EVENTS.find((event) => event.eventName === eventName);
      expect(entry?.declaredConsumers).toContain("m10");
    }
  });

  it("is accepted by the dispatcher routing-plan guard", () => {
    const catalog = new Map(M6_OUTBOX_EVENTS.map((event) => [event.eventName, event]));
    const plan = buildOutboxRoutingPlan(catalog, [
      {
        consumerName: M10_M6_ADMISSION_WORKFLOW_CONSUMER.consumerName,
        consumerModule: "m10",
        eventTypes: M10_M6_ADMISSION_WORKFLOW_CONSUMER.eventTypes,
        async handle() {},
      },
    ]);

    expect(plan.live.get("m6.admission.activated")?.map((b) => b.consumerName)).toContain(
      M10_M6_ADMISSION_WORKFLOW_CONSUMER.consumerName,
    );
    expect(plan.live.get("m6.admission.discharged")?.map((b) => b.consumerName)).toContain(
      M10_M6_ADMISSION_WORKFLOW_CONSUMER.consumerName,
    );
  });
});
