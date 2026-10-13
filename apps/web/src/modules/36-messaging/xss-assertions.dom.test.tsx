// Self-test of the shared XSS checker: proves expectInert is not vacuous by feeding it one bad node/attribute per
// class and requiring it to object, and a benign subtree and require it to stay quiet.
import { afterEach, describe, expect, it } from "vitest";
import { XSS_FLAG, expectInert, findViolations, resetXssFlag } from "./xss-assertions";

afterEach(resetXssFlag);

const html = (markup: string): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return host;
};

describe("xss checker: accepts a benign subtree", () => {
  it("passes plain text, a safe link and an aria-hidden icon", () => {
    const host = html(
      '<p>hi</p><a href="https://example.org" target="_blank" rel="noopener noreferrer">x</a><a href="/a/b">y</a><a href="mailto:a@b.c">m</a><svg aria-hidden="true"><path d="M0 0"/></svg>',
    );
    expect(findViolations(host)).toEqual([]);
    expect(() => expectInert(host)).not.toThrow();
  });
});

describe("xss checker: objects to each class of bad node or attribute", () => {
  const forbiddenElements = [
    "<script></script>",
    "<iframe></iframe>",
    "<object></object>",
    "<embed>",
    "<img>",
    "<style></style>",
    "<link>",
    "<meta>",
    "<base>",
    "<math></math>",
    "<template></template>",
    "<audio></audio>",
    "<video></video>",
    "<form></form>",
    "<input>",
    "<button></button>",
    "<noscript></noscript>",
    "<svg><use></use></svg>",
    "<svg><animate></animate></svg>",
    "<svg><set></set></svg>",
  ];
  it.each(forbiddenElements)("flags %s", (markup) => {
    const host = html(markup);
    expect(findViolations(host).length).toBeGreaterThan(0);
    expect(() => expectInert(host)).toThrow();
  });

  const badAttributes = [
    '<div onclick="x()"></div>',
    '<div onmouseover="x()"></div>',
    '<div style="background:url(x)"></div>',
    '<div style="width:expression(1)"></div>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="data:text/html,x">x</a>',
    '<a href="//evil.example/x">protocol-relative</a>',
    '<a href="/\\evil.example/x">backslash after slash</a>',
    '<a href="/&#9;/evil.example/x">tab inside the leading slashes</a>',
    '<a href="&#9;//evil.example/x">leading tab, protocol-relative</a>',
    '<a href="relative/path">no scheme</a>',
    '<a href="http://insecure.example">http</a>',
    '<a xlink:href="javascript:1">x</a>',
    '<p src="javascript:1"></p>',
    '<p action="javascript:1"></p>',
    '<p formaction="javascript:1"></p>',
    '<p srcset="javascript:1 1x"></p>',
    '<p srcset="/ok 1x, //evil.example/x 2x"></p>',
    '<p poster="javascript:1"></p>',
    '<p ping="//evil.example"></p>',
    '<p background="javascript:1"></p>',
    '<a href="https://x.example" target="_blank">no rel</a>',
  ];
  it.each(badAttributes)("flags %s", (markup) => {
    const host = html(markup);
    expect(findViolations(host).length).toBeGreaterThan(0);
    expect(() => expectInert(host)).toThrow();
  });

  it("flags a frame (the HTML parser drops it inside a div, so it is built through the DOM)", () => {
    const host = document.createElement("div");
    host.append(document.createElement("frame"));
    expect(findViolations(host).length).toBeGreaterThan(0);
  });

  it("flags form controls unless the tree is allowed its own", () => {
    const host = html(
      "<form><input><select></select><textarea></textarea><button>go</button></form>",
    );
    expect(findViolations(host).length).toBe(5);
    expect(findViolations(host, { appControls: true })).toEqual([]);
  });

  it("flags the page flag when something did set it", () => {
    (window as unknown as Record<string, unknown>)[XSS_FLAG] = 1;
    expect(findViolations(html("<p>x</p>"))).toEqual(["window.__xss was set"]);
  });
});
