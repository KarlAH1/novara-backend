import { escapeHtml } from "./html.js";

/*
  One look for every e-mail Raisium sends: a white card on a light grey page,
  the logo in a small pill, one large heading, a short line, a grey box with
  the thing that matters (an amount, a code, a message) and one pill button.

  Tables and inline styles only: that is what e-mail clients render reliably.
  Every text argument is escaped here; only `introHtml` and box `linesHtml`
  take markup, and callers escape what they put into those.
*/

const ACCENTS = {
  startup: "#0f766e",
  investor: "#1f63c6"
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function frontendBase() {
  return String(process.env.FRONTEND_URL || "").split(",")[0].trim().replace(/\/+$/, "");
}

function boxHtml(box) {
  if (!box) return "";
  const parts = [];
  if (box.code) {
    parts.push(`<div style="font-size:32px;font-weight:700;letter-spacing:0.22em;color:#1d1d1f;">${escapeHtml(box.code)}</div>`);
  }
  if (box.amount) {
    parts.push(`<div style="font-size:24px;font-weight:600;color:#1d1d1f;">${escapeHtml(box.amount)}</div>`);
  }
  if (box.label) {
    parts.push(`<div style="margin-top:4px;font-size:14px;color:#6e6e73;">${escapeHtml(box.label)}</div>`);
  }
  if (box.linesHtml) {
    const divider = parts.length
      ? `<div style="height:1px;margin:16px 0;background:#e3e3e8;line-height:1px;font-size:1px;">&nbsp;</div>`
      : "";
    parts.push(`${divider}<div style="font-size:15px;line-height:1.6;color:#1d1d1f;">${box.linesHtml}</div>`);
  }
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 0;background:#f3f4f6;border-radius:12px;">
      <tr><td style="padding:20px 22px;">${parts.join("")}</td></tr>
    </table>`;
}

export function renderEmail({
  heading,
  introHtml = "",
  box = null,
  button = null,
  after = "",
  preheader = "",
  accent = "startup"
}) {
  const color = ACCENTS[accent] || ACCENTS.startup;
  const logo = `${frontendBase()}/assets/logo-192.png`;
  const buttonHtml = button?.url
    ? `<a href="${escapeHtml(button.url)}" style="display:inline-block;margin-top:24px;padding:13px 26px;border-radius:999px;background:${color};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(button.label || "Åpne")}</a>`
    : "";
  const fallbackLink = button?.url
    ? `<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:#86868b;">Virker ikke knappen? Åpne denne lenken:<br><a href="${escapeHtml(button.url)}" style="color:#86868b;word-break:break-all;">${escapeHtml(button.url)}</a></p>`
    : "";

  return `<!doctype html>
<html lang="no">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;">
  <span style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || heading)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;font-family:${FONT};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;">
        <tr><td style="padding:36px 36px 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="border:1px solid #e5e5ea;border-radius:12px;">
            <tr><td style="padding:9px 14px;">
              <img src="${escapeHtml(logo)}" width="24" height="24" alt="" style="vertical-align:middle;border-radius:6px;border:0;">
              <span style="vertical-align:middle;margin-left:8px;font-size:13px;font-weight:700;letter-spacing:0.18em;color:#1d1d1f;">RAISIUM</span>
            </td></tr>
          </table>
          <h1 style="margin:28px 0 12px;font-size:26px;line-height:1.25;font-weight:700;color:#1d1d1f;">${escapeHtml(heading)}</h1>
          ${introHtml ? `<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3a3a3c;">${introHtml}</p>` : ""}
          ${boxHtml(box)}
          ${buttonHtml}
          ${after ? `<p style="margin:24px 0 0;font-size:13px;line-height:1.55;color:#6e6e73;">${escapeHtml(after)}</p>` : ""}
          ${fallbackLink}
        </td></tr>
      </table>
      <p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#86868b;">Raisium · Programvare for private runder i eget nettverk</p>
    </td></tr>
  </table>
</body>
</html>`;
}

/*
  E-mails not yet written for the layout (a few in payment confirmations and
  conversion) still get the frame: paragraphs styled, a lone link in a
  paragraph turned into the button.
*/
export function wrapLegacyEmail({ subject, html }) {
  if (/<!doctype|<html/i.test(String(html || ""))) return html;
  let button = null;
  const body = String(html || "")
    .replace(/<p>\s*<a href="([^"]+)">([^<]+)<\/a>\s*<\/p>/i, (match, url, label) => {
      button = { url: url.replace(/&amp;/g, "&"), label: label.replace(/&amp;/g, "&") };
      return "";
    })
    .replace(/<p>/g, '<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3a3a3c;">');
  return renderEmail({ heading: subject, introHtml: "", box: null, button, after: "" })
    .replace("<h1", `<!-- legacy -->\n          <h1`)
    .replace("</h1>", `</h1>\n          ${body}`);
}
