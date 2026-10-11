import type { ApiClient } from "@wardenx/ui";

export type AuthenticationContinuation =
  | { readonly kind: "password-change" }
  | { readonly kind: "organization" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Resolve the next post-credential step from the server-owned credential state. MFA remains a
 * Better Auth concern and calls this only after its challenge has completed.
 */
export async function authenticationContinuation(
  client: ApiClient,
): Promise<AuthenticationContinuation> {
  const { data, error } = await client.GET("/api/v1/auth/credential-status");
  if (error || !data) {
    return {
      kind: "error",
      message: "We could not verify your account setup state. Please sign in again.",
    };
  }
  return data.passwordChangeRequired ? { kind: "password-change" } : { kind: "organization" };
}

export function continuationPath(continuation: AuthenticationContinuation): string | null {
  if (continuation.kind === "password-change") return "/login/change-password";
  if (continuation.kind === "organization") return "/login/organization";
  return null;
}
