/**
 * Where THIS case stands (Assessment, Decision, Action, Outcome). The state is stated in text as well as drawn ("Done" / "In review" / "Next" / "Later"), never by colour alone.
 * Later steps are named and inert: no link, no button, no result.
 */
const STATE_TEXT = Object.freeze({ done: "Done", review: "In review", working: "In progress", next: "Next", later: "Later" });

export default function CaseProgress({ stages }) {
  return (
    <nav className="asst-progress" aria-label="Where this case stands">
      <ol>
        {stages.map((stage) => (
          <li key={stage.label} data-state={stage.state}>
            <span className="asst-progress-mark" aria-hidden="true">
              {stage.state === "done" ? "✓" : stage.state === "review" || stage.state === "working" ? "◐" : "○"}
            </span>
            <span className="asst-progress-label">{stage.label}</span>
            <span className="asst-progress-state">{STATE_TEXT[stage.state]}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
