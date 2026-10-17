import { ArrowRight, Building2, MessageSquareText, Users } from "lucide-react";
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
    <article className="page op-page home-page">
      <header className="home-hero">
        <div>
          <p className="greeting">{greetingForNow()}</p>
          <h1 className="page-title">Enterprise Operational Intelligence</h1>
        </div>
        <p className="page-lead">
          Ask about what is happening at your properties. EOI assesses it against your property, guest and stay records and your
          operating guidance, and recommends what to do. A person always decides; EOI never acts on its own.
        </p>
      </header>

      <nav aria-label="Where to start">
        <ul className="home-actions">
          <li>
            <Link to="/assistant" className="primary-button">
              <MessageSquareText size={18} strokeWidth={1.75} aria-hidden="true" />
              Ask the assistant
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </Link>
          </li>
          <li>
            <Link to="/operations/properties" className="suggestion-chip">
              <Building2 size={16} strokeWidth={1.75} aria-hidden="true" />
              Properties
            </Link>
          </li>
          <li>
            <Link to="/operations/guests" className="suggestion-chip">
              <Users size={16} strokeWidth={1.75} aria-hidden="true" />
              Guests &amp; stays
            </Link>
          </li>
        </ul>
      </nav>

      <section className="koi-card" aria-labelledby="landing-how">
        <h2 className="card-label home-section-label" id="landing-how">
          How it works
        </h2>
        <ol className="home-steps">
          <li className="home-step">
            <span className="home-step-label">Ask</span>
            <span className="home-step-text">Describe what happened, and where, in plain words</span>
          </li>
          <li className="home-step">
            <span className="home-step-label">Review</span>
            <span className="home-step-text">Read the assessment and recommendation, with its safety status</span>
          </li>
          <li className="home-step">
            <span className="home-step-label">Decide</span>
            <span className="home-step-text">Approve or reject it, then record what actually happened</span>
          </li>
        </ol>
      </section>

      <section className="koi-card" aria-labelledby="landing-recent">
        <h2 className="card-label home-section-label" id="landing-recent">
          Recent conversations
        </h2>
        {recent.status === "loading" ? (
          <ul className="skeleton-list" aria-label="Loading recent conversations">
            <li className="skeleton" />
            <li className="skeleton" />
          </ul>
        ) : null}
        {recent.status === "error" ? <p className="muted asst-note">Recent conversations couldn&apos;t be loaded.</p> : null}
        {recent.status === "ready" && recent.items.length === 0 ? <p className="muted asst-note">None yet. Start by asking the assistant.</p> : null}
        <ul className="home-recent">
          {recent.items.slice(0, 8).map((item) => (
            <li key={item.id}>
              <NavLink to={`/assistant/${item.id}`} className="home-recent-link">
                <MessageSquareText size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>{item.title}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
