/*
  AI-assisted extraction of Articles of Association fields.

  This is a FALLBACK, never the first attempt and never the authority:

    1. deterministic PDF text extraction   (articlesParser)
    2. deterministic clause parsing        (articlesParser)
    3. this, only for fields step 2 could not read
    4. explicit human confirmation by the company        (always required)

  The model is asked to read, never to compute. It must not derive a par value
  from share capital divided by share count, and must not guess: a field it
  cannot find stated in the document comes back null. Whatever it returns is
  still shown to the company for confirmation before any round can go live.

  Uses the same OpenAI configuration as the rest of the app — one AI
  integration, not two.
*/

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Enough for articles of association; keeps the request bounded.
const MAX_TEXT_CHARS = 24000;

export const ARTICLES_AI_EXTRACTION_VERSION = "articles-ai-1.0";

const SYSTEM_PROMPT = `Du leser norske vedtekter for aksjeselskap og henter ut faktaopplysninger.

REGLER:
- Hent KUN opplysninger som faktisk står i vedtektene.
- Returner null for felter som ikke er oppgitt, eller som du er usikker på.
- IKKE regn ut verdier. Hvis pålydende ikke står skrevet, returner null - selv om du kunne regnet det ut fra aksjekapital delt på antall aksjer.
- IKKE gjett, og IKKE fyll inn typiske verdier.
- Tall returneres som tall, ikke tekst. Norsk desimalkomma tolkes som desimaltegn (0,10 blir 0.10). Mellomrom er tusenskilletegn (30 000 blir 30000).
- "confidence" er et tall mellom 0 og 1 for hvor sikker du er på uttrekket samlet sett.

Svar KUN med gyldig JSON på nøyaktig dette formatet:
{"company_name":null,"organization_number":null,"last_amended_date":null,"share_capital_amount":null,"share_count":null,"nominal_value":null,"municipality":null,"business_purpose":null,"board_clause_text":null,"general_meeting_clause_text":null,"signature_clause_text":null,"confidence":null}`;

const NUMERIC_FIELDS = new Set(["share_capital_amount", "share_count", "nominal_value", "confidence"]);
const FIELDS = [
  "company_name", "organization_number", "last_amended_date",
  "share_capital_amount", "share_count", "nominal_value",
  "municipality", "business_purpose",
  "board_clause_text", "general_meeting_clause_text", "signature_clause_text",
  "confidence"
];

export function isArticlesAiAvailable() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function coerce(field, value) {
  if (value === null || value === undefined || value === "") return null;

  if (NUMERIC_FIELDS.has(field)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    if (field === "share_count") return Math.round(numeric);
    return numeric;
  }

  const text = String(value).trim();
  return text ? text : null;
}

/*
  Runs only for the fields the deterministic parser could not read.
  Returns null when AI is unavailable, the call fails, or the response is
  unusable — a failure here must degrade to manual entry, never to a guess.
*/
export async function extractArticlesFieldsWithAi(articlesText, missingFields = []) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const text = String(articlesText || "").trim();
  if (!text) return null;

  const wanted = missingFields.length ? missingFields.filter((f) => FIELDS.includes(f)) : FIELDS;
  if (!wanted.length) return null;

  const userPrompt =
    `Hent ut disse feltene fra vedtektene under: ${wanted.join(", ")}.\n` +
    `Sett alle andre felter til null.\n\n--- VEDTEKTER ---\n${text.slice(0, MAX_TEXT_CHARS)}`;

  let response;
  try {
    response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" },
        // Reading facts out of a document, not writing prose.
        temperature: 0,
        max_tokens: 900
      })
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let parsed;
  try {
    const data = await response.json();
    parsed = JSON.parse(data?.choices?.[0]?.message?.content || "");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const fields = {};
  for (const field of FIELDS) {
    // Only fields we actually asked about are accepted, so the model cannot
    // overwrite something the deterministic parser already read correctly.
    fields[field] = wanted.includes(field) ? coerce(field, parsed[field]) : null;
  }

  return {
    fields,
    confidence: fields.confidence,
    model: OPENAI_MODEL,
    extraction_version: ARTICLES_AI_EXTRACTION_VERSION
  };
}
