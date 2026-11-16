// 采集输出的纯计算（与 WGC 无关，可在单元测试里验证）。

pub fn output_size(width: u32, height: u32, resolution: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (resolution * 16 / 9 / 2 * 2, resolution);
    }
    let short = width.min(height) as f64;
    let long = width.max(height) as f64;
    let scale = (resolution as f64 / short)
        .min((resolution as f64 * 16.0 / 9.0) / long)
        .min(1.0);
    let even = |value: f64| ((value.round() as u32) / 2 * 2).max(2);
    (even(width as f64 * scale), even(height as f64 * scale))
}

pub fn validate(resolution: u32, frame_rate: u32) -> Result<(), String> {
    if ![720, 1080, 1440, 2160].contains(&resolution) {
        return Err("无效的共享分辨率".into());
    }
    if ![30, 60, 120].contains(&frame_rate) {
        return Err("无效的共享帧率".into());
    }
    Ok(())
}

/// RGBA 最近邻缩放。32 位定点步进，避免每像素两次除法——那是共享帧率
/// 上不去的首要原因（1080p 每帧 200 万次除法会吃掉几十毫秒）。
pub fn scale_rgba(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let pixels = width as usize * height as usize * 4;
    let src_stride = src_width as usize * 4;
    if src.len() < src_stride * src_height as usize || width == 0 || height == 0 {
        return Vec::new();
    }
    if width == src_width && height == src_height {
        return src[..pixels].to_vec();
    }
    let mut out = vec![0u8; pixels];
    let step_x = ((src_width as u64) << 32) / width as u64;
    let step_y = ((src_height as u64) << 32) / height as u64;
    let dst_row = width as usize * 4;
    let mut acc_y = step_y / 2;
    for y in 0..height as usize {
        let sy = (acc_y >> 32) as usize;
        let src_row = &src[sy * src_stride..];
        let dst = &mut out[y * dst_row..(y + 1) * dst_row];
        let mut acc_x = step_x / 2;
        for px in dst.chunks_exact_mut(4) {
            let sx = (acc_x >> 32) as usize;
            let index = sx * 4;
            px.copy_from_slice(&src_row[index..index + 4]);
            acc_x += step_x;
        }
        acc_y += step_y;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_aspect_and_never_upscales() {
        assert_eq!(output_size(3840, 2160, 1080), (1920, 1080));
        assert_eq!(output_size(2160, 3840, 1080), (1080, 1920));
        assert_eq!(output_size(1280, 720, 2160), (1280, 720));
        assert_eq!(output_size(2560, 1600, 720), (1152, 720));
        assert_eq!(output_size(5120, 1440, 1080), (1920, 540));
    }

    #[test]
    fn rejects_unknown_quality() {
        assert!(validate(1080, 30).is_ok());
        assert!(validate(1000, 30).is_err());
        assert!(validate(1080, 15).is_err());
    }

    #[test]
    fn scale_rgba_downsamples_nearest_neighbor() {
        // 4×2 源图，每个像素写 (x, y)。缩到 2×1 时按像素中心采样，
        // 取 x=1,3 与 y=1 的四个点。
        let mut src = Vec::new();
        for y in 0..2u8 {
            for x in 0..4u8 {
                src.extend_from_slice(&[x, y, 0, 255]);
            }
        }
        let out = scale_rgba(&src, 4, 2, 2, 1);
        assert_eq!(out.len(), 2 * 1 * 4);
        assert_eq!(&out[0..4], &[1, 1, 0, 255]);
        assert_eq!(&out[4..8], &[3, 1, 0, 255]);
    }

    #[test]
    fn scale_rgba_copies_when_sizes_match() {
        let src: Vec<u8> = (0..2 * 2 * 4).map(|i| i as u8).collect();
        assert_eq!(scale_rgba(&src, 2, 2, 2, 2), src);
        assert!(scale_rgba(&[0u8; 8], 2, 2, 2, 2).is_empty());
    }

}
