# RN_DAY stale suspect QC — Consumer 회신

작성일: 2026-09-01  
대상 문서: `docs/rainfall-producer-rnday-stale-suspect-qc-consumer-notice-2026-09-01.md`

## 1. 결론

Producer notice의 역할 분리와 구현 방향에 동의합니다.

- Producer: spike island를 pack binary 원천에서 reject
- Consumer: `RN_DAY`의 오래된 carry-forward가 현재 관측처럼 보이지 않도록 렌더링 방어
- 순위표/극값/기준판: pack binary 기준 유지
- `/exact`, `/range`: 원천 확인용으로 보존, UI 통계에는 사용하지 않음

Consumer 임시 방어와 cache key 보강은 반영했습니다.

## 2. §6 확인 요청 회신

### 2.1 임시 carry 방어

동의합니다. Consumer는 producer 배포 전에도 `RN_DAY` carry 제한을 유지합니다.

기본값:

```text
RN_DAY_MAX_CARRY_FORWARD_MINUTES = 10
```

정책:

- 마지막 실제 관측 후 10분 이내: 짧은 결측 보정으로 carry-forward 허용
- 10분 초과: 지도 기둥/IDW 입력에서 제외
- 순위표는 기존처럼 현재 시각 실제 관측값 기준 유지

이 값은 운영 확인 후 너무 짧거나 길면 조정 가능합니다.

### 2.2 캐시 키

반영했습니다.

Consumer pack cache key에는 다음이 포함됩니다.

- API root
- `date`
- `variable`
- `contractRevision`
- variable별 `logicRevision`
- `datasetId`
- `data.sha256`
- consumer schema/station eligibility revision

RN 강수 QC revision은 아래 필드 중 하나로 읽습니다.

```text
manifest.rnDayQcLogicRevision
manifest.qc.rnDayQcLogicRevision
manifest.qc.rnDayQc.logicRevision
manifest.qc.rainQc.logicRevision
```

따라서 producer가 `rnDayQcLogicRevision: 3`으로 올리면 같은 `contractRevision`이라도 구 캐시를 재사용하지 않습니다.

### 2.3 qcDetailUrl fetch 실패 시

현재 Consumer는 RN sidecar를 UI 통계 산정값의 소스로 사용하지 않습니다.

- `RN_DAY`/`RN_*` 순위표·극값·기준판: pack binary 기준
- RN sidecar: 현재는 producer 검증/진단용 계약으로 취급
- 따라서 RN `qcDetailUrl` fetch 실패가 UI hard stop을 만들지는 않습니다.

추후 RN sidecar를 사용자 경고/진단 UI에 표시하기로 하면, “binary 사용 + warn + PT hard stop 없음” 정책에 동의합니다.

### 2.4 Rolling 변수 범위

Consumer 입장에서는 **B: rolling pack에도 동일 spike mask 전파 필요** 의견입니다.

이유:

- 이번 사례에서 08:09~08:12 `RN_15M`/`RN_60M`에도 94.0mm spike가 확인됐습니다.
- `RN_DAY`만 reject되면 시간재생/기간요약/기록갱신 재생에서 변수 선택에 따라 같은 지점이 다시 튈 수 있습니다.
- `RN_24HR`은 `RN_DAY` 기반 파생이므로 `RN_DAY` 보정 후 재생성이 필요합니다.

권장 범위:

```text
1차: RN_DAY
2차: RN_15M, RN_60M
필요 시: RN_12HR, RN_24HR 파생 재생성/동일 mask 검증
```

### 2.5 관측 소스 우선순위

동의합니다.

- 순위표·극값·기준판 = pack binary only
- 지도 carry = consumer 렌더링 정책
- producer가 carry 시간을 직접 제어하지 않음

## 3. Consumer 반영 내용

### 3.1 오래된 RN_DAY carry 제한

`src/awsApiAdapter.js`

- `RN_DAY_MAX_CARRY_FORWARD_MINUTES = 10`
- `dayVariablePacksToTimeline()`에서 `RN_DAY` carry-forward 시 마지막 실제 관측 frame 이후 10분 초과분은 validity를 끊음
- 장시간 결측 구간의 오래된 누적값이 지도 기둥/IDW 입력으로 남지 않음

### 3.2 RN 강수 QC logicRevision cache key

`src/awsApiAdapter.js`

- TA 전용 logic revision 외에 RN logic revision도 cache key에 반영
- producer `rnDayQcLogicRevision` bump 시 구 pack cache 재사용 방지

### 3.3 테스트

`scripts/testAwsApiAdapter.js`

- `STN_ID=739` 심원 유사 fixture 추가
- 08:05 94.0mm 이후 결측이 지속되면 10분까지만 carry되고 이후 validity가 끊기는지 검증
- RN logic revision 추출 테스트 추가

`scripts/testRainDayBrowser.js`

- 현재 UI 용어(`시간강수합`, TOP10)에 맞춰 RN_DAY 회귀 테스트 기대값 갱신

## 4. 공동 검증 시 Consumer 확인 항목

Producer `rnDayQcLogicRevision >= 3` warm 이후:

- [ ] `2026-09-01 RN_DAY` 09:41 현재 시각에서 STN 739 심원 94.0mm 기둥 없음
- [ ] 순위표에 심원 없음
- [ ] 08:05~08:12 binary가 missing 처리되었는지 producer 결과와 대조
- [ ] `RN_15M`/`RN_60M`에서도 같은 spike가 제거되는지 확인
- [ ] 기존 정상 다습 지점 TOP 순위 회귀 없음

