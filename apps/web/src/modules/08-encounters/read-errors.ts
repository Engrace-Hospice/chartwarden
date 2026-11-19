// apps/web/src/modules/08-encounters — reading an API error body for the encounter record's forms: the message to show, and the
// per-field messages of a validation refusal. Pure; moved out of encounter-read.tsx unchanged so that file does not grow.

export function errorMessage(error: unknown, fallback: string): string {
  const body = error as {
    message?: string;
    title?: string;
    detail?: string;
    code?: string;
    error?: {
      message?: string;
      title?: string;
      detail?: string;
      code?: string;
    };
  } | null;

  if (body?.detail) return body.detail;
  if (body?.message) return body.message;
  if (body?.title) return body.title;
  if (body?.error?.detail) return body.error.detail;
  if (body?.error?.message) return body.error.message;
  if (body?.error?.title) return body.error.title;

  return fallback;
}

export type FieldErrors = Record<string, string>;

export function validationDetails(error: unknown): Array<{ field?: string; message?: string }> {
  const body = error as {
    details?: unknown;
    error?: {
      details?: unknown;
    };
  } | null;

  const raw = body?.error?.details ?? body?.details;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((detail) => {
    if (typeof detail !== "object" || detail === null) return [];

    const row = detail as {
      field?: unknown;
      path?: unknown;
      message?: unknown;
    };

    const field =
      typeof row.field === "string"
        ? row.field
        : typeof row.path === "string"
          ? row.path
          : undefined;

    return [
      {
        field,
        message: typeof row.message === "string" ? row.message : undefined,
      },
    ];
  });
}

export function fieldKeyFromPath(path: string | undefined): string | null {
  if (!path) return null;

  const normalized = path
    .replace(/^body\./, "")
    .replace(/^data\./, "")
    .replace(/^selections\./, "");

  if (
    normalized.includes("clinicalSummary") ||
    normalized === "finalDocumentation" ||
    normalized === "documentation" ||
    normalized === "narrative"
  ) {
    return "clinicalSummary";
  }

  return normalized.split(".").filter(Boolean).at(-1) ?? null;
}

export function fieldErrorsFrom(error: unknown, supportedFields: readonly string[]): FieldErrors {
  const supported = new Set(supportedFields);
  const result: FieldErrors = {};

  for (const detail of validationDetails(error)) {
    const key = fieldKeyFromPath(detail.field);

    if (key && supported.has(key) && detail.message && !result[key]) {
      result[key] = detail.message;
    }
  }

  return result;
}
