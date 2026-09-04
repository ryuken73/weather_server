# 이미지·외부 파이프라인 수집 흐름 — 초안 (미확정)

작성일: 2026-09-04  
상태: **드래프트 — `parse_netcdf`가 `weather_system` 아래로 push·문서화된 뒤, 그쪽 README/문서를 참고해 확정**  
관련: 루트 [`README.md`](../README.md) §4

**진행 방침:** 빈칸을 지금 무리해서 채우지 않는다. `parse_netcdf` commit 시 문서가 보강되면 그 내용을 이 표·루트 README §4에 반영한다.

---

## 0. 확정에 가까운 것 (이 repo만으로도 OK)

| 영역 | 수집 | 가공 | 서빙 |
| --- | --- | --- | --- |
| AWS JSON + pack | `main_AWS` (MSSQL/Hub) | `aws_min_pack.js` warm/QC | `/api/aws/*`, `/datasets/aws/*` |
| KIM global TXT HGT500 | `main_KIM_TXT` | `kim_hgt_text_sequence_generator.py` 등 | `/api/hgt500/*`, `/datasets/kim-glob-hgt500-*` |

위 두 줄은 이번 드래프트의 주 대상이 **아님**.

---

## 1. 불완전 항목 목록 (채울 곳)

### 1.1 IR105 / 구름 (GK2A)

| # | 질문 | 현재 파악 (채워 주세요) |
| --- | --- | --- |
| A1 | NetCDF 수집 watcher | `kma_fetch/main.js` → `in_data/gk2a/*.nc` (LE1B IR105, EA/FD/KO) — **이 부분은 OK?** |
| A2 | NC → mono/color **PNG** 담당 repo·스크립트 | (예: `parse_netcdf`의 어떤 함수/엔트리?) |
| A3 | PNG 출력 경로 (`ROOT_DIR` 기준 상대 경로) | |
| A4 | NC/중간산물 → **PostgreSQL `ir105_json`** 적재는 누가? | |
| A5 | `/ir105/.../fs` gzip JSON은 누가 쓰나? 경로? | |
| A6 | 기동·스케줄 (cron/pm2/별도 watcher 이름) | |
| A7 | Consumer가 쓰는 주 경로: JSON vs PNG? | |

**메모 / 다이어그램 (자유 기입)**

```text
(여기에 IR105 실제 흐름을 적어 주세요)
```

---

### 1.2 레이더 RDR HSP

| # | 질문 | 현재 파악 (채워 주세요) |
| --- | --- | --- |
| B1 | binary 수집 | `main_RDR.js` → `in_data/rdr/RDR_CMP_HSP_PUB_{tm}.bin(.gz)`, 5분 — **OK?** |
| B2 | bin → `RDR_CMP_HSP_PUB_{tm}_step{n}.png` 담당 | |
| B3 | `_equi` PNG는 같은 파이프라인인지 | |
| B4 | 출력 경로 | |
| B5 | 기동·스케줄 | |
| B6 | step 의미 (step1, step2…) | |

**메모 / 다이어그램**

```text

```

---

### 1.3 GFS (바람 JSON · 온도/습도 PNG)

| # | 질문 | 현재 파악 (채워 주세요) |
| --- | --- | --- |
| C1 | GFS 원천은 어디서 받나? (이 repo에 fetch 없음) | |
| C2 | `gfs-wind_*` **JSON** 생성 담당 | |
| C3 | `gfs-0p25_tmp_*` / `rh_*` **PNG** 생성 담당 | |
| C4 | `gfs_equ-*` 와 merc 계열 차이·담당 | |
| C5 | 출력 경로 (`ROOT_DIR` 기준) | |
| C6 | 기동·스케줄 | |
| C7 | weather_api와의 경계: 서빙만? | |

**메모 / 다이어그램**

```text

```

---

### 1.4 레거시 AWS 강수 PNG

| # | 질문 | 현재 파악 (채워 주세요) |
| --- | --- | --- |
| D1 | `/aws-RN_15M`, `/aws-RN_60M` PNG는 누가 만드나? | |
| D2 | 1분 pack (`/api/aws/min/pack`)과 관계 (병행? 폐기 예정?) | |
| D3 | 출력 파일명 `AWS_MIN_{tm}_{RN_*}_step1.png` 생성기 | |

**메모**

```text

```

---

### 1.5 KIM EAsia 레거시 PNG (`/kim-psl`, `/kim-hgt500` image)

| # | 질문 | 현재 파악 (채워 주세요) |
| --- | --- | --- |
| E1 | `main_KIM.js` NC 수집 후 PNG는 **이 repo python**인지, `parse_netcdf`인지 | |
| E2 | env `KIM_PSL_PNG_GENERATOR` / `KIM_HGH_PNG_GENERATOR` 실제 경로·repo | |
| E3 | global TXT HGT500(`/api/hgt500`)으로 이행 후 레거시 image 유지 여부 | |

**메모**

```text

```

---

### 1.6 공통·인프라

| # | 질문 | 현재 파악 (채워 주세요) |
| --- | --- | --- |
| F1 | `parse_netcdf` 예상 GitLab path (예: `weather_system/parse_netcdf`) | |
| F2 | 운영에서 이미지 job이 도는 호스트 (168과 동일? 다른 박스?) | |
| F3 | `ROOT_DIR_PROD` / `MODE=prod`가 가리키는 실제 디렉터리 | |
| F4 | `sync_image.sh` 역할 (있다면) | |
| F5 | README §4 조감도에서 “parse_netcdf”로 묶어도 되는 범위 | IR105? RDR? GFS? AWS PNG? |

---

## 2. README §4에 반영할 때 체크리스트

`parse_netcdf` push 후:

- [ ] 위 A~F 표의 “현재 파악” 채움 확인
- [ ] 루트 `README.md` §4.2~4.6 “불완전” 문구 제거·다이어그램 교체
- [ ] `skills/` 또는 `docs/`에 parse_netcdf 포인터 추가 여부 결정
- [ ] OpenAPI/catalog의 legacy image type과 생성기 매핑 표 1장

---

## 3. 한 줄로 남기고 싶은 Producer 입장 (초안)

> weather_api는 **원천 수집(watcher) + AWS pack/HGT500 dataset + HTTP 서빙**이 본업이고,  
> **NetCDF/bin → 시각화 PNG/일부 JSON**은 `parse_netcdf`(가칭) 등 이미지 파이프라인과 역할을 나눈다.  
> 경계는 `parse_netcdf`가 `weather_system`에 들어온 뒤 이 문서로 확정한다.

(수정 가능)

---

## 4. 변경 이력

| 날짜 | 내용 |
| --- | --- |
| 2026-09-04 | 불완전 항목 드래프트 작성 (빈칸 = 사용자 기입용) |
