// apps/web/src/modules/03-authorization — the role-catalog WRITE controls (GAP-116, M3 §7.6).
//
// The Roles & Permissions screen was read-only against a backend that already serves the writes
// (POST /roles, PATCH /roles/:id, DELETE /roles/:id). Nothing here decides authorization: the server owns
// anti-escalation (a role may not confer a permission the actor lacks), the system-locked floor and the
// reserved-role rule, and every refusal is rendered in place. The controls only appear when the caller
// holds `role.manage` (GET /me/permissions) — a convenience, never the control.
import { Button, Modal, SelectField, TextField, useApiClient, useToast } from "@wardenx/ui";
import { useState } from "react";
import type { JSX } from "react";

export interface RoleRecord {
  roleId: string;
  organizationId: string | null;
  key: string;
  name: string;
  category: string;
  scopeLevel: string;
  systemDefault: boolean;
  systemLocked: boolean;
  enabled: boolean;
  customized: boolean;
  permissionKeys: string[];
}

/** The server's refusal text if it sent one, else the fallback. */
function refusal(error: unknown, fallback: string): string {
  const e = error as { error?: { message?: string }; message?: string } | undefined;
  return e?.error?.message ?? e?.message ?? fallback;
}

const KEY_PATTERN = /^[a-z0-9_]+$/;

/** "New role" — a tenant role cloned from the selected one (its category, its permission set). */
export function NewRoleModal({
  open,
  base,
  categories,
  onClose,
  onCreated,
}: {
  open: boolean;
  base: RoleRecord | null;
  categories: readonly string[];
  onClose: () => void;
  onCreated: (role: RoleRecord) => void;
}): JSX.Element | null {
  const client = useApiClient();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState(base?.category ?? categories[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;

  const keyValid = KEY_PATTERN.test(key);
  const canSubmit = keyValid && name.trim() !== "" && category !== "" && !busy;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await client.POST("/api/v1/roles", {
      body: {
        key,
        name: name.trim(),
        // The options come from the roles the server already returned, so this is a member of its enum.
        category: category as never,
        ...(base ? { clonedFromKey: base.key, permissionKeys: base.permissionKeys } : {}),
      },
    });
    setBusy(false);
    if (res.error || !res.data) {
      setError(refusal(res.error, "The role could not be created."));
      return;
    }
    toast.show("Role created", { tone: "success" });
    onCreated(res.data as unknown as RoleRecord);
    setKey("");
    setName("");
    onClose();
  }

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} ariaLabel="New role" width="30rem">
      <div style={{ padding: "1.5rem", display: "grid", gap: "0.75rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>New role</h2>
        <p style={{ margin: 0, fontSize: "0.82rem" }}>
          {base
            ? `Starts as a copy of ${base.name} (${base.permissionKeys.length} permissions). You can only grant permissions you hold yourself.`
            : "Starts with no permissions."}
        </p>
        <TextField
          label="Role key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          hint="Lower-case letters, digits and underscores"
          {...(key && !keyValid
            ? { error: "Use lower-case letters, digits and underscores only" }
            : {})}
        />
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <SelectField
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          options={categories.map((c) => ({ value: c, label: c.replace(/_/g, " ") }))}
        />
        {error ? (
          <p role="alert" style={{ margin: 0, color: "var(--color-error)", fontSize: "0.82rem" }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? "Creating..." : "Create role"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The per-role action bar: edit the permission set, enable/disable, delete. A platform template is not
 * editable in place — it offers "Customize" (a tenant copy) through the New role dialog instead.
 */
export function RoleActions({
  role,
  editing,
  draftCount,
  dirty,
  onStartEdit,
  onCancelEdit,
  onSave,
  onToggleEnabled,
  onDelete,
  onCustomize,
  busy,
  error,
}: {
  role: RoleRecord;
  editing: boolean;
  draftCount: number;
  dirty: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
  onCustomize: () => void;
  busy: boolean;
  error: string | null;
}): JSX.Element {
  const tenantRole = role.organizationId !== null;
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div style={{ display: "grid", gap: "0.5rem", flex: "1 1 100%" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
        {tenantRole ? (
          editing ? (
            <>
              <Button onClick={onSave} disabled={busy || !dirty}>
                {busy ? "Saving..." : `Save ${draftCount} permissions`}
              </Button>
              <Button tone="tertiary" onClick={onCancelEdit} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onStartEdit} disabled={busy}>
                Edit permissions
              </Button>
              <Button tone="secondary" onClick={onToggleEnabled} disabled={busy}>
                {role.enabled ? "Disable role" : "Enable role"}
              </Button>
              {role.systemLocked ? null : confirmDelete ? (
                <>
                  <Button tone="danger" onClick={onDelete} disabled={busy}>
                    Confirm delete
                  </Button>
                  <Button tone="tertiary" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button tone="tertiary" onClick={() => setConfirmDelete(true)} disabled={busy}>
                  Delete role
                </Button>
              )}
            </>
          )
        ) : (
          <Button onClick={onCustomize}>Customize for this organization</Button>
        )}
      </div>
      {error ? (
        <p role="alert" style={{ margin: 0, color: "var(--color-error)", fontSize: "0.82rem" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** PATCH /roles/:id — returns the updated role, or the server's refusal text. */
export async function patchRole(
  client: ReturnType<typeof useApiClient>,
  roleId: string,
  body: { name?: string; enabled?: boolean; permissionKeys?: string[] },
): Promise<{ ok: true; role: RoleRecord } | { ok: false; message: string }> {
  const res = await client.PATCH("/api/v1/roles/{id}", {
    params: { path: { id: roleId } },
    body,
  });
  if (res.error || !res.data)
    return { ok: false, message: refusal(res.error, "The role could not be saved.") };
  return { ok: true, role: res.data as unknown as RoleRecord };
}

/** DELETE /roles/:id. */
export async function deleteRole(
  client: ReturnType<typeof useApiClient>,
  roleId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await client.DELETE("/api/v1/roles/{id}", {
    params: { path: { id: roleId } },
  });
  if (res.error)
    return { ok: false, message: refusal(res.error, "The role could not be deleted.") };
  return { ok: true };
}
