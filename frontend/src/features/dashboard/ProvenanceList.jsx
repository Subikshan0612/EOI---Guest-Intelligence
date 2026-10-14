/** Which knowledge sections were retrieved. Metadata only — never document contents. */
export default function ProvenanceList({ provenance }) {
  return (
    <section className="koi-card dash-block" aria-labelledby="dash-provenance">
      <p className="intel-section-label" id="dash-provenance">
        Knowledge provenance
      </p>
      <p className="muted dash-note">
        Sections retrieved to ground this analysis. The score is retrieval relevance, not confidence.
      </p>
      {provenance.length === 0 ? (
        <p className="muted">No knowledge sections were recorded for this analysis.</p>
      ) : (
        <ul className="dash-prov-list">
          {provenance.map((p) => (
            <li key={p.chunkId} className="dash-prov-item">
              <span className="dash-prov-section">{p.section || "Untitled section"}</span>
              {p.sectionPath.length && p.sectionPath.join(" › ") !== p.section ? (
                <span className="muted dash-note">{p.sectionPath.join(" › ")}</span>
              ) : null}
              <span className="dash-prov-meta">
                <span className="status-chip">{p.visibility || "unknown"}</span>
                <span className="muted dash-note">
                  Retrieval relevance {p.retrievalScore === null ? "—" : p.retrievalScore.toFixed(2)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
