#!/usr/bin/env bash
# 先构建界面，再把它内嵌进可执行文件。产物：target/release/bunsen
set -euo pipefail
cd "$(dirname "$0")"
pnpm -C ui install --frozen-lockfile
pnpm -C ui build
# 内嵌的界面在编译期读入：界面变了要让 cargo 重新编 cli。
touch crates/cli/src/main.rs 2>/dev/null || true
cargo build --release
echo
echo "构建完成：$(pwd)/target/release/bunsen"
echo "运行：    target/release/bunsen serve"
