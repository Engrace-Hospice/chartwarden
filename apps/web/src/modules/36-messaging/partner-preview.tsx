// M36 WP 6.6 (ADR-0096 D22, PROPOSED) - what the partner will see, for STAFF, shown in the share dialog (before the minimum-necessary box is ticked) and again
// next to the one-time link. It renders the SAME PartnerConversationView the partner page does, with SYNTHETIC messages: a live "as the partner" read
// would need a staff route that runs the partner reader (a second, content-bearing read path with its own audit), and a preview of REAL messages would
// put in front of the sharer exactly the content the filter exists to second-guess. The synthetic text is fixed here, contains no identifier, and is
// labelled "Example". The lists below are the rules of D2 and D16 in plain words; they are not computed from the channel.
import type { PartnerMessageDto } from "@chartwarden/types";
import type { JSX } from "react";
import { PartnerConversationView } from "./partner-conversation-view";

const EXAMPLE: readonly PartnerMessageDto[] = [
  {
    messageId: "example-1",
    authorName: "A staff member",
    body: "The weekly delivery is moving to Thursday.",
    createdAt: "2026-01-01T09:00:00.000Z",
    edited: false,
  },
  {
    messageId: "example-2",
    authorName: "Another staff member",
    body: "Thanks. Please confirm the new window by end of day.",
    createdAt: "2026-01-01T09:04:00.000Z",
    edited: false,
  },
];

export function PartnerPreview({
  partnerName,
  accessEndsText,
}: {
  readonly partnerName: string;
  readonly accessEndsText: string;
}): JSX.Element {
  return (
    <section aria-label="What the partner will see" className="wx-export-notice">
      <p className="wx-export-detail">
        <strong>What the partner will see.</strong> The partner opens the link, enters the code you
        give them separately, then reads the conversation as below (example text, not your
        messages). ChartWarden does not send the link or the code: you hand both over yourself.
      </p>
      <PartnerConversationView
        example
        partnerName={partnerName.trim() === "" ? "the partner" : partnerName.trim()}
        messages={EXAMPLE}
        accessEndsText={accessEndsText}
      />
      <p className="wx-export-detail">
        <strong>Shown:</strong> messages posted after you share, with the sender's display name and
        time. <strong>Never shown:</strong> earlier messages, attachments, clinical links, mentions,
        urgent or acknowledgment-requested messages, redacted messages, messages under a legal hold,
        and the member list. <strong>Withheld, not masked:</strong> any message containing a date of
        birth, a record, account or phone number, an email or a street address.{" "}
        <strong>Not detected:</strong> patient names and indirect details written in ordinary words,
        which the partner would read as typed.
      </p>
    </section>
  );
}
