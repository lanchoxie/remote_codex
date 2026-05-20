const fs = require('fs');
const path = require('path');
const { nowIso, makeId } = require('./protocol');

const DEFAULT_STORE_PATH = path.join(process.cwd(), 'tmp', 'connector-secrets.json');

function cleanString(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  return String(value).trim();
}

function cleanSecret(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  return String(value);
}

function normalizeConnectorSecretsInput(input = {}, existing = null) {
  const previous = existing || {};
  const now = nowIso();
  return {
    connectorId: cleanString(input.connectorId || previous.connectorId) || makeId(),
    gatewayPassword: cleanSecret(input.gatewayPassword || previous.gatewayPassword),
    targetPassword: cleanSecret(input.targetPassword || previous.targetPassword),
    createdAt: cleanString(previous.createdAt || input.createdAt) || now,
    updatedAt: now,
  };
}

function serializeConnectorSecrets(secret) {
  return {
    connectorId: secret.connectorId,
    gatewayPassword: secret.gatewayPassword || '',
    targetPassword: secret.targetPassword || '',
    createdAt: secret.createdAt || nowIso(),
    updatedAt: secret.updatedAt || nowIso(),
  };
}

function getConnectorSecretStatus(secret) {
  return {
    hasGatewayPassword: Boolean(secret?.gatewayPassword),
    hasTargetPassword: Boolean(secret?.targetPassword),
  };
}

function loadConnectorSecrets(storePath = DEFAULT_STORE_PATH) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.secrets)
      ? parsed.secrets
      : Array.isArray(parsed)
        ? parsed
        : [];
    const entries = list
      .map((item) => normalizeConnectorSecretsInput(item, item))
      .filter((item) => item.connectorId);
    return new Map(entries.map((item) => [item.connectorId, item]));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
}

function saveConnectorSecrets(secrets, storePath = DEFAULT_STORE_PATH) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const list = Array.from(secrets instanceof Map ? secrets.values() : Array.isArray(secrets) ? secrets : [])
    .map((item) => serializeConnectorSecrets(item))
    .filter((item) => item.connectorId);
  const payload = {
    savedAt: nowIso(),
    secrets: list,
  };
  fs.writeFileSync(storePath, JSON.stringify(payload, null, 2), 'utf8');
}

module.exports = {
  DEFAULT_STORE_PATH,
  getConnectorSecretStatus,
  loadConnectorSecrets,
  normalizeConnectorSecretsInput,
  saveConnectorSecrets,
};
