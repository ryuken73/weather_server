# 샘플 데이터

샘플 archive:

```text
assets/sample-data/kim-hgt500-text-sample.zip
```

내용:

```text
kim-hgt500-text-sample/
  2026070100/
    kim_glob_prs_hgt500_ft000_2026070100.txt
    kim_glob_prs_hgt500_ft003_2026070100.txt
```

이 샘플은 parser와 packing 동작 확인용 synthetic TXT다. 실제 기상장으로 의미가 있는 데이터가 아니며, grid는 `6x4`로 작게 만들었다.

테스트 실행 예:

```bash
python kma_fetch/python/kim_hgt_text_sequence_generator.py \
  --input-dir /tmp/kim-hgt500-text-sample/2026070100 \
  --output-dir /tmp/kim-hgt500-output/kim-glob-hgt500-2026070100 \
  --tmfc 2026070100 \
  --max-hours 3 \
  --interval 60 \
  --downsample 1
```

예상 frame 수는 `4`다. `ft000`부터 `ft003`까지 60분 간격으로 `00:00`, `01:00`, `02:00`, `03:00` frame이 만들어진다.

실제 운영 기본값인 `--downsample 3`은 이 작은 sample grid에는 맞지 않는다. sample에서는 반드시 `--downsample 1`을 사용한다.
