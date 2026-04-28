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
  startupEmail,
  startupName,
  investorEmail,
  investorName,
  amount,
  agreementId
}) {
  const dashboardUrl = `${getFrontendBase()}/dashboard.html`;
  const rcUrl = `${getFrontendBase()}/rc-detail.html?id=${agreementId}`;
  const amountLabel = formatNok(amount);

  const tasks = [];

  if (startupEmail) {
    tasks.push(sendEmail({
      to: startupEmail,
      subject: "Ny investoravtale i Raisium",
      text: `Hei,\n\n${investorName || investorEmail || "En investor"} har registrert ${amountLabel} i den private runden.\n\nGå til dashboardet for status og oppfølging:\n${dashboardUrl}`,
      html: `
        <p>Hei,</p>
        <p><strong>${investorName || investorEmail || "En investor"}</strong> har registrert <strong>${amountLabel}</strong> i den private runden.</p>
        <p><a href="${dashboardUrl}">Åpne dashboard</a></p>
      `
    }));
  }

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
