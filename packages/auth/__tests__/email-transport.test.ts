// packages/auth/__tests__/email-transport.test.ts — M2 email delivery seam.
// The transport is a thin port; these lock the two shipped impls (no-op drops, console formats the
// link into the log line). The reset/magic-link callbacks wiring it is exercised end-to-end in the
// auth-live lane (a capturing transport proves the link reaches `send`).
import { describe, expect, it } from "vitest";
import {
  type EmailMessage,
  createConsoleEmailTransport,
  createNoopEmailTransport,
} from "../src/identity/email-transport";

describe("email transport seam", () => {
  it("no-op transport drops the message without throwing", async () => {
    await expect(
      createNoopEmailTransport().send({ to: "a@b.test", subject: "x", text: "y" }),
    ).resolves.toBeUndefined();
  });

  it("console transport logs the recipient, subject, and body (the link)", async () => {
    const lines: string[] = [];
    const transport = createConsoleEmailTransport((line) => lines.push(line));
    const msg: EmailMessage = {
      to: "user@example.test",
      subject: "Reset your ChartWarden password",
      text: "Reset here:\nhttps://app.example/reset-password?token=abc123",
    };
    await transport.send(msg);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("user@example.test");
    expect(lines[0]).toContain("Reset your ChartWarden password");
    expect(lines[0]).toContain("token=abc123"); // the link must reach the transport
  });
});
