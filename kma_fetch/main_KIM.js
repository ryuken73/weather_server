const api = require('./services/api');
const file = require('./utils/file');
const time = require('./utils/time');
const schedule = require('./services/scheduler');
const { TIMEZONE } = require('./config/env');

// KIM 데이터 API 엔드포인트 (필요시 env에 추가하여 사용)
const API_ENDPOINT_KIM = 'https://apihub-pub.kma.go.kr/api/typ06/url';

// 예측 시간(ef) 목록 생성: 000부터 372까지 3시간 간격 (총 125개)
const KIM_EF_LIST = Array.from({ length: 125 }, (_, i) => String(i * 3).padStart(3, '0'));

// 다운로드할 파라미터 조합 정의 (KIM 전용)
const downloadConfigs = [
  { 
    baseUrl: API_ENDPOINT_KIM,
    dataType: 'g576', 
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
    interval: '1min' // 스케줄러 간격
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

    let newFilesCount = 0;

    // 2. 분석시간(tmfc)별로 예측시간(ef) 루프
    for (const tmfc of timeCandidates) {
      const dateStringForFolder = `${tmfc.substring(0, 4)}-${tmfc.substring(4, 6)}-${tmfc.substring(6, 8)}`;
      const existingFiles = folderFiles[dateStringForFolder] || [];

      for (const ef of KIM_EF_LIST) {
        // 다운로드 파일명 패턴: g576_v091_easia_etc.2byte.ft000.2026040212.nc
        const expectedFileName = `${dataType}_v091_${subDirName}_${params.sub}.2byte.ft${ef}.${tmfc}.${fileExt}`;
        
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
          
          // 파일 저장 (subDirName 위치에 dataType인 'g576'을 넘겨 올바른 경로 생성 유도)
          const savedPath = await file.saveFile(
            response.data, 
            saveFilename, 
            dateStringForFolder, 
            dataType, 
            compressed
          );
          
          console.log(`[KIM] File saved!`, savedPath);
          newFilesCount++;
        } catch (err) {
          // 404 에러 등 파일이 아직 생성되지 않은 경우 조용히 다음으로 넘어감
          // console.error(`File not ready: ${expectedFileName}`);
          continue; 
        }

        // 공공데이터포털 API 부하 방지
        await sleep(500); 
      }
    }

    if (newFilesCount === 0) {
      console.log(`[KIM] No new files to download at this time.`);
    } else {
      console.log(`[KIM] Successfully downloaded ${newFilesCount} new files.`);
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

// 테스트용 즉시 실행 (필요시 주석 해제)
// downloadLatestKimData(downloadConfigs[0]);

console.log('KIM Watcher started. Waiting for scheduled tasks...');