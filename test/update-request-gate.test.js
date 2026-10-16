const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateRequestGate } = require('../lib/update-request-gate');

function response() {
  const res = new EventEmitter();
  res.end = () => res;
  res.setHeader = (name, value) => { res[name] = value; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; res.end(); return res; };
  return res;
}

test('an accepted asynchronous history request remains busy after its browser disconnects until the handler ends', () => {
  const gate = createUpdateRequestGate({ isBlocked: () => false }), res = response();
  let admitted = false;
  gate.middleware({ method: 'POST', path: '/history/pick' }, res, () => { admitted = true; });
  assert.equal(admitted, true); assert.equal(gate.getActiveCount(), 1);
  res.emit('close');
  assert.equal(gate.getActiveCount(), 1);
  res.end(); res.emit('finish');
  assert.equal(gate.getActiveCount(), 0);
});

test('the handoff gate rejects new writes while retaining read and fixed updater access', () => {
  const gate = createUpdateRequestGate({ isBlocked: () => true });
  for (const req of [{ method: 'GET', path: '/app-info' }, { method: 'POST', path: '/updates/apply' }]) {
    let admitted = false;
    gate.middleware(req, response(), () => { admitted = true; });
    assert.equal(admitted, true);
  }
  for (const route of ['/history/pick', '/scan', '/play', '/updates-unrelated']) {
    const res = response();
    gate.middleware({ method: 'POST', path: route }, res, () => assert.fail('blocked mutation admitted'));
    assert.equal(res.statusCode, 503); assert.equal(res['Retry-After'], '5');
  }
  assert.equal(gate.getActiveCount(), 0);
});
