/**
 * `arch:vendor-agreements` (CW-BA-01) — the vendor-agreement register is metadata only, every documented
 * PHI integration that needs a BAA has a row, and a row cannot read `signed` without its proof. Red on each
 * planted violation, green on the committed repo.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type CheckInputs,
  type InventoryRow,
  type VendorRegister,
  type VendorRow,
  checkVendorAgreements,
  parseInventory,
} from "../check-vendor-agreements";

const ROOT = join(__dirname, "../..");
const TODAY = new Date("2026-11-26T00:00:00Z");
const SCOPE = "Receives clinical narrative text for drafting; processed under the vendor's terms.";

/** One integration that needs a BAA (claimed by the default row) and one that does not. */
const DEFAULT_INVENTORY: readonly InventoryRow[] = [
  { number: 9, integration: "Xero (accounting)", baaRequired: false },
  { number: 10, integration: "Acme Cloud", baaRequired: true },
  // The row a tenant-held agreement covers: it exists in the table, and no platform row is owed for it here.
  { number: 35, integration: "Claims clearinghouse (tenant account)", baaRequired: false },
];

const row = (over: Partial<VendorRow> = {}): VendorRow => ({
  id: "acme",
  name: "Acme Cloud",
  phi: "receives",
  inventory: [10],
  scope: SCOPE,
  evidence: ["docs/x.md"],
  agreement: { kind: "baa", status: "pending" },
  ...over,
});

const register = (
  vendors: readonly VendorRow[],
  over: Partial<VendorRegister> = {},
): VendorRegister => ({
  owner: "privacy-officer",
  review_by: "2027-01-31",
  vendors,
  ...over,
});

const inputs = (reg: VendorRegister | undefined, over: Partial<CheckInputs> = {}): CheckInputs => ({
  register: reg,
  inventory: DEFAULT_INVENTORY,
  controlIds: new Set(["CW-AC-17", "CW-BA-01"]),
  fileExists: (p) => p === "docs/x.md",
  today: TODAY,
  ...over,
});

const run = (vendors: readonly VendorRow[], over: Partial<CheckInputs> = {}): string[] =>
  checkVendorAgreements(inputs(register(vendors), over));

const SIGNED = {
  kind: "baa",
  status: "signed",
  signedOn: "2026-11-04",
  documentRef: "vault:acme-baa-2026",
  confirmedBy: "privacy-officer",
  confirmedOn: "2026-11-10",
};

describe("vendor register shape", () => {
  it("accepts a complete pending row", () => {
    expect(run([row()])).toEqual([]);
  });

  it("fails an unreadable or empty register instead of reading it as clean", () => {
    expect(checkVendorAgreements(inputs(undefined))).toEqual([
      expect.stringContaining("missing or unreadable"),
    ]);
    expect(checkVendorAgreements(inputs(register([])))).toEqual([
      expect.stringContaining("no `vendors`"),
    ]);
  });

  it("fails a duplicate id, a bad id, a bad phi class and a short scope", () => {
    const v = run([row(), row({ phi: "maybe" }), row({ id: "Bad Id", scope: "short" })]).join("\n");
    expect(v).toMatch(/duplicate id/);
    expect(v).toMatch(/phi `maybe`/);
    expect(v).toMatch(/id must be/);
    expect(v).toMatch(/scope/);
  });

  it("fails a scope or note long enough to be pasted contract text", () => {
    const v = run([row({ scope: "x".repeat(601) }), row({ id: "b", note: "y".repeat(601) })]).join(
      "\n",
    );
    expect(v).toMatch(/scope is 601 characters/);
    expect(v).toMatch(/note is 601 characters/);
  });

  it("fails an email, a URL or a phone number anywhere in the register", () => {
    const v = run([
      row({ note: "ask ops@example.org" }),
      row({ id: "b", scope: `${SCOPE} See https://example.org/terms` }),
      row({ id: "c", note: "call 503-555-0100" }),
    ]);
    expect(v.filter((m) => /contact detail/.test(m))).toHaveLength(3);
  });

  it("requires an owner and a review date that is neither past nor too far out", () => {
    const bad = (over: Partial<VendorRegister>) =>
      checkVendorAgreements(inputs(register([row()], over))).join("\n");
    expect(bad({ owner: undefined })).toMatch(/owner/);
    expect(bad({ review_by: undefined })).toMatch(/review_by/);
    expect(bad({ review_by: "2026-11-01" })).toMatch(/passed 25 day/);
    expect(bad({ review_by: "2027-12-31" })).toMatch(/max 180/);
    expect(bad({ review_by: new Date("2027-01-31T00:00:00Z") })).toBe("");
  });
});

describe("PHI exposure decides what an agreement must be", () => {
  it("a vendor that receives or sits next to PHI needs an agreement kind and a live status", () => {
    const v = run([
      row({ agreement: { kind: "none", status: "pending" } }),
      row({ id: "b", phi: "adjacent", agreement: { kind: "baa", status: "not-required" } }),
    ]).join("\n");
    expect(v).toMatch(/acme: phi `receives` needs agreement.kind baa or trading-partner/);
    expect(v).toMatch(/b: phi `adjacent` cannot be `not-required`/);
  });

  it("a vendor with no PHI is not-required, names no agreement kind, and says why in its scope", () => {
    expect(
      run([
        row({ phi: "none", agreement: { kind: "none", status: "not-required" }, evidence: [] }),
        row({ id: "claims-it" }),
      ]),
    ).toEqual([
      expect.stringContaining(
        "acme: claims inventory row 10, which needs a BAA, but says phi none",
      ),
    ]);
    expect(
      run([
        row({
          phi: "none",
          inventory: [],
          agreement: { kind: "none", status: "not-required" },
          evidence: [],
        }),
        row({ id: "claims-it" }),
      ]),
    ).toEqual([]);
    const v = run([
      row({ phi: "none", inventory: [], agreement: { kind: "baa", status: "pending" } }),
      row({ id: "claims-it" }),
    ]).join("\n");
    expect(v).toMatch(/phi `none` must be agreement.kind none and status not-required/);
  });

  it("a PHI vendor must point at the file that shows the data flow, and the file must exist", () => {
    const v = run([row({ evidence: [] }), row({ id: "b", evidence: ["nope.md"] })]).join("\n");
    expect(v).toMatch(/acme: needs at least one evidence file/);
    expect(v).toMatch(/b: evidence file `nope.md` does not exist/);
  });
});

describe("a row cannot read signed without its proof", () => {
  it("accepts a fully evidenced signed row", () => {
    expect(run([row({ agreement: SIGNED })])).toEqual([]);
  });

  it.each([
    ["signedOn", /signedOn/],
    ["documentRef", /documentRef/],
    ["confirmedBy", /confirmedBy/],
    ["confirmedOn", /confirmedOn/],
  ])("fails a signed row with no %s", (field, message) => {
    const agreement = { ...SIGNED, [field]: undefined };
    expect(run([row({ agreement })]).join("\n")).toMatch(message);
  });

  it("fails a future signing date and a confirmation that predates the signing", () => {
    expect(
      run([
        row({ agreement: { ...SIGNED, signedOn: "2026-12-01", confirmedOn: "2026-12-02" } }),
      ]).join("\n"),
    ).toMatch(/signedOn 2026-12-01 is in the future/);
    expect(run([row({ agreement: { ...SIGNED, confirmedOn: "2026-11-01" } })]).join("\n")).toMatch(
      /confirmedOn 2026-11-01 is before signedOn/,
    );
  });

  it("fails a placeholder vendor name, a URL-shaped document reference and a person as confirmer", () => {
    const v = run([
      row({ name: "TBD provider", agreement: SIGNED }),
      row({ id: "b", agreement: { ...SIGNED, documentRef: "https://drive.example.org/x" } }),
      row({ id: "c", agreement: { ...SIGNED, confirmedBy: "Jane Doe" } }),
    ]).join("\n");
    expect(v).toMatch(/acme: a signed row needs a real vendor name/);
    expect(v).toMatch(/b: agreement.documentRef/);
    expect(v).toMatch(/c: agreement.confirmedBy must be one of privacy-officer, security-officer/);
  });

  it.each([
    "TBD",
    "vault:TBD",
    "drive.google.com/file/d/1AbC",
    "s3://bucket/baa.pdf",
    "mailto:ops@example.org",
    "vault:acme baa",
    "vault:",
    "vault:pending",
    "sftp:files.vendor.example/baa-2026",
    "vault:jane.doe-baa-2026",
    "ssh:203.0.113.7/baa",
  ])("fails the documentRef %s", (documentRef) => {
    expect(run([row({ agreement: { ...SIGNED, documentRef } })]).join("\n")).toMatch(
      /agreement\.documentRef must be an opaque/,
    );
  });

  it("fails a placeholder or person-shaped confirmer even though it looks like a role", () => {
    for (const confirmedBy of ["tbd", "jane-doe", "engineering"])
      expect(run([row({ agreement: { ...SIGNED, confirmedBy } })]).join("\n")).toMatch(
        /agreement\.confirmedBy must be one of/,
      );
    expect(run([row({ agreement: { ...SIGNED, confirmedBy: "security-officer" } })])).toEqual([]);
  });

  it("judges dates by calendar day, whatever time of day the gate runs", () => {
    const evening = new Date("2026-11-26T18:00:00Z");
    expect(
      run([row({ agreement: { ...SIGNED, signedOn: "2026-11-27", confirmedOn: "2026-11-27" } })], {
        today: evening,
      }).join("\n"),
    ).toMatch(/signedOn 2026-11-27 is in the future/);
    expect(
      checkVendorAgreements(
        inputs(register([row()], { review_by: "2027-01-31" }), {
          today: new Date("2027-01-31T15:00:00Z"),
        }),
      ),
    ).toEqual([]);
  });

  it("fails a pending row that already carries signed-only fields", () => {
    const v = run([
      row({
        agreement: {
          kind: "baa",
          status: "pending",
          signedOn: "2026-11-04",
          documentRef: "vault:x",
        },
      }),
    ]).join("\n");
    expect(v).toMatch(/acme: status pending must not carry signedOn, documentRef/);
  });

  it("fails an unknown status or kind", () => {
    const v = run([row({ agreement: { kind: "nda", status: "received" } })]).join("\n");
    expect(v).toMatch(/agreement.kind `nda`/);
    expect(v).toMatch(/agreement.status `received`/);
  });
});

describe("tenant-held agreements are tracked by a control that records them, not by this file", () => {
  const held = (trackedBy?: readonly string[], inventory: readonly number[] = [35]) =>
    row({ id: "held", inventory, agreement: { kind: "baa", status: "tenant-held", trackedBy } });
  const other = row({ id: "other" });

  it("accepts a tenant-held row that names the control recording it and claims only its rows", () => {
    expect(run([held(["CW-AC-17"]), other])).toEqual([]);
  });

  it("fails a tenant-held row with no control, or one the register does not have", () => {
    expect(run([held(), other]).join("\n")).toMatch(/tenant-held needs agreement.trackedBy/);
    expect(run([held(["CW-NOPE-9"]), other]).join("\n")).toMatch(
      /trackedBy `CW-NOPE-9` is not a control/,
    );
  });

  it("fails a control that exists but does not record a tenant's own agreement", () => {
    expect(run([held(["CW-BA-01"]), other]).join("\n")).toMatch(
      /held: agreement.trackedBy `CW-BA-01` does not record a tenant's own agreement \(CW-AC-17 do\)/,
    );
  });

  it("fails the forgery: a tenant-held row that claims integrations its control does not record", () => {
    // One tenant-held row claiming every BAA-required integration would otherwise skip the signed proof.
    const forged = run([held(["CW-AC-17"], [10, 35])]);
    expect(forged.join("\n")).toMatch(/held: tenant-held cannot claim inventory row 10/);
    expect(
      run([
        row({ agreement: { kind: "baa", status: "tenant-held", trackedBy: ["CW-AC-17"] } }),
      ]).join("\n"),
    ).toMatch(/acme: tenant-held cannot claim inventory row 10/);
  });

  it("fails trackedBy on a row that is not tenant-held", () => {
    expect(
      run([row({ agreement: { kind: "baa", status: "pending", trackedBy: ["CW-AC-17"] } })]).join(
        "\n",
      ),
    ).toMatch(/trackedBy only belongs on a tenant-held row/);
  });
});

describe("validity dates are reserved for CW-AC-14 and CW-AC-17", () => {
  it("accepts effectiveOn and expiresOn in order and rejects a malformed or reversed pair", () => {
    const ok = { ...SIGNED, effectiveOn: "2026-11-04", expiresOn: "2027-11-04" };
    expect(run([row({ agreement: ok })])).toEqual([]);
    expect(run([row({ agreement: { ...ok, expiresOn: "2026-01-01" } })]).join("\n")).toMatch(
      /expiresOn 2026-01-01 is not after effectiveOn 2026-11-04/,
    );
    expect(run([row({ agreement: { ...ok, expiresOn: "next year" } })]).join("\n")).toMatch(
      /expiresOn must be a YYYY-MM-DD date/,
    );
  });
});

describe("the integration inventory decides which rows must exist", () => {
  const inventory: readonly InventoryRow[] = [
    { number: 1, integration: "DoseSpot (e-prescribe)", baaRequired: true },
    { number: 9, integration: "Xero (accounting)", baaRequired: false },
  ];

  it("fails a BAA-required integration that no row claims, naming it", () => {
    expect(run([row({ inventory: [] })], { inventory })).toEqual([
      expect.stringContaining(
        "inventory row 1 (DoseSpot (e-prescribe)) needs a BAA but no vendor row claims it",
      ),
    ]);
  });

  it("is satisfied by any row that claims the number, and does not demand rows for no-BAA integrations", () => {
    expect(run([row({ inventory: [1] })], { inventory })).toEqual([]);
  });

  it("fails a claim of an inventory row that does not exist, or a no-PHI row claiming a BAA integration", () => {
    const v = run(
      [
        row({ inventory: [1, 77] }),
        row({
          id: "b",
          phi: "none",
          inventory: [1],
          agreement: { kind: "none", status: "not-required" },
          evidence: [],
        }),
      ],
      { inventory },
    ).join("\n");
    expect(v).toMatch(/acme: inventory row 77 is not in/);
    expect(v).toMatch(/b: claims inventory row 1, which needs a BAA, but says phi none/);
  });

  it("fails when the inventory could not be read, or read with no BAA-required row at all", () => {
    expect(run([row()], { inventory: [] }).join("\n")).toMatch(/inventory .* could not be read/);
    expect(
      run([row()], {
        inventory: [{ number: 9, integration: "Xero", baaRequired: false }],
      }).join("\n"),
    ).toMatch(/read with no BAA-required integration/);
  });
});

describe("the register is a closed schema with no contact detail in it", () => {
  it("fails a key the schema does not name, at every level", () => {
    const v = checkVendorAgreements(
      inputs(
        register(
          [
            row({ agreement: { kind: "baa", status: "pending", terms: "pasted" } as never }),
            { ...row({ id: "b" }), clause: "pasted" } as never,
          ],
          { extra: 1 } as never,
        ),
      ),
    ).join("\n");
    expect(v).toMatch(/register: unknown key `extra`/);
    expect(v).toMatch(/b: unknown key `clause`/);
    expect(v).toMatch(/acme: agreement: unknown key `terms`/);
  });

  it("fails a row that is not a mapping instead of crashing on it", () => {
    expect(checkVendorAgreements(inputs(register([null as never, row()])))).toEqual([
      "(row 1): not a mapping",
    ]);
  });

  it.each([
    "(503)555-0100",
    "5035550100",
    "503 555 0100",
    "+44 20 7946 0958",
    "www.vendor.example/legal",
    "s3://bucket/baa.pdf",
    "mailto:ops@example.org",
    "ftp://host/file",
  ])("flags %s in a note", (note) => {
    expect(run([row({ note })]).join("\n")).toMatch(/contact detail/);
  });

  it("does not flag dates, inventory numbers or migration names", () => {
    expect(
      run([
        row({ note: "Observed 2026-11-04; rows 12, 13; packages/db/migrations/1417_m23_x.sql" }),
      ]),
    ).toEqual([]);
  });

  it("does not flag a version string or an S3 mention that is not a URL", () => {
    expect(run([row({ note: "S3: object mirror; pkg@1.2.3 pinned" })])).toEqual([]);
  });

  it.each(["To be determined", "Pending vendor", "Placeholder Inc"])(
    "fails the placeholder vendor name %s on a signed row",
    (name) => {
      expect(run([row({ name, agreement: SIGNED })]).join("\n")).toMatch(
        /a signed row needs a real vendor name/,
      );
    },
  );

  it.each(["../outside.md", "/etc/passwd", "docs/../x.md"])(
    "fails the evidence path %s that leaves the repository",
    (path) => {
      expect(run([row({ evidence: [path] })]).join("\n")).toMatch(
        /must be a path inside the repository/,
      );
    },
  );

  it("reports a wrong-typed value as a violation instead of crashing", () => {
    const v = run([
      row({ inventory: 10 as never }),
      row({ id: "b", evidence: "docs/x.md" as never }),
    ]);
    expect(v.join("\n")).toMatch(/acme: could not be checked, a value has the wrong type/);
  });

  it("scans the raw file text, comments included", () => {
    const v = checkVendorAgreements(
      inputs(register([row()]), { rawText: "# call 503-555-0100\nvendors: []\n" }),
    );
    expect(v).toEqual([expect.stringContaining("found in the file text, comments included")]);
    expect(checkVendorAgreements(inputs(register([row()]), { rawText: "# a comment\n" }))).toEqual(
      [],
    );
  });

  it("fails a name long enough to hold pasted text", () => {
    expect(run([row({ name: "N".repeat(121) })]).join("\n")).toMatch(/name is 121 characters/);
  });

  it("fails signed-only fields on a tenant-held row too", () => {
    expect(
      run([
        row({
          agreement: {
            kind: "baa",
            status: "tenant-held",
            trackedBy: ["CW-AC-17"],
            documentRef: "vault:x-1",
          },
        }),
      ]).join("\n"),
    ).toMatch(/status tenant-held must not carry documentRef/);
  });
});

describe("parseInventory", () => {
  const doc = [
    "## 1. Intro",
    "|9|NotThis|x|x|x|Yes|x|x|x|x|",
    "## 2. Integration Inventory",
    "|#|Integration|Direction|Protocol|PHI?|BAA req'd|Cred scope|Owning module(s)|Adapter pkg|DR tier|",
    "|--|---|---|---|---|---|---|---|---|---|",
    "|1|DoseSpot|Bidirectional|REST|Yes|Yes|per-tenant|12|`pkg`|Tier 2|",
    "|2|Surescripts|Downstream|—|Yes|via DoseSpot|n/a|12|x|Tier 2|",
    "|16|Anthropic|Outbound|REST|Yes (with ZDR)|**Yes** (BAA + ZDR)|platform|32|x|Tier 3|",
    "|17|Local AI|Internal|HTTP|Yes|N/A (no third party)|platform|32|x|Tier 3|",
    "|34|Filing|None|manual|Yes|n/a today; **Yes (vendor)** later|x|25|x|Tier 3|",
    "## 3. Next",
    "|35|NotThisEither|x|x|x|Yes|x|x|x|x|",
  ].join("\n");

  it("reads only section 2, strips markdown, and reads a cell that also says yes as BAA-required", () => {
    expect(parseInventory(doc)).toEqual([
      { number: 1, integration: "DoseSpot", baaRequired: true },
      { number: 2, integration: "Surescripts", baaRequired: false },
      { number: 16, integration: "Anthropic", baaRequired: true },
      { number: 17, integration: "Local AI", baaRequired: false },
      { number: 34, integration: "Filing", baaRequired: true },
    ]);
  });

  it("returns nothing, so the gate fails closed, when the section is gone or a row is short", () => {
    expect(parseInventory("## 1. Intro\n")).toEqual([]);
    expect(parseInventory("## 2. Integration Inventory\n|1|Short|Yes|\n")).toEqual([]);
  });

  const HEADER = "|#|Integration|Notes|PHI?|BAA req'd|Tier|";
  const SEP = "|--|--|--|--|--|--|";
  const table = (...rows: string[]) =>
    ["## 2. Integration Inventory", HEADER, SEP, ...rows, "## 3. Next"].join("\n");

  it("finds the BAA column by its header name, wherever the columns sit", () => {
    expect(
      parseInventory(table("|1|DoseSpot|a note|Yes|Yes|T2|", "|2|Xero|x|No|No (none)|T4|")),
    ).toEqual([
      { number: 1, integration: "DoseSpot", baaRequired: true },
      { number: 2, integration: "Xero", baaRequired: false },
    ]);
  });

  it("reads an indented row, and fails closed on a shifted, over-wide or non-numeric row", () => {
    expect(parseInventory(table("  |1|DoseSpot|n|Yes|Yes|T2|"))).toHaveLength(1);
    expect(parseInventory(table("|1|DoseSpot|n|Yes (a | b)|Yes|T2|"))).toEqual([]);
    expect(parseInventory(table("|1|DoseSpot|n|Yes|T2|"))).toEqual([]);
    expect(parseInventory(table("|3a|DoseSpot|n|Yes|Yes|T2|"))).toEqual([]);
    expect(parseInventory(table("|—|DoseSpot|n|Yes|Yes|T2|"))).toEqual([]);
  });

  it("fails closed when the table has no header or no BAA column", () => {
    expect(parseInventory("## 2. Integration Inventory\n|1|DoseSpot|Yes|Yes|\n")).toEqual([]);
    expect(
      parseInventory("## 2. Integration Inventory\n|#|Integration|PHI?|\n|--|--|--|\n|1|A|Yes|\n"),
    ).toEqual([]);
  });

  it("treats any BAA wording that is not No, N/A or via as BAA-required", () => {
    const rows = parseInventory(
      table(
        "|1|A|n|x|Conditional (see 6.22)|T|",
        "|2|B|n|x|Per-recipient (varies)|T|",
        "|3|C|n|x||T|",
        "|4|D|n|x|None|T|",
        "|5|E|n|x|No|T|",
        "|6|F|n|x|n/a today; Yes later|T|",
        "|7|G|n|x|N/A (CMS)|T|",
        "|8|H|n|x|via DoseSpot|T|",
        "|9|I|n|x|No, but yes for PHI|T|",
      ),
    );
    expect(rows.map((r) => [r.number, r.baaRequired])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [5, false],
      [6, true],
      [7, false],
      [8, false],
      [9, true],
    ]);
  });

  it("fails closed when a number appears twice", () => {
    expect(parseInventory(table("|1|A|n|x|Yes|T|", "|1|A again|n|x|No|T|"))).toEqual([]);
  });
});

describe("on the committed repo", () => {
  it("passes, and every BAA-required integration in the architecture doc has a row", () => {
    const r = spawnSync("bun", ["run", "scripts/check-vendor-agreements.ts"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.stderr + r.stdout).toContain("OK check-vendor-agreements");
    expect(r.status).toBe(0);
  });
});

describe("the script itself, run in a tree with a bad register", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const runIn = (register: string | undefined) => {
    const cwd = mkdtempSync(join(tmpdir(), "cw-vendor-agreements-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "compliance"));
    if (register !== undefined)
      writeFileSync(join(cwd, "compliance/vendor-agreements.yaml"), register);
    return spawnSync("bun", ["run", join(ROOT, "scripts/check-vendor-agreements.ts")], {
      cwd,
      encoding: "utf8",
    });
  };

  it("fails, never passes, when the register file is missing", () => {
    const r = runIn(undefined);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing or unreadable");
  });

  it("fails, never passes, when the register does not parse", () => {
    const r = runIn("vendors: [unclosed\n  - : :\n");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not parse|missing or unreadable|no `vendors`/);
  });

  it("fails when the register is empty", () => {
    const r = runIn("vendors: []\n");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no `vendors`");
  });
});
