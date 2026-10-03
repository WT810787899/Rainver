// mpv_smoke.rs — libmpv ABI 三角定位测试：
//   逐项测试不同 API 调用方式，精确定位哪种调用导致 0xc0000005
// 用法: cargo run --example mpv_smoke -- <音频文件路径>
#![cfg(windows)]
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::PathBuf;

type MpvHandle = *mut c_void;
const MPV_FORMAT_STRING: c_int = 1;
const MPV_FORMAT_FLAG: c_int = 3;
const MPV_FORMAT_DOUBLE: c_int = 5;

fn dll_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().to_path_buf();
    for p in [dir.join("mpv-2.dll"), dir.join("../mpv-2.dll"), PathBuf::from("mpv-2.dll")] {
        if p.is_file() {
            return p;
        }
    }
    panic!("找不到 mpv-2.dll");
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    let path = PathBuf::from(&arg);
    assert!(path.is_file(), "测试音频不存在: {}", path.display());

    unsafe {
        let lib = libloading::Library::new(dll_path()).expect("加载 mpv-2.dll 失败");
        eprintln!("[1] DLL 已加载");

        let create: unsafe extern "C" fn() -> MpvHandle = *lib.get(b"mpv_create").unwrap();
        let init: unsafe extern "C" fn(MpvHandle) -> c_int = *lib.get(b"mpv_initialize").unwrap();
        let cmd_str: unsafe extern "C" fn(MpvHandle, *const c_char) -> c_int =
            *lib.get(b"mpv_command_string").unwrap();
        let set_prop: unsafe extern "C" fn(MpvHandle, *const c_char, c_int, *mut c_void) -> c_int =
            *lib.get(b"mpv_set_property").unwrap();
        let set_prop_str: unsafe extern "C" fn(MpvHandle, *const c_char, *const c_char) -> c_int =
            *lib.get(b"mpv_set_property_string").unwrap();
        let get_prop: unsafe extern "C" fn(MpvHandle, *const c_char, c_int, *mut c_void) -> c_int =
            *lib.get(b"mpv_get_property").unwrap();
        let free: unsafe extern "C" fn(*mut c_void) = *lib.get(b"mpv_free").unwrap();
        let term: unsafe extern "C" fn(MpvHandle) = *lib.get(b"mpv_terminate_destroy").unwrap();
        // 与生产代码一致：泄漏 Library，避免 FreeLibrary 与 mpv 后台线程的退出竞态
        std::mem::forget(lib);
        eprintln!("[2] 符号解析 OK");

        let h = create();
        assert!(!h.is_null(), "mpv_create 失败");
        eprintln!("[3] mpv_create OK");

        // 排除后台线程异步崩溃：静置 2 秒
        std::thread::sleep(std::time::Duration::from_secs(2));
        eprintln!("[4] 静置 2s 无崩溃（排除 DLL 后台线程异步崩溃）");

        // A) set_property + FLAG 格式（int*）
        let n = CString::new("pause").unwrap();
        let mut flag: c_int = 0;
        let r = set_prop(h, n.as_ptr(), MPV_FORMAT_FLAG, &mut flag as *mut c_int as *mut c_void);
        eprintln!("[5] set_property(FLAG int*) = {r}");

        // B) set_property_string 便捷 API（name/value 都是纯字符串）
        let n = CString::new("keep-open").unwrap();
        let v = CString::new("yes").unwrap();
        let r = set_prop_str(h, n.as_ptr(), v.as_ptr());
        eprintln!("[6] set_property_string = {r}");

        // C) set_property + STRING 格式：data 必须是 char**（mpv 上游 client.c 第 1347 行
        // mpv_set_property_string 内部就是传 &data 调用的；m_option 字符串按指针存储）
        let n = CString::new("keep-open").unwrap();
        let v = CString::new("yes").unwrap();
        let vp = v.as_ptr();
        let r = set_prop(h, n.as_ptr(), MPV_FORMAT_STRING, &vp as *const *const c_char as *mut c_void);
        eprintln!("[7] set_property(STRING char**) = {r}");

        let r = init(h);
        eprintln!("[8] mpv_initialize = {r}");
        assert!(r >= 0, "mpv_initialize 失败");

        let p = path.to_string_lossy().replace('\\', "/").replace('"', "");
        let c = CString::new(format!("loadfile \"{p}\"")).unwrap();
        let r = cmd_str(h, c.as_ptr());
        eprintln!("[9] loadfile(command_string) = {r}");
        assert!(r >= 0, "loadfile 失败");

        let n = CString::new("duration").unwrap();
        let mut dur: f64 = 0.0;
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let r = get_prop(h, n.as_ptr(), MPV_FORMAT_DOUBLE, &mut dur as *mut f64 as *mut c_void);
            if r >= 0 && dur > 0.0 {
                break;
            }
        }
        assert!(dur > 0.0, "未读到 duration");
        eprintln!("[10] duration = {dur:.3}s");

        let n = CString::new("media-title").unwrap();
        let mut sp: *mut c_char = std::ptr::null_mut();
        let r = get_prop(h, n.as_ptr(), MPV_FORMAT_STRING, &mut sp as *mut *mut c_char as *mut c_void);
        assert!(r >= 0 && !sp.is_null(), "get_property(STRING) 失败");
        let title = CStr::from_ptr(sp).to_string_lossy().into_owned();
        free(sp as *mut c_void);
        eprintln!("[11] media-title = {title}");

        let c = CString::new("seek 1 absolute").unwrap();
        let r = cmd_str(h, c.as_ptr());
        eprintln!("[12] seek = {r}");

        let c = CString::new("stop").unwrap();
        let _ = cmd_str(h, c.as_ptr());
        term(h);
        eprintln!("[13] stop + terminate_destroy OK");
        eprintln!("SMOKE OK — 全部调用方式通过");
    }
}
