// 界面还没构建时也让 cargo 能编过（内嵌一个空目录，访问时会提示先构建）；正式构建走 ./build.sh。
// ui/dist 变了就重新编译，界面才会被重新内嵌。
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist");
    let _ = std::fs::create_dir_all(&dist);
    println!("cargo:rerun-if-changed=../../ui/dist");
    println!("cargo:rerun-if-changed=build.rs");
}
