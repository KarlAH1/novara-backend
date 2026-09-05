import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTICLES_PARSER_VERSION,
  extractArticlesTextFromBuffer,
  extractPdfTextFromBuffer,
  parseArticlesText
} from "../utils/articlesParser.js";
import { checkShareBasisConsistency, confirmationMatches } from "../utils/articlesConfirmation.js";

/*
  The share capital, share count and par value read out of a company's articles
  decide the share price, every investor's allocation and the size of the later
  capital increase. Getting them wrong is not a cosmetic error, so extraction is
  tested against the shapes Norwegian articles actually use, and the numbers are
  never accepted unless they add up.
*/

// A minimal, real PDF containing one line of text.
const SAMPLE_PDF = Buffer.from(
  "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L0NvbnRlbnRzIDUgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjUgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSAxMiBUZgo3MiA3MjAgVGQKKFZFRFRFS1RFUiBUZXN0IEFTKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU2IDAwMDAwIG4gCjAwMDAwMDAxMTEgMDAwMDAgbiAKMDAwMDAwMDI0NCAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKNDA1CiUlRU9GCg==",
  "base64"
);

const articles = ({ capital, count, par }) =>
  `VEDTEKTER Example AS\nOrg nr: 123456789\n\n§ 1\nSelskapets foretaksnavn er Example AS.\n\n` +
  `§ 2\nSelskapets forretningskommune er Oslo.\n\n§ 3\nSelskapets virksomhet er utvikling av programvare.\n\n` +
  `§ 4\nSelskapets aksjekapital er NOK ${capital} fordelt på ${count} aksjer, hver pålydende NOK ${par}.\n\n` +
  `§ 5\nStyret skal ha fra ett til fem medlemmer.\n\n§ 6\nOrdinær generalforsamling holdes hvert år.\n\n` +
  `§ 7\nSelskapets firma tegnes av styrets leder.\n`;

/* ------------------------------------------------- Linux-safe PDF extraction */

test("PDF text is extracted in-process, without any external command", async () => {
  const result = await extractPdfTextFromBuffer(SAMPLE_PDF);
  assert.equal(result.error, null);
  assert.match(result.text, /VEDTEKTER Test AS/);
});

test("extraction works from a Buffer, which is how uploads are stored", async () => {
  const text = await extractArticlesTextFromBuffer(SAMPLE_PDF, "application/pdf");
  assert.match(text, /VEDTEKTER Test AS/);
});

test("a non-PDF, an empty file and an oversized file each fail deterministically", async () => {
  assert.equal((await extractPdfTextFromBuffer(Buffer.from("not a pdf at all"))).error, "not_a_pdf");
  assert.equal((await extractPdfTextFromBuffer(Buffer.alloc(0))).error, "empty_file");

  const huge = Buffer.alloc(16 * 1024 * 1024);
  huge.write("%PDF-1.4");
  assert.equal((await extractPdfTextFromBuffer(huge)).error, "file_too_large");
});

test("a corrupt PDF returns an error rather than throwing", async () => {
  const corrupt = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("garbage".repeat(50))]);
  const result = await extractPdfTextFromBuffer(corrupt);
  assert.equal(result.text, "");
  assert.ok(result.error, "a corrupt file must report an error");
});

test("plain text articles are read without going through the PDF path", async () => {
  const text = await extractArticlesTextFromBuffer(
    Buffer.from(articles({ capital: "30 000", count: "30 000", par: "1" }), "utf8"),
    "text/plain"
  );
  assert.match(text, /aksjekapital/);
});

/* --------------------------------------------------- Norwegian number formats */

test("Norwegian number formats are read correctly, decimals included", () => {
  const cases = [
    { capital: "30 000", count: "30 000", par: "1", expect: [30000, 30000, 1] },
    { capital: "3 000", count: "30 000", par: "0,10", expect: [3000, 30000, 0.1] },
    { capital: "30 000", count: "30 000", par: "1,00", expect: [30000, 30000, 1] },
    { capital: "33 090", count: "33 090", par: "1", expect: [33090, 33090, 1] },
    { capital: "1.000.000", count: "1.000.000", par: "1", expect: [1000000, 1000000, 1] }
  ];

  for (const { capital, count, par, expect } of cases) {
    const f = parseArticlesText(articles({ capital, count, par })).parsedFields;
    assert.deepEqual(
      [f.share_capital_amount, f.share_count, f.nominal_value],
      expect,
      `${capital} / ${count} / ${par}`
    );
  }
});

test("a par value of 0,10 is never read as 10", () => {
  // Stripping every non-digit turned 0,10 into 10 — a hundredfold error in the
  // share price and therefore in every allocation.
  const f = parseArticlesText(articles({ capital: "3 000", count: "30 000", par: "0,10" })).parsedFields;
  assert.equal(f.nominal_value, 0.1);
  assert.notEqual(f.nominal_value, 10);
});

test("the parser records its version", () => {
  assert.match(ARTICLES_PARSER_VERSION, /^articles-parser-/);
});

/* ---------------------------------------------------- consistency, fail closed */

test("a consistent share basis is accepted", () => {
  assert.equal(
    checkShareBasisConsistency({ shareCapital: 30000, shareCount: 30000, parValue: 1 }).ok,
    true
  );
  assert.equal(
    checkShareBasisConsistency({ shareCapital: 3000, shareCount: 30000, parValue: 0.1 }).ok,
    true
  );
});

test("an inconsistent share basis is refused rather than silently accepted", () => {
  // 30,000 capital with 30,000 shares cannot have a par value of 0.10.
  const result = checkShareBasisConsistency({ shareCapital: 30000, shareCount: 30000, parValue: 0.1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /henger ikke sammen/);
});

test("missing or nonsensical figures are refused", () => {
  for (const input of [
    { shareCapital: 0, shareCount: 30000, parValue: 1 },
    { shareCapital: 30000, shareCount: 0, parValue: 1 },
    { shareCapital: 30000, shareCount: 30000, parValue: 0 },
    { shareCapital: 30000, shareCount: 30000.5, parValue: 1 },
    { shareCapital: 30000, shareCount: 30000, parValue: -1 }
  ]) {
    assert.equal(checkShareBasisConsistency(input).ok, false, JSON.stringify(input));
  }
});

/* ------------------------------------------------------- human confirmation */

test("a confirmation only covers the exact numbers it was given", () => {
  const confirmation = { share_capital_amount: 30000, share_count: 30000, par_value_per_share: 1 };

  assert.equal(
    confirmationMatches(confirmation, { shareCapital: 30000, shareCount: 30000, parValue: 1 }),
    true
  );
  // Editing the share basis afterwards invalidates the confirmation, so the
  // company has to look at the numbers again.
  assert.equal(
    confirmationMatches(confirmation, { shareCapital: 33090, shareCount: 33090, parValue: 1 }),
    false
  );
  assert.equal(
    confirmationMatches(confirmation, { shareCapital: 30000, shareCount: 30000, parValue: 0.1 }),
    false
  );
  assert.equal(confirmationMatches(null, { shareCapital: 30000, shareCount: 30000, parValue: 1 }), false);
});
