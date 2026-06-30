const path = require('path');

function deriveKimTextDirs(baseDir) {
  const normalizedBase = baseDir || './data/weather';
  const baseName = path.basename(path.normalize(normalizedBase)).toLowerCase();
  const parentDir = path.dirname(normalizedBase);

  if (baseName === 'in_data') {
    return {
      inputDir: path.join(normalizedBase, 'kim'),
      outputDir: path.join(parentDir, 'out_data', 'kim')
    };
  }

  if (baseName === 'out_data') {
    return {
      inputDir: path.join(parentDir, 'in_data', 'kim'),
      outputDir: path.join(normalizedBase, 'kim')
    };
  }

  return {
    inputDir: path.join(normalizedBase, 'in_data', 'kim'),
    outputDir: path.join(normalizedBase, 'out_data', 'kim')
  };
}

module.exports = {
  deriveKimTextDirs
};
