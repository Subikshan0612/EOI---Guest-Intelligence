import OpenAI from "openai";
import { AppError } from "../../utils/AppError.js";
import { INTELLIGENCE_JSON_SCHEMA } from "./intelligenceSchema.js";

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Direct-from-Node provider execution. As of Phase 5 Step 5, this module
 * owns exactly two providers:
 *   - "openai" — real OpenAI chat completions, called directly from Node.
 *     Retained as an optional/future alternative; never touches ai-service.
 *   - "test"   — deterministic in-process fixture for the Node-level Phase 4
 *     test suite. Never makes a network call.
 *
 * "gemini" is deliberately NOT a branch here. Real Gemini execution now
 * lives entirely in ai-service/ (app/services/gemini_client.py) — Node's
 * LLM_PROVIDER=gemini is intercepted in intelligenceService.js and delegated
 * to Python before this module is ever reached, so this file has no need to
 * know about Gemini, a Gemini SDK, or a Gemini API key at all.
 */

/**
 * Provider selection is read from process.env on every call rather than
 * cached at module load, so a differently-configured process (e.g. a
 * `LLM_PROVIDER=test` test run) never has to touch backend/.env. This is
 * also the ONLY place provider selection is decided — it is never
 * client-controllable (no query param or body field chooses a provider).
 */
function readConfig() {
  return {
    provider: (process.env.LLM_PROVIDER || "").trim().toLowerCase(),
    model: (process.env.LLM_MODEL || "").trim(),
    openaiApiKey: process.env.OPENAI_API_KEY,
  };
}

export function isAiConfigured() {
  const { provider, openaiApiKey } = readConfig();
  if (provider === "test") return true;
  if (provider === "openai") return Boolean(openaiApiKey);
  return false;
}

/** Honest provenance for the response envelope — never sourced from the LLM's own output. */
export function getActiveProviderInfo() {
  const { provider, model } = readConfig();
  if (provider === "test") return { provider: "test", model: model || "test-model" };
  return { provider: provider || "none", model: model || DEFAULT_OPENAI_MODEL };
}

/**
 * Calls the configured provider and returns its raw (unvalidated) parsed
 * JSON. Structural/semantic validation happens one layer up in
 * intelligenceSchema.js — this function's only job is "get JSON out of the
 * provider, or fail with a safe application error."
 *
 * `testScenario` is a deliberate, environment-gated test seam: it has no
 * effect unless the server process itself was started with
 * LLM_PROVIDER=test, so it can never be used to influence a real AI call.
 */
export async function requestStructuredIntelligence({ systemPrompt, userPrompt, testScenario }) {
  const { provider, model, openaiApiKey } = readConfig();

  if (provider === "test") {
    return callTestProvider(testScenario);
  }

  if (provider === "openai") {
    if (!openaiApiKey) {
      throw new AppError("AI intelligence service is not configured.", 503);
    }
    return callOpenAi({ systemPrompt, userPrompt, model: model || DEFAULT_OPENAI_MODEL, apiKey: openaiApiKey });
  }

  throw new AppError("AI intelligence service is not configured.", 503);
}

async function callOpenAi({ systemPrompt, userPrompt, model, apiKey }) {
  const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });

  let response;
  try {
    response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "koi_signal_intelligence",
          strict: true,
          schema: INTELLIGENCE_JSON_SCHEMA,
        },
      },
    });
  } catch (error) {
    throw mapOpenAiError(error);
  }

  const content = response?.choices?.[0]?.message?.content;
  if (!content) {
    throw new AppError("AI intelligence service returned an empty response.", 502);
  }

  let raw;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new AppError("AI intelligence service returned a malformed response.", 502);
  }

  return { raw, model };
}

/**
 * Maps an OpenAI SDK error to a safe application-level AppError. Never
 * forwards the raw error message or object to the caller — it may contain
 * request headers, endpoint URLs, or other provider internals — and never
 * logs the API key (the SDK error does not carry it, but nothing below
 * prints `error` in full either).
 */
function mapOpenAiError(error) {
  const status = error?.status ?? error?.response?.status;
  console.error("[KOI API] LLM provider error (openai):", error?.name || "Error", status ?? "no-status");

  if (status === 401 || status === 403) {
    return new AppError("AI intelligence service is not configured correctly.", 503);
  }
  if (status === 429) {
    return new AppError("AI intelligence service is currently rate-limited. Try again shortly.", 503);
  }
  if (error?.name === "APIConnectionTimeoutError" || error?.code === "ETIMEDOUT") {
    return new AppError("AI intelligence service timed out. Try again.", 504);
  }
  return new AppError("AI intelligence service is temporarily unavailable.", 502);
}

const TEST_BASE_RESULT = {
  summary: "Test-provider summary for automated verification.",
  findings: ["Deterministic test finding."],
  risk: { level: "medium", reason: "Deterministic test reason." },
  decision: {
    recommendation: "Deterministic test recommendation.",
    rationale: "Deterministic test rationale.",
  },
  action: {
    label: "Deterministic test action",
    recommended: [{ step: "Deterministic test step.", priority: "high" }],
  },
  outcome: { expected: "Deterministic test expected outcome." },
  confidence: 0.87,
};

/**
 * Deterministic in-process provider used only when LLM_PROVIDER=test. Never
 * makes a network call, never consumes API credits, and its output is never
 * offered as real intelligence — `getActiveProviderInfo()` always reports it
 * honestly as provider "test".
 */
function callTestProvider(scenario) {
  switch (scenario) {
    case "malformed":
      return { raw: { summary: "incomplete" }, model: "test-model" };
    case "invalid-risk":
      return {
        raw: { ...TEST_BASE_RESULT, risk: { level: "extreme", reason: "Deterministic test reason." } },
        model: "test-model",
      };
    case "invalid-confidence":
      return { raw: { ...TEST_BASE_RESULT, confidence: 5 }, model: "test-model" };
    case "provider-error":
      throw new AppError("AI intelligence service is temporarily unavailable.", 502);
    case "timeout":
      throw new AppError("AI intelligence service timed out. Try again.", 504);
    default:
      return { raw: TEST_BASE_RESULT, model: "test-model" };
  }
}
