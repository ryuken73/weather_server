const api = require('./services/api');
const file = require('./utils/file');
const time = require('./utils/time');
const schedule = require('./services/scheduler');
const { TIMEZONE, API_ENDPOINT_RDR } = require('./config/env');

console.log(TIMEZONE, API_ENDPOINT_RDR)

// 다운로드할 파라미터 조합 정의
const downloadConfigs = [
  { 
    baseUrl: API_ENDPOINT_RDR,
    dataType: 'RDR', 
    subDirName: 'rdr', 
    compressed: 'gz', 
    params: {
      cmp: 'hsp'
    },
    fileExt: 'bin',
    mkUrl: api.mkUrl, 
    getCandidate: api.mkFetchCandidate, 
    candiateCount: 2, // number of files which would be tried to fetch. default 2
    candidateMinute: 5,  // file generating interval. should be 5 for radar hsp
    interval: '5min'},
];

/**
 * 주어진 파라미터로 사용 가능한 최신 파일을 확인하고 다운로드
 * @param {string} outputLevel
 * @param {string} dataType
 * @param {string} dataCoverage
 */

async function downloadLatestData(config) {
  const {
    baseUrl,
    dataType, 
    subDirName,
    compressed,
    params,
    fileExt,
    getCandidate, 
    candiateCount,
    candidateMinute
  } = config
  try {
    const timeCandidates = getCandidate(candidateMinute, candiateCount);
    console.log(timeCandidates)

    const folderFiles = {};
    for (const timeCandidate of timeCandidates) {
      const kstTimeString = time.getDateString(timeCandidate) 
      if (!folderFiles[kstTimeString]) {
        folderFiles[kstTimeString] = await file.listFiles(kstTimeString, TIMEZONE, subDirName);
      }
    }

    const patternBase = `RDR_CMP_HSP_PUB_`;

    const timesToDownload = timeCandidates.filter(timeCandidate => {
      const kstTimeString = time.getDateString(timeCandidate);
      const fileNameRegex = new RegExp(`${patternBase}_${kstTimeString}.${fileExt}`);
      
      const existingFiles = folderFiles[kstTimeString] || [];
      return existingFiles.every(fileName => !fileNameRegex.test(fileName));
    });

    console.log(`Found ${timesToDownload.length} new files to download for RDR`);
    console.log(timesToDownload);

    const sleep = (interval=1000) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve();
        }, interval)
      })
    }

    for (const timeToDownload of timesToDownload) {
      const fetchUrl = api.mkUrl[dataType](baseUrl, timeToDownload, params);
      try {
        const {response, originalFileName} = await api.fetchFile(fetchUrl)
        console.log('found file to save!', originalFileName)
        const saveFilename = compressed ? file.uncompressedFname(originalFileName, compressed):originalFileName;
        const dateStringForFolder = time.getDateString(timeToDownload)
        const savedPath = await file.saveFile(response.data, saveFilename, dateStringForFolder, subDirName, compressed);
        console.log('File saved!', savedPath)
        
      } catch (err) {
        console.error(err)
        continue
      }
      await sleep(1000)
    }
  } catch (error) {
    console.error(error)
  }
}

// 스케줄 등록
downloadConfigs.forEach(config => {
  const { dataType, interval } = config;
  schedule.scheduleTask(
    `${dataType}-${interval}`,
    interval,
    () => downloadLatestData(config)
  );
});

// downloadLatestData(downloadConfigs[0])
console.log('Watcher started. Waiting for scheduled tasks...');