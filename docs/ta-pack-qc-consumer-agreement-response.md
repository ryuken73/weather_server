# Consumer 회신: TA pack QC 보강 합의 의견

작성일: 2026-08-29
원문: `docs/ta-pack-qc-consumer-agreement-request.md`
관련 producer 요청: `docs/producer-ta-temperature-qc-request.md`
대상 consumer: `weather-bars-instanced`

---

## 1. 총평

Producer 제안 방향에 전반적으로 동의한다.

핵심 합의 원칙은 다음과 같다.

1. `/api/aws/min/exact`는 원천 확인·디버그 용도로만 본다.
2. 화면 표시, 극값, TOP 순위, 기준 이상/이하 판정은 `/api/aws/min/pack` binary를 기준으로 계산한다.
3. `qcDetailUrl`은 표시값의 소스가 아니라 “왜 빠졌는지 설명하는 감사 자료”로 사용한다.
4. rev 9 TA pack이 충분히 검증되기 전까지 consumer의 sparse high 임시 방어선은 유지한다.
5. rev 9 검증 완료 뒤에도 임시 방어선은 완전 삭제보다 feature flag로 남기는 편이 안전하다.

이번 이슈의 본질은 “44.7℃가 물리 hard limit 안쪽이라 consumer 단독 plausibility만으로는 안정적으로 잡기 어렵다”는 점이다. 따라서 producer의 TA pack QC 강화와 consumer의 carry-forward 정책 정리가 같이 필요하다.

---

## 2. §6 미결정 사항에 대한 consumer 선택

| 항목 | Consumer 선택 | 의견 |
| --- | --- | --- |
| §6.1 오늘 partial pack | **A** | sparse high QC는 complete day pack 중심으로 적용하는 데 동의. 오늘 partial은 표본 수가 적어 오탐 위험이 있으므로 consumer 임시 방어선을 유지한다. |
| §6.2 carry-forward after QC missing | **A 조건부** | 순위·카드·극값·기준판에서는 missing 이후 carry-forward를 관측값으로 쓰지 않는다. 단, 렌더링 연속성을 위한 내부 시각화 보간/유지값은 “관측값 아님”으로 분리 가능하다. |
| §6.3 consumer plausibility | **B** | rev 9 이후에도 기본 물리 plausibility는 유지한다. 다만 상한을 43℃로 낮추는 방식은 반대한다. 실제 고온 가능성을 임의로 잘라낼 수 있다. |
| §6.4 `/exact` 사용 범위 | **A** | 일최고·극값·기준 이상/이하 판정은 pack only. exact는 원천 대조, 운영 진단, producer QC 검증에만 사용한다. |
| §6.5 qc detail fetch 실패 | **C 조건부** | binary는 계속 사용하되, qc detail을 못 읽으면 consumer 임시 방어선/plausibility를 유지하고 디버그 경고만 남긴다. PT 화면을 중단시키지는 않는다. |

요약하면 consumer는 `pack binary = 표시·계산의 single source of truth`, `qc detail = 설명/감사`, `exact = 원천 대조`로 역할을 분리한다.

---

## 3. manifest / qcDetailUrl 합의

### 3.1 complete day TA의 `qcDetailUrl`

동의한다.

`contractRevision >= 9`이고 `variable=TA`, `complete=true`인 pack은 `qcDetailUrl`과 `qcDetailSha256`을 제공하는 것을 계약으로 두는 것이 좋다.

다만 consumer 구현에서는 경로를 하드코딩하지 않고 manifest의 `qcDetailUrl`을 그대로 따라간다. Producer 내부 경로가 RN과 같은 `/datasets/aws/ta/1m/{day}/qc-v{sha16}.json` 형태인 것은 동의하지만, consumer가 이 경로 규칙을 직접 조립하지는 않는다.

### 3.2 qc detail의 역할

동의한다.

Consumer는 sidecar record를 사용해 다음 정도의 보조 기능을 붙일 수 있다.

- 운영/디버그 패널에서 “producer QC 제외” 사유 표시
- 특정 station/time이 왜 빠졌는지 추적
- rev 9 전환 검증 자동화

하지만 실제 지도 값, TOP10, 카드 값, 기준 이상/이하 판정은 binary에서 `-32768`인지 여부를 우선한다.

### 3.3 `qcDetailSha256`

동의한다.

검증 기준은 producer 제안처럼 압축 해제 후 UTF-8 JSON bytes 기준 SHA-256으로 두면 된다. 단, 첫 consumer 반영에서는 SHA 불일치 시 화면 전체를 중단하기보다 “QC detail 불신 + 임시 방어선 유지”로 처리하는 편이 PT 안정성 면에서 낫다.

---

## 4. 캐시와 contract 처리 의견

### 4.1 캐시 키

Consumer 캐시 키에는 최소 다음을 포함해야 한다.

- `date`
- `variable`
- `contractRevision`
- `qc.taTemporal.logicRevision`
- `datasetId`
- 가능하면 `data.sha256`

`datasetId`가 바뀌면 pack binary도 바뀐 것으로 보고 IndexedDB 캐시는 재사용하지 않는다. `contractRevision < 9`인 TA pack은 rev 9 배포 후 일최고·극값·기준판 계산에 쓰지 않는 방향에 동의한다.

### 4.2 rev 8 처리

rev 9 producer warm 전까지는 rev 8 pack을 완전히 금지하면 운영 확인이 끊길 수 있다. 따라서 consumer는 다음 단계가 적절하다.

1. rev 8에서는 현재 consumer sparse high 임시 방어선을 유지한다.
2. rev 9 + qc detail + 20260828 검증 통과 후 rev 8 TA pack을 stale로 취급한다.
3. 이후에는 rev 8 TA pack 사용 시 “재생성 필요”로 안내한다.

---

## 5. carry-forward에 대한 명확한 합의 요청

587 케이스의 재발 방지를 위해 이 부분은 강하게 합의가 필요하다.

Producer가 `-32768`로 reject한 분은 consumer에서 관측값으로 되살리지 않는다.

Consumer 내부에는 두 종류의 validity가 있을 수 있다.

| 구분 | 용도 | 판정/표시 사용 |
| --- | --- | --- |
| `observationValidity` | 해당 분에 실제 관측값이 있었는지 | 카드, TOP10, 극값, 기준판에서 사용 |
| `validity` 또는 carry-forward 값 | 렌더링 연속성, 일부 시각 보간 | 관측 판정에는 사용 금지 |

즉, PT 화면에서 지도가 부드럽게 보이도록 내부적으로 이전 값을 들고 있더라도, 그 값이 카드·순위·임계판에 관측값처럼 올라오면 안 된다.

Consumer 선택지로는 §6.2의 **A**를 선택하되, 위와 같은 “렌더링 전용 carry-forward 예외”만 인정하는 것으로 정리한다.

---

## 6. 오늘 partial pack 의견

Producer의 sparse high QC를 complete day 중심으로 적용하는 데 동의한다.

이유:

- partial day는 시간대에 따라 station/day 유효 샘플 수가 자연스럽게 적을 수 있다.
- `유효 샘플 <= 30` 같은 조건은 장마철/통신장애/오늘 초기 구간에서 오탐 가능성이 있다.
- 실시간 PT에서는 producer가 과감히 지우는 것보다 consumer가 임시 방어선을 유지하면서 보수적으로 보여주는 편이 안전하다.

따라서 오늘 pack은 다음 정책을 권장한다.

- producer: 기존 temporal QC 중심
- consumer: sparse high 임시 방어선 유지
- UI: 필요 시 “오늘 자료는 partial pack” 정도만 진단 정보로 표시

추후 partial에도 producer sparse high를 넣고 싶다면 station/day 전체 샘플 수가 아니라 “고온 anchor 주변의 전후 관측 밀도” 또는 “동일 권역 인접 관측소 대비 편차” 기반으로 별도 설계하는 편이 낫다.

---

## 7. consumer 임시 방어선 처리

완전 삭제보다 feature flag 유지에 동의한다.

권장 정책:

- rev 8 또는 qc detail 없는 TA pack: 방어선 ON
- rev 9 + qc detail 검증 통과: 기본 OFF 가능
- 운영 이상값 재발 또는 sidecar 실패: 즉시 ON 가능

feature flag 이름 예시:

```text
AWS_TA_CONSUMER_SPARSE_HIGH_GUARD=auto|on|off
```

`auto` 동작:

- `contractRevision >= 9`
- `qcDetailUrl` 존재
- `qc.taTemporal.logicRevision >= 2`
- 20260828 방산 검증 통과 pack

위 조건이면 off처럼 동작하고, 하나라도 불충족이면 on처럼 동작한다.

---

## 8. producer에 추가로 요청할 사항

### 8.1 공식 품질 플래그 조사 결과를 manifest에 남겨주기

DB/API Hub에 공식 TA 품질 플래그가 없더라도, 조사 결과를 manifest 또는 문서에 남겨주면 좋다.

예시:

```json
{
  "qc": {
    "taOfficialFlag": {
      "available": false,
      "checkedColumns": ["TA_QC", "TA_QA", "TA_FLAG", "QC_FLAG", "QC", "ERR", "STATUS", "GRADE"]
    }
  }
}
```

공식 플래그가 있으면 heuristic보다 우선해야 한다.

### 8.2 sparse high reject는 “해당 고온 샘플”만 제거

station/day 전체를 통째로 결측 처리하기보다, 제안처럼 `44℃ 이상` sparse high sample만 `-32768`로 만드는 데 동의한다.

단, QC detail에는 station/day 유효 샘플 수와 reject된 sample 목록이 반드시 남아야 한다.

### 8.3 17:16 24.0℃ 복원은 필수 아님

`/exact`에서 202608281716 방산이 `24.0℃`로 보이더라도, producer pack에서 해당 분을 반드시 복원해야 한다고 보지는 않는다.

Consumer 관점에서는 다음 둘 모두 허용 가능하다.

- pack 17:16 = `-32768`
- pack 17:16 = `240`

다만 12:01/12:15의 고온 anchor가 carry-forward되어 17시대에 보이는 것은 허용하지 않는다.

### 8.4 TOP10 검증 기준은 “값 없음”까지 포함

검증은 단순히 binary가 `-32768`인지뿐 아니라, UI 결과에서 다음이 없어야 한다.

- 시간재생 17시대 방산 `44.7℃`
- 일최고 TOP10 방산 `44.7℃`, `45.0℃`, `49℃대`
- 기준 이상 판의 방산 비컨/카드/순위 선택

---

## 9. 배포 순서 의견

Consumer 선배포를 권장한다.

이유:

- rev 8 환경에서도 현재 임시 방어선으로 운영 이상값 노출을 줄일 수 있다.
- rev 9 producer warm 이후에는 같은 consumer가 contract/datasetId/qc detail 기준으로 자연스럽게 새 pack을 받으면 된다.
- producer warm 후 consumer를 뒤늦게 배포하면 그 사이 stale pack/캐시 이슈를 사용자가 다시 볼 수 있다.

권장 순서:

| 순서 | 담당 | 작업 |
| --- | --- | --- |
| 1 | Consumer | rev 8/9 호환 캐시 키, carry-forward 관측 분리, sparse guard auto 모드 준비 |
| 2 | Producer | TA QC rev 9 구현 및 배포 |
| 3 | Producer | 20260828 TA + 최근 14일 TA force warm |
| 4 | 공동 | 587 케이스와 최근 고온일 검증 |
| 5 | Consumer | 검증 완료 후 sparse guard를 auto/off 상태로 운영 |

---

## 10. 회신 요약

Producer 제안에 대한 최종 회신은 다음과 같다.

```text
1. §6.1 partial pack: A
   - complete day 중심 sparse high 적용에 동의
   - today partial은 consumer 임시 방어 유지

2. §6.2 carry-forward: A 조건부
   - 카드/TOP10/극값/기준판에서는 carry-forward 금지
   - 렌더링 전용 내부 보간은 observationValidity와 분리하는 조건으로 허용

3. §6.3 plausibility: B
   - rev 9 이후에도 기본 물리 plausibility 유지
   - 상한 43℃ 조정은 반대

4. §6.4 exact 범위: A
   - exact는 디버그/대조 전용
   - 표시·계산은 pack only

5. §6.5 qc fetch 실패: C 조건부
   - binary는 사용
   - qc detail 불가 시 consumer 임시 방어선/plausibility 유지
   - PT 화면 hard stop은 하지 않음

6. §4 qcDetailUrl complete day 필수: 동의
   - 단 consumer는 manifest URL을 따르고 경로 조립은 하지 않음

7. §5.4 임시 방어선: feature flag 유지
   - rev 9 검증 후 기본 off 가능
   - 재발/sidecar 실패 시 즉시 on 가능해야 함

8. §8 배포 순서: consumer 선배포 권장
   - rev 8 보호와 rev 9 전환을 동시에 안전하게 처리

9. 기타 blocking 이슈:
   - 없음
   - 단 carry-forward 값과 실제 관측값의 분리는 반드시 지켜야 함
```

