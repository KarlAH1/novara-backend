import { sendEmail } from "./emailService.js";

const formatNok = (value) =>
  `${Number(value || 0).toLocaleString("no-NO")} NOK`;

export async function sendRcAgreementCreatedEmails({
  startupEmail,
  startupName,
  investorEmail,
  investorName,
  amount,
  agreementId
}) {
  const dashboardUrl = `${String(process.env.FRONTEND_URL || "").split(",")[0].replace(/\/+$/, "")}/dashboard.html`;
  const rcUrl = `${String(process.env.FRONTEND_URL || "").split(",")[0].replace(/\/+$/, "")}/rc-detail.html?id=${agreementId}`;
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
