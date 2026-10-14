/** Stored guidance as plain text (no tense change, no markup); internal evidence references are removed by the mapping layer (presentation only). */
export default function RecommendationBlock({ text }) {
  return (
    <section className="koi-card dash-block" aria-labelledby="dash-recommendation">
      <p className="intel-section-label intel-section-label-intelligence" id="dash-recommendation">
        Recommendation
      </p>
      <p className="muted dash-note">Recommended guidance — not yet actioned</p>
      <p className="dash-text">{text}</p>
    </section>
  );
}
