import { groupPromptsByCategory } from "../features/prompts/promptSelectors";

export default function PromptLibraryPage() {
  const groups = groupPromptsByCategory();

  return (
    <article className="page">
      <header>
        <p className="page-kicker">Prompt library</p>
        <h1 className="page-title">Operational questions, ready to reuse</h1>
        <p className="page-lead">
          Reusable operational questions for later investigations. The full library experience is
          not built yet.
        </p>
      </header>

      {groups.map((group) => (
        <section key={group.category} className="stack">
          <h2 className="nav-label">{group.category}</h2>
          {group.prompts.length ? (
            <ul className="prompt-list">
              {group.prompts.map((prompt) => (
                <li key={prompt.id} className="prompt-item">
                  <span className="category-chip">{prompt.category}</span>
                  <strong>{prompt.title}</strong>
                  <span className="muted">{prompt.description}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No prompts in this category yet.</p>
          )}
        </section>
      ))}
    </article>
  );
}
