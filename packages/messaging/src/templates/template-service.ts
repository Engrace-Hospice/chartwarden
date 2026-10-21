// @chartwarden/messaging - the TemplateService contract (M36 WP 2.8). Implemented by the in-memory double here and by the
// Drizzle service in apps/backend/src/modules/36-messaging/templates. Org and actor are always the server-side request
// context. Every refusal of an id that is not the caller's to touch is the same 404 a random id gets.
import type { TemplateCategory, TemplateScope, TemplateView } from "./template-model";

export interface TemplateActor {
  readonly organizationId: string;
  readonly userId: string;
}

export interface TemplateInput {
  readonly title: string;
  readonly body: string;
  readonly category: TemplateCategory;
}

export type TemplatePatch = Partial<TemplateInput>;

export interface OverlayInput {
  /** null = keep the platform title. */
  readonly title: string | null;
  /** null = keep the platform body. */
  readonly body: string | null;
  readonly isEnabled: boolean;
}

export interface PlatformTemplateAdminView {
  readonly id: string;
  readonly templateKey: string;
  readonly category: TemplateCategory;
  readonly floorTitle: string;
  readonly floorBody: string;
  readonly requiredPhrases: readonly string[];
  readonly overlay: (OverlayInput & { readonly updatedAt: string }) | null;
}

export interface TemplateAdminView {
  readonly platform: readonly PlatformTemplateAdminView[];
  readonly shared: readonly TemplateView[];
}

export interface TemplateService {
  /** What the caller's picker shows: platform (overlay applied), the org's shared, and the caller's own. */
  list(actor: TemplateActor): Promise<TemplateView[]>;
  get(actor: TemplateActor, id: string): Promise<TemplateView>;
  createPersonal(actor: TemplateActor, input: TemplateInput): Promise<TemplateView>;
  updatePersonal(actor: TemplateActor, id: string, patch: TemplatePatch): Promise<TemplateView>;
  deletePersonal(actor: TemplateActor, id: string): Promise<void>;
  /** The routes gate everything below on messaging.template.manage. */
  adminList(actor: TemplateActor): Promise<TemplateAdminView>;
  createShared(actor: TemplateActor, input: TemplateInput): Promise<TemplateView>;
  updateShared(actor: TemplateActor, id: string, patch: TemplatePatch): Promise<TemplateView>;
  deleteShared(actor: TemplateActor, id: string): Promise<void>;
  putOverlay(actor: TemplateActor, templateId: string, overlay: OverlayInput): Promise<void>;
  deleteOverlay(actor: TemplateActor, templateId: string): Promise<void>;
}

export type { TemplateScope };
