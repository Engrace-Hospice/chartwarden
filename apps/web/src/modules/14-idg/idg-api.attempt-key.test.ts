// The IDG writes whose contract DECLARES the Idempotency-Key header: each holds one key per intent (see ../__tests__/declared-key-contract).
import { type WriteSite, describeDeclaredKeyContract } from "../__tests__/declared-key-contract";
import {
  createDisciplineNote,
  excuseAttendance,
  scheduleMeeting,
  updateActionItem,
  updateAttendance,
  updateDisciplineNote,
} from "./idg-api";

const ID = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const noteText = (changed?: boolean): string => (changed ? "Pain controlled" : "Pain improving");

const SITES: readonly WriteSite[] = [
  ["updateAttendance", (c, changed) => updateAttendance(c, ID, "tardy", changed ? 4 : 3)],
  ["excuseAttendance", (c, changed) => excuseAttendance(c, ID, changed ? 4 : 3)],
  ["updateActionItem", (c, changed) => updateActionItem(c, ID, "completed", changed ? 4 : 3)],
  [
    "scheduleMeeting",
    (c, changed) =>
      scheduleMeeting(c, {
        locationId: ID,
        startsAt: changed ? "2026-12-02T15:00:00Z" : "2026-12-01T15:00:00Z",
        endsAt: "2026-12-01T16:00:00Z",
      } as never),
  ],
  [
    "createDisciplineNote",
    (c, changed) =>
      createDisciplineNote(c, ID, {
        patientId: PATIENT,
        discipline: "rn",
        bodyText: noteText(changed),
      }),
  ],
  [
    "updateDisciplineNote",
    (c, changed) => updateDisciplineNote(c, ID, 3, { bodyText: noteText(changed) }),
  ],
];

describeDeclaredKeyContract("IDG writes that name the Idempotency-Key header", SITES);
