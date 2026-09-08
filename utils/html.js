export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeHtmlRecord(values = {}) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, escapeHtml(value)])
  );
}
