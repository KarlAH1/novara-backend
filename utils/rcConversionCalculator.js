import * as D from "./exactDecimal.js";

/*
  Version of the authoritative conversion arithmetic. Persisted with every
  frozen calculation snapshot so a historical conversion can be reproduced
  without depending on whatever this file happens to say today.

  Bump this whenever the formula, the rounding rule, the price selection or the
  capitalization denominator changes.
*/
export const RC_CALCULATION_VERSION = "1.1";

/*
  Version of the legal model the RC documents implement. Not a claim of legal
  approval — it identifies which set of terms an executed RC was written under.
*/
export const RAISIUM_RC_LEGAL_MODEL_VERSION = "1.0";

/*
  Fractional shares cannot be issued, so the raw share count is rounded DOWN to
  a whole share. Rounding down is the conservative direction: it can never
  allocate an investor more economic value than the Investment Amount paid for,
  and the unused remainder is reported as rounding_difference rather than
  silently dropped. This single rule is authoritative for the contract, the
  calculator, the preview, the documents and the tests.
*/
export const RC_ROUNDING_METHOD = "floor";

/*
  The capitalization denominator for the standard Raisium RC.

  This is an economic term, not an implementation detail: it is the divisor that
  turns a valuation cap into a share price, so it decides how many shares an
  investor gets. It is therefore stated explicitly rather than inherited from
  whatever a query happens to return.

  V1 is ISSUED_SHARES_ONLY: the shares actually issued by the company, per the
  share basis the company has confirmed against its current articles,
  immediately before the capital increase under the RC.

  It is deliberately NOT a fully diluted basis. Options, an unissued option
  pool, other outstanding RC agreements, convertibles, warrants and other rights
  are excluded. A fully diluted denominator is larger, which makes the share
  price lower and hands the investor more shares — that is a different economic
  deal, and switching to it silently would change the economics of every round.
  If a future model includes such instruments, it gets its own basis type and
  its own calculation version.
*/
export const CAPITALIZATION_BASIS_TYPE = "ISSUED_SHARES_ONLY";

export const CAPITALIZATION_BASIS = {
  type: CAPITALIZATION_BASIS_TYPE,
  included_instrument_categories: ["issued_shares"],
  excluded_instrument_categories: [
    "unissued_option_pool",
    "granted_options",
    "other_rc_agreements",
    "convertible_instruments",
    "warrants",
    "subscription_rights"
  ],
  description_no:
    "Antall aksjer som faktisk er utstedt i selskapet, slik det følger av det " +
    "aksjegrunnlaget selskapet har bekreftet mot gjeldende vedtekter, umiddelbart " +
    "før kapitalforhøyelsen etter RC-en."
};

function toNumber(value) {
  // null, undefined and "" are absent values, not zero. Number(null) is 0,
  // which would turn "no discount agreed" into "a discount of 0 %" and stop a
  // frozen snapshot from replaying to exactly the same result.
  if (value === null || value === undefined || value === "") return null;

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

export function calculateRcConversion(input = {}) {
  const investmentAmount = toNumber(input.investment_amount);
  const valuationCap = toNumber(input.valuation_cap);
  const discountPercent = toNumber(input.discount_percent);
  const pricedRoundSharePrice = toNumber(input.priced_round_share_price);
  const capitalizationBaseShareCount = toNumber(input.capitalization_base_share_count);
  const nominalValuePerShare = toNumber(input.nominal_value_per_share);
  const triggerType = String(input.trigger_type || "").trim();

  if (!investmentAmount || investmentAmount <= 0) {
    throw new Error("investment_amount må være større enn 0.");
  }
  if (!capitalizationBaseShareCount || capitalizationBaseShareCount <= 0) {
    throw new Error("capitalization_base_share_count må være større enn 0.");
  }
  if (!nominalValuePerShare || nominalValuePerShare <= 0) {
    throw new Error("nominal_value_per_share må være større enn 0.");
  }
  if (!triggerType) {
    throw new Error("trigger_type mangler.");
  }

  /*
    From here the arithmetic is exact.

    The share price derived from a valuation cap is a rational number:
    NOK 1,000,000 over 30,000 shares is exactly 100/3, not 33.33. Rounding it to
    øre before dividing the investment by it moves the raw share count, and near
    a whole-share boundary that costs the investor a share. So the price stays
    an exact fraction until the one rounding the contract actually prescribes:
    floor to a whole share.
  */
  const parValueExact = D.fromNumber(nominalValuePerShare);
  const investmentExact = D.fromNumber(investmentAmount);

  const capPriceExact = valuationCap && valuationCap > 0
    ? D.divide(D.fromNumber(valuationCap), D.fromNumber(capitalizationBaseShareCount))
    : null;

  let discountPriceExact = null;
  if (triggerType === "new_priced_round") {
    const roundPriceExact = (pricedRoundSharePrice == null || pricedRoundSharePrice <= 0)
      ? capPriceExact
      : D.fromNumber(pricedRoundSharePrice);

    if (roundPriceExact == null || !D.isPositive(roundPriceExact)) {
      throw new Error("Kunne ikke beregne pris per aksje ved ny emisjon.");
    }

    if (discountPercent != null && discountPercent > 0) {
      discountPriceExact = D.multiply(
        roundPriceExact,
        D.divide(D.fromNumber(100 - discountPercent), D.fromNumber(100))
      );
    }
  }

  let sharePriceExact = null;

  if (triggerType === "new_priced_round") {
    if (capPriceExact != null && discountPriceExact != null) {
      sharePriceExact = D.min(capPriceExact, discountPriceExact);
    } else if (capPriceExact != null) {
      sharePriceExact = capPriceExact;
    } else if (discountPriceExact != null) {
      sharePriceExact = discountPriceExact;
    } else {
      throw new Error("Kunne ikke beregne konverteringspris. valuation_cap eller discount må være satt.");
    }
  } else {
    if (capPriceExact == null || !D.isPositive(capPriceExact)) {
      throw new Error("valuation_cap må være satt for denne trigger-typen.");
    }
    sharePriceExact = capPriceExact;
  }

  if (!D.isPositive(sharePriceExact)) {
    throw new Error("chosen_conversion_price må være større enn 0.");
  }

  /*
    Share Price is the investor's total economic price per share. The investor
    has already paid the Investment Amount when entering the RC, and pays the
    par value per share on exercise, so the Investment Amount only has to cover
    the part of the price above par:

      RC Shares = Investment Amount / (Share Price - Par Value)
      Par Amount = RC Shares * Par Value

    The Investment Amount is not set off against the subscription obligation —
    it is accounted for through the share count.
  */
  const priceAboveParExact = D.subtract(sharePriceExact, parValueExact);

  if (!D.isPositive(priceAboveParExact)) {
    const error = new Error(
      "Tegningskursen er lik eller lavere enn aksjenes pålydende. Rundens vilkår eller selskapets aksjestruktur må gjennomgås før konvertering kan gjennomføres."
    );
    error.code = "SHARE_PRICE_NOT_ABOVE_PAR";
    error.details = {
      share_price: D.toRoundedNumber(sharePriceExact, 2),
      par_value_per_share: roundMoney(nominalValuePerShare)
    };
    throw error;
  }

  const rawShareCountExact = D.divide(investmentExact, priceAboveParExact);

  // The single contractual rounding: down to a whole share, applied once.
  const conversionShareCount = Number(D.floorToInteger(rawShareCountExact));

  if (!Number.isSafeInteger(conversionShareCount) || conversionShareCount <= 0) {
    throw new Error("Konverteringen gir 0 aksjer. Sjekk inputverdiene.");
  }

  const sharesExact = D.rational(BigInt(conversionShareCount));

  // The only cash the investor pays on exercise. It equals the aggregate par
  // value, so the capital increase carries no share premium. Calculated only
  // after the final whole-share allocation.
  const parAmount = D.toRoundedNumber(D.multiply(sharesExact, parValueExact), 2);
  const investmentApplied = D.toRoundedNumber(D.multiply(sharesExact, priceAboveParExact), 2);
  const roundingDifference = roundMoney(investmentAmount - investmentApplied);

  const capPrice = capPriceExact == null ? null : D.toRoundedNumber(capPriceExact, 2);
  const discountPrice = discountPriceExact == null ? null : D.toRoundedNumber(discountPriceExact, 2);
  const sharePrice = D.toRoundedNumber(sharePriceExact, 2);
  const rawShareCount = Number(D.toExactString(rawShareCountExact, 12));

  return {
    // Inputs, echoed back so the snapshot alone is enough to reproduce the
    // result without re-reading the round or the startup profile.
    calculation_version: RC_CALCULATION_VERSION,
    capitalization_basis_type: CAPITALIZATION_BASIS_TYPE,
    investment_amount: roundMoney(investmentAmount),
    valuation_cap: valuationCap == null ? null : roundMoney(valuationCap),
    discount_percent: discountPercent == null ? null : discountPercent,
    trigger_type: triggerType,
    priced_round_share_price: pricedRoundSharePrice == null ? null : roundMoney(pricedRoundSharePrice),
    // The single authoritative capitalization denominator: the company's issued
    // shares per its current Articles of Association, before this conversion.
    capitalization_denominator: capitalizationBaseShareCount,
    capitalization_basis: "issued_shares_current_articles",

    cap_price: capPrice,
    discount_price: discountPrice,
    share_price: roundMoney(sharePrice),
    chosen_conversion_price: roundMoney(sharePrice),
    // Full precision, for reproducing the calculation exactly. share_price is
    // the value shown to people; share_price_exact is the value it was
    // calculated from, and they are deliberately not the same field.
    share_price_exact: D.toExactString(sharePriceExact, 12),
    share_price_fraction: D.toFractionString(sharePriceExact),
    raw_share_count: rawShareCount,
    raw_share_count_exact: D.toExactString(rawShareCountExact, 12),
    rounding_method: RC_ROUNDING_METHOD,
    final_share_count: conversionShareCount,
    conversion_share_count: conversionShareCount,
    nominal_value_per_share: roundMoney(nominalValuePerShare),
    par_value_per_share: roundMoney(nominalValuePerShare),
    // Aggregate par value: both the cash the investor pays and the amount the
    // share capital increases by.
    nominal_amount: parAmount,
    par_amount: parAmount,
    share_capital_increase: parAmount,
    // No premium arises on exercise: the cash contribution is exactly par.
    share_premium: 0,
    investment_amount_applied: investmentApplied,
    rounding_difference: roundingDifference
  };
}

export function aggregateRcConversions(items = []) {
  return items.reduce((acc, item) => {
    acc.total_investment_amount = roundMoney(acc.total_investment_amount + Number(item.investment_amount || 0));
    acc.total_conversion_share_count += Number(item.conversion_share_count || 0);
    acc.total_nominal_amount = roundMoney(acc.total_nominal_amount + Number(item.nominal_amount || 0));
    // Total cash the investors pay on exercise — equals the share capital increase.
    acc.total_par_amount = roundMoney(acc.total_par_amount + Number(item.par_amount || 0));
    acc.total_share_capital_increase = roundMoney(acc.total_share_capital_increase + Number(item.share_capital_increase || 0));
    acc.total_share_premium = roundMoney(acc.total_share_premium + Number(item.share_premium || 0));
    acc.total_rounding_difference = roundMoney(acc.total_rounding_difference + Number(item.rounding_difference || 0));
    return acc;
  }, {
    total_investment_amount: 0,
    total_conversion_share_count: 0,
    total_nominal_amount: 0,
    total_par_amount: 0,
    total_share_capital_increase: 0,
    total_share_premium: 0,
    total_rounding_difference: 0
  });
}
