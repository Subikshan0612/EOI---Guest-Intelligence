export function IconButton({ label, onClick, className = "", children, ...props }) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  );
}
