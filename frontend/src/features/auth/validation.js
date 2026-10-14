/**
 * Client-side checks for the sign-in forms: they only save a round trip and give instant, plain feedback. The SERVER applies the real rules (and is the authority);
 * these mirror them closely but never replace them.
 */
export const EMAIL_PATTERN = /^[^\s@<>()[\]\,;:"]{1,64}@[^\s@<>()[\]\,;:"]+\.[^\s@<>()[\]\,;:"]{2,}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const normalizeEmailInput = (value) => String(value ?? "").normalize("NFC").trim();

export function emailProblem(value) {
  const email = normalizeEmailInput(value);
  if (!email) return "Please enter your email address.";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return "Please enter a valid email address.";
  return "";
}

export function nameProblem(value) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2) return "Please enter your full name.";
  if (name.length > 100 || /[\u0000-\u001f\u007f<>]/.test(name)) return "Please enter your full name using ordinary characters.";
  return "";
}

export function newPasswordProblem(password, { email } = {}) {
  const value = String(password ?? "");
  if (!value) return "Please choose a password.";
  if (value.length < PASSWORD_MIN) return `Please use at least ${PASSWORD_MIN} characters for your password.`;
  if (value.length > PASSWORD_MAX) return `Please keep your password to ${PASSWORD_MAX} characters or fewer.`;
  const local = String(email ?? "").split("@")[0].toLowerCase();
  if (local.length >= 4 && value.toLowerCase().includes(local)) return "Please choose a password that does not contain your email address.";
  return "";
}
