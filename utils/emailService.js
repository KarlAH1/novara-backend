function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

export async function sendEmail({ to, subject, html, text }) {
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.EMAIL_FROM;

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
    throw new Error("Email provider is not configured. Set RESEND_API_KEY and EMAIL_FROM.");
  }

  console.log("=== AUTH EMAIL PREVIEW ===");
  console.log("TO:", to);
  console.log("SUBJECT:", subject);
  console.log("TEXT:", text || html || "");
  console.log("==========================");

  return { mode: "log" };
}
