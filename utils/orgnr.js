export const normalizeOrgnr = (value) =>
  String(value || "").replace(/\s+/g, "");

export const isValidOrgnr = (value) => {
  const orgnr = normalizeOrgnr(value);

  if (!/^\d{9}$/.test(orgnr)) {
    return false;
  }

  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  const digits = orgnr.split("").map(Number);
  const sum = weights.reduce((acc, weight, index) => acc + (digits[index] * weight), 0);
  const remainder = sum % 11;
  const control = remainder === 0 ? 0 : 11 - remainder;

  if (control === 10) {
    return false;
  }

  return control === digits[8];
};
