const fs = require('fs').promises;
const fsRaw = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises');

async function hasNonEmptyFile(filePath) {
  const stats = await fs.stat(filePath).catch(() => null);
  return Boolean(stats && stats.isFile() && stats.size > 0);
}

async function downloadStreamToFile(url, outputPath, options = {}) {
  const {
    overwrite = false,
    timeoutMs = 5 * 60 * 1000,
    headers = {}
  } = options;

  if (!overwrite && await hasNonEmptyFile(outputPath)) {
    return { path: outputPath, skipped: true };
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const partialPath = `${outputPath}.partial`;
  await fs.rm(partialPath, { force: true }).catch(() => {});

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: timeoutMs,
    headers
  });

  await pipeline(
    response.data,
    fsRaw.createWriteStream(partialPath)
  );

  const stats = await fs.stat(partialPath);
  if (!stats.isFile() || stats.size === 0) {
    await fs.rm(partialPath, { force: true }).catch(() => {});
    throw new Error(`Downloaded file is empty: ${outputPath}`);
  }

  await fs.rename(partialPath, outputPath);
  return {
    path: outputPath,
    skipped: false,
    size: stats.size,
    status: response.status,
    headers: response.headers
  };
}

module.exports = {
  downloadStreamToFile,
  hasNonEmptyFile
};
