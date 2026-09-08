import { groupPromptsByCategory } from "../features/prompts/promptSelectors";

export default function PromptLibraryPage() {
  const groups = groupPromptsByCategory();
  const total = groups.reduce((count, group) => count + group.prompts.length, 0);

  return (
    <article className="page prompt-library-page">
      <header className="prompt-library-header">
        <p className="page-kicker">Prompt library</p>
        <h1 className="page-title">Operational questions, ready to reuse</h1>
        <p className="page-lead">
          Standard investigation starters for guest issues, stay risk, and service recovery. Use
          these as disciplined prompts when opening a new intelligence session.
        </p>
        <p className="prompt-library-count muted">
          {total} prompts across {groups.length} categories
        </p>
      </header>

      <div className="prompt-library-groups">
        {groups.map((group) => {
          const headingId = `prompt-cat-${group.category.toLowerCase().replace(/\s+/g, "-")}`;

          return (
            <section key={group.category} className="prompt-category" aria-labelledby={headingId}>
              <h2 id={headingId} className="nav-label">
                {group.category}
              </h2>
              {group.prompts.length ? (
                <ul className="prompt-list">
                  {group.prompts.map((prompt) => (
                    <li key={prompt.id} className="prompt-item">
                      <strong>{prompt.title}</strong>
                      <span className="muted">{prompt.description}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No prompts in this category yet.</p>
              )}
            </section>
          );
        })}
      </div>
    </article>
  );
}
