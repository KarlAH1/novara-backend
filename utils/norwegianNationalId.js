// Decodes the birth date embedded in a Norwegian fødselsnummer/D-nummer
// (first 6 digits DDMMYY + the "individsiffer" in positions 7-9, which
// determines the century). D-numbers add 40 to the day digit.
export function decodeBirthDateFromNationalId(nationalId) {
  const digits = String(nationalId || "").replace(/\D/g, "");
  if (digits.length !== 11) return null;

  let day = parseInt(digits.slice(0, 2), 10);
  const month = parseInt(digits.slice(2, 4), 10);
  const yy = parseInt(digits.slice(4, 6), 10);
  const individ = parseInt(digits.slice(6, 9), 10);

  if (day > 40) {
    day -= 40; // D-number
  }

  let century;
  if (individ <= 499) {
    century = 1900;
  } else if (individ <= 749 && yy >= 54) {
    century = 1800;
  } else if (individ <= 999 && yy <= 39) {
    century = 2000;
  } else {
    century = 1900;
  }

  const year = century + yy;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}
