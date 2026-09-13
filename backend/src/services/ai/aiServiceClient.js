import { AppError } from "../../utils/AppError.js";

const REQUEST_TIMEOUT_MS = 20000;

/**
 * Thin HTTP client to the Python AI service (Phase 5). Its only job is to
 * POST an already-assembled Signal context and translate the service's
 * response — or its failure — into the same safe application errors the
 * Gemini/OpenAI paths already produce.
 *
 * This module never assembles operational context, never touches MongoDB,
 * never resolves tenancy, and never contains any provider-specific (Gemini)
 * logic — that still lives entirely in llmProvider.js, untouched by this
 * file, and will eventually live in the Python service itself.
 */
export async function requestIntelligenceFromAiService(context) {
  const baseUrl = (process.env.AI_SERVICE_URL || "").trim();
  if (!baseUrl) {
    throw new AppError("AI intelligence service is not configured.", 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/intelligence/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AppError("AI intelligence service timed out. Try again.", 504);
    }
    console.error("[KOI API] AI service unreachable:", error?.name || "Error");
    throw new AppError("AI intelligence service is temporarily unavailable.", 502);
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new AppError("AI intelligence service returned a malformed response.", 502);
  }

  if (!response.ok) {
    throw mapAiServiceError(body, response.status);
  }

  // Python's own provenance is trusted here (unlike a raw LLM's own JSON
  // output): it is Python's honest self-report of which internal path it
  // just executed (its deterministic stub vs. its real Gemini client),
  // attached by Python's own trusted code, not by whatever came back from
  // an external model.
  return { raw: body, provider: body?.provenance?.provider, model: body?.provenance?.model };
}

/**
 * Maps the AI service's own error contract ({error:{code,message}}) to a
 * safe Node-facing AppError. Never forwards the service's raw message
 * verbatim, and never logs anything beyond the code/status — the same
 * no-leakage discipline as mapGeminiError/mapOpenAiError in llmProvider.js.
 */
function mapAiServiceError(body, status) {
  const code = body?.error?.code;
  console.error("[KOI API] AI service error:", code || "unknown", status);

  switch (code) {
    case "PROVIDER_NOT_CONFIGURED":
      return new AppError("AI intelligence service is not configured.", 503);
    case "PROVIDER_TIMEOUT":
      return new AppError("AI intelligence service timed out. Try again.", 504);
    case "PROVIDER_ERROR":
      return new AppError("AI intelligence service is temporarily unavailable.", 502);
    case "MALFORMED_RESPONSE":
    case "VALIDATION_FAILED":
    default:
      return new AppError("AI intelligence service returned an invalid response.", 502);
  }
}
