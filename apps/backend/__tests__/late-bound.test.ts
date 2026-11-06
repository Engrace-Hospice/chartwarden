// A late-bound dependency fails loudly when it is used or asserted before it is wired, and hands out what was bound after.
import { describe, expect, it } from "vitest";
import { lateBound } from "../src/bootstrap/late-bound";

describe("lateBound", () => {
  it("throws an error that names the missing binding, on get and on assertBound, until it is bound", () => {
    const holder = lateBound<{ run(): string }>("the pricing contract service");
    expect(() => holder.get()).toThrow(/the pricing contract service is not bound/);
    expect(() => holder.assertBound()).toThrow(/the pricing contract service is not bound/);
  });

  it("hands out what was bound, and passes the assertion", () => {
    const holder = lateBound<{ run(): string }>("x");
    holder.bind({ run: () => "ok" });
    expect(holder.get().run()).toBe("ok");
    expect(() => holder.assertBound()).not.toThrow();
  });
});
