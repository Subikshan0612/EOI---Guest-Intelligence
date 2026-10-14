import { Link, NavLink } from "react-router-dom";
import { useRecentConversations } from "../features/assistant/useRecentConversations";
import { greetingForNow } from "../utils/formatDate";

/**
 * Overview. Static, honest orientation plus the workspace's recent conversations (a read of the conversation list). It has no question box and no generated or
 * example answer: an assessment only ever comes from the evidence-backed pipeline behind the Assistant, when a person asks.
 */
export default function Home() {
  const recent = useRecentConversations();

  return (
    <article className="page op-page">
      <header className="op-page-header">
        <div>
          <p className="greeting">{greetingForNow()}</p>
          <h1 className="page-title">Enterprise Operational Intelligence</h1>
          <p className="page-lead">
            Ask about what is happening at your properties. EOI assesses it against your property, guest and stay records and your
            operating guidance, and recommends what to do. A person always decides; EOI never acts on its own.
          </p>
        </div>
      </header>

      <section className="koi-card" aria-labelledby="landing-how">
        <h2 className="card-label" id="landing-how">
          How it works
        </h2>
        <ol className="dash-empty-steps">
          <li>
            <span>Ask</span> Describe what happened, and where, in plain words
          </li>
          <li>
            <span>Review</span> Read the assessment and recommendation, with its safety status
          </li>
          <li>
            <span>Decide</span> Approve or reject it, then record what actually happened
          </li>
        </ol>
      </section>

      <nav aria-label="Where to start">
        <ul className="suggestion-list">
          <li>
            <Link to="/assistant" className="primary-button">
              Ask the assistant
            </Link>
          </li>
          <li>
            <Link to="/operations/properties" className="suggestion-chip">
              Properties
            </Link>
          </li>
          <li>
            <Link to="/operations/guests" className="suggestion-chip">
              Guests &amp; stays
            </Link>
          </li>
        </ul>
      </nav>

      <section className="koi-card" aria-labelledby="landing-recent">
        <h2 className="card-label" id="landing-recent">
          Recent conversations
        </h2>
        {recent.status === "error" ? <p className="muted asst-note">Recent conversations couldn&apos;t be loaded.</p> : null}
        {recent.status === "ready" && recent.items.length === 0 ? <p className="muted asst-note">None yet. Start by asking the assistant.</p> : null}
        <ul className="asst-recent">
          {recent.items.slice(0, 8).map((item) => (
            <li key={item.id}>
              <NavLink to={`/assistant/${item.id}`} className="asst-recent-link">
                {item.title}
              </NavLink>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
