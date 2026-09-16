import { useCallback, useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";

/**
 * Phase 7E — loads the Phase 7D `GET /api/learning` report for the current
 * workspace. Mirrors useSignalContext.js's shape (status: 'loading' | 'ready'
 * | 'error' | 'unconfigured') so the Learning page uses the same loading/
 * error conventions as the rest of the app.
 *
 * Only `from`/`to` are exposed as UI filters (see LearningPage.jsx for why
 * intelligenceId/decisionId/actionId are not — the API supports them, but
 * without a way to pick an Intelligence/Decision/Action by name there is
 * nothing useful for an operator to type into a raw id field yet).
 */
export function useLearningReport({ from, to } = {}) {
  const [report, setReport] = useState(null);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!isWorkspaceConfigured) {
      setStatus("unconfigured");
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const params = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const data = await koiApi.getLearningReport(KOI_WORKSPACE_ID, params);
      setReport(data);
      setStatus("ready");
    } catch (err) {
      setError(err.message || "Could not load the learning report.");
      setStatus("error");
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  return { report, status, error, reload: load };
}
