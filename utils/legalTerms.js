/*
  Acceptance of Raisium's brukervilkår and personvernerklæring.

  Every account is created through one of two doors: the startup registration
  and the investor's invite flow. Both must record that the person accepted the
  current terms, and which version, so it can be shown later which text they
  agreed to.

  Bump CURRENT_TERMS_VERSION whenever frontend/vilkar.html or
  frontend/personvern.html changes in substance, and update the "Sist oppdatert"
  date on both pages to match.
*/

export const CURRENT_TERMS_VERSION = "2026-10-19";

export const TERMS_NOT_ACCEPTED_ERROR =
  "Du må godta brukervilkårene og bekrefte at du har lest personvernerklæringen.";

export const TERMS_NOT_ACCEPTED_CODE = "TERMS_NOT_ACCEPTED";

// Only an explicit boolean true counts. A string, a 1 or a missing field is
// not a person ticking the box.
export function hasAcceptedTerms(body = {}) {
  return body?.acceptTerms === true;
}

export function termsNotAcceptedResponse(res) {
  return res.status(400).json({
    success: false,
    error: TERMS_NOT_ACCEPTED_ERROR,
    code: TERMS_NOT_ACCEPTED_CODE
  });
}
