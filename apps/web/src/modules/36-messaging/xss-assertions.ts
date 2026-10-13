// M36 Phase 2 gate: shared "rendered DOM is inert" assertion for the surface-wide XSS corpus tests.
// Importers: xss-surfaces.dom.test.tsx, xss-assertions.dom.test.tsx (the checker's own self-test). Data shape: any rendered subtree.
import { expect } from "vitest";

// No payload may have created any of these. (The app's own icons are svg with aria-hidden; they are not listed, but
// the svg elements that execute or animate are.)
const FORBIDDEN = [
  "script,iframe,frame,frameset,object,embed,img,style,link,meta,base,math,template,foreignObject",
  "audio,video,source,track,noscript,portal",
  "svg use,svg animate,svg animateTransform,svg set,svg image,svg script",
].join(",");
// Form controls are forbidden too, but a whole page legitimately holds the app's own (Send, inbox rows, the composer).
// `appControls: true` skips them for such trees; the page tests then compare control COUNTS against a benign render.
const CONTROLS = "form,input,button";
export const controlCount = (root: ParentNode): number => root.querySelectorAll(CONTROLS).length;
// Attributes that carry a URL (srcset holds a comma list, handled apart).
const URL_ATTRS = [
  "href",
  "src",
  "action",
  "formaction",
  "xlink:href",
  "srcdoc",
  "data",
  "poster",
  "ping",
  "background",
];
// https, mailto, or a same-origin path. A protocol-relative `//host` is a foreign origin, so it is not a path.
const SAFE_URL = /^(https:\/\/|mailto:|\/(?!\/))/;

// ponytail: the `__xss` flag cannot fire under jsdom (no script/handler ever runs), so it is only a belt-and-braces
// check; the structural checks above are what actually prove inertness. Upgrade: a real browser run (Playwright).
export const XSS_FLAG = "__xss";

export function resetXssFlag(): void {
  (window as unknown as Record<string, unknown>)[XSS_FLAG] = undefined;
}

const outline = (el: Element): string => el.outerHTML.slice(0, 80);

/** Everything a payload could have created in the subtree: an element, an on* handler, a bad URL. Empty = inert. */
export function findViolations(
  root: ParentNode,
  options: { appControls?: boolean } = {},
): string[] {
  const selector = options.appControls ? FORBIDDEN : `${FORBIDDEN},${CONTROLS}`;
  const found = Array.from(root.querySelectorAll(selector)).map((el) => `element: ${outline(el)}`);
  for (const element of Array.from(root.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) found.push(`handler ${name}: ${outline(element)}`);
      if (name === "style" && /url\(|expression\(|javascript:/i.test(attribute.value))
        found.push(`style: ${outline(element)}`);
      if (URL_ATTRS.includes(name) && !SAFE_URL.test(attribute.value))
        found.push(`url ${name}: ${outline(element)}`);
      if (name === "srcset") {
        const candidates = attribute.value
          .split(",")
          .map((part) => part.trim().split(/\s+/)[0] ?? "");
        if (candidates.some((url) => !SAFE_URL.test(url)))
          found.push(`srcset: ${outline(element)}`);
      }
    }
    if (
      element.tagName === "A" &&
      element.getAttribute("target") === "_blank" &&
      !/noopener/.test(element.getAttribute("rel") ?? "")
    )
      found.push(`target=_blank without noopener: ${outline(element)}`);
  }
  if ((window as unknown as Record<string, unknown>)[XSS_FLAG] !== undefined)
    found.push("window.__xss was set");
  return found;
}

/** Fails when the subtree holds anything a payload could have created. */
export function expectInert(root: ParentNode, options: { appControls?: boolean } = {}): void {
  expect(findViolations(root, options)).toEqual([]);
}
