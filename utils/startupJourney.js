import pool from "../config/db.js";
import { getCompanyStartupProfile, resolveCompanyStartupOwner } from "./startupContext.js";
import { getStartupPlanSummaryForUser, STARTUP_PLAN_STATES } from "./startupPlanAccess.js";
import { getLegalResetCutoff } from "./legalRoundReset.js";
import { checkRoundActivationReadiness } from "./roundActivationReadiness.js";
import { tableExists } from "./schemaCapabilities.js";
import { loadRoundDraft } from "./roundDraft.js";

/*
  The terms form saves a draft as the company types and writes the round only
  at activation. "What is missing" is read against the draft, so a cap that is
  on screen is not reported as missing. Activation still checks the saved round.
*/
async function withDraftTerms(round) {
  if (!(await tableExists(pool, "emission_round_drafts"))) return round;
  const draft = await loadRoundDraft(pool, round.id).catch(() => null);
  const fields = draft?.fields || {};
  const merged = { ...round };
  const cap = Number(String(fields.valuation_cap ?? "").replace(/[^\d]/g, ""));
  if (cap > 0) merged.valuation_cap = cap;
  const period = Number(String(fields.conversion_years ?? "").replace(/[^\d]/g, ""));
  if (period >= 1) merged.trigger_period = period;
  const bank = String(fields.bank_account ?? "").trim();
  if (bank) merged.bank_account = bank.slice(0, 64);
  return merged;
}

/*
  The startup's whole road, from registration to shares on the register, as one
  ordered list of steps. Every startup page reads this, so the profile, the
  "next task" card and the automatic hand-over from one page to the next always
  agree on where the company is and what is missing.

  A step is "done", "current" (the first one not done), "waiting" (current, but
  nothing for the company to do: someone else acts), or "upcoming".
*/

const STEP_DEFINITIONS = [
  { key: "company", phase: "Klargjør", title: "Selskap og konto" },
  { key: "about", phase: "Klargjør", title: "Om selskapet" },
  { key: "plan", phase: "Klargjør", title: "Plan" },
  { key: "documents", phase: "Klargjør", title: "Rundedokumenter" },
  { key: "setup", phase: "Klargjør", title: "Vilkår og åpning" },
  { key: "invite", phase: "Runden pågår", title: "Inviter nettverket" },
  { key: "collect", phase: "Runden pågår", title: "Innbetalinger" },
  { key: "confirm", phase: "Runden pågår", title: "Revisor bekrefter" },
  { key: "conversion", phase: "Aksjer", title: "Aksjer til investorene" }
];

const formatNok = (value) => `${Number(value || 0).toLocaleString("no-NO")} kr`;

async function latestRound(startupUserId) {
  const [rows] = await pool.query(
    `SELECT * FROM emission_rounds WHERE startup_id = ? ORDER BY id DESC LIMIT 1`,
    [startupUserId]
  );
  return rows[0] || null;
}

async function yearZeroDocuments(startupUserId) {
  const cutoff = await getLegalResetCutoff(pool, startupUserId);
  const [rows] = await pool.query(
    `SELECT type, status FROM documents
     WHERE startup_id = ? AND type IN ('BOARD', 'GF') AND (? IS NULL OR created_at > ?)
     ORDER BY id DESC`,
    [startupUserId, cutoff, cutoff]
  );
  const latest = (type) => rows.find((row) => row.type === type) || null;
  return { board: latest("BOARD"), gf: latest("GF") };
}

async function roundActivity(roundId) {
  const [[invites]] = await pool.query("SELECT COUNT(*) AS n FROM rc_invites WHERE round_id = ?", [roundId]);
  const [[agreements]] = await pool.query(
    `SELECT
       SUM(status = 'Active RC') AS paid,
       COALESCE(SUM(CASE WHEN status = 'Active RC' THEN investment_amount END), 0) AS paid_amount,
       SUM(status = 'Awaiting Payment') AS awaiting,
       SUM(status = 'Awaiting Payment' AND investor_marked_paid_at IS NOT NULL) AS marked_paid,
       SUM(status = 'Pending Signatures') AS signing
     FROM rc_agreements WHERE round_id = ?`,
    [roundId]
  );
  return {
    invites: Number(invites?.n || 0),
    paid: Number(agreements?.paid || 0),
    paidAmount: Number(agreements?.paid_amount || 0),
    awaiting: Number(agreements?.awaiting || 0),
    markedPaid: Number(agreements?.marked_paid || 0),
    signing: Number(agreements?.signing || 0)
  };
}

async function roundConfirmation(roundId) {
  if (!(await tableExists(pool, "payment_confirmation_requests"))) return null;
  const [rows] = await pool.query(
    "SELECT status, document_id FROM payment_confirmation_requests WHERE scope_key = ? LIMIT 1",
    [`round:${roundId}`]
  );
  return rows[0] || null;
}

async function latestConversion(startupUserId, roundId) {
  const [rows] = await pool.query(
    "SELECT id, status, trigger_type FROM conversion_events WHERE startup_id = ? AND round_id = ? ORDER BY id DESC LIMIT 1",
    [startupUserId, roundId]
  );
  return rows[0] || null;
}

export async function getStartupJourney(userId) {
  const { company, startupUserId } = await resolveCompanyStartupOwner(pool, userId);
  const [[user]] = await pool.query(
    "SELECT name, company_role_check_status FROM users WHERE id = ? LIMIT 1",
    [userId]
  );
  const profile = await getCompanyStartupProfile(pool, userId);
  const plan = await getStartupPlanSummaryForUser(userId);
  const docs = await yearZeroDocuments(startupUserId);
  const round = await latestRound(startupUserId);
  const activity = round ? await roundActivity(round.id) : null;
  const notices = [];

  const rolePending = user?.company_role_check_status === "pending_manual_review";
  if (rolePending) {
    notices.push({
      tone: "info",
      text: "Raisium bekrefter at du har en rolle i selskapet. Du kan forberede alt i mellomtiden, men runden kan først åpnes når det er gjort."
    });
  }

  const step = {};

  step.company = {
    done: Boolean(company),
    summary: company ? `${company.company_name} · org.nr. ${company.orgnr}` : null,
    missing: company ? [] : ["Koble kontoen til selskapet"],
    cta: { label: "Koble til selskap", url: "register.html" }
  };

  const aboutMissing = [];
  if (!String(profile?.sector || "").trim()) aboutMissing.push("Hva selskapet tilbyr");
  if (!String(profile?.pitch || "").trim()) aboutMissing.push("Hva pengene skal brukes til");
  step.about = {
    done: aboutMissing.length === 0,
    summary: aboutMissing.length ? null : "Investorene ser hva dere gjør og hva pengene går til.",
    missing: aboutMissing,
    cta: { label: "Fyll ut", url: "profile.html#om-selskapet" }
  };

  const planActive = plan.state === STARTUP_PLAN_STATES.RAISE_FORM_UNLOCKED;
  const planWaiting = plan.state === STARTUP_PLAN_STATES.PAYMENT_PENDING;
  // There is one plan, so there is nothing to choose: the payment page picks
  // it and the startup goes straight to paying.
  step.plan = {
    done: planActive,
    waiting: planWaiting,
    summary: planActive ? "Seed er aktiv." : planWaiting ? "Betalingen er registrert. Raisium bekrefter den." : null,
    missing: planActive || planWaiting ? [] : ["Betal planen"],
    cta: { label: planWaiting ? "Se status" : "Betal planen", url: "startup-payment.html" }
  };

  const boardSigned = docs.board?.status === "LOCKED";
  const gfSigned = docs.gf?.status === "LOCKED";
  const documentsMissing = [];
  if (!boardSigned) documentsMissing.push("Styrets forslag, signert");
  if (!gfSigned) documentsMissing.push("Generalforsamlingens vedtak, signert");
  if (boardSigned && gfSigned && !round) documentsMissing.push("Opprett runden");
  step.documents = {
    done: Boolean(round),
    summary: round ? "Styrets forslag og generalforsamlingens vedtak er signert." : null,
    missing: documentsMissing,
    cta: { label: boardSigned && gfSigned ? "Opprett runden" : "Lag og signer dokumentene", url: "emisjon.html?auto=1" }
  };

  const roundOpened = Boolean(round && (Number(round.open) === 1 || round.closed_reason));
  let setupMissing = [];
  if (round && !roundOpened) {
    const readiness = await checkRoundActivationReadiness(pool, startupUserId, await withDraftTerms(round));
    setupMissing = readiness.blockers;
  } else if (!round) {
    setupMissing = ["Rundedokumentene må være signert først"];
  }
  step.setup = {
    done: roundOpened,
    summary: roundOpened
      ? `Mål ${formatNok(round.target_amount)} · cap ${formatNok(round.valuation_cap)} · ${round.trigger_period || round.conversion_years || 2} år`
      : null,
    missing: setupMissing,
    cta: { label: "Sett vilkår og åpne runden", url: round ? `dashboard.html?emission=${round.id}` : "emisjon.html?auto=1" }
  };

  const inviteUrl = round ? `dashboard.html?emission=${round.id}#inviter` : "dashboard.html";
  step.invite = {
    done: Boolean(activity?.invites),
    summary: activity?.invites ? `${activity.invites} personlige lenker laget.` : null,
    missing: activity?.invites ? [] : ["Lag en personlig lenke til den første personen"],
    cta: { label: "Inviter", url: inviteUrl }
  };

  const target = Number(round?.target_amount || 0);
  const committed = Number(round?.committed_amount ?? activity?.paidAmount ?? 0);
  const roundFull = Boolean(round && target > 0 && committed >= target);
  const roundClosed = Boolean(round?.closed_reason);
  const collectMissing = [];
  if (activity?.markedPaid) {
    collectMissing.push(`${activity.markedPaid} ${activity.markedPaid === 1 ? "investor har" : "investorer har"} betalt med bankoverføring. Bekreft at pengene kom inn.`);
  }
  step.collect = {
    done: roundFull || roundClosed,
    summary: round ? `${formatNok(committed)} av ${formatNok(target)} innbetalt${activity?.paid ? ` fra ${activity.paid} ${activity.paid === 1 ? "investor" : "investorer"}` : ""}.` : null,
    waiting: !collectMissing.length,
    waitingText: "Investorene signerer og betaler. Dere følger dem i pipelinen.",
    missing: collectMissing,
    cta: { label: collectMissing.length ? "Bekreft betalinger" : "Se pipelinen", url: inviteUrl }
  };

  const confirmation = round ? await roundConfirmation(round.id) : null;
  step.confirm = {
    done: confirmation?.status === "confirmed",
    waiting: confirmation && confirmation.status !== "awaiting_evidence" && confirmation.status !== "info_requested",
    waitingText: "Raisiums revisor går gjennom innbetalingene. Dere trenger ikke gjøre noe.",
    summary: confirmation?.status === "confirmed" ? "Revisor har bekreftet innbetalingene." : null,
    missing: confirmation?.status === "awaiting_evidence"
      ? ["Last opp kontoutskrift for bankoverføringene"]
      : confirmation?.status === "info_requested" ? ["Revisor ber om mer dokumentasjon"] : [],
    cta: { label: "Last opp kontoutskrift", url: round ? `dashboard.html?emission=${round.id}` : "dashboard.html" }
  };

  const conversion = round ? await latestConversion(startupUserId, round.id) : null;
  const deadline = round?.deadline ? new Date(round.deadline) : null;
  const daysLeft = deadline ? Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / 86400000)) : null;
  step.conversion = {
    done: conversion?.status === "completed" || round?.closed_reason === "conversion_downloaded",
    summary: conversion ? null : (daysLeft != null ? `Senest om ${daysLeft} dager, eller tidligere ved en ny emisjon eller et salg.` : null),
    waiting: !conversion,
    waitingText: daysLeft != null
      ? `Investorene får aksjer ved konvertering, senest om ${daysLeft} dager. Skjer en ny emisjon eller et salg før det, registrerer dere det.`
      : "Investorene får aksjer ved konvertering.",
    missing: conversion ? ["Fullfør konverteringen"] : [],
    cta: { label: conversion ? "Gå til konverteringen" : "Se runden", url: conversion ? "convert.html" : inviteUrl }
  };

  // Year-0 confirmation only appears once the round is full or closed.
  const visible = STEP_DEFINITIONS.filter((definition) =>
    definition.key !== "confirm" || step.collect.done || confirmation
  );

  let currentFound = false;
  const steps = visible.map((definition, index) => {
    const data = step[definition.key];
    let status;
    if (data.done) {
      status = "done";
    } else if (!currentFound) {
      currentFound = true;
      status = data.waiting && !data.missing?.length ? "waiting" : "current";
    } else {
      status = "upcoming";
    }
    return {
      key: definition.key,
      number: index + 1,
      phase: definition.phase,
      title: definition.title,
      status,
      summary: data.summary || null,
      missing: status === "upcoming" ? [] : (data.missing || []),
      waiting_text: status === "waiting" ? data.waitingText || data.summary || null : null,
      cta: status === "current" || status === "waiting" ? data.cta : null
    };
  });

  const current = steps.find((item) => item.status === "current" || item.status === "waiting") || null;
  const done = steps.filter((item) => item.status === "done").length;

  return {
    company: company ? { name: company.company_name, orgnr: company.orgnr } : null,
    round: round ? { id: round.id, open: Number(round.open) === 1 } : null,
    steps,
    current,
    progress: { done, total: steps.length },
    notices
  };
}
