// M36 Phase 2 gate: shared "rendered DOM is inert" assertion for the surface-wide XSS corpus tests.
// Importers: xss-surfaces.dom.test.tsx. Data shape: any rendered subtree.
import { expect } from "vitest";

// No payload may have created any of these. (The app's own icons are svg with aria-hidden; they are not listed.)
const FORBIDDEN =
  "script,iframe,object,embed,img,style,link,meta,base,math,template,foreignObject,audio,video";
// (The composer's own <form> is app-owned; a payload-made form would still show up through action/on*.)
const URL_ATTRS = ["href", "src", "action", "formaction", "xlink:href", "srcdoc", "data"];
const SAFE_URL = /^(https:\/\/|mailto:|\/)/;

export const XSS_FLAG = "__xss";

export function resetXssFlag(): void {
  (window as unknown as Record<string, unknown>)[XSS_FLAG] = undefined;
}

/** Fails when the subtree holds anything a payload could have created: an element, an on* handler, a bad URL. */
export function expectInert(root: ParentNode): void {
  expect(
    Array.from(root.querySelectorAll(FORBIDDEN)).map((el) => el.outerHTML.slice(0, 80)),
  ).toEqual([]);
  for (const element of Array.from(root.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      expect(name.startsWith("on")).toBe(false);
      if (name === "style") expect(attribute.value).not.toMatch(/url\(|expression\(|javascript:/i);
      if (URL_ATTRS.includes(name)) expect(attribute.value).toMatch(SAFE_URL);
    }
    if (element.tagName === "A" && element.getAttribute("target") === "_blank")
      expect(element.getAttribute("rel") ?? "").toMatch(/noopener/);
  }
  expect((window as unknown as Record<string, unknown>)[XSS_FLAG]).toBeUndefined();
}
