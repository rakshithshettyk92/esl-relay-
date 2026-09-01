'use strict';

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function fcmSafeTopic(parts) {
  return parts.map(part => String(part).replace(/[^A-Za-z0-9_~.%-]/g, '_')).join('-');
}

function usableTokenLifetimeMs(expiresIn, bufferSeconds) {
  const lifetimeSeconds = Number(expiresIn);
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new Error('Login response did not include a valid expires_in value');
  }
  const safeBuffer = Math.min(bufferSeconds, Math.floor(lifetimeSeconds / 2));
  return Math.max(1, lifetimeSeconds - safeBuffer) * 1000;
}

function articleCacheKey(companyCode, storeCode, articleId, mapping = {}) {
  return JSON.stringify([
    companyCode,
    storeCode,
    articleId,
    mapping.articleIdField || '',
    mapping.articleNameField || '',
    mapping.helpEnabledField || '',
    mapping.aisleField || '',
  ]);
}

module.exports = { boundedInt, fcmSafeTopic, usableTokenLifetimeMs, articleCacheKey };
