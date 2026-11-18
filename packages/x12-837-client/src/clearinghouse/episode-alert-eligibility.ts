// Episode Alert's XML schema is not available in the repository or confirmed by the vendor. These names and the root
// used by local fixtures are assumptions only; this parser is not evidence of a valid vendor or hospice response.
import { SaxesParser } from "saxes";
import type { EligibilityOutcome } from "../types";

/** UNVERIFIED element names from the public sample report labels; namespaces are matched by local name. */
const EPISODE_ALERT_ELIGIBILITY_FIELDS = {
  partAStart: ["PartAEligibilityStartDate", "PartAStartDate", "PartAEffectiveDate"],
  partAEnd: ["PartAEligibilityEndDate", "PartAEndDate", "PartATerminationDate"],
} as const;

const MAX_XML_BYTES = 1_000_000;
const MAX_XML_NODES = 10_000;
const MAX_XML_DEPTH = 64;
const MAX_FIELD_CHARS = 32;
const EXPECTED_FIXTURE_ROOT = "eligibilityresponse";

type XmlNode = {
  readonly localName: string;
  readonly attributes: number;
  readonly children: XmlNode[];
  text: string;
};

export type EpisodeAlertEligibilityXmlResult =
  | { readonly kind: "outcome"; readonly outcome: EligibilityOutcome }
  | { readonly kind: "unsupported" }
  | { readonly kind: "malformed" };

/** `20260101`, `2026-01-01` or `01/01/2026` -> `2026-01-01`; null for anything else or an impossible date. */
export function toIsoDate(raw: string): string | null {
  const compact = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(raw);
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  const [y, mo, d] = compact
    ? [compact[1], compact[2], compact[3]]
    : us
      ? [us[3], us[1], us[2]]
      : [];
  if (!y || !mo || !d) return null;
  const iso = `${y}-${mo}-${d}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

function parseXml(xml: string): XmlNode | null {
  if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES || xml.trim().length === 0) return null;

  let root: XmlNode | undefined;
  const stack: XmlNode[] = [];
  let nodes = 0;
  let textChars = 0;
  let outsideText = "";
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on("doctype", () => {
      throw new Error("DTD is not accepted");
    });
    parser.on("opentag", (tag) => {
      nodes += 1;
      if (nodes > MAX_XML_NODES || stack.length + 1 > MAX_XML_DEPTH) {
        throw new Error("XML structural limits exceeded");
      }
      const node: XmlNode = {
        localName: (tag.local || tag.name).toLowerCase(),
        attributes: Object.keys(tag.attributes).length,
        children: [],
        text: "",
      };
      const parent = stack.at(-1);
      if (parent) parent.children.push(node);
      else if (root) throw new Error("multiple XML roots");
      else root = node;
      stack.push(node);
    });
    const appendText = (value: string) => {
      textChars += value.length;
      if (textChars > MAX_XML_BYTES) throw new Error("XML text limit exceeded");
      const current = stack.at(-1);
      if (current) current.text += value;
      else outsideText += value;
      if (outsideText.trim().length > 0) throw new Error("text outside root");
    };
    parser.on("text", appendText);
    parser.on("cdata", appendText);
    parser.on("closetag", () => {
      if (stack.pop() === undefined) throw new Error("unexpected closing tag");
    });
    parser.on("error", (error) => {
      throw error;
    });
    parser.write(xml).close();
  } catch {
    return null;
  }
  return root && stack.length === 0 ? root : null;
}

type Field =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "invalid" };

function readDirectField(root: XmlNode, aliases: readonly string[]): Field {
  const names = new Set(aliases.map((name) => name.toLowerCase()));
  const matches = root.children.filter((child) => names.has(child.localName));
  if (matches.length === 0) return { kind: "absent" };
  if (matches.length !== 1) return { kind: "invalid" };
  const node = matches[0];
  if (!node || node.children.length > 0 || node.attributes !== 0) return { kind: "invalid" };
  const value = node.text.trim();
  return value.length > 0 && value.length <= MAX_FIELD_CHARS
    ? { kind: "value", value }
    : { kind: "invalid" };
}

/**
 * Validates local fixture XML structurally, then evaluates only the guessed Part A dates. A valid XML document with an
 * unrecognized root is unsupported; malformed/contradictory data cannot become active or inactive evidence.
 */
export function parseEpisodeAlertEligibilityXml(
  xml: string,
  serviceDate: string,
): EpisodeAlertEligibilityXmlResult {
  const day = toIsoDate(serviceDate);
  if (day === null) return { kind: "malformed" };
  const root = parseXml(xml);
  if (!root) return { kind: "malformed" };
  if (root.localName !== EXPECTED_FIXTURE_ROOT) return { kind: "unsupported" };

  const startField = readDirectField(root, EPISODE_ALERT_ELIGIBILITY_FIELDS.partAStart);
  const endField = readDirectField(root, EPISODE_ALERT_ELIGIBILITY_FIELDS.partAEnd);
  if (startField.kind === "invalid" || endField.kind === "invalid") return { kind: "malformed" };
  if (startField.kind === "absent") return { kind: "outcome", outcome: "unknown" };

  const start = toIsoDate(startField.value);
  const end = endField.kind === "value" ? toIsoDate(endField.value) : null;
  if (
    start === null ||
    (endField.kind === "value" && end === null) ||
    (end !== null && end < start)
  ) {
    return { kind: "malformed" };
  }
  if (start > day || (end !== null && end < day)) {
    return { kind: "outcome", outcome: "inactive" };
  }
  return { kind: "outcome", outcome: "active" };
}

/** Local fixture helper only; intentionally absent from the package's public barrel. */
export function unverifiedFixtureEligibilityOutcome(
  xml: string,
  serviceDate: string,
): EligibilityOutcome {
  const parsed = parseEpisodeAlertEligibilityXml(xml, serviceDate);
  return parsed.kind === "outcome" ? parsed.outcome : "unknown";
}
