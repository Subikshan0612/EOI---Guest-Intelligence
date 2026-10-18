/**
 * One empty state for the whole app, so every empty list answers the same three questions in the same order:
 *   what is this?        -> `title` and `what`
 *   why is it empty?     -> `children` (the existing sentence for that situation)
 *   what do I do next?   -> `action` (only when the existing workflow supports it: a link to an existing page or a button that opens an existing form)
 * Presentation only: it holds no data and makes no request.
 */
export default function EmptyState({ icon: Icon, title, what, children, action }) {
  return (
    <section className="empty-state-card" aria-label={title}>
      {Icon ? (
        <span className="empty-state-icon" aria-hidden="true">
          <Icon size={22} strokeWidth={1.5} />
        </span>
      ) : null}
      <div className="empty-state-copy">
        <h2 className="empty-state-title">{title}</h2>
        {what ? <p className="empty-state-what">{what}</p> : null}
        <p className="empty-state-why">{children}</p>
      </div>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </section>
  );
}
