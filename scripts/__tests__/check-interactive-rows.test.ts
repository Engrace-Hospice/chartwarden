// #32 — the activatable-row gate.
//
// Two rules, and a parser that must not be fooled. The reason the parser is tested this hard: a
// naive `<tr[^>]*>` truncates at the `>` inside `onClick={() => …}`, so a row's real attributes are
// never seen. That mistake reported the repo's true count of keyboard-inoperable rows as 1 when it
// was 5 — the gate would have shipped green over four unreachable drawers.
import { describe, expect, it } from "vitest";
import { inspect, openingTags, run } from "../check-interactive-rows";

const F = "apps/web/src/modules/x/screen.tsx";

describe("the tag scanner", () => {
  it("does not truncate at the arrow inside an onClick handler", () => {
    const src = "<tr key={x} onClick={() => go(a > b)} tabIndex={0} onKeyDown={k}>";
    const [tag] = openingTags(src, "tr");
    expect(tag?.text).toBe(src);
  });

  it("survives nested braces and a } inside a string literal", () => {
    const src = `<tr style={{ a: "}", b: { c: 1 } }} onClick={h}>x</tr>`;
    const [tag] = openingTags(src, "tr");
    expect(tag?.text).toBe(`<tr style={{ a: "}", b: { c: 1 } }} onClick={h}>`);
  });

  it("finds every row, not just the first", () => {
    expect(openingTags("<tr a><tr b><tr c>", "tr")).toHaveLength(3);
  });
});

describe("rule A — a row that acts must be operable", () => {
  it("flags <tr onClick> with no keyboard path", () => {
    const found = inspect(`<tr onClick={() => open(id)} className="x">`, F);
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe("unoperable");
  });

  it("accepts the shared helper", () => {
    expect(inspect("<tr {...interactiveRowProps(() => open(id), sel)}>", F)).toEqual([]);
  });

  it("accepts a hand-written tabIndex + key handler", () => {
    // The two pre-existing correct rows (claim-workbench, reporting-schedules) predate the helper
    // and must not be forced to migrate to keep the gate green.
    expect(
      inspect(
        `<tr tabIndex={0} onClick={h} onKeyDown={(e) => { if (e.key === "Enter") h(); }}>`,
        F,
      ),
    ).toEqual([]);
  });

  it("is not satisfied by tabIndex alone", () => {
    // Focusable but inert: the user can tab onto it and nothing happens.
    expect(inspect("<tr tabIndex={0} onClick={h}>", F)[0]?.rule).toBe("unoperable");
  });

  it("is not satisfied by a key handler alone", () => {
    // A handler on an element that can never receive focus is unreachable.
    expect(inspect("<tr onKeyDown={k} onClick={h}>", F)[0]?.rule).toBe("unoperable");
  });
});

describe("rule B — a row that looks actable must act", () => {
  it("flags the interactive class with no row-level activation", () => {
    const found = inspect(`<tr className="wx-data-row-interactive" style={s}>`, F);
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe("false-affordance");
  });

  it("does not fire when the row is genuinely wired", () => {
    expect(
      inspect(`<tr className="wx-data-row-interactive" {...interactiveRowProps(h, sel)}>`, F),
    ).toEqual([]);
  });

  it("ignores an ordinary row that makes no claim", () => {
    expect(inspect("<tr key={id} style={rowStyle}>", F)).toEqual([]);
  });

  it("reports rule A rather than rule B when a row breaks both", () => {
    // An unoperable row is the more serious finding; reporting both would double-count it.
    const found = inspect(`<tr className="wx-data-row-interactive" onClick={h}>`, F);
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe("unoperable");
  });
});

describe("the repo baseline", () => {
  it("is clean", () => {
    expect(run()).toEqual([]);
  });
});
