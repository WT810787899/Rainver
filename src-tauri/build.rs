fn main() {
    // 开发期：把 lib/mpv-2.dll 拷到 target 输出目录，运行时与 exe 同目录
    let src = std::path::Path::new("lib/mpv-2.dll");
    if src.is_file() {
        println!("cargo:rerun-if-changed=lib/mpv-2.dll");
        // OUT_DIR 不可直接作运行目录，用 profile 目录推断（target/<profile>）
        if let Ok(out_dir) = std::env::var("OUT_DIR") {
            // .../target/<profile>/build/rainver-xxx/out → .../target/<profile>
            let profile_dir = std::path::Path::new(&out_dir)
                .ancestors()
                .nth(3)
                .map(std::path::Path::to_path_buf);
            if let Some(dir) = profile_dir {
                let dst = dir.join("mpv-2.dll");
                if std::fs::copy(src, &dst).is_ok() {
                    println!("cargo:warning=已拷贝 mpv-2.dll -> {}", dst.display());
                }
            }
        }
    }

    // Tauri 构建步骤：生成并嵌入 Windows 应用清单（声明 Microsoft.Windows.Common-Controls
    // v6 依赖）及图标资源。缺失时加载器绑定 comctl32 v5.82，TaskDialogIndirect 入口点
    // 不存在，启动即报 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND。
    tauri_build::build()
}
