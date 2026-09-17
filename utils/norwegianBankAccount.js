/*
  Norwegian bank account numbers.

  An account number is 11 digits, written XXXX.XX.XXXXX, and the last digit is
  a MOD11 check digit over the first ten. Checking it catches a wrong length
  and most typing mistakes — a mistyped digit, or two neighbours swapped —
  before an investor sends real money to an account that does not exist, or
  worse, to someone else's.

  Weights for the first ten digits, from the left: 5 4 3 2 7 6 5 4 3 2.
  The check digit is 11 minus (sum mod 11); a result of 11 means 0, and a
  result of 10 means no valid account number can end that way.
*/

const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

export function normalizeBankAccount(value) {
  return String(value ?? "").replace(/[\s.]/g, "");
}

export function validateBankAccount(value) {
  const digits = normalizeBankAccount(value);

  if (!digits) {
    return { ok: false, error: "Kontonummer må fylles ut." };
  }
  if (!/^\d+$/.test(digits)) {
    return { ok: false, error: "Kontonummer kan bare inneholde tall." };
  }
  if (digits.length !== 11) {
    return {
      ok: false,
      error: `Et norsk kontonummer har 11 siffer. Du har skrevet ${digits.length}.`
    };
  }

  const sum = WEIGHTS.reduce((acc, weight, i) => acc + weight * Number(digits[i]), 0);
  const remainder = sum % 11;
  const expected = remainder === 0 ? 0 : 11 - remainder;

  if (expected === 10 || expected !== Number(digits[10])) {
    return {
      ok: false,
      error: "Kontonummeret er ikke gyldig. Sjekk at alle sifrene er riktige."
    };
  }

  return { ok: true, normalized: digits, formatted: formatBankAccount(digits) };
}

export function formatBankAccount(value) {
  const digits = normalizeBankAccount(value);
  if (digits.length !== 11) return String(value ?? "");
  return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`;
}
