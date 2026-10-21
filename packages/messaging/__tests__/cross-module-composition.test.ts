// @chartwarden/messaging — M36-T09 cross-module notification composition tests (spec §4.11, §3.13,
// ADR-0024). The composer loads a `notification_template`, applies a tighten-only tenant overlay,
// renders title/body from the SOURCE event payload, resolves recipients via the ADR-0024 resolvers
// (registered onto M36's open registry), and dispatches catalog-validated. PHI in the composed
// copy never traverses the §4.7 out-of-band sanitizer.
import { describe, expect, it, vi } from "vitest";
import {
  COMPOSITION_RESOLVER_NAMES,
  COMPOSITION_RESOLVER_ROLE_KEYS,
  type CompositionResolverPorts,
  type CrossModuleComposerPorts,
  MissingTemplateVariableError,
  type NotificationTemplateRow,
  PLATFORM_NOTIFICATION_TEMPLATES,
  TemplateOverlayMismatchError,
  type TenantTemplateOverlayRow,
  UnknownNotificationTemplateError,
  UnregisteredComposedPayloadError,
  composeAndDispatch,
  createInMemoryCrossModuleComposer,
  createRecipientResolverRegistry,
  registerCompositionResolvers,
  renderTemplate,
  resolveRecipients,
  resolveTemplate,
  sanitizeForOutOfBand,
  toNewNotificationTemplateRows,
  validateNotificationTemplateSeed,
} from "../src/index";

const FLOOR: NotificationTemplateRow = {
  organizationId: null,
  templateKey: "m6.referral.declined",
  version: 1,
  titleTemplate: "Referral was not accepted",
  bodyTemplate:
    "Referral for {{patientName}} was declined by {{actorName}}. Reason: {{declineReason}}.",
  payloadSchema: { type: "object", required: ["patientName", "actorName", "declineReason"] },
  defaultPayloadType: "m6.referral.declined",
  defaultRecipientResolver: "intake_supervisor",
  ownedByModule: "m6",
};

describe("template resolution — tighten-only overlay (§3.13.2)", () => {
  it("uses the floor wording when no overlay is present", () => {
    const eff = resolveTemplate(FLOOR, null);
    expect(eff.titleTemplate).toBe(FLOOR.titleTemplate);
    expect(eff.bodyTemplate).toBe(FLOOR.bodyTemplate);
    expect(eff.defaultPayloadType).toBe("m6.referral.declined");
    expect(eff.defaultRecipientResolver).toBe("intake_supervisor");
  });

  it("an overlay rewords title/body but can never change schema/resolver/payload_type", () => {
    const overlay: TenantTemplateOverlayRow = {
      organizationId: "org-1",
      templateKey: "m6.referral.declined",
      titleTemplate: "A referral needs your review",
      bodyTemplate: null, // null = keep the floor body
    };
    const eff = resolveTemplate(FLOOR, overlay);
    expect(eff.titleTemplate).toBe("A referral needs your review");
    expect(eff.bodyTemplate).toBe(FLOOR.bodyTemplate); // null overlay field falls back to floor
    // Platform-owned fields always come from the floor — structurally un-loosenable:
    expect(eff.payloadSchema).toBe(FLOOR.payloadSchema);
    expect(eff.defaultPayloadType).toBe("m6.referral.declined");
    expect(eff.defaultRecipientResolver).toBe("intake_supervisor");
  });

  it("rejects an overlay whose template_key differs from the floor", () => {
    const overlay: TenantTemplateOverlayRow = {
      organizationId: "org-1",
      templateKey: "m6.referral.accepted",
      titleTemplate: "x",
      bodyTemplate: null,
    };
    expect(() => resolveTemplate(FLOOR, overlay)).toThrow(TemplateOverlayMismatchError);
  });
});

describe("template render (§4.11 step 2)", () => {
  it("substitutes {{placeholders}} from the source payload", () => {
    const { title, body } = renderTemplate(resolveTemplate(FLOOR), {
      patientName: "Jane Doe",
      actorName: "Dr. Smith",
      declineReason: "out of service area",
    });
    expect(title).toBe("Referral was not accepted");
    expect(body).toBe(
      "Referral for Jane Doe was declined by Dr. Smith. Reason: out of service area.",
    );
  });

  it("throws when a required placeholder is missing from the payload", () => {
    expect(() => renderTemplate(resolveTemplate(FLOOR), { patientName: "Jane Doe" })).toThrow(
      MissingTemplateVariableError,
    );
  });

  it("leaves an un-provided non-required placeholder literal rather than blanking it", () => {
    const tpl = resolveTemplate({
      ...FLOOR,
      bodyTemplate: "{{patientName}} — note {{optionalNote}}",
      payloadSchema: { type: "object", required: ["patientName", "actorName", "declineReason"] },
    });
    const { body } = renderTemplate(tpl, {
      patientName: "Jane Doe",
      actorName: "Dr. Smith",
      declineReason: "n/a",
    });
    expect(body).toBe("Jane Doe — note {{optionalNote}}");
  });
});

function compositionPorts(over: Partial<CompositionResolverPorts> = {}): CompositionResolverPorts {
  return {
    orderingProviderForOrder: vi.fn(async () => ["u-ordering"]),
    orderingProvidersWithActiveOrdersForPhysician: vi.fn(async () => ["u-prov-a", "u-prov-b"]),
    roleSetMembers: vi.fn(async () => ["u-role"]),
    ...over,
  };
}

describe("ADR-0024 composition resolvers (§4.11)", () => {
  it("register onto the open registry without clobbering the seven built-ins", async () => {
    const registry = createRecipientResolverRegistry({
      careTeamMembers: async () => ["u-ct"],
      onCallMembers: async () => [],
      disciplineMembers: async () => [],
      roleSetMembers: async () => [],
      tenantAdmins: async () => [],
      orgMembers: async () => [],
    });
    registerCompositionResolvers(registry, compositionPorts());
    // built-in still present:
    expect(await resolveRecipients(registry, "care_team", "org-1", {}, { patientId: "p" })).toEqual(
      ["u-ct"],
    );
    // all four ADR-0024 names registered:
    for (const name of COMPOSITION_RESOLVER_NAMES) expect(registry.has(name)).toBe(true);
  });

  it("ordering_provider reads orderId from the payload and queries the order seam", async () => {
    const ports = compositionPorts();
    const registry = registerCompositionResolvers(
      createRecipientResolverRegistry({
        careTeamMembers: async () => [],
        onCallMembers: async () => [],
        disciplineMembers: async () => [],
        roleSetMembers: async () => [],
        tenantAdmins: async () => [],
        orgMembers: async () => [],
      }),
      ports,
    );
    const out = await resolveRecipients(
      registry,
      "ordering_provider",
      "org-1",
      {},
      { orderId: "o-9" },
    );
    expect(out).toEqual(["u-ordering"]);
    expect(ports.orderingProviderForOrder).toHaveBeenCalledWith("org-1", "o-9");
  });

  it("ordering_provider resolves to nobody (no seam call) when orderId is absent", async () => {
    const ports = compositionPorts();
    const registry = registerCompositionResolvers(
      createRecipientResolverRegistry({
        careTeamMembers: async () => [],
        onCallMembers: async () => [],
        disciplineMembers: async () => [],
        roleSetMembers: async () => [],
        tenantAdmins: async () => [],
        orgMembers: async () => [],
      }),
      ports,
    );
    expect(await resolveRecipients(registry, "ordering_provider", "org-1", {}, {})).toEqual([]);
    expect(ports.orderingProviderForOrder).not.toHaveBeenCalled();
  });

  it("intake_supervisor / admissions_team query their default role-key sets", async () => {
    const ports = compositionPorts();
    const registry = registerCompositionResolvers(
      createRecipientResolverRegistry({
        careTeamMembers: async () => [],
        onCallMembers: async () => [],
        disciplineMembers: async () => [],
        roleSetMembers: async () => [],
        tenantAdmins: async () => [],
        orgMembers: async () => [],
      }),
      ports,
    );
    await resolveRecipients(registry, "intake_supervisor", "org-1", {}, {});
    expect(ports.roleSetMembers).toHaveBeenCalledWith(
      "org-1",
      COMPOSITION_RESOLVER_ROLE_KEYS.intake_supervisor,
    );
    await resolveRecipients(registry, "admissions_team", "org-1", {}, {});
    expect(ports.roleSetMembers).toHaveBeenCalledWith(
      "org-1",
      COMPOSITION_RESOLVER_ROLE_KEYS.admissions_team,
    );
  });

  it("the physician-fan-out variant reads physicianId and dedupes via the core path", async () => {
    const ports = compositionPorts({
      orderingProvidersWithActiveOrdersForPhysician: vi.fn(async () => ["u-1", "u-2", "u-1"]),
    });
    const registry = registerCompositionResolvers(
      createRecipientResolverRegistry({
        careTeamMembers: async () => [],
        onCallMembers: async () => [],
        disciplineMembers: async () => [],
        roleSetMembers: async () => [],
        tenantAdmins: async () => [],
        orgMembers: async () => [],
      }),
      ports,
    );
    const out = await resolveRecipients(
      registry,
      "ordering_provider_with_active_orders_for_physician",
      "org-1",
      {},
      { physicianId: "phys-1" },
    );
    expect(out).toEqual(["u-1", "u-2"]); // de-duped by resolveRecipients
  });
});

describe("composeAndDispatch — the one path for all six events (§4.11)", () => {
  it("loads → renders → resolves → dispatches the enriched payload", async () => {
    const { composeAndDispatch: compose, recorded } = createInMemoryCrossModuleComposer({
      compositionPorts: { roleSetMembers: async () => ["u-intake-1", "u-intake-2"] },
    });
    const result = await compose({
      eventType: "m6.referral.declined",
      organizationId: "org-1",
      correlationId: "corr-1",
      sourcePayload: {
        patientName: "Jane Doe",
        actorName: "Dr. Smith",
        declinedAt: "2026-06-15",
        declineReason: "out of service area",
        referralId: "ref-1",
      },
    });
    expect(result.payloadType).toBe("m6.referral.declined");
    expect(result.resolvedRecipientCount).toBe(2);
    expect(result.title).toBe("Referral was not accepted");

    expect(recorded).toHaveLength(1);
    const sent = recorded[0]!;
    expect(sent.callerModule).toBe("m36");
    expect(sent.recipientUserIds).toEqual(["u-intake-1", "u-intake-2"]);
    // composed copy carried alongside the source payload:
    expect(sent.payload.composedTitle).toBe("Referral was not accepted");
    expect(sent.payload.composedBody).toContain("Jane Doe");
    expect(sent.payload.referralId).toBe("ref-1"); // source fields preserved
  });

  it("routes the critical-results event to ordering_provider via the order seam", async () => {
    const { composeAndDispatch: compose, recorded } = createInMemoryCrossModuleComposer({
      compositionPorts: { orderingProviderForOrder: async () => ["u-ordering"] },
    });
    const result = await compose({
      eventType: "m22.document.rendered_critical_results",
      organizationId: "org-1",
      correlationId: "corr-2",
      sourcePayload: { patientName: "John Roe", orderShortId: "L-42", orderId: "o-42" },
    });
    expect(result.resolvedRecipientCount).toBe(1);
    expect(recorded[0]!.recipientUserIds).toEqual(["u-ordering"]);
    expect(recorded[0]!.payloadType).toBe("m22.document.rendered_critical_results");
  });

  it("throws on an unknown template (no floor row seeded)", async () => {
    const { composeAndDispatch: compose } = createInMemoryCrossModuleComposer();
    await expect(
      compose({
        eventType: "m99.unknown.event",
        organizationId: "org-1",
        correlationId: "c",
        sourcePayload: {},
      }),
    ).rejects.toBeInstanceOf(UnknownNotificationTemplateError);
  });

  it("throws on a missing required placeholder before dispatching anything", async () => {
    const { composeAndDispatch: compose, recorded } = createInMemoryCrossModuleComposer();
    await expect(
      compose({
        eventType: "m6.referral.declined",
        organizationId: "org-1",
        correlationId: "c",
        sourcePayload: { patientName: "Jane Doe" }, // missing actorName + declineReason
      }),
    ).rejects.toBeInstanceOf(MissingTemplateVariableError);
    expect(recorded).toHaveLength(0); // fail-closed: no half-rendered dispatch
  });

  it("the §4.6.1 dispatch refuses an unregistered composed payload type (§7.12)", async () => {
    // A floor row whose payload type is not in the known catalog set → dispatch fails closed.
    const rogue: NotificationTemplateRow = {
      ...FLOOR,
      templateKey: "m6.referral.received",
      defaultPayloadType: "m6.referral.received",
    };
    const { composeAndDispatch: compose } = createInMemoryCrossModuleComposer({
      templates: [rogue],
      knownPayloadTypes: [], // simulate the catalog NOT having this payload registered
    });
    await expect(
      compose({
        eventType: "m6.referral.received",
        organizationId: "org-1",
        correlationId: "c",
        sourcePayload: { patientName: "x", actorName: "y", declineReason: "z" },
      }),
    ).rejects.toBeInstanceOf(UnregisteredComposedPayloadError);
  });

  it("a tenant overlay rewords the dispatched title (tighten-only)", async () => {
    const { composeAndDispatch: compose, recorded } = createInMemoryCrossModuleComposer({
      compositionPorts: { roleSetMembers: async () => ["u-1"] },
      overlays: [
        {
          organizationId: "org-1",
          templateKey: "m6.referral.received",
          titleTemplate: "Triage needed: referral from {{sendingFacility}}",
          bodyTemplate: null,
        },
      ],
    });
    await compose({
      eventType: "m6.referral.received",
      organizationId: "org-1",
      correlationId: "c",
      sourcePayload: { sendingFacility: "Mercy General", receivedAt: "2026-06-15" },
    });
    expect(recorded[0]!.payload.composedTitle).toBe("Triage needed: referral from Mercy General");
  });
});

describe("§7.2 — composed PHI never traverses the out-of-band sanitizer (§4.7)", () => {
  it("a composed body naming a patient is stripped for out-of-band delivery", () => {
    const sanitized = sanitizeForOutOfBand({
      alertOrMessage: {
        kind: "alert",
        alertId: "a-1",
        notificationDeliveryId: "nd-1",
        category: "clinical_urgent",
        payload: {
          composedTitle: "CRITICAL lab results ready",
          composedBody: "Critical lab results for Jane Doe (DOB 1950-01-01) require review.",
          patientName: "Jane Doe",
        },
      },
      channel: "sms",
      recipientUserId: "u-ordering",
      baseUrl: "https://app.wardenx.example",
    });
    const blob = JSON.stringify(sanitized);
    expect(blob).not.toContain("Jane Doe");
    expect(blob).not.toContain("1950");
    expect(blob).not.toContain("composedBody");
  });
});

describe("platform-floor template seed (§3.13.1 Phase C)", () => {
  it("seeds the six moved templates and validates clean", () => {
    expect(PLATFORM_NOTIFICATION_TEMPLATES).toHaveLength(6);
    expect(validateNotificationTemplateSeed()).toEqual([]);
  });

  it("projects to platform-floor rows (organization_id NULL, published, en-US)", () => {
    const rows = toNewNotificationTemplateRows();
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.organizationId).toBeNull();
      expect(r.status).toBe("published");
      expect(r.supportedLocales).toEqual(["en-US"]);
      expect(r.defaultPayloadType).toBe(r.templateKey); // §3.12.5 contract for the moved rows
    }
  });

  it("flags a non-floor or key/payload-type mismatch row", () => {
    const violations = validateNotificationTemplateSeed([
      { ...FLOOR, organizationId: "org-x" as unknown as null },
      { ...FLOOR, defaultPayloadType: "m6.referral.accepted" },
    ]);
    expect(violations.map((v) => v.type)).toEqual(
      expect.arrayContaining(["not_platform_floor", "payload_type_key_mismatch", "duplicate_key"]),
    );
  });
});

// Type-level: an explicit ports object is assignable (documents the production wiring surface).
const _ports: CrossModuleComposerPorts = {
  loadTemplate: async () => null,
  loadOverlay: async () => null,
  resolveRecipients: async () => [],
  dispatch: async () => ({ alertId: "a" }),
};
void _ports;
void composeAndDispatch;
