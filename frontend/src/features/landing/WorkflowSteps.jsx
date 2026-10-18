import { ClipboardCheck, Flag, Layers, Radio, Scale, Sparkles } from "lucide-react";

/**
 * The EOI loop, drawn as a workflow: Signal -> Context -> Intelligence -> Decision -> Action -> Outcome. The wording describes what the application does today (and nothing it
 * does not): the assessment is AI-generated from the workspace's own records, a PERSON decides, the action is a record of what would be done (EOI carries nothing out), and the
 * outcome is what a person reports. It is an ordered list, so the sequence is announced as one. Presentation only: it holds no data and makes no request.
 */
const STAGES = Object.freeze([
  { icon: Radio, label: "Signal", text: "Something happens at a property" },
  { icon: Layers, label: "Context", text: "Property, guest and stay records" },
  { icon: Sparkles, label: "Intelligence", text: "An AI assessment grounded in those records" },
  { icon: Scale, label: "Decision", text: "A person approves or rejects it" },
  { icon: ClipboardCheck, label: "Action", text: "What would be done, on record" },
  { icon: Flag, label: "Outcome", text: "What actually happened" },
]);

export default function WorkflowSteps() {
  return (
    <ol className="landing-flow" aria-label="How EOI turns a signal into an outcome">
      {STAGES.map(({ icon: Icon, label, text }, index) => (
        <li key={label} className="landing-flow-step" style={{ "--i": index }}>
          <span className="landing-flow-node" aria-hidden="true">
            <Icon size={18} strokeWidth={1.75} />
          </span>
          <span className="landing-flow-copy">
            <span className="landing-flow-label">{label}</span>
            <span className="landing-flow-text">{text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
