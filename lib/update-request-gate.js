function createUpdateRequestGate({ isBlocked }) {
  let active = 0;
  function middleware(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/updates' || req.path.startsWith('/updates/')) return next();
    if (isBlocked()) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: '프로그램 업데이트를 적용하고 있습니다. 잠시 후 다시 시도해 주세요.' });
    }
    active++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; active--; } };
    const end = res.end;
    res.end = function (...args) { try { return end.apply(this, args); } finally { finish(); } };
    res.once('finish', finish);
    // A closed browser connection does not stop an accepted asynchronous save.
    // Only the handler finishing its response releases this admission.
    next();
  }
  return { middleware, getActiveCount: () => active };
}
module.exports = { createUpdateRequestGate };
