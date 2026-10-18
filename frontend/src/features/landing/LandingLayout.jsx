import { Outlet } from "react-router-dom";
import WorkflowSteps from "./WorkflowSteps";

/**
 * The public welcome page: what EOI is on the left, the existing sign-in / sign-up card on the right (the <Outlet />: the SAME SignInPage / SignUpPage /
 * ForgotPasswordPage components, rendered embedded - see components/auth/authShell.js). Shown only to a signed-out person (AuthRoutes); a signed-in person never reaches it.
 * No sign-in logic lives here, and nothing on this page is data: the copy describes the product as it works today - EOI recommends, a person decides.
 */
export default function LandingLayout() {
  return (
    <div className="landing">
      <a className="skip-link" href="#landing-auth">
        Skip to sign in
      </a>
      <div className="landing-bg" aria-hidden="true" />
      <div className="landing-inner">
        <main className="landing-main">
          <section className="landing-story" aria-labelledby="landing-title">
            <p className="landing-brand landing-reveal" style={{ "--i": 0 }}>
              <span className="landing-brand-mark">EOI</span>
              <span className="landing-brand-name">Enterprise Operations Intelligence</span>
            </p>
            <h1 className="landing-title landing-reveal" id="landing-title" style={{ "--i": 1 }}>
              Turn everyday operations into intelligent decisions.
            </h1>
            <p className="landing-lead landing-reveal" style={{ "--i": 2 }}>
              EOI helps hospitality teams understand operational signals in context, assess situations with AI, and make better human decisions across property, guest and stay
              operations.
            </p>
            <WorkflowSteps />
            <p className="landing-note landing-reveal" style={{ "--i": 9 }}>
              Built for hotels, service apartments and hospitality operations teams. EOI recommends; a person always decides.
            </p>
          </section>

          <section className="landing-auth" id="landing-auth" aria-label="Sign in or create an account" tabIndex={-1}>
            <Outlet />
          </section>
        </main>
      </div>
    </div>
  );
}
