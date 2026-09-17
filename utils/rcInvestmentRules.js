export const MINIMUM_RC_INVESTMENT_NOK = 1000;

export function validateRcInvestmentAmount(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      code: "invalid_amount",
      error: "Oppgi et gyldig investeringsbeløp."
    };
  }

  if (amount < MINIMUM_RC_INVESTMENT_NOK) {
    return {
      ok: false,
      code: "below_minimum_investment",
      error: "Minste investeringsbeløp er 1 000 NOK.",
      minimumInvestment: MINIMUM_RC_INVESTMENT_NOK
    };
  }

  return { ok: true, amount };
}
