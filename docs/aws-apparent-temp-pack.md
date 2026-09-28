# AWS 체감온도(AT) pack

Producer 파생 변수. Hub/JSON에 `AT` 필드는 없고, pack 빌드 시 `TA`+`HM`+`WS`로 산출한다.

## HTTP

```text
GET /api/aws/min/pack?date=YYYYMMDD&variable=AT
→ data.url 예: /datasets/aws/at/1m/{day}/at-v{sha8}.i16le
```

| 항목 | 값 |
|------|-----|
| variable | `AT` |
| slug | `at` |
| unit | `degC` |
| scale | `0.1` (binary ×10) |
| missing | `-32768` |
| sourceField | `derived:apparent_temp` |
| 풍속 | `WS` (평균, Hub WS1) |
| TA temporal QC | **미적용** |

## 월 분기 (KST)

| 기간 | 식 | 필수 입력 |
|------|-----|-----------|
| 5–9월 (하절기) | 습구온도 Tw → 체감 | `TA`, `HM` |
| 10–4월 (동절기) | 풍체감 (또는 V≤1.3이면 TA) | `TA`, `WS` |

구현: [`kma_fetch/utils/aws_apparent_temp.js`](../kma_fetch/utils/aws_apparent_temp.js).

### 하절기

```
Tw = T*atan(0.151977*sqrt(RH+8.313659)) + atan(T+RH) - atan(RH-1.676331)
   + 0.00391838*(RH^1.5)*atan(0.023101*RH) - 4.686035
T_feel = -0.2442 + 0.45535*T + 3.0 + (0.55399+0.00278*T)*Tw - 0.0022*(Tw^2)
```

### 동절기

- `V <= 1.3 m/s` → `T_feel = T`
- else `V_kmh = V*3.6`,  
  `T_feel = 13.12 + 0.6215*T - 11.37*(V_kmh^0.16) + 0.3965*(V_kmh^0.16)*T`

최종 ℃는 **소수 1자리 반올림** 후 ×10 Int16 저장.

## 결측

입력 null / 빈 문자열 / `.` / 비유한 / Hub ≤ -50℃(×10 ≤ -500) → binary `-32768`.

## Warm

```bash
NODE_ENV=production USE_API=false node kma_fetch/warm_aws_min_packs.js 20251204 --variables AT --force
```

오늘 pack은 `main_AWS` today registry에 `AT` 포함 (`sourceFields: TA,HM,WS`).
