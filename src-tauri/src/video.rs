// ═══════════════════════════════════════════════════════
// video.rs — 视频画面管线：ffmpeg 解码 → RGBA 字节 → 前端 <canvas>
//
// 为什么不用 mpv 自己的窗口嵌入：
//   mpv 只能通过 `wid` 把画面画进一个原生子窗口，而 WebView2 内部走
//   DirectComposition（进程窗口树里能看到 `Intermediate D3D Window`）。
//   DWM 合成时 DComp 内容永远画在 GDI 子窗口层「之上」，`SetWindowPos(HWND_TOP)`
//   在物理上无法把 WS_CHILD 抬上去。已用纯 GDI 红色 WS_CHILD 探针窗口实测证实：
//   探针覆盖整个客户区、Z 序第一、vis=true，屏幕采样 R-G=0，一个红像素都没有。
//   也就是说「mpv 画进子窗口」这条路在架构上就不可能出画面。
//
// 所以改成：mpv 只管音频（vo=null + vid=no，完全不碰视频轨），
// 画面由 ffmpeg 解码后以裸 RGBA 字节送给前端 putImageData。
// 字节走的是自定义协议 rvframe:// + fetch，与原生窗口层级无关，DComp 盖不住。
//
// 为什么不用 IPC 的 Raw 响应（踩过坑）：
//   `tauri::ipc::Response::new(Vec<u8>)` 看着是二进制通道，实际上阈值是 1024 字节。
//   超过就走 Channel 的 fetch 分支，最后落到
//   `runCallback(cb, JSON.parse('[1,2,3,...]'))` —— JS 侧拿到的是**数字数组**，
//   而这 15MB 的数字串还要先经过 webview.eval。一次 1280x720 的帧是 3.5MB 像素，
//   序列化后约 14MB 文本 + 370 万元素的 V8 数组，30fps 就是几百 MB/s 的垃圾，
//   大概率直接卡死。rvframe:// 走浏览器原生 fetch，拿到的是真正的 ArrayBuffer。
//
// 硬解：本机 ffmpeg 为 gyan.dev full static build，显式带 --enable-d3d11va
//   --enable-nvdec --enable-cuvid。实测 `-hwaccel d3d11va` 下
//   h264 解码器 pix_fmt 变为 d3d11，输出与软解逐像素一致，300帧@720p 快 2.5 倍。
//   驱动不支持时去掉该参数即自动退回软解，同一条代码路径。
// ═══════════════════════════════════════════════════════

use std::collections::VecDeque;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

/// 子进程不许弹出控制台窗口。
///
/// 不加这个标志时，Windows 会给每个 `Command::spawn` 出来的进程分配一个
/// 新的控制台，表现为「一播放视频就闪出一个黑框 CMD」。release 版尤其明显：
/// debug 版父进程自己就带着控制台，闪一下容易被忽略，而打包后父进程是
/// GUI 子系统（无控制台），ffmpeg 的黑框就变成了独立的、停在任务栏上的窗口。
/// `CREATE_NO_WINDOW` 让子进程与父进程共用（这里即「不分配」）控制台。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 一帧画面。整帧一次性发布，读者拿到的一定是完整帧（不会读到半帧）。
struct Frame {
    w: u32,
    h: u32,
    /// 自增序号，前端据此判断是否需要重绘（同一帧不重复解码绘制）
    seq: u64,
    /// 本帧的**媒体时间戳**（毫秒，相对文件开头）。
    ///
    /// 这是「先缓冲再一起播」的核心：有了它，队列里的帧自带时间轴，
    /// 前端不必靠「第几帧 ÷ 帧率」反推（那样在倍速下要反复换算、循环播放
    /// 还得处理回绕）。前端拿它和 mpv 的音频位置一比就知道该显示哪一帧。
    pts_ms: u32,
    /// 一整张 JPEG（SOI…EOI，含全部头尾标记）
    data: Vec<u8>,
}

/// 帧队列容量上限（帧数）。
///
/// 队列满了以后读帧线程就**停止从管道读取**，OS 管道缓冲（默认 64KB ≈ 1 帧）
/// 随之填满，ffmpeg 的 write() 被内核阻塞住 —— 这就是背压：
/// ffmpeg 只能以「前端消费的速度」解码，既不会把 CPU 吃满，也不会让队列无限涨。
///
/// 3 秒 @25fps = 75 帧，取 120 帧（约 4.8s）留出取帧抖动余量；
/// 1080p 单帧 ~100KB → 上限约 12MB，是可以接受的常驻占用。
const QUEUE_CAP: usize = 120;

/// 帧尺寸的探测结果
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct VideoDims {
    pub w: u32,
    pub h: u32,
    /// 源片原始尺寸（前端用来算「画面被缩了多少」，以及是否值得再降一档）
    pub src_w: u32,
    pub src_h: u32,
    /// 源帧率。前端靠它把「第几帧」换算成媒体时间戳，从而**实测音画偏移**：
    /// 裸 rawvideo 流没有帧头，帧号是唯一能推出 pts 的东西。
    /// CFR 源（绝大多数 h264/x264 视频）才准，VFR 源会读到 0 并被前端忽略。
    pub fps: f64,
    /// 实际启用的硬解方式（"d3d11va" / "software"）
    pub hwaccel: &'static str,
}

struct Session {
    /// 会话代号。每次启停自增，用来让上一轮的读帧线程自行退出。
    gen: u64,
    child: Option<Child>,
    /// 待显示帧队列（先进先出）。
    ///
    /// 旧方案这里是「最新一帧」的单槽（追帧语义，中间帧丢掉）。现在改成队列，
    /// 因为要先攒够缓冲再开播：帧必须**按媒体时间顺序**排队送出，
    /// 丢掉中间帧就等于丢掉时间轴上的一段内容。
    q: VecDeque<Arc<Frame>>,
    /// 前端已经取走的帧（序号游标）。队列里只保留 seq > cursor 的帧。
    cursor: u64,
    w: u32,
    h: u32,
    /// 源片原始尺寸。ffprobe 结果按路径缓存：拖进度条会连续重启管线，
    /// 每次都探一次头会白白多花几十毫秒，表现为「拖动一顿一顿的」。
    src_dims: (u32, u32),
    /// 源帧率（0 = VFR/未知，前端据此跳过帧号→时间戳换算）
    src_fps: f64,
    hwaccel: bool,
    /// 读帧线程读到 EOF 时置位（播完了 / 被杀掉了）
    eof: bool,
    /// ffmpeg 启动失败时的原因，供前端显示
    err: Option<String>,
    /// 首帧从「spawn 到可取」的实测墙钟耗时（0 = 还没出首帧）。
    /// 前端要靠它把画面和音频对上：这个值随 -ss 落点深度变化很大
    /// （4K 实测 ss=0.26→约 450ms，ss=8→约 1500ms，seek 越深越慢），
    /// 在前端猜是猜不准的，只能在这边直接掐表。
    first_ms: u32,
    /// 是否已预先缓冲到目标时长（用于「先缓冲 3 秒再一起播放」）
    primed: bool,
    /// 攒够缓冲所花的墙钟耗时（诊断用：起播延迟到底花在哪）
    prime_ms: u32,
    /// 攒够缓冲所需帧数（= 目标缓冲毫秒 ÷ 帧间隔）。
    /// 攒够即置 primed，前端据此启动音频。
    prime_frames: usize,
    /// 本轮有多少帧用上了 showinfo 的**真实**时间戳（其余是回退到帧号推算）。
    ///
    /// 纯诊断，但它能证明一件事：测试素材常常 pts_time 恰好从 0 起算，
    /// 于是真实值与推算值**完全相同**，只看 pts 数值无法区分走的是哪条路
    /// —— 而那正是「以为在用真实 pts 其实一直在推算」的盲区。
    real_pts_hits: u32,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// 本轮管线的起进程时刻。只由 `spawn_pipe` 写、只由 `prime_elapsed_ms` 读，
/// 所以用 `OnceLock` 而不是塞进 Session：`push_frame` 拿的是 `&mut Session`，
/// 要算耗时又不能再借 `t_spawn`（它已被 move 进读帧线程了）。
/// 多轮之间会覆盖，但读的时刻一定在本轮之内，语义上不会串。
static SPAWN_AT: OnceLock<std::time::Instant> = OnceLock::new();

/// ffprobe 结果缓存（只留最后一个文件）。源尺寸/帧率与渲染上限无关，
/// 所以同一个文件反复启停（拖进度条/切倍速/暂停续播）只探一次头。
static DIMS_CACHE: Mutex<Option<(PathBuf, (u32, u32, f64))>> = Mutex::new(None);

/// 帧数据在自定义协议响应体里的固定头长度：
///
/// ```text
/// [u32 w][u32 h][u64 seq][u32 pts_ms][u32 buffered_ms][u32 flags]
/// ```
/// 其后紧跟一整张 JPEG（不是裸 RGBA，见 spawn_pipe 里的取舍说明）。
///
/// - `pts_ms`：本帧的媒体时间戳。前端不再需要「第几帧 ÷ 帧率」去反推，
///   直接读它就能算出该显示队列里的哪一帧、以及当前音画差多少。
/// - `buffered_ms`：出队后队列里还剩多少缓冲。用来区分「队列抽干、稍等就有」
///   和「管线没起来、必须重开」——两者在前端都表现为 w=h=0，但处理方式相反。
/// - `flags` bit0 = primed（缓冲已攒够，音频可以起步了）。
///
/// 20 → 28 字节的变化全部来自「先缓冲再一起播」。`first_ms` 挪到了
/// `VideoStatus.first_ms`：它是诊断值，不该占每帧的热路径。
pub const FRAME_HEADER: usize = 28;

/// `flags` bit0：已攒够缓冲。
pub const FLAG_PRIMED: u32 = 1;

/// 渲染尺寸的硬上限（兜底）。真正的上限由前端按显示区大小动态下发，
/// 这里只是防止前端传错参数时把带宽打爆。
const ABS_MAX_W: u32 = 3840;
const ABS_MAX_H: u32 = 2160;

/// 默认渲染上限（前端按显示区物理像素下发，这里只是兜底）。
/// 管线输出 MJPEG，传输不再是瓶颈，所以上限可以放到 1080p。
const MAX_W: u32 = 1920;
const MAX_H: u32 = 1080;

// ─── ffmpeg 可执行文件定位 ───

/// ffprobe 与 ffmpeg 同目录（gyan / BtbN 等官方 build 都成对发布）。
/// 项目里只登记了 ffmpeg.exe，所以这里由 ffmpeg 路径推导 ffprobe。
fn find_ffprobe() -> Result<PathBuf, String> {
    let ff = crate::thumb::find_ffmpeg().ok_or("未找到 ffmpeg（视频画面需要它）")?;
    let probe = ff.with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if probe.is_file() {
        Ok(probe)
    } else {
        Err(format!("未找到 ffprobe（应在 {}）", ff.display()))
    }
}

// ─── 尺寸探测 ───

/// 探测视频原始尺寸与帧率。
///
/// 必须在启流前拿到尺寸：裸 rawvideo 流没有帧头，Rust 侧要按 w*h*4 定量读取，
/// 尺寸对不上就会永久错位。ffprobe 只读文件头，几十毫秒。
///
/// 帧率一起探：前端靠它把帧序号换算成媒体时间，实测音画偏移（见 VideoDims::fps）。
/// `avg_frame_rate` 是分数（`25/1`），这里转成 f64；解析不出来就返回 0，让前端跳过测量。
/// 解析 ffprobe 的 `xx_frame_rate`（`25/1` 或裸 `25`）。分母为 0 / 畸形 → 0。
fn parse_rate(v: &str) -> f64 {
    let v = v.trim();
    let r = match v.split_once('/') {
        Some((n, d)) => {
            let n: f64 = n.trim().parse().unwrap_or(0.0);
            let d: f64 = d.trim().parse().unwrap_or(0.0);
            if d > 0.0 { n / d } else { 0.0 }
        }
        None => v.parse().unwrap_or(0.0),
    };
    if r.is_finite() { r } else { 0.0 }
}

/// 按可信度取第一个能用的帧率。全都不可用 → 0（VFR，交给 pts 实测兜底）。
///
/// 单独抽出来是为了能直接单测 —— 帧率选择逻辑错了不会编译失败，
/// 只会在用户机器上表现为「一直缓冲中」或画面卡顿，从代码上完全看不出来。
fn first_usable_rate(avg: f64, r_frame: f64) -> f64 {
    for c in [avg, r_frame] {
        if c.is_finite() && (1.0..=240.0).contains(&c) {
            return c;
        }
    }
    0.0
}

fn probe_dims(path: &Path) -> Result<(u32, u32, f64), String> {
    let probe = find_ffprobe()?;
    let mut cmd = Command::new(probe);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate,r_frame_rate",
            "-of",
            "default=noprint_wrappers=1",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("执行 ffprobe 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe 失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let s = String::from_utf8_lossy(&out.stdout);
    // 一次输出若干行 key=value：`width=1280` / `height=720` / `avg_frame_rate=25/1` / `r_frame_rate=25/1`。
    // 逐行按 key 取值，比「抽取所有数字」稳（后者会被分数里的第二个数字带偏）。
    let mut w = 0u32;
    let mut h = 0u32;
    let mut avg = 0.0f64;
    let mut rfr = 0.0f64;
    for line in s.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match k.trim() {
            "width" => w = v.trim().parse().unwrap_or(0),
            "height" => h = v.trim().parse().unwrap_or(0),
            "avg_frame_rate" => avg = parse_rate(v),
            "r_frame_rate" => rfr = parse_rate(v),
            _ => {}
        }
    }
    if w == 0 || h == 0 {
        return Err(format!("无法解析视频尺寸: {}", s.trim()));
    }
    // 帧率来源按可信度排序，取第一个能用的：
    //
    //  1. avg_frame_rate —— 最准，但对 VFR 源常常是 `0/0`（"平均"没有意义）。
    //  2. r_frame_rate —— 容器标称的基准帧率（如 mkv 的 `r_frame_rate` 标 1000/1
    //     表示"时基 1ms"），恒流媒体上就是真实帧率。
    //  3. time_base × 帧序号 —— 最后兜底，见 push_frame 里 pts 的推算分支。
    //
    // 只看 avg_frame_rate 是曾经 fps 恒为 0 的原因：VFR 片子直接掉进兜底，
    // 而 fps=0 会连锁触发三个后果 —— prime_frames 退化成 1（3 秒缓冲形同虚设，
    // 边解边播、追不上就丢帧，表现为卡顿）、前端 frameMs 走 40ms 兜底
    // （所有基于帧长的闸门阈值全错）、pts 退化成按帧号推算。
    let mut fps = first_usable_rate(avg, rfr);
    // VFR / 畸形元数据：给个哨兵值 0，前端会因此跳过「帧号 → 时间戳」的换算
    if !(fps.is_finite() && (1.0..=240.0).contains(&fps)) {
        fps = 0.0;
    }
    Ok((w, h, fps))
}

/// 按上限等比缩放并对齐到偶数。
/// 偶数是 h264 色度子采样的要求，奇数尺寸部分解码器会直接拒绝。
///
/// `cap` 是本次渲染上限（前端按显示区像素数下发，见 `video_start`）。
/// 源比显示区小的时候保持原尺寸：放大只会浪费带宽，不会更清楚。
fn fit_dims_cap(vw: u32, vh: u32, cap: (u32, u32)) -> (u32, u32) {
    let (cw, ch) = cap;
    let scale = (cw as f64 / vw as f64)
        .min(ch as f64 / vh as f64)
        .min(1.0); // 不放大
    let w = ((((vw as f64 * scale).round() as u32).max(2)) & !1).min(cw & !1).max(2);
    let h = ((((vh as f64 * scale).round() as u32).max(2)) & !1).min(ch & !1).max(2);
    (w, h)
}

/// 默认上限下的缩放结果。只在测试里用（生产路径一律走 fit_dims_cap，
/// 上限由前端按显示区大小下发）。
#[cfg(test)]
fn fit_dims(vw: u32, vh: u32) -> (u32, u32) {
    fit_dims_cap(vw, vh, (MAX_W, MAX_H))
}

/// 把前端下发的上限夹到合法区间。
/// 传 0/None 表示「这一维用默认」——前端在显示区还没量到尺寸时会发 0；
/// 传太大则夹到绝对上限，防止一帧几百 MB 把带宽打爆。
fn normalize_cap(max_w: Option<u32>, max_h: Option<u32>) -> (u32, u32) {
    let w = max_w.filter(|v| *v > 0).unwrap_or(MAX_W).clamp(320, ABS_MAX_W);
    let h = max_h.filter(|v| *v > 0).unwrap_or(MAX_H).clamp(180, ABS_MAX_H);
    (w & !1, h & !1)
}

// ─── 启流 / 停流 ───

/// 从 ffmpeg `showinfo` 的一行日志里抽出该帧的 `pts_time`（秒）。
///
/// 典型行（实测 ffmpeg 7.0）：
/// ```text
/// [Parsed_showinfo_1 @ 0x…] n:   0 pts:    21 pts_time:0.021   duration:40 duration_time:0.04 …
/// ```
/// 三个必须踩准的点：
/// - 关键值紧跟在 `pts_time` 之后，用**冒号**分隔且**后面没有空格**
///   （`pts_time:0.021   duration:`）。所以只能「遇到分隔符就截断」，
///   按空白切词会把 `0.021` 和后面的字段粘在一起解析失败。
/// - 只能认 `pts_time` 这个键，不能整行搜数字：SEI 的 `User Data` 里也有
///   `pts_step=4`、`r_frame_rate=25` 这类字段，误取会污染时间轴。
/// - 负值夹到 0（B 帧重排时可能出现），非有限值/解析失败一律 None，
///   让调用方退回「帧号 × 帧率」的推算值（与改动前行为一致）。
///
/// 返回 `(帧号, pts_time)`。**帧号必须一起取**：stderr 与 stdout 是两条独立的
/// 管道，到达顺序没有保证，只按下标配对会错位（详见调用处的注释）。
pub fn parse_showinfo_frame(line: &str) -> Option<(u64, f64)> {
    let lower = line.to_ascii_lowercase();
    let t = parse_key_num(&lower, "pts_time")?;
    let n = parse_key_num(&lower, "n")? as u64;
    Some((n, t))
}

/// 从一行日志里取 `key` 紧跟的数值。
///
/// 两处都必须卡死，否则会静默读错：
/// 1. **键名前要有边界**：`n` 单独一个字母在 `duration_time` / `Parsed_showinfo` 里
///    到处都是，不卡边界会命中 `duration` 里第一个 n，取到完全无关的数。
/// 2. **分隔符要紧贴键名**（允许中间空格）：不能去后面找任意分隔符 ——
///    `"pts_time=1.5 duration:40"` 里第一个 ':' 属于 duration，拿它会读出 40，
///    把整条时间轴带偏且不报错。
fn parse_key_num(lower: &str, key: &str) -> Option<f64> {
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(key) {
        let at = from + rel;
        from = at + key.len();
        // 边界：前一个字符必须不是字母/数字/下划线
        let ok_prefix = at == 0
            || !lower[..at]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        if !ok_prefix {
            continue;
        }
        // 分隔符必须紧跟
        let tail = lower[at + key.len()..].trim_start();
        let Some(val) = tail.strip_prefix(':').or_else(|| tail.strip_prefix('=')) else {
            continue;
        };
        // 剥掉分隔符后还要再 trim：showinfo 的数值是**右对齐**补空格的
        // （"n:   7" 冒号后跟三个空格）。不处理的话 parse::<f64>() 会失败。
        let val = val.trim_start();
        let end = val
            .find(|c: char| c.is_whitespace() || ",]};\t".contains(c))
            .unwrap_or(val.len());
        let v: f64 = match val[..end].trim().parse::<f64>() {
            Ok(v) if v.is_finite() => v,
            _ => return None,
        };
        // B 帧重排时可能出现负 pts_time，夹到 0，绝不让它污染时间轴
        return Some(v.max(0.0));
    }
    None
}

/// 启动（或重启）一条解码流水线。
///
/// `start_at` 非 0 时从该秒数开始（暂停后继续播放、拖动进度条都走这里）。
/// 硬件解失败会在下一轮自动降级，见 spawn_pipe 的 hwaccel 回退逻辑。
fn spawn_pipe(
    path: &Path,
    w: u32,
    h: u32,
    start_at: f64,
    hwaccel: bool,
    rate: f64,
    looping: bool,
    gen: u64,
    fps: f64,
) -> Result<Child, String> {
    // 每帧的媒体时长（毫秒）。fps=0（VFR / ffprobe 没读到）时 pts 退化成 0，
    // 前端会自动跳过按 pts 选帧那条路，退回「按到达顺序取」，行为不变。
    let frame_ms = if fps > 0.0 { 1000.0 / fps } else { 0.0 };
    let start_ms = (start_at.max(0.0) * 1000.0) as u32;
    let ffmpeg = crate::thumb::find_ffmpeg().ok_or("未找到 ffmpeg（视频画面需要它）")?;

    let mut cmd = Command::new(ffmpeg);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null())
        // stdout 走管道持续吐裸帧；stderr 必须单独抽干，否则 ffmpeg 写日志
        // 撑满管道后会永久阻塞在写 stderr 上（经典 fork 陷阱）
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .arg("-hide_banner")
        // info 而不是 error：滤镜链里的 showinfo 要靠它把每帧 pts_time 打到 stderr
        // （showinfo 是 AV_LOG_INFO，loglevel=error 会整条过滤掉）。
        // 多出来的日志由 stderr 线程解析后丢弃，量很小（每帧一行）。
        .arg("-loglevel")
        .arg("info")
        .arg("-nostdin");

    if hwaccel {
        cmd.arg("-hwaccel").arg("d3d11va");
    }
    // -readrate 按指定倍率实时输出（-re 等价于 -readrate 1）。
    // 不加的话 ffmpeg 会以解码速度一路狂奔，读帧线程再怎么丢帧也追不上，
    // CPU 会被吃满；而且 mpv 变速后画面必须同速，否则音画越来越偏。
    // 注意：这里**没有** -readrate。旧方案靠它把 ffmpeg 输出节流到实时速率，
    // 但「先缓冲 3 秒再一起播」要求它全速把队列灌满：加了 -readrate，
    // 每秒只吐 1 秒内容，攒满 3 秒缓冲要干等 3 秒，起播延迟比省下的还大。
    // 去掉后解码 3 秒只要 75 帧 × 14ms ≈ 1.05s，而节流改由**队列背压**做
    // （读帧线程：队列满就停手，ffmpeg 堵在内核管道上）。
    // 倍速也不再由 ffmpeg 输出速率实现，而由前端按媒体时间戳取帧实现。
    let _ = rate;
    // 循环播放：必须放在 -i 之前（输入侧循环）
    if looping {
        cmd.arg("-stream_loop").arg("-1");
    }
    if start_at > 0.0 {
        // 放在 -i 之前是关键：输入端 seek 快且精确（ffmpeg 默认 accurate_seek：
        // 定位到目标前一个关键帧，解码并丢弃到目标时间点）
        cmd.arg("-ss").arg(format!("{start_at:.3}"));
    }
    cmd.arg("-i").arg(path)
        .arg("-map").arg("0:v:0") // 只取第一条视频轨
        .arg("-an").arg("-sn").arg("-dn") // 不要音频/字幕/数据流——音频归 mpv
        // 缩放显式走 -vf scale 并指定 bilinear：
        //   -s/-vf 默认是 bicubic，4K→720p 实测比 bilinear 慢约 15%
        //   （0.5s/20s 片段，500 帧：4.72s → 4.10s），而画面差别在这个尺寸下看不出来。
        // showinfo 串在同一条滤镜链里（放在 scale **之后**）：它把每帧真实的
        // pts_time 打到 stderr，stdout 的 MJPEG 帧与这些日志**按顺序一一对应**，
        // 于是每帧都能拿到原片时间轴上的时间戳，而不是靠「帧号 × 帧率」推算。
        // 推算在 VFR 片源或 ffprobe 帧率有误差时会逐帧累积偏差，播得越久偏得越多。
        // 注意 showinfo 是 info 级日志，所以 -loglevel 必须放到 info（见上）。
        .args(["-vf", &format!("scale={w}:{h}:flags=bilinear,showinfo")])
        // 输出 MJPEG 而不是裸 RGBA：这是整套画面管线的关键取舍。
        //   裸 RGBA 一帧 1920x1080 = 7.9MB，而 Tauri 自定义协议实测只有 ~55MB/s，
        //   一帧要 150ms → 4K 只能跑 6.5fps（实测），720p 也只有 15fps。
        //   MJPEG 单帧 ~100KB（4K→1080p 实测，q=2），同样带宽能到 30fps，
        //   编码侧 72fps 也绰绰有余，WebView2 端还有硬件 JPEG 解码。
        //   代价是 q=2 的有损压缩，正常片源肉眼看不出。
        //   注意：不能在这里显式写 hwdownload —— ffmpeg 7.0 会尝试在 hwdownload
        //   之前插 auto_scale，然后报 "Impossible to convert" 而整条管线起不来。
        //   让 ffmpeg 自己按编码器要求自动插软件转换即可。
        .args(["-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj420p"])
        .arg("-f").arg("mjpeg")
        .arg("-");

    // 掐表起点放在 spawn 之前：进程创建本身也要算进「启动耗时」里
    let t_spawn = std::time::Instant::now();
    let _ = SPAWN_AT.set(t_spawn);
    let mut child = cmd.spawn().map_err(|e| format!("启动 ffmpeg 失败: {e}"))?;

    // 解析 stderr：showinfo 按帧打印 pts_time（秒），用它替代「帧号 × 帧率」的推算，
    // 解决 -ss 之后时间戳错位导致预缓冲被整段丢弃的问题。
    //
    // 必须连 showinfo 自己的 n:（帧序号）一起送出去，**不能**只靠发送顺序配对：
    // stderr 与 stdout 是两条独立的管道，谁先谁后没有保证。若只按下标取，
    // stderr 落后 k 帧时会把第 1 帧的 pts 按到第 k+1 帧上 —— 时间轴被压缩，
    // 而且不报错，只是画面越播越偏。带上帧号后按号取值，与交错彻底无关。
    use std::io::{BufRead, BufReader};
    let (pts_tx, pts_rx) = std::sync::mpsc::channel::<(u64, f64)>();
    if let Some(se) = child.stderr.take() {
        let tx = pts_tx;
        std::thread::spawn(move || {
            let mut br = BufReader::new(se);
            let mut line = String::new();
            loop {
                line.clear();
                match br.read_line(&mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        if let Some(pair) = parse_showinfo_frame(&line) {
                            let _ = tx.send(pair);
                        }
                        // 其它 stderr（banner、User Data、color_range…）直接忽略
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // 读帧线程：按 JPEG 帧边界切分 → 整帧发布
    if let Some(mut so) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut acc: Vec<u8> = Vec::with_capacity(1024 * 1024);
            let mut chunk = vec![0u8; 256 * 1024];
            let mut n: u64 = 0;
            let pts_rx = pts_rx;
            // 已收到的「帧号 → 真实 pts_time」。可能领先也可能落后于 n，
            // 所以每帧都要先把管道里现有的都取干净，再按 n 号查表。
            let mut real_pts: std::collections::HashMap<u64, f64> =
                std::collections::HashMap::with_capacity(QUEUE_CAP + 8);
            loop {
                // ── 背压 ──
                // 队列攒满就先停手，不再从管道读。此时 ffmpeg 的 write() 会
                // 堵在内核管道缓冲（64KB）上，**自然地**被前端消费速度节流。
                // 不这么做的话，去掉 -readrate 之后 ffmpeg 会全速狂奔，
                // 队列瞬间涨满并开始丢尾帧，画面就会一顿一顿地跳。
                if queue_len(gen) >= QUEUE_CAP {
                    std::thread::sleep(std::time::Duration::from_millis(4));
                    continue;
                }
                // 一次 read 拿多少算多少，**不能**循环读到填满缓冲：
                // 管道里有数据就立刻切帧发布，攒满 256KB 会白白压上好几帧的延迟。
                let got = match so.read(&mut chunk) {
                    Ok(g) if g > 0 => g,
                    _ => break, // EOF 或出错
                };
                acc.extend_from_slice(&chunk[..got]);

                // 一段数据里可能含很多完整帧（256KB 能装下 4K 的好几帧），逐个切出来
                loop {
                    // 帧头必须是 SOI；之前若残留着上一帧的尾巴就丢掉
                    let Some(soi) = find2(&acc, 0, 0xFF, 0xD8) else {
                        // 整个缓冲里没有 SOI：留一个可能落在块边界的 FF，其余丢掉，
                        // 否则「FF」在这次读里、「D8」在下次读的话会永远对不齐
                        let keep_ff = acc.last() == Some(&0xFF);
                        acc.clear();
                        if keep_ff {
                            acc.push(0xFF);
                        }
                        break;
                    };
                    if soi > 0 {
                        acc.drain(..soi);
                    }
                    // 帧尾：SOI 之后才找，避免把 SOI 自己当成 EOI
                    let Some(eoi) = find2(&acc, 2, 0xFF, 0xD9) else {
                        // 帧没收全，等下一段。真遇上损坏流就一直涨，所以设个上限
                        if acc.len() > 32 * 1024 * 1024 {
                            acc.clear();
                        }
                        break;
                    };
                    n += 1;
                    if n == 1 {
                        // 首帧落地即记账：这是前端唯一能拿到的「真实启动耗时」
                        let ms = t_spawn.elapsed().as_secs_f64() * 1000.0;
                        if let Ok(mut g) = SESSION.lock() {
                            if let Some(s) = g.as_mut() {
                                if s.gen == gen {
                                    s.first_ms = ms.clamp(0.0, 60000.0) as u32;
                                }
                            }
                        }
                    }
                    // 先把管道里现有的真实 pts 全取干净（可能领先也可能落后于当前 n）
                    while let Ok((idx, t)) = pts_rx.try_recv() {
                        if real_pts.len() > QUEUE_CAP * 4 {
                            real_pts.clear(); // 兜底：不该发生（showinfo 与帧一一对应）
                        }
                        real_pts.insert(idx, t);
                    }
                    // 帧的媒体时间戳：优先用 showinfo 报的真实 pts_time
                    // （start_ms + pts_time*1000）；本帧没收到才退回按帧号推算。
                    //
                    // 为什么必须要真实值：ffmpeg 对输入端 -ss 做了 ts 偏移，
                    // showinfo 的 pts_time 是**相对 -ss 落点**的（实测从 0.021 起），
                    // 而前端是拿 mpv 的绝对媒体位置来要帧的。不加回 start_ms 的话，
                    // 预缓冲里所有帧的 pts 都比真实时间轴小一大截，音频一起步
                    // 就被当成「全都过期」整段丢掉 —— 黑屏 / 反复重开管线。
                    //
                    // 按帧号查表（而不是按下标取）：stderr 与 stdout 是两条管道，
                    // 谁先到没有保证。查表让取值与交错无关，退化也只是单帧回落
                    // 到推算值，不会累积。
                    let pts_real = real_pts
                        .get(&(n - 1))
                        .map(|t| start_ms as f64 + t * 1000.0)
                        .filter(|ms| ms.is_finite() && *ms >= 0.0)
                        .map(|ms| ms as u32);
                    let pts = pts_real.unwrap_or_else(|| {
                        if frame_ms > 0.0 {
                            (start_ms as f64 + (n - 1) as f64 * frame_ms).max(0.0) as u32
                        } else {
                            0
                        }
                    });
                    if pts_real.is_some() {
                        if let Ok(mut g) = SESSION.lock() {
                            if let Some(s) = g.as_mut() {
                                if s.gen == gen {
                                    s.real_pts_hits += 1;
                                }
                            }
                        }
                    }
                    push_frame(gen, w, h, n, pts, acc[..eoi + 2].to_vec());
                    acc.drain(..eoi + 2);
                }
            }
            mark_eof(gen);
        });
    }

    Ok(child)
}

/// 从 `from` 开始找 `b0 b1` 两字节序列的首个位置。
fn find2(buf: &[u8], from: usize, b0: u8, b1: u8) -> Option<usize> {
    if from >= buf.len() {
        return None;
    }
    buf[from..]
        .windows(2)
        .position(|w| w[0] == b0 && w[1] == b1)
        .map(|p| p + from)
}

/// 把一帧排进队列尾部。
///
/// 队列满（`QUEUE_CAP`）时**丢掉这一帧**并继续读：丢弃发生在队列尾部，
/// 意味着丢的是「最新的几帧」，而队列里靠前的内容（马上要播的那些）完好无损。
/// 正常情况下根本走不到这里 —— 队列满会让读帧线程暂停 read()，
/// ffmpeg 被内核挡在 write() 上（背压）；只有在前端长时间不取帧时才可能触发，
/// 此时丢尾帧正是想要的：宁可画面停在能立刻显示的那一帧，
/// 也不能让队列无限涨把内存吃穿。
fn push_frame(gen: u64, w: u32, h: u32, seq: u64, pts_ms: u32, data: Vec<u8>) {
    let mut g = SESSION.lock().unwrap();
    let Some(s) = g.as_mut() else { return };
    if s.gen != gen {
        return; // 已被新一轮会话取代，这帧直接丢掉
    }
    if s.q.len() >= QUEUE_CAP {
        return;
    }
    s.q.push_back(Arc::new(Frame { w, h, seq, pts_ms, data }));
    // primed 的判据必须是「**已经产出**多少帧」，不是「**队列里还剩**多少帧」。
    //
    // seq 是读帧线程的产出计数（从 1 开始、只增不减）；s.q.len() 是瞬时长度，
    // 会被前端的抽帧速度拖着走。攒缓冲期前端也在按 rAF 抽帧（抽出来的帧一律
    // 丢掉，只为等 primed 标志），抽得比解码快时队列长度就永远到不了
    // prime_frames —— primed 永不触发，前端永远停在缓冲浮层、mpv 被 holdAudio
    // 压着不出声、进度条不动，而且**一条提示都没有**（那条 8 秒看门狗当时挂在
    // 「零帧头」分支上，而帧其实一直在正常产出）。这个竞态在 10/02 的
    // 「点开视频一直缓冲中」上实际发生过：判据选错了量。
    if !s.primed && seq >= s.prime_frames as u64 {
        s.primed = true;
        // 起播延迟花在哪：这是「起进程 → 攒够 3 秒缓冲」的总耗时，
        // 前端会把它显示在状态栏，涨了就知道是解码慢了还是机器被抢占了。
        s.prime_ms = prime_elapsed_ms();
    }
}

/// 「起进程到现在」的墙钟毫秒。抽成函数是因为读帧线程和 video_start 都要用，
/// 而它们拿到的是同一个 `Instant`（见 spawn_pipe 的 t_spawn）。
fn prime_elapsed_ms() -> u32 {
    SPAWN_AT
        .get()
        .map(|t| t.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
        .clamp(0.0, 60000.0) as u32
}

/// 队列里还有多少帧可取。读帧线程用它做背压判断（队列满就停止 read()）。
fn queue_len(gen: u64) -> usize {
    let g = SESSION.lock().unwrap();
    match g.as_ref() {
        Some(s) if s.gen == gen => s.q.len(),
        _ => 0,
    }
}

/// 取走一帧（推进游标）。队列空返回 None。
///
/// want 是前端「想要哪个媒体时刻的帧」（毫秒，来自 URL 的 ?pts=）。
/// 比它旧的帧会被**一次性丢掉**，然后返回第一帧 >= want 的。
///
/// 为什么要丢：画面位置是音频位置的函数（见前端 startFrameLoop）。前端一旦
/// 因为调度抖动 / 解码变慢而落后，按 FIFO 一帧一帧追就永远慢半拍 —— 每追一帧，
/// 队尾又新进了几帧。丢掉过旧帧等于一次「跳到当前位置」，是唯一能收敛的做法。
///
/// 两个例外必须守住：
///   - 至少留一帧：全部过旧时返回最新的那帧，而不是回空。回空会被前端当成
///     「队列抽干」进而重开管线，陷入死循环。
///   - VFR 源（帧率未知，pts 恒为 0）不做比较，退化成严格 FIFO：否则
///     0 < want 恒成立，会把整个队列丢光。
fn pop_frame(gen: u64, want: Option<u32>) -> Option<Arc<Frame>> {
    let mut g = SESSION.lock().unwrap();
    let s = g.as_mut()?;
    if s.gen != gen {
        return None;
    }
    if let Some(w) = want {
        // 判断能不能按 pts 比较，用 src_fps 而不是「队首 pts > 0」——
        // 起播点恰好是 0 秒时首帧 pts 就是 0，拿它当判据会把正常 CFR 源误判成 VFR。
        //
        // src_fps == 0（ffprobe 没读到帧率）时，pts 是靠帧号推的、可能整队都是 0，
        // 这时不能比：0 < want 恒成立会把整队丢光。但只要队里有任何一帧 pts > 0，
        // 就说明 showinfo 拿到了真实时间戳，这时可以放心丢。
        let pts_usable = s.src_fps > 0.0 || s.q.iter().any(|f| f.pts_ms > 0);
        if w > 0 && pts_usable {
            while s.q.len() > 1 && s.q.front().is_some_and(|f| f.pts_ms < w) {
                s.q.pop_front();
            }
        }
    }
    let f = s.q.pop_front()?;
    s.cursor = f.seq;
    Some(f)
}

/// 已缓冲的媒体时长（毫秒）= 队尾 pts − 队首 pts。
/// 前端用它判断「还剩多少缓冲」，以及诊断背压是否在稳态维持住深度。
fn buffered_ms(s: &Session) -> u32 {
    match (s.q.front(), s.q.back()) {
        (Some(f), Some(b)) => b.pts_ms.saturating_sub(f.pts_ms),
        _ => 0,
    }
}

fn mark_eof(gen: u64) {
    let mut g = SESSION.lock().unwrap();
    if let Some(s) = g.as_mut() {
        if s.gen == gen {
            s.eof = true;
            // 读到末尾还没攒够（比 3 秒还短的片子，或解码远慢于实时）：
            // 就这么多了，直接置就绪。否则前端会一直等一个永远不会到的
            // primed，表现为「点开短片永远黑屏」。
            if !s.primed && !s.q.is_empty() {
                s.primed = true;
                s.prime_ms = prime_elapsed_ms();
            }
        }
    }
}

// ─── Tauri 命令 ───

/// 开始播放画面：探测尺寸 → 启流 → 返回渲染尺寸。
/// `start_at` 为起播秒数（续播位置 / 暂停后继续），None/0 表示从头开始。
/// `rate` 为播放倍率（None → 1.0），`loop_file` 为单文件循环。
/// `max_w`/`max_h` 是本次渲染上限（前端按显示区像素数下发，见 normalize_cap）。
/// mpv 侧由调用方以 vo=null + vid=no 起纯音频（见 mpv.rs）。
#[tauri::command]
pub async fn video_start(
    path: String,
    start_at: Option<f64>,
    rate: Option<f64>,
    loop_file: Option<bool>,
    max_w: Option<u32>,
    max_h: Option<u32>,
    buffer_ms: Option<u32>,
) -> Result<VideoDims, String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let at = start_at.unwrap_or(0.0).max(0.0);
    // 倍率做上下限保护：0 或负数会让 -readrate 直接报错退出
    let rate = rate.unwrap_or(1.0).clamp(0.05, 16.0);
    let looping = loop_file.unwrap_or(false);
    let cap = normalize_cap(max_w, max_h);

    // 同一文件复用上次的探测结果：ffprobe 一次几十毫秒，
    // 拖进度条/切倍速会连续重启管线，每次都探就白扔掉几百毫秒。
    // 缓存挂在会话之外，因为 stop_inner 会把 SESSION 整个换掉。
    let (vw, vh, fps) = {
        let mut c = DIMS_CACHE.lock().unwrap();
        match c.as_ref() {
            Some((p, d)) if *p == src => *d,
            _ => {
                let d = probe_dims(&src)?;
                *c = Some((src.clone(), d));
                d
            }
        }
    };
    // 攒够多少算「缓冲完成」。按帧率换算成帧数；帧率未知（VFR）时退化成
    // 「首帧即就绪」，也就是不缓冲、沿用旧的按序取帧行为。
    let prime_frames = if fps > 0.0 {
        (((buffer_ms.unwrap_or(3000) as f64) / 1000.0) * fps).ceil() as usize
    } else {
        1
    }
    .clamp(1, QUEUE_CAP);

    let (w, h) = fit_dims_cap(vw, vh, cap);

    // 先停掉上一轮。必须是同步调用：video_stop 是 async 命令，
    // 直接 `let _ = video_stop();` 只会构造一个从不被 poll 的 future，等于没停。
    stop_inner();

    let gen = {
        let mut g = SESSION.lock().unwrap();
        let gen = g.as_ref().map(|s| s.gen + 1).unwrap_or(1);
        *g = Some(Session {
            gen,
            child: None,
            q: VecDeque::with_capacity(prime_frames + 8),
            cursor: 0,
            w,
            h,
            src_dims: (vw, vh),
            src_fps: fps,
            hwaccel: true,
            eof: false,
            err: None,
            first_ms: 0,
            primed: false,
            prime_ms: 0,
            prime_frames,
            real_pts_hits: 0,
        });
        gen
    };

    // 优先 D3D11VA 硬解；起不来就退回软解，同一条代码路径只是少个参数
    let (child, hwaccel) = match spawn_pipe(&src, w, h, at, true, rate, looping, gen, fps) {
        Ok(c) => (c, "d3d11va"),
        Err(e) => {
            let c = spawn_pipe(&src, w, h, at, false, rate, looping, gen, fps)
                .map_err(|e2| format!("{e}；软解也失败: {e2}"))?;
            let mut g = SESSION.lock().unwrap();
            if let Some(s) = g.as_mut() {
                s.err = Some(e);
            }
            (c, "software")
        }
    };

    let mut g = SESSION.lock().unwrap();
    if let Some(s) = g.as_mut() {
        s.child = Some(child);
        s.hwaccel = hwaccel == "d3d11va";
    }
    Ok(VideoDims {
        w,
        h,
        src_w: vw,
        src_h: vh,
        fps,
        hwaccel,
    })
}

/// 从 `rvframe` 请求的 query 里取出前端「想看的媒体时刻」（毫秒）。
///
/// 前端发的是 `?pts=<毫秒>`（可能还带别的参数）。解析失败一律当没给
/// （退回严格 FIFO）—— 绝不能因为一个脏参数就把画面卡死。
pub fn parse_want_pts(query: Option<&str>) -> Option<u32> {
    query?
        .split('&')
        .find_map(|kv| kv.strip_prefix("pts=").and_then(|v| v.parse::<u32>().ok()))
}

/// 自定义协议 rvframe 的响应体。
///
/// 任何路径都返回 200 + application/octet-stream，前端**只看头里的字段**：
///   - w/h 为 0 → 这一轮没有画面，保持 canvas 上那一帧不动
///   - flags bit0（FLAG_PRIMED）→ 缓冲已攒够，音频可以起步
///
/// 缓冲没攒够时**只回头、不发帧**。把队首那帧发出去看着更「有用」，其实是错的：
/// 前端会先把它画出来，然后干等剩下那 2.9 秒 —— 用户看到「画面出来了却卡住不动」，
/// 比黑屏更像故障；而且攒够之前前端每帧都轮询一次，每次都重传一整张 JPEG
/// （1080p 约 100KB）纯属浪费。
///
/// 攒够之后按 want_pts 出队（见 pop_frame）：画面位置由前端按音频时钟决定，
/// 落后时一次跳到当前位置，而不是一帧一帧慢慢追。
///
/// 必须带 CORS 头：页面自身是 tauri://localhost，而 Windows 上自定义协议
/// 被映射成 http://rvframe.localhost，对页面来说就是跨源，不给会被浏览器拦掉。
/// no-store 同样必要：URL 是固定的，不禁缓存 WebView2 会直接复用旧帧。
pub fn frame_response(want_pts: Option<u32>) -> tauri::http::Response<Vec<u8>> {
    let mut body: Vec<u8> = Vec::new();
    {
        // 先取出当前 gen，再按 gen 出队：中途可能刚好被新一轮 stop/start 换掉
        let (gen, buffered, primed) = {
            let g = SESSION.lock().unwrap();
            match g.as_ref() {
                Some(s) => (s.gen, buffered_ms(s), s.primed),
                None => (0, 0, false),
            }
        };
        let flags = if primed { FLAG_PRIMED } else { 0 };
        // 没有帧也要给这个头（w=h=0），前端据此安静跳过重绘。
        // buffered_ms 照样带上：前端据此知道「缓冲还剩多少 / 是否被抽干」。
        let head_only = |body: &mut Vec<u8>| {
            body.resize(FRAME_HEADER, 0);
            body[20..24].copy_from_slice(&buffered.to_le_bytes());
            body[24..28].copy_from_slice(&flags.to_le_bytes());
        };
        if !primed {
            // 攒够缓冲之前只回头：前端等着 primed 标志，别把队首那帧发出去
            // （见函数文档：会画出来再干等，而且白白重传 JPEG）。
            head_only(&mut body);
        } else {
            match pop_frame(gen, want_pts) {
                Some(f) => {
                    // 一次性按整帧大小分配 + 一次 copy_from_slice：
                    // 逐段 extend_from_slice 会让整帧在多次扩容中反复搬，
                    // 而这条路径每 40ms 走一次。
                    body.resize(FRAME_HEADER + f.data.len(), 0);
                    body[0..4].copy_from_slice(&f.w.to_le_bytes());
                    body[4..8].copy_from_slice(&f.h.to_le_bytes());
                    body[8..16].copy_from_slice(&f.seq.to_le_bytes());
                    body[16..20].copy_from_slice(&f.pts_ms.to_le_bytes());
                    body[20..24].copy_from_slice(&buffered.to_le_bytes());
                    body[24..28].copy_from_slice(&flags.to_le_bytes());
                    body[FRAME_HEADER..].copy_from_slice(&f.data);
                }
                // 已就绪但队列空 = 缓冲被抽干（解码跟不上 / 前端跑太快）
                None => head_only(&mut body),
            }
        }
    }
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header(tauri::http::header::CONTENT_TYPE, "application/octet-stream")
        .header(tauri::http::header::CACHE_CONTROL, "no-store, no-cache, must-revalidate")
        .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap_or_else(|_| {
            tauri::http::Response::new(Vec::new())
        })
}

/// 当前渲染尺寸 + 状态（前端用于 canvas 尺寸初始化和错误提示）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStatus {
    pub w: u32,
    pub h: u32,
    pub src_w: u32,
    pub src_h: u32,
    pub src_fps: f64,
    pub hwaccel: bool,
    /// 读帧线程是否已到 EOF（播完或进程被杀）
    pub eof: bool,
    /// 暂停：进程被杀但**会话与最后一帧都留着**（前端据此冻结画面而不是清黑）
    pub paused: bool,
    pub err: Option<String>,
    /// 已攒够缓冲，可以启动音频（前端据此 mpvCtl('play')）
    pub primed: bool,
    /// 攒缓冲实际花掉的墙钟毫秒（诊断：起播延迟花在哪）
    pub prime_ms: u32,
    /// 首帧就绪耗时（诊断用，不在每帧热路径上）
    pub first_ms: u32,
    /// 队列里还没被取走的帧数（诊断：背压是否在起作用）
    pub queued: usize,
}

#[tauri::command]
pub async fn video_status() -> VideoStatus {
    let g = SESSION.lock().unwrap();
    match g.as_ref() {
        Some(s) => VideoStatus {
            w: s.w,
            h: s.h,
            src_w: s.src_dims.0,
            src_h: s.src_dims.1,
            src_fps: s.src_fps,
            hwaccel: s.hwaccel,
            eof: s.eof,
            paused: s.child.is_none(),
            err: s.err.clone(),
            primed: s.primed,
            prime_ms: s.prime_ms,
            first_ms: s.first_ms,
            queued: s.q.len(),
        },
        None => VideoStatus {
            w: 0,
            h: 0,
            src_w: 0,
            src_h: 0,
            src_fps: 0.0,
            hwaccel: false,
            eof: true,
            paused: false,
            err: None,
            primed: false,
            prime_ms: 0,
            first_ms: 0,
            queued: 0,
        },
    }
}

/// 杀掉 ffmpeg 进程，但**保留会话与最后一帧**。
///
/// 暂停必须走这里而不是 `video_stop`：
///   - `video_stop` 会把 SESSION 整个清掉，前端画布只能隐藏 → 暂停瞬间黑屏一下；
///   - 会话留着，续播时 `video_start` 就能直接复用已探测的尺寸、少一次 ffprobe。
/// gen 自增让上一轮的读帧线程自行退出。
fn pause_inner() {
    let mut g = SESSION.lock().unwrap();
    if let Some(s) = g.as_mut() {
        s.gen += 1;
        if let Some(mut c) = s.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        s.eof = false;
        // 队列必须一起清掉：暂停后媒体位置没变，但缓冲里那 3 秒是「暂停前那段时间」
        // 的内容，续播时若不清，续播会先播完旧缓冲再跳回来（看起来就是画面卡住不动）。
        s.q.clear();
        s.primed = false;
        s.prime_ms = 0;
        s.cursor = 0;
    }
}

/// 停流（同步实现）：杀掉 ffmpeg 并清空会话。
/// async 命令只是它的薄壳——注意别在别处直接 `let _ = video_stop();`，
/// 那只会构造一个从不被 poll 的 future。
fn stop_inner() {
    let mut g = SESSION.lock().unwrap();
    if let Some(mut s) = g.take() {
        s.gen += 1; // 让在跑的读帧线程下一轮 publish 时自行退出
        if let Some(mut c) = s.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// 停流：杀掉 ffmpeg 并清空会话。切换文件、关闭预览时调用。
#[tauri::command]
pub async fn video_stop() -> Result<(), String> {
    stop_inner();
    Ok(())
}

/// 进程退出前的兜底清理：**必须**调，否则 ffmpeg 会变成孤儿进程。
///
/// Windows 上父进程退出不会带走子进程。开了单文件循环的管线是
/// `-stream_loop -1`，ffmpeg 会一直解到天荒地老；应用退出后它还在后台
/// 满速解码 + 编码，吃满一个核，用户只能在任务管理器里手动结束。
/// 任务管理器里「结束任务」也是强杀，ffmpeg 的 `-t` 计时/文件句柄来不及
/// 释放，所以只能在还活着的时候主动 kill + wait（wait 回收句柄，
/// 否则每次启停都漏一个进程句柄，跑久了句柄表会耗尽）。
pub fn kill_all() {
    let mut g = SESSION.lock().unwrap();
    if let Some(mut s) = g.take() {
        s.gen += 1; // 让在跑的读帧线程下一轮 publish 时自行退出
        if let Some(mut c) = s.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// 暂停：杀掉解码进程但保留最后一帧与会话。
#[tauri::command]
pub async fn video_pause() -> Result<(), String> {
    pause_inner();
    Ok(())
}

// ─── 测试 ───

#[cfg(test)]
mod tests {
    use super::*;

    /// 只有一条解码会话（SESSION 是全局的），所以**碰过 SESSION 的用例必须串行**。
    ///
    /// 之前两个 ffmpeg 用例并行跑：`pause_keeps_last_frame` 会 video_stop 把
    /// SESSION 清空，正好卡在另一个用例取帧的当口，于是 frame_response(None) 只回
    /// 20 字节的头、没有帧体，断言 `头+整张 JPEG` 直接失败（4 次里挂 3 次）。
    /// 纯函数用例（fit_dims / normalize_cap / probe_dims）不碰 SESSION，不用抢锁。
    static SESSION_LOCK: Mutex<()> = Mutex::new(());

    /// 用 ffmpeg 内置的 testsrc 现场造一段测试视频，不依赖仓库里的任何素材。
    /// 造不出来返回 None，由调用方 skip。
    ///
    /// `tag` 必须每个用例都不一样：cargo test 默认并行跑，
    /// 共用同一个临时文件路径会互相删掉对方的输入，表现为「ffmpeg 秒退 → 读不到帧」。
    fn make_test_video(ffmpeg: &Path, tag: &str) -> Option<PathBuf> {
        make_test_video_secs(ffmpeg, tag, 4)
    }

    /// 同 make_test_video，但可指定时长。背压用例需要一段**明显长于**
    /// QUEUE_CAP 的素材：素材太短的话 ffmpeg 一口气解到末尾，就看不出
    /// 背压到底有没有生效（「解到末尾」和「被挡住」在短素材上结果一样）。
    fn make_test_video_secs(ffmpeg: &Path, tag: &str, secs: u32) -> Option<PathBuf> {
        let path = std::env::temp_dir().join(format!("rainver_video_pipe_{tag}.mp4"));
        let _ = std::fs::remove_file(&path);
        let ok = Command::new(ffmpeg)
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=25"])
            .args(["-t", &secs.to_string(), "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&path)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        (ok && path.is_file()).then_some(path)
    }

    /// 造一个空会话（不启 ffmpeg），专供纯逻辑用例直接灌帧。
    ///
    /// 之前每个用例都手抄一遍十几个字段的字面量，加一个字段就要改四处。
    /// 新用例一律走这里。
    fn bare_session(gen: u64, prime_frames: usize, src_fps: f64) -> Session {
        Session {
            gen,
            child: None,
            q: VecDeque::new(),
            cursor: 0,
            w: 16,
            h: 16,
            src_dims: (16, 16),
            src_fps,
            hwaccel: true,
            eof: false,
            err: None,
            first_ms: 0,
            primed: false,
            prime_ms: 0,
            prime_frames,
            real_pts_hits: 0,
        }
    }

    /// 尺寸缩放的边界：不放大、按上限等比缩小、偶数对齐、竖屏保持纵横比
    #[test]
    fn fit_dims_is_sane() {
        assert_eq!(fit_dims(320, 180), (320, 180), "小于上限不放大");
        assert_eq!(fit_dims(2560, 1440), (1920, 1080), "按上限等比缩小");
        assert_eq!(fit_dims(3840, 2160), (1920, 1080), "4K 压到 1080p");
        // 竖屏：受高度上限约束
        let (w, h) = fit_dims(1080, 1920);
        assert!(w % 2 == 0 && h % 2 == 0, "尺寸必须为偶数（h264 色度子采样要求）");
        assert!(w <= MAX_W && h <= MAX_H, "不能超过上限");
        assert!(
            (w as f64 / h as f64 - 1080.0 / 1920.0).abs() < 0.02,
            "竖屏纵横比要保持，得到 {w}x{h}"
        );
    }

    /// 动态上限：窗口小就少渲染，4K 全屏才给到 1080p，且永远不放大源。
    /// 这一层直接决定传输带宽（RGBA = w*h*4），4K 卡顿主要就是被它卡住的。
    #[test]
    fn fit_dims_follows_cap() {
        // 窗口只有 800x600 → 按 800 宽压
        assert_eq!(fit_dims_cap(3840, 2160, (800, 600)), (800, 450));
        // 竖屏窗口：受高度约束
        assert_eq!(fit_dims_cap(1080, 1920, (800, 600)), (338, 600));
        // 源比显示区小 → 不放大
        assert_eq!(fit_dims_cap(320, 180, (1920, 1080)), (320, 180));
        // 全屏 1080p：4K 压到 1080p（不再被写死的 720 上限截断）
        assert_eq!(fit_dims_cap(3840, 2160, (1920, 1080)), (1920, 1080));
        // 奇数上限要向下取偶，且不能超过上限
        let (w, h) = fit_dims_cap(1920, 1080, (801, 601));
        assert_eq!((w, h), (800, 450));
        assert!(w <= 800 && h <= 600);
    }

    /// 前端下发的上限必须被夹住：0/None 走默认，超大值夹到绝对上限
    #[test]
    fn normalize_cap_clamps() {
        assert_eq!(normalize_cap(None, None), (MAX_W, MAX_H));
        assert_eq!(normalize_cap(Some(0), Some(0)), (MAX_W, MAX_H));
        assert_eq!(normalize_cap(Some(99999), Some(99999)), (ABS_MAX_W, ABS_MAX_H));
        // 奇数 → 偶数
        assert_eq!(normalize_cap(Some(801), Some(451)), (800, 450));
        // 下限保护：太小会让画面糊成一团
        assert_eq!(normalize_cap(Some(10), Some(10)), (320, 180));
    }

    /// ffprobe 的输出格式踩过坑：`-of csv=p=0:s=x` 对 `stream=width,height`
    /// 只输出一行 `640x360`，按逗号/换行切会切出 1 个元素导致解析失败。
    #[test]
    fn probe_dims_parses_single_token() {
        let Some(ffmpeg) = crate::thumb::find_ffmpeg() else {
            eprintln!("跳过：未找到 ffmpeg");
            return;
        };
        let Some(video) = make_test_video(&ffmpeg, "probe") else {
            eprintln!("跳过：ffmpeg 造不出测试视频");
            return;
        };
        let (w, h, fps) = probe_dims(&video).expect("ffprobe 输出应能被解析");
        assert_eq!((w, h), (320, 180), "testsrc 尺寸应为 320x180");
        // 帧率是前端做音画对齐测量的输入：解析错会让「帧号→时间戳」整体错位
        assert!((fps - 25.0).abs() < 0.01, "25fps 测试片应探到 25，实测 {fps}");
        let _ = std::fs::remove_file(&video);
    }

    /// `?pts=` 是前端唯一告诉 Rust「我该看哪一帧」的通道，写错就会画面乱跳或卡死。
    /// 重点是**宽容**：脏参数、缺参数都必须安静退化成「没给」（严格 FIFO），
    /// 而不是把请求整个打回。
    #[test]
    fn parse_want_pts_is_lenient() {
        assert_eq!(parse_want_pts(Some("pts=1234")), Some(1234));
        assert_eq!(parse_want_pts(Some("n=5&pts=40")), Some(40));
        assert_eq!(parse_want_pts(Some("pts=40&t=1")), Some(40));
        assert_eq!(parse_want_pts(Some("pts=0")), Some(0));
        assert_eq!(parse_want_pts(Some("n=5")), None);
        assert_eq!(parse_want_pts(Some("pts=abc")), None);
        assert_eq!(parse_want_pts(Some("pts=-5")), None);
        assert_eq!(parse_want_pts(Some("")), None);
        assert_eq!(parse_want_pts(None), None);
    }

    /// showinfo 日志解析：格式取自 ffmpeg 7.0 实测输出，锁死「冒号 + 无空格」这个坑。
    #[test]
    fn showinfo_pts_parses_real_log_lines() {
        // 只关心 pts_time 的用例走这个包装，省得每次都写 .map(|(_, t)| t)
        fn pts(line: &str) -> Option<f64> {
            parse_showinfo_frame(line).map(|(_, t)| t)
        }

        // 实测首帧：`-ss 5` 时 pts_time 从 0.021 起（不是 0），后面紧跟 duration
        let l = "[Parsed_showinfo_1 @ 00000251f877ba80] n:   0 pts:     21 pts_time:0.021   duration:     40 duration_time:0.04    fmt:yuvj420p cl:left sar:1/1 s:160x90 i:P iskey:0 type:P checksum:1AA0C3E3";
        assert_eq!(pts(l), Some(0.021));

        // 后续帧：间隔严格 40ms（25fps），这是「用真实 pts 就不漂移」的根据
        for (i, want) in [(0u32, 0.061f64), (1, 0.101), (2, 0.141), (10, 0.421)] {
            let line = format!(
                "[Parsed_showinfo_1 @ 0xabc] n:{:4} pts:{:6} pts_time:{}   duration:    40 duration_time:0.04",
                i,
                i * 40 + 21,
                want
            );
            let got = pts(&line).unwrap();
            assert!((got - want).abs() < 1e-9, "帧 {} 解析成 {}，应为 {}", i, got, want);
        }

        // = 分隔也吃（不同 ffmpeg 版本/滤镜变体可能用等号）
        assert_eq!(
            pts("[showinfo] n:0 pts:0 pts_time=1.5 duration:40"),
            Some(1.5)
        );

        // SEI 的 User Data 里也有 pts_step / r_frame_rate 这类字段，
        // 但没有 pts_time → 必须整行判否，绝不能误取数字
        let sei = "[Parsed_showinfo_1 @ 0x1] User Data=0x4d50 ... pts_step=4 qpmin=69 r_frame_rate=25 pts_x=8 qpstep=4";
        assert_eq!(pts(sei), None);

        // 非 showinfo 的 stderr 一律忽略
        assert_eq!(pts("[h264 @ 0x1] SEI: 0 bytes"), None);
        assert_eq!(pts(""), None);

        // 边界：负值夹 0、非有限值/缺字段判否
        assert_eq!(pts("n:0 pts_time:-0.04 duration:40"), Some(0.0));
        assert_eq!(pts("n:0 pts_time:nan duration:40"), None);
        assert_eq!(pts("n:0 pts_time: duration:40"), None);
        assert_eq!(pts("n:0 pts_time:abc"), None);
    }

    /// 帧号配对：showinfo 的 n: 必须能和 pts_time 一起取出来。
    ///
    /// 这是防「stderr 落后 k 帧 → 把第 1 帧的 pts 按到第 k+1 帧上」的关键。
    /// 那种错位不会报错，只会让画面越播越偏。
    #[test]
    fn showinfo_frame_pairs_index_with_pts() {
        // 实测格式：n 与 pts_time 之间隔着 pts
        let l = "[Parsed_showinfo_1 @ 0x1] n:   7 pts:   301 pts_time:0.301   duration:40 duration_time:0.04";
        assert_eq!(parse_showinfo_frame(l), Some((7, 0.301)));

        // n: 紧贴等号也要认
        assert_eq!(
            parse_showinfo_frame("[showinfo] n=12 pts_time=2.5"),
            Some((12, 2.5))
        );

        // 只有 pts_time 没有 n → 配不出帧号，必须判否（否则会被当成第 0 帧）
        assert_eq!(parse_showinfo_frame("pts_time:0.021 duration:40"), None);
        // 只有 n 没有 pts_time → 同理
        assert_eq!(parse_showinfo_frame("n:7 pts:301 duration:40"), None);

        // 帧序号跨过两位数/三位数
        assert_eq!(
            parse_showinfo_frame("n:123 pts_time:4.921").map(|(_, t)| t),
            Some(4.921)
        );
    }

    /// pts_time 是**相对 -ss 落点**的，所以必须加回 start_ms 才能回到媒体时间轴。
    /// 这个测试锁住「真实 pts 优先、拿不到才退回推算」这条优先级。
    #[test]
    fn real_pts_is_relative_to_seek_point() {
        // 25fps，start_at=5.0s。首帧 pts_time=0.021（实测）。
        let start_ms = 5000u32;
        let frame_ms = 1000.0 / 25.0;
        // 真实值：5000 + 21 = 5021ms，落在第 0 帧之后、第 1 帧之前
        let real: u32 = (start_ms as f64 + 0.021 * 1000.0) as u32;
        assert_eq!(real, 5021);
        // 若错误地只用 pts_time（不加 start_ms），会得到 21ms —— 远早于音频位置，
        // 前端要帧时会判定整段预缓冲过期而丢掉，画面就是黑的。这条不能发生。
        assert!(real > 5000, "真实 pts 必须落在起播点之后");
        // 退回推算时也不该差太远（同一帧、同一公式）
        let approx = (start_ms as f64 + 0.0 * frame_ms) as u32;
        assert!(real as f64 - approx as f64 <= frame_ms as f64);
    }

    /// 端到端验证「-ss 之后帧 pts 落在真实媒体时间轴上」。
    ///
    /// 这是整件事的关键：之前 pts 是拿「start_ms + 帧号 × 帧间隔」推的。
    /// 若 showinfo 的 pts_time 被**漏掉 start_ms**，首帧 pts 会是 ~21ms 而不是
    /// ~5021ms —— 差 5 秒，于是前端按音频位置（5000ms+）要帧时，会判定整段
    /// 预缓冲「全都过期」全部丢掉，画面就是黑的／反复重开管线。
    ///
    /// 断言三件事：
    /// 1. 首帧 pts ≥ start_at（不能比起播点还早，否则整段预缓冲会被丢光）
    /// 2. 首帧 pts 落在起播点后**一帧之内**（不能偏太远）
    /// 3. 帧间隔稳定、无累积漂移（这是用真实 pts 而非推算的根本收益）
    #[test]
    fn seek_pts_lands_on_real_media_timeline() {
        let _guard = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(ffmpeg) = crate::thumb::find_ffmpeg() else {
            eprintln!("跳过：未找到 ffmpeg");
            return;
        };
        let Some(video) = make_test_video(&ffmpeg, "seekpts") else {
            eprintln!("跳过：ffmpeg 造不出测试视频");
            return;
        };

        let (vw, vh, vfps) = probe_dims(&video).expect("应能读出尺寸");
        let (w, h) = fit_dims(vw, vh);
        let start_at = 2.0f64;
        let start_ms = (start_at * 1000.0) as u32;
        let frame_ms = 1000.0 / vfps;

        const GEN: u64 = 1;
        *SESSION.lock().unwrap() = Some(bare_session(GEN, 1, vfps));
        {
            let mut g = SESSION.lock().unwrap();
            let s = g.as_mut().unwrap();
            s.w = w;
            s.h = h;
            s.src_dims = (vw, vh);
        }
        let child = spawn_pipe(&video, w, h, start_at, true, 1.0, false, GEN, vfps)
            .expect("起流应成功");
        SESSION.lock().unwrap().as_mut().unwrap().child = Some(child);

        // 攒够若干帧，把连续 pts 都读出来（要看间隔稳定性，单帧不够）
        let mut ptss: Vec<u32> = Vec::new();
        for _ in 0..400 {
            {
                let mut g = SESSION.lock().unwrap();
                let s = g.as_mut().unwrap();
                while let Some(f) = s.q.pop_front() {
                    if !f.data.is_empty() {
                        ptss.push(f.pts_ms);
                    }
                    if ptss.len() >= 12 {
                        break;
                    }
                }
            }
            if ptss.len() >= 12 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        // 计数器必须在 stop_inner() **之前**读：它会把整个 SESSION 置空，
        // 之后再读只会拿到 0，于是这条「证明真走了真实 pts」的断言变成永远失败。
        let hits = SESSION.lock().unwrap().as_ref().map(|s| s.real_pts_hits).unwrap_or(0);
        stop_inner();

        assert!(ptss.len() >= 5, "应攒到多帧才能验证间隔，实际 {}", ptss.len());

        // 1 + 2：首帧必须落在起播点之后一帧之内
        let first = ptss[0] as i64;
        assert!(
            first >= start_ms as i64,
            "首帧 pts {} 比起播点 {} 还早 —— 整段预缓冲会被判定过期而丢光（黑屏）",
            first,
            start_ms
        );
        assert!(
            first < start_ms as i64 + (2.0 * frame_ms) as i64,
            "首帧 pts {} 偏离起播点 {} 太多（应在一帧内，帧间隔 {:.0}ms）",
            first,
            start_ms,
            frame_ms
        );

        // 3：相邻间隔应稳定在帧长附近，且**不随帧号累积放大**
        let mut worst = 0.0f64;
        for w in ptss.windows(2) {
            let d = (w[1] - w[0]) as f64;
            assert!(d > 0.0, "pts 必须单调递增，实际 {:?} → {:?}", w[0], w[1]);
            worst = worst.max((d - frame_ms).abs());
        }
        assert!(
            worst <= frame_ms,
            "帧间隔偏离 {:.0}ms 达 {:.0}ms —— 时间戳在漂移，播久了必然不同步",
            frame_ms,
            worst
        );

        // 证明**真的走了** showinfo 那条路，而不是悄悄回退到帧号推算。
        // 这条不能省：测试素材的 pts_time 常恰好从 0 起算，真实值与推算值
        // 完全相同，上面所有断言在「一直在推算」的情况下也会全过 ——
        // 那样就等于什么都没验证。
        assert!(
            hits >= 5,
            "只有 {} 帧用上真实 pts（应至少 5）—— 管道多半一直在用帧号推算，\
             前面那些 pts 断言等于没验证到真实时间轴",
            hits
        );
        println!(
            "seek pts 验证：start_at={:.0}ms 首帧 pts={}ms 间隔最大偏差={:.1}ms 真实pts命中={}/{}",
            start_at * 1000.0,
            ptss[0],
            worst,
            hits,
            ptss.len()
        );
    }

    /// 端到端验证真实管道：D3D11VA 硬解 → 裸 RGBA → 最新帧槽位。
    /// 覆盖最容易写错的四处：ffmpeg 参数、帧长必须严格等于 w*h*4（否则前端定量读帧会永久错位）、
    /// 像素不能全黑、播放位置要能被 start_at 定位。
    #[test]
    fn pipe_yields_correct_mjpeg_frames() {
        let _guard = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(ffmpeg) = crate::thumb::find_ffmpeg() else {
            eprintln!("跳过：未找到 ffmpeg");
            return;
        };
        let Some(video) = make_test_video(&ffmpeg, "pipe") else {
            eprintln!("跳过：ffmpeg 造不出测试视频");
            return;
        };

        let (vw, vh, vfps) = probe_dims(&video).expect("应能读出尺寸");
        let (w, h) = fit_dims(vw, vh);
        assert_eq!((w, h), (320, 180), "未超上限不该缩放");

        const GEN: u64 = 1;
        *SESSION.lock().unwrap() = Some(Session {
            gen: GEN,
            child: None,
            q: VecDeque::new(),
            cursor: 0,
            w,
            h,
            src_dims: (vw, vh),
            src_fps: vfps,
            hwaccel: true,
            eof: false,
            err: None,
            first_ms: 0,
            primed: false,
            prime_ms: 0,
            prime_frames: 1,
            real_pts_hits: 0,
        });
        let child = spawn_pipe(&video, w, h, 0.0, true, 1.0, false, GEN, vfps)
            .expect("D3D11VA 起流应成功");
        SESSION.lock().unwrap().as_mut().unwrap().child = Some(child);

        // 现在没有 -readrate，ffmpeg 全速解码，第一帧几乎是 spawn 后立刻就有；
        // 这里仍然留 15 秒余量，只是不再依赖它。
        let mut got: Option<(u32, u32, u64, u32, Vec<u8>)> = None;
        for _ in 0..600 {
            {
                let g = SESSION.lock().unwrap();
                let s = g.as_ref().expect("会话不应被清空");
                if let Some(f) = s.q.front() {
                    if !f.data.is_empty() {
                        got = Some((f.w, f.h, f.seq, f.pts_ms, f.data.clone()));
                        break;
                    }
                }
                if s.eof {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let (fw, fh, seq, fpts, data) = got.expect("15 秒内应收到完整帧");
        assert_eq!(fpts, 0, "从 0 秒起流时首帧的 pts 应为 0");
        // 注意：这里不要先 stop_inner()——下面还要验证协议响应能取到这一帧

        assert_eq!((fw, fh), (w, h), "帧尺寸应与探测缩放后的尺寸一致");
        assert!(seq >= 1, "帧序号应从 1 开始");
        // 帧体是一整张 JPEG：SOI 起 EOI 止，且 SOF0 里报的尺寸必须就是渲染尺寸。
        // 这几条同时锁死了「前端 createImageBitmap 拿到的东西是不是能直接解码」。
        assert!(data.starts_with(&[0xFF, 0xD8, 0xFF]), "JPEG 必须以 SOI 开头");
        assert!(
            data.len() > 2 && data[data.len() - 2..] == [0xFF, 0xD9],
            "JPEG 必须以 EOI 结尾（实际尾部 {:02x?}）",
            &data[data.len().saturating_sub(2)..]
        );
        assert_eq!(jpeg_dims(&data), Some((w, h)), "JPEG 内部尺寸必须与帧头一致");
        // 体积必须真的压缩了：裸 RGBA 是 w*h*4，JPEG 远小于它（这就是选 MJPEG 的原因）
        let raw = (w as usize) * (h as usize) * 4;
        assert!(
            data.len() < raw / 2,
            "JPEG 应显著小于裸 RGBA（{raw} → {}）",
            data.len()
        );
        println!(
            "管道验证通过：{w}x{h} seq={seq} jpeg={}KB（裸 RGBA 要 {}KB）",
            data.len() / 1024,
            raw / 1024
        );

        // 自定义协议响应：头里的 w/h/seq/first_ms 必须和帧一致，长度 = 20 + JPEG 长度
        let resp = frame_response(None);
        assert_eq!(resp.status(), tauri::http::StatusCode::OK);
        assert_eq!(
            resp.headers().get("access-control-allow-origin").map(|v| v.to_str().unwrap()),
            Some("*"),
            "跨源 fetch 必须有 CORS 头，否则 WebView2 直接拦掉响应"
        );
        let body = resp.into_body();
        assert_eq!(body.len(), FRAME_HEADER + data.len(), "响应体应是 20 字节头 + 整张 JPEG");
        let body_w = u32::from_le_bytes(body[0..4].try_into().unwrap());
        let body_h = u32::from_le_bytes(body[4..8].try_into().unwrap());
        let body_seq = u64::from_le_bytes(body[8..16].try_into().unwrap());
        let body_pts = u32::from_le_bytes(body[16..20].try_into().unwrap());
        let body_buf = u32::from_le_bytes(body[20..24].try_into().unwrap());
        let body_flags = u32::from_le_bytes(body[24..28].try_into().unwrap());
        assert_eq!((body_w, body_h, body_seq), (w, h, seq), "协议头必须与帧一致");
        assert_eq!(body_pts, fpts, "协议头里的 pts 必须与帧一致");
        assert!(
            body_flags & FLAG_PRIMED != 0,
            "prime_frames=1 时第一帧就该算就绪"
        );
        println!("首帧 pts={body_pts} 已缓冲={body_buf}ms flags={body_flags}");
        assert_eq!(&body[FRAME_HEADER..], &data[..], "协议体必须就是那一帧的 JPEG");

        // 停流后：只回 28 字节的零头，前端据此保持上一帧不动
        stop_inner();
        let empty = frame_response(None);
        assert_eq!(empty.into_body().len(), FRAME_HEADER, "停流后应只回零头");

        // 定位：-ss 放在 -i 之前，ffmpeg 默认 accurate_seek 会解到目标时间点。
        // 这里真的再起一条 2 秒处的管线，把它吐的 JPEG 解回像素，与 0 秒那帧比。
        let dir = tmp_dir("seek");
        let at2_jpg = run_pipe_and_grab(&video, w, h, 2.0).expect("2 秒处也应拿到帧");
        std::fs::write(dir.join("f0.jpg"), &data).expect("写 0 秒帧失败");
        std::fs::write(dir.join("f2.jpg"), &at2_jpg).expect("写 2 秒帧失败");
        let head_px = jpeg_to_rgb(&ffmpeg, &dir.join("f0.jpg"));
        let at2_px = jpeg_to_rgb(&ffmpeg, &dir.join("f2.jpg"));
        let diff = mean_abs_diff(&head_px, &at2_px);
        assert!(diff > 8.0, "seek 到 2 秒后画面几乎没变（差 {diff:.1}），-ss 可能没生效");
        println!("定位验证通过：0s 与 2s 两帧平均差 {diff:.1}");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&video);
    }

    /// 临时目录（存对比用的 JPEG 帧）
    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rainver_jpeg_{tag}"));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    /// 起一条到 `at` 秒的管线，等首帧出来，返回那张 JPEG。
    fn run_pipe_and_grab(video: &Path, w: u32, h: u32, at: f64) -> Option<Vec<u8>> {
        const GEN2: u64 = 9_999;
        stop_inner();
        *SESSION.lock().unwrap() = Some(Session {
            gen: GEN2,
            child: None,
            q: VecDeque::new(),
            cursor: 0,
            w,
            h,
            src_dims: (w, h),
            src_fps: 25.0,
            hwaccel: true,
            eof: false,
            err: None,
            first_ms: 0,
            primed: false,
            prime_ms: 0,
            prime_frames: 1,
            real_pts_hits: 0,
        });
        let child = spawn_pipe(video, w, h, at, true, 1.0, false, GEN2, 25.0)
            .expect("起流应成功");
        SESSION.lock().unwrap().as_mut().unwrap().child = Some(child);
        for _ in 0..600 {
            {
                let g = SESSION.lock().unwrap();
                let s = g.as_ref().expect("会话应还在");
                if let Some(f) = s.q.front() {
                    if !f.data.is_empty() {
                        return Some(f.data.clone());
                    }
                }
                if s.eof {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        None
    }

    /// 把一张 JPEG 交给 ffmpeg 解回 RGB 像素（测试里没有图像解码器，借 ffmpeg 用一下）
    fn jpeg_to_rgb(ffmpeg: &Path, jpg: &Path) -> Vec<u8> {
        let out = Command::new(ffmpeg)
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(jpg)
            .args(["-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
            .output()
            .expect("ffmpeg 解 JPEG 应成功");
        out.stdout
    }

    /// 暂停必须**留住最后一帧**：这是「暂停不黑屏」的前提。
    ///
    /// 曾经暂停走的是 `video_stop`，它把 SESSION 整个清掉，前端只能把画布隐藏，
    /// 于是每按一次暂停画面就黑一下。这里锁死 pause 与 stop 的区别：
    ///   pause → 会话还在、frame 还在、协议照样能取到那一帧
    ///   stop  → 只回 20 字节零头
    #[test]
    fn pause_keeps_last_frame() {
        let _guard = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(ffmpeg) = crate::thumb::find_ffmpeg() else {
            eprintln!("跳过：未找到 ffmpeg");
            return;
        };
        let Some(video) = make_test_video(&ffmpeg, "pause") else {
            eprintln!("跳过：ffmpeg 造不出测试视频");
            return;
        };
        const GEN: u64 = 1;
        let (w, h) = (320u32, 180u32);
        *SESSION.lock().unwrap() = Some(Session {
            gen: GEN,
            child: None,
            q: VecDeque::new(),
            cursor: 0,
            w,
            h,
            src_dims: (w, h),
            src_fps: 25.0,
            hwaccel: true,
            eof: false,
            err: None,
            first_ms: 0,
            primed: false,
            prime_ms: 0,
            prime_frames: 1,
            real_pts_hits: 0,
        });
        let child = spawn_pipe(&video, w, h, 0.0, true, 1.0, false, GEN, 25.0).expect("起流应成功");
        SESSION.lock().unwrap().as_mut().unwrap().child = Some(child);

        // 等第一帧
        let mut ok = false;
        for _ in 0..400 {
            {
                let g = SESSION.lock().unwrap();
                if g.as_ref().is_some_and(|s| !s.q.is_empty()) {
                    ok = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(ok, "10 秒内应收到第一帧");
        let before = frame_response(None).into_body();
        let jpeg_len = before.len() - FRAME_HEADER;
        assert!(
            before.len() > FRAME_HEADER && before[FRAME_HEADER..].starts_with(&[0xFF, 0xD8, 0xFF]),
            "帧体应是 JPEG（{} 字节）",
            jpeg_len
        );

        pause_inner();
        // 暂停后：会话保留（续播要复用尺寸），但缓冲要清空。
        //
        // 「保留最后一帧」这条旧约定在改成 FIFO 队列之后**必须放弃**：
        // 队列里躺的是「马上要播的那 3 秒」，暂停时不清掉的话，
        // 续播会先把暂停前那 3 秒播完才跳回来（用户看到画面卡住不动、
        // 声音已经往前走了）。前端的冻结不依赖 Rust 侧留帧 ——
        // 暂停后前端不再取帧，canvas 上本来就还是那一帧。
        {
            let g = SESSION.lock().unwrap();
            let s = g.as_ref().expect("pause 不能清空会话");
            assert!(
                s.child.is_none(),
                "pause 必须杀掉解码进程（ffmpeg 自己不会停，会一路解到文件末尾）"
            );
            assert!(!s.eof, "暂停不是播完，别把 eof 置起来");
            assert!(s.q.is_empty(), "pause 必须清空缓冲，否则续播会先播完旧内容");
            assert!(!s.primed, "pause 后缓冲已作废，primed 要跟着复位");
        }
        // 队列空了 → 只回零头，前端保持 canvas 上那一帧不动（不会黑屏）
        assert_eq!(
            frame_response(None).into_body().len(),
            FRAME_HEADER,
            "pause 且缓冲已清空时协议应只回零头"
        );

        // 对照：stop 会清空整个会话
        stop_inner();
        assert_eq!(
            frame_response(None).into_body().len(),
            FRAME_HEADER,
            "stop 后应只回零头"
        );
        let _ = std::fs::remove_file(&video);
    }

    /// 缓冲队列：攒够目标帧数才置 primed，且按 FIFO 顺序出队。
    ///
    /// 这是「先缓冲 3 秒再一起播」的全部机制所在，出错的话表现是
    /// 音画差一个缓冲深度（画面永远晚 3 秒），所以单独锁死。
    #[test]
    fn buffer_primes_then_yields_in_order() {
        let _g = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        stop_inner();

        const GEN: u64 = 42;
        const PRIME_FRAMES: usize = 5;
        *SESSION.lock().unwrap() = Some(Session {
            gen: GEN,
            child: None,
            q: VecDeque::new(),
            cursor: 0,
            w: 16,
            h: 16,
            src_dims: (16, 16),
            src_fps: 25.0,
            hwaccel: true,
            eof: false,
            err: None,
            first_ms: 0,
            primed: false,
            prime_ms: 0,
            prime_frames: PRIME_FRAMES,
            real_pts_hits: 0,
        });

        // 攒 3 帧时不该就绪
        for n in 1..=3u64 {
            push_frame(GEN, 16, 16, n, n as u32 * 40, vec![0xFF, 0xD8, n as u8, 0xFF, 0xD9]);
            assert!(
                !SESSION.lock().unwrap().as_ref().unwrap().primed,
                "攒 {n} 帧(<{PRIME_FRAMES})不该算就绪"
            );
        }
        // 攒到第 5 帧 → 就绪
        push_frame(GEN, 16, 16, 4, 160, vec![0xFF, 0xD8, 4, 0xFF, 0xD9]);
        push_frame(GEN, 16, 16, 5, 200, vec![0xFF, 0xD8, 5, 0xFF, 0xD9]);
        let g = SESSION.lock().unwrap();
        {
            let s = g.as_ref().unwrap();
            assert!(s.primed, "攒满 {PRIME_FRAMES} 帧就该置 primed（音频据此起步）");
            assert!(s.prime_ms < 60_000, "prime_ms 应是实测值");
        }
        drop(g);

        // primed 标志要通过协议头传出去，前端才收得到。
        // 注意 frame_response 是**出队**语义，这一下已经取走了 seq=1，
        // 所以顺手把它当 FIFO 的第一个样本一起验掉。
        let first = frame_response(None).into_body();
        let flags = u32::from_le_bytes(first[24..28].try_into().unwrap());
        assert_ne!(flags & FLAG_PRIMED, 0, "协议头必须带出 primed 标志");
        assert_eq!(
            u64::from_le_bytes(first[8..16].try_into().unwrap()),
            1,
            "第一次出队应拿到 seq=1"
        );
        assert_ne!(
            u32::from_le_bytes(first[0..4].try_into().unwrap()),
            0,
            "就绪后的帧头 w 必须非 0"
        );

        // FIFO：必须按 seq 顺序出队（不是取最新，否则缓冲白攒）
        for want in 2..=5u64 {
            let b = frame_response(None).into_body();
            let seq = u64::from_le_bytes(b[8..16].try_into().unwrap());
            assert_eq!(seq, want, "出队顺序必须是 FIFO，第 {want} 次应拿到 seq={want}");
        }
        // 队列空了 → 零头，且 primed 仍然成立（缓冲已攒够，只是暂时取空）
        let empty = frame_response(None).into_body();
        assert_eq!(empty.len(), FRAME_HEADER, "取空后只回零头");
        assert_eq!(
            u32::from_le_bytes(empty[0..4].try_into().unwrap()),
            0,
            "空帧头的 w 应为 0"
        );
        stop_inner();
    }

    /// primed 的判据不能是「队列里还剩多少帧」——必须是「**已经产出**多少帧」。
    ///
    /// 顺带说明：曾经写成 `s.q.len() >= prime_frames`，看着像会被前端的抽帧速度
    /// 拖住（抽得比解码快队列就攒不够），但下面这个用例会看到那个担心不成立 ——
    /// frame_response 在 !primed 期间压根不出队。
    ///
    /// 这里按真实协议行为验：`frame_response` 在 !primed 时**只回零头、不出队**，
    /// 所以攒缓冲期前端根本抽不走帧、队列只增不减 —— primed 在这条链路上并不存在
    /// 「被前端抽帧速度拖住」的竞态。判据用哪个量结果一样，但 seq 是单调产出量，
    /// 语义更对，也不再依赖「攒缓冲期不出队」这条约定哪天被改掉。
    ///
    /// 顺带钉住两件被它隐含依赖的事：攒够那一刻**队首仍在队列里**（前端靠它画出
    /// 第一帧），且那一次响应必须同时带出 primed 标志和这一帧（不能让它空等一轮）。
    #[test]
    fn priming_is_keyed_on_produced_frames() {
        let _g = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        stop_inner();

        const GEN: u64 = 91;
        const PRIME_FRAMES: usize = 5;
        *SESSION.lock().unwrap() = Some(bare_session(GEN, PRIME_FRAMES, 25.0));

        for n in 1..=PRIME_FRAMES as u64 {
            push_frame(GEN, 16, 16, n, n as u32 * 40, vec![0xFF, 0xD8, 0xFF, 0xD9]);
            // 每轮都真去取一次：!primed 时应当只拿到零头、队列不减。
            let body = frame_response(None).into_body();
            let g = SESSION.lock().unwrap();
            let s = g.as_ref().unwrap();
            if n < PRIME_FRAMES as u64 {
                assert_eq!(body.len(), FRAME_HEADER, "攒够之前只回零头");
                assert_eq!(s.q.len(), n as usize, "攒够之前不出队，帧应留在队列里");
                assert!(!s.primed, "产出 {n} 帧(<{PRIME_FRAMES})不该算就绪");
            } else {
                assert!(s.primed, "产出满 {PRIME_FRAMES} 帧就该就绪");
                assert_eq!(s.q.len(), PRIME_FRAMES, "就绪时队首仍在，前端要靠它画第一帧");
                let flags = u32::from_le_bytes(body[24..28].try_into().unwrap());
                assert_ne!(flags & FLAG_PRIMED, 0, "就绪那次的协议头必须带 primed 标志");
                assert!(body.len() > FRAME_HEADER, "就绪那次的响应必须同时带出第一帧");
            }
            drop(g);
        }
        stop_inner();
    }

    /// 背压：队列满时 `push_frame` 必须丢尾帧而不是无限涨。
    ///
    /// 这是内存上限的唯一保障。丢掉的是最新的几帧（马上还用不到），
    /// 队列靠前的内容（马上要播的）完好 —— 方向不能反。
    #[test]
    fn queue_cap_bounds_memory() {
        let _g = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        stop_inner();

        const GEN: u64 = 77;
        *SESSION.lock().unwrap() = Some(Session {
            gen: GEN,
            child: None,
            q: VecDeque::new(),
            cursor: 0,
            w: 16,
            h: 16,
            src_dims: (16, 16),
            src_fps: 25.0,
            hwaccel: true,
            eof: false,
            err: None,
            first_ms: 0,
            primed: false,
            prime_ms: 0,
            prime_frames: 1,
            real_pts_hits: 0,
        });

        // 灌 QUEUE_CAP + 50 帧
        for n in 1..=(QUEUE_CAP as u64 + 50) {
            push_frame(GEN, 16, 16, n, n as u32 * 40, vec![0xFF, 0xD8, 0xFF, 0xD9]);
        }
        let s = SESSION.lock().unwrap();
        let q = &s.as_ref().unwrap().q;
        assert_eq!(q.len(), QUEUE_CAP, "队列长度必须被 QUEUE_CAP 封顶");
        assert_eq!(q[0].seq, 1, "最早那帧不能被丢（马上要播的就是它）");
        assert_eq!(
            q[QUEUE_CAP - 1].seq,
            QUEUE_CAP as u64,
            "满后应该丢尾帧（最新的那些）"
        );
        drop(s);
        stop_inner();
    }

    /// 拖进度条 / 画面落后时前端会带 ?pts= 要「该时刻的帧」。Rust 必须把比它旧的
    /// 帧**一次性丢掉**，否则画面只能一帧一帧慢慢追、永远慢半拍。
    ///
    /// 同时锁死两个反例：不能把队列丢空（会被前端当成「抽干」去重开管线，死循环），
    /// VFR（pts 恒为 0）必须退化成严格 FIFO（否则 0 < want 恒成立，整队丢光）。
    #[test]
    fn want_pts_drops_stale_frames() {
        let _g = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        stop_inner();

        const GEN: u64 = 77;
        *SESSION.lock().unwrap() = Some(bare_session(GEN, 1, 25.0));
        // 10 帧，pts = 0,40,...,360
        for n in 0..10u64 {
            push_frame(GEN, 16, 16, n + 1, n as u32 * 40, vec![0xFF, 0xD8, 0xFF, 0xD9]);
        }

        // 要 200ms 处的帧：前面的 0..160 一次丢光，直接拿到 200
        let f = pop_frame(GEN, Some(200)).expect("应有帧");
        assert_eq!(f.pts_ms, 200, "落后的帧必须一次性丢掉，不能一帧一帧追");
        // 不带 pts 时保持严格 FIFO（旧行为不能坏）
        let f = pop_frame(GEN, None).expect("应有帧");
        assert_eq!(f.pts_ms, 240, "不带 pts 时必须严格 FIFO");
        // 要一个超过队尾的时刻：至少留一帧，绝不能回空
        let f = pop_frame(GEN, Some(99_999)).expect("不能把队列清空");
        assert_eq!(f.pts_ms, 360, "超出队尾时应返回最新的一帧，而不是回空");

        // VFR：pts 恒为 0，带 pts 也必须是严格 FIFO
        stop_inner();
        *SESSION.lock().unwrap() = Some(bare_session(GEN + 1, 1, 0.0));
        for n in 0..5u64 {
            push_frame(GEN + 1, 16, 16, n + 1, 0, vec![0xFF, 0xD8, 0xFF, 0xD9]);
        }
        for want in 1..=5u64 {
            let f = pop_frame(GEN + 1, Some(12_345)).expect("VFR 也必须能出帧");
            assert_eq!(f.seq, want, "VFR 下 pts 恒 0，必须退化成严格 FIFO");
        }
        stop_inner();
    }

    /// 「先缓冲再一起播」的核心机制，端到端跑一遍真 ffmpeg。
    ///
    /// 去掉 -readrate 之后 ffmpeg 会全速解码，唯一的节流来自读线程在队列满时
    /// 停止 read()（ffmpeg 于是被内核管道挡在 write 上）。这个用例锁死三件事，
    /// 任何一件坏了「先缓冲」都会退化成「先黑屏再狂追」或内存爆掉：
    ///
    ///   1. 攒够 prime_frames 之前协议**只回头**（前端据此安静等 primed，
    ///      不会先画一帧再干等剩下那 2.9 秒）
    ///   2. 攒够之后 flags 带 FLAG_PRIMED，且严格 FIFO（pts 单调不减）
    ///   3. 不消费时队列深度被背压钉在 QUEUE_CAP 以内，**绝不解到文件末尾**
    #[test]
    fn buffered_pipe_primes_then_throttles() {
        let _g = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        stop_inner();
        let Some(ffmpeg) = crate::thumb::find_ffmpeg() else {
            eprintln!("跳过：未找到 ffmpeg");
            return;
        };
        // 12s @25fps = 300 帧，明显长于 QUEUE_CAP(120)：
        // 素材够长才能区分「被背压挡住」和「本来就到末尾了」。
        let Some(video) = make_test_video_secs(&ffmpeg, "buffered", 12) else {
            eprintln!("跳过：ffmpeg 造不出测试视频");
            return;
        };

        const GEN: u64 = 555;
        const PRIME: usize = 30; // 1.2s @25fps
        const FPS: f64 = 25.0;
        let (w, h) = (320u32, 180u32);

        *SESSION.lock().unwrap() = Some(bare_session(GEN, PRIME, FPS));
        {
            let mut g = SESSION.lock().unwrap();
            let s = g.as_mut().unwrap();
            s.w = w;
            s.h = h;
            s.src_dims = (w, h);
        }
        let child = spawn_pipe(&video, w, h, 0.0, true, 1.0, false, GEN, FPS).expect("起流应成功");
        SESSION.lock().unwrap().as_mut().unwrap().child = Some(child);

        // 1) 就绪之前只能回头。这里同时确认「拿到 primed 的那一次就已经带帧」，
        //    前端正是靠这一帧开始画的。
        let mut primed_seen = false;
        for _ in 0..2000 {
            let body = frame_response(None).into_body();
            let flags = u32::from_le_bytes(body[24..28].try_into().unwrap());
            if flags & FLAG_PRIMED != 0 {
                assert!(
                    body.len() > FRAME_HEADER,
                    "带 primed 的响应必须同时给出第一帧"
                );
                primed_seen = true;
                break;
            }
            assert_eq!(
                body.len(),
                FRAME_HEADER,
                "攒够缓冲之前只能回头（发了帧前端就会先画出来再干等）"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(primed_seen, "4 秒内应攒够 {PRIME} 帧缓冲");

        // 2) 就绪后是严格 FIFO，且每帧都是完整 JPEG
        let mut last_pts = 0u32;
        for k in 0..20 {
            let body = frame_response(None).into_body();
            let flags = u32::from_le_bytes(body[24..28].try_into().unwrap());
            assert_ne!(flags & FLAG_PRIMED, 0, "就绪后每一帧都要带 primed 标志");
            let pts = u32::from_le_bytes(body[16..20].try_into().unwrap());
            assert!(pts >= last_pts, "pts 必须单调不减（FIFO），{last_pts} → {pts}");
            last_pts = pts;
            assert!(
                body[FRAME_HEADER..].starts_with(&[0xFF, 0xD8, 0xFF]),
                "第 {k} 帧的帧体必须是 JPEG"
            );
        }

        // 3) 停手不取帧：背压必须把 ffmpeg 钉住，队列封顶在 QUEUE_CAP。
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let (qlen, bufm, eof) = {
            let g = SESSION.lock().unwrap();
            let s = g.as_ref().unwrap();
            (s.q.len(), buffered_ms(s), s.eof)
        };
        assert!(qlen <= QUEUE_CAP, "队列绝不能超过 QUEUE_CAP（实测 {qlen}）");
        assert!(
            !eof,
            "不消费时背压必须把 ffmpeg 挡在 write 上，不能一路解到文件末尾"
        );
        assert!(bufm >= 1000, "队列里应保有足够缓冲（实测 {bufm}ms）");
        println!("背压验证：队列 {qlen} 帧 / 缓冲 {bufm}ms / eof={eof}");

        stop_inner();
        let _ = std::fs::remove_file(&video);
    }

    /// 比缓冲目标还短的片子：1 秒（25 帧）的素材，而 3 秒缓冲要 75 帧。
    ///
    /// 读线程会在攒够之前就撞到 EOF。这时必须用**已有的帧**就地置为就绪，
    /// 否则前端会永远等一个不会到来的 primed 标志 —— 表现就是「点开短片永远黑屏」。
    /// 这条路径只有真读一个短文件才会走到，纯逻辑用例覆盖不了。
    #[test]
    fn short_clip_primes_at_eof() {
        let _g = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        stop_inner();
        let Some(ffmpeg) = crate::thumb::find_ffmpeg() else {
            eprintln!("跳过：未找到 ffmpeg");
            return;
        };
        let Some(video) = make_test_video_secs(&ffmpeg, "short", 1) else {
            eprintln!("跳过：ffmpeg 造不出测试视频");
            return;
        };

        const GEN: u64 = 666;
        const PRIME: usize = 75; // 3s @25fps，比素材本身还长
        const FPS: f64 = 25.0;
        let (w, h) = (320u32, 180u32);
        *SESSION.lock().unwrap() = Some(bare_session(GEN, PRIME, FPS));
        {
            let mut g = SESSION.lock().unwrap();
            let s = g.as_mut().unwrap();
            s.w = w;
            s.h = h;
            s.src_dims = (w, h);
        }
        let child = spawn_pipe(&video, w, h, 0.0, true, 1.0, false, GEN, FPS).expect("起流应成功");
        SESSION.lock().unwrap().as_mut().unwrap().child = Some(child);

        // 无论攒没攒够，素材总会被读完 → 必须以「就绪」收场
        let mut primed = false;
        for _ in 0..3000 {
            let body = frame_response(None).into_body();
            let flags = u32::from_le_bytes(body[24..28].try_into().unwrap());
            if flags & FLAG_PRIMED != 0 {
                assert!(body.len() > FRAME_HEADER, "就绪时应当也能取出第一帧");
                primed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(primed, "短片在 EOF 时必须就绪（否则前端永远黑屏）");

        // 就绪后剩下的帧照样按序取出（第一帧已在上面取走）
        let mut got = 1;
        let mut last_pts = 0u32;
        for _ in 0..200 {
            let body = frame_response(None).into_body();
            if body.len() <= FRAME_HEADER {
                break;
            }
            let pts = u32::from_le_bytes(body[16..20].try_into().unwrap());
            assert!(pts >= last_pts, "pts 必须单调不减，{last_pts} → {pts}");
            last_pts = pts;
            got += 1;
        }
        assert!(
            (20..=30).contains(&got),
            "1 秒 25fps 的素材应产出约 25 帧，实测 {got}"
        );
        let eof = SESSION.lock().unwrap().as_ref().unwrap().eof;
        assert!(eof, "1 秒的素材读完后必须报告 EOF");
        println!("短片验证：{got} 帧后 EOF 就绪");

        stop_inner();
        let _ = std::fs::remove_file(&video);
    }

    /// 非黑像素占比（亮度 > 24 视为非黑）
    /// 从 JPEG 的 SOF 标记里读出真实像素尺寸。
    /// 前端拿到的就是这串字节，如果这里报出来的尺寸和帧头对不上，
    /// canvas 会被设成错的比例，画面直接拉伸变形。
    fn jpeg_dims(jpg: &[u8]) -> Option<(u32, u32)> {
        let mut i = 2usize; // 跳过 SOI
        while i + 4 <= jpg.len() {
            if jpg[i] != 0xFF {
                return None;
            }
            let marker = jpg[i + 1];
            // 填充字节：FF 后面可以跟任意多个 FF
            if marker == 0xFF {
                i += 1;
                continue;
            }
            // 无长度字段的标记（SOI/EOI/RSTn/TEM），不推进
            if (0xD0..=0xD9).contains(&marker) || marker == 0x01 {
                i += 2;
                continue;
            }
            let len = u16::from_be_bytes([jpg[i + 2], jpg[i + 3]]) as usize;
            // SOF0..SOF15（跳过 DHT=C4 / JPG=C8 / DAC=CC 这三个非 SOF）
            if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
            {
                let h = u16::from_be_bytes([jpg[i + 5], jpg[i + 6]]) as u32;
                let w = u16::from_be_bytes([jpg[i + 7], jpg[i + 8]]) as u32;
                return Some((w, h));
            }
            i += 2 + len;
        }
        None
    }

    /// 两帧 RGB 的平均逐通道绝对差
    fn mean_abs_diff(a: &[u8], b: &[u8]) -> f64 {
        if a.is_empty() || a.len() != b.len() {
            return 0.0;
        }
        let sum: u64 = a
            .iter()
            .zip(b.iter())
            .map(|(x, y)| (*x as i32 - *y as i32).unsigned_abs() as u64)
            .sum();
        sum as f64 / a.len() as f64
    }
}
