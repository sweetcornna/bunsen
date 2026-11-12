#!/usr/bin/env bash
# 用 Developer ID 给 macOS 版签名并公证，然后替换发布页上的两个 Mac 包。
#   dev/sign-macos.sh v0.1.0
#
# 准备（各做一次）：
#   1. 钥匙串里有 “Developer ID Application: …” 证书
#      （Xcode > Settings > Accounts > Manage Certificates > + > Developer ID Application）。
#   2. 把公证凭据存进钥匙串（会提示输入 App 专用密码，密码不会出现在命令行里）：
#        xcrun notarytool store-credentials outpost-notary --apple-id <Apple ID> --team-id <团队 ID>
#
# 可选环境变量：SIGN_IDENTITY（证书名）、NOTARY_PROFILE（默认 outpost-notary）、
# SKIP_NOTARIZE=1（只签名不公证）、NO_UPLOAD=1（只在本机出包）。
set -euo pipefail
tag="${1:?用法：dev/sign-macos.sh <标签，例如 v0.1.0>}"
cd "$(dirname "$0")/.."

profile="${NOTARY_PROFILE:-outpost-notary}"
identity="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ { print $2; exit }')}"
if [ -z "$identity" ]; then
  echo "钥匙串里没有 Developer ID Application 证书（见本脚本开头的说明）。" >&2
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$tag^{commit}")" ]; then
  echo "当前检出的不是 $tag：先 git checkout $tag，保证签的是这个版本的代码。" >&2
  exit 1
fi

out="target/dist-macos"
rm -rf "$out"
mkdir -p "$out"
pnpm -C ui install --frozen-lockfile
pnpm -C ui build

for t in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target add "$t" >/dev/null
  touch crates/cli/src/main.rs
  cargo build --release --locked -p outpost-cli --target "$t"
  bin="target/$t/release/outpost"
  codesign --force --timestamp --options runtime --identifier dev.outpost.cli --sign "$identity" "$bin"
  codesign --verify --strict --verbose=2 "$bin"
  if [ "${SKIP_NOTARIZE:-}" != "1" ]; then
    ditto -c -k "$bin" "$out/notarize-$t.zip"
    xcrun notarytool submit "$out/notarize-$t.zip" --keychain-profile "$profile" --wait
    rm -f "$out/notarize-$t.zip"
  fi
  mkdir -p "$out/stage-$t"
  cp "$bin" LICENSE "$out/stage-$t/"
  tar -czf "$out/outpost-$t.tar.gz" -C "$out/stage-$t" outpost LICENSE
  rm -rf "$out/stage-$t"
done

echo "已签名：$identity"
ls -l "$out"
[ "${NO_UPLOAD:-}" = "1" ] && exit 0

# 更新校验和：保留其它平台的行，换掉两个 Mac 包的。
gh release download "$tag" -p SHA256SUMS -D "$out" --clobber
grep -v "apple-darwin" "$out/SHA256SUMS" > "$out/SHA256SUMS.new" || true
(cd "$out" && shasum -a 256 outpost-*-apple-darwin.tar.gz >> SHA256SUMS.new)
sort -k2 "$out/SHA256SUMS.new" > "$out/SHA256SUMS"
rm -f "$out/SHA256SUMS.new"
gh release upload "$tag" "$out"/outpost-*-apple-darwin.tar.gz "$out/SHA256SUMS" --clobber
echo "发布页上的 Mac 包已换成签名版：$tag"
