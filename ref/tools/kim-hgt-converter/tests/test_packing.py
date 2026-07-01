import numpy as np

from kim_hgt_converter.packing import (
    compute_stats,
    decode_rgb_to_values,
    encode_values_to_uint16,
    pack_uint16_to_rgb,
)


def test_pack_decode_round_trip_within_quantization_tolerance():
    values = np.array([[4500.0, 5000.0, 6500.0]], dtype=np.float64)

    encoded = encode_values_to_uint16(values)
    rgb = pack_uint16_to_rgb(encoded)
    decoded = decode_rgb_to_values(rgb)

    assert np.max(np.abs(decoded - values)) <= (2000.0 / 65535.0)


def test_compute_stats_counts_missing_and_clipped_values():
    values = np.array([[np.nan, 4400.0, 4500.0, 6600.0]], dtype=np.float64)

    stats = compute_stats(values)

    assert stats.frame_min == 4400.0
    assert stats.frame_max == 6600.0
    assert stats.clipped_low_count == 1
    assert stats.clipped_high_count == 1
    assert stats.missing_count == 1
