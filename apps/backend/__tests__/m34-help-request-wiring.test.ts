// Help-request text is accepted independently of M34's optional provisioning gateway and object storage. Pin its retention worker
// outside that optional integration guard so a deployment cannot accept text while silently disabling expiry and deletion.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");

describe("the composition root keeps the M34 help-request retention worker live", () => {
  it("registers it under the platform database guard, outside the optional provisioning block", () => {
    const optionalStart = index.indexOf(
      "if (m34ProvisionGateway && m34TenantStorage && platformDbHandle)",
    );
    const independentStart = index.indexOf(
      "if (platformDbHandle) {\n      const m34HelpRequestSweep = registerM34HelpRequestSweepWorker",
    );
    expect(optionalStart).toBeGreaterThan(-1);
    expect(independentStart).toBeGreaterThan(optionalStart);
    expect(index.slice(optionalStart, independentStart)).not.toContain(
      "registerM34HelpRequestSweepWorker",
    );
    expect(index.slice(independentStart)).toContain("scheduleM34HelpRequestSweepJob");
  });
});
