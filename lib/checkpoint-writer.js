// Periodic snapshots are replaceable until a barrier seals their position.
// Barriers keep explicit before/attempt/final checkpoints in call order and
// resolve only after every earlier write, including a coalesced snapshot.
function createCheckpointWriter({ write, onError = () => {} } = {}) {
  if (typeof write !== 'function' || typeof onError !== 'function') throw new TypeError('Checkpoint callbacks are required');
  const queue = [];
  let active = null;
  function pump() {
    if (active || !queue.length) return;
    active = queue.shift();
    const selected = active;
    Promise.resolve().then(() => write(selected.kind, selected.payload)).catch(error => {
      try { onError(error); } catch (_) {}
    }).finally(() => {
      active = null;
      selected.resolve();
      pump();
    });
  }
  function save(kind, payload, { barrier = false } = {}) {
    const pending = queue.at(-1);
    if (!barrier && pending?.periodic && pending.kind === kind) {
      pending.payload = payload;
      return pending.promise;
    }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    queue.push({ kind, payload, periodic: !barrier, promise, resolve });
    pump();
    return promise;
  }
  function flush() { return queue.at(-1)?.promise || active?.promise || Promise.resolve(); }
  return { save, flush };
}

module.exports = { createCheckpointWriter };
