import { sendEmail } from "./emailService.js";
import { escapeHtml } from "./html.js";
import { renderEmail } from "./emailLayout.js";
import { publicAppUrl } from "./publicUrl.js";

const formatNok = (value) =>
  `${Number(value || 0).toLocaleString("no-NO")} NOK`;

const getFrontendBase = () =>
  publicAppUrl();

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
    html: renderEmail({
      heading: "Runden er åpen",
      introHtml: `Den private runden${startupName ? ` for <strong>${escapeHtml(startupName)}</strong>` : ""} er klar. Lag en personlig lenke til den første du vil invitere.`,
      button: { label: "Gå til runden", url: dashboardUrl }
    })
  });
}

export async function sendRcAgreementCreatedEmails({
  investorEmail,
  startupName,
  amount,
  agreementId
}) {
  const rcUrl = `${getFrontendBase()}/rc-detail.html?agreement=${agreementId}`;
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
      html: renderEmail({
        heading: `Du har signert avtalen med ${startupName || "selskapet"}`,
        introHtml: "Siste steg er å betale. Pengene går direkte til selskapet.",
        box: { amount: amountLabel, label: `Investering i ${startupName || "selskapet"}` },
        button: { label: "Gå til betaling", url: rcUrl },
        accent: "investor"
      })
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
  const rcUrl = `${getFrontendBase()}/rc-detail.html?agreement=${agreementId}`;
  await sendSafe({
    to: investorEmail,
    subject: `Betaling er bekreftet hos ${startupName || "selskapet"}`,
    text: `Hei,\n\nBetalingen på ${formatNok(amount)} til ${startupName || "selskapet"} er bekreftet.\n\nAvtalen er nå aktiv i Raisium:\n${rcUrl}`,
    html: renderEmail({
      heading: `Du er med i ${startupName || "selskapet"}`,
      introHtml: "Betalingen er bekreftet, og avtalen er aktiv. Aksjene får du senere, etter vilkårene i avtalen.",
      box: { amount: formatNok(amount), label: `Investering i ${startupName || "selskapet"}` },
      button: { label: "Se avtalen", url: rcUrl },
      accent: "investor"
    })
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
    html: renderEmail({
      heading: `${investorLabel} har betalt`,
      introHtml: "Sjekk at pengene har kommet inn på kontoen, og bekreft det i Raisium.",
      box: { amount: amountLabel, label: `Bankoverføring fra ${investorLabel}` },
      button: { label: "Bekreft i Raisium", url: dashboardUrl }
    })
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
    html: renderEmail({
      heading: "Du har fått en investering",
      introHtml: `<strong>${escapeHtml(investorLabel)}</strong> betalte med kort eller Vipps. Avtalen er aktivert, og du trenger ikke gjøre noe.`,
      box: { amount: amountLabel, label: `Fra ${investorLabel}` },
      button: { label: "Se runden", url: dashboardUrl }
    })
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
  const rcUrl = `${getFrontendBase()}/rc-detail.html?agreement=${agreementId}`;
  const amountLabel = formatNok(amount);
  await sendSafe({
    to: investorEmail,
    subject: `Påminnelse: betaling til ${startupName || "selskapet"} venter`,
    text: `Hei ${investorName || ""},\n\nBetalingsfristen for avtalen din på ${amountLabel} hos ${startupName || "selskapet"} har passert. Fullfør betalingen for å aktivere avtalen:\n${rcUrl}`,
    html: renderEmail({
      heading: `Betalingen til ${startupName || "selskapet"} venter`,
      introHtml: `Hei${investorName ? ` ${escapeHtml(investorName)}` : ""}. Betalingsfristen har passert. Betal nå for å fullføre investeringen.`,
      box: { amount: amountLabel, label: `Investering i ${startupName || "selskapet"}` },
      button: { label: "Betal nå", url: rcUrl },
      accent: "investor"
    })
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
  const reasonHtml = reason ? `<p>Begrunnelse fra selskapet: ${escapeHtml(reason)}</p>` : "";
  await sendSafe({
    to: investorEmail,
    subject: `Avtalen din hos ${startupName || "selskapet"} er kansellert`,
    text: `Hei ${investorName || ""},\n\n${startupName || "Selskapet"} har kansellert avtalen din på ${amountLabel}, siden betaling ikke ble mottatt.${reasonLine}\n\nTa kontakt med selskapet hvis du fortsatt ønsker å investere.`,
    html: renderEmail({
      heading: "Avtalen er kansellert",
      introHtml: `<strong>${escapeHtml(startupName || "Selskapet")}</strong> har kansellert avtalen, siden betalingen ikke kom inn. Ta kontakt med selskapet hvis du fortsatt vil investere.`,
      box: { amount: amountLabel, label: "Kansellert investering", linesHtml: reason ? `Begrunnelse: ${escapeHtml(reason)}` : "" },
      accent: "investor"
    })
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
  const reasonHtml = reason ? `<p>Begrunnelse fra investoren: ${escapeHtml(reason)}</p>` : "";
  await sendSafe({
    to: startupEmail,
    subject: "En investor har avbrutt investeringen",
    text: `Hei,\n\n${investorLabel} har avbrutt investeringen på ${amountLabel} i den private runden, før betaling.${reasonLine}\n\nÅpne dashboard:\n${dashboardUrl}`,
    html: renderEmail({
      heading: `${investorLabel} har avbrutt investeringen`,
      introHtml: "Investoren avbrøt før betaling. Plassen er ledig for andre i runden.",
      box: { amount: amountLabel, label: "Avbrutt investering", linesHtml: reason ? `Begrunnelse: ${escapeHtml(reason)}` : "" },
      button: { label: "Se runden", url: dashboardUrl }
    })
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
    html: renderEmail({
      heading: "Trigger event er registrert",
      introHtml: `${triggerLabel ? `<strong>${escapeHtml(triggerLabel)}</strong> er registrert for ` : "Trigger event er registrert for "}<strong>${escapeHtml(startupName || "selskapet")}</strong>. Raisium viser deg neste steg.`,
      button: { label: "Se neste steg", url: dashboardUrl }
    })
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
    html: renderEmail({
      heading: "Runden er lukket",
      introHtml: `Runden${startupName ? ` for <strong>${escapeHtml(startupName)}</strong>` : ""} er lukket etter at dokumentpakken ble lastet ned.`,
      button: { label: "Se runden", url: dashboardUrl }
    })
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
    html: renderEmail({
      heading: `${documentTitle || "Et dokument"} venter på deg`,
      introHtml: `Du skal signere${companyName ? ` for <strong>${escapeHtml(companyName)}</strong>` : ""}${roleLabel ? ` som <strong>${escapeHtml(roleLabel)}</strong>` : ""}. Det tar et par minutter.`,
      button: { label: "Les og signer", url: signUrl }
    })
  });
}
