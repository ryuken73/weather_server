const api = require('./services/api');
const file = require('./utils/file');
const time = require('./utils/time');
const { spawn } = require('child_process');
const schedule = require('./services/scheduler');
const path = require('path');
const { 
    NODE_ENV, 
    TIMEZONE, 
    API_ENDPOINT_KIM, 
    KIM_PSL_PNG_GENERATOR, 
    BASE_DIR, 
    OUT_PATH_KIM 
} = require('./config/env');

// 🔥 [삭제] 기존의 고정된 KIM_EF_LIST 제거

// 💡 [추가] tmfc(분석시간)에 따라 동적으로 예측시간(ef) 배열과 최대 시간을 반환하는 헬퍼 함수
function getKimEfInfo(tmfc) {
  const hour = tmfc.substring(8, 10); // YYYYMMDDHH에서 HH 추출
  
  // 00시, 12시는 372시간 / 06시, 18시(기타)는 87시간
  const maxHours = (hour === '00' || hour === '12') ? 372 : 87;
  const count = Math.floor(maxHours / 3) + 1; // 3시간 간격 개수 계산
  
  const efList = Array.from({ length: count }, (_, i) => String(i * 3).padStart(3, '0'));
  
  return { efList, maxHours };
}

// 보간 image makes (🔥 maxHours 파라미터 추가)
function generateKimPng(inDir, tmfc, maxHours) {
  return new Promise((resolve, reject) => {
    console.log(`[KIM-PNG] Starting PNG generation for tmfc: ${tmfc} (Max: ${maxHours}h)`);
    
    const pythonProcess = spawn('python', [
      '-u', 
      KIM_PSL_PNG_GENERATOR,
      '--in_dir', inDir,
      '--tmfc', tmfc,
      '--max_hours', String(maxHours), // 🔥 고정값 '372' 대신 동적으로 할당된 값 사용
      '--interval', '10',   
      '--workers', '8'      
    ], {
      env: {
        ...process.env,               
        ENV: NODE_ENV || 'dev',       
        OUT_PATH_KIM: OUT_PATH_KIM    
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
    compressed: false, 
    params: {
      sub: 'etc' 
    },
    fileExt: 'nc',
    mkUrl: api.mkUrl, 
    getCandidate: api.mkKimFetchCandidate, 
    candiateCount: 1, 
    delayHours: 12,   
    interval: 'kim_custom'  
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
    const timeCandidates = getCandidate(delayHours, candiateCount);
    console.log(`[KIM] Fetching candidates:`, timeCandidates);

    const folderFiles = {};
    for (const tmfc of timeCandidates) {
      const dateStringForFolder = `${tmfc.substring(0, 4)}-${tmfc.substring(4, 6)}-${tmfc.substring(6, 8)}`;
      if (!folderFiles[dateStringForFolder]) {
        folderFiles[dateStringForFolder] = await file.listFiles(dateStringForFolder, TIMEZONE, dataType)
                                            .catch(() => []); 
      }
    }

    const sleep = (interval = 1000) => new Promise(resolve => setTimeout(resolve, interval));

    const updatedTmfcs = []; 
    let totalDownloadedCount = 0;

    for (const tmfc of timeCandidates) {
      let currentTmfcNewFiles = 0; 
      const dateStringForFolder = `${tmfc.substring(0, 4)}-${tmfc.substring(4, 6)}-${tmfc.substring(6, 8)}`;
      const existingFiles = folderFiles[dateStringForFolder] || [];
      const targetDir = path.join(BASE_DIR, dataType, dateStringForFolder);

      // 🔥 1. 현재 tmfc에 맞는 efList와 maxHours를 동적으로 가져옴
      const { efList, maxHours } = getKimEfInfo(tmfc);
      console.log(`[KIM] Target tmfc: ${tmfc} -> Will fetch ${efList.length} files up to ${maxHours}h`);

      // 🔥 2. 동적으로 생성된 efList 사용
      for (const ef of efList) {
        const expectedFileName = `g576_v091_${subDirName}_${params.sub}.2byte.ft${ef}.${tmfc}.${fileExt}`;
        
        if (existingFiles.includes(expectedFileName)) continue;

        const currentParams = { ...params, ef };
        const fetchUrl = api.mkUrl[dataType](baseUrl, tmfc, currentParams);

        try {
          const { response, originalFileName } = await api.fetchFile(fetchUrl);
          const saveFilename = originalFileName || expectedFileName;
          console.log(`[KIM] Found file to save:`, saveFilename);
          
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

      if (currentTmfcNewFiles > 0) {
        // 🔥 3. 파이썬 스크립트에 넘겨주기 위해 maxHours도 함께 보관
        updatedTmfcs.push({ tmfc, targetDir, newFilesCount: currentTmfcNewFiles, maxHours });
      }
    } // -- tmfc 루프 끝 --

    if (updatedTmfcs.length > 0) {
      console.log(`[KIM] 모든 다운로드 완료 (총 ${totalDownloadedCount}개 파일). PNG 일괄 변환을 시작합니다.`);
      
      for (const target of updatedTmfcs) {
        console.log(`[KIM-PNG] ${target.tmfc} 변환 시작 (신규 파일: ${target.newFilesCount}개)`);
        try {
          // 🔥 4. Python 스크립트에 정확한 maxHours 전달
          await generateKimPng(target.targetDir, target.tmfc, target.maxHours);
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
downloadConfigs.forEach(config => {
  const { dataType, interval } = config;
  schedule.scheduleTask(
    `${dataType}-${interval}`,
    interval,
    () => downloadLatestKimData(config)
  );
});

// 테스트용 즉시 실행
// downloadLatestKimData(downloadConfigs[0]);

console.log('KIM Watcher started. Waiting for scheduled tasks...');