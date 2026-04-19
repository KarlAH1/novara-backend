import pool from "../config/db.js";

export const STARTUP_PLAN_DEFINITIONS = {
  normal: {
    code: "normal",
    name: "Normal",
    annual_price_nok: 2000,
    available: true,
    features: [
      "Full dokumentflyt i Raisium",
      "Dokumentlagring",
      "Dokumentproduksjon",
      "Konverteringspakke",
      "Oppfolging av status og dokumentflyt",
      "Assistanse ved spørsmål"
    ],
    includes_document_storage: true,
    includes_conversion_package: true,
    includes_follow_up: true,
    includes_legal_help: true
  },
  pro: {
    code: "pro",
    name: "Pro",
    annual_price_nok: 4000,
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
  const hasFullPlan = activePlan === "normal" || activePlan === "pro";

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
    startup_has_normal_active: activePlan === "normal",
    requires_normal_for_advanced_features: !hasFullPlan,
    upgrade_required_state: null,
    upgrade_message: null,
    can_store_documents: hasFullPlan,
    includes_conversion_package: hasFullPlan,
    includes_follow_up: hasFullPlan,
    includes_legal_help: hasFullPlan,
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
