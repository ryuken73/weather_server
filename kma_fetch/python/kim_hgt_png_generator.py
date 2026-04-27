import os
import glob
import re
import argparse
from datetime import datetime, timedelta
import xarray as xr
import numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor

# ==========================================
# 설정 (Configuration)
# ==========================================
# 500hPa 지위고도(hgt)의 예상 최소/최대값 (단위: m)
# 관측값(5222~5898)을 여유 있게 포괄하도록 4500~6500으로 설정합니다.
# 클라이언트(JS)에서 값을 복원할 때 이 범위를 사용해야 합니다.
MIN_HGT = 4500.0
MAX_HGT = 6500.0

PREFIX = "g576_v091_easia_prs.2byte"
TARGET_LEV_IDX = 13  # 24개 pressure level 중 14번째 (0-based index)

def save_image_task(img_array, output_path):
    # RGB 모드(8-bit x 3채널)로 저장합니다.
    Image.fromarray(img_array, mode='RGB').save(output_path)

def process_kim_data(in_dir, tmfc, max_hours, interval, workers):
    out_base_path = os.getenv('OUT_PATH_KIM')
    
    if not out_base_path:
        raise ValueError("OUT_PATH_KIM이 설정되지 않았습니다.")

    print(f"[PRS-HGT] Processing KIM data for tmfc: {tmfc} with max_hours: {max_hours}, interval: {interval} minutes, workers: {workers}")
    print(f"[PRS-HGT] Input directory: {in_dir}, Output base path: {out_base_path}")
    tmfc_dt = datetime.strptime(tmfc, '%Y%m%d%H')
    
    # 1. 입력 파일 검색 및 정렬 (prs 파일 검색)
    search_pattern = os.path.join(in_dir, f"*_prs.*.{tmfc}.nc")
    files = sorted(glob.glob(search_pattern))
    
    # max_hours 제한 필터링
    valid_files = []
    for f in files:
        match = re.search(r'ft(\d{3})', f)
        if match:
            ef = int(match.group(1))
            if ef <= max_hours:
                valid_files.append((ef, f))
    
    valid_files.sort(key=lambda x: x[0])
    
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
            
            minutes_diff = (ef2 - ef1) * 60
            steps = minutes_diff // interval
            
            with xr.open_dataset(file1) as ds1, xr.open_dataset(file2) as ds2:
                # 🔥 xarray의 isel을 사용하여 14번째 level(index 13)의 hgt 값을 추출하고 time 차원을 스퀴즈
                val1 = np.squeeze(ds1['hgt'].isel(levs=TARGET_LEV_IDX).values)
                val2 = np.squeeze(ds2['hgt'].isel(levs=TARGET_LEV_IDX).values)

            # Vectorized 보간
            weights = np.linspace(0, 1, steps, endpoint=False)[:, np.newaxis, np.newaxis]
            interp_vals = val1 + (val2 - val1) * weights
            
            interp_clipped = np.clip(interp_vals, MIN_HGT, MAX_HGT)
            
            # 1. 16-bit 정수(0~65535)로 변환
            interp_norm16 = ((interp_clipped - MIN_HGT) / (MAX_HGT - MIN_HGT) * 65535.0).astype(np.uint16)
            
            base_frame_dt = tmfc_dt + timedelta(hours=ef1)
            
            for step_idx in range(steps):
                current_dt = base_frame_dt + timedelta(minutes=(step_idx * interval))
                
                date_folder = current_dt.strftime('%Y-%m-%d')
                out_dir = os.path.join(out_base_path, date_folder)
                os.makedirs(out_dir, exist_ok=True)
                
                # 파일명을 prs_hgt500 으로 명확히 지정
                filename = f"{PREFIX}_hgt500_{current_dt.strftime('%Y%m%d%H%M')}.png"
                output_path = os.path.join(out_dir, filename)
                
                # 2. 16-bit 값을 분할하여 8-bit RGB 배열에 패킹 (R: 상위 8비트, G: 하위 8비트)
                q = interp_norm16[step_idx]
                h, w = q.shape
                rgb_img = np.zeros((h, w, 3), dtype=np.uint8)
                
                rgb_img[..., 0] = (q >> 8) & 0xFF  # R 채널 (High Byte)
                rgb_img[..., 1] = q & 0xFF         # G 채널 (Low Byte)
                # B 채널(rgb_img[..., 2])은 0으로 유지됨
                
                executor.submit(save_image_task, rgb_img, output_path)
                global_frames += 1
                
            print(f"progress: {i+1}/{total_files-1} files processed (frames {global_frames} generated)")

        # 마지막 파일 정확히 1장 추가 저장
        last_ef, last_file = valid_files[-1]
        last_dt = tmfc_dt + timedelta(hours=last_ef)
        with xr.open_dataset(last_file) as ds_last:
            val_last = np.squeeze(ds_last['hgt'].isel(levs=TARGET_LEV_IDX).values)
            val_clipped = np.clip(val_last, MIN_HGT, MAX_HGT)
            
            val_norm16 = ((val_clipped - MIN_HGT) / (MAX_HGT - MIN_HGT) * 65535.0).astype(np.uint16)
            
            h, w = val_norm16.shape
            rgb_last = np.zeros((h, w, 3), dtype=np.uint8)
            rgb_last[..., 0] = (val_norm16 >> 8) & 0xFF
            rgb_last[..., 1] = val_norm16 & 0xFF
            
            out_dir = os.path.join(out_base_path, last_dt.strftime('%Y-%m-%d'))
            os.makedirs(out_dir, exist_ok=True)
            output_path = os.path.join(out_dir, f"{PREFIX}_hgt500_{last_dt.strftime('%Y%m%d%H%M')}.png")
            
            executor.submit(save_image_task, rgb_last, output_path)
            global_frames += 1

    print(f"[{tmfc}] done! total {global_frames} images generated.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KIM NetCDF to RGB Packed PNG Interpolator (500hPa HGT)")
    parser.add_argument('--in_dir', type=str, required=True, help="nc 파일이 있는 폴더 경로")
    parser.add_argument('--tmfc', type=str, required=True, help="분석 시간 (예: 2026040212)")
    parser.add_argument('--max_hours', type=int, default=372, help="최대 예측 시간 (기본: 372)")
    parser.add_argument('--interval', type=int, default=10, help="보간 간격 분 (기본: 10)")
    parser.add_argument('--workers', type=int, default=8, help="동시 변환 워커 수 (기본: 8)")
    
    args = parser.parse_args()
    process_kim_data(args.in_dir, args.tmfc, args.max_hours, args.interval, args.workers)