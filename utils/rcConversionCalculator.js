function toNumber(value) {
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
    if (pricedRoundSharePrice == null || pricedRoundSharePrice <= 0) {
      throw new Error("priced_round_share_price må være større enn 0 ved ny emisjon.");
    }

    if (discountPercent != null && discountPercent > 0) {
      discountPrice = roundMoney(pricedRoundSharePrice * (1 - (discountPercent / 100)));
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

  const rawShareCount = investmentAmount / chosenConversionPrice;
  const conversionShareCount = Math.floor(rawShareCount);

  if (conversionShareCount <= 0) {
    throw new Error("Konverteringen gir 0 aksjer. Sjekk inputverdiene.");
  }

  const roundedInvestmentAmount = roundMoney(conversionShareCount * chosenConversionPrice);
  const roundingDifference = roundMoney(investmentAmount - roundedInvestmentAmount);
  const nominalAmount = roundMoney(conversionShareCount * nominalValuePerShare);
  const sharePremium = roundMoney(investmentAmount - nominalAmount);

  if (nominalAmount > investmentAmount) {
    throw new Error("nominal_amount kan ikke overstige investment_amount.");
  }

  return {
    cap_price: capPrice,
    discount_price: discountPrice,
    chosen_conversion_price: roundMoney(chosenConversionPrice),
    conversion_share_count: conversionShareCount,
    nominal_value_per_share: roundMoney(nominalValuePerShare),
    nominal_amount: nominalAmount,
    share_premium: sharePremium,
    rounding_difference: roundingDifference
  };
}

export function aggregateRcConversions(items = []) {
  return items.reduce((acc, item) => {
    acc.total_investment_amount = roundMoney(acc.total_investment_amount + Number(item.investment_amount || 0));
    acc.total_conversion_share_count += Number(item.conversion_share_count || 0);
    acc.total_nominal_amount = roundMoney(acc.total_nominal_amount + Number(item.nominal_amount || 0));
    acc.total_share_premium = roundMoney(acc.total_share_premium + Number(item.share_premium || 0));
    acc.total_rounding_difference = roundMoney(acc.total_rounding_difference + Number(item.rounding_difference || 0));
    return acc;
  }, {
    total_investment_amount: 0,
    total_conversion_share_count: 0,
    total_nominal_amount: 0,
    total_share_premium: 0,
    total_rounding_difference: 0
  });
}
