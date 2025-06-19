const api = require('./services/api');
const file = require('./utils/file');
const time = require('./utils/time');
const schedule = require('./services/scheduler');
const { TIMEZONE } = require('./config/env');

// 다운로드할 파라미터 조합 정의
const downloadConfigs = [
  { outputLevel: 'LE1B', dataType: 'IR105', dataCoverage: 'EA', interval: '10min' },
  { outputLevel: 'LE1B', dataType: 'IR105', dataCoverage: 'FD', interval: '10min' },
  { outputLevel: 'LE1B', dataType: 'IR105', dataCoverage: 'KO', interval: '2min' },
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
    // let sDate = new Date(now.getTime() - 60 * 60 * 1000); // 1시간 전
    let sDate = new Date(now.getTime() - 60 * 60 * 6000); // 6시간 전
    if(dataCoverage === 'KO'){
      // sDate = new Date(now.getTime() - 60 * 4 * 1000); // 4분전
      sDate = new Date(now.getTime() - 60 * 60 * 1000); // 1시간 전
    }
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
    // const filesToDownload = availableFiles.filter(availFile => {
    //   const kstFolder = time.getKstFolderDate(availFile.utcDate);
    //   // const expectedFileName = `gk2a_ami_${outputLevel.toLowerCase()}_${dataType.toLowerCase()}_${dataCoverage.toLowerCase()}020ge_${availFile.date}_${availFile.kstDate}.nc`;
    //   const expectedFileNamePattern = new RegExp(`gk2a_ami_${outputLevel.toLowerCase()}_${dataType.toLowerCase()}_${dataCoverage.toLowerCase()}020(ge|lc)_${availFile.date}_${availFile.kstDate}.nc`);
    //   console.log(expectedFileName)
    //   // return !folderFiles[kstFolder].includes(expectedFileName);
    //   return folderFiles[kstFolder].every(fname => {
    //     return !expectedFileNamePattern.test(fname)
    //   })
    // });
    // 공통 패턴을 밖에서 정의 (outputLevel 등이 고정값일 경우)
    const patternBase = `gk2a_ami_${outputLevel.toLowerCase()}_${dataType.toLowerCase()}_${dataCoverage.toLowerCase()}020(ge|lc)`;

    const filesToDownload = availableFiles.filter(availFile => {
      const kstFolder = time.getKstFolderDate(availFile.utcDate);
      const fileNameRegex = new RegExp(`${patternBase}_${availFile.date}_${availFile.kstDate}.nc`);
      
      const existingFiles = folderFiles[kstFolder] || [];
      return existingFiles.every(fileName => !fileNameRegex.test(fileName));
    });

    console.log(`Found ${filesToDownload.length} new files to download for ${outputLevel}/${dataType}/${dataCoverage}`);

    const sleep = (interval=1000) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve();
        }, interval)
      })
    }

    for (const fileToDownload of filesToDownload) {
      const savedPath = await api.fetchAndSaveNcFile(outputLevel, dataType, dataCoverage, fileToDownload.date);
      console.log(`Downloaded and saved: ${savedPath}`);
      await sleep(1000)
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