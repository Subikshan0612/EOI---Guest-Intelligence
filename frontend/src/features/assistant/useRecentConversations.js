import { useCallback, useEffect, useState } from "react";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../../config/workspace";
import * as koiApi from "../../services/api";
import { mapConversation } from "./assistantMapping";

/** The workspace's most recent conversations (GET only; conversations are workspace-shared). `refresh` re-reads them, e.g. after a first turn created one. */
export function useRecentConversations() {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState(isWorkspaceConfigured ? "loading" : "unconfigured");

  const refresh = useCallback(async () => {
    if (!isWorkspaceConfigured) {
      setStatus("unconfigured");
      return;
    }
    try {
      const page = await koiApi.listConversations(KOI_WORKSPACE_ID, { limit: 15, sort: "-updatedAt" });
      setItems(page.items.map(mapConversation).filter(Boolean));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { items, status, refresh };
}
