(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexSessionWatch = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeTarget(input = {}) {
    const hostId = text(input.hostId);
    const sessionId = text(input.sessionId);
    if (!hostId || !sessionId) {
      return null;
    }
    return {
      hostId,
      sessionId,
      nativeThreadId: text(input.nativeThreadId) || null,
      bridgeSessionId: text(input.bridgeSessionId) || null,
      originSessionId: text(input.originSessionId) || null,
      sourceSessionId: text(input.sourceSessionId) || null,
      conversationKey: text(input.conversationKey) || null,
    };
  }

  function targetKey(target) {
    return target?.hostId && target?.sessionId ? `${target.hostId}::${target.sessionId}` : '';
  }

  function targetSignature(target) {
    return target ? JSON.stringify(target) : '';
  }

  class SelectedSessionWatchController {
    constructor(options = {}) {
      if (typeof options.sendWatch !== 'function' || typeof options.sendUnwatch !== 'function') {
        throw new TypeError('sendWatch and sendUnwatch are required');
      }
      this.clientId = text(options.clientId);
      this.viewId = text(options.viewId) || 'primary';
      this.sendWatch = options.sendWatch;
      this.sendUnwatch = options.sendUnwatch;
      this.supportsAtomicReplace = typeof options.supportsAtomicReplace === 'function'
        ? options.supportsAtomicReplace
        : () => true;
      this.onError = typeof options.onError === 'function' ? options.onError : () => {};
      this.now = typeof options.now === 'function' ? options.now : Date.now;
      this.renewAfterMs = Math.max(1_000, Number(options.renewAfterMs) || 20_000);
      this.desired = null;
      this.confirmed = null;
      this.confirmedByHost = new Map();
      this.revision = 0;
      this.lastRenewedAt = 0;
      this.reconcilePromise = null;
      this.reconcileRequested = false;
      this.forceRequested = false;
      this.silentRequested = true;
    }

    get desiredKey() {
      return targetKey(this.desired);
    }

    get confirmedKey() {
      return targetKey(this.confirmed);
    }

    select(input, options = {}) {
      const target = normalizeTarget(input);
      if (!target) {
        return this.clear(options);
      }
      const changed = targetSignature(target) !== targetSignature(this.desired);
      this.desired = target;
      const due = this.confirmedKey === targetKey(target)
        && this.now() - this.lastRenewedAt >= this.renewAfterMs;
      const staleHostLease = Array.from(this.confirmedByHost.keys())
        .some((hostId) => hostId !== target.hostId);
      if (
        changed
        || this.confirmedKey !== targetKey(target)
        || staleHostLease
        || options.force === true
        || due
      ) {
        return this.requestReconcile({
          force: options.force === true || due,
          silent: options.silent === true,
        });
      }
      return this.reconcilePromise || Promise.resolve();
    }

    renewIfDue(input) {
      return this.select(input, { silent: true });
    }

    clear(options = {}) {
      this.desired = null;
      if (!this.confirmedByHost.size && !this.reconcilePromise) {
        return Promise.resolve();
      }
      return this.requestReconcile({ force: true, silent: options.silent === true });
    }

    releaseNow(options = {}) {
      const targets = new Map(this.confirmedByHost);
      if (this.desired) {
        targets.set(this.desired.hostId, this.desired);
      }
      this.desired = null;
      this.confirmed = null;
      this.confirmedByHost.clear();
      this.lastRenewedAt = 0;
      if (!targets.size) {
        return Promise.resolve();
      }
      const revision = this.nextRevision();
      return Promise.all(Array.from(targets.values(), (target) => {
        const request = {
          ...target,
          clientId: this.clientId,
          viewId: this.viewId,
          watchRevision: revision,
          keepalive: options.keepalive === true,
        };
        return Promise.resolve(this.sendUnwatch(request)).catch((error) => {
          this.reportError(error, target, 'unwatch', options.silent === true);
        });
      })).then(() => undefined);
    }

    requestReconcile(options = {}) {
      this.reconcileRequested = true;
      this.forceRequested = this.forceRequested || options.force === true;
      this.silentRequested = this.silentRequested && options.silent === true;
      if (!this.reconcilePromise) {
        this.reconcilePromise = Promise.resolve()
          .then(() => this.drain())
          .finally(() => {
            this.reconcilePromise = null;
            if (this.reconcileRequested) {
              this.requestReconcile({
                force: this.forceRequested,
                silent: this.silentRequested,
              });
            }
          });
      }
      return this.reconcilePromise;
    }

    async drain() {
      while (this.reconcileRequested) {
        const force = this.forceRequested;
        const silent = this.silentRequested;
        this.reconcileRequested = false;
        this.forceRequested = false;
        this.silentRequested = true;
        try {
          await this.reconcileOnce({ force });
        } catch (error) {
          this.reportError(error, this.desired || this.confirmed, 'watch', silent);
        }
      }
    }

    async reconcileOnce(options = {}) {
      const target = this.desired;
      if (!target) {
        const confirmed = Array.from(this.confirmedByHost.entries());
        if (!confirmed.length) {
          return;
        }
        const revision = this.nextRevision();
        const failures = [];
        for (const [hostId, confirmedTarget] of confirmed) {
          try {
            await this.sendUnwatch({
              ...confirmedTarget,
              clientId: this.clientId,
              viewId: this.viewId,
              watchRevision: revision,
              keepalive: false,
            });
            if (
              revision === this.revision
              && targetKey(this.confirmedByHost.get(hostId)) === targetKey(confirmedTarget)
            ) {
              this.confirmedByHost.delete(hostId);
            }
          } catch (error) {
            failures.push(error);
          }
        }
        if (revision === this.revision && !this.desired && !this.confirmedByHost.size) {
          this.confirmed = null;
          this.lastRenewedAt = 0;
        }
        if (failures.length) {
          throw failures[0];
        }
        return;
      }

      const sameTarget = targetSignature(this.confirmed) === targetSignature(target);
      const renewalDue = this.now() - this.lastRenewedAt >= this.renewAfterMs;
      const staleHostLeases = Array.from(this.confirmedByHost.entries())
        .filter(([hostId]) => hostId !== target.hostId);
      const sameHostLease = this.confirmedByHost.get(target.hostId) || null;
      const legacyReplacement = Boolean(
        sameHostLease
        && targetSignature(sameHostLease) !== targetSignature(target)
        && !this.supportsAtomicReplace(target)
      );
      let revision = this.revision;
      if (legacyReplacement) {
        revision = this.nextRevision();
        await this.sendUnwatch({
          ...sameHostLease,
          clientId: this.clientId,
          viewId: this.viewId,
          watchRevision: revision,
          keepalive: false,
        });
        if (revision !== this.revision) {
          return;
        }
        if (targetKey(this.confirmedByHost.get(target.hostId)) === targetKey(sameHostLease)) {
          this.confirmedByHost.delete(target.hostId);
        }
        if (targetSignature(this.confirmed) === targetSignature(sameHostLease)) {
          this.confirmed = null;
        }
        if (targetSignature(this.desired) !== targetSignature(target)) {
          return;
        }
      }
      if (!sameTarget || options.force === true || renewalDue) {
        revision = this.nextRevision();
        await this.sendWatch({
          ...target,
          clientId: this.clientId,
          viewId: this.viewId,
          watchRevision: revision,
        });
        if (revision !== this.revision) {
          return;
        }
        this.confirmed = target;
        this.confirmedByHost.set(target.hostId, target);
        this.lastRenewedAt = this.now();
      } else if (staleHostLeases.length) {
        revision = this.nextRevision();
      }

      const failures = [];
      for (const [hostId, staleTarget] of staleHostLeases) {
        try {
          await this.sendUnwatch({
            ...staleTarget,
            clientId: this.clientId,
            viewId: this.viewId,
            watchRevision: revision,
            keepalive: false,
          });
          if (
            revision === this.revision
            && targetKey(this.confirmedByHost.get(hostId)) === targetKey(staleTarget)
          ) {
            this.confirmedByHost.delete(hostId);
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw failures[0];
      }
    }

    nextRevision() {
      this.revision += 1;
      return this.revision;
    }

    reportError(error, target, operation, silent) {
      if (!silent) {
        this.onError(error, target, operation);
      }
    }
  }

  function createSelectedSessionWatchController(options) {
    return new SelectedSessionWatchController(options);
  }

  return {
    SelectedSessionWatchController,
    createSelectedSessionWatchController,
    normalizeTarget,
    targetKey,
  };
}));
