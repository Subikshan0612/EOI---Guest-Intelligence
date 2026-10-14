import { createEoiAuthApi } from "./eoiAuthApi";
import { oidcSettings } from "./oidc/oidcSession";

/** The credential endpoints bound to this build's API origin (VITE_API_BASE_URL). */
export const eoiAuth = createEoiAuthApi({ apiBase: oidcSettings.apiBase });
