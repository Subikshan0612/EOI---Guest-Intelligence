import { useEffect, useState } from "react";
import { ClipboardList, Database, FileSearch, UserRound, BedDouble, Building2 } from "lucide-react";

/**
 * The Assistant before an investigation is started: what to do, in order, and what EOI does with it. Static guidance - it shows no conversation, no assessment and no number.
 * The examples are only suggestions of what to describe. Once the property, guest and stay are chosen (`ready`), choosing one puts its words in the composer for the person to edit
 * (it sends nothing and starts nothing). Before that the composer is not available, so choosing one fills nothing and says what to select first.
 */
const STEPS = Object.freeze([
  { icon: Building2, label: "Select the property" },
  { icon: UserRound, label: "Select the guest" },
  { icon: BedDouble, label: "Select the stay" },
  { icon: ClipboardList, label: "Describe the signal" },
  { icon: FileSearch, label: "EOI assesses it" },
]);

const EXAMPLES = Object.freeze(["The AC is not cooling.", "The TV is not working.", "Guest reports excessive noise.", "Hot water is unavailable."]);

export default function AssistantStart({ onExample, ready = true }) {
  const [needContext, setNeedContext] = useState(false);
  // Once the context is complete the reminder has done its job.
  useEffect(() => {
    if (ready) setNeedContext(false);
  }, [ready]);
  const choose = (example) => {
    if (!ready) {
      setNeedContext(true);
      return;
    }
    onExample?.(example);
  };
  return (
    <section className="koi-card asst-start" aria-labelledby="asst-start-title">
      <header className="asst-start-head">
        <span className="asst-start-mark" aria-hidden="true">
          <Database size={20} strokeWidth={1.5} />
        </span>
        <div>
          <h2 className="asst-start-title" id="asst-start-title">
            Select your operational context and describe what is happening.
          </h2>
          <p className="asst-start-lead">EOI assesses the situation against the records of the property, guest and stay you choose, then recommends what to do. You decide.</p>
        </div>
      </header>

      <ol className="asst-start-steps" aria-label="How an investigation starts">
        {STEPS.map(({ icon: Icon, label }) => (
          <li key={label} className="asst-start-step">
            <span className="asst-start-step-icon" aria-hidden="true">
              <Icon size={16} strokeWidth={1.75} />
            </span>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      <div className="asst-start-examples">
        <p className="card-label">Examples of what you might describe</p>
        <ul className="asst-start-chips" data-ready={ready ? "true" : "false"}>
          {EXAMPLES.map((example) => (
            <li key={example}>
              <button type="button" className="suggestion-chip" onClick={() => choose(example)} aria-describedby={needContext ? "asst-start-need" : undefined}>
                {example}
              </button>
            </li>
          ))}
        </ul>
        {needContext && !ready ? (
          <p className="asst-start-need" id="asst-start-need" role="status">
            Select the property, guest and stay first, then choose an example.
          </p>
        ) : null}
      </div>
    </section>
  );
}
