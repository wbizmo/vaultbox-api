function parseInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getConfig() {
  const nodeEnv = process.env.NODE_ENV || "development";

  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    port: parseInteger(process.env.PORT, 4000, { min: 1, max: 65535 }),
    jwtSecret: process.env.JWT_SECRET || "",
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
    databaseUrl: process.env.DATABASE_URL || "",
    appUrl: process.env.APP_URL || "http://localhost:4000",
    corsOrigins: parseList(process.env.CORS_ORIGINS),
    maxUploadBytes: parseInteger(process.env.MAX_UPLOAD_BYTES, 100 * 1024 * 1024, {
      min: 1024,
      max: 10 * 1024 * 1024 * 1024
    }),
    downloadTokenExpiresMinutes: parseInteger(process.env.DOWNLOAD_TOKEN_EXPIRES_MINUTES, 15, {
      min: 1,
      max: 1440
    }),
    downloadMaxRanges: parseInteger(process.env.DOWNLOAD_MAX_RANGES, 8, { min: 1, max: 32 }),
    downloadSuggestedPartBytes: parseInteger(process.env.DOWNLOAD_SUGGESTED_PART_BYTES, 8 * 1024 * 1024, {
      min: 256 * 1024,
      max: 128 * 1024 * 1024
    })
  };
}

function assertRuntimeConfig(config = getConfig()) {
  const errors = [];

  if (!config.databaseUrl) {
    errors.push("DATABASE_URL is required");
  }

  if (!config.jwtSecret) {
    errors.push("JWT_SECRET is required");
  } else if (config.isProduction && config.jwtSecret.length < 32) {
    errors.push("JWT_SECRET must be at least 32 characters in production");
  }

  if (errors.length > 0) {
    const error = new Error(`Invalid runtime configuration: ${errors.join("; ")}`);
    error.code = "INVALID_RUNTIME_CONFIGURATION";
    throw error;
  }

  return config;
}

module.exports = {
  getConfig,
  assertRuntimeConfig,
  parseInteger,
  parseList
};
