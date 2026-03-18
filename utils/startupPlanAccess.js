import pool from "../config/db.js";

export const STARTUP_PLAN_DEFINITIONS = {
  basic: {
    code: "basic",
    name: "Basic",
    annual_price_nok: 500,
    available: true,
    features: [
      "Startupen kan fullføre en emisjon i Raisium",
      "Tilgang til dagens kjerneflyt",
      "Dokumenter kan genereres",
      "Startupen må laste ned og oppbevare dokumentene selv",
      "Raisium lagrer ikke dokumentene for startupen",
      "Ingen konverteringspakke senere",
      "Ingen løpende oppfølging inkludert",
      "Ingen juridisk hjelp inkludert"
    ],
    includes_document_storage: false,
    includes_conversion_package: false,
    includes_follow_up: false,
    includes_legal_help: false
  },
  normal: {
    code: "normal",
    name: "Normal",
    annual_price_nok: 1000,
    available: true,
    features: [
      "Alt i Basic",
      "Dokumentlagring",
      "Dokumentproduksjon",
      "Konverteringspakke",
      "Oppfolging",
      "Juridisk hjelp ved tvister og spørsmål"
    ],
    includes_document_storage: true,
    includes_conversion_package: true,
    includes_follow_up: true,
    includes_legal_help: true
  },
  pro: {
    code: "pro",
    name: "Pro",
    annual_price_nok: 2000,
    available: false,
    features: [
      "Utvidet stotte",
      "Mer avansert automasjon",
      "Mer operativ hjelp gjennom hele løpet"
    ]
  }
};

export const STARTUP_PLAN_STATES = {
  NO_PLAN_SELECTED: "no_plan_selected",
  PLAN_SELECTED: "plan_selected",
  PAYMENT_REQUIRED: "payment_required",
  PAYMENT_PENDING: "payment_pending",
  PAYMENT_CONFIRMED: "payment_confirmed",
  RAISE_FORM_UNLOCKED: "raise_form_unlocked"
};

export function getStartupPlanDefinition(planCode) {
  return STARTUP_PLAN_DEFINITIONS[String(planCode || "").toLowerCase()] || null;
}

export async function getCompanyForUser(userId) {
  const [rows] = await pool.query(
    `
    SELECT c.id AS company_id, c.company_name, c.orgnr
    FROM company_memberships cm
    JOIN companies c ON c.id = cm.company_id
    WHERE cm.user_id = ?
    LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
}

async function getActiveSubscription(companyId) {
  const [rows] = await pool.query(
    `
    SELECT s.*, d.code AS discount_code
    FROM startup_plan_subscriptions s
    LEFT JOIN startup_discount_codes d ON d.id = s.discount_code_id
    WHERE s.company_id = ?
      AND s.status = 'active'
      AND (s.expires_at IS NULL OR s.expires_at >= NOW())
    ORDER BY COALESCE(s.activated_at, s.created_at) DESC, s.id DESC
    LIMIT 1
    `,
    [companyId]
  );

  return rows[0] || null;
}

async function getPendingSubscription(companyId) {
  const [rows] = await pool.query(
    `
    SELECT s.*, d.code AS discount_code
    FROM startup_plan_subscriptions s
    LEFT JOIN startup_discount_codes d ON d.id = s.discount_code_id
    WHERE s.company_id = ?
      AND s.status IN ('payment_required', 'payment_pending')
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT 1
    `,
    [companyId]
  );

  return rows[0] || null;
}

function buildStartupPlanState({ company, activeSubscription, pendingSubscription }) {
  const activePlan = activeSubscription?.plan_code || null;
  const pendingPlan = pendingSubscription?.plan_code || null;
  const selectedPlan = pendingPlan || activePlan || null;

  let state = STARTUP_PLAN_STATES.NO_PLAN_SELECTED;
  if (activeSubscription) {
    state = STARTUP_PLAN_STATES.RAISE_FORM_UNLOCKED;
  } else if (pendingSubscription?.status === "payment_pending") {
    state = STARTUP_PLAN_STATES.PAYMENT_PENDING;
  } else if (pendingSubscription?.status === "payment_required") {
    state = STARTUP_PLAN_STATES.PAYMENT_REQUIRED;
  } else if (selectedPlan) {
    state = STARTUP_PLAN_STATES.PLAN_SELECTED;
  }

  return {
    company,
    state,
    selected_plan: selectedPlan,
    active_plan: activePlan,
    pending_plan: pendingPlan,
    payment_status: activeSubscription ? "confirmed" : pendingSubscription?.status || null,
    payment_confirmed: !!activeSubscription,
    raise_form_unlocked: !!activeSubscription,
    startup_has_basic_active: activePlan === "basic",
    startup_has_normal_active: activePlan === "normal",
    requires_normal_for_advanced_features: activePlan !== "normal",
    upgrade_required_state: activePlan === "basic" ? "upgrade_required" : null,
    upgrade_message: activePlan === "basic" ? "Denne funksjonen krever Normal-plan." : null,
    can_store_documents: activePlan === "normal",
    includes_conversion_package: activePlan === "normal",
    includes_follow_up: activePlan === "normal",
    includes_legal_help: activePlan === "normal",
    plan_options: STARTUP_PLAN_DEFINITIONS,
    active_subscription: activeSubscription,
    pending_subscription: pendingSubscription
  };
}

export async function getStartupPlanSummaryForUser(userId) {
  const company = await getCompanyForUser(userId);

  if (!company) {
    return buildStartupPlanState({
      company: null,
      activeSubscription: null,
      pendingSubscription: null
    });
  }

  const [activeSubscription, pendingSubscription] = await Promise.all([
    getActiveSubscription(company.company_id),
    getPendingSubscription(company.company_id)
  ]);

  return buildStartupPlanState({
    company,
    activeSubscription,
    pendingSubscription
  });
}

export async function canStartupCreateRaise(userId) {
  const summary = await getStartupPlanSummaryForUser(userId);
  return summary.raise_form_unlocked === true;
}
