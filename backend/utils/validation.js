export function sanitizeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

export function parseStudentId(value) {
  const normalized = Number(sanitizeString(value));
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return null;
  }
  return normalized;
}

export function getAuthRateLimitConfig(env = process.env) {
  const authMode = env.AUTH_MODE || (env.NODE_ENV === "production" ? "oidc" : "local");
  const localDevelopment = env.NODE_ENV !== "production" && authMode === "local";
  const readPositiveInteger = (name, fallback) => {
    const rawValue = env[name];
    if (rawValue === undefined || String(rawValue).trim() === "") return fallback;

    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
    return value;
  };

  return {
    windowMs: readPositiveInteger("AUTH_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
    max: readPositiveInteger("AUTH_RATE_LIMIT_MAX", localDevelopment ? 100 : 10)
  };
}

export function sanitizePublicItem(item) {
  if (!item) return null;
  const {
    reportedBy,
    identifyingMarks,
    serialNumber,
    verificationQuestion,
    verificationQuestions,
    privateImages,
    brand,
    model,
    accessories,
    physicalDamage,
    contactPhone,
    secretNotes,
    approvedClaimId,
    ...publicItem
  } = item;

  return {
    ...publicItem,
    // Provide a boolean flag indicating if verification challenges exist, without exposing answers
    hasVerificationDetails: Boolean(
      identifyingMarks ||
      serialNumber ||
      verificationQuestion ||
      (Array.isArray(verificationQuestions) && verificationQuestions.length > 0)
    )
  };
}

export function validateEnvironment(env = process.env) {
  const errors = [];

  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    errors.push("JWT_SECRET must be configured with a random secret of at least 32 characters.");
  }

  const authMode = env.AUTH_MODE || (env.NODE_ENV === "production" ? "oidc" : "local");
  if (!["local", "oidc"].includes(authMode)) {
    errors.push("AUTH_MODE must be either 'local' or 'oidc'.");
  }

  if (env.NODE_ENV === "production" && authMode !== "oidc") {
    errors.push("Production deployments must use AUTH_MODE=oidc for verified campus single sign-on.");
  }

  if (authMode === "oidc") {
    if (!env.OIDC_ISSUER) errors.push("OIDC_ISSUER is required when AUTH_MODE=oidc.");
    if (!env.OIDC_CLIENT_ID) errors.push("OIDC_CLIENT_ID is required when AUTH_MODE=oidc.");
    if (!env.OIDC_CLIENT_SECRET) errors.push("OIDC_CLIENT_SECRET is required when AUTH_MODE=oidc.");
    if (!env.OIDC_REDIRECT_URI) errors.push("OIDC_REDIRECT_URI is required when AUTH_MODE=oidc.");
  }

  const port = Number(env.PORT || 5000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    errors.push("PORT must be a valid port number between 1 and 65535.");
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}
