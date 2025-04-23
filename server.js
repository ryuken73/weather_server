const fastify = require('fastify')({ logger: false });
const path = require('path');
const fs = require('fs/promises');
const {addHours, format, parse} = require('date-fns');
const { Pool } = require('pg');
require('dotenv').config(); // .env 파일 로드

// 데이터 압축 플러그인 등록
// fastify.register(require('@fastify/compress'), { 
//   global: true ,
//   threshold: 1024, // 최소 1KB 이상 데이터에 대해 압축 (기본값은 1024)
//   encodings: ['gzip', 'deflate', 'br'], // 지원하는 압축 형식 명시  
// }).after(() => {
//   fastify.log.info('Compression plugin registered')
// });
fastify.register(require('@fastify/cors'), {
  origin: '*'
})

const mode = process.env.MODE || 'dev';
const dataDir = mode === 'prod' ? process.env.ROOT_DIR_PROD : process.env.ROOT_DIR_DEV 
console.log(`MODE: ${mode}`);
console.log(`DATA DIR: ${dataDir}`);

// 데이터베이스 연결 설정
const dbConfig = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
};


// PostgreSQL 풀 생성
const pool = new Pool(dbConfig);

// (async () => {
//   console.time('query');
//   const result = await pool.query(
//     'SELECT observation_time_kor, data FROM ir105_json WHERE observation_area = $1 AND step = $2 AND observation_time_kor = ANY($3)',
//     ['ea', 10, Array.from({ length: 100 }, (_, i) => `2025-03-01T${String(Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00Z`)],
//   );
//   console.timeEnd('query');
//   console.log('Rows:', result.rows.length);
// })();


const convertGMTToKSTString = (dateString) => {
  // 입력 문자열을 Date 객체로 파싱
  // parse 함수는 형식 패턴을 사용해 문자열을 해석
  const gmtDate = parse(dateString, 'yyyyMMddHHmm', new Date());
  // KST는 UTC+9이므로 9시간 추가
  const kstDate = addHours(gmtDate, 9);
  // 변환된 시간을 yymmddHHmm 형식으로 포매팅
  const kstString = format(kstDate, 'yyyyMMddHHmm');
  return kstString;
}

const convertKSTToGMTString = (dateString) => {
  // 입력 문자열을 Date 객체로 파싱
  // parse 함수는 형식 패턴을 사용해 문자열을 해석
  const kstDate = parse(dateString, 'yyyyMMddHHmm', new Date());
  // KST는 UTC+9이므로 9시간 추가
  const gmtDate = addHours(kstDate, -9);
  // 변환된 시간을 yymmddHHmm 형식으로 포매팅
  const gmtString = format(gmtDate, 'yyyyMMddHHmm');
  return gmtString;
}

(async () => {
  await fastify.register(require('@fastify/compress'), { global: true}).after(() => {
    fastify.log.info('Compression plugin registered')
  });
  fastify.register(require('@fastify/static'), {
    root: dataDir,
    prefix: '/weather/'
  })
  // 엔드포인트 설정: /ir105/:area/:step?timestamp_kor=...
  fastify.get('/ir105/:area/:step', async (request, reply) => {
    const { area, step } = request.params; // URL 파라미터
    const { timestamp_kor } = request.query; // 쿼리 파라미터

    // 필수 파라미터 검증
    if (!timestamp_kor) {
      return reply.code(400).send({ error: 'timestamp_kor query parameter is required' });
    }

    try {
      // 데이터베이스 쿼리
      const query = `
        SELECT * 
        FROM ir105_json 
        WHERE observation_area = $1 
          AND step = $2 
          AND observation_time_kor = $3
      `;
      const values = [area, step, timestamp_kor];

      const result = await pool.query(query, values);

      // 결과가 없는 경우
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'No data found for the given parameters' });
      }

      // 결과 반환 (JSON 데이터 포함)
      return reply.send(result.rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error', details: err.message });
    }
  });

  fastify.get('/ir105/:area/:step/batch', async (request, reply) => {
    const { area, step } = request.params;
    const { timestamps } = request.query; // 예: "2025-03-01T00:00:00Z,2025-03-01T00:10:00Z"
    const timestampArray = timestamps.split(',');

    try {
      const query = `
        SELECT observation_time_kor, data 
        FROM ir105_json 
        WHERE observation_area = $1 
          AND step = $2 
          AND observation_time_kor = ANY($3)
        ORDER BY observation_time_kor ASC
      `;
      const values = [area, step, timestampArray];
      console.time('query')
      const result = await pool.query(query, values);
      console.timeEnd('query')

      console.time('stringify');
      const jsonString = JSON.stringify(result.rows);
      console.timeEnd('stringify');

      reply.header('Content-Type', 'application/json');
      return jsonString;

      // return reply.send(result.rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
  fastify.get('/ir105/:area/:step/fs', async (request, reply) => {
    const { area, step } = request.params; // URL 파라미터
    const { timestamp_utc } = request.query; // 쿼리 파라미터
    // 필수 파라미터 검증
    if (!timestamp_utc) {
      return reply.code(400).send({ error: 'timestamp_kor query parameter is required' });
    }
    const jsonFileDir = 'd:/002.Code/001.python/netcdf/jsonfiles'
    const fileName = `gk2a_ami_le1b_ir105_${area}020lc_${timestamp_utc}_step${step}.json.gz`;
    const gzipFname = path.join(jsonFileDir, fileName);
    console.log('read', gzipFname)

    try {
      const data = await fs.readFile(gzipFname);

      reply.header('Content-Type', 'application/json');
      reply.header('Content-Encoding', 'gzip');
      return data;
    } catch (err) {
      fastify.log.error(err);
      if (err.code === 'ENOENT') {
          return reply.code(404).send({ error: 'File not found' });
        }
      throw err;
    }
  });

  fastify.get('/:type/:area/:step/image', async (request, reply) => {
    const { type, area, step } = request.params; // URL 파라미터
    const { timestamp_kor } = request.query; // 쿼리 파라미터
    // 필수 파라미터 검증
    if (!timestamp_kor) {
      return reply.code(400).send({ error: 'timestamp_kor query parameter is required' });
    }
    const [dataName, color] = type.split('-')
    const timestamp_utc = convertKSTToGMTString(timestamp_kor);
    const subdir = `${timestamp_kor.slice(0,4)}-${timestamp_kor.slice(4,6)}-${timestamp_kor.slice(6,8)}`
    const proj = area === 'ea' ? 'lc' : 'ge';
    const fileName = `gk2a_ami_le1b_${dataName}_${area}020${proj}_${timestamp_utc}_${timestamp_kor}_step${step}_${color}.png`;
    // const gzipFname = path.join(jsonFileDir, fileName);
    const fullName = path.join(dataDir, subdir, fileName);
    console.log('read', fileName)

    try {
      const data = await fs.readFile(fullName);

      reply.header('Content-Type', 'image/png');
      // reply.header('Content-Encoding', 'gzip');
      return data;
    } catch (err) {
      fastify.log.error(err);
      if (err.code === 'ENOENT') {
          return reply.code(404).send({ error: 'File not found' });
        }
      throw err;
    }
  });


  // 서버 시작
  const start = async () => {
    try {
      await fastify.listen({ port: 3010, host: '0.0.0.0' });
      fastify.log.info('Server running on http://localhost:3010');
    } catch (err) {
      console.log(err)
      fastify.log.error(err);
      process.exit(1);
    }
  };

  start();

})()
