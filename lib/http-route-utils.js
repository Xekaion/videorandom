// Express 4 does not forward rejected handler promises to error middleware.
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function requestObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('요청 본문은 JSON 객체여야 합니다.');
  return value;
}

function filePathInput(value, label = '파일 경로') {
  if (typeof value !== 'string' || !value.trim() || value.length > 32767 || /[\x00-\x1f]/.test(value)) {
    throw badRequest(`${label}는 비어 있지 않은 올바른 문자열이어야 합니다.`);
  }
  return value.trim();
}

function scanInput(value) {
  const body = requestObject(value);
  const directory = filePathInput(body.directory, '디렉터리 경로');
  const excludeDirs = body.excludeDirs === undefined ? [] : body.excludeDirs;
  if (!Array.isArray(excludeDirs) || excludeDirs.length > 1000
      || excludeDirs.some(item => typeof item !== 'string' || item.length > 32767 || /[\x00-\x1f]/.test(item))) {
    throw badRequest('제외 폴더는 올바른 문자열 목록으로 입력해 주세요.');
  }
  const paths = directory.split(',').map(item => item.trim()).filter(Boolean);
  if (!paths.length) throw badRequest('유효한 디렉터리 경로가 없습니다.');
  return { paths, excludeDirs };
}

function apiErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let status = Number(error.status || error.statusCode);
  if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
  let message = status >= 500 ? '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' : String(error.message || '요청 형식이 올바르지 않습니다.');
  if (error.type === 'entity.parse.failed') message = '요청 본문의 JSON 형식이 올바르지 않습니다.';
  if (error.type === 'entity.too.large') message = '요청 본문이 허용된 크기를 초과했습니다.';
  res.status(status).json({ error: message });
}

module.exports = { asyncRoute, apiErrorHandler, requestObject, filePathInput, scanInput };
