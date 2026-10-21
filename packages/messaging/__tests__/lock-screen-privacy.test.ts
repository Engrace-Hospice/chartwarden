// M36 WP 4.7 - lock-screen privacy. The acceptance snapshot: over EVERY alert category x EVERY out-of-band channel
// (and the message notification), with adversarial PHI injected into every payload field, id and base URL, the
// rendered subject/title/body/link carry no name, MRN, diagnosis or free text. Plus the fail-safe (an unissued or
// hand-built notification renders the generic wording, never its own text) and the coverage guard (no vendor send
// outside the audited files, so a new out-of-band template cannot ship without this test seeing it).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Alert,
  type AlertCategory,
  type Message,
  OUT_OF_BAND_CHANNELS,
  type OutOfBandChannel,
  renderOutOfBand,
  sanitizeForEmergencyContactCall,
  sanitizeForOutOfBand,
  setOutOfBandFallbackObserver,
} from "../src/index";

const CATEGORIES: readonly AlertCategory[] = [
  "clinical_urgent",
  "clinical_routine",
  "operational",
  "field_safety",
  "administrative",
  "system",
];
const BASE = "https://app.wardenx.example";
const SMS_SEGMENT = 160;

const PHI = [
  "Jane Patient",
  "MRN-00042",
  "metabolic encephalopathy",
  "123 Care Lane",
  "DEADBEEF-BODY-CIPHER",
  "patient died at 0300",
  "555-12-3456",
  "03/14/1941",
  "free text from the sender",
];

function adversarialAlert(category: AlertCategory): Alert {
  const payload = Object.fromEntries(PHI.map((v, i) => [`field${i}`, v]));
  return {
    kind: "alert",
    alertId: "alert-1",
    notificationDeliveryId: "nd-abc-123",
    category,
    payload: { ...payload, patientName: PHI[0], nested: { phi: true, value: PHI[2] } },
  };
}
const adversarialMessage: Message = {
  kind: "message",
  messageId: "msg-1",
  notificationDeliveryId: "nd-msg-9",
  channelId: "chan-Jane Patient",
  body: PHI.join(" | "),
};

function surface(r: ReturnType<typeof renderOutOfBand>): string {
  return JSON.stringify(r).toLowerCase();
}
function expectNoPhi(text: string, label: string): void {
  for (const token of PHI)
    expect(text, `${label} leaked '${token}'`).not.toContain(token.toLowerCase());
}

describe("WP 4.7 - every category x channel renders PHI-free", () => {
  for (const channel of OUT_OF_BAND_CHANNELS) {
    for (const category of CATEGORIES) {
      it(`${category} / ${channel}`, () => {
        const n = sanitizeForOutOfBand({
          alertOrMessage: adversarialAlert(category),
          channel,
          recipientUserId: "user-7",
          baseUrl: BASE,
        });
        const r = renderOutOfBand(n, channel);
        expectNoPhi(surface(r), `${category}/${channel}`);
        expect(r.link).toBe(`${BASE}/n/nd-abc-123`);
        if (channel === "sms") expect(r.body.length).toBeLessThanOrEqual(SMS_SEGMENT);
      });
    }
    it(`message / ${channel}`, () => {
      const n = sanitizeForOutOfBand({
        alertOrMessage: adversarialMessage,
        channel,
        recipientUserId: "user-7",
        baseUrl: BASE,
      });
      expectNoPhi(surface(renderOutOfBand(n, channel)), `message/${channel}`);
    });
  }

  it("fixed shapes: constant email subject, constant push title, SMS and push body carry the link once", () => {
    const mk = (channel: OutOfBandChannel) =>
      renderOutOfBand(
        sanitizeForOutOfBand({
          alertOrMessage: adversarialAlert("clinical_urgent"),
          channel,
          recipientUserId: "u",
          baseUrl: BASE,
        }),
        channel,
      );
    expect(mk("email").subject).toBe("ChartWarden notification");
    expect(mk("push").title).toBe("ChartWarden");
    expect(mk("sms").body).toBe(
      `You have a new urgent request in ChartWarden. Sign in to view. ${BASE}/n/nd-abc-123`,
    );
    expect(mk("email").body).toContain(`${BASE}/n/nd-abc-123`);
  });
});

describe("WP 4.7 - the link is a fixed generic authenticated route", () => {
  const bad: ReadonlyArray<readonly [string, string, string]> = [
    ["credentials", "https://user:pw@app.wardenx.example", "nd-1"],
    ["query token", "https://app.wardenx.example?token=abc", "nd-1"],
    ["fragment token", "https://app.wardenx.example/#access=abc", "nd-1"],
    ["not http", "javascript:alert(1)", "nd-1"],
    ["name in id", BASE, "Jane Patient"],
    ["path traversal id", BASE, "../patients/42"],
    ["query in id", BASE, "nd-1?mrn=00042"],
    ["empty id", BASE, ""],
  ];
  for (const [label, baseUrl, id] of bad) {
    it(`drops the link for ${label}; wording still tells the user to sign in`, () => {
      const n = sanitizeForOutOfBand({
        alertOrMessage: { ...adversarialAlert("clinical_urgent"), notificationDeliveryId: id },
        channel: "sms",
        recipientUserId: "u",
        baseUrl,
      });
      const r = renderOutOfBand(n, "sms");
      expect(r.link).toBe("");
      expect(r.body).toContain("Sign in to view.");
      expect(r.body).not.toMatch(/https?:|Jane|token|mrn/i);
    });
  }
  it("a long base URL never pushes the SMS past one segment (link dropped, wording kept)", () => {
    const n = sanitizeForOutOfBand({
      alertOrMessage: adversarialAlert("clinical_urgent"),
      channel: "sms",
      recipientUserId: "u",
      baseUrl: `https://${"a".repeat(50)}.${"b".repeat(50)}.example`,
    });
    const r = renderOutOfBand(n, "sms");
    expect(r.body.length).toBeLessThanOrEqual(SMS_SEGMENT);
    expect(r.body).toContain("Sign in to view.");
  });
});

describe("WP 4.7 - fail safe: unproven text is replaced by the generic wording", () => {
  const forged = {
    notificationDeliveryId: "nd-1",
    short: "Jane Patient, MRN-00042: metabolic encephalopathy worsening",
    deepLink: "https://evil.example/p/Jane%20Patient?token=abc",
  };
  for (const channel of OUT_OF_BAND_CHANNELS) {
    it(`a hand-built notification renders generic on ${channel}`, () => {
      const r = renderOutOfBand(forged, channel);
      expectNoPhi(surface(r), `forged/${channel}`);
      expect(surface(r)).not.toContain("evil.example");
      expect(surface(r)).not.toContain("token");
      expect(r.body.length).toBeGreaterThan(0);
    });
    it(`a spread copy of an issued notification is unproven on ${channel}`, () => {
      const issued = sanitizeForOutOfBand({
        alertOrMessage: adversarialAlert("clinical_urgent"),
        channel,
        recipientUserId: "u",
        baseUrl: BASE,
      });
      const r = renderOutOfBand({ ...issued, short: PHI[0] as string }, channel);
      expectNoPhi(surface(r), `spread/${channel}`);
    });
  }

  const sos = () =>
    sanitizeForEmergencyContactCall({
      idempotencyKey: "k-1",
      agencyName: "Harbor Hospice",
      subjectDisplayName: "Sam Nurse",
    });
  for (const channel of ["push", "sms", "email"] as const) {
    it(`the SOS script handed to ${channel} renders generic: no names, no link, still sent`, () => {
      const r = renderOutOfBand(sos(), channel);
      expect(surface(r)).not.toContain("harbor");
      expect(surface(r)).not.toContain("sam nurse");
      expect(r.body).toContain("Sign in to view.");
      expect(r.link).toBe("");
    });
  }

  describe("fallback observability", () => {
    afterEach(() => setOutOfBandFallbackObserver(undefined));
    it("reports a stable reason code and channel only, for unissued and wrong-channel notifications", () => {
      const seen: unknown[] = [];
      setOutOfBandFallbackObserver((e) => seen.push(e));
      renderOutOfBand(
        { notificationDeliveryId: "x", short: PHI[0] as string, deepLink: "" },
        "sms",
      );
      renderOutOfBand(sos(), "push");
      renderOutOfBand(sos(), "voice");
      expect(seen).toEqual([
        { reason: "unissued_notification", channel: "sms" },
        { reason: "channel_not_bound", channel: "push" },
      ]);
    });
    it("a throwing observer never breaks the render", () => {
      setOutOfBandFallbackObserver(() => {
        throw new Error("boom");
      });
      expect(renderOutOfBand(sos(), "sms").body).toContain("Sign in to view.");
    });
  });

  it("voice with a non-opaque idempotencyKey still speaks the script but correlates with no id", () => {
    const n = sanitizeForEmergencyContactCall({
      idempotencyKey: "Jane Patient/../x",
      agencyName: "Harbor Hospice",
      subjectDisplayName: "Sam Nurse",
    });
    const r = renderOutOfBand(n, "voice");
    expect(r.body).toContain("Harbor Hospice");
    expect(r.id).toBe("");
  });

  it("the SOS emergency-contact call (a designated safety route) still speaks its issued script", () => {
    const n = sanitizeForEmergencyContactCall({
      idempotencyKey: "k-1",
      agencyName: "Harbor Hospice",
      subjectDisplayName: "Sam Nurse",
    });
    const r = renderOutOfBand(n, "voice");
    expect(r.body).toContain("Harbor Hospice");
    expect(r.body).toContain("Sam Nurse");
  });
});

// Coverage guard: every file that talks to an out-of-band vendor is audited here. A new sender must either render
// through renderOutOfBand (and so be covered above) or be added to this list with a reason in review.
const AUDITED_SENDERS: Readonly<Record<string, string>> = {
  "packages/messaging/src/dispatch/postmark-alert-transport.ts":
    "alert email; renders via renderOutOfBand",
  "packages/messaging/src/dispatch/twilio-transports.ts":
    "alert SMS/voice; renders via renderOutOfBand",
  "packages/messaging/src/dispatch/web-push-transport.ts":
    "alert push; renders via renderOutOfBand",
  "packages/messaging/src/dispatch/vendor-http.ts": "the HTTP helper itself",
  "packages/messaging/src/notification/postmark-transactional-email.ts":
    "auth links (reset / magic link): pre-session, no PHI source, a token link by design",
  "apps/backend/src/modules/36-messaging/delivery/transport-binding.ts":
    "endpoint OTP: fixed text + one-time code, no PHI source",
};
const RENDER_REQUIRED = [
  "packages/messaging/src/dispatch/postmark-alert-transport.ts",
  "packages/messaging/src/dispatch/twilio-transports.ts",
  "packages/messaging/src/dispatch/web-push-transport.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.(test|live\.test|d)\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("WP 4.7 - coverage guard: no unaudited out-of-band sender", () => {
  const root = join(__dirname, "..", "..", "..");
  const files = [...walk(join(root, "packages")), ...walk(join(root, "apps", "backend", "src"))];
  const vendorCall =
    /\bpostToVendor\(|\bsendTwilioSms\(|\bsendPostmarkEmail\(|api\.postmarkapp\.com|api\.twilio\.com/;

  it("every file that calls a vendor is on the audited list", () => {
    const callers = files
      .filter((f) => vendorCall.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f));
    const unaudited = callers.filter((f) => !(f in AUDITED_SENDERS));
    expect(unaudited, `unaudited out-of-band senders: ${unaudited.join(", ")}`).toEqual([]);
  });

  it("alert transports render through renderOutOfBand and never read short/deepLink directly", () => {
    for (const f of RENDER_REQUIRED) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).toContain("renderOutOfBand(");
      expect(src, f).not.toMatch(/notification\.(short|deepLink)/);
    }
  });

  it("no dispatch/notification file other than sanitize.ts touches .short / .deepLink", () => {
    const dirs = ["dispatch", "notification"].map((d) => join(root, "packages/messaging/src", d));
    const reads =
      /\.\s*(short|deepLink)\b|\[\s*["'`](short|deepLink)["'`]\s*\]|\{[^}]*\b(short|deepLink)\b[^}]*\}\s*=\s*(notification|n)\b/;
    for (const f of dirs.flatMap((d) => walk(d)).filter((f) => !f.endsWith("sanitize.ts")))
      expect(readFileSync(f, "utf8"), relative(root, f)).not.toMatch(reads);
  });

  it("no raw fetch / vendor SDK / dynamic import outside the audited senders", () => {
    const sdk =
      /\b(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:twilio|web-push|nodemailer|postmark|@aws-sdk\/client-(?:ses|sesv2|sns)|aws-sdk)[^"']*["']/;
    const rawFetch = /(?<![\w.])fetch\s*\(|globalThis\.fetch\s*\(/;
    const dirs = ["dispatch", "notification"].map((d) => join(root, "packages/messaging/src", d));
    for (const f of dirs.flatMap((d) => walk(d))) {
      const rel = relative(root, f);
      const src = readFileSync(f, "utf8");
      expect(src, `${rel} imports a vendor SDK`).not.toMatch(sdk);
      if (!(rel in AUDITED_SENDERS))
        expect(src, `${rel} calls fetch directly`).not.toMatch(rawFetch);
    }
    for (const f of files) expect(readFileSync(f, "utf8"), relative(root, f)).not.toMatch(sdk);
  });

  it("the dispatch and notification surfaces import no template, composer or payload module (tenant-edited templates cannot reach a vendor)", () => {
    const dirs = ["dispatch", "notification"].map((d) => join(root, "packages/messaging/src", d));
    for (const f of dirs.flatMap((d) => walk(d))) {
      const imports = readFileSync(f, "utf8").match(/from\s+"[^"]+"/g) ?? [];
      for (const i of imports)
        expect(i, `${relative(root, f)} imports ${i}`).not.toMatch(
          /\/(compose|templates)\/|payload-catalog|template-render/,
        );
    }
  });
});
