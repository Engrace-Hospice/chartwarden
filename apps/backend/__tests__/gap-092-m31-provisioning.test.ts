/**
 * GAP-092 — M31 provisioning, against a recording fake of the Drizzle chains (see `_fake-drizzle.ts`) and the real
 * AES-GCM envelope: notification preferences, encrypted upload staging + the M22 hand-off, and account + grant
 * creation from an invitation (issue / list / revoke / accept).
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPortalPhiCipher } from "../src/modules/31-portal/portal-crypto";
import {
  PORTAL_SCOPE_FLOOR_VERSION,
  createPortalInvitations,
  hashInvitationToken,
  mintInvitationToken,
  overlayForProposedScope,
} from "../src/modules/31-portal/provisioning/invitations";
import {
  createPortalPreferences,
  toPreferencesView,
} from "../src/modules/31-portal/provisioning/preferences";
import type {
  PortalConsentPort,
  PortalInviteeUserPort,
  PortalUploadIntakePort,
} from "../src/modules/31-portal/provisioning/types";
import { createPortalUploads } from "../src/modules/31-portal/provisioning/uploads";
import { type FakeRows, fakeDb } from "./_fake-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const PE = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const ACTOR = "66666666-6666-4666-8666-666666666666";
const UPLOAD = "77777777-7777-4777-8777-777777777777";
const INVITATION = "88888888-8888-4888-8888-888888888888";
const GRANT_ID = "99999999-9999-4999-8999-999999999990";
const NOW = new Date("2026-10-06T12:00:00.000Z");

function cipher() {
  const key = randomBytes(32);
  return createPortalPhiCipher({
    dekForOrg: async () => ({ version: "v1", key }),
    dekForOrgVersion: async (_org: string, version: string) => ({ version, key }),
  });
}

// ── notification preferences ────────────────────────────────────────────────────────────────────────────────────
describe("portal notification preferences", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "99999999-9999-4999-8999-999999999999",
    organizationId: ORG,
    portalAccountId: ACCOUNT,
    channel: "sms",
    enabled: true,
    quietHoursStartHour: null,
    quietHoursEndHour: null,
    version: 0,
    ...over,
  });

  it("reads a channel with no row as its default and carries the stored quiet hours", () => {
    const view = toPreferencesView([
      row({ quietHoursStartHour: 22, quietHoursEndHour: 7 }) as never,
    ]);
    expect(view.channels).toEqual([
      { channel: "email", enabled: true },
      { id: "99999999-9999-4999-8999-999999999999", channel: "sms", enabled: true },
      { channel: "push", enabled: false },
    ]);
    expect(view.quietHours).toEqual({ startHour: 22, endHour: 7 });
  });

  it("inserts the first toggle of a channel, addressed by channel name", async () => {
    const { db, rec } = fakeDb({ portal_notification_preference: [] });
    await createPortalPreferences(db).update({
      organizationId: ORG,
      actingUserId: ACTOR,
      portalAccountId: ACCOUNT,
      idOrChannel: "push",
      update: { enabled: true, quietHoursStartHour: 21, quietHoursEndHour: 6 },
    });
    expect(rec.inserts[0]?.values).toMatchObject({
      portalAccountId: ACCOUNT,
      channel: "push",
      enabled: true,
      quietHoursStartHour: 21,
      quietHoursEndHour: 6,
    });
  });

  it("updates an existing row (bumping its version) when addressed by its row id", async () => {
    const { db, rec } = fakeDb({ portal_notification_preference: [row({ version: 3 })] });
    await createPortalPreferences(db).update({
      organizationId: ORG,
      actingUserId: ACTOR,
      portalAccountId: ACCOUNT,
      idOrChannel: "99999999-9999-4999-8999-999999999999",
      update: { enabled: false },
    });
    expect(rec.inserts).toHaveLength(0);
    expect(rec.updates[0]?.set).toMatchObject({ enabled: false, version: 4 });
  });

  it("404s an id that is not this account's, and refuses a half-specified quiet-hours pair", async () => {
    const prefs = createPortalPreferences(fakeDb({}).db);
    await expect(
      prefs.update({
        organizationId: ORG,
        actingUserId: ACTOR,
        portalAccountId: ACCOUNT,
        idOrChannel: "99999999-9999-4999-8999-999999999999",
        update: { enabled: true },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      prefs.update({
        organizationId: ORG,
        actingUserId: ACTOR,
        portalAccountId: ACCOUNT,
        idOrChannel: "sms",
        update: { enabled: true, quietHoursStartHour: 22 },
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});

// ── encrypted upload staging ────────────────────────────────────────────────────────────────────────────────────
describe("portal document upload staging", () => {
  const PDF = Buffer.from("%PDF-1.7 a small portal upload");
  const uploadRow = (over: Record<string, unknown> = {}) => ({
    id: UPLOAD,
    organizationId: ORG,
    portalAccountId: ACCOUNT,
    patientId: PATIENT,
    purpose: "prior_records",
    declaredMime: "application/pdf",
    expectedByteSize: PDF.byteLength,
    status: "initiated",
    contentCipher: null,
    expiresAt: new Date(NOW.getTime() + 60_000),
    ...over,
  });
  const base = {
    organizationId: ORG,
    actingUserId: ACTOR,
    portalAccountId: ACCOUNT,
    patientId: PATIENT,
  };

  it("begin records an intent under the account's grant and returns the content route", async () => {
    const { db, rec } = fakeDb({
      portal_access_grant: [{ providerEntityId: PE, locationId: null }],
      portal_document_upload: (op) => (op === "insert" ? [{ id: UPLOAD }] : []),
    });
    const out = await createPortalUploads({ db, cipher: cipher(), now: () => NOW }).begin({
      ...base,
      purpose: "prior_records",
      mimeType: "application/pdf",
      expectedByteSize: 2048,
      patientDischargedReadOnly: false,
    });
    expect(out.contentPath).toBe(`/api/v1/portal/documents/uploads/${UPLOAD}/content`);
    expect(rec.inserts[0]?.values).toMatchObject({
      providerEntityId: PE,
      portalAccountId: ACCOUNT,
      patientId: PATIENT,
      declaredMime: "application/pdf",
      expectedByteSize: 2048,
    });
  });

  it("begin refuses a disallowed type, an oversized file, a discharged patient and a patient with no grant", async () => {
    const uploads = createPortalUploads({
      db: fakeDb({ portal_access_grant: [] }).db,
      cipher: cipher(),
      now: () => NOW,
    });
    const ok = {
      ...base,
      purpose: "x",
      mimeType: "application/pdf",
      expectedByteSize: 10,
      patientDischargedReadOnly: false,
    };
    await expect(uploads.begin({ ...ok, mimeType: "application/zip" })).rejects.toMatchObject({
      statusCode: 415,
    });
    await expect(
      uploads.begin({ ...ok, expectedByteSize: 51 * 1024 * 1024 }),
    ).rejects.toMatchObject({ statusCode: 413 });
    await expect(uploads.begin({ ...ok, patientDischargedReadOnly: true })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(uploads.begin(ok)).rejects.toMatchObject({ statusCode: 403 }); // no live grant row
  });

  it("stage seals the bytes (never plaintext at rest) and records their digest", async () => {
    const c = cipher();
    const { db, rec } = fakeDb({ portal_document_upload: [uploadRow()] });
    await createPortalUploads({ db, cipher: c, now: () => NOW }).stage({
      ...base,
      uploadId: UPLOAD,
      bytes: PDF,
    });
    const set = rec.updates.find((u) => u.set.status === "staged")?.set;
    expect(set?.contentSha256).toBe(createHash("sha256").update(PDF).digest("hex"));
    expect(String(set?.contentCipher)).not.toContain("PDF");
    const opened = await c.decrypt(
      ORG,
      "portal_document_upload.content_cipher",
      String(set?.contentCipher),
    );
    expect(opened.equals(PDF)).toBe(true);
  });

  it("stage rejects a wrong size, spoofed content (closing the upload) and an expired window", async () => {
    const uploads = (rows: FakeRows) =>
      createPortalUploads({
        db: fakeDb({ portal_document_upload: rows }).db,
        cipher: cipher(),
        now: () => NOW,
      });
    await expect(
      uploads([uploadRow()]).stage({ ...base, uploadId: UPLOAD, bytes: Buffer.from("%PDF-short") }),
    ).rejects.toMatchObject({ code: "UPLOAD_SIZE_MISMATCH" });

    const spoof = fakeDb({ portal_document_upload: [uploadRow()] });
    const exe = Buffer.alloc(PDF.byteLength, 0x4d);
    await expect(
      createPortalUploads({ db: spoof.db, cipher: cipher(), now: () => NOW }).stage({
        ...base,
        uploadId: UPLOAD,
        bytes: exe,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_MAGIC_BYTE_MISMATCH", statusCode: 415 });
    expect(spoof.rec.updates.some((u) => u.set.status === "rejected")).toBe(true);

    await expect(
      uploads([uploadRow({ expiresAt: new Date(NOW.getTime() - 1) })]).stage({
        ...base,
        uploadId: UPLOAD,
        bytes: PDF,
      }),
    ).rejects.toMatchObject({ statusCode: 410 });
  });

  it("stage 404s an upload that is not this account's", async () => {
    await expect(
      createPortalUploads({ db: fakeDb({}).db, cipher: cipher(), now: () => NOW }).stage({
        ...base,
        uploadId: UPLOAD,
        bytes: PDF,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("complete hands the DECRYPTED bytes to M22 intake, clears the staged ciphertext and is idempotent", async () => {
    const c = cipher();
    const sealed = await c.encrypt(ORG, "portal_document_upload.content_cipher", PDF);
    const { db, rec } = fakeDb({
      portal_document_upload: [uploadRow({ status: "staged", contentCipher: sealed.envelope })],
    });
    const accept = vi.fn(async () => ({
      documentId: "d0000000-0000-4000-8000-000000000001",
      intakeBatchId: "b0000000-0000-4000-8000-000000000001",
    }));
    const intake: PortalUploadIntakePort = { accept };
    const uploads = createPortalUploads({ db, cipher: c, intake, now: () => NOW });
    const out = await uploads.complete({ ...base, uploadId: UPLOAD });
    expect(out).toMatchObject({
      status: "received",
      documentId: "d0000000-0000-4000-8000-000000000001",
    });
    const call = (
      accept.mock.calls[0] as unknown as [{ bytes: Buffer; mimeType: string; purpose: string }]
    )[0];
    expect(Buffer.from(call.bytes).equals(PDF)).toBe(true);
    expect(call).toMatchObject({ mimeType: "application/pdf", purpose: "prior_records" });
    expect(rec.updates.find((u) => u.set.status === "submitted")?.set).toMatchObject({
      contentCipher: null,
      documentId: "d0000000-0000-4000-8000-000000000001",
    });

    // a retry after success answers the same ids without re-filing
    const again = createPortalUploads({
      db: fakeDb({
        portal_document_upload: [
          uploadRow({
            status: "submitted",
            documentId: "d0000000-0000-4000-8000-000000000001",
            intakeBatchId: "b0000000-0000-4000-8000-000000000001",
          }),
        ],
      }).db,
      cipher: c,
      intake,
      now: () => NOW,
    });
    await expect(again.complete({ ...base, uploadId: UPLOAD })).resolves.toMatchObject({
      status: "received",
    });
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("complete keeps the staged bytes and answers 503 when intake is unbound or fails; 409 when nothing is staged", async () => {
    const c = cipher();
    const sealed = await c.encrypt(ORG, "portal_document_upload.content_cipher", PDF);
    const staged = uploadRow({ status: "staged", contentCipher: sealed.envelope });
    const unbound = fakeDb({ portal_document_upload: [staged] });
    await expect(
      createPortalUploads({ db: unbound.db, cipher: c, now: () => NOW }).complete({
        ...base,
        uploadId: UPLOAD,
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(unbound.rec.updates).toHaveLength(0);

    const failing = fakeDb({ portal_document_upload: [staged] });
    await expect(
      createPortalUploads({
        db: failing.db,
        cipher: c,
        intake: {
          accept: async () => {
            throw new Error("object store down");
          },
        },
        now: () => NOW,
      }).complete({ ...base, uploadId: UPLOAD }),
    ).rejects.toThrow("object store down");
    expect(failing.rec.updates).toHaveLength(0);

    await expect(
      createPortalUploads({
        db: fakeDb({ portal_document_upload: [uploadRow()] }).db,
        cipher: c,
        now: () => NOW,
      }).complete({
        ...base,
        uploadId: UPLOAD,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_STAGED", statusCode: 409 });
  });
});

// ── invitations: account + grant provisioning ───────────────────────────────────────────────────────────────────
describe("portal invitations", () => {
  const CONSENT = { consentRecordId: "c0000000-0000-4000-8000-000000000001", consentVersion: "4" };
  const users = (): PortalInviteeUserPort & { ensured: unknown[]; verified: string[] } => {
    const ensured: unknown[] = [];
    const verified: string[] = [];
    return {
      ensured,
      verified,
      ensureUser: async (_org, input) => {
        ensured.push(input);
        return { userId: USER };
      },
      markEmailVerified: async (_org, userId) => {
        verified.push(userId);
      },
    };
  };
  const consent = (value: typeof CONSENT | null): PortalConsentPort => ({
    governingConsent: async () => value,
  });
  const site = { siteForPatient: async () => ({ providerEntityId: PE, locationId: null }) };
  const issueInput = {
    organizationId: ORG,
    actingUserId: ACTOR,
    patientId: PATIENT,
    relationship: "family_caregiver" as const,
    inviteeDisplayName: "Jane Roe",
    inviteeEmail: "  Jane.Roe@Example.com ",
    inviteePhone: "555-0100",
    proposedScopeSet: ["care_plan", "medications"],
  };
  const invitationRow = (over: Record<string, unknown> = {}) => ({
    id: INVITATION,
    organizationId: ORG,
    providerEntityId: PE,
    locationId: null,
    portalAccountId: ACCOUNT,
    patientId: PATIENT,
    relationship: "family_caregiver",
    grantKind: "family_caregiver",
    tokenHash: "x",
    proposedScopeOverlay: null,
    expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
    acceptedAt: null,
    revokedAt: null,
    createdAt: NOW,
    ...over,
  });

  it("issue creates the invited account with SEALED contact PHI and an invitation holding only the token digest", async () => {
    const u = users();
    const c = cipher();
    const delivered: Array<{ token: string; email: string }> = [];
    const { db, rec } = fakeDb({
      portal_account: (op) => (op === "insert" ? [{ id: ACCOUNT }] : []),
      portal_invitation: (op) =>
        op === "insert"
          ? [invitationRow({ expiresAt: new Date(NOW.getTime() + 72 * 3_600_000) })]
          : [],
    });
    const issued = await createPortalInvitations({
      db,
      cipher: c,
      users: u,
      consent: consent(CONSENT),
      site,
      delivery: {
        deliver: async (i) => {
          delivered.push({ token: i.token, email: i.email });
          return { inviteUrl: null };
        },
      },
      now: () => NOW,
    }).issue(issueInput);

    expect(issued).toMatchObject({
      invitationId: INVITATION,
      portalAccountId: ACCOUNT,
      status: "invited",
      inviteUrl: null,
    });
    expect(u.ensured).toEqual([{ email: "jane.roe@example.com", displayName: "Jane Roe" }]);
    const account = rec.inserts.find((i) => i.table === "portal_account")?.values;
    expect(account).toMatchObject({
      userId: USER,
      relationship: "family_caregiver",
      status: "invited",
    });
    expect(String(account?.emailCipher)).not.toContain("example.com");
    expect(String(account?.displayNameCipher)).not.toContain("Jane");
    await expect(
      c.decrypt(ORG, "portal_account.email_cipher", String(account?.emailCipher)),
    ).resolves.toEqual(Buffer.from("jane.roe@example.com"));
    const invitation = rec.inserts.find((i) => i.table === "portal_invitation")?.values;
    const token = delivered[0]?.token as string;
    expect(token).toMatch(new RegExp(`^${ORG}\\.[A-Za-z0-9_-]{43}$`));
    expect(invitation?.tokenHash).toBe(hashInvitationToken(token));
    expect(JSON.stringify(invitation)).not.toContain(token);
    expect(invitation).toMatchObject({
      providerEntityId: PE,
      patientId: PATIENT,
      grantKind: "family_caregiver",
      proposedScopeOverlay: expect.objectContaining({ assessments: false, visits: false }),
    });
    // 72h TTL floor
    expect((invitation?.expiresAt as Date).getTime() - NOW.getTime()).toBe(72 * 3_600_000);
  });

  it("issue writes nothing without an active portal-access consent, and returns the link when nothing delivered it", async () => {
    const none = fakeDb({});
    await expect(
      createPortalInvitations({
        db: none.db,
        cipher: cipher(),
        users: users(),
        consent: consent(null),
        site,
        now: () => NOW,
      }).issue(issueInput),
    ).rejects.toMatchObject({ code: "PORTAL_CONSENT_ABSENT", statusCode: 403 });
    expect(none.rec.inserts).toHaveLength(0);
  });

  it("issue refuses a patient with no site and a category the grant kind cannot carry", async () => {
    const make = (s: typeof site | { siteForPatient: () => Promise<null> }) =>
      createPortalInvitations({
        db: fakeDb({}).db,
        cipher: cipher(),
        users: users(),
        consent: consent(CONSENT),
        site: s,
        now: () => NOW,
      });
    await expect(
      make({ siteForPatient: async () => null }).issue(issueInput),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      make(site).issue({ ...issueInput, proposedScopeSet: ["bereavement"] }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      make(site).issue({ ...issueInput, proposedScopeSet: ["not_a_category"] }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("only tightens: unnamed floor-allowed categories turn off, naming everything leaves the floor", () => {
    expect(overlayForProposedScope("family_caregiver", [])).toBeUndefined();
    const overlay = overlayForProposedScope("family_caregiver", ["care_plan"]);
    expect(overlay).toMatchObject({ medications: false, visits: false });
    expect(overlay).not.toHaveProperty("care_plan");
    expect(overlayForProposedScope("bereaved_family", ["bereavement", "messages"])).toBeUndefined();
  });

  it("accept consumes the token once: activates the account and inserts the grant under the governing consent", async () => {
    const u = users();
    const token = mintInvitationToken(ORG);
    const { db, rec } = fakeDb({
      portal_invitation: [invitationRow({ tokenHash: hashInvitationToken(token) })],
      portal_account: [
        {
          id: ACCOUNT,
          organizationId: ORG,
          userId: USER,
          status: "invited",
          revokedAt: null,
          version: 0,
        },
      ],
      // The grant insert now `returning({ id })` (the granted event carries it); selects see no prior grant.
      portal_access_grant: (op) => (op === "insert" ? [{ id: GRANT_ID }] : []),
    });
    const out = await createPortalInvitations({
      db,
      cipher: cipher(),
      users: u,
      consent: consent(CONSENT),
      site,
      now: () => NOW,
    }).accept(token);

    expect(out).toEqual({
      portalAccountId: ACCOUNT,
      patientId: PATIENT,
      grantKind: "family_caregiver",
      status: "active",
      replayed: false,
    });
    expect(rec.updates.find((x) => x.table === "portal_invitation")?.set).toMatchObject({
      acceptedAt: NOW,
    });
    expect(rec.updates.find((x) => x.table === "portal_account")?.set).toMatchObject({
      status: "active",
      activatedAt: NOW,
      version: 1,
    });
    const grant = rec.inserts.find((x) => x.table === "portal_access_grant")?.values;
    expect(grant).toMatchObject({
      organizationId: ORG,
      providerEntityId: PE,
      portalAccountId: ACCOUNT,
      patientId: PATIENT,
      grantKind: "family_caregiver",
      sourceConsentRecordId: CONSENT.consentRecordId,
      sourceConsentVersion: "4",
    });
    expect((grant?.scopeSetJsonb as { floorVersion: string }).floorVersion).toBe(
      PORTAL_SCOPE_FLOOR_VERSION,
    );
    expect(u.verified).toEqual([USER]);
  });

  it("accept is an idempotent replay once used, and refuses a bad, unknown, revoked, expired or consent-less token", async () => {
    const token = mintInvitationToken(ORG);
    const hash = hashInvitationToken(token);
    const make = (rows: Record<string, FakeRows>, c = consent(CONSENT)) => {
      const f = fakeDb(rows);
      return {
        f,
        svc: createPortalInvitations({
          db: f.db,
          cipher: cipher(),
          users: users(),
          consent: c,
          site,
          now: () => NOW,
        }),
      };
    };
    const accepted = make({
      portal_invitation: [invitationRow({ tokenHash: hash, acceptedAt: NOW })],
    });
    await expect(accepted.svc.accept(token)).resolves.toMatchObject({
      replayed: true,
      status: "active",
    });
    expect(accepted.f.rec.inserts).toHaveLength(0);

    await expect(make({}).svc.accept("garbage")).rejects.toMatchObject({ statusCode: 404 });
    await expect(make({ portal_invitation: [] }).svc.accept(token)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      make({ portal_invitation: [invitationRow({ tokenHash: hash, revokedAt: NOW })] }).svc.accept(
        token,
      ),
    ).rejects.toMatchObject({ code: "INVITATION_REVOKED" });
    await expect(
      make({
        portal_invitation: [
          invitationRow({ tokenHash: hash, expiresAt: new Date(NOW.getTime() - 1) }),
        ],
      }).svc.accept(token),
    ).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
    const noConsent = make(
      { portal_invitation: [invitationRow({ tokenHash: hash })] },
      consent(null),
    );
    await expect(noConsent.svc.accept(token)).rejects.toMatchObject({
      code: "PORTAL_CONSENT_ABSENT",
    });
    expect(noConsent.f.rec.inserts).toHaveLength(0);
  });

  it("accept refuses when a concurrent accept already consumed the token (no second grant)", async () => {
    const token = mintInvitationToken(ORG);
    const { db, rec } = fakeDb({
      portal_invitation: (op) =>
        op === "update" ? [] : [invitationRow({ tokenHash: hashInvitationToken(token) })],
      portal_account: [
        {
          id: ACCOUNT,
          organizationId: ORG,
          userId: USER,
          status: "invited",
          revokedAt: null,
          version: 0,
        },
      ],
    });
    await expect(
      createPortalInvitations({
        db,
        cipher: cipher(),
        users: users(),
        consent: consent(CONSENT),
        site,
        now: () => NOW,
      }).accept(token),
    ).rejects.toMatchObject({ code: "INVITATION_ALREADY_BOUND", statusCode: 409 });
    expect(rec.inserts).toHaveLength(0);
  });

  it("list derives each invitation's status; revoke is idempotent and refuses an accepted one", async () => {
    const svc = (rows: FakeRows) =>
      createPortalInvitations({
        db: fakeDb({ portal_invitation: rows }).db,
        cipher: cipher(),
        users: users(),
        consent: consent(CONSENT),
        site,
        now: () => NOW,
      });
    const items = await svc([
      invitationRow(),
      invitationRow({ id: "a", acceptedAt: NOW }),
      invitationRow({ id: "b", revokedAt: NOW }),
      invitationRow({ id: "c", expiresAt: new Date(NOW.getTime() - 1) }),
    ]).list(ORG);
    expect(items.map((i) => i.status)).toEqual(["outstanding", "accepted", "revoked", "expired"]);

    await expect(svc([]).revoke(ORG, ACTOR, INVITATION)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      svc([invitationRow({ acceptedAt: NOW })]).revoke(ORG, ACTOR, INVITATION),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    const live = fakeDb({ portal_invitation: [invitationRow()] });
    await createPortalInvitations({
      db: live.db,
      cipher: cipher(),
      users: users(),
      consent: consent(CONSENT),
      site,
      now: () => NOW,
    }).revoke(ORG, ACTOR, INVITATION);
    expect(live.rec.updates[0]?.set).toMatchObject({ revokedAt: NOW });
    await expect(
      svc([invitationRow({ revokedAt: NOW })]).revoke(ORG, ACTOR, INVITATION),
    ).resolves.toBeUndefined();
  });
});
