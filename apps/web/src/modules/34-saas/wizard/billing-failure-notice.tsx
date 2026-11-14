// apps/web/src/modules/34-saas/wizard — the billing panels' refusal notice. It is only ever shown when the refusal is NOT beside an input (a
// refusal that names a rendered field is read under that field, and this is not drawn), so a validation refusal that reaches it names
// only fields the member cannot see (the server's `(root)` for an unknown shape). It is read as the plain refusal it is, with its own
// sentence, not as "some details need attention" about inputs that are not on screen.
import { WriteFailureNotice, type WriteFailureNoticeProps } from "@chartwarden/ui";
import type { JSX } from "react";

export function BillingFailureNotice(props: WriteFailureNoticeProps): JSX.Element {
  return <WriteFailureNotice {...props} failure={{ ...props.failure, fieldErrors: {} }} />;
}
