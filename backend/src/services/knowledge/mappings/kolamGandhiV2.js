/**
 * Reviewed corpus mapping for "Kolam Gandhi SOP v2 - Business Knowledge".
 *
 * Each entry is an explicit, human-made decision keyed by the section's
 * number AND title (see corpusClassification.js). It carries only section
 * numbers/titles and the reason for the decision - no document content.
 *
 * Visibility here is a PROVISIONAL ingestion design. Where a section mixes
 * audiences, the higher visibility was chosen (fail closed) and the reason
 * says so; changing a decision is a one-line edit reviewed like any code.
 */

const include = (number, title, visibility, reason) => ({ number, title, action: "include", visibility, reason });

export const KOLAM_GANDHI_V2_MAPPING = Object.freeze({
  preamble: {
    action: "exclude",
    visibility: "not applicable",
    reason: "Title/version block: document identity, carried by the KnowledgeDocument's title and version.",
  },
  entries: [
    include("1", "Property Master", "guest", "Approved guest-facing property facts, including the explicitly published contact."),
    include("2", "Property Structure & Inventory", "guest", "Guest-facing inventory and occupancy."),
    include("3", "Facilities & Accommodation Model", "guest", "Guest-facing facilities."),
    include("4", "Current Rate Card & Occupancy-Based 3BHK Tariff", "guest", "Current approved rates; the source has already removed superseded values."),
    include("5", "Laundry", "guest", "Guest-facing charges."),
    include("6", "Standard Stay Timings & Add-on Charges", "guest", "Guest-facing timings and charges."),
    include("7", "Booking & Check-in/Check-out Operations", "staff", "Parent heading of staff workflows."),
    include("7.1", "Booking", "staff", "Booking workflow."),
    include("7.2", "Check-in", "staff", "Check-in workflow."),
    include("7.3", "Check-out & Post Check-out", "staff", "Check-out workflow."),
    include("8", "Early Check-in / Late Checkout", "staff", "Mixed chunk: guest-facing charges alongside staff room-handling steps (ready/not-ready, alternative properties). The chunker cannot split it without changing the source, so it fails closed to staff; the standing charges are also in section 6 (guest)."),
    include("9", "Booking Modification & Extension", "staff", "Staff workflow."),
    include("10", "Cancellation & Refund", "guest", "Approved cancellation/refund policy."),
    include("11", "Guest Rules", "guest", "Guest-facing rules."),
    include("12", "Food & Beverage", "staff", "Mixed chunk: guest-facing menu/timings/charges alongside staff-only service instructions (caretaker serving, Front Office coordination). The chunker cannot split it without changing the source, so it fails closed to staff."),
    include("13", "Housekeeping", "staff", "Operational procedure."),
    include("14", "Guest Complaints", "staff", "Complaint-handling workflow."),
    include("15", "Maintenance", "staff", "Maintenance workflow."),
    include("16", "Service Recovery / Compensation", "staff", "Staff must not promise compensation; internal workflow."),
    include("17", "Damage / Missing Items / Lost Key", "staff", "Damage-handling and billing procedure."),
    include("18", "Payment / Billing Disputes", "staff", "Dispute-handling procedure."),
    include("19", "Staff Roles & Escalation — Staff Knowledge", "staff", "Labelled staff knowledge; roles and escalation."),
    include("20", "Daily Operational Pattern — Staff Knowledge", "staff", "Labelled staff knowledge; not a guest-facing guarantee."),
    {
      number: "21",
      title: "Current Data / Knowledge Boundaries",
      action: "exclude",
      visibility: "not applicable",
      reason: "Knowledge/application boundary and AI-oriented policy material, not ordinary retrievable business knowledge.",
    },
    {
      number: "22",
      title: "Emergency Procedures — PROVISIONAL / HOLD",
      action: "hold",
      visibility: "restricted",
      reason: "Explicitly provisional and not approved; must not enter the production corpus until management approves.",
    },
    {
      number: "23",
      title: "Restricted Information — Not for Guest RAG",
      action: "exclude",
      visibility: "not applicable",
      reason: "Describes restricted information whose values were intentionally removed from v2; it holds no useful facts and would be a meaningless chunk.",
    },
    {
      number: "24",
      title: "Excluded From Business Knowledge Corpus",
      action: "exclude",
      visibility: "not applicable",
      reason: "The document's own list of material that must not become ordinary business knowledge.",
    },
  ],
});
