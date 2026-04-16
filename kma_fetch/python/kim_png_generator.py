import os
import glob
import re
import argparse
from datetime import datetime, timedelta
import xarray as xr
import numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor

# config.py 임포트 (필요시 활성화)

# 설정
MIN_P = 900.0
MAX_P = 1100.0
PREFIX = "g576_v091_easia_etc.2byte"

def save_image_task(img_array, output_path):
    # 16-bit 그레이스케일 모드인 'I;16'을 사용하여 저장합니다.
    Image.fromarray(img_array, mode='I;16').save(output_path)

def process_kim_data(in_dir, tmfc, max_hours, interval, workers):
    out_base_path = os.getenv('OUT_PATH_KIM')
    
    if not out_base_path:
        raise ValueError("OUT_PATH_KIM이 설정되지 않았습니다.")

    # 기준 분석시간 파싱 (예: 2026040212)
    print(f"Processing KIM data for tmfc: {tmfc} with max_hours: {max_hours}, interval: {interval} minutes, workers: {workers}")
    print(f"Input directory: {in_dir}, Output base path: {out_base_path}")
    tmfc_dt = datetime.strptime(tmfc, '%Y%m%d%H')
    
    # 1. 입력 파일 검색 및 정렬
    search_pattern = os.path.join(in_dir, f"*.{tmfc}.nc")
    files = sorted(glob.glob(search_pattern))
    
    # max_hours 제한 필터링 (정규식으로 ftXXX 부분 추출)
    valid_files = []
    for f in files:
        match = re.search(r'ft(\d{3})', f)
        if match:
            ef = int(match.group(1))
            if ef <= max_hours:
                valid_files.append((ef, f))
    
    valid_files.sort(key=lambda x: x[0]) # ef 기준으로 오름차순 정렬
    
    if len(valid_files) < 2:
        print(f"[{tmfc}] 보간을 수행하기 위한 파일이 부족합니다. (최소 2개)")
        return
    
    total_files = len(valid_files)

    print(f"[{tmfc}] total {total_files} files found for processing. (max_hours={max_hours})")
    
    global_frames = 0
    
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for i in range(total_files - 1):
            ef1, file1 = valid_files[i]
            ef2, file2 = valid_files[i+1]
            
            # 두 파일 사이의 시간(분) 계산
            minutes_diff = (ef2 - ef1) * 60
            steps = minutes_diff // interval
            
            with xr.open_dataset(file1) as ds1, xr.open_dataset(file2) as ds2:
                val1 = np.squeeze(ds1['psl'].values) / 100.0
                val2 = np.squeeze(ds2['psl'].values) / 100.0

            # Vectorized 보간
            weights = np.linspace(0, 1, steps, endpoint=False)[:, np.newaxis, np.newaxis]
            interp_vals = val1 + (val2 - val1) * weights
            
            interp_clipped = np.clip(interp_vals, MIN_P, MAX_P)
            # [수정됨] 8-bit(255)에서 16-bit(65535)로 변환 및 uint16 적용
            interp_norm = ((interp_clipped - MIN_P) / (MAX_P - MIN_P) * 65535.0).astype(np.uint16)
            
            # 프레임별 파일 저장
            base_frame_dt = tmfc_dt + timedelta(hours=ef1)
            
            for step_idx in range(steps):
                current_dt = base_frame_dt + timedelta(minutes=(step_idx * interval))
                
                # 출력 디렉토리: OUT_PATH_KIM / YYYY-MM-DD (해당 프레임의 날짜 기준)
                date_folder = current_dt.strftime('%Y-%m-%d')
                out_dir = os.path.join(out_base_path, date_folder)
                os.makedirs(out_dir, exist_ok=True)
                
                # 파일명: g576_v091_easia_etc.2byte_psl_202604030010.png
                filename = f"{PREFIX}_psl_{current_dt.strftime('%Y%m%d%H%M')}.png"
                output_path = os.path.join(out_dir, filename)
                
                executor.submit(save_image_task, interp_norm[step_idx], output_path)
                global_frames += 1
            print(f"progress: {i+1}/{total_files-1} files processed (frames {global_frames} generated)")

        # 마지막 파일 정확히 1장 추가 저장
        last_ef, last_file = valid_files[-1]
        last_dt = tmfc_dt + timedelta(hours=last_ef)
        with xr.open_dataset(last_file) as ds_last:
            val_last = np.squeeze(ds_last['psl'].values) / 100.0
            val_clipped = np.clip(val_last, MIN_P, MAX_P)
            # [수정됨] 8-bit(255)에서 16-bit(65535)로 변환 및 uint16 적용
            val_norm = ((val_clipped - MIN_P) / (MAX_P - MIN_P) * 65535.0).astype(np.uint16)
            
            out_dir = os.path.join(out_base_path, last_dt.strftime('%Y-%m-%d'))
            os.makedirs(out_dir, exist_ok=True)
            output_path = os.path.join(out_dir, f"{PREFIX}_psl_{last_dt.strftime('%Y%m%d%H%M')}.png")
            
            executor.submit(save_image_task, val_norm, output_path)
            global_frames += 1

    print(f"[{tmfc}] done! total {global_frames} images generated.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KIM NetCDF to PNG Interpolator")
    parser.add_argument('--in_dir', type=str, required=True, help="nc 파일이 있는 폴더 경로")
    parser.add_argument('--tmfc', type=str, required=True, help="분석 시간 (예: 2026040212)")
    parser.add_argument('--max_hours', type=int, default=372, help="최대 예측 시간 (기본: 372)")
    parser.add_argument('--interval', type=int, default=10, help="보간 간격 분 (기본: 10)")
    parser.add_argument('--workers', type=int, default=8, help="동시 변환 워커 수 (기본: 8)")
    
    args = parser.parse_args()
    
    process_kim_data(args.in_dir, args.tmfc, args.max_hours, args.interval, args.workers)