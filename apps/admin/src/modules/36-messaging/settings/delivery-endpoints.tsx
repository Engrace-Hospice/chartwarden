// apps/admin/src/modules/36-messaging/settings — M36 §4.2 delivery endpoints (`POST /api/v1/notifications/endpoints`,
// `POST .../:id/verify`, `DELETE .../:id`; notifications.endpoint.manage; SELF-only). Register a push / sms /
// email target, confirm the code sent to it, remove it.
// ponytail: the API has NO list route, so only endpoints registered in this session appear (id + channel +
// target held in component state). Add a GET /notifications/endpoints list route to show earlier ones.
import {
  Button,
  SelectField,
  StatusPill,
  TextField,
  focusFirstInvalid,
  useApiClient,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { StateEmpty, useRestoreFocus } from "../ui";
import { humanize } from "./alert-rules";
import { toResult } from "./api";
import { type Banner, BannerView, PageHead } from "./ui";

type EndpointView =
  operations["postApiV1NotificationsEndpoints"]["responses"][200]["content"]["application/json"];
interface Endpoint extends EndpointView {
  readonly target: string;
}

const CHANNEL_OPTIONS = [
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "push", label: "Push" },
];
const STATUS_TONE = { verified: "success", pending: "progress", expired: "warning" } as const;

export function DeliveryEndpoints(): JSX.Element {
  const client = useApiClient();
  const [endpoints, setEndpoints] = useState<readonly Endpoint[]>([]);
  const [channel, setChannel] = useState<EndpointView["channel"]>("email");
  const [target, setTarget] = useState("");
  const [tokens, setTokens] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [registerAttempted, setRegisterAttempted] = useState(false);
  const [verifyAttempted, setVerifyAttempted] = useState<ReadonlySet<string>>(new Set());
  const formRef = useRef<HTMLFormElement>(null);
  // Fields and buttons are disabled while an action is in flight (dropping focus), and a verified row loses its
  // code field; focus goes back to where it was, else to the address field.
  const captureFocus = useRestoreFocus(busy !== null, () =>
    formRef.current?.querySelector("input"),
  );

  // A 403 on one action is that action's banner; it never hides the page or the endpoints already listed.
  const fail = (message: string, isForbidden: boolean): void =>
    setBanner({
      ok: false,
      message: isForbidden ? "You do not have access to delivery endpoints." : message,
    });

  const register = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setRegisterAttempted(true);
    if (target.trim() === "") {
      focusFirstInvalid(formRef.current);
      return;
    }
    captureFocus();
    setBusy("register");
    setBanner(null);
    const res = await client.POST("/api/v1/notifications/endpoints", {
      body: { channel, target: target.trim() },
    });
    const result = toResult(res, "Could not add the endpoint.");
    setBusy(null);
    if (!result.ok) return fail(result.message, result.forbidden);
    setEndpoints((list) => [...list, { ...result.data, target: target.trim() }]);
    setTarget("");
    setRegisterAttempted(false);
    setBanner({ ok: true, message: "Endpoint added. Enter the verification code sent to it." });
  };

  const verify = async (endpoint: Endpoint, row: ParentNode | null): Promise<void> => {
    setVerifyAttempted((seen) => new Set(seen).add(endpoint.endpointId));
    if ((tokens[endpoint.endpointId] ?? "").trim() === "") {
      focusFirstInvalid(row);
      return;
    }
    captureFocus();
    setBusy(endpoint.endpointId);
    setBanner(null);
    const res = await client.POST("/api/v1/notifications/endpoints/{id}/verify", {
      params: { path: { id: endpoint.endpointId } },
      body: { token: (tokens[endpoint.endpointId] ?? "").trim() },
    });
    const result = toResult(res, "That code was not accepted.");
    setBusy(null);
    if (!result.ok) return fail(result.message, result.forbidden);
    setEndpoints((list) =>
      list.map((e) =>
        e.endpointId === endpoint.endpointId
          ? { ...e, verificationStatus: result.data.verificationStatus }
          : e,
      ),
    );
    setBanner(
      result.data.verificationStatus === "verified"
        ? { ok: true, message: `${endpoint.target} is verified.` }
        : { ok: false, message: "That code was not accepted. Check it and try again." },
    );
  };

  const remove = async (endpoint: Endpoint): Promise<void> => {
    captureFocus();
    setBusy(endpoint.endpointId);
    setBanner(null);
    const res = await client.DELETE("/api/v1/notifications/endpoints/{id}", {
      params: { path: { id: endpoint.endpointId } },
    });
    const result = toResult(res, "Could not remove the endpoint.");
    setBusy(null);
    if (!result.ok) return fail(result.message, result.forbidden);
    setEndpoints((list) => list.filter((e) => e.endpointId !== endpoint.endpointId));
    setBanner({ ok: true, message: `${endpoint.target} removed.` });
  };

  return (
    <div className="wx-list-drawer-main">
      <PageHead
        title="Delivery endpoints"
        sub="Email, SMS and push targets your alerts are delivered to. Each must be verified."
      />
      <BannerView banner={banner} />
      <form ref={formRef} noValidate className="wx-form-stack" onSubmit={(e) => void register(e)}>
        <SelectField
          label="Channel"
          options={CHANNEL_OPTIONS}
          value={channel}
          disabled={busy !== null}
          onChange={(e) => setChannel(e.target.value as EndpointView["channel"])}
        />
        <TextField
          label="Address or device token"
          required
          maxLength={512}
          value={target}
          disabled={busy !== null}
          onChange={(e) => setTarget(e.target.value)}
          error={
            registerAttempted && target.trim() === ""
              ? "Enter the address or device token to register."
              : undefined
          }
        />
        <div className="wx-drawer-actions">
          <Button type="submit" size="lg" loading={busy === "register"}>
            Add endpoint
          </Button>
        </div>
      </form>
      {endpoints.length === 0 ? (
        <StateEmpty>No endpoints added in this session. Add one above.</StateEmpty>
      ) : (
        <ul className="grid gap-3" aria-label="Endpoints added this session">
          {endpoints.map((endpoint) => (
            <li key={endpoint.endpointId} className="wx-drawer-card flex flex-wrap items-end gap-3">
              <div className="grid gap-1">
                <span className="wx-row-title">{endpoint.target}</span>
                <span className="wx-row-sub">{humanize(endpoint.channel)}</span>
              </div>
              <StatusPill
                tone={STATUS_TONE[endpoint.verificationStatus]}
                label={humanize(endpoint.verificationStatus)}
              />
              {endpoint.verificationStatus === "verified" ? null : (
                <>
                  <TextField
                    label={`Verification code for ${endpoint.target}`}
                    maxLength={64}
                    value={tokens[endpoint.endpointId] ?? ""}
                    disabled={busy !== null}
                    error={
                      verifyAttempted.has(endpoint.endpointId) &&
                      (tokens[endpoint.endpointId] ?? "").trim() === ""
                        ? "Enter the verification code that was sent."
                        : undefined
                    }
                    onChange={(e) => {
                      const token = e.target.value;
                      setTokens((t) => ({ ...t, [endpoint.endpointId]: token }));
                    }}
                  />
                  <Button
                    tone="secondary"
                    size="lg"
                    loading={busy === endpoint.endpointId}
                    disabled={busy !== null}
                    aria-label={`Verify ${endpoint.target}`}
                    onClick={(e) => void verify(endpoint, e.currentTarget.closest("li"))}
                  >
                    Verify
                  </Button>
                </>
              )}
              <Button
                tone="tertiary"
                size="lg"
                disabled={busy !== null}
                aria-label={`Remove ${endpoint.target}`}
                onClick={() => void remove(endpoint)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
