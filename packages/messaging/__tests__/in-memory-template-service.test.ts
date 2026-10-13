// M36 WP 2.8 - the in-memory TemplateService (the double the route tests run on). The Drizzle service carries the same
// scenarios live (apps/backend/__tests__/m36-message-templates.live.test.ts); keep the two in step.
import { describe, expect, it } from "vitest";
import { createInMemoryTemplateService } from "../src/templates/in-memory-template-service";
import { lintTemplateText } from "../src/templates/phi-lint";
import { TEMPLATE_CATEGORIES, TEMPLATE_LIMITS } from "../src/templates/template-model";
import { PLATFORM_MESSAGE_TEMPLATES } from "../src/templates/template-seed";

const ORG_A = "org-a";
const ORG_B = "org-b";
const alice = { organizationId: ORG_A, userId: "alice" };
const bob = { organizationId: ORG_A, userId: "bob" };
const carol = { organizationId: ORG_B, userId: "carol" };
const input = {
  title: "Running late",
  body: "I am running a few minutes behind.",
  category: "scheduling" as const,
};

const rejects = async (promise: Promise<unknown>, code: string, status: number): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ code, statusCode: status });
};

describe("platform seed", () => {
  it("every platform template passes the PHI lint and its own floor, in a non-clinical category", () => {
    expect(PLATFORM_MESSAGE_TEMPLATES.length).toBeGreaterThanOrEqual(5);
    for (const t of PLATFORM_MESSAGE_TEMPLATES) {
      expect(lintTemplateText(t.title)).toEqual([]);
      expect(lintTemplateText(t.body)).toEqual([]);
      expect(TEMPLATE_CATEGORIES).toContain(t.category);
      for (const phrase of t.requiredPhrases)
        expect(t.body.toLowerCase()).toContain(phrase.toLowerCase());
    }
    expect(JSON.stringify(PLATFORM_MESSAGE_TEMPLATES)).not.toMatch(/sbar/i);
  });
});

describe("list and visibility", () => {
  it("a new org sees the platform templates only", async () => {
    const svc = createInMemoryTemplateService();
    const items = await svc.list(alice);
    expect(items.map((i) => i.scope)).toEqual(items.map(() => "platform"));
    expect(items).toHaveLength(PLATFORM_MESSAGE_TEMPLATES.length);
  });

  it("a personal reply is visible to its owner only; a shared one to the whole org but no other org", async () => {
    const svc = createInMemoryTemplateService();
    const mine = await svc.createPersonal(alice, input);
    const shared = await svc.createShared(alice, { ...input, title: "Org reply" });
    expect((await svc.list(alice)).map((i) => i.id)).toEqual(
      expect.arrayContaining([mine.id, shared.id]),
    );
    const bobIds = (await svc.list(bob)).map((i) => i.id);
    expect(bobIds).toContain(shared.id);
    expect(bobIds).not.toContain(mine.id);
    const carolIds = (await svc.list(carol)).map((i) => i.id);
    expect(carolIds).not.toContain(shared.id);
    expect(carolIds).not.toContain(mine.id);
    await rejects(svc.get(bob, mine.id), "NOT_FOUND", 404);
    await rejects(svc.get(carol, shared.id), "NOT_FOUND", 404);
  });
});

describe("personal saved replies", () => {
  it("create, update and delete by the owner", async () => {
    const svc = createInMemoryTemplateService();
    const row = await svc.createPersonal(alice, input);
    expect(row).toMatchObject({ scope: "personal", title: "Running late", category: "scheduling" });
    const updated = await svc.updatePersonal(alice, row.id, { body: "Back in ten minutes." });
    expect(updated.body).toBe("Back in ten minutes.");
    await svc.deletePersonal(alice, row.id);
    await rejects(svc.get(alice, row.id), "NOT_FOUND", 404);
  });

  it("another user, another org, a shared id and a platform id all answer 404 on write", async () => {
    const svc = createInMemoryTemplateService();
    const row = await svc.createPersonal(alice, input);
    const shared = await svc.createShared(alice, { ...input, title: "Org reply" });
    const platformId = PLATFORM_MESSAGE_TEMPLATES[0]!.id;
    for (const [actor, id] of [
      [bob, row.id],
      [carol, row.id],
      [alice, shared.id],
      [alice, platformId],
    ] as const) {
      await rejects(svc.updatePersonal(actor, id, { body: "x" }), "NOT_FOUND", 404);
      await rejects(svc.deletePersonal(actor, id), "NOT_FOUND", 404);
    }
  });

  it("refuses PHI on create and on update, without storing it", async () => {
    const svc = createInMemoryTemplateService();
    await rejects(
      svc.createPersonal(alice, { ...input, body: "Call 415-555-0134" }),
      "TEMPLATE_PHI_DETECTED",
      422,
    );
    const row = await svc.createPersonal(alice, input);
    await rejects(
      svc.updatePersonal(alice, row.id, { body: "SSN 123-45-6789" }),
      "TEMPLATE_PHI_DETECTED",
      422,
    );
    expect((await svc.get(alice, row.id)).body).toBe(input.body);
  });

  it("refuses a duplicate title for the same owner (case-insensitive) but not for another user", async () => {
    const svc = createInMemoryTemplateService();
    await svc.createPersonal(alice, input);
    await rejects(
      svc.createPersonal(alice, { ...input, title: "RUNNING LATE" }),
      "TEMPLATE_TITLE_TAKEN",
      409,
    );
    await expect(svc.createPersonal(bob, input)).resolves.toMatchObject({ scope: "personal" });
  });

  it("caps replies per user", async () => {
    const svc = createInMemoryTemplateService();
    for (let i = 0; i < TEMPLATE_LIMITS.personalPerUser; i++) {
      await svc.createPersonal(alice, { ...input, title: `Reply ${i}` });
    }
    await rejects(
      svc.createPersonal(alice, { ...input, title: "One more" }),
      "TEMPLATE_LIMIT_REACHED",
      409,
    );
  });
});

describe("shared templates and the platform overlay", () => {
  it("shared create/update/delete, and a personal id is not reachable through the shared path", async () => {
    const svc = createInMemoryTemplateService();
    const row = await svc.createShared(alice, { ...input, title: "Org reply" });
    expect(row.scope).toBe("org");
    expect((await svc.updateShared(bob, row.id, { title: "Org reply v2" })).title).toBe(
      "Org reply v2",
    );
    const mine = await svc.createPersonal(alice, input);
    await rejects(svc.updateShared(alice, mine.id, { body: "x" }), "NOT_FOUND", 404);
    await svc.deleteShared(alice, row.id);
    await rejects(svc.get(alice, row.id), "NOT_FOUND", 404);
  });

  const emergency = PLATFORM_MESSAGE_TEMPLATES.find((t) => t.requiredPhrases.length > 0)!;

  it("an overlay that keeps the required wording is applied for its own org only", async () => {
    const svc = createInMemoryTemplateService();
    const body = `Our line: ${emergency.requiredPhrases.join(" ")}. Thank you.`;
    await svc.putOverlay(alice, emergency.id, { title: "Ours", body, isEnabled: true });
    const a = (await svc.list(alice)).find((i) => i.id === emergency.id);
    expect(a).toMatchObject({ title: "Ours", body, customized: true });
    const c = (await svc.list(carol)).find((i) => i.id === emergency.id);
    expect(c).toMatchObject({ title: emergency.title, body: emergency.body, customized: false });
  });

  it("an overlay that drops the required wording is refused and nothing is stored (the floor is not loosened)", async () => {
    const svc = createInMemoryTemplateService();
    await rejects(
      svc.putOverlay(alice, emergency.id, {
        title: null,
        body: "Reply when you can.",
        isEnabled: true,
      }),
      "TEMPLATE_FLOOR_VIOLATION",
      422,
    );
    const view = (await svc.list(alice)).find((i) => i.id === emergency.id);
    expect(view?.customized).toBe(false);
  });

  it("an overlay is held to the PHI lint", async () => {
    const svc = createInMemoryTemplateService();
    const body = `${emergency.requiredPhrases.join(" ")} 415-555-0134`;
    await rejects(
      svc.putOverlay(alice, emergency.id, { title: null, body, isEnabled: true }),
      "TEMPLATE_PHI_DETECTED",
      422,
    );
  });

  it("disabling hides a platform template from that org's pickers; deleting the overlay restores it", async () => {
    const svc = createInMemoryTemplateService();
    await svc.putOverlay(alice, emergency.id, { title: null, body: null, isEnabled: false });
    expect((await svc.list(alice)).some((i) => i.id === emergency.id)).toBe(false);
    expect((await svc.list(carol)).some((i) => i.id === emergency.id)).toBe(true);
    await svc.deleteOverlay(alice, emergency.id);
    expect((await svc.list(alice)).some((i) => i.id === emergency.id)).toBe(true);
  });

  it("an overlay can only target a platform template", async () => {
    const svc = createInMemoryTemplateService();
    const shared = await svc.createShared(alice, { ...input, title: "Org reply" });
    await rejects(
      svc.putOverlay(alice, shared.id, { title: null, body: null, isEnabled: false }),
      "NOT_FOUND",
      404,
    );
    await rejects(
      svc.putOverlay(alice, "no-such-id", { title: null, body: null, isEnabled: false }),
      "NOT_FOUND",
      404,
    );
  });

  it("adminList shows the floor, the overlay and the shared templates, never another org's", async () => {
    const svc = createInMemoryTemplateService();
    await svc.createShared(alice, { ...input, title: "Org reply" });
    await svc.createShared(carol, { ...input, title: "Carol reply" });
    await svc.putOverlay(alice, emergency.id, { title: "Ours", body: null, isEnabled: true });
    const admin = await svc.adminList(alice);
    expect(admin.shared.map((s) => s.title)).toEqual(["Org reply"]);
    const row = admin.platform.find((p) => p.id === emergency.id);
    expect(row).toMatchObject({
      floorBody: emergency.body,
      requiredPhrases: emergency.requiredPhrases,
    });
    expect(row?.overlay).toMatchObject({ title: "Ours", body: null, isEnabled: true });
  });
});
