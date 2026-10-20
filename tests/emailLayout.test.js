import test from "node:test";
import assert from "node:assert/strict";
import { renderEmail, wrapLegacyEmail } from "../utils/emailLayout.js";

test("text in an e-mail is escaped, so a name cannot inject markup", () => {
  const html = renderEmail({
    heading: "<script>alert(1)</script> har invitert deg",
    box: { amount: "25 000 kr", label: "<b>Privat runde</b>" },
    button: { label: "Se \"invitasjonen\"", url: "https://raisium.io/invest.html?invite=a&b=1" }
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;b&gt;Privat runde&lt;/b&gt;"));
  assert.ok(html.includes('href="https://raisium.io/invest.html?invite=a&amp;b=1"'));
});

test("a code is shown large in the grey box, and the investor accent is blue", () => {
  const html = renderEmail({ heading: "Koden din", box: { code: "482913" }, accent: "investor" });
  assert.match(html, /letter-spacing:0\.22em;[^>]*>482913</);
  const button = renderEmail({ heading: "x", button: { label: "Åpne", url: "https://x" }, accent: "investor" });
  assert.match(button, /background:#1f63c6/);
});

test("older bodies get the frame, with a lone link turned into the button", () => {
  const html = wrapLegacyEmail({
    subject: "Bekreftelse",
    html: `<p>Hei,</p><p><a href="https://raisium.io/x?a=1&amp;b=2">Åpne</a></p>`
  });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /border-radius:999px[^>]*>Åpne<\/a>/);
  assert.ok(html.includes('href="https://raisium.io/x?a=1&amp;b=2"'));
  // Already framed e-mails pass through untouched.
  assert.equal(wrapLegacyEmail({ subject: "s", html }), html);
});
