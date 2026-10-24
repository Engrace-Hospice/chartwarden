# CHARTWARDEN_UI_APPOINTMENT_FORMS

Route `/remittance/representative-forms` (module 25, milestone 13a). Requires `representative_form.configure`.

The organization's own appointment-of-representative form versions, entered by compliance exactly as supplied: name, form identifier
and edition as entered, a mandatory source note, an optional verified-on date and the required-element labels (one per line).
ChartWarden ships none and does not validate them against any CMS form. A version is frozen once saved; to change it, retire it and
add a new one. With none entered the screen says "No appointment form configured for your organisation - ask compliance to add one"
and appointments can only be recorded against another written instrument.

The beneficiary-filed appeal and appointment-of-representative sections live on the claim rail of the denial and appeal detail panels
(`beneficiary-section.tsx`): record-only copy ("ChartWarden records this appeal; it does not file it."), visible prompts for every
absence ("No appointment of representative on file", "Validity end not recorded", "No due date recorded - enter it from the notice"),
disabled actions that say why (aria-describedby), keyed drawers, stale-response guards, 409 reloads that keep typed values.

Use Admin Settings Layout.
