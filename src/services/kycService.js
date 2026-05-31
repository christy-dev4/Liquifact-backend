'use strict';

/**
 * KYC Service
 *
 * Verifies SME identity via an external KYC provider and persists results
 * to the kyc_records table so status survives restarts.
 *
 * Fail-closed: any provider error leaves the status as 'pending'.
 *
 * @module services/kycService
 */

const logger = require('../logger');
const appConfig = require('../config');
const db = require('../db/knex');

const KYC_STATUSES = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  EXEMPTED: 'exempted',
};

/**
 * Returns KYC provider config from validated app config or process.env fallback
 * (the fallback keeps unit tests that skip validate() working).
 */
function getKycProviderConfig() {
  let cfg;
  try {
    cfg = appConfig.get();
  } catch {
    cfg = process.env;
  }
  const apiKey = cfg.KYC_PROVIDER_API_KEY || null;
  const baseUrl = cfg.KYC_PROVIDER_URL || null;
  return {
    enabled: !!(apiKey && baseUrl),
    apiKey,
    baseUrl,
    apiSecret: cfg.KYC_PROVIDER_SECRET || null,
  };
}

/**
 * Calls the external KYC provider to verify an SME.
 *
 * POST {baseUrl}/verify
 * Authorization: Bearer {apiKey}
 * Body: { smeId, ...smeData }
 *
 * Expected response: { status, recordId, verifiedAt }
 *
 * @param {string} smeId
 * @param {Object} smeData
 * @returns {Promise<{status: string, recordId: string, verifiedAt: string|null}>}
 */
async function verifyWithExternalProvider(smeId, smeData = {}) {
  const config = getKycProviderConfig();

  if (!config.enabled) {
    throw new Error('KYC provider not configured');
  }

  const url = `${config.baseUrl}/verify`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      ...(config.apiSecret ? { 'X-KYC-Secret': config.apiSecret } : {}),
    },
    body: JSON.stringify({ smeId, ...smeData }),
  });

  if (!response.ok) {
    throw new Error(`KYC provider returned ${response.status}`);
  }

  const body = await response.json();

  return {
    status: body.status || KYC_STATUSES.PENDING,
    recordId: body.recordId || null,
    verifiedAt: body.verifiedAt || null,
  };
}

/**
 * Persists (upserts) a KYC result to the database.
 *
 * @param {string} smeId
 * @param {{status: string, recordId: string|null, verifiedAt: string|null}} result
 */
async function persistKycRecord(smeId, result) {
  const row = {
    sme_id: smeId,
    status: result.status,
    provider_record_id: result.recordId || null,
    verified_at: result.verifiedAt ? new Date(result.verifiedAt) : null,
    updated_at: new Date(),
  };

  const existing = await db('kyc_records').where({ sme_id: smeId }).first();

  if (existing) {
    await db('kyc_records').where({ sme_id: smeId }).update(row);
  } else {
    await db('kyc_records').insert(row);
  }
}

/**
 * Reads a persisted KYC record from the database.
 *
 * @param {string} smeId
 * @returns {Promise<{status: string, recordId: string|null, verifiedAt: string|null}|null>}
 */
async function readKycRecord(smeId) {
  const row = await db('kyc_records').where({ sme_id: smeId }).first();
  if (!row) return null;
  return {
    status: row.status,
    recordId: row.provider_record_id || null,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
  };
}

/**
 * Returns the current KYC status for an SME.
 *
 * Flow:
 *  1. If provider is configured, call it and persist the result.
 *  2. On provider error, log and fall back to the last persisted record.
 *  3. If no record exists, return pending (fail-closed).
 *
 * @param {string} smeId
 * @returns {Promise<{status: string, recordId?: string, verifiedAt?: string}>}
 */
async function getKycStatus(smeId) {
  if (!smeId || typeof smeId !== 'string') {
    throw new Error('Invalid SME ID');
  }

  const config = getKycProviderConfig();

  if (config.enabled) {
    try {
      const result = await verifyWithExternalProvider(smeId, {});
      await persistKycRecord(smeId, result);
      logger.info({ smeId, status: result.status }, 'KYC status refreshed from provider');
      return result;
    } catch (err) {
      // Log without leaking the API key
      logger.warn(
        { smeId, error: err.message, provider: config.baseUrl },
        'KYC provider call failed — falling back to persisted record'
      );
    }
  }

  // Fall back to DB
  const persisted = await readKycRecord(smeId);
  if (persisted) return persisted;

  return { status: KYC_STATUSES.PENDING };
}

/**
 * Returns true only for statuses that permit capital transfer.
 *
 * @param {string} kycStatus
 * @returns {boolean}
 */
function canFundWithKycStatus(kycStatus) {
  return kycStatus === KYC_STATUSES.VERIFIED || kycStatus === KYC_STATUSES.EXEMPTED;
}

module.exports = {
  KYC_STATUSES,
  getKycStatus,
  canFundWithKycStatus,
  getKycProviderConfig,
  // Exported for testing
  verifyWithExternalProvider,
  persistKycRecord,
  readKycRecord,
};
