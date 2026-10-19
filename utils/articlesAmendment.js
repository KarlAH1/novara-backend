/*
  Updated articles after a capital increase.

  The GF resolution changes one thing in the articles: the share capital clause.
  Everything else has to stay exactly as the company's registered articles say.
  The articles used to be rebuilt from a seven-clause template filled with
  parsed fields and generic fallbacks. That replaced the purpose, board and
  signature clauses with stock text and dropped every clause the template did
  not have, such as transfer restrictions: an amendment of the articles that no
  general meeting had resolved, sent to Foretaksregisteret.

  So the updated articles are the company's own current text, with the share
  capital and the share count in the capital clause replaced. If that clause
  cannot be found exactly once, or the figures in it do not match the confirmed
  share basis, nothing is produced and a person has to prepare the articles.
*/

// "40 000", "40.000", "40000", "1", "0,10". Grouped forms are tried first.
const NUMBER = String.raw`\d{1,3}(?:[ .  ]\d{3})+(?:,\d+)?|\d+(?:,\d+)?`;
const CURRENCY = String.raw`(?:NOK|kr\.?|kroner)`;

const CAPITAL_PATTERNS = [
  new RegExp(String.raw`(aksjekapital(?:en)?\s+(?:er\s+)?(?:på\s+)?${CURRENCY}\s*)(${NUMBER})`, "gi"),
  new RegExp(String.raw`(aksjekapital(?:en)?\s+(?:er\s+)?(?:på\s+)?)(${NUMBER})(?=\s*${CURRENCY})`, "gi")
];
const SHARE_COUNT_PATTERN = new RegExp(String.raw`(fordelt\s+på\s+)(${NUMBER})(?=\s+aksjer)`, "gi");
const PAR_PATTERNS = [
  new RegExp(String.raw`(pålydende\s+(?:verdi\s+)?(?:på\s+)?${CURRENCY}\s*)(${NUMBER})`, "gi"),
  new RegExp(String.raw`(pålydende\s+(?:verdi\s+)?(?:på\s+)?)(${NUMBER})(?=\s*${CURRENCY})`, "gi")
];

function parseNorwegianNumber(text) {
  const compact = String(text).replace(/[ .  ](?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const value = Number(compact);
  return Number.isFinite(value) ? value : null;
}

export function formatNorwegianInteger(value) {
  return String(Math.round(Number(value))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Joins lines that a PDF wrapped mid-sentence, keeping list items on their own lines.
function joinWrappedLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const startsItem = /^([-•–]|\(?[a-zæøå0-9]{1,2}[).])\s/i.test(line);
    const previous = out[out.length - 1];
    if (previous && previous !== "" && !startsItem && !/[:;]$/.test(previous)) {
      out[out.length - 1] = /[a-zæøå]-$/i.test(previous) && /^[a-zæøå]/.test(line)
        ? previous.slice(0, -1) + line
        : `${previous} ${line}`;
    } else {
      out.push(line);
    }
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

// Splits articles text into the lines before the first § and one entry per §.
export function splitArticles(text) {
  const lines = String(text || "").replace(/\r/g, "\n").split("\n");
  const preamble = [];
  const sections = [];
  for (const line of lines) {
    if (/^\s*§\s*\d+/.test(line)) {
      sections.push([line.trim()]);
    } else if (sections.length) {
      sections[sections.length - 1].push(line);
    } else {
      preamble.push(line);
    }
  }

  return {
    preamble: preamble.map((line) => line.trim()).filter(Boolean),
    sections: sections.map(([first, ...rest]) => {
      const match = first.match(/^(§\s*\d+\s*[.:]?)\s*(.*)$/);
      const number = match[1].replace(/[.:]$/, "").replace(/\s+/g, " ").trim();
      const remainder = match[2].trim();
      // "§ 4 Aksjekapital" is a heading; "§ 4 Selskapets aksjekapital er …" is
      // the clause itself.
      const isHeading = remainder && remainder.length <= 60 && !/[.]$/.test(remainder) && rest.some((line) => line.trim());
      return {
        heading: isHeading ? `${number} ${remainder}` : number,
        paragraphs: joinWrappedLines(isHeading ? rest : [remainder, ...rest]).filter((line) => line !== "")
      };
    })
  };
}

function findOnce(patterns, text) {
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 1) return { pattern, match: matches[0] };
    if (matches.length > 1) return { ambiguous: true };
  }
  return null;
}

/*
  current: the confirmed share basis before the increase.
  next: share capital and share count after it.
  Returns { ok: true, html, capitalSection } or { ok: false, error }.
*/
export function amendArticlesShareCapital(text, { current, next, companyName, orgnr, amendedDate }) {
  const { preamble, sections } = splitArticles(text);
  if (!sections.length) {
    return { ok: false, error: "Fant ingen paragrafer (§) i teksten fra vedtektene." };
  }

  const candidates = sections.filter((section) => {
    const body = section.paragraphs.join(" ");
    return /aksjekapital/i.test(body) && /fordelt\s+på/i.test(body);
  });
  if (candidates.length !== 1) {
    return {
      ok: false,
      error: candidates.length
        ? "Vedtektene har mer enn én paragraf som ser ut som aksjekapitalparagrafen."
        : "Fant ikke paragrafen om aksjekapital i vedtektene."
    };
  }
  const capitalSection = candidates[0];
  const body = capitalSection.paragraphs.join("\n");

  const capital = findOnce(CAPITAL_PATTERNS, body);
  const count = findOnce([SHARE_COUNT_PATTERN], body);
  const par = findOnce(PAR_PATTERNS, body);
  if (!capital?.match || !count?.match || !par?.match) {
    return { ok: false, error: "Aksjekapital, antall aksjer og pålydende står ikke på en form som kan oppdateres automatisk." };
  }

  const found = {
    capital: parseNorwegianNumber(capital.match[2]),
    count: parseNorwegianNumber(count.match[2]),
    par: parseNorwegianNumber(par.match[2])
  };
  const matchesBasis =
    Math.abs(found.capital - Number(current.shareCapital)) < 0.005 &&
    Math.abs(found.count - Number(current.shareCount)) < 0.5 &&
    Math.abs(found.par - Number(current.parValue)) < 0.00005;
  if (!matchesBasis) {
    return {
      ok: false,
      error:
        `Vedtektene som er lastet opp sier aksjekapital ${found.capital}, ${found.count} aksjer og pålydende ${found.par}, ` +
        `men det bekreftede aksjegrunnlaget er ${current.shareCapital}, ${current.shareCount} og ${current.parValue}. ` +
        "Last opp gjeldende vedtekter."
    };
  }

  const amendedBody = body
    .replace(capital.pattern, (_, before) => `${before}${formatNorwegianInteger(next.shareCapital)}`)
    .replace(SHARE_COUNT_PATTERN, (_, before) => `${before}${formatNorwegianInteger(next.shareCount)}`);
  const amendedSections = sections.map((section) => section === capitalSection
    ? { ...section, paragraphs: amendedBody.split("\n"), amended: true }
    : section);

  let dated = false;
  const header = preamble.map((line) => {
    if (/sist\s+endret/i.test(line)) {
      dated = true;
      return line.replace(/(sist\s+endret\s*:?\s*).*$/i, `$1${amendedDate}`);
    }
    return line;
  });
  if (!dated) header.push(`Sist endret: ${amendedDate}`);

  const [title, ...headerRest] = header.length ? header : [`Vedtekter for ${companyName}`];
  const html = `<!-- updated_articles: amended share capital clause only -->
<div class="doc-template" style="font-family: Georgia, 'Times New Roman', serif; color: #111; line-height: 1.55; max-width: 760px; margin: 0 auto;">
  <h1 style="margin: 0 0 8px; font-size: 26px;">${escapeHtml(title)}</h1>
  ${headerRest.map((line) => `<p style="margin: 0 0 4px; color: #374151;">${escapeHtml(line)}</p>`).join("\n  ")}
  ${orgnr && !header.some((line) => line.replace(/\s/g, "").includes(String(orgnr))) ? `<p style="margin: 0 0 4px; color: #374151;">Org.nr. ${escapeHtml(orgnr)}</p>` : ""}
  <div style="margin-top: 24px;">
  ${amendedSections.map((section) => `<p style="margin: 0 0 14px;"><strong>${escapeHtml(section.heading)}</strong><br>${section.paragraphs.map(escapeHtml).join("<br>")}</p>`).join("\n  ")}
  </div>
</div>`;

  return {
    ok: true,
    html,
    capitalSection: { heading: capitalSection.heading, before: body, after: amendedBody }
  };
}
