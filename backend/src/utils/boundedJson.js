import { AppError } from "./AppError.js";

/**
 * Validates an untrusted JSON-shaped value BEFORE it can reach MongoDB, so malformed or hostile input becomes a clean
 * 400 (never a Mongoose CastError, a BSON depth error or a 500) and never echoes a schema path or driver text.
 *
 * Bounds: serialized size, nesting depth, keys per object, items per array, string length. Only plain JSON is accepted
 * (objects, arrays, strings, finite numbers, booleans, null). Object keys must be safe Mongo Map keys: no ".", no leading
 * "$", and never __proto__ / constructor / prototype.
 *
 * Iterative (explicit stack), so a 100 KB body of `{"a":{"a":...` cannot overflow the call stack.
 */
export function assertBoundedJson(value, limits, label = "value") {
  const { maxBytes, maxDepth, maxKeys, maxArray, maxString } = limits;
  const fail = (why) => {
    throw new AppError(`${label} ${why}`, 400, { code: "INVALID_FIELD", field: label });
  };
  if (value === undefined || value === null) return;

  const stack = [[value, 1]];
  let visited = 0;
  while (stack.length > 0) {
    const [current, depth] = stack.pop();
    visited += 1;
    if (visited > maxKeys * maxArray + maxKeys + 1000) fail("is too large");
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("contains an invalid number");
      continue;
    }
    if (typeof current === "string") {
      if (current.length > maxString) fail(`contains a string longer than ${maxString} characters`);
      continue;
    }
    if (typeof current !== "object") fail("contains an unsupported value");
    if (depth > maxDepth) fail(`is nested deeper than ${maxDepth} levels`);
    if (Array.isArray(current)) {
      if (current.length > maxArray) fail(`contains an array longer than ${maxArray} items`);
      for (const item of current) stack.push([item, depth + 1]);
      continue;
    }
    const proto = Object.getPrototypeOf(current);
    if (proto !== Object.prototype && proto !== null) fail("contains an unsupported value");
    const keys = Object.keys(current);
    if (keys.length > maxKeys) fail(`contains an object with more than ${maxKeys} keys`);
    for (const key of keys) {
      if (key.includes(".") || key.startsWith("$") || key === "__proto__" || key === "constructor" || key === "prototype") fail("contains a key that is not allowed");
      if (key.length > 100) fail("contains a key that is too long");
      stack.push([current[key], depth + 1]);
    }
  }
  if (JSON.stringify(value).length > maxBytes) fail(`is larger than ${maxBytes} bytes`);
}

/** Requires a string within [min, max] characters (after trimming); returns the trimmed string. */
export function requireBoundedString(value, { min = 1, max, label }) {
  if (typeof value !== "string") throw new AppError(`${label} must be a string`, 400, { code: "INVALID_FIELD", field: label });
  const trimmed = value.trim();
  if (trimmed.length < min) throw new AppError(`${label} is required`, 400, { code: "INVALID_FIELD", field: label });
  if (trimmed.length > max) throw new AppError(`${label} must be at most ${max} characters`, 400, { code: "INVALID_FIELD", field: label });
  return trimmed;
}
