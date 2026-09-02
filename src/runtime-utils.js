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

function validTimeZone(value) {
  if (!value || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return 'UTC';
  }
}

function perHour(calls, timeZone) {
  const buckets = new Array(24).fill(0);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: validTimeZone(timeZone),
    hour: 'numeric',
    hourCycle: 'h23',
  });
  for (const call of calls) {
    const hourPart = formatter.formatToParts(new Date(call.deliveredAt))
      .find(part => part.type === 'hour');
    const hour = Number(hourPart?.value) % 24;
    if (Number.isInteger(hour)) buckets[hour] += 1;
  }
  return buckets;
}

module.exports = {
  boundedInt,
  fcmSafeTopic,
  usableTokenLifetimeMs,
  articleCacheKey,
  validTimeZone,
  perHour,
};
