import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signTypeFor } from "../utils/pendingSignatures.js";

const frontendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");

/*
  VS Code Live Server injects its reload script in front of the first "</body>"
  it finds in a file — even one inside a JavaScript string. The injected
  "</script>" then closes the page's own script early, the rest of the code is
  rendered as text, and nothing on the page works. sign.html did exactly this.

  Inside inline scripts, write "<\/body>" instead; it is the same string in JS.
*/
test("no inline script contains a literal closing body, head, html or svg tag", () => {
  const offenders = [];

  for (const file of fs.readdirSync(frontendDir).filter((f) => f.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(frontendDir, file), "utf8");
    const scripts = html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi);
    for (const [, body] of scripts) {
      for (const tag of ["</body>", "</head>", "</html>", "</svg>"]) {
        if (body.toLowerCase().includes(tag)) offenders.push(`${file}: ${tag}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `write these as "<\\/tag>" inside scripts: ${offenders.join(", ")}`);
});

test("sign links carry the document's real type", () => {
  assert.equal(signTypeFor("BOARD"), "board");
  assert.equal(signTypeFor("GF"), "gf");
  assert.equal(signTypeFor("RC"), "rc");
  assert.equal(signTypeFor("CONVERSION_ARTICLES"), "conversion");
  assert.equal(signTypeFor(null), "conversion");
});

test("regenerating a year-0 document removes earlier unsigned drafts only", () => {
  const cleanup = fs.readFileSync(
    path.join(frontendDir, "..", "backend", "utils", "legalDocumentCleanup.js"), "utf8"
  );
  assert.match(cleanup, /export async function removeUnsignedDrafts/);
  // Never a signed or locked document, and never a draft someone has signed.
  assert.match(cleanup, /d\.status = 'DRAFT'/);
  assert.match(cleanup, /ds\.signed_at IS NOT NULL/);

  for (const route of ["boardRoutes.js", "gfRoutes.js"]) {
    const source = fs.readFileSync(path.join(frontendDir, "..", "backend", "routes", route), "utf8");
    assert.match(source, /await removeUnsignedDrafts\(pool, startupId,/, `${route} must clear old drafts`);
  }
});
