// @wardenx/messaging — M36-owned transactional email transport (FB-T14).
//
// M36 owns outbound email (DR/INT #14, Postmark = packages/messaging); the auth `EmailTransport` seam
// binds to `selectTransactionalEmailTransport` at the composition root, so password-reset / magic-link
// links dispatch through M36. These lock the three behaviors: no-op drops, console formats the link
// into the log line, and the boot-time selector honors a real provider / dev-console / prod-no-op.
import { describe, expect, it } from "vitest";
import {
  type OutboundEmail,
  type TransactionalEmailTransport,
  createConsoleTransactionalEmailTransport,
  createNoopTransactionalEmailTransport,
  selectTransactionalEmailTransport,
} from "../src/notification/transactional-email";

const RESET: OutboundEmail = {
  to: "user@example.test",
  subject: "Reset your WardenX password",
  text: "Reset here:\nhttps://app.example/reset-password?token=abc123",
};

describe("M36 transactional email transport (FB-T14)", () => {
  it("no-op transport drops the message without throwing", async () => {
    await expect(createNoopTransactionalEmailTransport().send(RESET)).resolves.toBeUndefined();
  });

  it("console transport logs the recipient, subject, and the link (body)", async () => {
    const lines: string[] = [];
    await createConsoleTransactionalEmailTransport((line) => lines.push(line)).send(RESET);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("user@example.test");
    expect(lines[0]).toContain("Reset your WardenX password");
    expect(lines[0]).toContain("token=abc123"); // the link must reach the transport
  });

  it("selector prefers an injected provider (the real Postmark/SES adapter) over the fallbacks", async () => {
    const captured: OutboundEmail[] = [];
    const provider: TransactionalEmailTransport = {
      async send(email) {
        captured.push(email);
      },
    };
    const transport = selectTransactionalEmailTransport({ isProduction: true, provider });
    await transport.send(RESET);
    expect(captured).toEqual([RESET]); // provider wins even in production
  });

  it("selector logs in dev (no provider) and stays silent in prod (a link in prod logs is a credential)", async () => {
    const devLines: string[] = [];
    await selectTransactionalEmailTransport({ isProduction: false, log: (l) => devLines.push(l) }).send(RESET);
    expect(devLines).toHaveLength(1);
    expect(devLines[0]).toContain("token=abc123");

    const prodLines: string[] = [];
    await selectTransactionalEmailTransport({ isProduction: true, log: (l) => prodLines.push(l) }).send(RESET);
    expect(prodLines).toHaveLength(0); // prod fallback drops the link rather than log a credential
  });
});
