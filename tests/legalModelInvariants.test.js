import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
  The legal model lives in the document templates as much as in the code. These
  tests pin the SLIP-style architecture so a careless edit can't quietly
  reintroduce the abandoned set-off model:

    - Year 0: the investor pays the Investment Amount and receives a contractual
      right. No shares are issued, no capital increase happens, and the investor
      is not a shareholder.
    - Exercise: the investor pays only the aggregate par value in cash. No part
      of the Investment Amount is set off against the subscription obligation,
      so no § 2-6 redegjørelse and no auditor set-off confirmation arise.
*/

const templatesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates"
);

const readTemplate = (name) => fs.readFileSync(path.join(templatesDir, name), "utf8");

const stripTags = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// Templates covering year 0 — RC signing and the resolutions that authorise it.
const YEAR_ZERO_TEMPLATES = ["rc-template.html", "gf-template.html", "bp-template.html"];

// Templates covering the exercise event — the capital increase itself.
const EXERCISE_TEMPLATES = [
  "sfc-template.html",
  "gfc-template.html",
  "conversion-capital-confirmation-template.html",
  "altinn-package-template.html"
];

const ALL_TEMPLATES = [...YEAR_ZERO_TEMPLATES, ...EXERCISE_TEMPLATES];

test("no template references the abandoned § 2-6 redegjørelse", () => {
  for (const name of ALL_TEMPLATES) {
    const text = readTemplate(name).toLowerCase();
    assert.ok(!text.includes("redegjør"), `${name} still mentions a redegjørelse`);
    assert.ok(!text.includes("2-6"), `${name} still cites § 2-6`);
  }
});

test("the redegjørelse template is gone", () => {
  assert.equal(
    fs.existsSync(path.join(templatesDir, "redegjorelse-template.html")),
    false,
    "the § 2-6 redegjørelse template belongs to the abandoned set-off model"
  );
});

test("set-off is only ever mentioned to rule it out", () => {
  // Sentences that mention motregning must say it does not happen. Any bare
  // affirmative use means the set-off model has crept back in.
  const ALLOWED = [
    "skal ikke benyttes til motregning",
    "skal ikke gjøres opp ved motregning",
    "ikke gir investor en fordring som skal motregnes",
    "gir ikke investor en fordring som skal motregnes",
    "ikke skal motregnes"
  ];

  for (const name of ALL_TEMPLATES) {
    const text = stripTags(readTemplate(name)).toLowerCase();
    if (!text.includes("motregn")) continue;

    const negated = ALLOWED.some((phrase) => text.includes(phrase));
    assert.ok(negated, `${name} mentions motregning without ruling it out`);
  }
});

test("year-0 templates issue no shares and no capital increase", () => {
  for (const name of YEAR_ZERO_TEMPLATES) {
    const text = stripTags(readTemplate(name)).toLowerCase();
    assert.ok(
      text.includes("kontraktsrettslig rett"),
      `${name} must describe the investor's contractual right to subscribe later`
    );
    // A capital increase may only be mentioned to say it does not happen yet.
    const affirmsIncrease = /aksjekapitalen forhøyes(?! ikke)/.test(text);
    assert.ok(
      !affirmsIncrease,
      `${name} must not resolve a capital increase at year 0`
    );
  }
});

test("the RC agreement states that the par amount is the only payment on exercise", () => {
  const text = stripTags(readTemplate("rc-template.html"));
  assert.ok(
    text.includes("Paribeløpet er det eneste beløpet Investor skal innbetale ved utøvelse"),
    "clause 5.3 must state the par amount is the only payment due on exercise"
  );
});

test("the RC is never characterised as a loan, a claim or a subscription right", () => {
  // Words that would recharacterise the instrument. Each is allowed only in a
  // sentence that rules it out.
  const FORBIDDEN_UNLESS_NEGATED = [
    ["ugjenkallelig", []],
    ["warrant", []],
    ["konvertibelt lån", []],
    ["gjeldskonvertering", []],
    ["frittstående tegningsrett", ["innebærer ikke at aksjer eller frittstående tegningsretter"]]
  ];

  for (const name of ALL_TEMPLATES) {
    const text = stripTags(readTemplate(name)).toLowerCase();
    for (const [term, allowances] of FORBIDDEN_UNLESS_NEGATED) {
      if (!text.includes(term)) continue;
      const negated = allowances.some((phrase) => text.includes(phrase));
      assert.ok(negated, `${name} uses "${term}" without ruling it out`);
    }
  }
});

test("the RC agreement rules out a § 11-12 freestanding subscription right", () => {
  const text = stripTags(readTemplate("rc-template.html"));
  assert.match(text, /§ 11-12/, "the agreement must address § 11-12 explicitly");
  assert.match(
    text,
    /innebærer ikke at aksjer eller frittstående tegningsretter etter aksjeloven § 11-12 utstedes/,
    "the agreement must state that no § 11-12 right is issued at signing"
  );
  assert.match(
    text,
    /bare utstedes etter særskilt og gyldig beslutning om kapitalforhøyelse etter aksjeloven kapittel 10/,
    "new shares must require a valid Chapter 10 resolution"
  );
});

test("the RC agreement obliges the investor to subscribe once the increase is resolved", () => {
  const text = stripTags(readTemplate("rc-template.html"));
  assert.match(text, /Investors tegningsforpliktelse/);
  assert.match(text, /forplikter Investor seg til å gjennomføre nødvendig tegning og innbetale Paribeløpet/);
});

test("the RC agreement does not remove the general meeting's statutory competence", () => {
  const text = stripTags(readTemplate("rc-template.html"));
  assert.match(
    text,
    /kan ikke ved avtale frata generalforsamlingen den beslutningsmyndigheten som følger av aksjeloven/
  );
  // The founders' undertaking must stay a contractual obligation only.
  assert.match(text, /Det erstatter ikke de selskapsrettslige beslutningene som kreves etter aksjeloven/);
});

test("the RC agreement states one rounding rule, and it is rounding down", () => {
  const text = stripTags(readTemplate("rc-template.html"));
  assert.match(text, /Antall RC-aksjer rundes derfor ned til nærmeste hele aksje/);
  assert.ok(
    !/rundes.{0,40}opp til nærmeste hele aksje/.test(text),
    "no second, contradictory rounding rule may appear"
  );
});

test("the RC agreement defines the capitalization denominator", () => {
  const text = stripTags(readTemplate("rc-template.html"));
  assert.match(text, /Kapitaliseringsgrunnlaget er Selskapets utstedte aksjer/);
  // It must exclude the shares being issued and any undrawn instruments, which
  // is what the calculator does.
  assert.match(text, /inngår ikke i kapitaliseringsgrunnlaget/);
});

test("the RC agreement defines a share price for each of the three triggers", () => {
  const text = stripTags(readTemplate("rc-template.html"));
  assert.match(text, /Ved Equity Financing er Tegningskursen den laveste av/);
  assert.match(text, /Ved Change of Control og ved utløpet av Utøvelsesperioden er Tegningskursen lik Cap-kursen/);
});

test("the long-stop period is not hardcoded in the agreement text", () => {
  const text = stripTags(readTemplate("rc-template.html"));
  assert.ok(
    !/Utøvelsesperioden er 36 måneder/.test(text),
    "the long-stop must come from the signed terms, not a hardcoded 36 months"
  );
  assert.match(text, /perioden som er angitt i Vedlegg 1 for denne avtalen/);
  assert.match(text, /låst ved signering/);
});

test("exercise templates describe a cash contribution at par with no premium", () => {
  for (const name of ["sfc-template.html", "gfc-template.html", "conversion-capital-confirmation-template.html"]) {
    const text = stripTags(readTemplate(name)).toLowerCase();
    assert.ok(
      text.includes("kontant") && text.includes("pålydende"),
      `${name} must describe a cash contribution at par value`
    );
    assert.ok(
      text.includes("ingen overkurs") || text.includes("ikke tilført overkurs"),
      `${name} must state that no share premium arises`
    );
  }
});
