const test = require('node:test');
const assert = require('node:assert/strict');
const { createCheckpointWriter } = require('../lib/checkpoint-writer');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('a slow checkpoint writer keeps only the newest pending periodic snapshot', async () => {
  const gate = deferred(), calls = [];
  let running = 0, maximum = 0;
  const writer = createCheckpointWriter({ write: async (kind, payload) => {
    maximum = Math.max(maximum, ++running);
    calls.push([kind, payload]);
    if (calls.length === 1) await gate.promise;
    running--;
  } });
  const first = writer.save('source', 0);
  for (let index = 1; index <= 10000; index++) writer.save('source', index);
  const flushed = writer.flush();
  await Promise.resolve();
  assert.deepEqual(calls, [['source', 0]]);
  gate.resolve();
  await Promise.all([first, flushed]);
  assert.deepEqual(calls, [['source', 0], ['source', 10000]]);
  assert.equal(maximum, 1);
});

test('barriers seal their call order and flush earlier periodic snapshots', async () => {
  const gate = deferred(), calls = [];
  const writer = createCheckpointWriter({ write: async (kind, payload) => {
    calls.push([kind, payload]);
    if (calls.length === 1) await gate.promise;
  } });
  writer.save('source', 1);
  writer.save('source', 2);
  writer.save('source', 3);
  const before = writer.save('source-before', 4, { barrier: true });
  writer.save('source', 5);
  writer.save('source', 6);
  const attempt = writer.save('source-attempt', 7, { barrier: true });
  const final = writer.save('source', 8, { barrier: true });
  let finished = false;
  final.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  gate.resolve();
  await Promise.all([before, attempt, final, writer.flush()]);
  assert.deepEqual(calls, [['source', 1], ['source', 3], ['source-before', 4], ['source', 6], ['source-attempt', 7], ['source', 8]]);
});

test('a failed write reports its warning and does not prevent an ordered final flush', async () => {
  const calls = [], warnings = [];
  const writer = createCheckpointWriter({ write: async (kind, payload) => {
    calls.push([kind, payload]);
    if (payload === 1) throw new Error('owned write failure');
  }, onError: error => warnings.push(error.message) });
  writer.save('source', 1);
  await writer.save('source', 2, { barrier: true });
  assert.deepEqual(warnings, ['owned write failure']);
  assert.deepEqual(calls, [['source', 1], ['source', 2]]);
  await writer.flush();
});
