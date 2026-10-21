/*
  Switches for features that depend on outside agreements (Vipps, BankID).
  A feature is on only when its switch is set AND its keys are present, so
  setting the switch without keys never shows a button that cannot work.

  FEATURE_VIPPS_LOGIN=1    + VIPPS_LOGIN_CLIENT_ID, VIPPS_LOGIN_CLIENT_SECRET
  FEATURE_VIPPS_PAYMENT=1  + VIPPS_CLIENT_ID, VIPPS_CLIENT_SECRET,
                             VIPPS_SUBSCRIPTION_KEY (partner keys)
  VIPPS_ENV=test|production (default test)
*/

function envOn(name) {
  return ["1", "true", "on", "yes"].includes(String(process.env[name] || "").trim().toLowerCase());
}

function hasEnv(...names) {
  return names.every((name) => String(process.env[name] || "").trim());
}

export function vippsLoginEnabled() {
  return envOn("FEATURE_VIPPS_LOGIN") && hasEnv("VIPPS_LOGIN_CLIENT_ID", "VIPPS_LOGIN_CLIENT_SECRET");
}

export function vippsPaymentEnabled() {
  return envOn("FEATURE_VIPPS_PAYMENT") && hasEnv("VIPPS_CLIENT_ID", "VIPPS_CLIENT_SECRET", "VIPPS_SUBSCRIPTION_KEY");
}

export function vippsApiBase() {
  return String(process.env.VIPPS_ENV || "test").toLowerCase() === "production"
    ? "https://api.vipps.no"
    : "https://apitest.vipps.no";
}

// What the browser may know: which buttons to show, nothing secret.
export function publicFeatureFlags() {
  return {
    vippsLogin: vippsLoginEnabled(),
    vippsPayment: vippsPaymentEnabled()
  };
}
