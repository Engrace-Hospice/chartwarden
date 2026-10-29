import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewConversationDialog } from "./new-conversation-dialog";

describe("context-free group creation", () => {
  it("creates a group from selected eligible colleagues", async () => {
    const peers = [
      { userId: "11111111-1111-4111-8111-111111111111", displayName: "Nurse One", roles: ["rn"] },
      { userId: "22222222-2222-4222-8222-222222222222", displayName: "Nurse Two", roles: ["rn"] },
    ];
    const api = {
      GET: vi.fn(() => Promise.resolve({ data: { staff: peers }, error: undefined })),
      POST: vi.fn(() =>
        Promise.resolve({ data: { channelId: "group-1", created: true }, error: undefined }),
      ),
    } as unknown as ApiClient;
    const onCreated = vi.fn(async () => true);
    render(
      <ApiClientProvider client={api}>
        <NewConversationDialog
          open
          organizationId="org-1"
          organizationName="North Hospice"
          currentUserId="owner-1"
          onClose={() => {}}
          onCreated={onCreated}
        />
      </ApiClientProvider>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Group" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
      target: { value: "Weekend team" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Nurse One rn" }));
    fireEvent.click(screen.getByRole("button", { name: "Nurse Two rn" }));
    fireEvent.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith("/api/v1/messaging/groups", {
        body: { title: "Weekend team", userIds: peers.map((peer) => peer.userId) },
      }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("group-1"));
  });
});
