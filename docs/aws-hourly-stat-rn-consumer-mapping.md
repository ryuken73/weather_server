# AWS 시간통계(RN) ↔ Consumer UI 매핑 (합의)

작성: 2026-09-10  
상태: **Consumer 확정**  
Hub API: `typ01/url/awsh.php?var=RN&tm=YYYYMMDDHHMI`  
Producer endpoint (실험): `GET /api/aws/stat/hourly/pack?date=YYYYMMDD&variable=RN`

기존 1분 pack(`RN_60M`, `RN_DAY` 등) 계약은 **변경하지 않는다**.  
1분 pack = 시간재생 / rolling 재생.  
시간통계 pack = 방재 공식 수치 parity · 기록 갱신 재생 · 공식 비교 모드.

---

## UI / 방재 정렬2 ↔ Hub

| Consumer / 방재 정렬2 | Hub 필드 | grain | 비고 |
| --- | --- | --- | --- |
| **1시간최대강수** | `RN_HR1` | **선택 구간 max** | Hub 값은 정시 `tm` 기준 1시간 강수. UI는 구간 내 매시 `RN_HR1`의 max. 발생시각 = 해당 `TM`(정시) |
| **최대60분강수** | `RN_60M_MAX` | **선택 구간 max** | Hub 값은 정시 `tm` 기준 직전 60분 창의 60분 이동합 최대. UI는 구간 내 매시 `RN_60M_MAX`의 max. 발생시각 = `TM + RN_60M_MAX_MI` (분) |

예: `TM=11:00`, `RN_60M_MAX_MI=-50` → 발생시각 **10:10**.

---

## 방재 정렬2 기간 (start 제외, end 포함)

선택 구간 `(start, end]` — **시작 정시 제외, 종료 정시 포함**.

예: `2026-08-08 00:00 ~ 18:00` → 정시 `01:00, 02:00, …, 18:00` (18개).  
방재 화면 자료처리수 `18/18` 패턴과 동일.

Producer day pack(`date=YYYYMMDD`)은 해당 달력일의 정시 `HH00` 원천(기본 `0000`–`2300`)을 저장한다.  
구간 필터·max 산정은 **consumer**가 위 규칙으로 수행한다.  
하루를 `00:00~24:00`으로 잡을 때 마지막 슬롯이 익일 `00:00`이면 인접일 pack도 함께 요청한다.

---

## Producer가 저장·노출하는 RN 필드

| 필드 | 용도 |
| --- | --- |
| `TM`, `STN` | 정시·지점 |
| `RE_SUM`, `RE_QCM` | 강수유무 합·자료수 (Hub 컬럼; STN 직후) |
| `RN_DAY` | 해당 시각까지 일강수 |
| `RN_HR1`, `RN_HR1_MI` | 1시간 강수 · 시차(분) |
| `RN_60M_MAX`, `RN_60M_MAX_MI`, `RN_60M_QCM` | 최대 60분 이동합 · 시차 · 자료수 |
| `RN_15M_MAX`, `RN_15M_MAX_MI`, `RN_15M_QCM` | 최대 15분 이동합 · 시차 · 자료수 |
| `RN_DAY_MI` | 일강수 시차 |

**컬럼 순서 (contractRevision ≥ 2):** `STN` 뒤 `RE_SUM`, `RE_QCM` 다음이 `RN_*`.  
rev1은 `RE_*`를 건너뛰지 않아 RN 필드가 두 칸 밀렸음 → **rev2에서 수정.**

**음수 강수량 (contractRevision ≥ 3):** `RN_DAY`/`RN_HR1`/`RN_60M_MAX`/`RN_15M_MAX`가 음수면 **해당 STN·field만 `null`**.  
같은 row의 다른 필드·다른 지점은 유지. manifest `qc.negativeAmountNulls`에 건수·샘플 기록.  
음수 cell ≥5% **그리고** null≥100, 또는 음수 보유 지점 ≥10% **그리고** 지점≥50일 때만 컬럼 밀림 의심으로 fetch FAIL (`RN_AMOUNT_NEGATIVE_FLOOD`).  
소수 지점 `-0.5` 등은 TM 전체를 버리지 않는다.

결측: Hub 물리결측(≤ -50 등) → JSON `null`. **0.0 mm는 0**.

---

## 변경 이력

| 날짜 | 내용 |
| --- | --- |
| 2026-09-10 | Consumer 확정안 반영 |
| 2026-09-10 | **contractRevision 2**: `RE_SUM`/`RE_QCM` 컬럼 정렬 수정 (rev1 두 칸 밀림) |
| 2026-09-10 | **contractRevision 3**: 음수 강수 STN/field null + qc 집계; 다량만 fatal |
