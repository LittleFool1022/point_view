use tauri::Manager;

/// 仅写本应用私有导出目录；真实点云下载须另建流式文件通道。
#[tauri::command]
fn save_demo_text(app: tauri::AppHandle, name: String, content: String) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("无效文件名".into());
    }
    if content.len() > 1024 * 1024 {
        return Err("演示文本导出上限为 1 MiB".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 同名成果用时间后缀保留，避免覆盖上一份导出。
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let destination = dir.join(format!("{stamp}-{name}"));
    std::fs::write(&destination, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(destination.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_demo_text])
        .run(tauri::generate_context!())
        .expect("OMNI Scan 启动失败");
}
