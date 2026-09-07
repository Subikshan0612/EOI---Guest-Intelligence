import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { formatConversationMeta } from "../../utils/formatDate";
import { IconButton } from "../../components/ui/IconButton";
import { useConversations } from "./useConversations";

export default function ConversationItem({ conversation, onNavigate }) {
  const navigate = useNavigate();
  const { conversationId: activeId } = useParams();
  const { renameConversation, deleteConversation } = useConversations();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(conversation.title);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rowRef = useRef(null);
  const skipBlurRef = useRef(false);

  useEffect(() => {
    setDraftTitle(conversation.title);
  }, [conversation.title]);

  useEffect(() => {
    if (!menuOpen && !renaming) return undefined;

    function onPointerDown(event) {
      if (!rowRef.current?.contains(event.target)) {
        skipBlurRef.current = renaming;
        setMenuOpen(false);
        setConfirmingDelete(false);
        setRenaming(false);
        setDraftTitle(conversation.title);
      }
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        skipBlurRef.current = true;
        setMenuOpen(false);
        setConfirmingDelete(false);
        setRenaming(false);
        setDraftTitle(conversation.title);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, renaming, conversation.title]);

  function saveRename(event) {
    event.preventDefault();
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    if (!renameConversation(conversation.id, draftTitle)) {
      setDraftTitle(conversation.title);
      setRenaming(false);
      return;
    }
    setRenaming(false);
    setMenuOpen(false);
  }

  function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }

    deleteConversation(conversation.id);
    setMenuOpen(false);
    if (activeId === conversation.id) {
      navigate("/chat", { state: { resetAt: Date.now() } });
    }
  }

  return (
    <div ref={rowRef} className="conversation-row">
      {renaming ? (
        <form className="conversation-rename" onSubmit={saveRename}>
          <label className="visually-hidden" htmlFor={`rename-${conversation.id}`}>
            Conversation title
          </label>
          <input
            id={`rename-${conversation.id}`}
            value={draftTitle}
            autoFocus
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={saveRename}
          />
        </form>
      ) : (
        <>
          <NavLink
            to={`/chat/${conversation.id}`}
            className="conversation-link"
            onClick={onNavigate}
          >
            <span className="conversation-link-copy">
              <span>{conversation.title}</span>
              <small>{formatConversationMeta(conversation.updatedAt)}</small>
            </span>
          </NavLink>
          <IconButton
            className="conversation-more"
            label={`Actions for ${conversation.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((open) => !open);
              setConfirmingDelete(false);
            }}
          >
            <MoreHorizontal size={16} strokeWidth={1.75} />
          </IconButton>
        </>
      )}

      {menuOpen && !renaming ? (
        <div className="conversation-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setDraftTitle(conversation.title);
              setRenaming(true);
              setMenuOpen(false);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className={confirmingDelete ? "is-danger" : undefined}
            onClick={handleDelete}
          >
            {confirmingDelete ? "Confirm delete" : "Delete"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
