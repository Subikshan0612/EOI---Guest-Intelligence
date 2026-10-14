import {
  SIGNAL_SEVERITIES,
  SIGNAL_STATUSES,
  SIGNAL_TYPES,
  formatLabel,
  hasActiveFilters,
} from "./dashboardMapping";

export default function DashboardFilters({ filters, properties, onChange, onClear }) {
  const update = (key) => (event) => onChange(key, event.target.value);
  return (
    <div className="op-filter-bar dash-filters" role="search" aria-label="Filter signals">
      <label className="op-field op-field-narrow">
        <span className="op-field-label">Property</span>
        <select className="op-field-input" value={filters.propertyId} onChange={update("propertyId")}>
          <option value="">All properties</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="op-field op-field-narrow">
        <span className="op-field-label">Severity</span>
        <select className="op-field-input" value={filters.severity} onChange={update("severity")}>
          <option value="">All severities</option>
          {[...SIGNAL_SEVERITIES].reverse().map((s) => (
            <option key={s} value={s}>
              {formatLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <label className="op-field op-field-narrow">
        <span className="op-field-label">Status</span>
        <select className="op-field-input" value={filters.status} onChange={update("status")}>
          <option value="">All statuses</option>
          {SIGNAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {formatLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <label className="op-field op-field-narrow">
        <span className="op-field-label">Type</span>
        <select className="op-field-input" value={filters.type} onChange={update("type")}>
          <option value="">All types</option>
          {SIGNAL_TYPES.map((t) => (
            <option key={t} value={t}>
              {formatLabel(t)}
            </option>
          ))}
        </select>
      </label>
      <label className="op-field op-field-narrow">
        <span className="op-field-label">Intelligence</span>
        <select
          className="op-field-input"
          value={filters.hasIntelligence}
          onChange={update("hasIntelligence")}
        >
          <option value="">All</option>
          <option value="true">Analyzed</option>
          <option value="false">Not analyzed</option>
        </select>
      </label>
      {hasActiveFilters(filters) ? (
        <button type="button" className="text-button" onClick={onClear}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
