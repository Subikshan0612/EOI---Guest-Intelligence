/**
 * Roles, permissions and the role-derived knowledge ceiling.
 *
 * Three DIFFERENT concepts, deliberately kept apart:
 *   - role                     what a workspace member IS (stored on the membership)
 *   - permission               what a role may DO (derived here, never stored, never
 *                              taken from a token or a request)
 *   - knowledge visibility     the highest data classification a role may READ; it
 *     ceiling                  is used only by the existing visibility helpers and
 *                              grants no permission
 *
 * `action:execute` exists in the vocabulary but NO role holds it yet, and Phase 29
 * (which added `action:propose`/`action:review`, granted to the same roles as their
 * decision:* counterparts) deliberately left it that way: proposing and reviewing an
 * Action PROPOSAL is not the same as running one, and this phase introduces no
 * execution path at all. `action:execute` remains reachable by nobody until a future
 * phase explicitly assigns it. (`intelligence:generate` = spend model budget / write
 * Intelligence; `operations:view` / `operations:manage` = Guest/Stay/Signal-style
 * operational data - the latter two are defined by the Phase 12 policy but not yet
 * enforced on any route.)
 *
 * Pure module: no I/O, no environment.
 */
export const ROLES = Object.freeze(["viewer", "operator", "reviewer", "admin"]);

export const PERMISSIONS = Object.freeze([
  "intelligence:view",
  "intelligence:generate",
  "operations:view",
  "operations:manage",
  "decision:propose",
  "decision:review",
  // Phase 29 (Decision -> Action lifecycle): proposing and reviewing an Action PROPOSAL - never executing
  // one. Added for exactly the same reason decision:propose/decision:review exist separately from
  // action:execute: a person may draft and a person may approve without either of those steps being able
  // to run anything. Granted to the SAME roles as their decision:* counterparts, for the same reason.
  "action:propose",
  "action:review",
  "action:execute",
  "workspace:admin",
]);

export const ROLE_PERMISSIONS = Object.freeze({
  viewer: Object.freeze(["intelligence:view"]),
  operator: Object.freeze(["intelligence:view", "intelligence:generate", "operations:view", "operations:manage", "decision:propose", "action:propose"]),
  reviewer: Object.freeze(["intelligence:view", "intelligence:generate", "operations:view", "operations:manage", "decision:propose", "action:propose", "decision:review", "action:review"]),
  admin: Object.freeze(["intelligence:view", "intelligence:generate", "operations:view", "operations:manage", "decision:propose", "action:propose", "decision:review", "action:review", "workspace:admin"]),
});

/** viewer -> guest, operator/reviewer -> staff, admin -> restricted. */
export const ROLE_KNOWLEDGE_CEILING = Object.freeze({
  viewer: "guest",
  operator: "staff",
  reviewer: "staff",
  admin: "restricted",
});

export function isValidRole(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, value);
}

/** The permissions of a role; an unknown role has none (fail closed). */
export function permissionsForRole(role) {
  return isValidRole(role) ? ROLE_PERMISSIONS[role] : Object.freeze([]);
}

export function hasPermission(role, permission) {
  return permissionsForRole(role).includes(permission);
}

/** The role's knowledge ceiling; an unknown role gets the lowest level ("guest"). */
export function knowledgeCeilingForRole(role) {
  return isValidRole(role) ? ROLE_KNOWLEDGE_CEILING[role] : "guest";
}
