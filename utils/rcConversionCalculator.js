/*
  Version of the authoritative conversion arithmetic. Persisted with every
  frozen calculation snapshot so a historical conversion can be reproduced
  without depending on whatever this file happens to say today.

  Bump this whenever the formula, the rounding rule, the price selection or the
  capitalization denominator changes.
*/
export const RC_CALCULATION_VERSION = "1.0";

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

  const capPrice = valuationCap && valuationCap > 0
    ? roundMoney(valuationCap / capitalizationBaseShareCount)
    : null;

  let discountPrice = null;
  if (triggerType === "new_priced_round") {
    const effectivePricedRoundSharePrice = (pricedRoundSharePrice == null || pricedRoundSharePrice <= 0)
      ? capPrice
      : pricedRoundSharePrice;

    if (effectivePricedRoundSharePrice == null || effectivePricedRoundSharePrice <= 0) {
      throw new Error("Kunne ikke beregne pris per aksje ved ny emisjon.");
    }

    if (discountPercent != null && discountPercent > 0) {
      discountPrice = roundMoney(effectivePricedRoundSharePrice * (1 - (discountPercent / 100)));
    }
  }

  let chosenConversionPrice = null;

  if (triggerType === "new_priced_round") {
    if (capPrice != null && discountPrice != null) {
      chosenConversionPrice = Math.min(capPrice, discountPrice);
    } else if (capPrice != null) {
      chosenConversionPrice = capPrice;
    } else if (discountPrice != null) {
      chosenConversionPrice = discountPrice;
    } else {
      throw new Error("Kunne ikke beregne konverteringspris. valuation_cap eller discount må være satt.");
    }
  } else {
    if (capPrice == null || capPrice <= 0) {
      throw new Error("valuation_cap må være satt for denne trigger-typen.");
    }
    chosenConversionPrice = capPrice;
  }

  if (!chosenConversionPrice || chosenConversionPrice <= 0) {
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
  const sharePrice = chosenConversionPrice;

  if (sharePrice <= nominalValuePerShare) {
    const error = new Error(
      "Tegningskursen er lik eller lavere enn aksjenes pålydende. Rundens vilkår eller selskapets aksjestruktur må gjennomgås før konvertering kan gjennomføres."
    );
    error.code = "SHARE_PRICE_NOT_ABOVE_PAR";
    error.details = {
      share_price: roundMoney(sharePrice),
      par_value_per_share: roundMoney(nominalValuePerShare)
    };
    throw error;
  }

  /*
    Done in øre as integers. Subtracting two prices in floating point loses
    precision exactly where it hurts: 1.01 - 1 evaluates to 0.010000000000000009,
    which floors the share count one share short. Prices are already money at
    two decimals, so integer øre is both exact and consistent with the rest of
    the system.
  */
  const toOre = (value) => Math.round(value * 100);
  const priceAboveParOre = toOre(sharePrice) - toOre(nominalValuePerShare);

  if (priceAboveParOre <= 0) {
    const error = new Error(
      "Tegningskursen er lik eller lavere enn aksjenes pålydende. Rundens vilkår eller selskapets aksjestruktur må gjennomgås før konvertering kan gjennomføres."
    );
    error.code = "SHARE_PRICE_NOT_ABOVE_PAR";
    throw error;
  }

  const rawShareCount = toOre(investmentAmount) / priceAboveParOre;

  if (!Number.isFinite(rawShareCount)) {
    throw new Error("Kunne ikke beregne antall aksjer. Sjekk inputverdiene.");
  }

  const conversionShareCount = Math.floor(rawShareCount);

  if (conversionShareCount <= 0) {
    throw new Error("Konverteringen gir 0 aksjer. Sjekk inputverdiene.");
  }

  // The only cash the investor pays on exercise. It equals the aggregate par
  // value, so the capital increase carries no share premium.
  const parAmount = roundMoney(conversionShareCount * nominalValuePerShare);
  const investmentApplied = roundMoney(conversionShareCount * (sharePrice - nominalValuePerShare));
  const roundingDifference = roundMoney(investmentAmount - investmentApplied);

  return {
    // Inputs, echoed back so the snapshot alone is enough to reproduce the
    // result without re-reading the round or the startup profile.
    calculation_version: RC_CALCULATION_VERSION,
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
    raw_share_count: rawShareCount,
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
