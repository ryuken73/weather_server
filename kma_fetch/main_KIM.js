const api = require('./services/api');
const file = require('./utils/file');
const time = require('./utils/time');
const { spawn } = require('child_process');
const schedule = require('./services/scheduler');
const path = require('path'); // 경로 조합을 위해 필수 추가
const { 
    NODE_ENV, 
    TIMEZONE, 
    API_ENDPOINT_KIM, 
    KIM_PSL_PNG_GENERATOR, 
    BASE_DIR, 
    OUT_PATH_KIM 
} = require('./config/env'); // BASE_DIR 추가

// 예측 시간(ef) 목록 생성: 000부터 372까지 3시간 간격 (총 125개)
const KIM_EF_LIST = Array.from({ length: 125 }, (_, i) => String(i * 3).padStart(3, '0'));

// 보간 image makes
function generateKimPng(inDir, tmfc) {
  return new Promise((resolve, reject) => {
    console.log(`[KIM-PNG] Starting PNG generation for tmfc: ${tmfc}`);
    
    // 파이썬 스크립트 경로
    // const pythonScript = path.join(__dirname, KIM_PSL_PNG_GENERATOR);
    
    const pythonProcess = spawn('python', [
      '-u', // Python 출력 버퍼링 해제
      KIM_PSL_PNG_GENERATOR,
      '--in_dir', inDir,
      '--tmfc', tmfc,
      '--max_hours', '372', // 필요 시 설정 변경
      '--interval', '10',   // 10분 간격
      '--workers', '8'      // 8개 워커
    ], {
      // 핵심: Node.js의 환경변수를 파이썬으로 직접 넘겨줍니다.
      env: {
        ...process.env,               // 기존 시스템 환경변수 상속
        ENV: NODE_ENV || 'dev',       // Python의 os.getenv("ENV") 에 대응
        OUT_PATH_KIM: OUT_PATH_KIM    // 파이썬에서 os.getenv("OUT_PATH_KIM")으로 바로 읽힘
      }        
    });

    pythonProcess.stdout.on('data', (data) => {
      console.log(`[Python] ${data.toString().trim()}`);
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error(`[Python Err] ${data.toString().trim()}`);
    });

    pythonProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`[KIM-PNG] Successfully generated PNGs for tmfc: ${tmfc}`);
        resolve();
      } else {
        reject(new Error(`Python process exited with code ${code}`));
      }
    });
  });
}

// 다운로드할 파라미터 조합 정의 (KIM 전용)
const downloadConfigs = [
  { 
    baseUrl: API_ENDPOINT_KIM,
    dataType: 'kim', 
    subDirName: 'easia', 
    compressed: false, // nc 파일은 압축 해제 불필요
    params: {
      sub: 'etc' // 아시아 국지 데이터
    },
    fileExt: 'nc',
    mkUrl: api.mkUrl, 
    getCandidate: api.mkKimFetchCandidate, 
    candiateCount: 2, // 최근 2개의 분석시간(tmfc) 확인
    delayHours: 12,   // KIM 데이터 지연 시간
    interval: '1min'  // 스케줄러 간격
  }
];

/**
 * 주어진 파라미터로 사용 가능한 최신 KIM 데이터를 확인하고 다운로드
 */
async function downloadLatestKimData(config) {
  const {
    baseUrl,
    dataType, 
    subDirName,
    compressed,
    params,
    fileExt,
    getCandidate, 
    candiateCount,
    delayHours
  } = config;

  try {
    // 1. 후보 tmfc(분석시간) 가져오기 (예: ['2026040212', '2026040206'])
    const timeCandidates = getCandidate(delayHours, candiateCount);
    console.log(`[KIM] Fetching candidates:`, timeCandidates);

    const folderFiles = {};
    for (const tmfc of timeCandidates) {
      // YYYYMMDDHH 포맷에서 YYYY-MM-DD 폴더명 추출
      const dateStringForFolder = `${tmfc.substring(0, 4)}-${tmfc.substring(4, 6)}-${tmfc.substring(6, 8)}`;
      
      if (!folderFiles[dateStringForFolder]) {
        // file.js 구조상 BASE_DIR 하위에 'g576' 폴더를 만들기 위해 dataType을 subDirName 인자로 넘김
        folderFiles[dateStringForFolder] = await file.listFiles(dateStringForFolder, TIMEZONE, dataType)
                                            .catch(() => []); // 폴더가 없으면 빈 배열 반환
      }
    }

    const sleep = (interval = 1000) => new Promise(resolve => setTimeout(resolve, interval));

    // 다운로드 정보를 모아둘 배열과 카운터 선언
    const updatedTmfcs = []; 
    let totalDownloadedCount = 0;

    // 2. 분석시간(tmfc)별로 예측시간(ef) 루프
    for (const tmfc of timeCandidates) {
      let currentTmfcNewFiles = 0; // 해당 tmfc의 신규 다운로드 카운터
      const dateStringForFolder = `${tmfc.substring(0, 4)}-${tmfc.substring(4, 6)}-${tmfc.substring(6, 8)}`;
      const existingFiles = folderFiles[dateStringForFolder] || [];
      
      // Python 스크립트에 넘겨줄 실제 nc 파일 폴더 경로 생성
      const targetDir = path.join(BASE_DIR, dataType, dateStringForFolder);

      for (const ef of KIM_EF_LIST) {
        // 다운로드 파일명 패턴: g576_v091_easia_etc.2byte.ft000.2026040212.nc
        const expectedFileName = `g576_v091_${subDirName}_${params.sub}.2byte.ft${ef}.${tmfc}.${fileExt}`;
        
        // 이미 폴더에 존재하는 파일이면 스킵
        if (existingFiles.includes(expectedFileName)) continue;

        // URL 파라미터 조합
        const currentParams = { ...params, ef };
        const fetchUrl = api.mkUrl[dataType](baseUrl, tmfc, currentParams);

        try {
          const { response, originalFileName } = await api.fetchFile(fetchUrl);
          
          // API 헤더에 filename이 없을 경우 expectedFileName으로 대체
          const saveFilename = originalFileName || expectedFileName;
          console.log(`[KIM] Found file to save:`, saveFilename);
          
          // 파일 저장
          const savedPath = await file.saveFile(
            response.data, 
            saveFilename, 
            dateStringForFolder, 
            dataType, 
            compressed
          );
          
          console.log(`[KIM] File saved!`, savedPath);
          currentTmfcNewFiles++;
          totalDownloadedCount++;
        } catch (err) {
          // 404 에러 등 파일이 아직 생성되지 않은 경우 조용히 다음으로 넘어감
          continue; 
        }

        // 공공데이터포털 API 부하 방지
        await sleep(10000); 
      } // -- ef 루프 끝 --

      // 현재 분석시간(tmfc)에 새로 받은 파일이 있다면 일괄 처리 목록에 추가
      if (currentTmfcNewFiles > 0) {
        updatedTmfcs.push({ tmfc, targetDir, newFilesCount: currentTmfcNewFiles });
      }
    } // -- tmfc 루프 끝 --

    // 3. 다운로드가 모두 완료된 후 일괄 PNG 생성 실행
    if (updatedTmfcs.length > 0) {
      console.log(`[KIM] 모든 다운로드 완료 (총 ${totalDownloadedCount}개 파일). PNG 일괄 변환을 시작합니다.`);
      
      for (const target of updatedTmfcs) {
        console.log(`[KIM-PNG] ${target.tmfc} 변환 시작 (신규 파일: ${target.newFilesCount}개)`);
        try {
          // 파이썬 스크립트 대기 (한 번에 하나씩 순차 처리하여 서버 부하 방지)
          await generateKimPng(target.targetDir, target.tmfc);
        } catch (err) {
          console.error(`[KIM-PNG] ${target.tmfc} 변환 중 오류 발생:`, err);
        }
      }
      console.log(`[KIM] 모든 PNG 변환 작업이 완료되었습니다!`);
    } else {
      console.log(`[KIM] No new files to download at this time.`);
    }

  } catch (error) {
    console.error(`[KIM] Error in download task:`, error);
  }
}

// 스케줄 등록
// downloadConfigs.forEach(config => {
//   const { dataType, interval } = config;
//   schedule.scheduleTask(
//     `${dataType}-${interval}`,
//     interval,
//     () => downloadLatestKimData(config)
//   );
// });

// 테스트용 즉시 실행 (필요시 주석 해제)
downloadLatestKimData(downloadConfigs[0]);

console.log('KIM Watcher started. Waiting for scheduled tasks...');