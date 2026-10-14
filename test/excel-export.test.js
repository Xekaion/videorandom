const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const JSZip = require(require.resolve('jszip', { paths: [require.resolve('exceljs')] }));
const { createCatalogWorkbook, MAX_EXPORT_RECORDS } = require('../lib/excel-export');

// A real 16 x 9 JPEG, encoded from a solid RGB bitmap. No media tools or API needed.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAJABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjqKKK+kPAP//Z', 'base64');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-excel-test-'));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative.startsWith('videorandom-excel-test-') && !relative.includes(path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function record(overrides = {}) {
  return {
    id: 'video001', name: '여행.mp4', path: 'D:\\영상\\여행.mp4', ext: '.mp4', size: 123.4,
    duration: 3700, status: 'completed', summary: '친구들이 제주도로 여행한다.',
    plot: '친구들이 공항에서 만나 바다와 산을 돌아본다.', dialogueSummary: '여행 계획과 소감을 이야기한다.',
    labels: ['여행', '제주', '우정'], transcriptSource: 'subtitle',
    transcript: [{ start: 2.5, end: 5.5, text: '이번에는 바다부터 가자.' }, { start: 300, end: 302, text: '여기 정말 좋다.' }],
    frames: [], warnings: [], error: '', analyzedAt: '2026-10-13T18:00:00.000Z', ...overrides
  };
}

function columnNumber(sheet, title) {
  let result;
  sheet.getRow(1).eachCell(cell => { if (cell.value === title) result = cell.col; });
  assert.ok(result, `Missing column: ${title}`);
  return result;
}

function texts(sheet, title) {
  const column = columnNumber(sheet, title);
  const values = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) values.push(sheet.getCell(row, column).text);
  return values;
}

async function roundtrip(records, dataDir) {
  const buffer = await createCatalogWorkbook(records, { dataDir });
  assert.ok(Buffer.isBuffer(buffer));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return { buffer, workbook };
}

function secondsFromCell(cell) {
  return cell.value instanceof Date
    ? (cell.value.getTime() - Date.UTC(1899, 11, 30)) / 1000 : cell.value * 86400;
}

test('exports all ten actual JPEGs, catalog metadata and timestamped dialogue', async t => {
  const dataDir = await temporaryDirectory(t);
  const frameDir = path.join(dataDir, 'frames', 'video001');
  await fs.mkdir(frameDir, { recursive: true });
  const frames = Array.from({ length: 10 }, (_, index) => ({
    timestamp: (index + 1) * 300, filename: `frame-${index + 1}.jpg`, caption: `장면 ${index + 1}: 바다를 바라본다.`
  }));
  await Promise.all(frames.map(frame => fs.writeFile(path.join(frameDir, frame.filename), JPEG)));
  const { buffer, workbook } = await roundtrip([record({ frames })], dataDir);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['영상 목록', '장면 이미지', '전체 대사']);
  const catalog = workbook.getWorksheet('영상 목록');
  const scenes = workbook.getWorksheet('장면 이미지');
  const dialogue = workbook.getWorksheet('전체 대사');
  assert.equal(catalog.rowCount, 2);
  assert.deepEqual(texts(catalog, '영상파일명'), ['여행.mp4']);
  assert.deepEqual(texts(catalog, '라벨'), ['여행, 제주, 우정']);
  assert.equal(secondsFromCell(catalog.getCell(2, columnNumber(catalog, '재생 시간'))), 3700);
  assert.equal(catalog.getCell(2, columnNumber(catalog, '파일 크기 (MB)')).value, 123.4);
  assert.equal(catalog.getCell(2, columnNumber(catalog, '분석 시각 (UTC)')).value.toISOString(), '2026-10-13T18:00:00.000Z');
  assert.match(catalog.getCell(2, columnNumber(catalog, '장면 보기')).value.hyperlink, /장면 이미지.*A2/);
  assert.equal(scenes.rowCount, 11);
  assert.equal(scenes.getImages().length, 10);
  assert.deepEqual(texts(scenes, '이미지 상태'), Array(10).fill('포함됨'));
  assert.equal(secondsFromCell(scenes.getCell(2, columnNumber(scenes, '시각'))), 300);
  assert.deepEqual(texts(dialogue, '전체 대사'), ['이번에는 바다부터 가자.', '여기 정말 좋다.']);
  assert.equal(secondsFromCell(dialogue.getCell(2, columnNumber(dialogue, '시작'))), 2.5);
  for (const sheet of workbook.worksheets) {
    assert.equal(sheet.views[0].state, 'frozen');
    assert.equal(sheet.views[0].ySplit, 1);
    assert.ok(sheet.autoFilter);
  }
  const zip = await JSZip.loadAsync(buffer);
  const images = Object.keys(zip.files).filter(name => /^xl\/media\/.*\.jpeg$/.test(name));
  assert.equal(images.length, 10);
  for (const name of images) assert.deepEqual(await zip.file(name).async('nodebuffer'), JPEG);
});

test('preserves long plot, summary, descriptions and complete dialogue losslessly with literal formula-looking text', async t => {
  const dataDir = await temporaryDirectory(t);
  const plot = '도입\n' + '가'.repeat(32764) + '🎬' + '전개와 결말 '.repeat(6000);
  const summary = '=HYPERLINK("https://example.invalid", "클릭")\n' + '요약 '.repeat(12000);
  const dialogueSummary = '대화\n'.repeat(600);
  const transcriptText = '=1+1\n' + '나'.repeat(32758) + '😀' + '대사\r\n'.repeat(9000) + '\t끝 _x000D_ _x005F_\u0000';
  const caption = '@SUM(1,2)\n' + '설명 '.repeat(12000);
  const { buffer, workbook } = await roundtrip([record({
    name: '=1+1.mp4', plot, summary, dialogueSummary,
    transcript: [{ start: 10, end: 20, text: transcriptText }],
    frames: [{ timestamp: 10, filename: 'missing.jpg', caption }]
  })], dataDir);
  const catalog = workbook.getWorksheet('영상 목록');
  const scenes = workbook.getWorksheet('장면 이미지');
  const dialogue = workbook.getWorksheet('전체 대사');
  assert.equal(texts(catalog, '줄거리').join(''), plot);
  assert.equal(texts(catalog, '요약').join(''), summary);
  assert.equal(texts(catalog, '대사 요약').join(''), dialogueSummary);
  assert.equal(texts(scenes, '장면 설명').join(''), caption);
  assert.ok(texts(dialogue, '전체 대사').join('') === transcriptText, 'Full transcript must survive XLSX roundtrip exactly.');
  assert.ok(dialogue.rowCount > 2);
  for (let row = 2; row <= dialogue.rowCount; row += 1) {
    assert.equal(secondsFromCell(dialogue.getCell(row, columnNumber(dialogue, '시작'))), 10);
    assert.equal(dialogue.getCell(row, columnNumber(dialogue, '구간 번호')).value, 1);
  }
  workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
    assert.notEqual(cell.type, ExcelJS.ValueType.Formula);
    if (typeof cell.value === 'string') {
      assert.ok(cell.value.length <= 32767);
      assert.ok((cell.value.match(/\n/g) || []).length <= 250);
      assert.ok(!/[\uD800-\uDBFF]$/.test(cell.value));
    }
  })));
  const zip = await JSZip.loadAsync(buffer);
  for (const name of Object.keys(zip.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))) {
    assert.doesNotMatch(await zip.file(name).async('string'), /<f[ >]/);
  }
});

test('keeps all twenty explicitly selected frames', async t => {
  const dataDir = await temporaryDirectory(t);
  const frameDir = path.join(dataDir, 'frames', 'video001');
  await fs.mkdir(frameDir, { recursive: true });
  const frames = Array.from({ length: 20 }, (_, index) => ({
    timestamp: index * 60, filename: `frame-${index}.jpg`, caption: `사용자 지정 장면 ${index + 1}`
  }));
  await Promise.all(frames.map(frame => fs.writeFile(path.join(frameDir, frame.filename), JPEG)));
  const { workbook } = await roundtrip([record({ frames })], dataDir);
  assert.equal(workbook.getWorksheet('장면 이미지').getImages().length, 20);
  assert.equal(workbook.getWorksheet('장면 이미지').rowCount, 21);
  assert.equal(workbook.getWorksheet('영상 목록').getCell(2, columnNumber(workbook.getWorksheet('영상 목록'), '포함된 장면 수')).value, 20);
  assert.equal(texts(workbook.getWorksheet('영상 목록'), '경고').join(''), '');
});

test('flags missing, corrupt and traversal images without embedding files outside the frame folder', async t => {
  const dataDir = await temporaryDirectory(t);
  await fs.mkdir(path.join(dataDir, 'frames', 'video001'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'frames', 'video001', 'corrupt.jpg'), Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]));
  await fs.writeFile(path.join(dataDir, 'outside.jpg'), JPEG);
  const { buffer, workbook } = await roundtrip([
    record({ frames: [
      { timestamp: 0, filename: 'missing.jpg', caption: '없는 이미지' },
      { timestamp: 10, filename: 'corrupt.jpg', caption: '손상된 이미지' },
      { timestamp: 20, filename: '../../outside.jpg', caption: '잘못된 경로' }
    ] }),
    record({ id: '..', name: 'escape.mp4', frames: [{ timestamp: 0, filename: 'outside.jpg', caption: '잘못된 ID' }] })
  ], dataDir);
  const scenes = workbook.getWorksheet('장면 이미지');
  const statuses = texts(scenes, '이미지 상태');
  assert.match(statuses[0], /파일을 찾을 수 없음/);
  assert.match(statuses[1], /손상/);
  assert.match(statuses[2], /파일명 형식 오류/);
  assert.match(statuses[3], /영상 ID 형식 오류/);
  assert.equal(scenes.getImages().length, 0);
  const zip = await JSZip.loadAsync(buffer);
  assert.equal(Object.keys(zip.files).filter(name => /^xl\/media\/.*\.jpeg$/.test(name)).length, 0);
  assert.match(texts(workbook.getWorksheet('영상 목록'), '경고').join('\n'), /장면 2.*손상/);
});

test('rejects a directory junction or symbolic link escaping the data folder', async t => {
  const tempDir = await temporaryDirectory(t);
  const dataDir = path.join(tempDir, 'data');
  const outsideDir = path.join(tempDir, 'outside');
  await fs.mkdir(path.join(dataDir, 'frames'), { recursive: true });
  await fs.mkdir(outsideDir);
  await fs.writeFile(path.join(outsideDir, 'frame.jpg'), JPEG);
  try {
    await fs.symlink(outsideDir, path.join(dataDir, 'frames', 'video001'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('The host does not allow symbolic links.');
    throw error;
  }
  const { workbook } = await roundtrip([record({ frames: [{ timestamp: 1, filename: 'frame.jpg', caption: '' }] })], dataDir);
  assert.match(texts(workbook.getWorksheet('장면 이미지'), '이미지 상태')[0], /폴더 밖/);
  assert.equal(workbook.getWorksheet('장면 이미지').getImages().length, 0);
});

test('bounds oversized catalogs explicitly and creates a usable empty workbook', async t => {
  const dataDir = await temporaryDirectory(t);
  await assert.rejects(createCatalogWorkbook(Array(MAX_EXPORT_RECORDS + 1).fill(record()), { dataDir }), /1,000/);
  await assert.rejects(createCatalogWorkbook([record({ plot: '가'.repeat(32000001) })], { dataDir }), /텍스트가 너무 큽니다/);
  await assert.rejects(createCatalogWorkbook([record()]), /데이터 폴더/);
  const { workbook } = await roundtrip([], dataDir);
  assert.equal(workbook.worksheets.length, 3);
  workbook.eachSheet(sheet => assert.equal(sheet.rowCount, 1));
});
