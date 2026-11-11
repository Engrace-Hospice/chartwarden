import { describe, expect, it } from "vitest";
import { createLinkDelivery } from "../src/modules/02-identity/link-delivery";

const msg = {
  kind: "funeral_home" as const,
  organizationId: "o1",
  email: "f@x.test",
  token: "tok",
  expiresAt: new Date(0),
};

describe("createLinkDelivery", () => {
  it("refuses a provider whose wall-time can outlive the death-notification reconciliation lease", () => {
    expect(() =>
      createLinkDelivery({
        transport: { send: async () => undefined },
        baseUrl: "https://p.test",
        maxDeliveryDurationMs: 15 * 60_000,
      }),
    ).toThrow(/shorter than/);
  });

  it("sends with only a per-tenant origin (no global baseUrl)", async () => {
    const sent: { text: string }[] = [];
    const d = createLinkDelivery({
      maxDeliveryDurationMs: 40_000,
      transport: { send: async (m) => void sent.push(m) },
      baseUrlFor: async () => "https://acme.chartwarden.com/portal",
    });
    await d.deliver(msg);
    expect(sent[0]?.text).toContain("https://acme.chartwarden.com/portal/funeral/redeem#token=tok");
  });

  it("falls back to the global baseUrl when the per-tenant origin is unknown, and throws when there is neither", async () => {
    const sent: { text: string }[] = [];
    const transport = { send: async (m: { text: string }) => void sent.push(m) };
    await createLinkDelivery({
      maxDeliveryDurationMs: 40_000,
      transport,
      baseUrl: "https://p.test/",
      baseUrlFor: async () => undefined,
    }).deliver(msg);
    expect(sent[0]?.text).toContain("https://p.test/funeral/redeem#token=tok");
    await expect(
      createLinkDelivery({
        transport,
        maxDeliveryDurationMs: 40_000,
        baseUrlFor: async () => undefined,
      }).deliver(msg),
    ).rejects.toThrow(/no landing origin/);
    expect(sent).toHaveLength(1);
  });
});
