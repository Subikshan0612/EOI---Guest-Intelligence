import { listSuggestedPrompts } from "../prompts/promptSelectors";
import { greetingForNow } from "../../utils/formatDate";

export default function IntelligenceEmptyState({ composer, onSuggestion }) {
  const suggested = listSuggestedPrompts();

  return (
    <section className="empty-state" aria-label="New intelligence investigation">
      <p className="greeting">{greetingForNow()}</p>
      <h1 className="page-title">What should KOI investigate?</h1>
      <p className="page-lead">
        Understand guest situations, operational issues, and signals — then turn them into
        actionable intelligence.
      </p>

      {composer}

      <div className="empty-suggestions">
        <h2 className="section-label">Suggested intelligence</h2>
        <div className="suggestion-list">
          {suggested.map((prompt) =>
            onSuggestion ? (
              <button
                key={prompt.id}
                type="button"
                className="suggestion-chip"
                onClick={() => onSuggestion(prompt.title)}
              >
                {prompt.title}
              </button>
            ) : (
              <span key={prompt.id} className="suggestion-chip">
                {prompt.title}
              </span>
            ),
          )}
        </div>
      </div>
    </section>
  );
}
