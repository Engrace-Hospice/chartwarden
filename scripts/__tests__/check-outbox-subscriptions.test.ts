// F-094 / #205 — rule 6 of the outbox gate: a module's own `M<N>_SUBSCRIBED_EVENT_NAMES` against the
// boot event catalog, both ways.
//
// Six modules publish such a list and each claims, in its own doc comment, that it exists "so an upstream
// rename breaks the build rather than silently orphaning a handler". Nothing compared any of them to
// anything, and the six disagreed with the catalog on 65 facts. These tests pin the three shapes those 65
// were made of, and the fourth that would let one quietly stop being checked.
import { describe, expect, it } from "vitest";
import {
  catalogFactsOf,
  subscriptionDisagreements,
  undeclaredSubscriptions,
} from "../check-outbox-bindings";

const catalog = (entries: Record<string, readonly string[]>) =>
  new Map(Object.entries(entries).map(([k, v]) => [k, { declaredConsumers: v }]));

const none = () => false;

describe("subscribed → catalog", () => {
  it("catches a name no catalog carries — the M2/M36 shape", () => {
    // `m36.notification.delivery_failed`, named by M19, M20 and M26: M36 contributes no event catalog to
    // the boot dispatcher, so the handler behind it can never run under this or any other name.
    const failures = subscriptionDisagreements(
      new Map([["m19", ["m36.notification.delivery_failed"]]]),
      catalogFactsOf(catalog({})),
      none,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("is in no boot catalog entry");
  });

  it("catches a catalogued event that does not route to the subscriber — the #204 wall", () => {
    // This is the failure that mattered: five of M20's six triggers were in its list and in no
    // `declaredConsumers`, so writing the binding could not have delivered anything. The dispatcher's own
    // `assertBindableAgainstCatalog` refuses a binding whose module is not declared.
    const failures = subscriptionDisagreements(
      new Map([["m20", ["m17.visit.published"]]]),
      catalogFactsOf(catalog({ "m17.visit.published": ["m8", "m18"] })),
      none,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("does not declare 'm20'");
    expect(failures[0]).toContain("routes this event to nobody");
  });

  it("passes when the catalog declares the subscriber", () => {
    expect(
      subscriptionDisagreements(
        new Map([["m20", ["m17.visit.published"]]]),
        catalogFactsOf(catalog({ "m17.visit.published": ["m8", "m18", "m20"] })),
        none,
      ),
    ).toEqual([]);
  });

  it("catches a name listed twice — a list that repeats itself is not a source of truth", () => {
    const failures = subscriptionDisagreements(
      new Map([["m20", ["m17.visit.published", "m17.visit.published"]]]),
      catalogFactsOf(catalog({ "m17.visit.published": ["m20"] })),
      none,
    );
    expect(failures).toEqual([expect.stringContaining("is listed twice")]);
  });

  it("an exception suppresses the pair and NOTHING else", () => {
    const lists = new Map([["m16", ["m4.legal_hold.applied", "m8.encounter.signed"]]]);
    const facts = catalogFactsOf(
      catalog({ "m4.legal_hold.applied": [], "m8.encounter.signed": [] }),
    );
    const only = (m: string, e: string) => m === "m16" && e === "m4.legal_hold.applied";
    expect(subscriptionDisagreements(lists, facts, only)).toEqual([
      expect.stringContaining("m8.encounter.signed"),
    ]);
  });
});

describe("catalog → subscribed (the direction that found the live one)", () => {
  it("catches a declared consumer the module's own list omits", () => {
    // `idg.decision_recorded` declares m16 and M16 BINDS IT LIVE — and M16's list did not name it. The
    // constant claiming to be the single source of truth for M16's subscriptions omitted M16's only
    // running subscription.
    const failures = undeclaredSubscriptions(
      new Map([["m16", ["m6.bereavement.eligible"]]]),
      catalog({ "idg.decision_recorded": ["m7", "m11", "m12", "m16"] }),
      none,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("idg.decision_recorded");
    expect(failures[0]).toContain("M16_SUBSCRIBED_EVENT_NAMES does not list");
  });

  it("ignores events that declare other modules", () => {
    expect(
      undeclaredSubscriptions(
        new Map([["m16", []]]),
        catalog({ "m17.visit.published": ["m8", "m18", "m20"] }),
        none,
      ),
    ).toEqual([]);
  });

  it("checks only modules that publish a list — a module without one is not silently excused of the other rules", () => {
    // Rules 1-5 still cover m8; rule 6 simply has nothing to compare. The distinction matters because it
    // is why the exception register keys on the PAIR: a module could otherwise delete its list and stop
    // being checked here at all.
    expect(
      undeclaredSubscriptions(new Map(), catalog({ "m17.visit.published": ["m8"] }), none),
    ).toEqual([]);
  });
});
