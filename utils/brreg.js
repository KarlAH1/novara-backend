import { isValidOrgnr, normalizeOrgnr } from "./orgnr.js";

const BRREG_BASE_URL = "https://data.brreg.no/enhetsregisteret/api/enheter";
const BRREG_ROLES_BASE_URL = "https://data.brreg.no/enhetsregisteret/api/enheter";

const toAddressLabel = (address) => {
  if (!address || typeof address !== "object") {
    return null;
  }

  const lines = Array.isArray(address.adresse) ? address.adresse.filter(Boolean) : [];
  const postal = [address.postnummer, address.poststed].filter(Boolean).join(" ");

  return [...lines, postal, address.land].filter(Boolean).join(", ") || null;
};

const fetchBrregJson = async (url, notFoundMessage) => {
  let response;

  try {
    response = await fetch(url);
  } catch (err) {
    const error = new Error("Brønnøysund er utilgjengelig akkurat nå");
    error.status = 502;
    throw error;
  }

  if (response.status === 404) {
    const error = new Error(notFoundMessage);
    error.status = 404;
    throw error;
  }

  if (!response.ok) {
    const error = new Error("Klarte ikke hente data fra Brønnøysund");
    error.status = 502;
    throw error;
  }

  return response.json();
};

export const fetchBrregCompany = async (rawOrgnr) => {
  const orgnr = normalizeOrgnr(rawOrgnr);

  if (!isValidOrgnr(orgnr)) {
    const error = new Error("Ugyldig organisasjonsnummer");
    error.status = 400;
    throw error;
  }

  const data = await fetchBrregJson(
    `${BRREG_BASE_URL}/${orgnr}`,
    "Fant ikke selskap i Brønnøysund"
  );

  return {
    orgnr,
    name: data.navn,
    form: data.organisasjonsform?.kode || null,
    formDescription: data.organisasjonsform?.beskrivelse || null,
    status: data.konkurs ? "Konkurs" : (data.slettedato ? "Slettet" : "Aktiv"),
    address: toAddressLabel(data.forretningsadresse || data.postadresse),
    hasRegisteredSignature: typeof data.harRegistrertSignatur === "boolean"
      ? data.harRegistrertSignatur
      : null,
    hasRegisteredProkura: typeof data.harRegistrertProkura === "boolean"
      ? data.harRegistrertProkura
      : null
  };
};

const getPersonName = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (typeof value === "object") {
    const name = [value.fornavn, value.mellomnavn, value.etternavn]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ");

    return name || null;
  }

  return null;
};

const getRoleLabel = (value) => {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value.type?.beskrivelse ||
    value.type?.kode ||
    value.rolle?.beskrivelse ||
    value.rolle?.kode ||
    value.rollegruppe?.beskrivelse ||
    value.rollegruppe?.kode ||
    null;
};

const collectRoleEntries = (node, bucket, context = {}) => {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item) => collectRoleEntries(item, bucket, context));
    return;
  }

  if (typeof node !== "object") {
    return;
  }

  const personName =
    getPersonName(node.navn) ||
    getPersonName(node.person) ||
    context.personName ||
    null;

  const roleLabel = getRoleLabel(node) || context.roleLabel || null;
  const isInactive = node.fratraadt === true || node.avregistrert === true;

  if (Array.isArray(node.roller) && personName) {
    node.roller.forEach((role) => {
      const nestedRoleLabel = getRoleLabel(role) || roleLabel;

      if (nestedRoleLabel && role?.fratraadt !== true && role?.avregistrert !== true) {
        bucket.push({
          name: personName,
          role: nestedRoleLabel
        });
      }

      collectRoleEntries(role, bucket, {
        personName,
        roleLabel: nestedRoleLabel
      });
    });
  } else if (personName && roleLabel && !isInactive) {
    bucket.push({
      name: personName,
      role: roleLabel
    });
  }

  Object.values(node).forEach((value) => {
    if (value !== node.roller) {
      collectRoleEntries(value, bucket, { personName, roleLabel });
    }
  });
};

export const fetchBrregRoles = async (rawOrgnr) => {
  const orgnr = normalizeOrgnr(rawOrgnr);

  if (!isValidOrgnr(orgnr)) {
    const error = new Error("Ugyldig organisasjonsnummer");
    error.status = 400;
    throw error;
  }

  const data = await fetchBrregJson(
    `${BRREG_ROLES_BASE_URL}/${orgnr}/roller`,
    "Fant ikke roller i Brønnøysund"
  );

  const roles = [];

  if (Array.isArray(data.rollegrupper)) {
    data.rollegrupper.forEach((group) => {
      const groupRoles = Array.isArray(group?.roller) ? group.roller : [];

      groupRoles.forEach((role) => {
        const personName = getPersonName(role?.person?.navn) || getPersonName(role?.person);
        const roleLabel = getRoleLabel(role) || getRoleLabel(group);

        if (personName && roleLabel && role?.fratraadt !== true && role?.avregistrert !== true) {
          roles.push({
            name: personName,
            role: roleLabel
          });
        }
      });
    });
  }

  if (roles.length === 0) {
    collectRoleEntries(data, roles);
  }

  const deduped = Array.from(
    new Map(
      roles
        .filter((entry) => entry.name && entry.role)
        .map((entry) => [`${entry.name}::${entry.role}`, entry])
    ).values()
  );

  return deduped;
};
