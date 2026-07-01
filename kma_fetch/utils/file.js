const fs = require('fs').promises;
const zlib = require('zlib');
const fsRaw = require('fs');
const path = require('path');
const env = require('../config/env');
const time = require('./time');
const { DateTime } = require('luxon');
const { pipeline } = require('stream/promises');

// 기본 디렉토리 설정
const BASE_DIR = env.BASE_DIR;
const DATA_ROOT_NAMES = new Set(['in_data', 'out_data']);

function resolveBaseDir(dataRoot) {
  if (!dataRoot) {
    return BASE_DIR;
  }

  const normalizedBaseDir = path.normalize(BASE_DIR);
  const baseName = path.basename(normalizedBaseDir);

  if (DATA_ROOT_NAMES.has(baseName)) {
    return path.join(path.dirname(normalizedBaseDir), dataRoot);
  }

  return path.join(normalizedBaseDir, dataRoot);
}

/**
 * KST 날짜에 맞는 디렉토리를 생성하거나 확인
 * @param {Date} utcDate - UTC 시간의 Date 객체
 * @returns {string} - 생성된 디렉토리 경로
 */
async function ensureDirectory(date, timeZone, subDirName, options = {}) {
  const kstFolder = timeZone ? date : time.getKstFolderDate(date); // "2022-10-28"
  const baseDir = resolveBaseDir(options.dataRoot);
  const dirPath = path.join(baseDir, subDirName || 'gk2a', kstFolder);
  console.log(timeZone, date, dirPath, kstFolder)
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

/**
 * .nc 파일을 원본 파일명에 KST 시간을 추가해 저장
 * @param {Buffer} data - API에서 받은 파일 데이터
 * @param {string} originalFileName - Content-Disposition에서 추출한 원본 파일명
 * @param {Date} utcDate - UTC 시간의 Date 객체 (파일명에서 파싱된 시간)
 * @param {boolean} overwrite - 기존 파일 덮어쓰기 여부 (기본값: false)
 * @returns {string} - 저장된 파일의 전체 경로
 */
async function saveNcFile(data, originalFileName, utcDate, overwrite = false, options = {}) {
  const dirPath = await ensureDirectory(utcDate, undefined, options.subDirName, options);

  // 원본 파일명에서 확장자 분리
  const baseName = originalFileName.replace(/\.nc$/, ''); // "gk2a_ami_le2_ci_ela020ge_202210272350"
  // const kstStr = time.utcToKst(utcDate).toISOString().slice(0, 16).replace(/[-T:]/g, ''); // "202210280850"
  const kstStr = DateTime.fromJSDate(utcDate, { zone: 'UTC' })
    .setZone('Asia/Seoul')
    .toFormat('yyyyMMddHHmm'); // 직접 변환 보장
  const newFileName = `${baseName}_${kstStr}.nc`; // "gk2a_ami_le2_ci_ela020ge_202210272350_202210280850.nc"

  const filePath = path.join(dirPath, newFileName);

  // 파일 존재 여부 체크
  const fileExists = await fs.stat(filePath).catch(() => false);
  if (fileExists && !overwrite) {
    console.log(`File already exists: ${filePath}, skipping...`);
    return filePath;
  }

  await fs.writeFile(filePath, data);
  console.log(`Saved file: ${filePath}`);
  return filePath;
}

async function isFileExists(saveFileName, dateStringForFolder, subDirName, options = {}) {
  console.log('saveFile', saveFileName)
  const dirPath = await ensureDirectory(dateStringForFolder, env.TIMEZONE, subDirName, options);
  const filePath = path.join(dirPath, saveFileName);
  const fileExists = await fs.stat(filePath).catch(() => false);
  return [fileExists, filePath];
}

async function saveFile(data, saveFileName, dateStringForFolder, subDirName, compressed, overwrite=false, options = {}){
  console.log('saveFile', saveFileName)
  // const fileExists = await fs.stat(filePath).catch(() => false);
  // const dirPath = await ensureDirectory(dateStringForFolder, env.TIMEZONE, subDirName);
  // const filePath = path.join(dirPath, saveFileName);
  const [fileExists, filePath] = await isFileExists(saveFileName, dateStringForFolder, subDirName, options);
  if (fileExists && !overwrite) {
    console.log(`File already exists: ${filePath}, skipping...`);
    return filePath;
  }
  if(compressed){
    const gunzip = zlib.createGunzip();
    const fileStream = fsRaw.createWriteStream(filePath);
    console.log('compressed. save uncompress file', filePath, typeof(data))
    await pipeline(
      data,
      gunzip,
      fileStream
    )
  } else {
    console.log('not compressed. save original file', filePath)
    await fs.writeFile(filePath, data);
  }
  console.log(`Saved file: ${filePath}`);
  return filePath;
}

/**
 * 특정 KST 날짜 폴더의 파일 목록 반환
 * @param {Date} utcDate - UTC 시간의 Date 객체
 * @returns {string[]} - 해당 폴더 내 파일 목록
 */
async function listFiles(date, timeZone, subDirName, options = {}) {
  const dirPath = await ensureDirectory(date, timeZone, subDirName, options);
  const files = await fs.readdir(dirPath);
  return files;
}

function uncompressedFname(originalFileName, compressExt){
  return originalFileName.replace('.'+compressExt, '');
}

module.exports = {
  ensureDirectory,
  saveNcFile,
  isFileExists,
  saveFile,
  listFiles,
  uncompressedFname,
  resolveBaseDir
};
