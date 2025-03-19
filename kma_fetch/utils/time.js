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
  generateFileName,
  getUtcNow,
  utcToKst,
  kstToUtc,
};