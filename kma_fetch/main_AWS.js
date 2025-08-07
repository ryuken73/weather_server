const db = require('./utils/db');
const sql = require('mssql');
const api = require('./services/api');
const file = require('./utils/file');
const time = require('./utils/time');
const schedule = require('./services/scheduler');
const { TIMEZONE } = require('./config/env');

// 다운로드할 파라미터 조합 정의
const downloadConfigs = [
  { 
    dataType: 'AWS_MIN', 
    subDirName: 'aws', 
    compressed: false,
    fileExt: 'json',
    getCandidate: api.mkFetchCandidate, 
    candiateCount:5,
    candidateMinute: 2,
    interval: '2min'
  },
];

/**
 * 주어진 파라미터로 사용 가능한 최신 파일을 확인하고 다운로드
 * @param {string} outputLevel
 * @param {string} dataType
 * @param {string} dataCoverage
 */

async function downloadLatestData(config) {
  const {
    // baseUrl,
    // dataType, 
    subDirName,
    compressed,
    // params,
    fileExt,
    getCandidate, 
    candiateCount,
    candidateMinute
  } = config
  try {


    // await pool.close();
    const timeCandidatesRaw = getCandidate(candidateMinute, candiateCount);
    const [first, second, ...timeCandidates] = timeCandidatesRaw;
    console.log(timeCandidates)

    const folderFiles = {};
    for (const timeCandidate of timeCandidates) {
      const kstTimeString = time.getDateString(timeCandidate) 
      if (!folderFiles[kstTimeString]) {
        folderFiles[kstTimeString] = await file.listFiles(kstTimeString, TIMEZONE, subDirName);
      }
    }

    const patternBase = `AWS_MIN_`;
    const timesToDownload = timeCandidates.filter(timeCandidate => {
      const kstTimeString = time.getDateString(timeCandidate);
      const fileNameRegex = new RegExp(`${patternBase}_${kstTimeString}.${fileExt}`);
      
      const existingFiles = folderFiles[kstTimeString] || [];
      return existingFiles.every(fileName => !fileNameRegex.test(fileName));
    });

    console.log(`Found ${timesToDownload.length} new files to download for AWS`);
    console.log(timesToDownload);

    const sleep = (interval=1000) => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve();
        }, interval)
      })
    }

    const pool = await db.connect();
    for await (const timeToDownload of timesToDownload) {
      console.log('download AWS tm =', timeToDownload)
      try {
        const originalFileName = `${patternBase}${timeToDownload}.json`
        const saveFilename = compressed ? file.uncompressedFname(originalFileName, compressed):originalFileName;
        const dateStringForFolder = time.getDateString(timeToDownload)
        const [fileExists, filePath] = await file.isFileExists(saveFilename, dateStringForFolder, subDirName);
        if(fileExists){
          console.log('skip!! file alreay exists for tm', timeToDownload);
          continue;
        }
        // get db records
        const result = await pool.request()
          .input('tm', sql.VarChar, timeToDownload)
          .query(db.sqls.queryAwsMin);
        // console.log(result)
        const jsonData = result.recordset;
        if(jsonData.length === 0){
          console.log('no data to save.', timeToDownload)
          continue;
        }
        console.log('data to save. length =', jsonData.length)
        const savedPath = await file.saveFile(JSON.stringify(jsonData), saveFilename, dateStringForFolder, subDirName, compressed);
        console.log('File saved!', savedPath)
      } catch (err) {
        console.error(err)
        continue
      }
      await sleep(1000)
    }
    await pool.close();
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