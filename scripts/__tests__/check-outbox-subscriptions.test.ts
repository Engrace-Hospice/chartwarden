// F-094 / #205 and F-095 / #208 — rule 6 of the outbox gate: a module's own subscription declaration
// against the boot event catalog, both ways.
//
// Nineteen modules publish such a declaration and each claims, in its own doc comment, that it exists "so
// an upstream rename breaks the build rather than silently orphaning a handler". Nothing compared any of
// them to anything. F-094 fixed six; its discovery was a naming convention in one directory, so the other
// thirteen — three more spellings, in each module's own `consumers` directory — went on being compared to
// nothing, and disagreed with the catalog on 132 further facts. These tests pin the shapes those were made
// of, the normalisation that finds them wherever they are written, and the two ways one could quietly stop
// being checked.
import { describe, expect, it } from "vitest";
import {
  catalogFactsOf,
  normaliseSubscriptionValue,
  subscriptionDisagreements,
  undeclaredSubscriptions,
} from "../check-outbox-bindings";

const catalog = (entries: Record<string, readonly string[]>) =>
  new Map(Object.entries(entries).map(([k, v]) => [k, { declaredConsumers: v }]));

/** A module's discovered declaration. `constants` is what the failure message tells the reader to edit. */
const lists = (entries: Record<string, readonly string[]>, constant = "M_LIST") =>
  new Map(
    Object.entries(entries).map(([module, events]) => [
      module,
      { module, constants: [`${module.toUpperCase()}_${constant}`], events },
    ]),
  );

const none = () => false;

describe("subscribed → catalog", () => {
  it("catches a name no catalog carries — the M2/M36 shape", () => {
    // `m36.notification.delivery_failed`, named by M19, M20 and M26: M36 contributes no event catalog to
    // the boot dispatcher, so the handler behind it can never run under this or any other name.
    const failures = subscriptionDisagreements(
      lists({ m19: ["m36.notification.delivery_failed"] }),
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
      lists({ m20: ["m17.visit.published"] }),
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
        lists({ m20: ["m17.visit.published"] }),
        catalogFactsOf(catalog({ "m17.visit.published": ["m8", "m18", "m20"] })),
        none,
      ),
    ).toEqual([]);
  });

  it("catches a name listed twice — a list that repeats itself is not a source of truth", () => {
    const failures = subscriptionDisagreements(
      lists({ m20: ["m17.visit.published", "m17.visit.published"] }),
      catalogFactsOf(catalog({ "m17.visit.published": ["m20"] })),
      none,
    );
    expect(failures).toEqual([expect.stringContaining("is listed twice")]);
  });

  it("an exception suppresses the pair and NOTHING else", () => {
    const m16 = lists({ m16: ["m4.legal_hold.applied", "m8.encounter.signed"] });
    const facts = catalogFactsOf(
      catalog({ "m4.legal_hold.applied": [], "m8.encounter.signed": [] }),
    );
    const only = (m: string, e: string) => m === "m16" && e === "m4.legal_hold.applied";
    expect(subscriptionDisagreements(m16, facts, only)).toEqual([
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
      lists({ m16: ["m6.bereavement.eligible"] }),
      catalog({ "idg.decision_recorded": ["m7", "m11", "m12", "m16"] }),
      none,
      none,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("idg.decision_recorded");
    expect(failures[0]).toContain("M16_M_LIST does not list");
  });

  it("ignores events that declare other modules", () => {
    expect(
      undeclaredSubscriptions(
        lists({ m16: [] }),
        catalog({ "m17.visit.published": ["m8", "m18", "m20"] }),
        none,
        none,
      ),
    ).toEqual([]);
  });

  it("checks only modules that publish a list — a module without one is not silently excused of the other rules", () => {
    // Rules 1-5 still cover m8; rule 6 simply has nothing to compare. The distinction matters because it
    // is why the exception register keys on the PAIR: a module could otherwise delete its list and stop
    // being checked here at all.
    expect(
      undeclaredSubscriptions(new Map(), catalog({ "m17.visit.published": ["m8"] }), none, none),
    ).toEqual([]);
  });
  it("does not re-report a pair the #103 deferral register already holds — one absence, one register", () => {
    // The catalog declares m33 on 255 events it has no binding for, every one of them already registered
    // in `outbox-deferred-consumers.ts` with a reason. Reporting them here too would demand a second
    // reason for the first one, and would put a twin of the deferral register inside the exception
    // register. When the deferral is lifted by binding the event, this rule starts requiring the list to
    // name it — so the list is corrected on the commit that binds, which is the point.
    const args = [
      lists({ m33: [] }),
      catalog({ "m6.admission.activated": ["m33"] }),
      none,
    ] as const;
    expect(undeclaredSubscriptions(...args, () => true)).toEqual([]);
    expect(undeclaredSubscriptions(...args, none)).toHaveLength(1);
  });
});

describe("normalising a subscription declaration (F-095)", () => {
  // The four shapes the corpus actually uses. Three of them were invisible to F-094's discovery, which
  // matched a constant NAME in one directory; this normalises the VALUE, so where and under what name a
  // module writes its declaration stops mattering.
  it("reads the plain tuple — the six M<N>_SUBSCRIBED_EVENT_NAMES", () => {
    expect(normaliseSubscriptionValue(["m6.admission.activated"])).toEqual({
      shape: "string[]",
      events: ["m6.admission.activated"],
    });
  });

  it("reads the event → consumer routing table — M11/M12/M13/M14/M17/M33", () => {
    expect(
      normaliseSubscriptionValue([
        { eventName: "m22.document.rendered", consumerName: "m11.document-backref" },
      ]),
    ).toEqual({ shape: "{ eventName }[]", events: ["m22.document.rendered"] });
  });

  it("reads the frozen topic → effect map — M23/M24/M25/M26/M27/M30", () => {
    expect(
      normaliseSubscriptionValue({ "m23.claim.rejected": [{ kind: "seed_denial_from_277ca" }] }),
    ).toEqual({ shape: "Record<eventName, _>", events: ["m23.claim.rejected"] });
  });

  it("reads a lone subscription object — M33's scheduled delivery, M34's DSAR back-ref", () => {
    expect(
      normaliseSubscriptionValue({
        eventName: "m22.document.rendered",
        consumerName: "m34.m22-document-backref",
      }),
    ).toEqual({ shape: "{ eventName }", events: ["m22.document.rendered"] });
  });

  it("refuses a config object whose keys are not topics, rather than reading its field names as events", () => {
    // The Record arm is what makes a map readable, and it is also the arm that could swallow anything.
    // Requiring every key to look like `<segment>.<segment>` is what keeps `{ enabled, ttlMs }` from
    // being reported as two subscriptions to events named `enabled` and `ttlMs`.
    expect(normaliseSubscriptionValue({ enabled: true, ttlMs: 30_000 })).toBeNull();
  });

  it("refuses a shape it does not recognise — the caller must fail, never skip", () => {
    // A fifth spelling has to break the build on the commit that introduces it. Returning null here and
    // treating it as "nothing to check" at the call site is precisely how thirteen declarations went
    // unexamined for the whole of their lives.
    expect(normaliseSubscriptionValue(true)).toBeNull();
    expect(normaliseSubscriptionValue("m6.admission.activated")).toBeNull();
    expect(normaliseSubscriptionValue([{ topic: "m6.admission.activated" }])).toBeNull();
  });
});
