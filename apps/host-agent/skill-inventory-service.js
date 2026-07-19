const fs = require('fs');
const path = require('path');
const {
  computeSkillInventoryRevision,
  discoverSkillInventory,
} = require('../../shared/skill-inventory');

const DEFAULT_REFRESH_INTERVAL_MS = 30000;
const DEFAULT_WATCH_DEBOUNCE_MS = 500;

function pathKey(value) {
  const resolved = path.resolve(String(value || '').trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function cloneSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }
  return {
    revision: snapshot.revision || null,
    scannedAt: snapshot.scannedAt || null,
    instances: (Array.isArray(snapshot.instances) ? snapshot.instances : []).map((item) => ({ ...item })),
    scanErrors: (Array.isArray(snapshot.scanErrors) ? snapshot.scanErrors : []).map((item) => ({ ...item })),
  };
}

class HostSkillInventoryService {
  constructor(options = {}) {
    this.hostId = String(options.hostId || '').trim();
    if (!this.hostId) {
      throw new Error('hostId is required');
    }
    this.codexHome = options.codexHome || null;
    this.agentsHome = options.agentsHome || null;
    this.ccSwitchHome = options.ccSwitchHome || null;
    this.pluginRoots = Array.isArray(options.pluginRoots) ? options.pluginRoots.filter(Boolean).slice() : [];
    this.scan = typeof options.scan === 'function' ? options.scan : discoverSkillInventory;
    this.transformSnapshot = typeof options.transformSnapshot === 'function'
      ? options.transformSnapshot
      : null;
    this.publish = typeof options.publish === 'function' ? options.publish : async () => {};
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    this.refreshIntervalMs = Number.isFinite(options.refreshIntervalMs)
      ? Math.max(1, options.refreshIntervalMs)
      : DEFAULT_REFRESH_INTERVAL_MS;
    this.watchDebounceMs = Number.isFinite(options.watchDebounceMs)
      ? Math.max(1, options.watchDebounceMs)
      : DEFAULT_WATCH_DEBOUNCE_MS;

    this.workspaceRoots = [];
    this.workspaceRootKeys = new Set();
    this.currentSnapshot = null;
    this.lastPublishedRevision = null;
    this.started = false;
    this.dirty = true;
    this.invalidationVersion = 0;
    this.activeInvalidationVersion = -1;
    this.refreshPromise = null;
    this.queueAnotherScan = false;
    this.publishCurrentScan = false;
    this.publishCurrentContext = null;
    this.queuedPublishUnchanged = false;
    this.queuedPublishContext = null;
    this.watchers = new Map();
    this.watchTimer = null;
    this.periodicTimer = null;
    this.addWorkspaceRoots(options.workspaceRoots || []);
  }

  addWorkspaceRoots(roots) {
    let added = 0;
    for (const value of Array.isArray(roots) ? roots : []) {
      const root = String(value || '').trim();
      if (!root) {
        continue;
      }
      const key = pathKey(root);
      if (this.workspaceRootKeys.has(key)) {
        continue;
      }
      this.workspaceRootKeys.add(key);
      this.workspaceRoots.push(root);
      added += 1;
      if (this.started) {
        this.watchRoot(path.join(root, '.agents', 'skills'));
      }
    }
    if (added) {
      this.invalidate();
    }
    return added;
  }

  getWorkspaceRoots() {
    return this.workspaceRoots.slice();
  }

  snapshot() {
    return cloneSnapshot(this.currentSnapshot);
  }

  invalidate() {
    this.dirty = true;
    this.invalidationVersion += 1;
    if (this.refreshPromise && this.invalidationVersion !== this.activeInvalidationVersion) {
      this.queueAnotherScan = true;
    }
  }

  refresh(options = {}) {
    if (this.refreshPromise) {
      if (options.publishUnchanged) {
        this.queuedPublishUnchanged = true;
        this.queuedPublishContext = options.publishContext || null;
        this.queueAnotherScan = true;
      }
      if (this.invalidationVersion !== this.activeInvalidationVersion) {
        this.queueAnotherScan = true;
      }
      return this.refreshPromise;
    }

    const initialOptions = {
      force: Boolean(options.force),
      publishUnchanged: Boolean(options.publishUnchanged),
      publishContext: options.publishContext || null,
    };
    this.refreshPromise = this.runRefreshes(initialOptions).finally(() => {
      this.refreshPromise = null;
      this.queueAnotherScan = false;
      this.publishCurrentScan = false;
      this.publishCurrentContext = null;
      this.queuedPublishUnchanged = false;
      this.queuedPublishContext = null;
    });
    return this.refreshPromise;
  }

  async runRefreshes(initialOptions) {
    let options = initialOptions;
    let result = null;
    let needsAnotherScan = false;
    do {
      this.queueAnotherScan = false;
      this.publishCurrentScan = Boolean(options.publishUnchanged);
      this.publishCurrentContext = options.publishContext || null;
      this.activeInvalidationVersion = this.invalidationVersion;
      result = await this.performRefresh(options);
      const queuedPublishUnchanged = this.queuedPublishUnchanged;
      const queuedPublishContext = this.queuedPublishContext;
      this.queuedPublishUnchanged = false;
      this.queuedPublishContext = null;
      needsAnotherScan = this.queueAnotherScan
        || this.invalidationVersion !== this.activeInvalidationVersion
        || queuedPublishUnchanged;
      options = {
        force: true,
        publishUnchanged: queuedPublishUnchanged,
        publishContext: queuedPublishContext,
      };
    } while (needsAnotherScan);
    return result;
  }

  async performRefresh(options) {
    if (!options.force && !this.dirty && this.currentSnapshot) {
      const snapshot = this.snapshot();
      let published = false;
      if (options.publishUnchanged || this.publishCurrentScan) {
        await this.publish(snapshot, this.publishCurrentContext);
        this.lastPublishedRevision = snapshot.revision;
        published = true;
      }
      return { changed: false, published, snapshot };
    }

    const scanVersion = this.activeInvalidationVersion;
    const scannedSnapshot = await this.scan({
      hostId: this.hostId,
      codexHome: this.codexHome,
      agentsHome: this.agentsHome,
      ccSwitchHome: this.ccSwitchHome,
      pluginRoots: this.pluginRoots.slice(),
      workspaceRoots: this.getWorkspaceRoots(),
      scannedAt: this.now(),
    });
    if (!scannedSnapshot || typeof scannedSnapshot !== 'object' || !String(scannedSnapshot.revision || '').startsWith('sha256:')) {
      throw new Error('skill inventory scan returned an invalid snapshot');
    }
    let snapshot = cloneSnapshot(scannedSnapshot);
    if (this.transformSnapshot) {
      snapshot = cloneSnapshot(await this.transformSnapshot(snapshot));
      if (!snapshot) {
        throw new Error('skill inventory transform returned an invalid snapshot');
      }
      snapshot.revision = computeSkillInventoryRevision(snapshot.instances);
    }

    const previousRevision = this.currentSnapshot?.revision || null;
    const changed = previousRevision !== snapshot.revision;
    this.currentSnapshot = cloneSnapshot(snapshot);
    this.dirty = this.invalidationVersion !== scanVersion;
    const shouldPublish = changed
      || this.lastPublishedRevision !== snapshot.revision
      || options.publishUnchanged
      || this.publishCurrentScan;
    if (shouldPublish) {
      await this.publish(this.snapshot(), this.publishCurrentContext);
      this.lastPublishedRevision = snapshot.revision;
    }
    return {
      changed,
      published: shouldPublish,
      snapshot: this.snapshot(),
    };
  }

  scanRoots() {
    const roots = [];
    if (this.codexHome) {
      roots.push(path.join(this.codexHome, 'skills'));
    }
    if (this.agentsHome) {
      roots.push(path.join(this.agentsHome, 'skills'));
    }
    if (this.ccSwitchHome) {
      roots.push(path.join(this.ccSwitchHome, 'skills'));
    }
    roots.push(...this.pluginRoots);
    roots.push(...this.workspaceRoots.map((root) => path.join(root, '.agents', 'skills')));
    return roots;
  }

  watchRoot(rootPath) {
    const key = pathKey(rootPath);
    if (this.watchers.has(key) || !fs.existsSync(rootPath)) {
      return;
    }
    try {
      const stats = fs.statSync(rootPath);
      if (!stats.isDirectory()) {
        return;
      }
      let watcher;
      try {
        watcher = fs.watch(rootPath, {
          recursive: process.platform === 'win32' || process.platform === 'darwin',
        }, () => this.scheduleWatchedRefresh());
      } catch (_) {
        watcher = fs.watch(rootPath, () => this.scheduleWatchedRefresh());
      }
      watcher.on('error', (error) => {
        this.log(`[skills] watcher failed for ${rootPath}: ${error.message}`);
        try {
          watcher.close();
        } catch (_) {
          // Watcher may already be closed by the runtime.
        }
        this.watchers.delete(key);
      });
      this.watchers.set(key, watcher);
    } catch (error) {
      this.log(`[skills] unable to watch ${rootPath}: ${error.message}`);
    }
  }

  scheduleWatchedRefresh() {
    this.invalidate();
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.refresh({ force: true }).catch((error) => {
        this.log(`[skills] watched refresh failed: ${error.message}`);
      });
    }, this.watchDebounceMs);
    if (typeof this.watchTimer.unref === 'function') {
      this.watchTimer.unref();
    }
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const rootPath of this.scanRoots()) {
      this.watchRoot(rootPath);
    }
    this.periodicTimer = setInterval(() => {
      this.invalidate();
      this.refresh({ force: true }).catch((error) => {
        this.log(`[skills] periodic refresh failed: ${error.message}`);
      });
    }, this.refreshIntervalMs);
    if (typeof this.periodicTimer.unref === 'function') {
      this.periodicTimer.unref();
    }
    this.refresh({ force: true }).catch((error) => {
      this.log(`[skills] initial refresh failed: ${error.message}`);
    });
  }

  stop() {
    this.started = false;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch (_) {
        // Best effort during process shutdown.
      }
    }
    this.watchers.clear();
  }
}

module.exports = { HostSkillInventoryService };
