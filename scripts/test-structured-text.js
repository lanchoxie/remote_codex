const assert = require('assert');
const shared = require('../shared/structured-text');
const browser = require('../apps/mobile-web/public/structured-text');

const implementations = [
  {
    name: 'shared',
    text: shared.structuredText,
    scalar: shared.structuredScalar,
    json: shared.safeStructuredJson,
  },
  {
    name: 'browser',
    text: browser.toText,
    scalar: browser.toScalar,
    json: browser.safeJson,
  },
];

for (const implementation of implementations) {
  const protocolParts = [
    { type: 'input_text', text: 'alpha' },
    { type: 'output_text', text: 'beta' },
  ];
  assert.strictEqual(
    implementation.text(protocolParts),
    'alpha\nbeta',
    `${implementation.name}: protocol text parts must remain readable`
  );

  assert.strictEqual(
    implementation.text({ content: [{ message: { text: 'nested message' } }] }),
    'nested message',
    `${implementation.name}: nested content/message wrappers must be unwrapped`
  );
  assert.strictEqual(
    implementation.scalar({ status: { state: 'inProgress' } }, ''),
    'inProgress',
    `${implementation.name}: object statuses must normalize to a scalar`
  );

  const circular = { payload: { answer: 42 } };
  circular.self = circular;
  const circularText = implementation.text(circular);
  assert(circularText.includes('[Circular]'), `${implementation.name}: circular values need an explicit marker`);
  assert(!circularText.includes('[object Object]'), `${implementation.name}: circular values must not use implicit object coercion`);

  const commandActions = [{ type: 'read', path: 'D:/workspace/input.json', line: 12 }];
  const commandActionsJson = implementation.json(commandActions);
  assert(commandActionsJson.includes('"type":"read"'), `${implementation.name}: command action type must be retained`);
  assert(commandActionsJson.includes('"path":"D:/workspace/input.json"'), `${implementation.name}: command action path must be retained`);
  assert(!commandActionsJson.includes('[object Object]'), `${implementation.name}: structured JSON must not contain implicit object text`);

  const specialValuesJson = implementation.json({
    when: new Date('2026-08-30T01:02:03.000Z'),
    mapping: new Map([['alpha', { value: 1 }]]),
    selection: new Set(['beta']),
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert(specialValuesJson.includes('2026-08-30T01:02:03.000Z'), `${implementation.name}: Date must remain readable`);
  assert(specialValuesJson.includes('"$map"'), `${implementation.name}: Map entries must not collapse to an empty object`);
  assert(specialValuesJson.includes('"$set"'), `${implementation.name}: Set values must not collapse to an empty object`);
  assert(specialValuesJson.includes('Uint8Array 3 bytes'), `${implementation.name}: binary values need bounded metadata`);

  const throwingProperty = { safe: 'visible' };
  Object.defineProperty(throwingProperty, 'broken', {
    enumerable: true,
    get() {
      throw new Error('getter must not escape');
    },
  });
  const throwingJson = implementation.json(throwingProperty);
  assert(throwingJson.includes('"safe":"visible"'), `${implementation.name}: readable siblings must survive a throwing getter`);
  assert(throwingJson.includes('[Unserializable property]'), `${implementation.name}: throwing getters need an explicit marker`);

  const circularArray = [];
  circularArray.push(circularArray);
  assert(implementation.json(circularArray).includes('[Circular]'), `${implementation.name}: circular arrays must terminate safely`);

  for (const value of [protocolParts, circular, circularArray, specialValuesJson, { status: { state: 'running' } }, commandActions]) {
    assert(
      !implementation.text(value).includes('[object Object]'),
      `${implementation.name}: final display text must not contain [object Object]`
    );
  }
}

console.log('structured text assertions passed');
