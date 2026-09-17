/*
  Existing shareholders, reconciled to the company's share register.

  The aksjeeierbok records owners by NUMBER OF SHARES. Many founders only know
  their percentage, so either may be entered — but the share count is what is
  stored and what every later document uses, and the counts must add up to the
  company's issued shares exactly. Otherwise the register generated at
  conversion would disagree with the company's own aksjeeierbok.

  Rules:
    - A share count that was typed in is kept exactly as typed.
    - A percentage is converted to shares. When the percentages together are
      meant to cover the whole company — they add up to 100 % give or take the
      rounding of a two-decimal figure — the conversion distributes the shares
      with the largest-remainder method, so the total lands exactly on the
      issued share count instead of drifting by a share or two.
    - Percentages that clearly do not add up are not quietly stretched to fit.
      They are converted as they stand, and the shortfall is reported.

  Everything is integer arithmetic: percentages are read at four decimals,
  which is also how they are stored.
*/

const PERCENT_SCALE = 10000n;           // 4 decimals
const HUNDRED_PERCENT = 100n * PERCENT_SCALE;

// Each two-decimal percentage may be off by up to 0.005 percentage points.
const ROUNDING_TOLERANCE_PER_ENTRY = 50n; // 0.005 % at PERCENT_SCALE

export const SHAREHOLDER_SOURCE = { SHARES: "shares", PERCENT: "percent" };

function toScaledPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * Number(PERCENT_SCALE)));
}

function toShareCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return BigInt(n);
}

const abs = (x) => (x < 0n ? -x : x);

function percentOf(shares, total) {
  // 4 decimals, rounded half up.
  const scaled = (shares * HUNDRED_PERCENT * 2n + total) / (total * 2n);
  return Number(scaled) / Number(PERCENT_SCALE);
}

/*
  entries: [{ name, share_count?, ownership_percent? }]
  totalShares: the company's confirmed issued share count (may be unknown).
*/
export function allocateShareholders(entries = [], totalShares = null) {
  const errors = [];
  const cleaned = (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      const name = String(entry?.name || "").trim().slice(0, 200);
      const shares = toShareCount(entry?.share_count);
      const percent = shares == null ? toScaledPercent(entry?.ownership_percent) : null;
      return { index, name, shares, percent };
    })
    .filter((entry) => entry.name && (entry.shares != null || entry.percent != null));

  const total = toShareCount(totalShares);

  // Without the company's share count, shares cannot be derived. Keep the
  // percentages and say so; nothing is invented.
  if (total == null) {
    const hasShares = cleaned.some((e) => e.shares != null);
    if (hasShares) {
      errors.push("Selskapets totale antall aksjer må være bekreftet før eierandeler kan føres i antall aksjer.");
    }
    const percentSum = cleaned.reduce((sum, e) => sum + (e.percent ?? 0n), 0n);
    return {
      total_shares: null,
      allocated_shares: null,
      complete: abs(percentSum - HUNDRED_PERCENT) <= ROUNDING_TOLERANCE_PER_ENTRY * BigInt(Math.max(cleaned.length, 1)),
      shareholders: cleaned.map((e) => ({
        name: e.name,
        share_count: null,
        ownership_percent: e.percent == null ? null : Number(e.percent) / Number(PERCENT_SCALE),
        source: e.shares != null ? SHAREHOLDER_SOURCE.SHARES : SHAREHOLDER_SOURCE.PERCENT
      })),
      errors
    };
  }

  const fixed = cleaned.filter((e) => e.shares != null);
  const derived = cleaned.filter((e) => e.shares == null);

  const fixedShares = fixed.reduce((sum, e) => sum + e.shares, 0n);
  const remaining = total - fixedShares;

  // Exact share amount each percentage stands for, as numerator over
  // HUNDRED_PERCENT.
  const numerators = derived.map((e) => e.percent * total);
  const rawTotalNumerator = numerators.reduce((a, b) => a + b, 0n);

  // Do the percentages cover exactly what is left, give or take rounding?
  const percentSum = derived.reduce((sum, e) => sum + e.percent, 0n);
  const neededPercentNumerator = remaining * HUNDRED_PERCENT; // needed percent × total
  const tolerance = ROUNDING_TOLERANCE_PER_ENTRY * BigInt(derived.length) * total;
  const coversRemainder = derived.length > 0
    && remaining > 0n
    && abs(percentSum * total - neededPercentNumerator) <= tolerance;

  const floors = numerators.map((n) => n / HUNDRED_PERCENT);
  const floorSum = floors.reduce((a, b) => a + b, 0n);

  let target;
  if (coversRemainder) {
    target = remaining;
  } else {
    // Round the unadjusted total to the nearest share.
    target = (rawTotalNumerator * 2n + HUNDRED_PERCENT) / (HUNDRED_PERCENT * 2n);
  }

  const counts = [...floors];
  let delta = target - floorSum;
  if (delta !== 0n && derived.length) {
    const order = derived
      .map((e, i) => ({ i, remainder: numerators[i] % HUNDRED_PERCENT, index: e.index }))
      .sort((a, b) => (delta > 0n
        ? (a.remainder === b.remainder ? a.index - b.index : (a.remainder > b.remainder ? -1 : 1))
        : (a.remainder === b.remainder ? b.index - a.index : (a.remainder < b.remainder ? -1 : 1))));
    let k = 0;
    while (delta !== 0n && k < order.length * 4) {
      const slot = order[k % order.length].i;
      if (delta > 0n) {
        counts[slot] += 1n; delta -= 1n;
      } else if (counts[slot] > 0n) {
        counts[slot] -= 1n; delta += 1n;
      }
      k += 1;
    }
  }

  derived.forEach((e, i) => {
    e.shares = counts[i];
    if (counts[i] <= 0n) {
      errors.push(`Eierandelen til ${e.name} er for liten til å gi en hel aksje.`);
    }
  });

  const all = [...fixed, ...derived].sort((a, b) => a.index - b.index);
  const allocated = all.reduce((sum, e) => sum + e.shares, 0n);

  const fmt = (n) => Number(n).toLocaleString("no-NO");
  if (allocated > total) {
    errors.push(`Eierne har til sammen ${fmt(allocated)} aksjer, men selskapet har bare ${fmt(total)}.`);
  } else if (allocated < total && all.length) {
    errors.push(
      `Eierne har til sammen ${fmt(allocated)} av ${fmt(total)} aksjer. ` +
      `Alle aksjene må fordeles, slik aksjeeierboken viser.`
    );
  }

  return {
    total_shares: Number(total),
    allocated_shares: Number(allocated),
    complete: allocated === total && errors.length === 0,
    shareholders: all.map((e) => ({
      name: e.name,
      share_count: Number(e.shares),
      ownership_percent: percentOf(e.shares, total),
      source: fixed.includes(e) ? SHAREHOLDER_SOURCE.SHARES : SHAREHOLDER_SOURCE.PERCENT
    })),
    errors
  };
}

/*
  Share counts for already-stored owners, in their stored order.

  Uses the stored share count where there is one. Rows saved before share
  counts existed only have a percentage; those are converted with the same
  rule as above. This replaces the old "round down and give the last owner the
  rest", which quietly absorbed any mismatch into one person's holding.
*/
export function shareCountsForStoredOwners(owners = [], totalShares) {
  const list = Array.isArray(owners) ? owners : [];
  if (!list.length) return [];

  if (list.every((o) => Number.isInteger(Number(o.share_count)) && Number(o.share_count) > 0)) {
    return list.map((o) => Number(o.share_count));
  }

  const result = allocateShareholders(
    list.map((o, i) => ({
      name: o.shareholder_name || o.name || `Aksjonær ${i + 1}`,
      share_count: Number(o.share_count) > 0 ? Number(o.share_count) : null,
      ownership_percent: o.ownership_percent
    })),
    totalShares
  );
  return result.shareholders.map((s) => Number(s.share_count || 0));
}
