const ExcelJS = require('exceljs');
const fs = require('fs/promises');
const path = require('path');

const MAX_EXPORT_RECORDS = 1000;
const MAX_EXPORT_ROWS = 200000;
const MAX_TEXT_CHARACTERS = 32000000;
const MAX_CELL_CHARACTERS = 32767;
const MAX_FRAME_COUNT = 20;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 100 * 1024 * 1024;
const TIME_FORMAT = '[h]:mm:ss';
const COLORS = { navy: '17324D', pale: 'F0F5FA', line: 'DCE5EE', warning: '9C3C18' };

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function joinedText(value, separator) {
  return Array.isArray(value) ? value.map(text).join(separator) : text(value);
}

// OOXML escapes retain carriage returns/control characters and literal _xNNNN_
// strings. Leaving CR unescaped would let XML newline normalization change it.
function excelText(value) {
  return value.replace(/_x([0-9a-fA-F]{4})_/g, '_x005F_x$1_')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\r\uFFFE\uFFFF]/g,
      character => `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
}

// Continuation rows preserve the original text, including whitespace and emoji.
function textParts(value) {
  const original = text(value);
  if (!original) return [''];
  const parts = [];
  let start = 0;
  while (start < original.length) {
    let end = Math.min(start + MAX_CELL_CHARACTERS, original.length);
    let lineBreaks = 0;
    for (let i = start; i < end; i += 1) {
      if (original[i] === '\n' && ++lineBreaks === 250) {
        end = i + 1;
        break;
      }
    }
    if (end < original.length && /[\uD800-\uDBFF]/.test(original[end - 1])) end -= 1;
    parts.push(original.slice(start, end));
    start = end;
  }
  return parts;
}

function timeValue(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? seconds / 86400 : null;
}

function analyzedDate(value) {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : date;
}

function statusText(value) {
  const statuses = { pending: '대기', queued: '대기', processing: '분석 중', analyzing: '분석 중',
    completed: '완료', complete: '완료', done: '완료', error: '실패', failed: '실패',
    cancelled: '취소' };
  const status = text(value);
  return Object.prototype.hasOwnProperty.call(statuses, status) ? statuses[status] : status;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

// Check the JPEG markers before embedding: ExcelJS itself does not validate pixels.
function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  let dimensions = null;
  let inScan = false;
  let sawScan = false;
  while (offset < buffer.length) {
    if (inScan) {
      while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    }
    if (offset >= buffer.length || buffer[offset] !== 0xff) return null;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;
    const marker = buffer[offset++];
    if (inScan && (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    inScan = false;
    if (marker === 0xd9) return dimensions && sawScan ? dimensions : null;
    if (marker === 0xd8 || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (length < 8) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      const components = buffer[offset + 7];
      if (!width || !height || !components || length !== 8 + components * 3
        || width > 16384 || height > 16384 || width * height > 100000000) return null;
      dimensions = { width, height };
    }
    if (marker === 0xda) {
      if (!dimensions || length < 6 || length !== 6 + 2 * buffer[offset + 2]) return null;
      inScan = true;
      sawScan = true;
    }
    offset += length;
  }
  return null;
}

async function imageRoot(dataDir) {
  try {
    const canonicalData = await fs.realpath(path.resolve(dataDir));
    const canonicalFrames = await fs.realpath(path.join(canonicalData, 'frames'));
    return isWithin(canonicalData, canonicalFrames) ? canonicalFrames : null;
  } catch {
    return null;
  }
}

async function readFrame(record, frame, root, budget) {
  const id = text(record.id);
  const filename = text(frame.filename);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { status: '이미지 제외: 영상 ID 형식 오류' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,239}\.jpe?g$/i.test(filename)) {
    return { status: '이미지 제외: 이미지 파일명 형식 오류' };
  }
  if (!root) return { status: '이미지 없음: 프레임 폴더를 찾을 수 없음' };
  let handle;
  try {
    const filenamePath = await fs.realpath(path.join(root, id, filename));
    const recordPath = await fs.realpath(path.join(root, id));
    if (!isWithin(root, recordPath) || !isWithin(recordPath, filenamePath)) {
      return { status: '이미지 제외: 프레임 폴더 밖의 파일' };
    }
    handle = await fs.open(filenamePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return { status: '이미지 제외: 일반 파일이 아님' };
    if (stat.size > MAX_IMAGE_BYTES) return { status: '이미지 제외: 파일 크기 5 MB 초과' };
    if (budget.imageBytes + stat.size > MAX_TOTAL_IMAGE_BYTES) {
      return { status: '이미지 제외: 내보내기 이미지 합계 100 MB 초과' };
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > stat.size) return { status: '이미지 제외: 읽는 동안 파일 크기가 변경됨' };
    const content = buffer.subarray(0, bytesRead);
    const dimensions = jpegDimensions(content);
    if (!dimensions) return { status: '이미지 제외: 손상되었거나 지원하지 않는 JPEG' };
    budget.imageBytes += content.length;
    return { status: '포함됨', buffer: content, dimensions };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? '이미지 없음: 파일을 찾을 수 없음' : '이미지 제외: 파일을 읽을 수 없음' };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function setupSheet(workbook, name, columns) {
  const sheet = workbook.addWorksheet(name, {
    properties: { defaultRowHeight: 24, tabColor: { argb: COLORS.navy } },
    views: [{ state: 'frozen', xSplit: 2, ySplit: 1, showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });
  sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  sheet.getRow(1).height = 32;
  sheet.getRow(1).eachCell(cell => {
    cell.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  sheet.pageSetup.printTitlesRow = '1:1';
  return sheet;
}

function addRow(sheet, values, budget, height = 60) {
  if (++budget.rows > MAX_EXPORT_ROWS) {
    throw new RangeError(`엑셀 내보내기는 전체 ${MAX_EXPORT_ROWS.toLocaleString('en-US')}행까지 지원합니다. 영상을 나누어 내보내 주세요.`);
  }
  const encodedValues = Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (typeof value !== 'string') return [key, value];
    if (value.length > MAX_CELL_CHARACTERS) {
      throw new RangeError('엑셀 내보내기 식별자 또는 파일명이 너무 깁니다. 분석 데이터를 확인해 주세요.');
    }
    return [key, excelText(value)];
  }));
  const row = sheet.addRow(encodedValues);
  row.height = height;
  row.eachCell({ includeEmpty: true }, cell => {
    cell.font = { name: '맑은 고딕', size: 10, color: { argb: COLORS.navy } };
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.border = { bottom: { style: 'hair', color: { argb: COLORS.line } } };
    if (row.number % 2 === 0) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.pale } };
    }
  });
  return row;
}

function setFilters(sheet) {
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount } };
}

function validateTextBudget(records) {
  let characters = 0;
  function count(value) {
    characters += text(value).length;
    if (characters > MAX_TEXT_CHARACTERS) {
      throw new RangeError('엑셀 내보내기 텍스트가 너무 큽니다. 영상을 나누어 내보내 주세요.');
    }
  }
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('영상 분석 레코드가 올바르지 않습니다.');
    ['id', 'name', 'path', 'ext', 'status', 'summary', 'plot', 'dialogueSummary', 'transcriptSource', 'error', 'analyzedAt'].forEach(key => count(record[key]));
    count(joinedText(record.labels, ', '));
    count(joinedText(record.warnings, '\n'));
    if (Array.isArray(record.transcript)) record.transcript.forEach(segment => count(segment && segment.text));
    if (Array.isArray(record.frames)) record.frames.slice(0, MAX_FRAME_COUNT).forEach(frame => {
      count(frame && frame.caption);
      count(frame && frame.filename);
    });
  }
}

/**
 * Build an XLSX Buffer with the catalog, embedded JPEG scenes, and complete dialogue.
 * Text is never interpreted as a formula. Oversized text is split losslessly across
 * numbered rows. Images that cannot be read safely are reported in the workbook.
 * Limits: 1,000 videos, 200,000 data rows, 32M text characters, 20 images per video,
 * 5 MB per JPEG and 100 MB embedded images in total.
 */
async function createCatalogWorkbook(records, { dataDir } = {}) {
  if (!Array.isArray(records)) throw new TypeError('영상 목록은 배열이어야 합니다.');
  if (records.length > MAX_EXPORT_RECORDS) {
    throw new RangeError(`엑셀 내보내기는 영상 ${MAX_EXPORT_RECORDS.toLocaleString('en-US')}개까지 지원합니다. 목록을 나누어 내보내 주세요.`);
  }
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('분석 데이터 폴더가 필요합니다.');
  validateTextBudget(records);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Video Roulette';
  workbook.created = new Date();
  workbook.title = '영상 분석 목록';
  const catalog = setupSheet(workbook, '영상 목록', [
    ['영상 ID', 'id', 22], ['영상파일명', 'name', 34], ['본문 조각', 'part', 12], ['파일 경로', 'path', 45],
    ['재생 시간', 'duration', 14], ['파일 크기 (MB)', 'size', 16], ['분석 상태', 'status', 13],
    ['라벨', 'labels', 28], ['요약', 'summary', 50], ['줄거리', 'plot', 65], ['대사 요약', 'dialogueSummary', 55],
    ['대사 출처', 'transcriptSource', 22], ['대사 구간 수', 'transcriptCount', 16], ['포함된 장면 수', 'frameCount', 16],
    ['장면 보기', 'sceneLink', 18], ['대사 보기', 'transcriptLink', 18], ['분석 시각 (UTC)', 'analyzedAt', 23],
    ['경고', 'warnings', 45], ['오류', 'error', 45]
  ]);
  const scenes = setupSheet(workbook, '장면 이미지', [
    ['영상 ID', 'id', 22], ['영상파일명', 'name', 34], ['장면 번호', 'scene', 12], ['시각', 'timestamp', 14],
    ['이미지', 'image', 47], ['장면 설명', 'caption', 65], ['이미지 상태', 'imageStatus', 43],
    ['이미지 파일명', 'filename', 26], ['본문 조각', 'part', 12]
  ]);
  const transcriptSheet = setupSheet(workbook, '전체 대사', [
    ['영상 ID', 'id', 22], ['영상파일명', 'name', 34], ['대사 출처', 'source', 22], ['구간 번호', 'segment', 12],
    ['시작', 'start', 14], ['종료', 'end', 14], ['본문 조각', 'part', 12], ['전체 대사', 'text', 110]
  ]);
  catalog.getColumn('duration').numFmt = TIME_FORMAT;
  catalog.getColumn('size').numFmt = '#,##0.00';
  catalog.getColumn('analyzedAt').numFmt = 'yyyy-mm-dd hh:mm:ss';
  scenes.getColumn('timestamp').numFmt = TIME_FORMAT;
  transcriptSheet.getColumn('start').numFmt = TIME_FORMAT;
  transcriptSheet.getColumn('end').numFmt = TIME_FORMAT;
  const root = await imageRoot(dataDir);
  const budget = { imageBytes: 0, rows: 0 };

  for (const record of records) {
    const frames = Array.isArray(record.frames) ? record.frames.slice(0, MAX_FRAME_COUNT) : [];
    const transcript = Array.isArray(record.transcript) ? record.transcript : [];
    const extraWarnings = [];
    if (Array.isArray(record.frames) && record.frames.length > MAX_FRAME_COUNT) {
      extraWarnings.push(`장면 이미지는 처음 ${MAX_FRAME_COUNT}장만 포함되었습니다.`);
    }
    const firstSceneRow = scenes.rowCount + 1;
    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i] || {};
      const image = await readFrame(record, frame, root, budget);
      if (!image.buffer) extraWarnings.push(`장면 ${i + 1}: ${image.status}`);
      const captions = textParts(frame.caption);
      for (let part = 0; part < captions.length; part += 1) {
        const row = addRow(scenes, {
          id: text(record.id), name: text(record.name), scene: i + 1, timestamp: timeValue(frame.timestamp),
          caption: captions[part], imageStatus: part ? (image.buffer ? '첫 번째 본문 조각에 표시' : image.status) : image.status,
          filename: text(frame.filename), part: `${part + 1}/${captions.length}`
        }, budget, part === 0 && image.buffer ? 144 : 90);
        if (part === 0 && image.buffer) {
          const imageId = workbook.addImage({ buffer: image.buffer, extension: 'jpeg' });
          const scale = Math.min(320 / image.dimensions.width, 180 / image.dimensions.height);
          scenes.addImage(imageId, {
            tl: { col: 4.05, row: row.number - 1 + 0.03 },
            ext: { width: image.dimensions.width * scale, height: image.dimensions.height * scale },
            editAs: 'oneCell'
          });
        }
        if (!image.buffer) row.getCell('imageStatus').font = { name: '맑은 고딕', size: 10, color: { argb: COLORS.warning } };
      }
    }
    const firstTranscriptRow = transcriptSheet.rowCount + 1;
    for (let i = 0; i < transcript.length; i += 1) {
      const segment = transcript[i] || {};
      const parts = textParts(segment.text);
      for (let part = 0; part < parts.length; part += 1) {
        addRow(transcriptSheet, {
          id: text(record.id), name: text(record.name), source: text(record.transcriptSource), segment: i + 1,
          start: timeValue(segment.start), end: timeValue(segment.end), part: `${part + 1}/${parts.length}`, text: parts[part]
        }, budget, 90);
      }
    }
    const fields = {
      id: record.id, name: record.name, path: record.path, labels: joinedText(record.labels, ', '),
      summary: record.summary, plot: record.plot, dialogueSummary: record.dialogueSummary,
      transcriptSource: record.transcriptSource, error: record.error,
      warnings: [joinedText(record.warnings, '\n'), ...extraWarnings].filter(Boolean).join('\n')
    };
    const parts = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, textParts(value)]));
    const partCount = Math.max(...Object.values(parts).map(value => value.length));
    for (let part = 0; part < partCount; part += 1) {
      const row = addRow(catalog, {
        ...Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, value[part] || ''])),
        // Keep record identifiers visible on continuation rows for filtering.
        id: parts.id[part] || (parts.id.length === 1 ? parts.id[0] : ''),
        name: parts.name[part] || (parts.name.length === 1 ? parts.name[0] : ''),
        part: `${part + 1}/${partCount}`, duration: timeValue(record.duration),
        size: typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0 ? record.size : null,
        status: statusText(record.status), transcriptCount: transcript.length, frameCount: frames.length,
        analyzedAt: analyzedDate(record.analyzedAt)
      }, budget, 120);
      if (frames.length) row.getCell('sceneLink').value = { text: '장면 이미지 열기', hyperlink: `#'장면 이미지'!A${firstSceneRow}` };
      if (transcript.length) row.getCell('transcriptLink').value = { text: '전체 대사 열기', hyperlink: `#'전체 대사'!A${firstTranscriptRow}` };
      ['sceneLink', 'transcriptLink'].forEach(key => {
        row.getCell(key).font = { name: '맑은 고딕', size: 10, color: { argb: '1266AA' }, underline: true };
      });
    }
  }
  [catalog, scenes, transcriptSheet].forEach(setFilters);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { createCatalogWorkbook, MAX_EXPORT_RECORDS };
