// The lifecycle ledger row records `sideEffectsRecorded`. applyTransition only RUNS some of the machine's effects
// (status event, timestamps, retention window, shred/provision queue, catalog outbox, session cascade, alert); the rest
// (welcome email, M4 requestDestruction, export offer, ...) are named by the machine but have no runner here. The ledger
// must say which is which, instead of claiming an effect ran that was silently dropped.
import { describe, expect, it } from "vitest";
import { partitionEffects } from "../routes/platform/effect-ledger";

describe("partitionEffects", () => {
  it("splits the machine's effects into those applyTransition runs and those it does not", () => {
    const { ran, notRun } = partitionEffects([
      { kind: "status_event" },
      { kind: "set_timestamp" },
      { kind: "set_retention_window" },
      { kind: "outbox" },
      { kind: "alert" },
      { kind: "session_cascade" },
      { kind: "queue_job" },
      { kind: "welcome_email" },
      { kind: "request_destruction" },
      { kind: "offer_export_job" },
    ]);

    expect(ran).toEqual([
      "status_event",
      "set_timestamp",
      "set_retention_window",
      "outbox",
      "alert",
      "session_cascade",
      "queue_job",
    ]);
    expect(notRun).toEqual(["welcome_email", "request_destruction", "offer_export_job"]);
  });

  it("treats an effect kind it has never heard of as not run, so a new machine effect cannot look executed", () => {
    expect(partitionEffects([{ kind: "something_new" }])).toEqual({
      ran: [],
      notRun: ["something_new"],
    });
  });
});
