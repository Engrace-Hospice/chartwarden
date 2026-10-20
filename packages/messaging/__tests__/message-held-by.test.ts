// ADR-0086 D5 — which messages an M4 legal hold's criteria hold. Pure; the SQL mirror in the backend scan is
// proven against this function by the live suite.
import { type MessageHoldFacts, messageHeldBy } from "@wardenx/messaging";
import { describe, expect, it } from "vitest";

const P = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const facts = (over: Partial<MessageHoldFacts> = {}): MessageHoldFacts => ({
  createdAt: "2020-06-15T00:00:00Z",
  authorUserId: null,
  channelId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  channelKind: "dm",
  channelSubjectId: null,
  referencedPatientIds: [],
  memberUserIds: [],
  ...over,
});

describe("messageHeldBy", () => {
  it.each<[string, unknown, Partial<MessageHoldFacts>, boolean]>([
    ["org-wide legacy hold (empty criteria)", {}, {}, true],
    [
      "resourceKinds-only hold is ignored for selection, so org-wide",
      { resourceKinds: ["audit_event"] },
      {},
      true,
    ],
    [
      "patient: care_team channel about the patient",
      { patientIds: [P] },
      { channelKind: "care_team", channelSubjectId: P },
      true,
    ],
    [
      "patient: care_team channel about someone else",
      { patientIds: [P] },
      { channelKind: "care_team", channelSubjectId: OTHER },
      false,
    ],
    [
      "patient: DM that references the patient",
      { patientIds: [P] },
      { channelKind: "dm", referencedPatientIds: [P] },
      true,
    ],
    [
      "patient: DM that references another patient",
      { patientIds: [P] },
      { channelKind: "dm", referencedPatientIds: [OTHER] },
      false,
    ],
    [
      "patient: any bereavement channel (conservative)",
      { patientIds: [P] },
      { channelKind: "bereavement", channelSubjectId: OTHER },
      true,
    ],
    [
      "patient: announcement unrelated",
      { patientIds: [P] },
      { channelKind: "announcement" },
      false,
    ],
    [
      "patient: non-care_team subject equal to the patient id is not a patient channel",
      { patientIds: [P] },
      { channelKind: "location", channelSubjectId: P },
      false,
    ],
    ["channel: that channel", { channelIds: [CH] }, { channelId: CH }, true],
    ["channel: another channel", { channelIds: [CH] }, {}, false],
    ["user: authored", { userIds: [U] }, { authorUserId: U }, true],
    [
      "user: member of the channel (active or ended)",
      { userIds: [U] },
      { memberUserIds: [OTHER, U] },
      true,
    ],
    ["user: neither", { userIds: [U] }, { authorUserId: OTHER, memberUserIds: [OTHER] }, false],
    [
      "selectors union: channel hit with a patient miss",
      { patientIds: [P], channelIds: [CH] },
      { channelId: CH },
      true,
    ],
    [
      "dateRange alone: inside",
      { dateRange: { from: "2020-01-01T00:00:00Z", to: "2020-12-31T00:00:00Z" } },
      {},
      true,
    ],
    [
      "dateRange alone: before",
      { dateRange: { from: "2021-01-01T00:00:00Z", to: "2021-12-31T00:00:00Z" } },
      {},
      false,
    ],
    [
      "dateRange narrows a selector hit",
      { channelIds: [CH], dateRange: { from: "2021-01-01T00:00:00Z", to: "2021-12-31T00:00:00Z" } },
      { channelId: CH },
      false,
    ],
    [
      "dateRange bounds are inclusive",
      { dateRange: { from: "2020-06-15T00:00:00Z", to: "2020-06-15T00:00:00Z" } },
      {},
      true,
    ],
  ])("%s", (_name, criteria, over, expected) => {
    expect(messageHeldBy(criteria, facts(over))).toBe(expected);
  });
});
