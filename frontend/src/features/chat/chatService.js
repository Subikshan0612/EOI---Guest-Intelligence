/**
 * Frontend-only mock KOI intelligence service.
 *
 * This is not an LLM client. Later phases should replace this module with
 * a call to the KOI backend, keeping the same request/response contract.
 */
import { getConversationById, getGuestById, getStayById } from "../../data/mockData";

const DELAY_MS = 900;

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    if (!signal) return;

    if (signal.aborted) {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function snippet(content, length = 92) {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= length) return compact;
  return `${compact.slice(0, length - 1).trim()}…`;
}

function withStayContext(base, stay, guest) {
  if (!stay && !guest) return base;

  return {
    ...base,
    context: {
      ...base.context,
      guestId: guest?.id ?? base.context.guestId,
      stayId: stay?.id ?? base.context.stayId,
      unit: stay?.unit ?? base.context.unit ?? base.context.apartment,
      apartment: stay?.unit ?? base.context.apartment,
      occupancyStatus: stay?.status ?? base.context.occupancyStatus,
      stayStatus: stay?.status === "in_house" ? "In-house" : base.context.stayStatus,
    },
  };
}

function genericResponse(content) {
  return {
    signal: {
      title: "Operational signal",
      summary: snippet(content),
      severity: "medium",
      source: "operator_note",
    },
    context: {
      apartment: "Unspecified",
      stayStatus: "Needs confirmation",
      occupancyStatus: "unknown",
    },
    intelligence: {
      summary:
        "This looks like an in-stay service issue. If it remains unresolved, guest trust and review risk will rise faster than the operational cost of a same-day response.",
    },
    risk: {
      level: "medium",
      reason: "The issue is currently unresolved and has not been acknowledged to the guest.",
      reasons: ["Unresolved service issue", "No confirmed owner yet"],
    },
    decision: {
      recommendation: "Prioritize investigation and proactively communicate with the guest.",
      rationale: "A clear next step and an owner matter more than a complete diagnosis right now.",
    },
    action: {
      label: "Contact guest and investigate the issue",
      recommended: [
        {
          owner: "duty_manager",
          step: "Acknowledge the guest within 10 minutes and confirm what ‘resolved’ looks like.",
        },
        {
          owner: "operations",
          step: "Assign an owner and report back with a realistic completion window.",
        },
      ],
    },
    outcome: {
      status: "pending",
      summary: "Waiting for acknowledgement and an assigned owner.",
    },
  };
}

function followUpResponse(content) {
  return {
    signal: {
      title: "Follow-up signal",
      summary: snippet(content),
      severity: "medium",
      source: "operator_note",
    },
    context: {
      stayStatus: "In-house",
      occupancyStatus: "in_house",
    },
    intelligence: {
      summary:
        "The original issue is still open. Tighten ownership and give the guest one concrete update rather than adding another parallel task.",
    },
    risk: {
      level: "medium",
      reason: "Repeated signals without a closed loop increase escalation risk.",
    },
    decision: {
      recommendation: "Confirm the current owner and send one proactive guest update.",
    },
    action: {
      label: "Close the loop with the guest",
      recommended: [
        {
          owner: "duty_manager",
          step: "Reply with the current status, owner, and expected next update time.",
        },
      ],
    },
    outcome: {
      status: "pending",
    },
  };
}

function fromExistingConversation(id) {
  const conversation = getConversationById(id);
  const intelligenceMessage = conversation?.messages?.find((message) => message.type === "intelligence");
  if (!intelligenceMessage) return null;

  const guest = getGuestById(conversation.guestId);
  const stay = getStayById(conversation.stayId);

  return withStayContext(
    {
      signal: intelligenceMessage.signal,
      context: intelligenceMessage.context,
      intelligence: intelligenceMessage.intelligence,
      risk: intelligenceMessage.risk,
      decision: intelligenceMessage.decision,
      action: intelligenceMessage.action,
      outcome: intelligenceMessage.outcome ?? { status: "pending" },
    },
    stay,
    guest,
  );
}

function selectTemplate(content, priorMessages) {
  const assistantTurns = priorMessages.filter((message) => message.role === "assistant").length;
  if (assistantTurns > 0) return followUpResponse(content);

  const text = content.toLowerCase();
  if (/ac|air.?con|cooling|warm air|temperature/.test(text)) {
    return fromExistingConversation("convo_ac_204") ?? genericResponse(content);
  }
  if (/checkout|late stay|hassan/.test(text)) {
    return {
      signal: {
        title: "Reservation / departure request",
        summary: snippet(content),
        severity: "medium",
        source: "operator_note",
      },
      context: {
        apartment: "12B",
        unit: "12B",
        stayStatus: "In-house",
        occupancyStatus: "in_house",
      },
      intelligence: {
        summary:
          "A late checkout can be absorbed if housekeeping is sequenced around the next arrival. The guest experience risk is lower than a refused request with no alternative.",
      },
      risk: {
        level: "medium",
        reason: "Turnover pressure on the next arrival if housekeeping is not replanned.",
      },
      decision: {
        recommendation: "Approve a limited late checkout and lock a housekeeping start time.",
      },
      action: {
        label: "Confirm 14:00 checkout and resequence housekeeping",
        recommended: [
          {
            owner: "front_office",
            step: "Confirm the later checkout and the latest departure time in writing.",
          },
          {
            owner: "housekeeping",
            step: "Move the 12B turnover to immediately after departure.",
          },
        ],
      },
      outcome: { status: "pending" },
    };
  }
  if (/housekeep|linen|towel|crib|noise|call/.test(text)) {
    return {
      signal: {
        title: "Guest experience preference",
        summary: snippet(content),
        severity: "low",
        source: "operator_note",
      },
      context: {
        apartment: "318",
        unit: "318",
        stayStatus: "In-house",
        occupancyStatus: "in_house",
      },
      intelligence: {
        summary:
          "This is a preference, not a failure — unless service interrupts a work block. Honouring the window is low cost and protects a repeat guest.",
      },
      risk: {
        level: "low",
        reason: "Low severity, but a repeat guest with a clear boundary.",
      },
      decision: {
        recommendation: "Set a do-not-disturb window and complete service outside it.",
      },
      action: {
        label: "Update the unit service window",
        recommended: [
          {
            owner: "housekeeping",
            step: "Do not enter between 13:00 and 17:00; service before or after that window.",
          },
        ],
      },
      outcome: { status: "pending" },
    };
  }

  return genericResponse(content);
}

export async function requestIntelligence({ content, priorMessages = [], abortSignal } = {}) {
  await wait(DELAY_MS, abortSignal);
  return selectTemplate(content, priorMessages);
}
