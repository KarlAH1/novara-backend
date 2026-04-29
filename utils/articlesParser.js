import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

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

function normalizeNumber(value) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function extractSection(text, sectionNumber) {
  const pattern = new RegExp(`(^|\\n)§\\s*${sectionNumber}\\b[\\s\\S]*?(?=\\n§\\s*\\d+\\b|$)`, "i");
  const match = text.match(pattern);
  return match ? normalizeText(match[0]) : "";
}

async function extractPdfText(filePath) {
  try {
    const swiftScript = `
import Foundation
import PDFKit

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
if let document = PDFDocument(url: url) {
    print(document.string ?? "")
}
`;
    const { stdout } = await execFileAsync("/usr/bin/swift", ["-e", swiftScript, filePath], {
      timeout: 15000,
      maxBuffer: 1024 * 1024 * 8
    });
    const text = normalizeText(stdout);
    if (text) {
      return text;
    }
  } catch {}

  try {
    const { stdout } = await execFileAsync("/usr/bin/mdls", ["-raw", "-name", "kMDItemTextContent", filePath]);
    const text = normalizeText(stdout);
    if (text && text !== "(null)") {
      return text;
    }
  } catch {}

  try {
    const { stdout } = await execFileAsync("/usr/bin/textutil", ["-convert", "txt", "-stdout", filePath]);
    const text = normalizeText(stdout);
    if (text) {
      return text;
    }
  } catch {}

  return "";
}

export async function extractArticlesTextFromFile(filePath, mimeType) {
  if (String(mimeType || "").toLowerCase() === "application/pdf") {
    return extractPdfText(filePath);
  }

  try {
    return normalizeText(await fs.readFile(filePath, "utf8"));
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
  const shareCapitalMatch = section4.match(/aksjekapital(?:en)?(?: er)?\s*NOK\s*([\d .]+)/i);
  const shareCountMatch = section4.match(/fordelt på\s*([\d .]+)\s*aksjer/i);
  const nominalValueMatch = section4.match(/pålydende\s*NOK\s*([\d .]+)/i);

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
