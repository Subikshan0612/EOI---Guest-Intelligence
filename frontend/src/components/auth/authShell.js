import { Fragment } from "react";

/**
 * How an auth page presents itself. On its own (the default, and what a direct render of the page is) it is a full screen: a <main> and an <h1>. Embedded in the public welcome page
 * (features/landing), the welcome page already provides the <main> and the page's <h1>, so the card renders without the wrapper and its title is an <h2>. Presentation only: the
 * form, its validation and its calls are the same component either way. The wrapper is chosen once per mount (`embedded` is constant for a mounted page), so nothing remounts.
 */
export function authShell(embedded = false) {
  return embedded
    ? { Wrapper: Fragment, wrapperProps: {}, Heading: "h2", focusOptions: { preventScroll: true } }
    : { Wrapper: "main", wrapperProps: { className: "auth-screen" }, Heading: "h1", focusOptions: undefined };
}
