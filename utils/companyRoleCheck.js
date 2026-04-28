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

const tokensMatchAsInitialOrExact = (left, right) => {
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  if (left.length === 1 && right.startsWith(left)) {
    return true;
  }

  if (right.length === 1 && left.startsWith(right)) {
    return true;
  }

  return false;
};

const tokenSetContained = (leftTokens, rightTokens) =>
  leftTokens.every((left) => rightTokens.some((right) => tokensMatchAsInitialOrExact(left, right)));

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
  const inputFirstName = inputTokens[0] || "";
  const roleFirstName = roleTokens[0] || "";
  const inputLastName = inputTokens[inputTokens.length - 1] || "";
  const roleLastName = roleTokens[roleTokens.length - 1] || "";
  const inputGivenNames = inputTokens.slice(0, -1);
  const roleGivenNames = roleTokens.slice(0, -1);
  const lastNameMatches = inputLastName === roleLastName;
  const firstNameMatches = tokensMatchAsInitialOrExact(inputFirstName, roleFirstName);

  if (!lastNameMatches || !firstNameMatches) {
    return false;
  }

  if (inputTokens.length <= 2 || roleTokens.length <= 2) {
    return true;
  }

  if (sharedTokens.length >= 2) {
    return (
      sharedTokens.length === inputTokens.length ||
      sharedTokens.length === roleTokens.length
    );
  }

  return (
    tokenSetContained(inputGivenNames, roleGivenNames) ||
    tokenSetContained(roleGivenNames, inputGivenNames)
  );
};

export const checkCompanyRoleMatch = async ({ fullName, orgnr }) => {
  const [company, roles] = await Promise.all([
    fetchBrregCompany(orgnr),
    fetchBrregRoles(orgnr)
  ]);

  const matchedRoles = roles.filter((entry) => namesMatch(fullName, entry.name));

  return {
    matched: matchedRoles.length > 0,
    company,
    roles,
    matchedRoles
  };
};
