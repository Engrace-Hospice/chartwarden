// A late-bound dependency fails loudly when it is used or asserted before it is wired, and hands out what was bound after. An OPTIONAL one
// must be either bound or explicitly declined by the wiring; a path that did neither is the lost wiring a bare `?.` would hide.
import { describe, expect, it } from "vitest";
import { lateBound } from "../src/bootstrap/late-bound";

describe("lateBound (mandatory)", () => {
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

describe("lateBound (optional by configuration)", () => {
  it("find() answers undefined before and after a decline, and the bound value once bound", () => {
    const holder = lateBound<string>("the outbox dispatcher");
    expect(holder.find()).toBeUndefined();
    holder.decline("no platform credential");
    expect(holder.find()).toBeUndefined();
    holder.bind("dispatcher");
    expect(holder.find()).toBe("dispatcher");
  });

  it("a wiring that neither bound nor declined fails the boot assertion, naming the holder", () => {
    const holder = lateBound<string>("the realtime server");
    expect(() => holder.assertResolved()).toThrow(
      /the realtime server was neither bound nor declined/,
    );
  });

  it("a declined holder and a bound holder both pass the boot assertion", () => {
    const declined = lateBound<string>("a");
    declined.decline("opt-in flag is off");
    expect(() => declined.assertResolved()).not.toThrow();
    const bound = lateBound<string>("b");
    bound.bind("x");
    expect(() => bound.assertResolved()).not.toThrow();
  });

  it("a decline never un-binds a bound holder (a later else-branch cannot erase a real wiring)", () => {
    const holder = lateBound<string>("c");
    holder.bind("kept");
    holder.decline("not needed");
    expect(holder.find()).toBe("kept");
  });

  it("get() on an optional holder that declined is still loud (a caller that needs it must say so)", () => {
    const holder = lateBound<string>("d");
    holder.decline("off");
    expect(() => holder.get()).toThrow(/d is not bound/);
  });
});
