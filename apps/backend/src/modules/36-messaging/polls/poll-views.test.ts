import { CHANNEL_KIND_DESCRIPTORS } from "@chartwarden/messaging";
import { POLL_BLOCKED_CHANNEL_KINDS } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import type { MessageBodyCipher } from "../messaging-write-core";
import { pollBlockedChannelKinds } from "./poll-service-db";
import { UNREADABLE_OPTION_LABEL, openOptionLabels } from "./poll-views";

const cipher = (fail: string): MessageBodyCipher =>
  ({
    open: async (_org: string, buf: Buffer) => {
      if (buf.toString() === fail) throw new Error("bad envelope");
      return `label:${buf.toString()}`;
    },
  }) as unknown as MessageBodyCipher;

describe("openOptionLabels", () => {
  it("shows a placeholder and warns with ids only for a label that cannot be decrypted", async () => {
    const warn = vi.fn();
    const labels = await openOptionLabels(
      [
        { id: "o1", pollId: "p1", labelCipher: Buffer.from("a") },
        { id: "o2", pollId: "p1", labelCipher: Buffer.from("broken") },
      ],
      { orgId: "org", channelId: "ch", cipher: cipher("broken"), warn },
    );
    expect(labels.get("o1")).toBe("label:a");
    expect(labels.get("o2")).toBe(UNREADABLE_OPTION_LABEL);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      organizationId: "org",
      channelId: "ch",
      pollId: "p1",
      optionId: "o2",
    });
  });
});

describe("patient-linked channel kinds", () => {
  it("the web composer's blocked kinds equal the server's, derived from CHANNEL_KIND_DESCRIPTORS", () => {
    const derived = Object.values(CHANNEL_KIND_DESCRIPTORS)
      .filter((d) => d.subject === "patient_id" || d.subject === "bereavement_plan_id")
      .map((d) => d.kind);
    expect([...pollBlockedChannelKinds()].sort()).toEqual([...derived].sort());
    expect([...POLL_BLOCKED_CHANNEL_KINDS].sort()).toEqual([...pollBlockedChannelKinds()].sort());
  });
});
