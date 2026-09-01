# Producer 보완 요청 — RN_DAY 누적강수 carry seed QC 강화

작성일: 2026-09-01  
대상 변수: `RN_DAY` / 00시부터 누적강수량  
관련 문서:

- `docs/rainfall-producer-rnday-stale-suspect-qc-consumer-response-2026-09-01.md`
- `docs/rainfall-producer-rnday-stale-suspect-qc-request-2026-09-01.md`

## 1. 배경

Consumer UI에서 `RN_DAY`는 “해당일 00시부터 현재까지의 누적강수량”으로 보인다.

따라서 사용자는 다음을 기대한다.

- 한 번 나타난 누적강수 기둥은 같은 날 안에서 결측 때문에 사라지지 않는다.
- 누적강수량은 같은 날 안에서 줄어들지 않는다.
- 결측 구간은 “새 관측 없음”이지 “강수량 0 또는 관측소 소멸”이 아니다.

Consumer는 이 기대에 맞추기 위해 `RN_DAY` 표시 정책을 조정했다.

- 같은 KST 날짜 안에서는 마지막 실제 유효 누적값을 계속 carry-forward한다.
- 새 유효값이 이전 누적값보다 작으면 화면 표시값은 이전값으로 고정한다.
- 실제 관측 여부는 `observationValidity`로 별도 유지하고, carry 표시값은 `carryForwardValidity`로 구분한다.

이 구조에서는 producer pack binary에 남아 있는 잘못된 `RN_DAY` 값이 이후 결측 구간에서 계속 표시될 수 있다.  
그래서 `RN_DAY`는 consumer 표시 방어보다 producer QC가 더 중요하다.

## 2. Producer에서 강화가 필요한 QC 원칙

### 2.1 RN_DAY binary는 “carry seed로 안전한 값”만 유효 처리

`RN_DAY` binary의 유효값은 consumer에서 당일 내 장시간 carry-forward될 수 있다.

따라서 아래 값은 binary에 유효값으로 남기지 말고 `-32768` 결측으로 제거해야 한다.

- spike island로 판단되는 값
- counter regression 이후 신뢰 회복 전 값
- `RN_15M`, `RN_60M`, `RN_12HR`, `RN_24HR` 등 주변 강수 window와 물리적으로 맞지 않는 값
- 짧은 구간에만 고립되어 나타나고 전후 대부분이 결측인 큰 누적값
- Hub/API 원천에서 suspect-retained 성격이더라도 방송/통계용 pack에는 쓰면 안 되는 값

### 2.2 단조 증가 원칙

같은 KST 날짜의 `RN_DAY`는 원칙적으로 감소하지 않아야 한다.

권장 처리:

- 정상 증가 또는 동일값: 유지
- 감소 발생: counter-regression으로 판단하고 해당 sample은 결측 처리
- 감소 이후 다시 신뢰 가능한 연속 관측이 확보되기 전까지는 보수적으로 결측 처리
- 자정 reset은 예외로, KST 00:00/00:01 reset 규칙을 명시적으로 처리

### 2.3 고립 spike island 제거

아래 패턴은 특히 강하게 reject해야 한다.

- 특정 관측소에서 `RN_DAY`가 갑자기 큰 값으로 튐
- 같은 시각대 `RN_15M`/`RN_60M` 등 단기 강수량과 누적 증가량이 맞지 않음
- 전후 시각 대부분이 결측
- 주변 관측소·방재 구간통계와도 일관성이 약함
- 이후 시간이 지나도 실제 관측으로 복구되지 않고 결측만 지속됨

이 값이 binary에 남으면 consumer의 당일 carry-forward 정책 때문에 “현재 누적강수량”처럼 오래 표시될 수 있다.

### 2.4 QC 메타데이터 제공 권장

consumer는 최종 통계/지도 표시에는 pack binary를 기준으로 삼는다.  
다만 운영 디버깅을 위해 manifest 또는 sidecar에 아래 정보를 제공하면 좋다.

- `qc.rnDayQc.logicRevision`
- QC reason별 제거 sample 수
  - `midnight-normalize`
  - `counter-regression`
  - `upward-spike`
  - `sparse-spike-island`
  - `cross-window-inconsistent`
- 관측소별 제거 span
  - `stationId`
  - `from`
  - `to`
  - `reason`
  - `maxRemovedValue`
- today pack을 덮어쓰는 watcher/main_AWS 재기동 여부

## 3. Consumer 쪽 현재 정책

Consumer는 다음과 같이 역할을 분리한다.

| 항목 | 기준 |
| --- | --- |
| 지도 표시 | `RN_DAY` binary 유효값 + 당일 carry-forward |
| 카드/tooltip | carry-forward이면 `직전값 유지` 표시 |
| 순위표 | 현재 화면/분석 모드별 pack binary 기준 |
| 이상값 판정 | producer QC가 binary에서 제거해야 함 |
| 임의 보정 | consumer에서 방재값을 임의 생성하거나 관측소 값을 대체하지 않음 |

즉 consumer는 결측으로 인한 깜박임은 막지만, producer가 유효값으로 준 spike를 임의로 이상값이라고 단정하지 않는다.

## 4. 2026-09-01 STN 739 심원 warm 반영 확인

운영 API에서 `2026-09-01 RN_DAY` warm 반영을 확인했다.

조회:

```bash
GET /api/aws/min/pack?date=20260901&variable=RN_DAY
```

확인 결과:

| 항목 | 값 |
| --- | --- |
| `schemaVersion` | 4 |
| `contractRevision` | 8 |
| `datasetId` | `aws-rn_day-1m-20260901-v72181917` |
| `frameCount` | 719 |
| `stationCount` | 736 |
| `complete` | false |
| `dataComplete` | true |
| `rnDayQcLogicRevision` | 3 |

manifest warning:

- `RN_DAY Hub midnight normalize: forced 548 samples at 00:00 to 0 (Hub resets at 00:01)`
- `RN_DAY counter-regression → missing for 3777 samples across 21 stations`
- `RN_DAY upward-spike → missing for 60 samples across 9 stations`

문제 지점:

| 관측소 | 확인 시각 | binary 값 |
| --- | --- | --- |
| STN 739 심원 | 08:05~08:12 | 모두 `-32768` 결측 |
| STN 739 심원 | 09:41 | `-32768` 결측 |

따라서 기존에 보였던 `94.0mm` spike는 2026-09-01 warm 결과에서 더 이상 carry-forward seed가 되지 않는다.

추가 확인값:

- STN 739의 warm 후 당일 최대 유효값은 `4.5mm @ 04:44`

## 5. Producer 요청 사항

1. `RN_DAY` QC에서 spike island / counter regression / cross-window inconsistency를 계속 binary missing 처리해 주세요.
2. `RN_DAY` 유효값은 consumer에서 당일 carry seed가 된다는 전제로, `suspect-retained` 값을 방송/통계용 pack에 남기지 않는 방향을 유지해 주세요.
3. QC rule 변경 시 `rnDayQcLogicRevision` 또는 동등한 logic revision을 올려 주세요.
4. today pack은 API 서버뿐 아니라 AWS 수집 + pack 생성 watcher/main_AWS 재기동까지 함께 확인해 주세요.
5. 가능하면 향후 sidecar 또는 manifest에 station별 제거 span/reason을 제공해 주세요.

