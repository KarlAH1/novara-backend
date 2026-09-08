import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { escapeHtml } from "../utils/html.js";
import { createAuthToken, verifyAuthToken } from "../utils/authToken.js";
import { paymentMatches } from "../utils/stripePayments.js";
import { syncEmissionRoundAvailability } from "../utils/emissionRoundState.js";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("HTML values are escaped before entering legal templates", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="steal()"> O'Reilly & Co`),
    "&lt;img src=x onerror=&quot;steal()&quot;&gt; O&#39;Reilly &amp; Co"
  );
});

test("document preview is sandboxed and legacy signing cannot mutate documents", () => {
  const signPage = read("frontend/sign.html");
  const legacyRoutes = read("backend/routes/documentSignerRoutes.js");
  const inviteRoutes = read("backend/routes/rcInviteRoutes.js");
  assert.match(signPage, /<iframe id="documentViewer"[\s\S]*sandbox=""/);
  assert.doesNotMatch(signPage, /documentViewer"\)\.innerHTML\s*=\s*data\.html_content/);
  assert.match(legacyRoutes, /status\(410\)/);
  assert.doesNotMatch(legacyRoutes, /INSERT INTO document_signers/);
  assert.match(inviteRoutes, /router\.post\("\/access\/:token"[\s\S]*?status\(410\)/);
});

test("investor registration never persists a password in Web Storage", () => {
  const investSource = read("frontend/invest.js");
  assert.match(investSource, /JSON\.stringify\(\{ name, email \}\)/);
  assert.doesNotMatch(investSource, /sessionStorage\.setItem\([^\n]+password/);
});

test("initial UI state cannot animate or expose transient auth actions", () => {
  const configSource = read("frontend/config.js");
  const sharedStyles = read("frontend/styles.css");
  const loginPage = read("frontend/login.html");

  assert.match(configSource, /classList\.add\("ui-booting"\)/);
  assert.match(configSource, /dataset\.authState/);
  assert.match(sharedStyles, /html\.ui-booting \*[\s\S]*transition: none !important/);
  assert.match(sharedStyles, /body\[data-requires-auth\]:not\(\.auth-ready\) > \*[\s\S]*visibility: hidden/);
  assert.doesNotMatch(sharedStyles, /body\[data-requires-auth\]:not\(\.auth-ready\) > \*\s*\{[^}]*opacity:/);
  assert.match(loginPage, /<body class="[^"]*auth-entry-page/);
});

test("new auth tokens enforce algorithm, issuer and audience with a legacy rollout switch", () => {
  const previous = {
    secret: process.env.JWT_SECRET,
    legacy: process.env.ALLOW_LEGACY_JWT
  };
  process.env.JWT_SECRET = "test-secret-that-is-long-enough";
  process.env.ALLOW_LEGACY_JWT = "false";

  const token = createAuthToken({ id: 7, email: "user@example.no", role: "startup" });
  assert.equal(verifyAuthToken(token).id, 7);

  const legacyToken = jwt.sign({ id: 7 }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
  assert.throws(() => verifyAuthToken(legacyToken));

  if (previous.secret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previous.secret;
  if (previous.legacy === undefined) delete process.env.ALLOW_LEGACY_JWT;
  else process.env.ALLOW_LEGACY_JWT = previous.legacy;
});

test("Stripe activation accepts only the exact paid NOK amount", () => {
  const valid = { payment_status: "paid", currency: "nok", amount_total: 125000 };
  assert.equal(paymentMatches(valid, 1250), true);
  assert.equal(paymentMatches({ ...valid, payment_status: "unpaid" }, 1250), false);
  assert.equal(paymentMatches({ ...valid, currency: "eur" }, 1250), false);
  assert.equal(paymentMatches({ ...valid, amount_total: 124999 }, 1250), false);
});

test("availability reads do not write to the emission round", async () => {
  let showCount = 0;
  let updateCount = 0;
  const connection = {
    async query(sql) {
      if (sql.startsWith("SHOW COLUMNS")) {
        showCount += 1;
        return [[
          "discount_rate", "valuation_cap", "conversion_years", "trigger_period",
          "committed_amount", "status", "closed_at", "closed_reason"
        ].map((Field) => ({ Field }))];
      }
      if (sql.includes("UPDATE emission_rounds")) {
        updateCount += 1;
        return [{ affectedRows: 1 }];
      }
      return [[{
        id: 1,
        startup_id: 2,
        target_amount: 1000,
        committed_amount: 250,
        amount_raised: 250,
        deadline: new Date(Date.now() + 60000),
        open: 1,
        closed_reason: null
      }]];
    }
  };

  const first = await syncEmissionRoundAvailability(connection, 1);
  const second = await syncEmissionRoundAvailability(connection, 1);
  assert.equal(first.remainingCapacity, 750);
  assert.equal(second.remainingCapacity, 750);
  assert.equal(showCount, 1);
  assert.equal(updateCount, 0);
});
