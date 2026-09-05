import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
  The Change of Control provisions were deliberately rewritten: the earlier
  agreement let the investor take cash instead of shares, at no less than the
  Investment Amount, and made cash the default if they said nothing. That gave
  the instrument a repayment floor and made it look like debt.

  Change of Control is now simply a Trigger Event. These tests pin that, and pin
  the line between investment risk and contractual breach, so neither can drift
  back.
*/

const templatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const rc = () => fs.readFileSync(path.join(templatesDir, "rc-template.html"), "utf8")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/* ------------------------------------------- no cash-out on Change of Control */

test("Change of Control is a trigger event, not a cash settlement", () => {
  const text = rc();
  assert.match(text, /Change of Control er et Trigger Event/);
  assert.match(text, /RC-aksjene beregnes, tegnes og utstedes gjennom en kapitalforhøyelse/);
});

test("Change of Control creates no repayment right and no Investment Amount floor", () => {
  const text = rc();
  assert.match(
    text,
    /Change of Control gir ikke Investor rett til å kreve Investeringsbeløpet tilbakebetalt/
  );
  assert.match(text, /ikke Investor krav på et kontantoppgjør som tilsvarer eller er begrenset nedad til Investeringsbeløpet/);
});

test("silence never defaults to a cash settlement", () => {
  const text = rc();
  assert.match(
    text,
    /Manglende svar eller passivitet fra Investor innebærer ikke at Investor anses å ha valgt et kontantoppgjør/
  );
  // The old default-to-cash rule must be gone entirely.
  assert.ok(
    !/anses Investor å ha valgt kontantoppgjør/.test(text),
    "the old cash-by-default election has come back"
  );
});

test("the old higher-of-Investment-Amount election is gone", () => {
  const text = rc();
  assert.ok(
    !/kontantoppgjør uten aksjeutstedelse, lik det høyeste av/.test(text),
    "clause 6.2(b)'s cash floor is still present"
  );
});

test("a Change of Control does not terminate the RC", () => {
  const text = rc();
  assert.match(text, /opphører RC-en ikke som følge av transaksjonen/);
  assert.match(text, /Avtalen opphører ikke ved at et Trigger Event inntreffer uten at Selskapet gjennomfører sine forpliktelser/);
  // Termination on receipt of a cash settlement was removed with the mechanism.
  assert.ok(!/Investor har mottatt fullt kontantoppgjør/.test(text));
});

test("a planned transaction obliges the company to start implementation", () => {
  const text = rc();
  assert.match(text, /blir kjent med en planlagt disposisjon som vil utgjøre en Utløsende Hendelse/);
  assert.match(text, /uten ugrunnet opphold iverksette de handlingene/);
});

/* ------------------------------------------------------- anti-circumvention */

test("the agreement forbids deliberate circumvention", () => {
  const text = rc();
  assert.match(text, /Omgåelse og lojalitet/);
  assert.match(
    text,
    /hovedformålet med handlingen eller unnlatelsen er å omgå eller vesentlig forringe Investors avtalte rettigheter/
  );
});

test("related transactions are assessed together, so a sale cannot be split apart", () => {
  const text = rc();
  assert.match(text, /én transaksjon og flere innbyrdes sammenhengende transaksjoner under ett/);
  assert.match(text, /delt opp i flere koordinerte transaksjoner/);
});

test("ordinary business decisions are not circumvention", () => {
  const text = rc();
  assert.match(text, /rammer ikke alminnelige, forretningsmessig begrunnede beslutninger/);
});

/* --------------------------------------- business failure is not a breach */

test("business failure is expressly not a breach of the RC", () => {
  const text = rc();
  assert.match(
    text,
    /Tap som skyldes Selskapets forretningsmessige utvikling, verdifall, manglende lønnsomhet, manglende evne til å hente ny kapital eller insolvens utgjør ikke i seg selv mislighold/
  );
  assert.match(text, /Investeringsrisiko og mislighold av avtalte forpliktelser er to forskjellige forhold/);
});

test("insolvency creates no repayment claim", () => {
  const text = rc();
  assert.match(text, /ingen alminnelig rett til tilbakebetaling av Investeringsbeløpet/);
  assert.match(text, /gir ikke Investor krav på tilbakebetaling av Investeringsbeløpet/);
});

/* ------------------------------------------------- breach without becoming debt */

test("material breach is defined without turning the RC into a loan", () => {
  const text = rc();
  assert.match(text, /Vesentlig mislighold og misligholdsbeføyelser/);
  assert.match(text, /kreve oppfyllelse i den utstrekning dette er rettslig mulig, og erstatning for dokumentert økonomisk tap/);

  // The one sentence the model must never contain.
  assert.ok(
    !/Ved mislighold tilbakebetales Investeringsbeløpet/i.test(text),
    "breach must not create a repayment of the investment amount"
  );
  assert.match(
    text,
    /gjør ikke Investeringsbeløpet om til en tilbakebetalingspliktig lånehovedstol/
  );
});

test("remedies do not pretend the investor already owns shares", () => {
  const text = rc();
  assert.match(text, /innebærer ikke at Investor allerede eier aksjer/);
  assert.match(text, /setter ikke til side ufravikelige selskapsrettslige krav/);
});

test("no penalty or liquidated-damages mechanism was invented", () => {
  const text = rc();
  assert.match(text, /gir ingen rett til konvensjonalbot eller annen straffesanksjon/);
});

/* ----------------------------------------- company obligation without guarantee */

test("the company owes a concrete process after a trigger", () => {
  const text = rc();
  assert.match(text, /Etter et Trigger Event skal Selskapet uten ugrunnet opphold/);
  for (const step of [
    /beregne antall RC-aksjer og Paribeløpet/,
    /varsle Investor om beregningen/,
    /fremme forslag om kapitalforhøyelse for kompetent selskapsorgan/,
    /oversende Investor tegningsdokumentasjon/,
    /motta Paribeløpet som aksjeinnskudd/,
    /utarbeide oppdaterte vedtekter og oppdatert aksjeeierbok/
  ]) {
    assert.match(text, step);
  }
});

test("the company does not guarantee how the general meeting will vote", () => {
  const text = rc();
  assert.match(
    text,
    /Selskapet garanterer ikke, og kan ikke garantere, at generalforsamlingen utøver sin lovbestemte myndighet i en bestemt retning/
  );
});

test("founders undertake to vote, within the limits of mandatory law", () => {
  const text = rc();
  assert.match(text, /innenfor rammene av ufravikelig lov og sine aksjonærrettigheter, til å stemme for og ellers medvirke/);
  assert.match(text, /forplikter seg ikke til rettslige handlinger som ligger utenfor Grunnleggerens kontroll/);
});

test("the investor's reciprocal subscription obligation survives the rewrite", () => {
  const text = rc();
  assert.match(text, /Investors tegningsforpliktelse/);
  assert.match(text, /forplikter Investor seg til å gjennomføre nødvendig tegning og innbetale Paribeløpet/);
});
