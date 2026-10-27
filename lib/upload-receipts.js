const fs = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { classifyDiagnosticError } = require('./diagnostics');

const ID = /^[a-f0-9]{32}$/;
const PHASES = new Set(['receiving', 'accepted', 'rejected', 'interrupted']);
const MAX_BYTES = 359 * 1024 * 1024;
const MAX_ELAPSED = 7 * 24 * 60 * 60 * 1000;
const MAX_RECEIPT = 16 * 1024;

function cleanDiagnostic(value) {
    const clean = classifyDiagnosticError(value);
    // Receipts retain fixed technical classifications, not identity, source
    // contents, paths, arbitrary exception properties or raw messages.
    const result = { code: clean.code, message: clean.message };
    for (const key of ['systemCode', 'httpStatus']) if (clean[key] !== undefined) result[key] = clean[key];
    return result;
}

function sanitizeUploadReceipt(value) {
    if (!value || value.schemaVersion !== 1 || !ID.test(value.uploadId || '') || !PHASES.has(value.phase)
        || !Number.isSafeInteger(value.expectedBytes) || value.expectedBytes < 1 || value.expectedBytes > MAX_BYTES
        || !Number.isSafeInteger(value.receivedBytes) || value.receivedBytes < 0 || value.receivedBytes > value.expectedBytes
        || value.phase === 'accepted' && value.receivedBytes !== value.expectedBytes
        || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > MAX_ELAPSED
        || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) return null;
    return { schemaVersion: 1, uploadId: value.uploadId, phase: value.phase, expectedBytes: value.expectedBytes,
        receivedBytes: value.receivedBytes, elapsedMs: value.elapsedMs,
        createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString(),
        ...(value.phase === 'accepted' ? { jobId: value.uploadId } : {}),
        ...(value.errorDiagnostic ? { errorDiagnostic: cleanDiagnostic(value.errorDiagnostic) } : {}) };
}

function createUploadReceiptStore({ dataDir, io = fs, now = Date.now } = {}) {
    const directory = path.resolve(dataDir, 'remote', 'uploads');
    const locks = new Map();
    const filename = id => { if (!ID.test(id || '')) throw new TypeError('Invalid upload receipt ID'); return path.join(directory, id + '.json'); };
    const stamp = () => new Date(now()).toISOString();
    function locked(id, operation) {
        const previous = locks.get(id) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        locks.set(id, current);
        current.finally(() => { if (locks.get(id) === current) locks.delete(id); }).catch(() => {});
        return current;
    }
    async function read(id) {
        const target = filename(id);
        let stat;
        try { stat = await io.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        const invalid = () => Object.assign(new Error('Invalid upload receipt'), { code: 'UPLOAD_RECEIPT_INVALID' });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT) throw invalid();
        const contents = await io.readFile(target, 'utf8');
        let saved;
        try { saved = JSON.parse(contents); } catch (_) { throw invalid(); }
        const clean = sanitizeUploadReceipt(saved);
        if (!clean || clean.uploadId !== id) throw invalid();
        return clean;
    }
    async function write(value, initial = false) {
        const clean = sanitizeUploadReceipt(value);
        if (!clean) throw new TypeError('Invalid upload receipt');
        const target = filename(clean.uploadId), temporary = initial ? target : target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        let handle, owned = false;
        try {
            handle = await io.open(temporary, 'wx', 0o600); owned = true;
            await handle.writeFile(JSON.stringify(clean), 'utf8'); await handle.sync(); await handle.close(); handle = null;
            if (!initial) await io.rename(temporary, target);
        } catch (error) {
            if (handle) await handle.close().catch(() => {});
            if (owned) await io.unlink(temporary).catch(() => {});
            throw error;
        }
        return clean;
    }
    const ready = (async () => {
        await io.mkdir(directory, { recursive: true });
        const stat = await io.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('Invalid receipt directory'), { code: 'EIO' });
        for (const name of await io.readdir(directory)) {
            if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
            let value;
            try { value = await read(name.slice(0, 32)); }
            catch (error) {
                // An interrupted initial write or damaged single receipt must
                // not stop every other upload. This ID stays fail-closed:
                // get/begin will still reject it and never overwrite its file.
                if (error.code === 'UPLOAD_RECEIPT_INVALID') continue;
                throw error;
            }
            if (!value) continue;
            if (value.phase === 'receiving') await write({ ...value, phase: 'interrupted', updatedAt: stamp(),
                errorDiagnostic: cleanDiagnostic({ code: 'LAN_UPLOAD_DISCONNECTED' }) });
        }
    })();
    ready.catch(() => {});
    return {
        ready,
        async get(id) { await ready; return locked(id, () => read(id)); },
        async begin(id, expectedBytes) {
            await ready;
            return locked(id, async () => {
                const old = await read(id);
                if (old) return { created: false, receipt: old };
                const at = stamp();
                const receipt = await write({ schemaVersion: 1, uploadId: id, phase: 'receiving', expectedBytes,
                    receivedBytes: 0, elapsedMs: 0, createdAt: at, updatedAt: at }, true);
                return { created: true, receipt };
            });
        },
        async finish(id, fields) {
            await ready;
            return locked(id, async () => {
                const old = await read(id);
                if (!old) throw Object.assign(new Error('Upload receipt missing'), { code: 'EIO' });
                if (old.phase !== 'receiving') return old;
                const elapsedMs = Math.min(MAX_ELAPSED, Math.max(old.elapsedMs, Math.floor(now() - Date.parse(old.createdAt))));
                return write({ ...old, phase: fields.phase, receivedBytes: Math.min(old.expectedBytes, Math.max(0, Math.floor(fields.receivedBytes || 0))),
                    elapsedMs, updatedAt: stamp(), ...(fields.errorDiagnostic ? { errorDiagnostic: cleanDiagnostic(fields.errorDiagnostic) } : {}) });
            });
        },
        async flush() { await ready; await Promise.allSettled([...locks.values()]); }
    };
}

module.exports = { createUploadReceiptStore, sanitizeUploadReceipt, MAX_UPLOAD_RECEIPT_BYTES: MAX_BYTES };
