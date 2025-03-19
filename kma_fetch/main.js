const api = require('./services/api');
const file = require('./utils/file');
const time = require('./utils/time');
const schedule = require('./services/scheduler');

// 다운로드할 파라미터 조합 정의
const downloadConfigs = [
  { outputLevel: 'LE1B', dataType: 'IR105', dataCoverage: 'EA', interval: '10min' },
  { outputLevel: 'LE1B', dataType: 'IR105', dataCoverage: 'FD', interval: '10min' },
];

/**
 * 주어진 파라미터로 사용 가능한 최신 파일을 확인하고 다운로드
 * @param {string} outputLevel
 * @param {string} dataType
 * @param {string} dataCoverage
 */

async function downloadLatestData(outputLevel, dataType, dataCoverage) {
  try {
    const now = time.getUtcNow();
    const sDate = new Date(now.getTime() - 60 * 60 * 1000); // 1시간 전
    const eDate = now;

    console.log(`Fetching file list for ${outputLevel}/${dataType}/${dataCoverage} from ${sDate} to ${eDate}`);
    const availableFiles = await api.fetchFileList(outputLevel, dataType, dataCoverage, sDate, eDate);

    // KST 기준으로 폴더별 파일 목록 수집
    const folderFiles = {};
    for (const availFile of availableFiles) {
      const kstFolder = time.getKstFolderDate(availFile.utcDate);
      if (!folderFiles[kstFolder]) {
        folderFiles[kstFolder] = await file.listFiles(availFile.utcDate);
      }
    }

    // 다운로드되지 않은 파일만 필터링
    const filesToDownload = availableFiles.filter(availFile => {
      const kstFolder = time.getKstFolderDate(availFile.utcDate);
      const expectedFileName = `gk2a_ami_${outputLevel.toLowerCase()}_${dataType.toLowerCase()}_${dataCoverage.toLowerCase()}020ge_${availFile.date}_${time.utcToKst(availFile.utcDate).toISOString().slice(0, 16).replace(/[-T:]/g, '')}.nc`;
      return !folderFiles[kstFolder].includes(expectedFileName);
    });

    console.log(`Found ${filesToDownload.length} new files to download for ${outputLevel}/${dataType}/${dataCoverage}`);

    for (const fileToDownload of filesToDownload) {
      const savedPath = await api.fetchAndSaveNcFile(outputLevel, dataType, dataCoverage, fileToDownload.date);
      console.log(`Downloaded and saved: ${savedPath}`);
    }
  } catch (error) {
    console.error(`Error processing ${outputLevel}/${dataType}/${dataCoverage}: ${error.message}`);
  }
}

// 스케줄 등록
downloadConfigs.forEach(config => {
  const { outputLevel, dataType, dataCoverage, interval } = config;
  schedule.scheduleTask(
    `${outputLevel}-${dataType}-${dataCoverage}`,
    interval,
    () => downloadLatestData(outputLevel, dataType, dataCoverage)
  );
});

console.log('Watcher started. Waiting for scheduled tasks...');