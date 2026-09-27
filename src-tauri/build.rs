fn main() {
    let build_id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    println!("cargo:rustc-env=DIARY_BUILD_ID={build_id}");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}
