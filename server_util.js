function findNearestTimestamp(interval) {
  return (timestamp_kor) => {
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
    const modular = parseInt(interval);
    const nearestFiveMin = Math.round(minutes / modular) * modular;

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
}
function findNearestWindTimestamp(){
// 입력 문자열을 Date 객체로 파싱
  return (inputDateStr) => {
    const inputDate = new Date(
      parseInt(inputDateStr.slice(0, 4)), // 연도
      parseInt(inputDateStr.slice(4, 6)) - 1, // 월 (0-based)
      parseInt(inputDateStr.slice(6, 8)), // 일
      parseInt(inputDateStr.slice(8, 10)), // 시
      parseInt(inputDateStr.slice(10, 12)) // 분
    );

    // 기준 시간들 (03, 09, 15, 21시)
    // const targetHours = [3, 9, 15, 21];
    const targetHours = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];

    // 입력 날짜의 연, 월, 일, 시 추출
    const year = inputDate.getFullYear();
    const month = inputDate.getMonth();
    const day = inputDate.getDate();
    const hours = inputDate.getHours();
    const minutes = inputDate.getMinutes();

    // 입력 시간의 타임스탬프 (밀리초)
    const inputTimestamp = inputDate.getTime();

    // 가능한 시간들 생성 및 비교
    let nearestPastTime = null;
    let nearestDiff = Infinity;

    // 현재 날짜와 이전 날짜를 모두 고려
    for (let d = 0; d >= -1; d--) {
      const checkDate = new Date(inputDate);
      checkDate.setDate(day + d);

      for (const targetHour of targetHours) {
        // 해당 날짜의 targetHour 시 00분 설정
        const candidate = new Date(
          checkDate.getFullYear(),
          checkDate.getMonth(),
          checkDate.getDate(),
          targetHour,
          0
        );

        // 후보 시간이 입력 시간보다 이전인지 확인
        const timeDiff = inputTimestamp - candidate.getTime();
        if (timeDiff >= 0 && timeDiff < nearestDiff) {
          nearestDiff = timeDiff;
          nearestPastTime = candidate;
        }
      }
    }

    // nearestPastTime을 YYYYMMDDHH00 형식으로 변환
    if (nearestPastTime) {
      const yearStr = nearestPastTime.getFullYear().toString();
      const monthStr = (nearestPastTime.getMonth() + 1).toString().padStart(2, '0');
      const dayStr = nearestPastTime.getDate().toString().padStart(2, '0');
      const hourStr = nearestPastTime.getHours().toString().padStart(2, '0');
      return `${yearStr}${monthStr}${dayStr}${hourStr}00`;
    }

    // 예외 처리: 적합한 시간이 없는 경우 (실제로는 발생하지 않음)
    throw new Error("No valid past time found");
  }
}

module.exports = {
  findNearestTimestamp,
  findNearestWindTimestamp
}

// 테스트 예시
// try {
//   const timestamps = [
//     "202507070730", 
//     "202507070731", 
//     "202507070732", 
//     "202507070734",
//     "202507070735",
//     "202507070736",
//     "202507070737",
//     "202507070738",
//     "202507070739",
//     "202507070740",
//   ];
//   const results5 = timestamps.map(ts => findNearestTimestamp(5)(ts));
//   const results2 = timestamps.map(ts => findNearestTimestamp(2)(ts));
//   console.log(results5); 
//   console.log(results2); 
// } catch (error) {
//   console.error(error.message);
// }

// 테스트 예제
// console.log(findNearestWindTimestamp("202509040412")); // "202509040300"
// console.log(findNearestWindTimestamp("202509040258")); // "202509032100"
// console.log(findNearestWindTimestamp("202509040859")); // "202509040300"
// console.log(findNearestWindTimestamp("202509040900")); // "202509040900"
// console.log(findNearestWindTimestamp("202509040901")); // "202509040900"
// console.log(findNearestWindTimestamp("202509042359")); // "202509042100"