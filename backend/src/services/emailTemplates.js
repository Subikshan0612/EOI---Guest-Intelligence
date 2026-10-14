/**
 * The three transactional emails EOI sends (Phase 46.1). Pure functions: text in, { subject, text, html } out.
 *
 * What they contain: the EOI name, the purpose, the person's display name, ONE link (built by emailService.buildLink from the configured CLIENT_URL, never from a
 * request), the expiry and short security guidance. What they never contain: a user/workspace/Mongo id, an evidence reference, a stack trace, a backend URL, a
 * password, an access or refresh token, or any SMTP detail. The link's one-time token is the only secret in a message, and only inside the link.
 */
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A display name safe for a plain-text greeting: one line, no control characters. */
const plainName = (name) => String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);

function layout({ heading, greeting, paragraphs, button, link, footer }) {
  const para = (p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155">${escapeHtml(p)}</p>`;
  return `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0">
<tr><td style="padding:28px 32px 8px;font-size:18px;font-weight:700;letter-spacing:.04em;color:#0f172a">EOI</td></tr>
<tr><td style="padding:8px 32px 0"><h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#0f172a">${escapeHtml(heading)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155">${escapeHtml(greeting)}</p>
${paragraphs.map(para).join("\n")}
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px">${escapeHtml(button)}</a></p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#64748b">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>
</td></tr>
<tr><td style="padding:8px 32px 28px;border-top:1px solid #e2e8f0"><p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#64748b">${escapeHtml(footer)}</p></td></tr>
</table></td></tr></table></body></html>`;
}

const GUIDANCE = "EOI will never ask you for your password by email. Do not forward this message: anyone holding the link can use it.";

export function verifyEmailMessage({ name, link }) {
  const who = plainName(name);
  const greeting = who ? `Hello ${who},` : "Hello,";
  const text = [
    greeting, "",
    "Welcome to EOI. Confirm your email address to finish creating your account:", "",
    link, "",
    "This link works once and expires in 24 hours.", "",
    "If you did not create an EOI account, you can ignore this message and nothing will happen.",
    GUIDANCE, "", "- EOI",
  ].join("\n");
  const html = layout({
    heading: "Verify your EOI account", greeting,
    paragraphs: ["Welcome to EOI. Confirm your email address to finish creating your account.", "This link works once and expires in 24 hours."],
    button: "Verify email address", link,
    footer: `If you did not create an EOI account, you can safely ignore this message. ${GUIDANCE}`,
  });
  return { subject: "Verify your EOI account", text, html };
}

export function resetPasswordMessage({ name, link }) {
  const who = plainName(name);
  const greeting = who ? `Hello ${who},` : "Hello,";
  const text = [
    greeting, "",
    "We received a request to reset the password of your EOI account. Choose a new one here:", "",
    link, "",
    "This link works once and expires in 30 minutes. Resetting your password signs you out of EOI everywhere.", "",
    "If you did not ask for this, ignore this message: your password will not change.",
    GUIDANCE, "", "- EOI",
  ].join("\n");
  const html = layout({
    heading: "Reset your EOI password", greeting,
    paragraphs: ["We received a request to reset the password of your EOI account.", "This link works once and expires in 30 minutes. Resetting your password signs you out of EOI everywhere."],
    button: "Choose a new password", link,
    footer: `If you did not ask for this, you can safely ignore this message: your password will not change. ${GUIDANCE}`,
  });
  return { subject: "Reset your EOI password", text, html };
}

/** Sent when someone tries to sign up with an address that already has an account: the answer to the browser is identical either way (no enumeration). */
export function accountExistsMessage({ link }) {
  const text = [
    "Hello,", "",
    "Someone (hopefully you) tried to create an EOI account with this email address, but an account already exists. You can sign in, or reset your password here:", "",
    link, "",
    "If this was not you, you can ignore this message.",
    GUIDANCE, "", "- EOI",
  ].join("\n");
  const html = layout({
    heading: "You already have an EOI account", greeting: "Hello,",
    paragraphs: ["Someone (hopefully you) tried to create an EOI account with this email address, but an account already exists.", "You can sign in, or reset your password if you have forgotten it."],
    button: "Reset my password", link,
    footer: `If this was not you, you can safely ignore this message. ${GUIDANCE}`,
  });
  return { subject: "You already have an EOI account", text, html };
}
