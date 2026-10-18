/**
 * A loading placeholder shaped like the list rows it stands in for (icon, two text lines, a chip), so the page does not jump when the real rows arrive. Decorative only: no
 * data, no numbers. The status text is for assistive technology; the shapes are hidden from it. The pulse stops under prefers-reduced-motion (global rule).
 */
export default function ListSkeleton({ label, rows = 4 }) {
  return (
    <div className="list-skeleton" role="status">
      <span className="visually-hidden">{label}</span>
      <ul className="list-skeleton-rows" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="list-skeleton-row">
            <span className="list-skeleton-icon" />
            <span className="list-skeleton-copy">
              <span className="list-skeleton-line" />
              <span className="list-skeleton-line" />
            </span>
            <span className="list-skeleton-chip" />
          </li>
        ))}
      </ul>
    </div>
  );
}
