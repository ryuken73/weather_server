function findNearestRadarTimestamp(timestamp_kor) {
  // 입력 타임스탬프 파싱 (YYYYMMDDHHMM)
  if (!/^\d{12}$/.test(timestamp_kor)) {
    throw new Error("Invalid timestamp format. Expected YYYYMMDDHHMM, got: " + timestamp_kor);
  }

  const year = parseInt(timestamp_kor.substring(0, 4));
  const month = parseInt(timestamp_kor.substring(4, 6)) - 1; // JavaScript months are 0-based
  const day = parseInt(timestamp_kor.substring(6, 8));
  const hour = parseInt(timestamp_kor.substring(8, 10));
  const minute = parseInt(timestamp_kor.substring(10, 12));

  // Date 객체 생성
  const dt = new Date(year, month, day, hour, minute);

  // 분(minutes)을 추출
  const minutes = dt.getMinutes();
  // 가장 가까운 5분 주기 계산
  const nearestFiveMin = Math.round(minutes / 5) * 5;

  // 분이 60이 되면 시간(hour)을 증가시키고 분을 0으로 설정
  if (nearestFiveMin === 60) {
    dt.setHours(dt.getHours() + 1);
    dt.setMinutes(0);
  } else {
    dt.setMinutes(nearestFiveMin);
  }
  dt.setSeconds(0);
  dt.setMilliseconds(0);

  // 결과를 YYYYMMDDHHMM 형식으로 반환
  const pad = (num) => String(num).padStart(2, "0");
  return (
    dt.getFullYear() +
    pad(dt.getMonth() + 1) +
    pad(dt.getDate()) +
    pad(dt.getHours()) +
    pad(dt.getMinutes())
  );
}

module.exports = {
  findNearestRadarTimestamp
}

// 테스트 예시
// try {
//   const timestamp_kor = "202507070736";
//   const result = findNearestRadarTimestamp(timestamp_kor);
//   console.log(result); // 출력: 202507070735
// } catch (error) {
//   console.error(error.message);
// }