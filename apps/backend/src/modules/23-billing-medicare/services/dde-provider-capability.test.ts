import type { DdeAccessProvider } from "@chartwarden/x12-837-client";
import { describe, expect, it } from "vitest";
import { ddeProviderCapability } from "./dde-provider-capability";

const stub = (vendor: DdeAccessProvider["vendor"]) => ({ vendor }) as DdeAccessProvider;

describe("DDE operational capability snapshot", () => {
  it("keeps an absent or unbound provider manual-only", () => {
    expect(ddeProviderCapability(undefined, undefined)).toMatchObject({
      mode: "manual_only",
      submissionItemTypes: [],
      statusCheckItemTypes: [],
    });
    expect(ddeProviderCapability(stub("not_wired"), undefined).mode).toBe("manual_only");
  });

  it("labels the in-memory reference provider as test-only", () => {
    expect(ddeProviderCapability(stub("in_memory"), undefined)).toMatchObject({
      mode: "test_provider",
      label: "Test provider — not connected to Medicare",
      submissionItemTypes: [
        "noe",
        "notr",
        "claim_entry",
        "rtp_correction",
        "adjustment",
        "cancel",
        "adr_response",
      ],
      statusCheckItemTypes: [
        "noe",
        "notr",
        "claim_entry",
        "rtp_correction",
        "adjustment",
        "cancel",
        "adr_response",
      ],
    });
  });

  it("does not enable an unverified Episode Alert adapter", () => {
    expect(ddeProviderCapability(stub("episode_alert"), undefined)).toMatchObject({
      mode: "unverified",
      submissionItemTypes: [],
      statusCheckItemTypes: [],
    });
  });

  it("enables only explicitly code-qualified operations", () => {
    expect(
      ddeProviderCapability(stub("episode_alert"), {
        qualification: "vendor_qualified",
        submissionItemTypes: ["noe"],
        statusCheckItemTypes: [],
      }),
    ).toMatchObject({
      mode: "qualified",
      submissionItemTypes: ["noe"],
      statusCheckItemTypes: [],
    });
  });
});
