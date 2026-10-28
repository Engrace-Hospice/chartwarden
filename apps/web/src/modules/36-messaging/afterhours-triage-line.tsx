// M36 ADR-0082 slice S5 (PROPOSED, flag `messaging.afterhours_triage`) - the one-line result of an after-hours triage request, shown under the
// message that asked for it: a closed sentence from the server, with an icon AND words (never colour alone). "Triage call not confirmed" is a
// visible state, not an error. The line carries no triage content. A flag-off tenant, a failed read or a message with no request shows nothing.
import {
  AFTERHOURS_TRIAGE_LINE_TEXT,
  type AckRequestDto,
  type AfterHoursTriageLineDto,
  type AfterHoursTriageLineState,
} from "@chartwarden/types";
import { BACKGROUND_REQUEST_HEADERS, Glyph, useApiClient } from "@chartwarden/ui";
import { type JSX, useEffect, useState } from "react";

const LINES_PATH = "/api/v1/messaging/channels/{id}/afterhours-triage";
/** The server answers for at most this many messages per read. */
export const AFTERHOURS_LINES_MAX = 50;

const ICONS: Readonly<Record<AfterHoursTriageLineState, "clock" | "check" | "alert" | "info">> = {
  not_confirmed: "clock",
  opened: "check",
  coalesced: "check",
  no_coverage: "alert",
  withheld: "info",
};

interface LinesClient {
  GET(
    path: string,
    init: {
      params: { path: { id: string }; query: { message_ids: string } };
      headers?: Readonly<Record<string, string>>;
    },
  ): Promise<{ data?: { lines?: AfterHoursTriageLineDto[] }; response?: { status: number } }>;
}

/** The lines of the role-addressed requests of one channel, by message id. Empty on any failure (the line is informational). */
export function useAfterHoursLines(
  channelId: string,
  enabled: boolean,
  requests: readonly AckRequestDto[],
): ReadonlyMap<string, AfterHoursTriageLineDto> {
  const client = useApiClient() as unknown as LinesClient;
  const [lines, setLines] = useState<ReadonlyMap<string, AfterHoursTriageLineDto>>(new Map());
  const ids = requests
    .filter((r) => r.addressed_role)
    .map((r) => r.message_id)
    .slice(0, AFTERHOURS_LINES_MAX);
  const key = `${channelId}|${enabled}|${ids.join(",")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` summarises channelId, enabled and ids
  useEffect(() => {
    let live = true;
    if (!enabled || ids.length === 0) {
      setLines(new Map());
      return;
    }
    void Promise.resolve()
      .then(() =>
        client.GET(LINES_PATH, {
          params: { path: { id: channelId }, query: { message_ids: ids.join(",") } },
          headers: BACKGROUND_REQUEST_HEADERS,
        }),
      )
      .then(
        (result) => {
          if (live) setLines(new Map((result?.data?.lines ?? []).map((l) => [l.message_id, l])));
        },
        () => {
          if (live) setLines(new Map());
        },
      );
    return () => {
      live = false;
    };
  }, [key, client]);
  return lines;
}

export function AfterHoursTriageLine({ line }: { line: AfterHoursTriageLineDto }): JSX.Element {
  return (
    <p className="wx-afterhours-line" data-afterhours-line={line.state}>
      <Glyph name={ICONS[line.state]} size={14} />{" "}
      <span>{AFTERHOURS_TRIAGE_LINE_TEXT[line.state]}</span>
    </p>
  );
}
