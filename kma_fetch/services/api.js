const axios = require('axios');
const env = require('../config/env');
const file = require('../utils/file');
const time = require('../utils/time');
const { DateTime } = require('luxon');

// 환경 변수
const BASE_URL = env.API_ENDPOINT;
const BASE_URL_RDR = env.API_ENDPOINT_RDR;
const API_KEY = env.API_KEY;
const LOG_LEVEL = env.LOG_LEVEL || 'info';

/**
 * 파일명에서 UTC 시간을 파싱하여 Date 객체로 반환
 * @param {string} fileName - 원본 파일명 (예: "gk2a_ami_le1b_nr016_fd020ge_202210272350.nc")
 * @returns {Date} - UTC 시간의 Date 객체
 */
function parseUtcDateFromFileName(fileName) {
  const match = fileName.match(/(\d{12})\.nc$/); // "202210272350" 추출
  if (!match) throw new Error(`Invalid filename format: ${fileName}`);
  const utcStr = match[1]; // "202210272350"
  return DateTime.fromFormat(utcStr, 'yyyyMMddHHmm', { zone: 'UTC' }).toJSDate();
}

/**
 * 파일명에서 KST 시간을 파싱하여 Date 객체로 반환
 * @param {string} fileName - 원본 파일명 
 * @returns {Date} - KST 시간의 Date 객체
 */
function parseKstDateFromFileName(fileName, fileExt) {
  const match = fileName.match(/(\d{12})\.bin$/); // "202210272350" 추출
  if (!match) throw new Error(`Invalid filename format: ${fileName}`);
  const kstStr = match[1]; // "202210272350"
  return DateTime.fromFormat(kstStr, 'yyyyMMddHHmm', { zone: 'KST' }).toJSDate();
}

/**
 * 데이터 fetch API로 .nc 파일을 가져와 저장
 * @param {string} outputLevel - "LE1B" 또는 "L1B"
 * @param {string} dataType - "IR105", "NR016" 등
 * @param {string} dataCoverage - "FD", "EA", "KO"
 * @param {string} date - "yyyymmddHHMM" 형식의 UTC 시간
 * @returns {string} - 저장된 파일 경로
 */
async function fetchAndSaveNcFile(outputLevel, dataType, dataCoverage, date) {
  const url = `${BASE_URL}/${outputLevel}/${dataType}/${dataCoverage}/data?date=${date}&authKey=${API_KEY}`;

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer', // 바이너리 데이터 처리
    });

    // Content-Disposition에서 파일명 추출
    if(LOG_LEVEL==='debug'){
      console.log('response.status=',response.status)
    }
    const contentDisposition = response.headers['content-disposition'];
    if (!contentDisposition) {
      throw new Error('Content-Disposition header not found');
    }
    const fileNameMatch = contentDisposition.match(/filename="(.+?)"/);
    if (!fileNameMatch) {
      throw new Error(`Invalid Content-Disposition: ${contentDisposition}`);
    }
    const originalFileName = fileNameMatch[1]; // "gk2a_ami_le1b_nr016_fd020ge_202210272350.nc"

    // 파일명에서 UTC 시간 파싱
    const kstDate = parseUtcDateFromFileName(originalFileName);

    // 파일 저장
    const savedPath = await file.saveNcFile(response.data, originalFileName, kstDate);
    return savedPath;
  } catch (error) {
    console.error(`Error fetching or saving file from ${url}: ${error.message}`);
    throw error;
  }
}

async function fetchFile(fetchUrl) {
  try {
    const response = await axios.get(fetchUrl, {
      responseType: 'stream', // 바이너리 데이터 처리
      headers: {
        'Accept-Encoding': 'gzip'
      }
    });

    // Content-Disposition에서 파일명 추출
    const contentDisposition = response.headers['content-disposition'];
    if (!contentDisposition) {
      throw new Error('Content-Disposition header not found');
    }
    const fileNameMatch = contentDisposition.match(/filename=(.*)/);
    if (!fileNameMatch) {
      throw new Error(`Invalid Content-Disposition: ${contentDisposition}`);
    }
    const originalFileName = fileNameMatch[1]; // "gk2a_ami_le1b_nr016_fd020ge_202210272350.nc"
    return {response, originalFileName}

  } catch (error) {
    console.error(`Error fetching or saving file from ${fetchUrl}: ${error.message}`);
    throw error;
  }
}

/**
 * 리스트 fetch API로 sDate ~ eDate 사이의 파일 목록 가져오기
 * @param {string} outputLevel - "LE1B" 또는 "L1B"
 * @param {string} dataType - "IR105", "NR016" 등
 * @param {string} dataCoverage - "FD", "EA", "KO"
 * @param {Date} sDate - 시작 날짜 (UTC)
 * @param {Date} eDate - 종료 날짜 (UTC)
 * @returns {Object[]} - 파일 정보 배열 [{date, utcDate}, ...]
 */
async function fetchFileList(outputLevel, dataType, dataCoverage, sDate, eDate) {
  const sDateStr = DateTime.fromJSDate(sDate, { zone: 'UTC' }).toFormat('yyyyMMddHHmm');
  const eDateStr = DateTime.fromJSDate(eDate, { zone: 'UTC' }).toFormat('yyyyMMddHHmm');
  const url = `${BASE_URL}/${outputLevel}/${dataType}/${dataCoverage}/dataList?sDate=${sDateStr}&eDate=${eDateStr}&authKey=${API_KEY}`;

  try {
    const response = await axios.get(url);
    const fileList = response.data.list; // {"list":[{"item":"202210272300"}, ...]}

    return fileList.map(file => {
      const date = file.item; // "202210272300"
      const utcDate = DateTime.fromFormat(date, 'yyyyMMddHHmm', { zone: 'UTC' }).toJSDate();
      const kstDate = DateTime.fromFormat(date, 'yyyyMMddHHmm', { zone: 'UTC' }).setZone(env.TIMEZONE).toFormat('yyyyMMddHHmm');
      return { date, utcDate, kstDate };
    });
  } catch (error) {
    console.error(`Error fetching file list from ${url}: ${error.message}`);
    throw error;
  }
}

const mkUrl = {
  'RDR': (baseUrl, tm, params) => {
    const {cmp} = params;
    return `${baseUrl}/rdr_cmp_file.php?tm=${tm}&data=bin&cmp=${cmp}&authKey=${API_KEY}`;
  }
}

const mkFetchCandidate = (everyMinute, count) => {
  // 현재 시간을 기준으로 설정
  const now = new Date();
  
  // 가장 최근의 everyMinute 간격 시간 계산
  const minutes = now.getMinutes();
  const remainder = minutes % everyMinute;
  let baseMinutes;
  
  // 현재 시간이 everyMinute 간격이 아니면 직전 간격으로 조정
  if (remainder === 0) {
    baseMinutes = minutes;
  } else {
    baseMinutes = minutes - remainder;
  }
  
  const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), baseMinutes);

  const result = [];
  
  // count만큼 반복하며 시간 문자열 생성
  for (let i = 0; i < count; i++) {
    const currentTime = new Date(baseDate.getTime() - (i * everyMinute * 60 * 1000));
    
    // YYYYMMDDHHMM 형식으로 포맷
    const timeString = currentTime.getFullYear().toString() +
      String(currentTime.getMonth() + 1).padStart(2, '0') +
      String(currentTime.getDate()).padStart(2, '0') +
      String(currentTime.getHours()).padStart(2, '0') +
      String(currentTime.getMinutes()).padStart(2, '0');
    
    result.push(timeString);
  }
  
  return result;
}

module.exports = {
  fetchAndSaveNcFile,
  fetchFileList,
  fetchFile,
  mkFetchCandidate,
  mkUrl,
};