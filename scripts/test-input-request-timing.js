'use strict';

const assert = require('assert');
const { createInputRequestTimer } = require('../apps/relay/input-request-timing.js');

let now = 100;
const timer = createInputRequestTimer({ clock: () => now });
now = 103.25;
timer.mark('body_parse');
now = 111.5;
timer.mark('outbox_durable');
now = 112;
const headers = timer.headers();

assert.strictEqual(headers['X-Remote-Codex-Input-Total-Ms'], '12.00');
assert.match(headers['Server-Timing'], /body_parse;dur=3\.25/);
assert.match(headers['Server-Timing'], /outbox_durable;dur=8\.25/);
assert.match(headers['Server-Timing'], /total;dur=12\.00/);
assert.match(headers['Access-Control-Expose-Headers'], /Server-Timing/);

const disabled = createInputRequestTimer({ enabled: false, clock: () => 100 });
disabled.mark('ignored');
assert.deepStrictEqual(disabled.headers(), {});
console.log('input request timing assertions passed');
