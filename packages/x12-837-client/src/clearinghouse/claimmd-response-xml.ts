import { SaxesParser } from "saxes";
import type { ClaimMdRecord } from "./claimmd-wire";

type XmlNode = {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlNode[];
  text: string;
};

const MAX_XML_BYTES = 8 * 1024 * 1024;

function xmlValue(node: XmlNode): unknown {
  const value: Record<string, unknown> = { ...node.attributes };
  for (const child of node.children) {
    const childValue = xmlValue(child);
    const previous = value[child.name];
    value[child.name] =
      previous === undefined
        ? childValue
        : Array.isArray(previous)
          ? [...previous, childValue]
          : [previous, childValue];
  }
  const text = node.text.trim();
  if (text) {
    if (Object.keys(value).length === 0) return text;
    value._text = text;
  }
  return value;
}

/** Parses Claim.MD's documented XML attribute envelope without DTD or external entity support. */
export function parseClaimMdResponseXml(xml: string): ClaimMdRecord | null {
  if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) return null;
  let root: XmlNode | undefined;
  const stack: XmlNode[] = [];
  try {
    const parser = new SaxesParser({ xmlns: false });
    parser.on("doctype", () => {
      throw new Error("DTD is not accepted");
    });
    parser.on("opentag", (tag) => {
      const node: XmlNode = {
        name: tag.name,
        attributes: Object.fromEntries(Object.entries(tag.attributes)),
        children: [],
        text: "",
      };
      const parent = stack.at(-1);
      if (parent) parent.children.push(node);
      else if (root) throw new Error("Multiple XML roots");
      else root = node;
      stack.push(node);
    });
    parser.on("text", (text) => {
      const current = stack.at(-1);
      if (current) current.text += text;
    });
    parser.on("closetag", () => {
      stack.pop();
    });
    parser.on("error", (error) => {
      throw error;
    });
    parser.write(xml).close();
  } catch {
    return null;
  }
  if (!root || root.name !== "result") return null;
  const result = xmlValue(root);
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? { result: result as Record<string, unknown> }
    : null;
}
