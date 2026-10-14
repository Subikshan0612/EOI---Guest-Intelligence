import { useDashboardSummary } from "./useDashboardSummary";

/**
 * Counts come from the API's own totals, scoped to the workspace (narrowed by
 * the Property filter only). They describe this workspace's stored Signals,
 * not any wider organization.
 */
export default function DashboardSummary({ propertyId, propertyName }) {
  const { counts, status } = useDashboardSummary(propertyId);
  const cells = [
    { key: "open", label: "Open signals", hint: "New + acknowledged" },
    { key: "critical", label: "Critical", hint: "All statuses" },
    { key: "high", label: "High", hint: "All statuses" },
    { key: "analyzed", label: "Analyzed", hint: "Stored Intelligence V1" },
  ];
  const scope = propertyName ? propertyName : "this workspace (all properties)";
  return (
    <section className="koi-card dash-summary" aria-label="Summary">
      <div className="learning-stat-row dash-summary-row">
        {cells.map((cell) => (
          <div className="learning-stat" key={cell.key}>
            <span className="learning-stat-value">
              {status === "ready" && counts ? counts[cell.key] : "—"}
            </span>
            <span className="learning-stat-label">{cell.label}</span>
            <span className="muted dash-note">{cell.hint}</span>
          </div>
        ))}
      </div>
      <p className="muted dash-note">
        {status === "error"
          ? "Summary counts could not be loaded."
          : `Counts for ${scope}; they do not change with the other filters.`}
      </p>
    </section>
  );
}
