// Catalog-loading parsers on tiny INVENTED fixtures: the X12 CARC/RARC page reader, SNOMED language-refset
// preferred terms, and the RxNorm term-type filter. No real code-system content is embedded.
import { describe, expect, it } from "vitest";
import { parseSource } from "../src/parsers/index";
import { decodeEntities } from "../src/parsers/x12-code-list-html";
import { RXNCONSO, SNOMED_CONCEPT, SNOMED_DESC, SNOMED_REL, bytes, zip } from "./_fixtures";

const row = (cls: string, code: string, body: string, dates: string) =>
  `<tr class="prod-set ${cls}"><td class="code">${code}</td><td class="description">${body}<span class="dates"><br>${dates}</span></td></tr>`;
const page = (rows: string[]) =>
  `<!DOCTYPE html><html><body><table id="codelist"><tbody>\n${rows.join("\n")}\n</tbody></table></body></html>`;

const CARC_PAGE = page([
  row("current", "1", "Invented deductible text", "Start: 01/01/1995"),
  row(
    "current",
    "4",
    "Invented inconsistent-modifier text. Usage: refer to the 835 &amp; REF.",
    "Start: 01/01/1995 | Last Modified: 03/01/2020",
  ),
  row(
    "deactivated",
    "28",
    "Invented redundant coverage text",
    "Start: 01/01/1995 | Stop: 10/16/2003<br><i>Notes: Redundant to codes 26&amp;27.</i>",
  ),
  row("tobe", "A1", "Invented soon-retired text", "Start: 01/01/2000 | Stop: 12/31/2030"),
]);

const RARC_PAGE = page([
  row(
    "current",
    "M4",
    '<span style="color:#cc0000;font-weight:bold;">Alert: </span>Invented last installment.',
    "Start: 01/01/1997 | Last Modified: 04/01/2007<br><span>Notes: (Modified 4/1/07)</span>",
  ),
  row("current", "N940", "Invented missing x-ray&#039;s text.", "Start: 07/01/2026"),
  row("deactivated", "MA01", "Invented old remark", "Start: 01/01/1997 | Stop: 08/01/2004"),
]);

describe("X12 CARC/RARC saved page", () => {
  it("parses current, to-be-deactivated and deactivated rows with dates, notes and entities", () => {
    const parsed = parseSource("carc", bytes(CARC_PAGE));
    const by = Object.fromEntries(parsed.concepts.map((c) => [c.code, c]));
    expect(parsed.concepts.map((c) => c.code)).toEqual(["1", "4", "28", "A1"]);
    expect(by["1"]).toMatchObject({
      display: "Invented deductible text",
      status: "active",
      effectiveDate: "1995-01-01",
      endDate: null,
    });
    expect(by["4"]?.display).toBe(
      "Invented inconsistent-modifier text. Usage: refer to the 835 & REF.",
    );
    expect(by["4"]?.properties).toMatchObject({ lastModified: "2020-03-01" });
    expect(by["28"]).toMatchObject({ status: "retired", endDate: "2003-10-16" });
    expect(by["28"]?.properties).toMatchObject({ notes: "Redundant to codes 26&27." });
    expect(by.A1).toMatchObject({ status: "active", endDate: "2030-12-31" });
  });

  it("parses RARC alphanumeric codes, flags Alerts and decodes numeric entities", () => {
    const parsed = parseSource("rarc", bytes(RARC_PAGE));
    const by = Object.fromEntries(parsed.concepts.map((c) => [c.code, c]));
    expect(by.M4).toMatchObject({
      display: "Alert: Invented last installment.",
      properties: { alert: true, notes: "(Modified 4/1/07)" },
    });
    expect(by.N940?.display).toBe("Invented missing x-ray's text.");
    expect(by.MA01).toMatchObject({ status: "retired", endDate: "2004-08-01" });
  });

  it("accepts the page inside a zip and still prefers the normalized CSV path for a CSV", () => {
    expect(parseSource("carc", zip({ "carc.html": CARC_PAGE })).concepts).toHaveLength(4);
    const csv = parseSource("carc", bytes("code,display\n1,Deductible\n"));
    expect(csv.concepts).toHaveLength(1);
  });

  it("fails loudly on a page with no rows, a bad code or a duplicate code", () => {
    expect(() => parseSource("carc", bytes("<!doctype html><html></html>"))).toThrow(
      /SOURCE_EMPTY/,
    );
    expect(() =>
      parseSource("carc", bytes(page([row("current", "bad code!", "x", "Start: 01/01/1995")]))),
    ).toThrow(/CODE_INVALID/);
    expect(() =>
      parseSource(
        "carc",
        bytes(page([row("current", "1", "a", "Start: 01/01/1995"), row("current", "1", "b", "")])),
      ),
    ).toThrow(/DUPLICATE_CODE/);
  });

  it("rejects an impossible date and an unknown row class", () => {
    expect(() =>
      parseSource("carc", bytes(page([row("current", "1", "a", "Start: 02/31/1995")]))),
    ).toThrow(/DATE_INVALID/);
    expect(() =>
      parseSource("carc", bytes(page([row("weird", "1", "a", "Start: 01/01/1995")]))),
    ).toThrow(/STATUS_INVALID/);
  });

  it("decodeEntities handles named, decimal and hex references and leaves unknown ones alone", () => {
    expect(decodeEntities("a &amp; b &#039; &#x41; &bogus;")).toBe("a & b ' A &bogus;");
  });
});

describe("SNOMED CT language-refset preferred terms", () => {
  const LANG_HEADER =
    "id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tacceptabilityId";
  const US = "900000000000509007";
  const GB = "900000000000508004";
  const PREF = "900000000000548007";
  const ACC = "900000000000549004";
  const files = (lang: string) =>
    zip({
      "Snapshot/Terminology/sct2_Concept_Snapshot_US_20240301.txt": SNOMED_CONCEPT,
      "Snapshot/Terminology/sct2_Description_Snapshot-en_US_20240301.txt": SNOMED_DESC,
      "Snapshot/Terminology/sct2_Relationship_Snapshot_US_20240301.txt": SNOMED_REL,
      "Snapshot/Refset/Language/der2_cRefset_LanguageSnapshot-en_US_20240301.txt": lang,
    });

  it("uses the US-English preferred synonym as display and keeps the FSN in properties", () => {
    const lang = [LANG_HEADER, `a\t20240301\t1\t9\t${US}\t3\t${PREF}`].join("\n");
    const parsed = parseSource("snomed", files(lang));
    const child = parsed.concepts.find((c) => c.code === "900001002");
    expect(child).toMatchObject({
      display: "Synthetic child synonym",
      properties: {
        fullySpecifiedName: "Synthetic child disorder (disorder)",
        semanticTag: "disorder",
      },
    });
    // a concept with no preferred synonym falls back to the FSN without its tag
    expect(parsed.concepts.find((c) => c.code === "900001001")?.display).toBe(
      "Synthetic root finding",
    );
    expect(parsed.warnings.join(" ")).not.toMatch(/Language refset absent/);
  });

  it("ignores acceptable-only and inactive rows, and prefers the US refset over GB", () => {
    const acceptableOnly = [LANG_HEADER, `a\t20240301\t1\t9\t${US}\t3\t${ACC}`].join("\n");
    expect(
      parseSource("snomed", files(acceptableOnly)).concepts.find((c) => c.code === "900001002")
        ?.display,
    ).toBe("Synthetic child disorder");
    const inactive = [LANG_HEADER, `a\t20240301\t0\t9\t${US}\t3\t${PREF}`].join("\n");
    expect(
      parseSource("snomed", files(inactive)).concepts.find((c) => c.code === "900001002")?.display,
    ).toBe("Synthetic child disorder");
    // description 2 is the FSN (wrong type) so only 3 can win; GB-only still works when US is absent
    const gbOnly = [LANG_HEADER, `a\t20240301\t1\t9\t${GB}\t3\t${PREF}`].join("\n");
    expect(
      parseSource("snomed", files(gbOnly)).concepts.find((c) => c.code === "900001002")?.display,
    ).toBe("Synthetic child synonym");
  });

  it("warns, and falls back to the FSN, when no language refset ships", () => {
    const noLang = zip({
      "sct2_Concept_Snapshot_x.txt": SNOMED_CONCEPT,
      "sct2_Description_Snapshot_x.txt": SNOMED_DESC,
    });
    const parsed = parseSource("snomed", noLang);
    expect(parsed.warnings.join(" ")).toMatch(/Language refset absent/);
    expect(parsed.concepts.find((c) => c.code === "900001002")?.display).toBe(
      "Synthetic child disorder",
    );
  });
});

describe("RxNorm term-type filter", () => {
  const atom = (rxcui: string, sab: string, tty: string, str: string, suppress = "N") =>
    `${rxcui}|ENG|P|L|PF|S|Y|A||${rxcui}||${sab}|${tty}|${rxcui}|${str}|0|${suppress}|256|`;

  it("loads ingredient, clinical-drug and brand term types only", () => {
    const lines = [
      atom("1", "RXNORM", "IN", "invented ingredient"),
      atom("2", "RXNORM", "SCD", "invented clinical drug"),
      atom("3", "RXNORM", "SBD", "invented branded drug"),
      atom("4", "RXNORM", "BN", "invented brand"),
      atom("5", "RXNORM", "DF", "Oral Solution"),
      atom("6", "RXNORM", "SCDG", "invented group"),
      atom("7", "RXNORM", "PSN", "invented prescribable name"),
      atom("8", "RXNORM", "SY", "only a synonym"),
      atom("9", "MMSL", "SCD", "other source"),
      atom("10", "RXNORM", "SCD", "suppressed", "O"),
    ].join("\n");
    const parsed = parseSource("rxnorm", bytes(lines));
    expect(parsed.concepts.map((c) => [c.code, c.properties.tty])).toEqual([
      ["1", "IN"],
      ["2", "SCD"],
      ["3", "SBD"],
      ["4", "BN"],
    ]);
  });

  it("labels a multi-atom RXCUI by its best loaded term type, not its synonym", () => {
    const parsed = parseSource("rxnorm", bytes(RXNCONSO));
    expect(parsed.concepts.find((c) => c.code === "200")).toMatchObject({
      display: "morphine 10 MG/ML Oral Solution",
      properties: { tty: "SCD" },
    });
  });

  it("fails when the filter leaves nothing to load", () => {
    expect(() => parseSource("rxnorm", bytes(atom("5", "RXNORM", "DF", "Oral Solution")))).toThrow(
      /SOURCE_EMPTY/,
    );
  });
});
