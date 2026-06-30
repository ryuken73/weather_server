const dotenv = require('dotenv');
const path = require('path');

// NODE_ENV에 따라 적절한 .env 파일 로드
const envMode = process.env.NODE_ENV || 'development'; // 기본값은 development
const envFile = `.env.${envMode}`; // 예: .env.development, .env.production
dotenv.config({ path: path.resolve(__dirname, '../', envFile) });

const env = {
  NODE_ENV: envMode,
  USE_API: process.env.USE_API || "true",
  API_KEY: process.env.API_KEY,
  BASE_DIR: process.env.BASE_DIR || './data/weather',
  API_ENDPOINT: process.env.API_ENDPOINT || 'https://apihub-pub.kma.go.kr/api/typ05/api/GK2A',
  API_ENDPOINT_RDR: process.env.API_ENDPOINT_RDR || 'https://apihub-pub.kma.go.kr/api/typ04/url',
  API_ENDPOINT_KIM: process.env.API_ENDPOINT_KIM || 'https://apihub-pub.kma.go.kr/api/typ06/url',
  API_ENDPOINT_KIM_TXT: process.env.API_ENDPOINT_KIM_TXT || 'https://apihub-pub.kma.go.kr/api/typ01/cgi-bin/url',
  OUT_PATH_KIM: process.env.OUT_PATH_KIM, 
  KIM_PSL_PNG_GENERATOR: process.env.KIM_PSL_PNG_GENERATOR || 'python/kim_png_generator.py',
  KIM_HGH_PNG_GENERATOR: process.env.KIM_HGH_PNG_GENERATOR || 'python/kim_hgt_png_generator.py',
  KIM_TEXT_PNG_GENERATOR: process.env.KIM_TEXT_PNG_GENERATOR || 'python/kim_hgt_text_sequence_generator.py',
  KIM_TEXT_MAX_HOURS: process.env.KIM_TEXT_MAX_HOURS || '72',
  KIM_TEXT_INTERVAL_MINUTES: process.env.KIM_TEXT_INTERVAL_MINUTES || '10',
  KIM_TEXT_DOWNSAMPLE_FACTOR: process.env.KIM_TEXT_DOWNSAMPLE_FACTOR || '3',
  KIM_TEXT_FORECAST_HOURS: process.env.KIM_TEXT_FORECAST_HOURS || '0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57,60,63,66,69,72',
  KIM_TEXT_CYCLE_HOURS: process.env.KIM_TEXT_CYCLE_HOURS || '0,6,12,18',
  KIM_TEXT_CANDIDATE_COUNT: process.env.KIM_TEXT_CANDIDATE_COUNT || '1',
  KIM_TEXT_DELAY_HOURS: process.env.KIM_TEXT_DELAY_HOURS || '12',
  TIMEZONE: process.env.TIMEZONE || 'Asia/Seoul',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  MSSQL_HOST: process.env.MSSQL_HOST,
  MSSQL_USER: process.env.MSSQL_USER,
  MSSQL_PASSWD: process.env.MSSQL_PASSWD,
  MSSQL_DB: process.env.MSSQL_DB
};

// 필수 변수 검증
if (env.USE_API === 'true' && !env.API_KEY){
  throw new Error('API_KEY must be provided via environment variable');
}
if (!env.BASE_DIR) {
  throw new Error('BASE_DIR is required in .env file');
}

console.log(`Running in ${env.NODE_ENV} mode with config:`, env);

module.exports = env;
