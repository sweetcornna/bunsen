#!/bin/sh
# Bunsen 安装脚本（macOS / Linux）。
#   curl -fsSL https://raw.githubusercontent.com/sweetcornna/bunsen/main/install.sh | sh
# 可选环境变量：
#   BUNSEN_VERSION      要装的版本，例如 v0.1.0（默认最新）
#   BUNSEN_INSTALL_DIR  安装目录（默认 ~/.local/bin）
set -eu

repo="sweetcornna/bunsen"
version="${BUNSEN_VERSION:-latest}"
dir="${BUNSEN_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'bunsen: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os="apple-darwin" ;;
  Linux) os="unknown-linux-musl" ;;
  *) die "不支持的系统：$(uname -s)。Windows 请用 install.ps1。" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x86_64" ;;
  arm64 | aarch64) arch="aarch64" ;;
  *) die "不支持的架构：$(uname -m)" ;;
esac

asset="bunsen-$arch-$os.tar.gz"
if [ "$version" = "latest" ]; then
  base="https://github.com/$repo/releases/latest/download"
else
  base="https://github.com/$repo/releases/download/$version"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q "$1" -O "$2"; }
else
  die "需要 curl 或 wget"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "下载 $asset（$version）…"
fetch "$base/$asset" "$tmp/$asset" || die "下载失败：$base/$asset"

# 校验：发布页上有 SHA256SUMS 时核对，对不上就停。
if fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
  want="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
  elif command -v shasum >/dev/null 2>&1; then
    got="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
  else
    got=""
  fi
  if [ -n "$want" ] && [ -n "$got" ]; then
    [ "$want" = "$got" ] || die "校验和不一致，已中止（期望 $want，实际 $got）"
    say "校验和一致"
  fi
fi

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$dir"
cp "$tmp/bunsen" "$dir/bunsen.new"
chmod 755 "$dir/bunsen.new"
mv -f "$dir/bunsen.new" "$dir/bunsen"

say "已安装：$dir/bunsen（$("$dir/bunsen" --version 2>/dev/null || echo bunsen)）"
case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    say ""
    say "$dir 不在 PATH 里。把下面这行加进 ~/.zshrc 或 ~/.bashrc："
    say "  export PATH=\"$dir:\$PATH\""
    ;;
esac
say ""
say "开始使用：bunsen serve"
