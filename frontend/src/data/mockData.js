/**
 * Phase 1 mock dataset for KOI frontend development.
 *
 * Shapes follow the future KOI intelligence contract so this file can be
 * replaced by API responses in later phases without rewriting the UI.
 *
 * Learning loop: Signals → Context → Intelligence → Decision → Action → Outcome → Learning
 */

export const guests = [
  {
    id: "gst_evan_chen",
    name: "Evan Chen",
    email: "evan.chen@example.com",
    phone: "+1 415 555 0148",
    loyaltyTier: "Preferred",
    staysCompleted: 4,
    notes: "Values quiet units and fast maintenance response.",
  },
  {
    id: "gst_amira_hassan",
    name: "Amira Hassan",
    email: "amira.hassan@example.com",
    phone: "+44 20 7946 0958",
    loyaltyTier: "Standard",
    staysCompleted: 1,
    notes: "Traveling with a toddler. Requested extra linens on arrival.",
  },
  {
    id: "gst_priya_menon",
    name: "Priya Menon",
    email: "priya.menon@example.com",
    phone: "+91 98400 11220",
    loyaltyTier: "Preferred",
    staysCompleted: 7,
    notes: "Repeat guest. Sensitive to housekeeping timing during work calls.",
  },
];

export const stays = [
  {
    id: "sty_204",
    guestId: "gst_evan_chen",
    unit: "204",
    property: "Harbour Residences",
    checkIn: "2026-09-03T15:00:00.000Z",
    checkOut: "2026-09-08T11:00:00.000Z",
    occupancy: "1 adult",
    status: "in_house",
  },
  {
    id: "sty_12b",
    guestId: "gst_amira_hassan",
    unit: "12B",
    property: "Harbour Residences",
    checkIn: "2026-09-04T16:10:00.000Z",
    checkOut: "2026-09-10T11:00:00.000Z",
    occupancy: "2 adults, 1 child",
    status: "in_house",
  },
  {
    id: "sty_318",
    guestId: "gst_priya_menon",
    unit: "318",
    property: "Harbour Residences",
    checkIn: "2026-09-01T14:40:00.000Z",
    checkOut: "2026-09-06T11:00:00.000Z",
    occupancy: "1 adult",
    status: "in_house",
  },
];

export const workspace = {
  name: "Harbour Residences",
  profileLabel: "Operations",
  initials: "Ops",
};

function daysAgo(days, hours = 13, minutes = 18) {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

export const conversations = [
  {
    id: "convo_ac_204",
    title: "AC not cooling in Unit 204",
    createdAt: daysAgo(0, 13, 12),
    updatedAt: daysAgo(0, 13, 18),
    guestId: "gst_evan_chen",
    stayId: "sty_204",
    status: "open",
    summary: "In-house guest reported warm room temperature during a heat spell.",
    messages: [
      {
        id: "msg_001",
        role: "user",
        type: "text",
        createdAt: daysAgo(0, 13, 12),
        content:
          "Guest in 204 just messaged that the AC has been blowing warm air since last night. He has a client call at 10:00 and wants this fixed before then.",
      },
      {
        id: "msg_002",
        role: "assistant",
        type: "intelligence",
        createdAt: daysAgo(0, 13, 13),
        signal: {
          id: "sig_ac_204",
          source: "guest_message",
          channel: "in_app",
          receivedAt: "2026-09-05T08:11:40.000Z",
          summary: "In-house guest reports AC blowing warm air in Unit 204.",
          severity: "high",
          tags: ["maintenance", "comfort", "in_house"],
        },
        context: {
          guestId: "gst_evan_chen",
          stayId: "sty_204",
          unit: "204",
          occupancyStatus: "in_house",
          timeToCheckoutHours: 75,
          relevantHistory: [
            "Preferred guest with four completed stays.",
            "Previous stay had a same-day maintenance resolution for a noisy fridge.",
          ],
        },
        intelligence: {
          summary:
            "This is a comfort-critical in-stay issue for a preferred guest with an imminent work commitment. Delay is likely to damage trust more than the fault itself.",
          pattern:
            "Warm-air AC reports on this floor have clustered after overnight heat spikes.",
          guestImpact:
            "Unable to work comfortably in-unit; risk of public complaint if not acknowledged quickly.",
          operationalImpact:
            "May require a technician visit and a temporary room change if parts are delayed.",
        },
        risk: {
          level: "high",
          score: 0.78,
          reasons: [
            "Comfort issue during an in-house stay",
            "Preferred guest with a time-sensitive work need",
            "Limited recovery window before 10:00",
          ],
        },
        decision: {
          recommendation: "Treat as priority service recovery, not a routine work order.",
          rationale:
            "Speed of acknowledgement and a concrete next step matter more than a perfect technical diagnosis right now.",
          alternatives: [
            "Standard maintenance ticket with next available slot",
            "Immediate unit move without attempting on-site repair",
          ],
        },
        action: {
          recommended: [
            {
              owner: "duty_manager",
              step: "Call the guest within 10 minutes, acknowledge the issue, and confirm the 10:00 deadline.",
            },
            {
              owner: "maintenance",
              step: "Inspect Unit 204 immediately and report whether a same-morning fix is realistic.",
            },
            {
              owner: "front_office",
              step: "Hold Unit 221 as a quiet backup if the repair cannot complete before 09:40.",
            },
          ],
        },
        outcome: null,
      },
    ],
  },
  {
    id: "convo_late_checkout",
    title: "Late checkout request — Hassan",
    createdAt: daysAgo(1, 11, 40),
    updatedAt: daysAgo(1, 12, 5),
    guestId: "gst_amira_hassan",
    stayId: "sty_12b",
    status: "open",
    summary: "Family asked to keep 12B until 14:00 on departure day.",
    messages: [
      {
        id: "msg_101",
        role: "user",
        type: "text",
        createdAt: daysAgo(1, 11, 40),
        content:
          "The Hassan family in 12B asked for a 14:00 checkout. Next arrival in that unit is at 16:00. Can we approve this without stressing housekeeping?",
      },
    ],
  },
  {
    id: "convo_housekeeping_318",
    title: "Housekeeping timing in 318",
    createdAt: daysAgo(8, 9, 15),
    updatedAt: daysAgo(8, 9, 22),
    guestId: "gst_priya_menon",
    stayId: "sty_318",
    status: "open",
    summary: "Repeat guest asked that service not interrupt afternoon calls.",
    messages: [
      {
        id: "msg_201",
        role: "user",
        type: "text",
        createdAt: daysAgo(8, 9, 15),
        content:
          "Priya in 318 asked that housekeeping not enter between 13:00 and 17:00. She has video calls. Please advise how we should handle service for the rest of her stay.",
      },
    ],
  },
];

export const promptCategories = [
  "Guest Experience",
  "Reservations",
  "Operations",
  "Service Recovery",
  "Risk",
  "Management",
];

export const prompts = [
  {
    id: "prm_analyze_complaint",
    title: "Analyze Guest Complaint",
    category: "Guest Experience",
    description: "Turn a guest complaint into signal, context, and recommended recovery.",
  },
  {
    id: "prm_identify_guest_risk",
    title: "Identify Guest Risk",
    category: "Risk",
    description: "Assess whether a situation is likely to escalate into a poor stay outcome.",
  },
  {
    id: "prm_reservation_issue",
    title: "Analyze Reservation Issue",
    category: "Reservations",
    description: "Review a booking mismatch and recommend an operational response.",
  },
  {
    id: "prm_service_recovery",
    title: "Recommend Service Recovery",
    category: "Service Recovery",
    description: "Propose recovery actions that fit the guest, stay, and operational constraints.",
  },
  {
    id: "prm_stay_risk",
    title: "Assess Stay Risk",
    category: "Risk",
    description: "Score in-stay risk using guest, unit, and recent signal context.",
  },
  {
    id: "prm_summarize_situation",
    title: "Summarize Guest Situation",
    category: "Management",
    description: "Produce a concise briefing for duty managers and owners.",
  },
  {
    id: "prm_ops_turnover",
    title: "Plan Unit Turnover",
    category: "Operations",
    description: "Balance housekeeping capacity against arrival and late-checkout pressure.",
  },
];

export function getGuestById(guestId) {
  return guests.find((guest) => guest.id === guestId) ?? null;
}

export function getStayById(stayId) {
  return stays.find((stay) => stay.id === stayId) ?? null;
}

export function getConversationById(conversationId) {
  return conversations.find((conversation) => conversation.id === conversationId) ?? null;
}

export function getLatestIntelligence(conversation) {
  if (!conversation?.messages) return null;
  return (
    [...conversation.messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.type === "intelligence") ?? null
  );
}
