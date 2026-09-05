import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  ARTICLES_PARSER_VERSION,
  extractArticlesTextFromBuffer,
  extractArticlesTextFromFile,
  parseArticlesText
} from "./articlesParser.js";
import {
  extractArticlesFieldsWithAi,
  isArticlesAiAvailable
} from "./articlesAiExtraction.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, "../../frontend");

function safeParseJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function hasParsedArticlesData(parsedFields = {}) {
  return Object.values(parsedFields).some((value) => value != null && value !== "");
}

// Fields whose absence is worth a follow-up AI read: everything the capital
// increase and the share price depend on.
const CRITICAL_FIELDS = ["share_capital_amount", "share_count", "nominal_value"];
const AI_ELIGIBLE_FIELDS = [
  ...CRITICAL_FIELDS,
  "company_name", "organization_number", "municipality", "business_purpose",
  "board_clause_text", "general_meeting_clause_text", "signature_clause_text",
  "last_amended_date"
];

function missingFieldsIn(parsedFields = {}) {
  return AI_ELIGIBLE_FIELDS.filter((field) => {
    const value = parsedFields[field];
    return value === null || value === undefined || value === "";
  });
}

/*
  Reads the articles in three steps, most trustworthy first:

    1. deterministic text extraction, then deterministic clause parsing;
    2. AI extraction, but only for fields step 1 could not read, and only when
       one of the critical figures is among them — there is no reason to send a
       document to a third party when the parser already read it;
    3. neither, in which case the company types the values.

  Every field carries where it came from, and none of it is authoritative until
  the company confirms it (see articlesConfirmation).
*/
export async function ensureStartupArticlesParsed(connection, document) {
  if (!document?.id) {
    return document || null;
  }

  const existingParsedFields = safeParseJson(document.parsed_fields_json);
  if (
    (document.parse_status === "parsed_complete" || document.parse_status === "parsed_partial")
    && hasParsedArticlesData(existingParsedFields)
  ) {
    return {
      ...document,
      parsed_fields_json: JSON.stringify(existingParsedFields),
      extracted_text: document.extracted_text || null
    };
  }

  // Uploads live in startup_documents.file_data; the container filesystem is
  // ephemeral. The on-disk branch only serves rows predating that migration.
  let extractedText = "";
  const mimeType = document.mime_type || "application/pdf";

  if (document.file_data) {
    extractedText = await extractArticlesTextFromBuffer(document.file_data, mimeType);
  } else if (document.url) {
    const absolutePath = path.resolve(frontendRoot, document.url);
    try {
      await fs.access(absolutePath);
      extractedText = await extractArticlesTextFromFile(absolutePath, mimeType);
    } catch {
      extractedText = "";
    }
  }

  if (!extractedText) {
    await connection.query(
      "UPDATE startup_documents SET parse_status = ? WHERE id = ?",
      ["failed", document.id]
    );
    return {
      ...document,
      parse_status: "failed",
      parsed_fields_json: JSON.stringify(existingParsedFields),
      extracted_text: document.extracted_text || null
    };
  }

  const parsed = parseArticlesText(extractedText);
  const fields = { ...(parsed.parsedFields || {}) };
  const sources = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined && value !== "") sources[key] = "parser";
  }

  let aiMeta = null;
  const missing = missingFieldsIn(fields);
  const missingCritical = missing.filter((field) => CRITICAL_FIELDS.includes(field));

  if (missingCritical.length && isArticlesAiAvailable()) {
    const aiResult = await extractArticlesFieldsWithAi(extractedText, missing);
    if (aiResult) {
      for (const field of missing) {
        const value = aiResult.fields?.[field];
        if (value !== null && value !== undefined && value !== "") {
          fields[field] = value;
          sources[field] = "ai";
        }
      }
      aiMeta = {
        model: aiResult.model,
        extraction_version: aiResult.extraction_version,
        confidence: aiResult.confidence,
        fields_requested: missing
      };
    }
  }

  fields.field_sources = sources;
  fields.parser_version = ARTICLES_PARSER_VERSION;
  if (aiMeta) fields.ai_extraction = aiMeta;

  const readCount = Object.keys(sources).length;
  const parseStatus = readCount >= 8 ? "parsed_complete" : (readCount > 0 ? "parsed_partial" : "failed");

  await connection.query(
    `
    UPDATE startup_documents
    SET parse_status = ?, parsed_fields_json = ?, extracted_text = ?
    WHERE id = ?
    `,
    [parseStatus, JSON.stringify(fields), extractedText || null, document.id]
  );

  return {
    ...document,
    parse_status: parseStatus,
    parsed_fields_json: JSON.stringify(fields),
    extracted_text: extractedText || null
  };
}
