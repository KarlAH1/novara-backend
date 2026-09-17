import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import { escapeHtml } from "../utils/html.js";
import { createAuthToken, verifyAuthToken } from "../utils/authToken.js";
import { paymentMatches } from "../utils/stripePayments.js";
import { syncEmissionRoundAvailability } from "../utils/emissionRoundState.js";
import {
  MINIMUM_RC_INVESTMENT_NOK,
  validateRcInvestmentAmount
} from "../utils/rcInvestmentRules.js";
import { normalizeRoundDraftPayload } from "../utils/roundDraft.js";
import { normalizeInvestorFlowProgress } from "../utils/investorFlowProgress.js";

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
  // The preview frame is sandboxed and may never run scripts. It carries
  // allow-same-origin only so the page can measure the document and grow the
  // frame to full height (one scrollbar). That is safe precisely because
  // allow-scripts is absent — the two together would let the document escape
  // the sandbox — so any other capability is refused outright.
  const sandbox = signPage.match(/<iframe id="documentViewer"[\s\S]*?sandbox="([^"]*)"/);
  assert.ok(sandbox, "the document preview must be a sandboxed iframe");
  const tokens = sandbox[1].split(/\s+/).filter(Boolean);
  assert.deepEqual(
    tokens.filter((token) => token !== "allow-same-origin"),
    [],
    `the preview sandbox may grant nothing beyond allow-same-origin, got: ${sandbox[1]}`
  );
  assert.ok(!tokens.includes("allow-scripts"), "the preview must never run scripts");
  // And the document itself declares a CSP that blocks everything but inline styles.
  assert.match(signPage, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/);
  assert.doesNotMatch(signPage, /documentViewer"\)\.innerHTML\s*=\s*data\.html_content/);
  assert.match(legacyRoutes, /status\(410\)/);
  assert.doesNotMatch(legacyRoutes, /INSERT INTO document_signers/);
  assert.match(inviteRoutes, /router\.post\("\/access\/:token"[\s\S]*?status\(410\)/);
});

test("investor registration never persists a password in Web Storage", () => {
  const investSource = read("frontend/invest.js");
  const verifySource = read("frontend/invite-verify.html");
  const inviteRoutes = read("backend/routes/rcInviteRoutes.js");
  assert.match(investSource, /JSON\.stringify\(\{ name, email \}\)/);
  assert.doesNotMatch(investSource, /sessionStorage\.setItem\([^\n]+password/);
  assert.doesNotMatch(verifySource, /verifyInvestorPassword|Bekreft passordet ditt/);
  assert.match(inviteRoutes, /pending_password_hash/);
  assert.match(inviteRoutes, /SET verified_at = NOW\(\),[\s\S]*?pending_password_hash = NULL/);
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

test("the signed-in role controls the global UI color identity", () => {
  const configSource = read("frontend/config.js");
  const sharedStyles = read("frontend/styles.css");
  const investorFlow = read("frontend/invest.html");

  assert.match(configSource, /dataset\.authRole/);
  assert.match(configSource, /classList\.toggle\("page-investor", role === "investor"\)/);
  assert.match(configSource, /classList\.toggle\("page-startup", role === "startup"\)/);
  assert.match(sharedStyles, /html\[data-auth-role="investor"\] body/);
  assert.match(sharedStyles, /--role-ui-rgb: 42, 95, 176/);
  assert.match(sharedStyles, /--role-ui-rgb: 15, 118, 110/);
  assert.doesNotMatch(investorFlow, /rgba\(77, ?183, ?169|#0e7a6e|#159487/);
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

test("all RC investments enforce the standard NOK 1,000 minimum", () => {
  assert.equal(MINIMUM_RC_INVESTMENT_NOK, 1000);
  assert.equal(validateRcInvestmentAmount(999).ok, false);
  assert.equal(validateRcInvestmentAmount(999).code, "below_minimum_investment");
  assert.deepEqual(validateRcInvestmentAmount(1000), { ok: true, amount: 1000 });

  const agreementController = read("backend/controllers/rcAgreementController.js");
  const investPage = read("frontend/invest.html");
  assert.match(agreementController, /validateRcInvestmentAmount\(amount\)/);
  assert.match(investPage, /Minste investering:[\s\S]*?1 000 NOK/);
});

test("round drafts preserve partial progress without becoming operative terms", () => {
  const draft = normalizeRoundDraftPayload({
    lastStep: 9,
    fields: {
      conversion_years: "",
      discount_rate: "20 %",
      valuation_cap: "1 000 000 kr",
      bank_account: "1234.56"
    },
    shareholders: [
      { name: "Ada AS", source: "shares", share_count: 1250 },
      { name: "Uferdig eier", source: "percent" }
    ]
  });

  assert.equal(draft.lastStep, 3);
  assert.equal(draft.fields.conversion_years, "");
  assert.equal(draft.fields.valuation_cap, "1 000 000 kr");
  assert.equal(draft.shareholders[0].share_count, 1250);
  assert.equal(draft.shareholders[1].ownership_percent, null);

  const controller = read("backend/controllers/emissionController.js");
  const dashboard = read("frontend/dashboard.html");
  const nextTasks = read("backend/utils/nextTaskResolver.js");
  assert.match(controller, /saveRoundDraft\(/);
  assert.match(controller, /deleteRoundDraft\(connection, emissionId\)/);
  assert.match(dashboard, /Lagre og fortsett senere/);
  assert.match(nextTasks, /Fortsett der du slapp/);
});

test("investors can resume only an actual unfinished investment flow", () => {
  assert.deepEqual(
    normalizeInvestorFlowProgress({ stage: "review", amount: 2500 }),
    { stage: "review", amount: 2500 }
  );
  assert.deepEqual(
    normalizeInvestorFlowProgress({ stage: "profile_name", amount: 0 }),
    { stage: "terms", amount: null }
  );

  const inviteRoutes = read("backend/routes/rcInviteRoutes.js");
  const agreementController = read("backend/controllers/rcAgreementController.js");
  const investPage = read("frontend/invest.html");
  const nextTasks = read("backend/utils/nextTaskResolver.js");
  assert.match(inviteRoutes, /router\.put\("\/:token\/progress"/);
  assert.match(agreementController, /deleteInvestorFlowProgress/);
  assert.match(investPage, /Lagre og fortsett senere/);
  assert.match(nextTasks, /resume_investor_flow/);
});

test("an investor withdrawal stays resumable only while the round can still accept investments", () => {
  const agreementRoutes = read("backend/routes/rcAgreementRoutes.js");
  const progressStore = read("backend/utils/investorFlowProgress.js");
  const roundState = read("backend/utils/emissionRoundState.js");
  const inviteRoutes = read("backend/routes/rcInviteRoutes.js");

  const withdrawRoute = agreementRoutes.match(
    /INVESTOR WITHDRAWS BEFORE PAYING[\s\S]*?GET MY AGREEMENTS/
  )?.[0];
  assert.ok(withdrawRoute, "the investor withdrawal route must exist");
  assert.match(withdrawRoute, /preserveInvestorFlow: true/);
  assert.match(progressStore, /AND r\.open = 1/);
  assert.match(progressStore, /r\.deadline IS NULL OR r\.deadline >= NOW\(\)/);
  assert.match(progressStore, /r\.target_amount - COALESCE\(r\.committed_amount, r\.amount_raised, 0\) >= \?/);
  assert.match(roundState, /deleteInvestorFlowProgressForRound\(connection, roundId\)/);
  assert.match(inviteRoutes, /availability\.remainingCapacity < MINIMUM_RC_INVESTMENT_NOK/);
});

test("investors can resume several different rounds but can invest only once per round", () => {
  const taskRoutes = read("backend/routes/taskRoutes.js");
  const nextTasks = read("backend/utils/nextTaskResolver.js");
  const progressStore = read("backend/utils/investorFlowProgress.js");
  const profilePage = read("frontend/profile.html");
  const profileScript = read("frontend/script.js");
  const agreementController = read("backend/controllers/rcAgreementController.js");
  const agreementSchema = read("backend/utils/rcAgreementSchema.js");

  assert.match(taskRoutes, /res\.json\(\{[\s\S]*?tasks,/);
  assert.match(nextTasks, /getInvestorNextTasks/);
  assert.match(progressStore, /getInvestorFlowProgressList/);
  assert.doesNotMatch(
    progressStore.match(/export async function getInvestorFlowProgressList[\s\S]*?\n\}/)?.[0] || "",
    /LIMIT 1/
  );
  assert.match(profilePage, /id="nextTaskList"/);
  assert.match(profileScript, /tasks\.forEach/);
  assert.match(agreementController, /WHERE round_id = \? AND investor_id = \?/);
  assert.match(agreementController, /agreement_exists_for_round/);
  assert.match(agreementSchema, /uniq_rc_agreement_round_investor/);
});

test("the investor amount is capped by authoritative remaining round capacity", () => {
  const inviteRoutes = read("backend/routes/rcInviteRoutes.js");
  const agreementController = read("backend/controllers/rcAgreementController.js");
  const investSource = read("frontend/invest.js");

  assert.match(inviteRoutes, /getReservedAmount\(pool, invite\.round_id\)/);
  assert.match(inviteRoutes, /remainingCapacity,/);
  assert.match(agreementController, /requestedAmount > availability\.remainingCapacity/);
  assert.match(investSource, /amount > maximum/);
  assert.match(investSource, /Maks tilgjengelig beløp/);
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

test("public invite validation builds its estimate with an available database handle", () => {
  const inviteRoutes = read("backend/routes/rcInviteRoutes.js");
  const validateHandler = inviteRoutes.match(
    /router\.get\("\/validate\/:token"[\s\S]*?\n\}\);/
  )?.[0];

  assert.ok(validateHandler, "the public invite validation route must exist");
  assert.match(validateHandler, /buildInviteParEstimate\(pool, invite\)/);
  assert.doesNotMatch(validateHandler, /buildInviteParEstimate\(connection, invite\)/);
});
