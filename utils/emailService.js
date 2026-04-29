function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function firstNonEmptyEnv(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

export async function sendEmail({ to, subject, html, text }) {
  const resendApiKey = firstNonEmptyEnv("RESEND_API_KEY", "RESEND_KEY");
  const fromEmail = firstNonEmptyEnv("EMAIL_FROM", "RESEND_FROM", "FROM_EMAIL", "MAIL_FROM");

  if (!to || !subject) {
    throw new Error("Email requires recipient and subject");
  }

  if (resendApiKey && fromEmail) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [to],
        subject,
        html,
        text
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Resend error: ${errorBody}`);
    }

    return { mode: "resend" };
  }

  if (isProduction()) {
    throw new Error("Email provider is not configured. Set RESEND_API_KEY and EMAIL_FROM (or RESEND_FROM).");
  }

  console.log("=== AUTH EMAIL PREVIEW ===");
  console.log("TO:", to);
  console.log("SUBJECT:", subject);
  console.log("TEXT:", text || html || "");
  console.log("==========================");

  return { mode: "log" };
}
