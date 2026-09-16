import { listSuggestedPrompts } from "../prompts/promptSelectors";
import { greetingForNow } from "../../utils/formatDate";

export default function IntelligenceEmptyState({ composer, onSuggestion }) {
  const suggested = listSuggestedPrompts();

  return (
    <section className="empty-state" aria-label="New intelligence investigation">
      <div className="empty-state-copy">
        <p className="greeting">{greetingForNow()}</p>
        <h1 className="page-title">What should EOI investigate?</h1>
        <p className="page-lead">
          Understand guest situations, operational issues, and signals — then turn them into
          actionable intelligence.
        </p>
      </div>

      {composer}

      <div className="empty-suggestions">
        <h2 className="section-label">Suggested investigations</h2>
        <ul className="suggestion-list">
          {suggested.map((prompt) => (
            <li key={prompt.id}>
              {onSuggestion ? (
                <button
                  type="button"
                  className="suggestion-chip"
                  onClick={() => onSuggestion(prompt.title)}
                >
                  {prompt.title}
                </button>
              ) : (
                <span className="suggestion-chip">{prompt.title}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
