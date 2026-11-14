// @chartwarden/ui web — the attributes of a write-only secret input (a vendor credential, a client secret): a password field that asks the
// browser and the common password managers NOT to offer to save, fill or correct it. A mitigation only (a browser may ignore
// `autocomplete="off"` on a password field), which is why the secret is also never stashed or kept in state past its write.
export const SECRET_INPUT_PROPS = {
  type: "password",
  autoComplete: "new-password",
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true,
} as const;
