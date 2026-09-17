import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatBankAccount, validateBankAccount } from "../utils/norwegianBankAccount.js";

/*
  Investors send real money to this number. A wrong length or a mistyped digit
  must stop the round before anyone pays.
*/

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a valid account number is accepted in any common format", () => {
  for (const input of ["1234.56.78903", "12345678903", "1234 56 78903", " 1234.56.78903 "]) {
    const result = validateBankAccount(input);
    assert.equal(result.ok, true, input);
    assert.equal(result.formatted, "1234.56.78903");
  }
});

test("a number with the wrong length is refused, and says how many digits it has", () => {
  const eight = validateBankAccount("12345678");
  assert.equal(eight.ok, false);
  assert.match(eight.error, /11 siffer/);
  assert.match(eight.error, /skrevet 8/);

  assert.equal(validateBankAccount("123456789012").ok, false);
});

test("a single mistyped digit is caught by the check digit", () => {
  assert.equal(validateBankAccount("1234.56.78904").ok, false);
  assert.equal(validateBankAccount("1234.56.78913").ok, false);
});

test("two swapped digits are caught", () => {
  assert.equal(validateBankAccount("1234.65.78903").ok, false);
  assert.equal(validateBankAccount("2134.56.78903").ok, false);
});

test("empty and non-numeric input is refused", () => {
  assert.equal(validateBankAccount("").ok, false);
  assert.equal(validateBankAccount(null).ok, false);
  assert.equal(validateBankAccount("abcd.ef.ghijk").ok, false);
  assert.equal(validateBankAccount("1234-56-78903").ok, false);
});

test("a check digit that would have to be 10 means no valid account", () => {
  // Weighted sum ≡ 1 (mod 11) gives a required check digit of 10.
  // 0000.00.0003x: 3 x 2 (weight of the 10th digit) = 6 ... search for one.
  let found = null;
  for (let n = 0; n < 100000 && !found; n += 1) {
    const base = String(n).padStart(10, "0");
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + w * Number(base[i]), 0);
    if (sum % 11 === 1) found = base;
  }
  assert.ok(found);
  for (let d = 0; d <= 9; d += 1) {
    assert.equal(validateBankAccount(found + d).ok, false, `${found}${d} must not validate`);
  }
});

test("formatting only applies to a complete number", () => {
  assert.equal(formatBankAccount("12345678903"), "1234.56.78903");
  assert.equal(formatBankAccount("123"), "123");
});

test("the browser check gives exactly the same answers as the server", () => {
  const source = fs.readFileSync(path.join(root, "..", "frontend", "script.js"), "utf8");
  const match = source.match(/function validateNorwegianBankAccount\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, "validateNorwegianBankAccount not found in script.js");
  const browserValidate = new Function(`${match[0]}; return validateNorwegianBankAccount;`)();

  const samples = [
    "1234.56.78903", "12345678903", "12345678", "1234.56.78904", "1234.65.78903",
    "", "abc", "0000.00.00000", "9999.99.99999", "1503.12.34567", "8601.11.17947"
  ];
  for (const sample of samples) {
    const server = validateBankAccount(sample);
    const browser = browserValidate(sample);
    assert.equal(browser.ok, server.ok, `disagreement on ${JSON.stringify(sample)}`);
    if (server.ok) assert.equal(browser.formatted, server.formatted);
  }
});

test("every place that stores an account number runs the check", () => {
  const controller = fs.readFileSync(path.join(root, "controllers", "emissionController.js"), "utf8");
  const uses = controller.match(/validateBankAccount\(/g) || [];
  assert.ok(uses.length >= 2, "both the config save and the account update must validate");

  const readiness = fs.readFileSync(path.join(root, "utils", "roundActivationReadiness.js"), "utf8");
  assert.match(readiness, /validateBankAccount\(round\.bank_account\)/, "activation must reject a stored invalid account");
});
