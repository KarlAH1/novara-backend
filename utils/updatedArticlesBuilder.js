import fs from "fs/promises";

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "";
  }

  return numeric.toLocaleString("no-NO");
}

export async function buildUpdatedArticlesDraft({
  templatePath,
  currentArticles = {},
  nextCapitalData = {},
  fallbackData = {}
}) {
  const template = await fs.readFile(templatePath, "utf8");
  const merged = {
    company_name: currentArticles.company_name || fallbackData.company_name || "",
    orgnr: currentArticles.organization_number || fallbackData.orgnr || "",
    date: nextCapitalData.last_amended_date || new Date().toLocaleDateString("no-NO"),
    municipality: currentArticles.municipality || fallbackData.municipality || "",
    business_purpose: currentArticles.business_purpose || fallbackData.business_purpose || "Selskapets virksomhet følger det som er registrert for selskapet.",
    share_capital_amount_display: formatNumber(nextCapitalData.share_capital_amount ?? currentArticles.share_capital_amount),
    share_count_display: formatNumber(nextCapitalData.share_count ?? currentArticles.share_count),
    nominal_value_display: formatNumber(nextCapitalData.nominal_value ?? currentArticles.nominal_value),
    board_clause_text: currentArticles.board_clause_text || fallbackData.board_clause_text || "Selskapets styre skal ha det antall medlemmer som besluttes av generalforsamlingen.",
    general_meeting_clause_text: currentArticles.general_meeting_clause_text || fallbackData.general_meeting_clause_text || "Ordinær generalforsamling holdes hvert år innen lovens frister.",
    signature_clause_text: currentArticles.signature_clause_text || fallbackData.signature_clause_text || "Selskapets firma tegnes av styret eller den styret gir signaturrett."
  };

  let html = template;
  Object.entries(merged).forEach(([key, value]) => {
    html = html.replace(new RegExp(`{{${key}}}`, "g"), String(value || ""));
  });

  return {
    fields: merged,
    html
  };
}
