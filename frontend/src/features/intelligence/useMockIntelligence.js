import { useCallback, useEffect, useRef, useState } from "react";
import { requestIntelligence } from "../chat/chatService";

/**
 * Runs the existing Phase-1 mock intelligence generator against a real
 * Signal's own title/description. This is NOT an LLM call — `chatService.js`
 * is a template/keyword generator — and its result is intentionally kept
 * separate from operational Context (Phase 3D), which is the only source of
 * fact on this page.
 *
 * status: 'idle' | 'loading' | 'ready' | 'error'
 */
export function useMockIntelligence(signal) {
  const [intelligence, setIntelligence] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (!signal) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus("loading");
    setError(null);
    try {
      const content = [signal.title, signal.description].filter(Boolean).join(". ") || "Operational signal";
      const result = await requestIntelligence({ content, abortSignal: controller.signal });
      setIntelligence(result);
      setStatus("ready");
    } catch (err) {
      if (err?.name === "AbortError") return;
      setError("Could not generate an intelligence interpretation for this signal.");
      setStatus("error");
    }
  }, [signal?.id, signal?.title, signal?.description]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  return { intelligence, status, error, reload: load };
}
