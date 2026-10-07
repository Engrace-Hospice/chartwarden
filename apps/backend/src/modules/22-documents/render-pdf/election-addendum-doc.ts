// apps/backend/src/modules/22-documents/render-pdf/election-addendum-doc.ts — FY2027. The `election_addendum`
// template: M6's `m6.election_addendum.furnished` / `.acknowledged` render payload → a {@link DocModel}. Pure.
//
// 42 CFR 418.24(c) as amended by CMS-1851-F (effective 2026-10-01), element by element:
//   (c)(1)  the exact title                                   → TITLE
//   (c)(2)  name of the hospice                               → identification facts
//   (c)(3)  individual's name + hospice medical record id     → identification facts
//   (c)(4)  terminal illness and related conditions           → "Your terminal illness and related conditions"
//   (c)(5)  conditions + items/services/drugs not covered     → "Not covered by the hospice" table (or the
//                                                               documented "all related" determination)
//   (c)(6)  clinical explanation + the general statement      → "Why…" + RELATEDNESS_STATEMENT
//   (c)(7)  clinical practice / policy / coverage references  → "References"
//   (c)(8)  (i) purpose, (ii) BFCC-QIO immediate advocacy     → PURPOSE + ADVOCACY (the CMS model's contacts)
//   (c)(9)  name, signature, date + receipt-only statement;   → RECEIPT_ONLY + signature block, or the refusal
//           refusal reason documented on the addendum           reason / (d)(4) exemption notation
//   (c)(10) date furnished                                    → identification facts
// Plus the financial-responsibility line (418.24(b)(5) cost sharing, as the CMS model carries it) and the
// version line (418.24(d)(2) updates).
//
// Signed on paper (M6 v0.9.1): when the acknowledgement came from a scanned paper copy, the acknowledgement block
// says so (with the filing date and a short document reference). When the version's CONTENT is on that paper
// (`contentSource: scanned_paper` — an incomplete WardenX draft signed on paper), the render is a RECORD NOTICE:
// it names the paper copy as the authoritative addendum and does NOT print the (c)(4)–(8) sections, because empty
// sections would misstate the determinations (an empty list would otherwise print "the hospice will cover
// everything"). It is still rendered — rather than skipped — so the furnished / acknowledged events keep one
// M22 document per version and the chart shows where the addendum is.
//
// The language is plain English at the CMS model's reading level. Nothing here reads a field by anything but
// its name, so an unexpected payload field can never reach the page.
import { type Block, type DocModel, latestInstant } from "./doc-model";
import { arr, fmtDate, humanize, rec, str } from "./shared";

/** 418.24(c)(1) — verbatim. */
export const ELECTION_ADDENDUM_DOC_TITLE =
  "Patient Notification of Hospice Non-Covered Items, Services, and Drugs";

/** 418.24(c)(8)(i). */
export const ADDENDUM_PURPOSE =
  "The purpose of this addendum is to notify you (or your representative), in writing, of the conditions, items, services, and drugs the hospice will not be covering because the hospice has determined they are unrelated to your terminal illness and related conditions.";

/** 418.24(c)(6) — the general statement that must accompany the clinical explanation. */
export const RELATEDNESS_STATEMENT =
  "The decision as to whether or not conditions, items, services, and drugs are related is made for each patient. You should share this clinical explanation with other health care providers from whom you seek items, services, or drugs unrelated to your terminal illness and related conditions.";

/** 418.24(c)(8)(ii) — with the BFCC-QIO contacts the CMS model addendum (Aug 2026) prints. */
export const ADDENDUM_ADVOCACY =
  "Right to Immediate Advocacy: if you (or your representative) disagree with the hospice's determination, immediate advocacy is available through the Medicare Beneficiary and Family Centered Care Quality Improvement Organization (BFCC-QIO). Call 1-800-MEDICARE (1-800-633-4227; TTY 1-877-486-2048) or visit https://www.cms.gov/medicare/quality/quality-improvement-organizations/family-centered-care to find your BFCC-QIO.";

/** 418.24(b)(5) / the CMS model's financial-responsibility note. */
export const ADDENDUM_FINANCIAL =
  "Financial responsibility: the hospice will not pay for the items, services, and drugs listed above. Original Medicare, another insurer, or you may be responsible for them, and the usual deductibles and coinsurance may apply.";

/** 418.24(c)(9) — signing acknowledges receipt only. */
export const RECEIPT_ONLY =
  "Signing this addendum (and its updates) is only acknowledgement of receipt of the addendum. It does not mean you (or your representative) agree with the hospice's determinations.";

const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  condition: "Condition",
  item: "Item",
  service: "Service",
  drug: "Drug",
};

const EXEMPTION_LABEL: Readonly<Record<string, string>> = {
  death: "the patient died",
  revocation: "the patient revoked the hospice election",
  discharge: "the patient was discharged from hospice",
};

function diagnosisLines(v: unknown): string[] {
  return arr(v).map((d) => {
    const r = rec(d);
    const code = str(r.icd10Code);
    const desc = str(r.description) ?? "";
    return code ? `${desc} (${code})` : desc;
  });
}

/** The short document reference printed for a scanned copy (the M22 id's first 8 characters). */
export function scannedCopyRef(documentId: unknown): string {
  const id = str(documentId) ?? "";
  return id.slice(0, 8) || "on file";
}

/** "scanned and filed <date> (document <ref>)", or a dateless form when the scan reference is absent. */
function filedPhrase(scan: Readonly<Record<string, unknown>>): string {
  const date = str(scan.filedDate) ? ` ${fmtDate(scan.filedDate)}` : "";
  return `scanned and filed${date} (document ${scannedCopyRef(scan.documentId)})`;
}

function acknowledgementBlocks(
  ack: Readonly<Record<string, unknown>>,
  scan: Readonly<Record<string, unknown>>,
): Block[] {
  const outcome = str(ack.outcome) ?? "pending";
  const onPaper = str(ack.source) === "uploaded";
  const blocks: Block[] = [
    { kind: "heading", level: 1, text: "Acknowledgement of receipt" },
    { kind: "paragraph", text: RECEIPT_ONLY },
  ];
  if (outcome === "signed") {
    const representative = str(ack.signerKind) === "representative";
    blocks.push({
      kind: "facts",
      rows: [
        ["Signed by", representative ? "Beneficiary representative" : "Beneficiary"],
        ...(representative
          ? ([
              ["Representative", str(ack.representativeName) ?? "—"],
              ["Relationship", str(ack.representativeRelationship) ?? "—"],
            ] as const)
          : []),
        ["Date signed", fmtDate(ack.signedDate)],
      ],
    });
    if (onPaper) {
      blocks.push({
        kind: "paragraph",
        text: `Acknowledged on a signed paper copy, ${filedPhrase(scan)}.`,
      });
    }
  } else if (outcome === "refused") {
    blocks.push({
      kind: "banner",
      tone: "warn",
      text: `Not signed. The beneficiary (or representative) refused to sign. Reason: ${str(ack.refusalReason) ?? "not recorded"}`,
    });
    if (onPaper) {
      blocks.push({
        kind: "paragraph",
        text: `The refusal is documented on the paper copy, ${filedPhrase(scan)}.`,
      });
    }
  } else if (outcome === "signature_not_required") {
    const why = EXEMPTION_LABEL[str(ack.exemptionReason) ?? ""] ?? "the patient left hospice care";
    const note = str(ack.exemptionNote);
    blocks.push({
      kind: "banner",
      tone: "info",
      text: `Signature not required: ${why} before the addendum was signed (42 CFR 418.24(d)(4)).${note ? ` ${note}` : ""}`,
    });
  } else {
    blocks.push({
      kind: "facts",
      rows: [
        ["Signature of beneficiary", "______________________________"],
        ["Signature of beneficiary representative", "______________________________"],
        ["Representative's relationship", "______________________________"],
        ["Date signed", "______________"],
      ],
    });
  }
  blocks.push({
    kind: "paragraph",
    muted: true,
    text: "Non-hospice providers and Medicare contractors may view this addendum; they are not required to sign it.",
  });
  return blocks;
}

/** The record notice for a version whose content is the scanned paper copy (no (c)(4)–(8) sections). */
function contentOnPaperDoc(p: Readonly<Record<string, unknown>>, version: number): Block[] {
  const scan = rec(p.scannedCopy);
  return [
    {
      kind: "title",
      text: ELECTION_ADDENDUM_DOC_TITLE,
      subtitle: `Version ${version} — content on the signed paper copy`,
    },
    {
      kind: "facts",
      rows: [
        ["Hospice", str(p.hospiceName) ?? "—"],
        ["Patient name", str(p.patientName) ?? "—"],
        ["Medical record number", str(p.medicalRecordNumber) ?? "—"],
        ["Date furnished", fmtDate(p.furnishedDate)],
        ["Furnished", humanize(p.furnishMethod)],
      ],
    },
    {
      kind: "banner",
      tone: "warn",
      text: `The authoritative content of this addendum — the conditions, items, services, and drugs the hospice will not cover and the reasons (42 CFR 418.24(c)(4)–(8)) — is the signed paper copy furnished on ${fmtDate(p.furnishedDate)}, ${filedPhrase(scan)}. This page records that the addendum was furnished and acknowledged; it does not restate the paper's content.`,
    },
  ];
}

export function buildElectionAddendumDoc(payload: unknown): DocModel {
  const p = rec(payload);
  if (str(p.contentSource) === "scanned_paper") {
    const version = typeof p.versionNumber === "number" ? p.versionNumber : 1;
    return {
      title: ELECTION_ADDENDUM_DOC_TITLE,
      createdAtIso: createdAt(p),
      blocks: [
        ...contentOnPaperDoc(p, version),
        ...acknowledgementBlocks(rec(p.acknowledgement), rec(p.scannedCopy)),
      ],
    };
  }
  const items = arr(p.items).map(rec);
  const version = typeof p.versionNumber === "number" ? p.versionNumber : 1;
  const update = str(p.trigger) === "poc_change";
  const blocks: Block[] = [
    {
      kind: "title",
      text: ELECTION_ADDENDUM_DOC_TITLE,
      subtitle: update
        ? `Updated addendum (version ${version}) — plan of care change`
        : `Version ${version}`,
    },
    {
      kind: "facts",
      rows: [
        ["Hospice", str(p.hospiceName) ?? "—"],
        ["Patient name", str(p.patientName) ?? "—"],
        ["Medical record number", str(p.medicalRecordNumber) ?? "—"],
        ["Date furnished", fmtDate(p.furnishedDate)],
        ["Furnished", humanize(p.furnishMethod)],
      ],
    },
    { kind: "heading", level: 1, text: "Purpose of this addendum" },
    { kind: "paragraph", text: ADDENDUM_PURPOSE },
    { kind: "heading", level: 1, text: "Your terminal illness and related conditions" },
    { kind: "heading", level: 2, text: "Terminal illness" },
  ];
  const terminal = diagnosisLines(p.terminalDiagnoses);
  blocks.push(
    terminal.length > 0
      ? { kind: "bullets", items: terminal }
      : { kind: "paragraph", muted: true, text: "Not recorded." },
  );
  blocks.push({ kind: "heading", level: 2, text: "Related conditions" });
  const related = diagnosisLines(p.relatedDiagnoses);
  blocks.push(
    related.length > 0
      ? { kind: "bullets", items: related }
      : { kind: "paragraph", muted: true, text: "None identified." },
  );

  blocks.push({
    kind: "heading",
    level: 1,
    text: "Conditions, items, services, and drugs the hospice will not cover",
  });
  if (p.noNonCoveredItems === true || items.length === 0) {
    blocks.push({
      kind: "banner",
      tone: "info",
      text: "The hospice has determined that all of your conditions, items, services, and drugs are related to your terminal illness and related conditions. The hospice will cover them.",
    });
  } else {
    blocks.push({
      kind: "table",
      columns: [
        { header: "Type", weight: 1 },
        { header: "Condition, item, service, or drug", weight: 3 },
        { header: "Reason not covered", weight: 4 },
      ],
      rows: items.map((i) => [
        CATEGORY_LABEL[str(i.category) ?? ""] ?? humanize(i.category),
        str(i.description) ?? "",
        str(i.reasonNotCovered) ?? "",
      ]),
      emptyText: "None.",
    });
  }

  blocks.push({ kind: "heading", level: 1, text: "Why these are not covered" });
  const explanation = str(p.clinicalExplanation);
  if (explanation) blocks.push({ kind: "paragraph", text: explanation });
  blocks.push({ kind: "paragraph", text: RELATEDNESS_STATEMENT });
  const refs = str(p.guidelineReferences);
  blocks.push({ kind: "heading", level: 2, text: "References" });
  blocks.push({
    kind: "paragraph",
    muted: !refs,
    text: refs ?? "No specific clinical practice, policy, or coverage guideline was relied on.",
  });

  blocks.push({ kind: "heading", level: 1, text: "Your costs" });
  blocks.push({ kind: "paragraph", text: ADDENDUM_FINANCIAL });
  blocks.push({ kind: "heading", level: 1, text: "Your right to immediate advocacy" });
  blocks.push({ kind: "paragraph", text: ADDENDUM_ADVOCACY });

  blocks.push(...acknowledgementBlocks(rec(p.acknowledgement), rec(p.scannedCopy)));

  return { title: ELECTION_ADDENDUM_DOC_TITLE, createdAtIso: createdAt(p), blocks };
}

function createdAt(p: Readonly<Record<string, unknown>>): string {
  return latestInstant([
    typeof p.furnishedDate === "string" ? `${p.furnishedDate}T12:00:00.000Z` : undefined,
    typeof rec(p.acknowledgement).signedDate === "string"
      ? `${rec(p.acknowledgement).signedDate}T12:00:00.000Z`
      : undefined,
  ]);
}
