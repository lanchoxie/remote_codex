const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { createSkillArtifactArchive } = require('../../shared/skill-artifact');

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_UPLOAD_RESPONSE_BYTES = 1024 * 1024;

function requiredText(value, name, maxLength = 8192) {
  const text = String(value == null ? '' : value).trim();
  if (!text) {
    throw new Error(`${name} is required`);
  }
  if (text.length > maxLength) {
    throw new Error(`${name} exceeds ${maxLength} characters`);
  }
  return text;
}

function normalizeHash(value, name) {
  const hash = requiredText(value, name, 96).toLowerCase();
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`${name} must be a sha256 digest`);
  }
  return hash;
}

function parseUploadResponse(buffer) {
  const text = buffer.toString('utf8').trim();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Relay returned invalid artifact upload JSON: ${error.message}`);
  }
}

function uploadArtifactFile(options) {
  const relayUrl = requiredText(options.relayUrl, 'relayUrl');
  const uploadPath = requiredText(options.uploadPath, 'uploadPath');
  if (!uploadPath.startsWith('/api/agent/skills/adoptions/')) {
    throw new Error('uploadPath must be a Relay skill adoption API path');
  }
  const target = new URL(uploadPath, relayUrl);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Relay artifact upload requires HTTP or HTTPS');
  }
  const archivePath = path.resolve(options.archivePath);
  const archiveBytes = fs.statSync(archivePath).size;
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const request = client.request({
      method: 'PUT',
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      headers: {
        'Content-Type': 'application/vnd.remote-codex.skill-artifact',
        'Content-Length': archiveBytes,
        'X-Remote-Codex-Upload-Token': requiredText(options.uploadToken, 'uploadToken'),
        'X-Remote-Codex-Host-Id': requiredText(options.hostId, 'hostId', 160),
        'X-Remote-Codex-Instance-Digest': crypto
          .createHash('sha256')
          .update(requiredText(options.instanceId, 'instanceId'))
          .digest('hex'),
        ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
      },
    }, (response) => {
      const chunks = [];
      let totalBytes = 0;
      response.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_UPLOAD_RESPONSE_BYTES) {
          request.destroy(new Error('Relay artifact upload response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        let body;
        try {
          body = parseUploadResponse(Buffer.concat(chunks));
        } catch (error) {
          finish(error);
          return;
        }
        const statusCode = response.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          finish(new Error(body.error || `Relay artifact upload failed with HTTP ${statusCode}`));
          return;
        }
        finish(null, body);
      });
      response.on('error', (error) => finish(error));
      response.on('aborted', () => finish(new Error('Relay artifact upload response was aborted')));
    });
    request.setTimeout(Number(options.timeoutMs || 120000), () => {
      request.destroy(new Error('Relay artifact upload timed out'));
    });
    request.on('error', (error) => finish(error));
    const input = fs.createReadStream(archivePath);
    input.on('error', (error) => request.destroy(error));
    input.pipe(request);
  });
}

class HostSkillArtifactService {
  constructor(options = {}) {
    this.hostId = requiredText(options.hostId, 'hostId', 160);
    if (!options.inventoryService || typeof options.inventoryService.refresh !== 'function') {
      throw new Error('inventoryService with refresh() is required');
    }
    this.inventoryService = options.inventoryService;
    this.relayUrl = options.relayUrl || '';
    this.authToken = options.authToken || '';
    this.tempRoot = path.resolve(
      options.tempRoot || path.join(os.tmpdir(), 'remote-codex-skill-artifacts')
    );
    this.upload = typeof options.upload === 'function' ? options.upload : uploadArtifactFile;
  }

  async exportInstance(command = {}) {
    const adoptionId = requiredText(command.adoptionId, 'adoptionId', 240);
    const instanceId = requiredText(command.instanceId, 'instanceId');
    const expectedHash = normalizeHash(command.expectedHash, 'expectedHash');
    const uploadPath = requiredText(command.uploadPath, 'uploadPath');
    const uploadToken = requiredText(command.uploadToken, 'uploadToken', 512);

    const refreshed = await this.inventoryService.refresh({ force: true });
    const snapshot = refreshed?.snapshot || refreshed;
    const matches = (Array.isArray(snapshot?.instances) ? snapshot.instances : [])
      .filter((instance) => instance?.instanceId === instanceId);
    if (matches.length !== 1) {
      throw new Error(matches.length
        ? `instanceId is ambiguous in the current inventory: ${instanceId}`
        : `instance not found in the current inventory: ${instanceId}`);
    }
    const instance = matches[0];
    if (instance.hostId && instance.hostId !== this.hostId) {
      throw new Error('inventory instance belongs to another Host');
    }
    const scope = String(instance.scope || '').trim().toLowerCase();
    if (instance.readonly || scope === 'plugin' || scope === 'system') {
      throw new Error(`${scope || 'readonly'} owned Skill instances cannot be adopted`);
    }
    const observedHash = normalizeHash(instance.observedHash, 'observedHash');
    if (observedHash !== expectedHash) {
      throw new Error(`Skill content changed since inventory refresh: expected ${expectedHash}, observed ${observedHash}`);
    }
    const skillPath = requiredText(instance.realPath || instance.activationPath, 'instance realPath');

    await fs.promises.mkdir(this.tempRoot, { recursive: true });
    const archivePath = path.join(
      this.tempRoot,
      `${crypto.randomBytes(16).toString('hex')}.rcskill`
    );
    try {
      const artifact = await createSkillArtifactArchive(skillPath, archivePath);
      if (artifact.contentHash !== expectedHash) {
        throw new Error(
          `Skill content changed while exporting: expected ${expectedHash}, archived ${artifact.contentHash}`
        );
      }
      const response = await this.upload({
        relayUrl: this.relayUrl,
        authToken: this.authToken,
        archivePath,
        archiveBytes: artifact.archiveBytes,
        uploadPath,
        uploadToken,
        hostId: this.hostId,
        adoptionId,
        instanceId,
      });
      if (response?.artifactId && response.artifactId !== artifact.artifactId) {
        throw new Error('Relay accepted a different artifactId than the exported content');
      }
      return {
        adoptionId,
        instanceId,
        artifactId: artifact.artifactId,
        archiveBytes: artifact.archiveBytes,
      };
    } finally {
      await fs.promises.unlink(archivePath).catch((error) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }
}

module.exports = {
  HostSkillArtifactService,
  uploadArtifactFile,
};
