fn main() {
    // Tauri 构建步骤：生成并嵌入 Windows 应用清单（声明 Microsoft.Windows.Common-Controls
    // v6 依赖）及图标资源。缺失时加载器绑定 comctl32 v5.82，TaskDialogIndirect 入口点
    // 不存在，启动即报 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND。
    tauri_build::build()
}
