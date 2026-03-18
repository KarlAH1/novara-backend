import { fetchBrregCompany, fetchBrregRoles } from "./brreg.js";

const normalizeName = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

const getTokens = (value) => normalizeName(value).split(" ").filter(Boolean);

const namesMatch = (inputName, roleName) => {
  const normalizedInput = normalizeName(inputName);
  const normalizedRole = normalizeName(roleName);

  if (!normalizedInput || !normalizedRole) {
    return false;
  }

  if (normalizedInput === normalizedRole) {
    return true;
  }

  const inputTokens = getTokens(inputName);
  const roleTokens = getTokens(roleName);
  const sharedTokens = inputTokens.filter((token) => roleTokens.includes(token));

  if (sharedTokens.length < 2) {
    return false;
  }

  return sharedTokens.length === inputTokens.length || sharedTokens.length === roleTokens.length;
};

export const checkCompanyRoleMatch = async ({ fullName, orgnr }) => {
  const company = await fetchBrregCompany(orgnr);
  const roles = await fetchBrregRoles(orgnr);

  const matchedRoles = roles.filter((entry) => namesMatch(fullName, entry.name));

  return {
    matched: matchedRoles.length > 0,
    company,
    roles,
    matchedRoles
  };
};
