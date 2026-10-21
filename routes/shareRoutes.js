import express from "express";
import pool from "../config/db.js";
import { escapeHtml } from "../utils/html.js";
import { frontendBase } from "../utils/emailLayout.js";

/*
  Link previews for personal invites.

  Messenger, SMS, WhatsApp and Slack read Open Graph tags from the HTML of a
  link and never run JavaScript, so a static page cannot show who sent the
  invitation. raisium.io/i/<token> is proxied here (see frontend/_redirects):
  this page carries the preview and sends the person on to the invite.

  It only reads. Opening the preview neither marks the invite as opened nor
  claims it; that happens on the invite page itself.
*/
const router = express.Router();

const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/i;

function previewPage({ title, description, target, imageUrl, url }) {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const targetAttr = escapeHtml(target);
  return `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Raisium">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${escapeHtml(url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="0; url=${targetAttr}">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#1d1d1f;background:#f5f5f7}a{color:#0e7a6e}</style>
</head>
<body>
<p><a href="${targetAttr}">Åpne invitasjonen</a></p>
<script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>`;
}

router.get("/i/:token", async (req, res) => {
  const base = frontendBase();
  const token = String(req.params.token || "").trim();
  const imageUrl = `${base}/assets/og-invite.png`;
  res.set("Cache-Control", "public, max-age=300");
  res.type("html");

  if (!TOKEN_PATTERN.test(token)) {
    return res.status(404).send(previewPage({
      title: "Raisium",
      description: "Private runder, drevet av startupen.",
      target: `${base}/`,
      imageUrl,
      url: base
    }));
  }

  try {
    const [[invite]] = await pool.query(
      `SELECT COALESCE(c.company_name, sp.company_name) AS company_name, owner.name AS founder_name
       FROM rc_invites i
       JOIN emission_rounds r ON r.id = i.round_id
       JOIN users owner ON owner.id = r.startup_id
       LEFT JOIN company_memberships cm ON cm.user_id = r.startup_id
       LEFT JOIN companies c ON c.id = cm.company_id
       LEFT JOIN startup_profiles sp ON sp.user_id = r.startup_id
       WHERE i.token = ?
       LIMIT 1`,
      [token]
    );

    const target = `${base}/invest.html?invite=${encodeURIComponent(token)}`;
    if (!invite) {
      return res.send(previewPage({
        title: "Personlig invitasjon",
        description: "En personlig invitasjon til en privat runde på Raisium.",
        target,
        imageUrl,
        url: `${base}/i/${token}`
      }));
    }

    const company = prettyCompanyName(invite.company_name || "selskapet");
    const founder = String(invite.founder_name || "").trim();
    res.send(previewPage({
      title: founder
        ? `${founder} har invitert deg til å investere i ${company}`
        : `Du er invitert til å investere i ${company}`,
      description: `En personlig invitasjon til en privat runde i ${company}. Se hva de gjør, og velg om du vil være med.`,
      target,
      imageUrl,
      url: `${base}/i/${token}`
    }));
  } catch (err) {
    console.error("Invite preview failed:", err);
    res.redirect(302, `${base}/invest.html?invite=${encodeURIComponent(token)}`);
  }
});

// Brønnøysund stores names in capitals; previews read better as people write them.
const COMPANY_FORM_WORDS = new Set(["AS", "ASA", "ANS", "DA", "SA", "BA", "NUF", "KS", "SE"]);
function prettyCompanyName(name) {
  const value = String(name || "").trim();
  if (!value || value !== value.toUpperCase()) return value;
  return value.split(/(\s+|-)/).map((part) => {
    if (!/[A-ZÆØÅ]/.test(part) || COMPANY_FORM_WORDS.has(part) || /\d/.test(part)) return part;
    return part.charAt(0) + part.slice(1).toLowerCase();
  }).join("");
}

export default router;
