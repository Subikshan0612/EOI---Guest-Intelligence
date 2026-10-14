import { useCallback, useEffect, useRef, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapDecisionV1 } from "./dashboardMapping";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

/**
 * Stored Decision V1 records for the workspace, keyed by their Intelligence id.
 * ONE list request (a few pages only if there are more than 100), never one per
 * Signal, and GET only. The Decision API applies workspace scope and the live
 * parent-Intelligence visibility; records that are not decision-v1 are dropped.
 * If the workspace has more Decisions than MAX_PAGES pages hold, `partial` is
 * set so a missing entry is reported as unavailable, not as "not proposed".
 *
 * status: 'loading' | 'ready' | 'unauthenticated' (401) | 'forbidden' (403) | 'error' | 'unconfigured'
 */
export function useDashboardDecisions() {
  const [byIntelligenceId, setMap] = useState(() => new Map());
  const [partial, setPartial] = useState(false);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!isWorkspaceConfigured) {
      setStatus("unconfigured");
      return;
    }
    const ticket = ++latest.current;
    setStatus("loading");
    try {
      const map = new Map();
      let page = 1;
      let pages = 1;
      do {
        const { items, pagination } = await koiApi.listDecisions(KOI_WORKSPACE_ID, { limit: PAGE_SIZE, page });
        for (const item of items) {
          const decision = mapDecisionV1(item);
          if (decision) map.set(String(decision.intelligenceId), decision);
        }
        pages = pagination?.pages ?? 1;
        page += 1;
      } while (page <= pages && page <= MAX_PAGES);
      if (ticket !== latest.current) return;
      setMap(map);
      setPartial(pages > MAX_PAGES);
      setStatus("ready");
    } catch (error) {
      if (ticket !== latest.current) return;
      setStatus(koiApi.isAuthenticationError(error) ? "unauthenticated" : koiApi.isAuthorizationError(error) ? "forbidden" : "error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { byIntelligenceId, partial, status, reload: load };
}
