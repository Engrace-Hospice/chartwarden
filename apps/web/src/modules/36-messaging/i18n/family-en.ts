// M36 WP 6.7 (ADR-0099 D11, PROPOSED) - every string of the family / caregiver messaging surfaces, as keys under `family.*` in the ADR-0093 catalogue.
// English is the source and the only language written: no Spanish is provided here, so a contact whose saved preference selects `es` sees these English
// strings (the catalogue's fallback rule), and a reviewed translation must be added before any other locale is switched on. The bereavement wording
// (`family.bereavement.*`) and the dead-link wording (`family.dead.*`) are PLACEHOLDERS for the bereavement coordinator and the privacy officer to replace.
// Free text a contact or a staff member types is never translated.
import {
  FAMILY_BEREAVEMENT_NOTIFICATION_TEXT,
  FAMILY_MESSAGE_MAX_CHARS,
  FAMILY_NOTIFICATION_TEXT,
  FAMILY_NOT_EMERGENCY_TEXT,
} from "@chartwarden/types";

export const FAMILY_EN = {
  // Fixed outbound text (D7, D15). No sender is wired in this build.
  "family.notification.text": FAMILY_NOTIFICATION_TEXT,
  "family.notification.bereavement.text": FAMILY_BEREAVEMENT_NOTIFICATION_TEXT,
  "family.notEmergency": FAMILY_NOT_EMERGENCY_TEXT,

  // The contact's page.
  "family.page.title": "Secure message",
  "family.contact.heading": "Secure message",
  "family.contact.agencyPhone": "Agency 24-hour number:",
  "family.contact.opening": "Opening your secure message.",
  "family.contact.network":
    "We could not reach the service. Please check your connection and try again.",
  "family.contact.retry": "Try again",
  "family.dead.heading": "Secure message",
  "family.dead.text":
    "This link is no longer active. Please call the agency number you were given.",
  "family.dead.call": "Call the agency: {phone}",
  "family.code.heading": "Enter your code",
  "family.code.help":
    "Enter the 8-digit code the care team gave you by phone. It is not in the link.",
  "family.code.label": "8-digit code",
  "family.code.submit": "Continue",
  "family.code.checking": "Checking",
  "family.code.format": "Enter the 8 digits exactly as you were given them.",
  "family.code.invalid": "That code is not correct. Please check it and try again.",
  "family.code.limited": "Too many tries. Please wait a few minutes and try again.",
  "family.thread.heading": "Messages with your care team",
  "family.thread.intro":
    "Write to your care team here. They read these messages during working hours and will reply as soon as they can.",
  "family.thread.empty": "There are no messages yet. You can write the first one below.",
  "family.thread.log": "Messages",
  "family.thread.closed": "This conversation is closed, please call the agency.",
  "family.thread.refreshFailed":
    "We could not refresh just now. The messages below may be out of date.",
  "family.thread.more": "Show more messages",
  "family.thread.moreBusy": "Loading",
  "family.message.you": "You",
  "family.message.careTeam": "Care team",
  "family.message.received": "Received by the care team",
  "family.refresh": "Refresh",
  "family.refreshing": "Refreshing",
  "family.send.label": "Your message",
  "family.send.button": "Send",
  "family.send.sending": "Sending",
  "family.send.counter": "{n} of {max} characters",
  "family.send.tooLong": "That message is longer than {max} characters. Please shorten it.",
  "family.send.empty": "Write a message first.",
  "family.send.sent": "Your message was sent.",
  "family.send.closed": "This conversation is closed, please call the agency.",
  "family.send.limited":
    "Please wait a little while before sending another message. If you need help sooner, please call the agency.",
  "family.send.failed": "Your message was not sent. Please check your connection and try again.",

  // Bereavement mode (D15): calmer wording, no clinical terms. PLACEHOLDER wording for the bereavement coordinator.
  "family.bereavement.heading": "Your messages",
  "family.bereavement.intro":
    "We are thinking of you. You can write to us here, and someone will reply as soon as they can.",
  "family.bereavement.phone": "Support line:",
  "family.bereavement.empty":
    "There are no messages yet. You can write to us below whenever you wish.",
  "family.bereavement.message.careTeam": "Support team",

  // The staff Family lane.
  "family.lane.title": "Family",
  "family.lane.breadcrumb": "Messaging",
  "family.lane.intro":
    "People the patient has agreed may write to the care team without an app. Everything you write here, the contact can read. It is not a chart note.",
  "family.lane.list": "Family contacts",
  "family.lane.empty.title": "No family contacts",
  "family.lane.empty.text": "Invited family contacts appear here.",
  "family.lane.loadFailed": "The family contacts could not be loaded.",
  "family.lane.denied": "You do not have access to the family lane.",
  "family.lane.notOn": "Family messaging is not turned on for your organisation.",
  "family.lane.notOn.detail": "Existing contacts can still be listed, closed, blocked and revoked.",
  "family.lane.retry": "Retry",
  "family.row.for": "About {patient}",
  "family.row.consent": "Consent: {state}",
  "family.row.link": "Link: {state}",
  "family.row.waiting": "Unanswered for {age}",
  "family.row.nothingWaiting": "Nothing waiting",
  "family.row.language": "Language: {language}",
  "family.row.languageUnknown": "Language not recorded",
  "family.chip.highVolume": "High volume",
  "family.chip.closed": "Closed",
  "family.chip.blocked": "Blocked",
  "family.chip.bereavement": "Bereavement",
  "family.row.open": "Open the conversation",

  "family.consent.ok": "Consent in place",
  "family.consent.no_consent": "No consent",
  "family.consent.involvement_ended": "No longer involved",
  "family.consent.part2_restricted": "Restricted record",
  "family.consent.patient_status": "Patient status does not allow it",
  "family.consent.not_in_bereavement_plan": "Not in the bereavement plan",
  "family.consent.blocked": "Blocked",
  "family.eligibility.ok": "Can be invited.",
  "family.eligibility.no_consent": "Cannot be invited: there is no consent for this person.",
  "family.eligibility.involvement_ended":
    "Cannot be invited: this person is no longer involved in the patient's care.",
  "family.eligibility.part2_restricted": "Cannot be invited: the patient's record is restricted.",
  "family.eligibility.patient_status":
    "Cannot be invited: the patient's status does not allow family messaging.",
  "family.eligibility.not_in_bereavement_plan":
    "Cannot be invited: this person is not in the bereavement plan.",
  "family.eligibility.blocked": "Cannot be invited: this contact is blocked.",
  "family.link.none": "No link",
  "family.link.not_opened": "Not opened yet",
  "family.link.verifying": "Waiting for the code",
  "family.link.active": "In use",
  "family.link.locked": "Locked after wrong codes",
  "family.link.expired": "Expired",
  "family.link.revoked": "Revoked",

  // The conversation drawer.
  "family.thread.drawerLabel": "Family conversation",
  "family.thread.close": "Close conversation panel",
  "family.thread.loading": "Loading the conversation",
  "family.thread.loadFailed": "The conversation could not be loaded.",
  "family.thread.noMessages": "No messages yet.",
  "family.thread.fromContact": "Family contact",
  "family.thread.fromStaffUnknown": "Care team member",
  "family.thread.language": "Contact language: {language}",
  "family.thread.reload": "Reload",
  "family.composer.label": "Reply to {name}",
  "family.composer.persistent":
    "The contact can read this reply. It is not a chart note and is not added to the patient's record as one.",
  "family.composer.send": "Send reply",
  "family.composer.sending": "Sending",
  "family.composer.sent": "Reply sent.",
  "family.composer.closed": "This conversation is closed. Reopen it to reply.",
  "family.composer.blocked": "This contact is blocked, so you cannot reply.",
  "family.composer.failed": "The reply was not sent. Try again.",
  "family.composer.notOn":
    "Family messaging is not turned on for your organisation, so replies cannot be sent.",
  "family.composer.cannot": "This contact cannot be replied to right now.",

  // Manage actions.
  "family.manage.invite": "Invite a family contact",
  "family.manage.settings": "Settings",
  "family.manage.revoke": "Revoke link",
  "family.manage.close": "Close conversation",
  "family.manage.reopen": "Reopen conversation",
  "family.manage.block": "Block contact",
  "family.manage.unblock": "Unblock contact",
  "family.manage.cancel": "Keep as is",
  "family.manage.failed": "That did not work. Check the list and try again.",
  "family.manage.denied": "You do not have permission to do that.",
  "family.manage.signIn": "Your session has ended. Sign in again.",
  "family.manage.limit": "Too many requests. Wait a moment and try again.",
  "family.manage.notAvailable": "That contact is no longer available.",
  "family.manage.done.revoke": "The link was revoked. The contact's next request is refused.",
  "family.manage.done.close": "The conversation is closed.",
  "family.manage.done.reopen": "The conversation is open again.",
  "family.manage.done.block": "The contact is blocked.",
  "family.manage.done.unblock": "The contact is unblocked.",
  "family.confirm.revoke.title": "Revoke the link for {name}?",
  "family.confirm.revoke.text":
    "The link and the code stop working at once. To give access again you create a new invitation.",
  "family.confirm.revoke.yes": "Yes, revoke the link",
  "family.confirm.close.title": "Close the conversation with {name}?",
  "family.confirm.close.text":
    "The contact can still read it but cannot send. You can reopen it later.",
  "family.confirm.close.yes": "Yes, close it",
  "family.confirm.reopen.title": "Reopen the conversation with {name}?",
  "family.confirm.reopen.text": "The contact will be able to send messages again.",
  "family.confirm.reopen.yes": "Yes, reopen it",
  "family.confirm.block.title": "Block {name}?",
  "family.confirm.block.text":
    "The link is revoked and the contact cannot read or send. A block can only be lifted by a different person.",
  "family.confirm.block.yes": "Yes, block the contact",
  "family.confirm.unblock.title": "Unblock {name}?",
  "family.confirm.unblock.text":
    "The contact is no longer blocked. You will need to invite them again. This must be done by a different person from the one who blocked them.",
  "family.confirm.unblock.yes": "Yes, unblock the contact",

  // Settings panel.
  "family.settings.title": "Family messaging settings",
  "family.settings.agencyName": "Neutral sender name",
  "family.settings.agencyName.hint": "Shown to contacts. Avoid words that reveal hospice care.",
  "family.settings.agencyPhone": "24-hour number",
  "family.settings.agencyPhone.hint":
    "Required before anyone can be invited. Shown on every page the contact sees.",
  "family.settings.bereavementPhone": "Bereavement support number",
  "family.settings.save": "Save settings",
  "family.settings.saved": "Settings saved.",
  "family.settings.failed": "The settings could not be saved.",
  "family.settings.tooLong": "At most {max} characters.",
  "family.settings.close": "Close",
  "family.settings.loadFailed": "The settings could not be loaded.",
  "family.settings.missing":
    "Set the 24-hour number first. An invitation cannot be created until it exists.",
  "family.settings.missing.link": "Open the settings",

  // Invite dialog.
  "family.invite.title": "Invite a family contact",
  "family.invite.patientId": "Patient ID",
  "family.invite.patientId.hint": "Paste the patient's ID, then look up who can be invited.",
  "family.invite.patientId.invalid": "Enter the patient ID as a UUID.",
  "family.invite.lookup": "Look up contacts",
  "family.invite.looking": "Looking up",
  "family.invite.none": "This patient has no caregivers on record.",
  "family.invite.pick": "Who should be invited",
  "family.invite.pick.required": "Choose a person to invite.",
  "family.invite.legalRep": "Legal representative",
  "family.invite.days": "Days until the link expires",
  "family.invite.days.invalid": "Choose 1 to {max} days.",
  "family.invite.byVoice": "I will give the code by phone, never in the same message as the link.",
  "family.invite.byVoice.required": "Confirm how the code will be given.",
  "family.invite.create": "Create invitation",
  "family.invite.creating": "Creating",
  "family.invite.cancel": "Cancel",
  "family.invite.notOn":
    "Family messaging is not turned on for your organisation, so an invitation cannot be created.",
  "family.invite.notEligible": "This person cannot be invited right now.",
  "family.invite.limit": "Too many invitations today. Revoke one, or try again tomorrow.",
  "family.invite.failed": "The invitation could not be created. Nothing was created.",
  "family.invite.offline": "You are offline. An invitation needs a connection.",

  // Secrets panel (shown once).
  "family.secrets.title": "Invitation created",
  "family.secrets.once": "This is the only time the link and the code are shown.",
  "family.secrets.link": "Link (works once)",
  "family.secrets.code": "Code to speak",
  "family.secrets.codeNote":
    "Say the code to the contact by phone. Never send it in the same message as the link.",
  "family.secrets.notSent":
    "ChartWarden does not send the link or the code. Hand the link over yourself by a channel you trust.",
  "family.secrets.expires": "The link expires {when}.",
  "family.secrets.copyLink": "Copy link",
  "family.secrets.copyCode": "Copy code",
  "family.secrets.copied": "Copied.",
  "family.secrets.copyFailed": "Copy did not work. Select the text and copy it yourself.",
  "family.secrets.done": "I have passed these on",
  "family.secrets.gone": "The link and the code are no longer shown.",
} as const;
