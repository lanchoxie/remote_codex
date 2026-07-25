const crypto = require('crypto');

function boundedText(value, limit = 512) {
  return String(value || '').trim().slice(0, limit);
}

function leaseError(code, message, extra = {}) {
  return {
    ok: false,
    code,
    message,
    ...extra,
  };
}

class HostAgentLeaseRegistry {
  constructor(options = {}) {
    this.ttlMs = Math.max(1, Number(options.ttlMs || 30_000) || 30_000);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.makeLeaseId = typeof options.makeLeaseId === 'function'
      ? options.makeLeaseId
      : () => crypto.randomBytes(32).toString('base64url');
    this.leases = new Map();
  }

  current(hostId) {
    return this.leases.get(boundedText(hostId, 160)) || null;
  }

  delete(hostId) {
    return this.leases.delete(boundedText(hostId, 160));
  }

  deleteIfOwned(hostIdInput, agentInstanceIdInput) {
    const hostId = boundedText(hostIdInput, 160);
    const agentInstanceId = boundedText(agentInstanceIdInput);
    const existing = this.leases.get(hostId) || null;
    if (!existing || !agentInstanceId || existing.agentInstanceId !== agentInstanceId) {
      return false;
    }
    return this.leases.delete(hostId);
  }

  publicLease(lease) {
    if (!lease) return null;
    return {
      agentInstanceId: lease.agentInstanceId,
      leaseId: lease.leaseId,
      acquiredAt: lease.acquiredAt,
      renewedAt: lease.renewedAt,
      expiresAt: new Date(lease.renewedAtMs + this.ttlMs).toISOString(),
      ttlMs: this.ttlMs,
    };
  }

  isExpired(lease, nowMs = this.now()) {
    return !lease || nowMs - Number(lease.renewedAtMs || 0) >= this.ttlMs;
  }

  retryAfterMs(lease, nowMs = this.now()) {
    return Math.max(1, this.ttlMs - Math.max(0, nowMs - Number(lease?.renewedAtMs || 0)));
  }

  create(hostId, agentInstanceId, nowMs = this.now()) {
    const timestamp = new Date(nowMs).toISOString();
    const lease = {
      hostId,
      agentInstanceId,
      leaseId: this.makeLeaseId(),
      acquiredAt: timestamp,
      renewedAt: timestamp,
      renewedAtMs: nowMs,
      activeRequests: 0,
    };
    this.leases.set(hostId, lease);
    return lease;
  }

  renew(lease, nowMs = this.now()) {
    lease.renewedAtMs = nowMs;
    lease.renewedAt = new Date(nowMs).toISOString();
    return lease;
  }

  register(hostIdInput, agentInstanceIdInput) {
    const hostId = boundedText(hostIdInput, 160);
    const agentInstanceId = boundedText(agentInstanceIdInput);
    if (!hostId) {
      return leaseError('host_agent_host_required', 'hostId is required');
    }
    const existing = this.leases.get(hostId) || null;
    if (!agentInstanceId) {
      return existing
        ? leaseError(
          'host_agent_lease_required',
          `A versioned Host Agent lease is active for ${hostId}.`,
          { retryAfterMs: this.retryAfterMs(existing) }
        )
        : { ok: true, legacy: true, lease: null };
    }

    const nowMs = this.now();
    if (existing?.agentInstanceId === agentInstanceId) {
      return { ok: true, legacy: false, lease: this.renew(existing, nowMs), renewed: true };
    }
    if (existing && (!this.isExpired(existing, nowMs) || existing.activeRequests > 0)) {
      return leaseError(
        'host_agent_instance_conflict',
        `A different Host Agent instance is already active for ${hostId}.`,
        { retryAfterMs: this.retryAfterMs(existing, nowMs) }
      );
    }
    return {
      ok: true,
      legacy: false,
      lease: this.create(hostId, agentInstanceId, nowMs),
      replaced: Boolean(existing),
    };
  }

  heartbeat(hostIdInput, agentInstanceIdInput, leaseIdInput) {
    const hostId = boundedText(hostIdInput, 160);
    const agentInstanceId = boundedText(agentInstanceIdInput);
    const leaseId = boundedText(leaseIdInput);
    if (!hostId) {
      return leaseError('host_agent_host_required', 'hostId is required');
    }
    const existing = this.leases.get(hostId) || null;
    if (!agentInstanceId) {
      return existing
        ? leaseError('host_agent_lease_required', `A versioned Host Agent lease is active for ${hostId}.`)
        : { ok: true, legacy: true, lease: null };
    }
    if (!existing) {
      return {
        ok: true,
        legacy: false,
        lease: this.create(hostId, agentInstanceId),
        acquired: true,
      };
    }
    if (existing.agentInstanceId !== agentInstanceId || existing.leaseId !== leaseId) {
      return leaseError(
        'host_agent_lease_revoked',
        `Host Agent lease ownership was revoked for ${hostId}.`
      );
    }
    return { ok: true, legacy: false, lease: this.renew(existing), renewed: true };
  }

  release(hostIdInput, agentInstanceIdInput, leaseIdInput) {
    const hostId = boundedText(hostIdInput, 160);
    const agentInstanceId = boundedText(agentInstanceIdInput);
    const leaseId = boundedText(leaseIdInput);
    const existing = this.leases.get(hostId) || null;
    if (!existing) {
      return { ok: true, released: false };
    }
    if (existing.agentInstanceId !== agentInstanceId || existing.leaseId !== leaseId) {
      return leaseError(
        'host_agent_lease_revoked',
        `Host Agent lease ownership was revoked for ${hostId}.`
      );
    }
    this.leases.delete(hostId);
    return { ok: true, released: true };
  }

  authorize(hostIdInput, agentInstanceIdInput, leaseIdInput, options = {}) {
    const hostId = boundedText(hostIdInput, 160);
    const agentInstanceId = boundedText(agentInstanceIdInput);
    const leaseId = boundedText(leaseIdInput);
    if (!hostId) {
      return leaseError('host_agent_host_required', 'hostId is required');
    }
    const existing = this.leases.get(hostId) || null;
    if (!existing) {
      return agentInstanceId
        ? leaseError(
          'host_agent_registration_required',
          `Host Agent ${hostId} must register before using this endpoint.`
        )
        : { ok: true, legacy: true, lease: null, release: () => {} };
    }
    if (!agentInstanceId) {
      return leaseError(
        'host_agent_lease_required',
        `A versioned Host Agent lease is active for ${hostId}.`
      );
    }
    if (existing.agentInstanceId !== agentInstanceId || existing.leaseId !== leaseId) {
      return leaseError(
        'host_agent_lease_revoked',
        `Host Agent lease ownership was revoked for ${hostId}.`
      );
    }

    this.renew(existing);
    let released = false;
    if (options.hold === true) {
      existing.activeRequests += 1;
    }
    return {
      ok: true,
      legacy: false,
      lease: existing,
      release: () => {
        if (released) return;
        released = true;
        if (options.hold === true) {
          existing.activeRequests = Math.max(0, existing.activeRequests - 1);
        }
      },
    };
  }
}

module.exports = {
  HostAgentLeaseRegistry,
};
