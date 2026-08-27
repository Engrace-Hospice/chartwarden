// F-040 / #100 — the vulnerability-allowlist hygiene gate.
//
// `.trivyignore.yaml` is the only way past the release scan's HIGH/CRITICAL failure, which makes it the
// one place the whole supply-chain control can be disarmed. These pin the five accountability rules and,
// more importantly, the two shapes that would disarm it SILENTLY: a malformed file read as "no
// suppressions", and an expired entry that still reads as an active one.
import { describe, expect, it } from "vitest";
import { checkAllowlist, parseAllowlist } from "../check-vuln-allowlist";

const TODAY = new Date("2026-08-26T00:00:00Z");
const check = (src: string, days?: number) => checkAllowlist(parseAllowlist(src), TODAY, days);
const problems = (src: string, days?: number) =>
  check(src, days)
    .map((v) => v.problem)
    .join(" | ");

const good = `vulnerabilities:
  - id: CVE-2026-1111
    expired_at: 2026-10-01
    statement: >
      Base-image openssl has no patched build for alpine 3.20 yet; upstream tracking issue
      alpine/aports#12345. Removed by the 3.21 base bump already queued.
`;

describe("parseAllowlist", () => {
  it("reads id, expiry and a folded statement", () => {
    const p = parseAllowlist(good);
    expect(p.sawKey).toBe(true);
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]?.id).toBe("CVE-2026-1111");
    expect(p.entries[0]?.expiredAt).toBe("2026-10-01");
    expect(p.entries[0]?.statement).toContain("alpine/aports#12345");
  });

  it("reads an inline `- id:` item form as well as the block form", () => {
    const p = parseAllowlist(
      "vulnerabilities:\n  - id: CVE-2026-2222\n    expired_at: 2026-09-01\n    statement: a statement long enough to count\n",
    );
    expect(p.entries[0]?.id).toBe("CVE-2026-2222");
  });

  it("distinguishes an explicitly empty list from a missing key", () => {
    expect(parseAllowlist("vulnerabilities: []\n")).toMatchObject({
      sawKey: true,
      explicitlyEmpty: true,
      entries: [],
    });
    expect(parseAllowlist("# only a comment\n").sawKey).toBe(false);
  });
});

describe("checkAllowlist", () => {
  it("passes a well-formed, unexpired entry", () => {
    expect(check(good)).toEqual([]);
  });

  it("passes an empty allowlist — nothing suppressed is the healthy state", () => {
    expect(check("vulnerabilities: []\n")).toEqual([]);
  });

  it("FAILS a malformed file rather than reading it as empty", () => {
    // The dangerous one. If a typo'd key parsed as "no suppressions", this gate would report a clean
    // allowlist while Trivy read the file differently — the gate agreeing with the bug.
    expect(problems("vulnerabilties:\n  - id: CVE-1\n")).toContain("malformed");
  });

  it("FAILS an entry that has already expired", () => {
    // Trivy stopped honouring this the day after the date, so the release is already failing — and this
    // row is what makes that look like it should not be. A dead suppression reads exactly like a live one.
    const p = problems(good.replace("2026-10-01", "2026-07-01"));
    expect(p).toContain("expired 56 day(s) ago");
    expect(p).toContain("disguises");
  });

  it("FAILS an expiry beyond the 90-day ceiling", () => {
    expect(problems(good.replace("2026-10-01", "2028-01-01"))).toContain(
      "beyond the 90-day ceiling",
    );
  });

  it("honours a caller-supplied ceiling", () => {
    expect(check(good, 400)).toEqual([]);
    expect(problems(good, 5)).toContain("beyond the 5-day ceiling");
  });

  it("FAILS a missing expiry", () => {
    const src =
      "vulnerabilities:\n  - id: CVE-2026-3333\n    statement: a statement long enough to count\n";
    expect(problems(src)).toContain("decision to stop looking");
  });

  it("FAILS a placeholder statement", () => {
    for (const s of ["TODO", "tbd", "n/a", "CVE-2026-1111", "short"]) {
      const src = `vulnerabilities:\n  - id: CVE-2026-1111\n    expired_at: 2026-10-01\n    statement: ${s}\n`;
      expect(problems(src), `statement=${s}`).toContain("empty of content");
    }
  });

  it("FAILS an entry with no id", () => {
    expect(problems("vulnerabilities:\n  - expired_at: 2026-10-01\n")).toContain(
      "names no vulnerability",
    );
  });

  it("FAILS a non-date expiry", () => {
    expect(problems(good.replace("2026-10-01", "next quarter"))).toContain("not a YYYY-MM-DD date");
    expect(problems(good.replace("2026-10-01", "2026-13-45"))).toContain("not a real date");
  });

  it("reports every bad entry, not just the first", () => {
    const src =
      "vulnerabilities:\n" +
      "  - id: CVE-A\n    expired_at: 2026-01-01\n    statement: a statement long enough to count\n" +
      "  - id: CVE-B\n    statement: a statement long enough to count\n";
    expect(check(src)).toHaveLength(2);
  });
});
