const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  TerminalSessionService,
  sanitizedTerminalEnvironment,
} = require('../apps/host-agent/terminal-session-service');

function fakePtyFactory() {
  const instances = [];
  return {
    instances,
    spawn(executable, args, options) {
      const emitter = new EventEmitter();
      const pty = {
        pid: 4242 + instances.length,
        executable,
        args,
        options,
        writes: [],
        resizes: [],
        killed: false,
        onData(listener) {
          emitter.on('data', listener);
          return { dispose: () => emitter.off('data', listener) };
        },
        onExit(listener) {
          emitter.on('exit', listener);
          return { dispose: () => emitter.off('exit', listener) };
        },
        write(data) { this.writes.push(data); },
        resize(cols, rows) { this.resizes.push([cols, rows]); },
        kill() { this.killed = true; },
        emitData(data) { emitter.emit('data', data); },
        emitExit(event) { emitter.emit('exit', event); },
      };
      instances.push(pty);
      return pty;
    },
  };
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-terminal-service-'));
  const published = [];
  const ptyFactory = fakePtyFactory();
  const service = new TerminalSessionService({
    hostId: 'test-host',
    platform: 'linux',
    env: {
      SHELL: '/bin/bash',
      PATH: '/usr/bin',
      RELAY_AUTH_TOKEN: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak',
      NORMAL_VALUE: 'kept',
    },
    ptyFactory,
    outputFlushMs: 1,
    publish: async (event) => published.push(event),
  });

  assert.strictEqual(service.getCapability().available, true);
  const opened = service.create({
    terminalId: 'term-1',
    sessionId: 'session-1',
    cwd,
    cols: 120,
    rows: 40,
  });
  assert.strictEqual(opened.cwd, cwd);
  assert.strictEqual(opened.shell, 'bash');
  assert.strictEqual(ptyFactory.instances[0].options.env.NORMAL_VALUE, 'kept');
  assert.strictEqual(ptyFactory.instances[0].options.env.RELAY_AUTH_TOKEN, undefined);
  assert.strictEqual(ptyFactory.instances[0].options.env.OPENAI_API_KEY, undefined);
  assert.strictEqual(service.hasActiveSessions(), true);

  service.write({ terminalId: 'term-1', data: 'echo ok\r' });
  assert.deepStrictEqual(ptyFactory.instances[0].writes, ['echo ok\r']);
  service.resize({ terminalId: 'term-1', cols: 132, rows: 44 });
  assert.deepStrictEqual(ptyFactory.instances[0].resizes, [[132, 44]]);

  ptyFactory.instances[0].emitData('hello');
  ptyFactory.instances[0].emitData(' world');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.strictEqual(published.length, 1);
  assert.strictEqual(published[0].type, 'host.terminal.output');
  assert.strictEqual(published[0].data, 'hello world');
  assert.strictEqual(published[0].sequence, 1);

  assert.throws(
    () => service.create({ terminalId: 'term-missing', sessionId: 'session-1', cwd: path.join(cwd, 'missing') }),
    (error) => error.code === 'terminal_cwd_unavailable'
  );
  assert.throws(
    () => service.write({ terminalId: 'term-1', data: 'x'.repeat(70 * 1024) }),
    (error) => error.code === 'terminal_input_too_large'
  );

  assert.strictEqual(service.close({ terminalId: 'term-1', reason: 'test-close' }), true);
  assert.strictEqual(ptyFactory.instances[0].killed, true);
  assert.strictEqual(service.hasActiveSessions(), false);

  const clean = sanitizedTerminalEnvironment({
    USER: 'test',
    PASSWORD: 'secret',
    SOME_API_KEY: 'secret',
    AUTH_HEADER: 'secret',
  });
  assert.deepStrictEqual(clean.USER, 'test');
  assert.strictEqual(clean.PASSWORD, undefined);
  assert.strictEqual(clean.SOME_API_KEY, undefined);
  assert.strictEqual(clean.AUTH_HEADER, undefined);

  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('terminal session service assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
