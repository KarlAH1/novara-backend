import fs from "fs/promises";
import { PDFParse } from "pdf-parse";

/*
  Version of the deterministic clause parser. Recorded with every extraction so
  it stays possible to tell which rules read a given set of figures.
*/
export const ARTICLES_PARSER_VERSION = "articles-parser-1.1";

function normalizeText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanClauseText(value) {
  return normalizeText(String(value || "").replace(/^§\s*\d+[^\n]*\n?/i, ""));
}

function extractMunicipality(sectionText) {
  const section = normalizeText(sectionText);
  if (!section) return null;

  const normalizedLine = section.replace(/\n+/g, " ");
  const patterns = [
    /forretningskommune(?:n)?(?: er)?\s+([^.]+?)(?:\.)?$/i,
    /forretningskontor(?:et)?(?: er)?\s+(?:i\s+)?([^.]+?)(?:\.)?$/i,
    /har\s+(?:sin\s+)?forretningsadresse\s+i\s+([^.]+?)(?:\.)?$/i,
    /(?:i|på)\s+([A-ZÆØÅa-zæøå \-]+ kommune)(?:\.)?$/i
  ];

  for (const pattern of patterns) {
    const match = normalizedLine.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return cleanClauseText(section) || null;
}

/*
  Norwegian articles write money as "30 000", "1", "0,10" or occasionally
  "1.000,50". Stripping every non-digit turned a par value of NOK 0,10 into 10 —
  a hundredfold error in the share price, and therefore in every allocation.
  Space and thin space are thousands separators; the LAST comma (or a lone dot
  with 1-2 trailing digits) is the decimal separator.
*/
function normalizeNumber(value) {
  let text = String(value || "").replace(/[\s\u00a0\u202f]/g, "").trim();
  if (!text) return null;

  if (text.includes(",")) {
    // Any dots are thousands separators once a comma is present.
    text = text.replace(/\./g, "").replace(/,/g, ".");
  } else {
    const dotMatch = text.match(/^(\d+)\.(\d{1,2})$/);
    text = dotMatch ? `${dotMatch[1]}.${dotMatch[2]}` : text.replace(/\./g, "");
  }

  if (!/^\d+(\.\d+)?$/.test(text)) return null;

  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function extractSection(text, sectionNumber) {
  const pattern = new RegExp(`(^|\\n)§\\s*${sectionNumber}\\b[\\s\\S]*?(?=\\n§\\s*\\d+\\b|$)`, "i");
  const match = text.match(pattern);
  return match ? normalizeText(match[0]) : "";
}

/*
  Maximum size we will attempt to parse. Articles of association are a few
  pages; anything far larger is either not articles or a decompression bomb, and
  parsing it would tie up the request for no good reason.
*/
const MAX_ARTICLES_BYTES = 15 * 1024 * 1024;

// Every PDF starts with %PDF- . Checking it means a mislabelled upload fails
// fast and predictably instead of somewhere inside the parser.
function looksLikePdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

/*
  PDF text extraction.

  This runs in-process through pdf-parse and is the only supported path. The
  previous implementation shelled out to /usr/bin/swift, mdls and textutil,
  which exist only on macOS — on the Linux container that serves production
  every one of them failed silently and articles were never parsed at all.

  Nothing here executes an external command.
*/
export async function extractPdfTextFromBuffer(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);

  if (!data.length) {
    return { text: "", error: "empty_file" };
  }
  if (data.length > MAX_ARTICLES_BYTES) {
    return { text: "", error: "file_too_large" };
  }
  if (!looksLikePdf(data)) {
    return { text: "", error: "not_a_pdf" };
  }

  let parser = null;
  try {
    parser = new PDFParse({ data: new Uint8Array(data) });
    const result = await parser.getText();
    // pdf-parse marks page boundaries; they are noise for clause matching.
    const text = normalizeText(String(result?.text || "").replace(/^--\s*\d+\s+of\s+\d+\s*--$/gim, ""));
    return { text, error: text ? null : "no_text_layer" };
  } catch (err) {
    // A scanned (image-only) or encrypted PDF is an expected outcome, not a
    // crash. The caller falls back to AI extraction or manual entry.
    return { text: "", error: err?.name === "PasswordException" ? "password_protected" : "extraction_failed" };
  } finally {
    try { await parser?.destroy(); } catch { /* nothing useful to do */ }
  }
}

/*
  Extraction for a document stored as bytes in the database, which is where
  uploads live — the container filesystem is ephemeral.
*/
export async function extractArticlesTextFromBuffer(buffer, mimeType) {
  if (!buffer || !buffer.length) return "";

  if (String(mimeType || "").toLowerCase() !== "application/pdf") {
    return normalizeText(Buffer.from(buffer).toString("utf8"));
  }

  const { text } = await extractPdfTextFromBuffer(buffer);
  return text;
}

// Legacy on-disk path, for rows that predate the move into the database.
export async function extractArticlesTextFromFile(filePath, mimeType) {
  try {
    const buffer = await fs.readFile(filePath);
    return await extractArticlesTextFromBuffer(buffer, mimeType);
  } catch {
    return "";
  }
}

export function parseArticlesText(rawText) {
  const text = normalizeText(rawText);

  if (!text) {
    return {
      parseStatus: "failed",
      parsedFields: {},
      extractedText: ""
    };
  }

  const section1 = extractSection(text, 1);
  const section2 = extractSection(text, 2);
  const section3 = extractSection(text, 3);
  const section4 = extractSection(text, 4);
  const section5 = extractSection(text, 5);
  const section6 = extractSection(text, 6);
  const section7 = extractSection(text, 7);

  const titleMatch = text.match(/VEDTEKTER\s+([^\n]+)/i);
  const orgMatch = text.match(/Org\.?\s*nr\.?:?\s*([0-9 ]{9,})/i);
  const amendedMatch = text.match(/Sist endret:?\s*([^\n]+)/i);
  const purposeMatch = section3.match(/virksomhet(?:en)?(?: er)?\s+([\s\S]+)$/i);
  const shareCapitalMatch = section4.match(/aksjekapital(?:en)?(?: er)?\s*NOK\s*([\d ., ]+)/i);
  const shareCountMatch = section4.match(/fordelt på\s*([\d ., ]+?)\s*aksjer/i);
  const nominalValueMatch = section4.match(/pålydende\s*NOK\s*([\d ., ]+)/i);

  const parsedFields = {
    company_name: titleMatch?.[1]?.trim() || null,
    organization_number: orgMatch ? orgMatch[1].replace(/\s+/g, "") : null,
    last_amended_date: amendedMatch?.[1]?.trim() || null,
    municipality: extractMunicipality(section2),
    business_purpose: purposeMatch ? cleanClauseText(purposeMatch[1]) : (section3 ? cleanClauseText(section3) : null),
    share_capital_amount: normalizeNumber(shareCapitalMatch?.[1]),
    share_count: normalizeNumber(shareCountMatch?.[1]),
    nominal_value: normalizeNumber(nominalValueMatch?.[1]),
    board_clause_text: section5 ? cleanClauseText(section5) : null,
    general_meeting_clause_text: section6 ? cleanClauseText(section6) : null,
    signature_clause_text: section7 ? cleanClauseText(section7) : null
  };

  const foundCount = Object.values(parsedFields).filter((value) => value != null && value !== "").length;
  const parseStatus =
    foundCount >= 8 ? "parsed_complete" :
    foundCount > 0 ? "parsed_partial" :
    "failed";

  return {
    parseStatus,
    parsedFields,
    extractedText: text
  };
}
