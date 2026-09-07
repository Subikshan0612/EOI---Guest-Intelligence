export default function Settings() {
  return (
    <article className="page">
      <header>
        <p className="page-kicker">Settings</p>
        <h1 className="page-title">Workspace settings</h1>
        <p className="page-lead">
          Authentication, team preferences, and integration settings belong to later phases.
          This page keeps the route and navigation in place.
        </p>
      </header>

      <section className="placeholder-card">
        <h2 className="card-label">Coming later</h2>
        <ul className="settings-list">
          <li>Account and access control</li>
          <li>Property and unit context</li>
          <li>Notification and action routing</li>
        </ul>
      </section>
    </article>
  );
}
