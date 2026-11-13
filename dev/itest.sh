#!/usr/bin/env bash
# 集成测试：在临时的 BUNSEN_DATA_DIR 下起真实的 bunsen serve，经 HTTP / WebSocket 走完整条流程。
# 前提：测试容器在跑（dev/test-server/run.sh up，默认 dev@127.0.0.1:2222）。
# 自定义端口：BUNSEN_TEST_PORT=2223 dev/test-server/run.sh up，然后 dev/itest.sh。
# 端口优先级：BUNSEN_TEST_PORT → dev/test-server/.tmp/port → 2222。
#   dev/itest.sh
set -eu
cd "$(dirname "$0")/.."
port="${BUNSEN_TEST_PORT:-}"
if [ -z "$port" ] && [ -f dev/test-server/.tmp/port ]; then
  port="$(cat dev/test-server/.tmp/port)"
fi
port="${port:-2222}"
if ! (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
  echo "测试容器没在跑（127.0.0.1:$port 连不上）：先执行 BUNSEN_TEST_PORT=$port dev/test-server/run.sh up" >&2
  exit 2
fi
if [ ! -f dev/test-server/.tmp/ssh_config ] || [ ! -f dev/test-server/.tmp/id_test ]; then
  echo "缺少 dev/test-server/.tmp/ssh_config 或 id_test：先执行 BUNSEN_TEST_PORT=$port dev/test-server/run.sh up" >&2
  exit 2
fi
BUNSEN_TEST_PORT="$port" BUNSEN_ITEST=1 exec cargo test -p bunsen-cli --test itest -- --ignored --nocapture --test-threads=1 "$@"
