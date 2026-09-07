/*
  Exact arithmetic for the authoritative RC calculation.

  Binary floating point cannot represent 1/3, and it cannot represent 0.1
  either. Both appear in this model: a valuation cap of NOK 1,000,000 over
  30,000 shares is exactly 100/3 per share, and a par value of NOK 0.10 is a
  perfectly ordinary Norwegian par value. Rounding either to øre before
  dividing changes the share count near a whole-share boundary, and the error
  is silent.

  So the share price is carried as an exact rational — a BigInt numerator over
  a BigInt denominator — from the valuation cap all the way to the division
  that produces the raw share count. Rounding happens once, at the end, where
  the contract says it happens: floor to a whole share.

  Only the display value is rounded to øre, and only for display.
*/

// Input money is read at six decimals, which covers NOK amounts, par values
// stored as DECIMAL(12,4), and percentage arithmetic without loss.
const INPUT_SCALE = 1000000n;

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) { [x, y] = [y, x % y]; }
  return x;
}

/*
  A rational number n/d, always kept in lowest terms with a positive
  denominator so equality and comparison are straightforward.
*/
export function rational(numerator, denominator = 1n) {
  let n = BigInt(numerator);
  let d = BigInt(denominator);

  if (d === 0n) throw new Error("Division by zero in exact arithmetic.");
  if (d < 0n) { n = -n; d = -d; }

  const divisor = gcd(n, d) || 1n;
  return { n: n / divisor, d: d / divisor };
}

/*
  Converts a JavaScript number to an exact rational.

  The number itself already carries whatever floating-point error it arrived
  with — 1.01 * 1000 is 1010.0000000000001 — so it is read at six decimals,
  which discards that noise and keeps every value a person could actually have
  entered.
*/
export function fromNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error("Ugyldig tallverdi i beregningen.");
  return rational(BigInt(Math.round(numeric * Number(INPUT_SCALE))), INPUT_SCALE);
}

export const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const subtract = (a, b) => rational(a.n * b.d - b.n * a.d, a.d * b.d);
export const multiply = (a, b) => rational(a.n * b.n, a.d * b.d);
export const divide = (a, b) => {
  if (b.n === 0n) throw new Error("Division by zero in exact arithmetic.");
  return rational(a.n * b.d, a.d * b.n);
};

export const compare = (a, b) => {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : (left > right ? 1 : 0);
};

export const isPositive = (a) => a.n > 0n;
export const min = (a, b) => (compare(a, b) <= 0 ? a : b);

// Floor to a whole unit. This is the contractual share-rounding rule, applied
// once, to the raw share count.
export function floorToInteger(value) {
  const { n, d } = value;
  const quotient = n / d;
  // BigInt division truncates toward zero, which is not floor for negatives.
  return (n < 0n && quotient * d !== n) ? quotient - 1n : quotient;
}

/*
  Rounds to a fixed number of decimals, half away from zero, and returns a
  JavaScript number. Used for amounts that are actually paid or booked, and for
  display — never in the middle of the share calculation.
*/
export function toRoundedNumber(value, decimals = 2) {
  const scale = 10n ** BigInt(decimals);
  const scaled = value.n * scale;
  const half = value.d / 2n;
  const rounded = value.n >= 0n
    ? (scaled + half) / value.d
    : -((-scaled + half) / value.d);
  return Number(rounded) / Number(scale);
}

// Full-precision decimal string, for the audit record. Trailing zeros trimmed.
export function toExactString(value, maxDecimals = 12) {
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n;
  const whole = n / value.d;
  let remainder = n % value.d;

  if (remainder === 0n) return `${negative ? "-" : ""}${whole}`;

  let decimals = "";
  for (let i = 0; i < maxDecimals && remainder !== 0n; i += 1) {
    remainder *= 10n;
    decimals += (remainder / value.d).toString();
    remainder %= value.d;
  }
  decimals = decimals.replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${decimals ? `.${decimals}` : ""}`;
}

// Exact fraction, so a frozen calculation can be replayed without any loss.
export const toFractionString = (value) => `${value.n}/${value.d}`;

export function fromFractionString(text) {
  const [n, d] = String(text).split("/");
  return rational(BigInt(n), BigInt(d));
}
