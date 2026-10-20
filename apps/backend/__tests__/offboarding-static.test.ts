// M36 WP 5.9 (ADR-0084) - what the offboarding code is pinned NOT to do. Files named in other ratchets' allowlists (m36-ack-static, m36-urgent-no-escalation)
// are there on the strength of these promises.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "../src/modules/36-messaging/offboarding");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

describe("workforce offboarding architecture pins", () => {
  it("scans the files it means to", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "binding.ts",
        "steps-access.ts",
        "steps-owned-work.ts",
        "steps-personal.ts",
      ]),
    );
  });

  it("never writes the acknowledgment aggregate, the messages table or the handoff/task tables itself", () => {
    // Reads only: every move goes through the supervisor reassign and the task/handoff sweeps.
    const code = read("steps-owned-work.ts");
    expect(code).not.toMatch(/\.(insert|update|delete)\(/);
  });

  it("never touches M19's roster", () => {
    for (const f of files) {
      expect(read(f), f).not.toMatch(/onCallShift|on_call_shift|on-call-shifts|oncall\/schema/);
    }
  });

  it("deletes only the leaver's own personal rows (scheduled sends, reminders, snoozes) and expires endpoints", () => {
    const deleting = files.filter((f) => /\.delete\(/.test(read(f)));
    expect(deleting).toEqual(["steps-personal.ts"]);
    const code = read("steps-personal.ts");
    expect(code).not.toMatch(/\.delete\((MSG|M|DRAFT|CM)\b/);
    expect(read("steps-access.ts")).not.toMatch(/\.delete\(/);
  });

  it("never carries a message body or a name into an audit row or a report", () => {
    for (const f of files) {
      expect(read(f), f).not.toMatch(/bodyCipher|body_cipher|displayName|display_name/);
    }
  });
});
