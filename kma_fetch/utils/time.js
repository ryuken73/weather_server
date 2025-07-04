const { DateTime } = require('luxon');
const env = require('../config/env');

// 시간대 설정 (env에서 가져옴)
const TIMEZONE = env.TIMEZONE;

/**
 * UTC Date 객체를 받아 KST 기준 yyyy-MM-dd 형식으로 변환
 * @param {Date} utcDate - UTC 시간의 Date 객체
 * @returns {string} - KST 기준 "yyyy-MM-dd"
 */
function getKstFolderDate(utcDate) {
  return DateTime.fromJSDate(utcDate, { zone: 'UTC' })
    .setZone(TIMEZONE)
    .toFormat('yyyy-MM-dd');
}

function getDateString(yyyyMMddHHmm) {
  const year = yyyyMMddHHmm.slice(0, 4);
  const month = yyyyMMddHHmm.slice(4, 6); 
  const day = yyyyMMddHHmm.slice(6, 8);
  return `${year}-${month}-${day}`
}

/**
 * UTC Date 객체를 받아 UTC와 KST를 포함한 파일명 생성
 * @param {Date} utcDate - UTC 시간의 Date 객체
 * @returns {string} - "yyyymmddhhMM_yyyymmddhhMM.nc"
 */
function generateFileName(utcDate) {
  const utcStr = DateTime.fromJSDate(utcDate, { zone: 'UTC' }).toFormat('yyyyMMddHHmm');
  const kstStr = DateTime.fromJSDate(utcDate, { zone: 'UTC' })
    .setZone(TIMEZONE)
    .toFormat('yyyyMMddHHmm');
  return `${utcStr}_${kstStr}.nc`;
}

/**
 * 현재 UTC 시간을 반환
 * @returns {Date} - 현재 UTC 시간의 Date 객체
 */
function getUtcNow() {
  return new Date();
}
function getKstNow() {
  const utcNow = getUtcNow();
  return utcToKst(utcNow);
}
function jsDateToString(jsDate) {
  return DateTime.fromJSDate(jsDate, { zone: TIMEZONE }).toFormat('yyyyMMddHHmm');
}

/**
 * UTC 시간을 KST로 변환
 * @param {Date} utcDate - UTC 시간의 Date 객체
 * @returns {Date} - KST 시간의 Date 객체
 */
function utcToKst(utcDate) {
  return DateTime.fromJSDate(utcDate, { zone: 'UTC' })
    .setZone(TIMEZONE)
    .toJSDate();
}

/**
 * KST 시간을 UTC로 변환
 * @param {Date} kstDate - KST 시간의 Date 객체
 * @returns {Date} - UTC 시간의 Date 객체
 */
function kstToUtc(kstDate) {
  return DateTime.fromJSDate(kstDate, { zone: TIMEZONE })
    .setZone('UTC')
    .toJSDate();
}

module.exports = {
  getKstFolderDate,
  getDateString,
  generateFileName,
  getUtcNow,
  getKstNow,
  jsDateToString,
  utcToKst,
  kstToUtc,
};