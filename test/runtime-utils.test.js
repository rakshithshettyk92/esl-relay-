'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  boundedInt,
  fcmSafeTopic,
  usableTokenLifetimeMs,
  articleCacheKey,
} = require('../src/runtime-utils');

test('boundedInt applies defaults and clamps unsafe values', () => {
  assert.equal(boundedInt(undefined, 20, 1, 120), 20);
  assert.equal(boundedInt('-5', 20, 1, 120), 1);
  assert.equal(boundedInt('500', 20, 1, 120), 120);
});

test('fcmSafeTopic produces Firebase-compatible store topics', () => {
  assert.equal(fcmSafeTopic(['employee-calls', 'ACME US', 'Store/12']),
    'employee-calls-ACME_US-Store_12');
});

test('token buffer cannot consume a short token lifetime', () => {
  assert.equal(usableTokenLifetimeMs(120, 300), 60_000);
  assert.throws(() => usableTokenLifetimeMs(0, 300), /expires_in/);
});

test('article cache keys change when the requested mapping fields change', () => {
  const first = articleCacheKey('EVNT', 'NJS', 'ADI_01', {
    articleIdField: 'ARTICLE_ID',
    articleNameField: 'ITEM_NAME',
    helpEnabledField: 'ASSOCIATE_HELP_ENABLED',
  });
  const second = articleCacheKey('EVNT', 'NJS', 'ADI_01', {
    articleIdField: 'ARTICLE_ID',
    articleNameField: 'ITEM_NAME',
    helpEnabledField: 'EMPLOYEE_CALL',
  });

  assert.notEqual(first, second);
  assert.equal(first, articleCacheKey('EVNT', 'NJS', 'ADI_01', {
    articleIdField: 'ARTICLE_ID',
    articleNameField: 'ITEM_NAME',
    helpEnabledField: 'ASSOCIATE_HELP_ENABLED',
  }));
});
