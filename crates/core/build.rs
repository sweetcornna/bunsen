// 内嵌的插件（plugins/）在 release 构建时编进可执行文件：目录有变化就重新编译。
fn main() {
    println!("cargo:rerun-if-changed=../../plugins");
    println!("cargo:rerun-if-changed=agents.json");
}
