import { sendEmail } from "./emailService.js";

const formatNok = (value) =>
  `${Number(value || 0).toLocaleString("no-NO")} NOK`;

const getFrontendBase = () =>
  `${String(process.env.FRONTEND_URL || "").split(",")[0].replace(/\/+$/, "")}`;

const sendSafe = async (payload) => {
  try {
    await sendEmail(payload);
  } catch (error) {
    console.error("Notification email failed:", error);
  }
};

export async function sendRoundActivatedEmail({
  startupEmail,
  startupName,
  roundId
}) {
  if (!startupEmail) return;
  const dashboardUrl = `${getFrontendBase()}/dashboard.html`;
  await sendSafe({
    to: startupEmail,
    subject: "Privat runde er opprettet i Raisium",
    text: `Hei,\n\nDen private runden${startupName ? ` for ${startupName}` : ""} er nå opprettet og klar til bruk i Raisium.\n\nÅpne dashboard:\n${dashboardUrl}\n\nRunde-ID: ${roundId || "-"}`,
    html: `
      <p>Hei,</p>
      <p>Den private runden${startupName ? ` for <strong>${startupName}</strong>` : ""} er nå opprettet og klar til bruk i Raisium.</p>
      <p><a href="${dashboardUrl}">Åpne dashboard</a></p>
      <p>Runde-ID: <strong>${roundId || "-"}</strong></p>
    `
  });
}

export async function sendRcAgreementCreatedEmails({
  investorEmail,
  startupName,
  amount,
  agreementId
}) {
  const rcUrl = `${getFrontendBase()}/rc-detail.html?id=${agreementId}`;
  const amountLabel = formatNok(amount);

  const tasks = [];

  // Startupen varsles bevisst IKKE her — avtalen er kun signert, ikke betalt.
  // De får beskjed først når investor faktisk har betalt eller markert som betalt
  // (se sendInvestorMarkedPaidEmail / Stripe-webhooken), så de slipper å sjekke
  // kontoen sin forgjeves hver gang en avtale opprettes.

  if (investorEmail) {
    tasks.push(sendEmail({
      to: investorEmail,
      subject: `Avtalen din hos ${startupName || "startupen"} er opprettet`,
      text: `Hei,\n\nAvtalen din på ${amountLabel} er opprettet i Raisium. Du kan åpne avtalen her:\n${rcUrl}`,
      html: `
        <p>Hei,</p>
        <p>Avtalen din på <strong>${amountLabel}</strong> er opprettet i Raisium.</p>
        <p><a href="${rcUrl}">Åpne avtalen</a></p>
      `
    }));
  }

  await Promise.all(tasks);
}

export async function sendRcPaymentConfirmedEmail({
  investorEmail,
  startupName,
  amount,
  agreementId
}) {
  if (!investorEmail) return;
  const rcUrl = `${getFrontendBase()}/rc-detail.html?id=${agreementId}`;
  await sendSafe({
    to: investorEmail,
    subject: `Betaling er bekreftet hos ${startupName || "selskapet"}`,
    text: `Hei,\n\nBetalingen på ${formatNok(amount)} er bekreftet av ${startupName || "selskapet"}.\n\nAvtalen er nå aktiv i Raisium:\n${rcUrl}`,
    html: `
      <p>Hei,</p>
      <p>Betalingen på <strong>${formatNok(amount)}</strong> er bekreftet av <strong>${startupName || "selskapet"}</strong>.</p>
      <p><a href="${rcUrl}">Åpne avtalen</a></p>
    `
  });
}

// Investor har trykket "Jeg har betalt" (bankoverføring) — startupen må selv
// bekrefte mottak i dashboardet før avtalen aktiveres.
export async function sendInvestorMarkedPaidEmail({
  startupEmail,
  investorName,
  investorEmail,
  amount,
  agreementId
}) {
  if (!startupEmail) return;
  const dashboardUrl = `${getFrontendBase()}/dashboard.html`;
  const amountLabel = formatNok(amount);
  const investorLabel = investorName || investorEmail || "En investor";
  await sendSafe({
    to: startupEmail,
    subject: "En investor har markert betaling som sendt",
    text: `Hei,\n\n${investorLabel} har markert ${amountLabel} som betalt i den private runden.\n\nSjekk kontoen din og bekreft mottak i Raisium når pengene er der:\n${dashboardUrl}`,
    html: `
      <p>Hei,</p>
      <p><strong>${investorLabel}</strong> har markert <strong>${amountLabel}</strong> som betalt i den private runden.</p>
      <p>Sjekk kontoen din og bekreft mottak i Raisium når pengene er der.</p>
      <p><a href="${dashboardUrl}">Åpne dashboard</a></p>
    `
  });
}

// Stripe har bekreftet betaling og aktivert avtalen automatisk — startupen
// trenger ikke gjøre noe, men bør vite at pengene er på vei.
export async function sendStripePaymentReceivedStartupEmail({
  startupEmail,
  investorName,
  investorEmail,
  amount,
  agreementId
}) {
  if (!startupEmail) return;
  const dashboardUrl = `${getFrontendBase()}/dashboard.html`;
  const amountLabel = formatNok(amount);
  const investorLabel = investorName || investorEmail || "En investor";
  await sendSafe({
    to: startupEmail,
    subject: "Betaling mottatt via Stripe",
    text: `Hei,\n\n${investorLabel} har betalt ${amountLabel} med kort/Vipps via Stripe. Avtalen er automatisk aktivert i Raisium.\n\nÅpne dashboard:\n${dashboardUrl}`,
    html: `
      <p>Hei,</p>
      <p><strong>${investorLabel}</strong> har betalt <strong>${amountLabel}</strong> med kort/Vipps via Stripe. Avtalen er automatisk aktivert i Raisium.</p>
      <p><a href="${dashboardUrl}">Åpne dashboard</a></p>
    `
  });
}

// Betalingsfristen har passert uten at investor har betalt eller markert som
// betalt — én engangs-påminnelse, sendt automatisk (ikke gjentagende spam).
export async function sendRcPaymentReminderEmail({
  investorEmail,
  investorName,
  startupName,
  amount,
  agreementId
}) {
  if (!investorEmail) return;
  const rcUrl = `${getFrontendBase()}/rc-detail.html?id=${agreementId}`;
  const amountLabel = formatNok(amount);
  await sendSafe({
    to: investorEmail,
    subject: `Påminnelse: betaling til ${startupName || "selskapet"} venter`,
    text: `Hei ${investorName || ""},\n\nBetalingsfristen for avtalen din på ${amountLabel} hos ${startupName || "selskapet"} har passert. Fullfør betalingen for å aktivere avtalen:\n${rcUrl}`,
    html: `
      <p>Hei ${investorName || ""},</p>
      <p>Betalingsfristen for avtalen din på <strong>${amountLabel}</strong> hos <strong>${startupName || "selskapet"}</strong> har passert.</p>
      <p>Fullfør betalingen for å aktivere avtalen.</p>
      <p><a href="${rcUrl}">Åpne avtalen</a></p>
    `
  });
}

// Startupen har kansellert en avtale som ikke ble betalt i tide.
export async function sendRcAgreementCancelledEmail({
  investorEmail,
  investorName,
  startupName,
  amount,
  reason,
  agreementId
}) {
  if (!investorEmail) return;
  const amountLabel = formatNok(amount);
  const reasonLine = reason ? `\n\nBegrunnelse fra selskapet: ${reason}` : "";
  const reasonHtml = reason ? `<p>Begrunnelse fra selskapet: ${reason}</p>` : "";
  await sendSafe({
    to: investorEmail,
    subject: `Avtalen din hos ${startupName || "selskapet"} er kansellert`,
    text: `Hei ${investorName || ""},\n\n${startupName || "Selskapet"} har kansellert avtalen din på ${amountLabel}, siden betaling ikke ble mottatt.${reasonLine}\n\nTa kontakt med selskapet hvis du fortsatt ønsker å investere.`,
    html: `
      <p>Hei ${investorName || ""},</p>
      <p><strong>${startupName || "Selskapet"}</strong> har kansellert avtalen din på <strong>${amountLabel}</strong>, siden betaling ikke ble mottatt.</p>
      ${reasonHtml}
      <p>Ta kontakt med selskapet hvis du fortsatt ønsker å investere.</p>
    `
  });
}

// Investor har selv avbrutt investeringen før betaling — startupen varsles
// med det samme.
export async function sendInvestorWithdrewEmail({
  startupEmail,
  investorName,
  investorEmail,
  amount,
  reason,
  agreementId
}) {
  if (!startupEmail) return;
  const dashboardUrl = `${getFrontendBase()}/dashboard.html`;
  const amountLabel = formatNok(amount);
  const investorLabel = investorName || investorEmail || "En investor";
  const reasonLine = reason ? `\n\nBegrunnelse fra investoren: ${reason}` : "";
  const reasonHtml = reason ? `<p>Begrunnelse fra investoren: ${reason}</p>` : "";
  await sendSafe({
    to: startupEmail,
    subject: "En investor har avbrutt investeringen",
    text: `Hei,\n\n${investorLabel} har avbrutt investeringen på ${amountLabel} i den private runden, før betaling.${reasonLine}\n\nÅpne dashboard:\n${dashboardUrl}`,
    html: `
      <p>Hei,</p>
      <p><strong>${investorLabel}</strong> har avbrutt investeringen på <strong>${amountLabel}</strong> i den private runden, før betaling.</p>
      ${reasonHtml}
      <p><a href="${dashboardUrl}">Åpne dashboard</a></p>
    `
  });
}

export async function sendConversionStartedEmail({
  startupEmail,
  startupName,
  triggerLabel
}) {
  if (!startupEmail) return;
  const dashboardUrl = `${getFrontendBase()}/dashboard.html`;
  await sendSafe({
    to: startupEmail,
    subject: "Trigger event er registrert i Raisium",
    text: `Hei,\n\nTrigger event${triggerLabel ? ` (${triggerLabel})` : ""} er registrert for ${startupName || "selskapet"}.\n\nÅpne dashboard for videre oppfølging:\n${dashboardUrl}`,
    html: `
      <p>Hei,</p>
      <p>Trigger event${triggerLabel ? ` (<strong>${triggerLabel}</strong>)` : ""} er registrert for <strong>${startupName || "selskapet"}</strong>.</p>
      <p><a href="${dashboardUrl}">Åpne dashboard</a></p>
    `
  });
}

export async function sendRoundClosedEmail({
  startupEmail,
  startupName
}) {
  if (!startupEmail) return;
  const dashboardUrl = `${getFrontendBase()}/dashboard.html`;
  await sendSafe({
    to: startupEmail,
    subject: "Runden er nå lukket i Raisium",
    text: `Hei,\n\nRunden${startupName ? ` for ${startupName}` : ""} er nå lukket etter at dokumentpakken ble lastet ned.\n\nÅpne dashboard:\n${dashboardUrl}`,
    html: `
      <p>Hei,</p>
      <p>Runden${startupName ? ` for <strong>${startupName}</strong>` : ""} er nå lukket etter at dokumentpakken ble lastet ned.</p>
      <p><a href="${dashboardUrl}">Åpne dashboard</a></p>
    `
  });
}

export async function sendDocumentSigningRequestEmail({
  to,
  companyName,
  roleLabel,
  documentTitle,
  signUrl
}) {
  if (!to || !signUrl) return;
  await sendSafe({
    to,
    subject: `${documentTitle || "Dokument"} er klar for signering`,
    text: `Hei,\n\n${documentTitle || "Et dokument"} er klart for signering${companyName ? ` for ${companyName}` : ""}${roleLabel ? ` som ${roleLabel}` : ""}.\n\nÅpne dokumentet her:\n${signUrl}`,
    html: `
      <p>Hei,</p>
      <p><strong>${documentTitle || "Et dokument"}</strong> er klart for signering${companyName ? ` for <strong>${companyName}</strong>` : ""}${roleLabel ? ` som <strong>${roleLabel}</strong>` : ""}.</p>
      <p><a href="${signUrl}">Åpne dokumentet</a></p>
    `
  });
}
