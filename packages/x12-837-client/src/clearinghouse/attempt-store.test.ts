import { describe, it } from "vitest";
import { InMemoryAttemptStore } from "./attempt-store";
import { ATTEMPT_STORE_CONTRACT, IN_MEMORY_CONTRACT_IDS } from "./attempt-store-contract";

describe("InMemoryAttemptStore satisfies the attempt-store contract", () => {
  for (const c of ATTEMPT_STORE_CONTRACT) {
    it(`${c.id}: ${c.title}`, async () => {
      await c.run(async () => new InMemoryAttemptStore(), IN_MEMORY_CONTRACT_IDS);
    });
  }
});
