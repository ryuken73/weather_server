const dotenv = require('dotenv');
const path = require('path');

// NODE_ENV에 따라 적절한 .env 파일 로드
const envMode = process.env.NODE_ENV || 'development'; // 기본값은 development
const envFile = `.env.${envMode}`; // 예: .env.development, .env.production
dotenv.config({ path: path.resolve(__dirname, '../../', envFile) });

const env = {
  NODE_ENV: envMode,
  API_KEY: process.env.API_KEY,
  BASE_DIR: process.env.BASE_DIR || './data/weather',
  API_ENDPOINT: process.env.API_ENDPOINT || 'https://apihub-pub.kma.go.kr/api/typ05/api/GK2A',
  TIMEZONE: process.env.TIMEZONE || 'Asia/Seoul',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

// 필수 변수 검증
if (!env.API_KEY){
  throw new Error('API_KEY must be provided via environment variable');
}
if (!env.BASE_DIR) {
  throw new Error('BASE_DIR is required in .env file');
}

console.log(`Running in ${env.NODE_ENV} mode with config:`, env);

module.exports = env;