/**
 * EMFILE(FD 누수) 회귀 방지 테스트
 *
 * 실행:
 *   node kma_fetch/tests/testEmfileFixes.js
 *   (또는 kma_fetch 디렉터리에서) node tests/testEmfileFixes.js
 *
 * 수동 검증 시나리오 (운영/스테이징):
 * 1) in_data/rdr/YYYY-MM-DD/ 에 RDR_CMP_HSP_PUB_yyyyMMddHHmm.bin 이 있는 시각은
 *    로그의 timesToDownload 에 포함되지 않아야 함
 * 2) 동일 조건에서 5분 스케줄 수회 돌린 뒤 `ls /proc/<pid>/fd | wc -l` 이
 *    단조 증가하지 않아야 함 (skip 경로에서 axios stream 미정리 시 증가함)
 * 3) 이전 downloadLatestData 가 길어지면 로그에
 *    "Skipping task (still running): RDR-5min" 이 나와야 함
 */

const assert = require('assert');
const { Readable } = require('stream');
const { destroyStream } = require('../utils/download');

function getDateString(yyyyMMddHHmm) {
  return `${yyyyMMddHHmm.slice(0, 4)}-${yyyyMMddHHmm.slice(4, 6)}-${yyyyMMddHHmm.slice(6, 8)}`;
}

/** main_RDR / main_AWS 와 동일한 존재 검사 필터 */
function filterTimesToDownload(timeCandidates, folderFiles, patternBase, fileExt) {
  return timeCandidates.filter((timeCandidate) => {
    const kstTimeString = getDateString(timeCandidate);
    const fileNameRegex = new RegExp(`^${patternBase}${timeCandidate}\\.${fileExt}$`);
    const existingFiles = folderFiles[kstTimeString] || [];
    return existingFiles.every((fileName) => !fileNameRegex.test(fileName));
  });
}

function testRdrExistingFileNotInTimesToDownload() {
  const patternBase = 'RDR_CMP_HSP_PUB_';
  const fileExt = 'bin';
  const timeCandidates = ['202607230010', '202607230015', '202607230020'];
  const folderFiles = {
    '2026-07-23': [
      'RDR_CMP_HSP_PUB_202607230010.bin',
      'RDR_CMP_HSP_PUB_202607230015.bin',
    ],
  };

  const timesToDownload = filterTimesToDownload(
    timeCandidates,
    folderFiles,
    patternBase,
    fileExt
  );

  assert.deepStrictEqual(
    timesToDownload,
    ['202607230020'],
    '이미 있는 .bin 시각은 timesToDownload 에 포함되면 안 됨'
  );

  // 과거 버그: getDateString + 이중 underscore → 절대 매칭 실패 → 전부 재다운로드
  const buggyRegex = new RegExp(
    `${patternBase}_${getDateString('202607230010')}.${fileExt}`
  );
  assert.strictEqual(
    buggyRegex.test('RDR_CMP_HSP_PUB_202607230010.bin'),
    false,
    '버그 패턴은 실제 파일명과 매칭되지 않아야 함(회귀 문서화)'
  );
}

function testAwsExistingFileNotInTimesToDownload() {
  const patternBase = 'AWS_MIN_';
  const fileExt = 'json';
  const timeCandidates = ['202607230010', '202607230012'];
  const folderFiles = {
    '2026-07-23': ['AWS_MIN_202607230010.json'],
  };

  const timesToDownload = filterTimesToDownload(
    timeCandidates,
    folderFiles,
    patternBase,
    fileExt
  );

  assert.deepStrictEqual(timesToDownload, ['202607230012']);
}

function testDestroyStreamReleasesReadable() {
  const stream = new Readable({
    read() {
      this.push(Buffer.from('x'));
      this.push(null);
    },
  });
  assert.strictEqual(stream.destroyed, false);
  destroyStream(stream);
  assert.strictEqual(stream.destroyed, true, 'skip/error 시 stream.destroy 되어야 함');

  // 문자열/undefined 에도 예외 없이 no-op
  destroyStream('not-a-stream');
  destroyStream(undefined);
}

function testSchedulerOverlapLock() {
  // node-schedule cron 없이 overlap lock 동작만 검증
  let running = false;
  let runCount = 0;
  let skipCount = 0;
  let release;

  const invoke = () => {
    if (running) {
      skipCount += 1;
      return;
    }
    running = true;
    runCount += 1;
    return new Promise((resolve) => {
      release = () => {
        running = false;
        resolve();
      };
    });
  };

  const first = invoke();
  invoke(); // overlap → skip
  assert.strictEqual(runCount, 1);
  assert.strictEqual(skipCount, 1);
  release();
  return Promise.resolve(first).then(() => {
    invoke();
    assert.strictEqual(runCount, 2);
    release();
  });
}

async function main() {
  testRdrExistingFileNotInTimesToDownload();
  testAwsExistingFileNotInTimesToDownload();
  testDestroyStreamReleasesReadable();
  await testSchedulerOverlapLock();
  console.log('OK: testEmfileFixes passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
