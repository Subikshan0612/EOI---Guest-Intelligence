import crypto from "node:crypto";
import { promisify } from "node:util";
import { getRuntimeMode } from "../config/runtimeMode.js";

/**
 * Password hashing and the password policy (Phase 46).
 *
 * ALGORITHM: scrypt (RFC 7914), from Node's own `crypto` - no dependency. Argon2id is the usual first choice, but Node 20 does not ship it and adding a native
 * package was not warranted; scrypt is a memory-hard, well-reviewed alternative and is accepted by the OWASP password-storage guidance when configured with
 * enough memory. Default cost: N = 2^16, r = 8, p = 1 (64 MiB per hash), a random 16-byte salt per password, a 32-byte derived key.
 *
 *   stored form   scrypt$<log2 N>$<r>$<p>$<salt, base64url>$<hash, base64url>   - the cost is stored WITH the hash, so it can be raised later: `needsRehash`
 *                 says when a successfully verified password should be rewritten with the current cost.
 *   comparison    constant time (crypto.timingSafeEqual).
 *   unknown user  `verifyAgainstDummy` does the same amount of work, so the time taken does not reveal whether an address has an account.
 *
 * The plaintext password and the hash are never logged, returned or placed in an error message by anything in this module.
 */
const scryptAsync = promisify(crypto.scrypt);
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const R = 8;
const P = 1;
const PRODUCTION_MIN_LOG_N = 15;

/** log2(N). KOI_PASSWORD_SCRYPT_LOG_N may LOWER the cost in development/test only (fast test suites); production never goes below 2^15. */
export function getScryptLogN() {
  const raw = Number(process.env.KOI_PASSWORD_SCRYPT_LOG_N);
  const requested = Number.isInteger(raw) && raw >= 10 && raw <= 20 ? raw : 16;
  return getRuntimeMode() === "production" ? Math.max(PRODUCTION_MIN_LOG_N, requested) : requested;
}

const b64 = (buffer) => buffer.toString("base64url");
const fromB64 = (text) => Buffer.from(text, "base64url");

/** The password as it is hashed: Unicode-normalised (NFKC) so visually identical passwords match. */
const prepare = (password) => String(password).normalize("NFKC");

async function derive(password, salt, logN, r, p) {
  const N = 2 ** logN;
  return scryptAsync(prepare(password), salt, KEY_LENGTH, { N, r, p, maxmem: 128 * N * r * 2 });
}

export async function hashPassword(password) {
  const logN = getScryptLogN();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, logN, R, P);
  return `scrypt$${logN}$${R}$${P}$${b64(salt)}$${b64(hash)}`;
}

function parse(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, logN, r, p] = parts.slice(0, 4).map((v, i) => (i === 0 ? v : Number(v)));
  if (![logN, r, p].every(Number.isInteger) || logN < 10 || logN > 22 || r < 1 || r > 32 || p < 1 || p > 8) return null;
  const salt = fromB64(parts[4]);
  const hash = fromB64(parts[5]);
  if (salt.length < 8 || hash.length !== KEY_LENGTH) return null;
  return { logN, r, p, salt, hash };
}

/** @returns {Promise<boolean>} true when the password matches the stored hash. A malformed stored value never matches. */
export async function verifyPassword(password, stored) {
  const parsed = parse(stored);
  if (!parsed || typeof password !== "string" || password.length === 0 || password.length > 1024) return false;
  const candidate = await derive(password, parsed.salt, parsed.logN, parsed.r, parsed.p);
  return crypto.timingSafeEqual(candidate, parsed.hash);
}

/** True when a verified hash was made with a weaker cost than the one now configured (rewrite it after a successful sign-in). */
export function needsRehash(stored) {
  const parsed = parse(stored);
  return !parsed || parsed.logN < getScryptLogN() || parsed.r !== R || parsed.p !== P;
}

let dummyHash = null;
let dummyKey = null;
/** Spends the same time as a real verification, for an address with no account (or no password). Always returns false. */
export async function verifyAgainstDummy(password) {
  const logN = getScryptLogN();
  if (!dummyHash || dummyKey !== logN) {
    dummyHash = await hashPassword(crypto.randomBytes(18).toString("base64url"));
    dummyKey = logN;
  }
  await verifyPassword(typeof password === "string" ? password : "", dummyHash);
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

// A short deny-list of the most common passwords (and their obvious variants are caught by the normalisation below). Not a substitute for length.
const COMMON = new Set(
  (
    "password,passw0rd,password1,password12,password123,password1234,123456,1234567,12345678,123456789,1234567890,12345678910,qwerty,qwerty123,qwertyuiop,qwerty12345," +
    "abc123,abcd1234,abcdefgh,abcdefghij,iloveyou,letmein,welcome,welcome1,welcome123,admin,admin123,administrator,monkey,dragon,master,sunshine,princess,football," +
    "baseball,superman,batman,trustno1,changeme,changeme123,111111,000000,123123,123321,654321,666666,987654321,0987654321,qazwsxedc,zaq12wsx,1q2w3e4r,1q2w3e4r5t," +
    "passpass,passwordpassword,letmein123,openseame,hello123,hellohello,test1234,testtest,default,secret,secret123,eoi12345,eoipassword,eoi123456"
  ).split(","),
);

// Common base words: a password that is one of these plus digits / symbols is as guessable as the word itself.
const COMMON_WORDS = new Set(["password", "passw", "pass", "qwerty", "letmein", "welcome", "admin", "administrator", "iloveyou", "monkey", "dragon", "master", "sunshine", "princess", "football", "baseball", "superman", "batman", "trustno", "changeme", "default", "secret", "hello", "test", "testtest", "login", "abc", "eoi"]);

/**
 * @returns {{ ok: boolean, message: string }} a plain, fixed sentence when the password is not acceptable. Nothing about the rule engine leaks.
 */
export function checkPasswordPolicy(password, { email, name } = {}) {
  const fail = (message) => ({ ok: false, message });
  if (typeof password !== "string") return fail("Please enter a password.");
  const value = prepare(password);
  if (value.length < PASSWORD_MIN_LENGTH) return fail(`Please use at least ${PASSWORD_MIN_LENGTH} characters for your password.`);
  if (value.length > PASSWORD_MAX_LENGTH) return fail(`Please keep your password to ${PASSWORD_MAX_LENGTH} characters or fewer.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) return fail("Please use ordinary characters in your password.");
  const lower = value.toLowerCase();
  const stripped = lower.replace(/[^a-z0-9]/g, "");
  // The same word with look-alike characters undone ("P@ssw0rd" -> "password") and its digits / symbols dropped ("password12345" -> "password").
  const unleet = lower.replace(/[\d\W_]+$/, "").replace(/[@4]/g, "a").replace(/3/g, "e").replace(/[1!|]/g, "i").replace(/0/g, "o").replace(/[5$]/g, "s").replace(/7/g, "t");
  const base = unleet.replace(/[^a-z]/g, "");
  const sequence = /^(?:0123456789|1234567890|qwertyuiop|asdfghjkl|zxcvbnm|abcdefghij)/.test(stripped);
  if (COMMON.has(lower) || COMMON.has(stripped) || COMMON_WORDS.has(base) || sequence || /^(.)\1+$/.test(value) || /^\d+$/.test(value) || new Set(value).size < 4) {
    return fail("That password is too easy to guess. Please choose a longer, less common one.");
  }
  const local = typeof email === "string" ? email.split("@")[0].toLowerCase() : "";
  if (local.length >= 4 && lower.includes(local)) return fail("Please choose a password that does not contain your email address.");
  const first = typeof name === "string" ? name.trim().split(/\s+/)[0]?.toLowerCase() : "";
  if (first && first.length >= 5 && lower === first) return fail("That password is too easy to guess. Please choose a longer, less common one.");
  return { ok: true, message: "" };
}
