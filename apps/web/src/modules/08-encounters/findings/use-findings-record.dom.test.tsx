import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import { type AdlBody, IMMUTABLE_AFTER_SIGN, loadAdl, saveAdl } from "./findings-api";
import { ENCOUNTER_ID, type Handler, errorReply, mountWithApi } from "./findings-test-harness";
import { useFindingsRecord } from "./use-findings-record";

const OTHER_ENCOUNTER_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const EMPTY_ADL: AdlBody = { items: {}, bladder: null, bowel: null, devices: [] };

/** One record hook on a visit that can be switched, the way a composer URL changes under it. */
function Probe(): JSX.Element {
  const [encounterId, setEncounterId] = useState(ENCOUNTER_ID);
  const record = useFindingsRecord({
    encounterId,
    load: loadAdl,
    save: saveAdl,
    onSaved: () => {},
  });
  return (
    <>
      <button type="button" onClick={() => setEncounterId(OTHER_ENCOUNTER_ID)}>
        Other visit
      </button>
      <button type="button" onClick={() => void record.save(EMPTY_ADL)}>
        Save
      </button>
      <output>{record.locked ? "locked" : "open"}</output>
      <output>{record.failure ?? "no failure"}</output>
    </>
  );
}

/** The first visit is signed (every PUT to it is refused 409); the other takes writes. */
const handler: Handler = (request) => {
  if (request.method === "GET") return { json: null };
  return request.path.includes(ENCOUNTER_ID)
    ? errorReply(409, IMMUTABLE_AFTER_SIGN, "signed")
    : {
        json: { ...EMPTY_ADL, encounterId: OTHER_ENCOUNTER_ID, updatedAt: "2026-11-19T11:00:00Z" },
      };
};

describe("useFindingsRecord", () => {
  it("starts another visit unlocked and without the last visit's refusal", async () => {
    const user = userEvent.setup();
    mountWithApi(<Probe />, handler);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("locked")).toBeTruthy());
    expect(screen.queryByText("no failure")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Other visit" }));

    expect(await screen.findByText("open")).toBeTruthy();
    expect(screen.getByText("no failure")).toBeTruthy();
  });
});
