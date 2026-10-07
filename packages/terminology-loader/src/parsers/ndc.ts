// @wardenx/terminology-loader — NDC parser (FDA National Drug Code Directory; tier 1 public).
//
// Input: the FDA `ndctext.zip` (or its two files): `product.txt` + `package.txt`, tab-delimited with a header.
// One concept per PACKAGE ndc, keyed by the 11-digit HIPAA form (5-4-2, zero-padded, no dashes) because that is
// what DoseSpot and X12 claims carry; the labeller's dashed form is kept in `properties.ndcPackageCode`.
// Rows the FDA flags `NDC_EXCLUDE_FLAG = Y` (unfinished / excluded products) are skipped.
import { iterLines, requireEntry } from "../bytes";
import { LoaderDataError } from "../errors";
import type { ParsedSource, SourceBundle } from "../types";
import { assertCodeShape, concept, finish, parseDate } from "./shared";

const NDC_11 = /^\d{11}$/;

/** Convert a labeller `4-4-2` / `5-3-2` / `5-4-1` package code to the 11-digit form. Throws on any other shape. */
export function toNdc11(packageCode: string): string {
  const parts = packageCode.split("-");
  const [a, b, c] = parts;
  if (parts.length !== 3 || !a || !b || !c || ![a, b, c].every((p) => /^\d+$/.test(p))) {
    throw new LoaderDataError("CODE_INVALID", "ndc: package code is not a dashed 3-segment NDC");
  }
  const shape = `${a.length}-${b.length}-${c.length}`;
  if (!["4-4-2", "5-3-2", "5-4-1"].includes(shape)) {
    throw new LoaderDataError("CODE_INVALID", `ndc: unsupported NDC segment shape ${shape}`);
  }
  return `${a.padStart(5, "0")}${b.padStart(4, "0")}${c.padStart(2, "0")}`;
}

interface Table {
  readonly rows: readonly Record<string, string>[];
}

function readTable(bytes: Uint8Array, required: readonly string[], what: string): Table {
  const iter = iterLines(bytes);
  const first = iter.next();
  if (first.done) throw new LoaderDataError("SOURCE_EMPTY", `${what} is empty`);
  const header = first.value.split("\t").map((h) => h.trim().toUpperCase());
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new LoaderDataError("FORMAT_INVALID", `${what} lacks column(s): ${missing.join(", ")}`);
  }
  const rows: Record<string, string>[] = [];
  for (const line of iter) {
    if (line.trim() === "") continue;
    const cells = line.split("\t");
    rows.push(Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()])));
  }
  return { rows };
}

/** Parse an NDC Directory bundle. */
export function parseNdc(bundle: SourceBundle): ParsedSource {
  const product = readTable(
    bundle.read(requireEntry(bundle, /product\.txt$/i, "product.txt")),
    ["PRODUCTID", "PROPRIETARYNAME", "NONPROPRIETARYNAME", "DOSAGEFORMNAME"],
    "product.txt",
  );
  const pack = readTable(
    bundle.read(requireEntry(bundle, /package\.txt$/i, "package.txt")),
    ["PRODUCTID", "NDCPACKAGECODE", "PACKAGEDESCRIPTION"],
    "package.txt",
  );
  const byProduct = new Map(product.rows.map((p) => [p.PRODUCTID as string, p]));
  const seen = new Set<string>();
  const concepts = [];
  let duplicates = 0;
  for (const [i, p] of pack.rows.entries()) {
    if (p.NDC_EXCLUDE_FLAG === "Y") continue;
    const code = toNdc11(p.NDCPACKAGECODE as string);
    assertCodeShape("ndc", code, NDC_11, `package row ${i + 1}`);
    if (seen.has(code)) {
      duplicates++;
      continue;
    }
    seen.add(code);
    const prod = byProduct.get(p.PRODUCTID as string);
    if (!prod)
      throw new LoaderDataError(
        "REFERENCE_INVALID",
        `ndc: package row ${i + 1} references an unknown product`,
      );
    const brand = prod.PROPRIETARYNAME || prod.NONPROPRIETARYNAME || "";
    const generic =
      prod.NONPROPRIETARYNAME && prod.NONPROPRIETARYNAME !== brand
        ? ` (${prod.NONPROPRIETARYNAME})`
        : "";
    const end = parseDate(p.ENDMARKETINGDATE, `package row ${i + 1} ENDMARKETINGDATE`);
    concepts.push(
      concept(
        code,
        `${brand}${generic} ${prod.DOSAGEFORMNAME ?? ""} — ${p.PACKAGEDESCRIPTION}`
          .replace(/\s+/g, " ")
          .trim(),
        end ? "deprecated" : "active",
        {
          effectiveDate: parseDate(p.STARTMARKETINGDATE, `package row ${i + 1} STARTMARKETINGDATE`),
          endDate: end,
          properties: {
            ndcPackageCode: p.NDCPACKAGECODE,
            productNdc: p.PRODUCTNDC || undefined,
            labelerName: prod.LABELERNAME || undefined,
            dosageForm: prod.DOSAGEFORMNAME || undefined,
            route: prod.ROUTENAME || undefined,
            deaSchedule: prod.DEA_SCHEDULE || undefined,
          },
        },
      ),
    );
  }
  return finish(
    "ndc",
    concepts,
    duplicates > 0 ? [`${duplicates} duplicate package NDC row(s) ignored`] : [],
  );
}
