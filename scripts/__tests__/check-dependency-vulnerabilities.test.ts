// scripts/__tests__/check-dependency-vulnerabilities.test.ts — GAP-087.
//
// The classification half of the audit gate, pinned against a REAL `bun audit --json` payload
// (captured from a probe project pinned to lodash@4.17.11 + minimist@1.2.0 — 9 advisories, 2
// critical / 3 high / 4 moderate). Hand-invented fixtures would only prove the parser handles the
// shape the author imagined; this is the shape the tool actually emits, keys, casing and all.
//
// The network half is not tested here — it is the one part that cannot be, which is exactly why the
// script fails hard rather than skipping when the registry is unreachable under CI.
import { describe, expect, it } from "vitest";
import { findingsFrom, ghsaOf } from "../check-dependency-vulnerabilities";

/** Verbatim excerpt of `bun audit --json` output (bun 1.3.5). */
const REPORT = {
  lodash: [
    {
      id: 1106913,
      url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
      title: "Command Injection in lodash",
      severity: "high",
      vulnerable_versions: "<4.17.21",
    },
    {
      id: 1106918,
      url: "https://github.com/advisories/GHSA-jf85-cpcp-j695",
      title: "Prototype Pollution in lodash",
      severity: "critical",
      vulnerable_versions: "<4.17.12",
    },
    {
      id: 1108258,
      url: "https://github.com/advisories/GHSA-29mw-wpgm-hmr9",
      title: "Regular Expression Denial of Service (ReDoS) in lodash",
      severity: "moderate",
      vulnerable_versions: ">=4.0.0 <4.17.21",
    },
  ],
  minimist: [
    {
      id: 1106819,
      url: "https://github.com/advisories/GHSA-xvch-5gv4-984h",
      title: "Prototype Pollution in minimist",
      severity: "critical",
      vulnerable_versions: ">=1.0.0 <1.2.6",
    },
  ],
};

describe("dependency audit classification", () => {
  it("reads `{}` — the clean report — as no findings", () => {
    expect(findingsFrom({}).findings).toEqual([]);
  });

  it("flattens every advisory across every package", () => {
    const { findings } = findingsFrom(REPORT);
    expect(findings).toHaveLength(4);
    expect(new Set(findings.map((f) => f.pkg))).toEqual(new Set(["lodash", "minimist"]));
  });

  it("orders worst-first so the blocking findings lead the output", () => {
    const { findings } = findingsFrom(REPORT);
    expect(findings.map((f) => f.severity)).toEqual(["critical", "critical", "high", "moderate"]);
  });

  it("extracts the GHSA id from the advisory URL", () => {
    expect(ghsaOf("https://github.com/advisories/GHSA-35jh-r3h4-6jhm")).toBe("GHSA-35jh-r3h4-6jhm");
    expect(ghsaOf(undefined)).toBe("");
  });

  it("drops an advisory that has been explicitly accepted, by GHSA id", () => {
    const { findings, acceptedHits } = findingsFrom(REPORT, {
      "GHSA-jf85-cpcp-j695": { reason: "test", reviewed: "2026-08-14" },
    });
    expect(acceptedHits).toEqual(["lodash GHSA-jf85-cpcp-j695"]);
    expect(findings.map((f) => f.ghsa)).not.toContain("GHSA-jf85-cpcp-j695");
    expect(findings).toHaveLength(3);
  });

  it("treats an unrecognized severity as critical rather than dropping it", () => {
    // A gate that silently ignores what it cannot classify is how a vulnerability ships. If the
    // registry ever introduces a new level, it lands on the blocking side of the line, loudly.
    const { findings } = findingsFrom({
      mystery: [
        { url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "apocalyptic" },
      ],
    });
    expect(findings[0]?.severity).toBe("critical");
  });

  it("survives an advisory missing every optional field", () => {
    const { findings } = findingsFrom({ bare: [{}] });
    expect(findings).toEqual([
      {
        pkg: "bare",
        severity: "critical",
        title: "(untitled advisory)",
        url: "",
        ghsa: "",
        versions: "",
      },
    ]);
  });
});
