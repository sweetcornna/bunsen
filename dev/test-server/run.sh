#!/usr/bin/env bash
# 启动（或重建）集成测试用的 SSH 目标容器，并生成连接它用的一次性密钥与 ssh 配置。
#   dev/test-server/run.sh up      构建并启动，默认监听 127.0.0.1:2222
#   BUNSEN_TEST_PORT=2223 dev/test-server/run.sh up  使用其他端口，然后运行 dev/itest.sh
#   dev/test-server/run.sh down    停止并删除容器
# 生成物都在 dev/test-server/.tmp/ 下（已被 .gitignore 忽略）：
#   id_test / id_test.pub   一次性密钥
#   ssh_config              `Host bunsen-test` 一个块，可直接作为“上传的 ssh 配置”
#   port                    实际端口，供 dev/itest.sh 读取
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$here/.tmp"
name=bunsen-test-ssh
# 在任何复制、构建或容器操作之前校验；不让 shell 按八进制解释前导零。
port="${BUNSEN_TEST_PORT-2222}"
case "$port" in ''|*[!0123456789]*) echo 'BUNSEN_TEST_PORT 必须是 1 到 65535 的十进制整数' >&2; exit 2 ;; esac
port="${port#"${port%%[!0]*}"}"
port="${port:-0}"
if [ "${#port}" -gt 5 ] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  echo 'BUNSEN_TEST_PORT 必须是 1 到 65535 的十进制整数' >&2; exit 2
fi
port_busy() {
  if command -v nc >/dev/null 2>&1; then nc -z -w 1 127.0.0.1 "$port" >/dev/null 2>&1
  else (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null
  fi
}
case "${1:-up}" in
  down)
    docker rm -f "$name" >/dev/null 2>&1 || true
    echo "已删除容器 $name"
    ;;
  up)
    own=no
    # 直接检查运行中的固定名称与实际绑定，不依赖 publish 过滤器对容器端口的解释。
    if docker ps --format '{{.Names}}' | grep -Fx "$name" >/dev/null &&
       docker port "$name" 22/tcp | grep -Fx "127.0.0.1:$port" >/dev/null; then own=yes; fi
    if [ "$own" != yes ] && port_busy; then
      echo "端口 127.0.0.1:${port} 已被占用；请改用 BUNSEN_TEST_PORT，例如 BUNSEN_TEST_PORT=2223 dev/test-server/run.sh up" >&2
      exit 1
    fi
    mkdir -p "$tmp"
    [ -f "$tmp/id_test" ] || ssh-keygen -q -t ed25519 -N "" -C bunsen-test -f "$tmp/id_test"
    cp "$tmp/id_test.pub" "$here/authorized_keys"
    docker build -q -t bunsen-test-ssh "$here" >/dev/null
    rm -f "$here/authorized_keys"
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" -p "127.0.0.1:$port:22" bunsen-test-ssh >/dev/null
    printf '%s\n' "$port" > "$tmp/port"
    cat > "$tmp/ssh_config" <<EOF
Host bunsen-test
  HostName 127.0.0.1
  Port $port
  User dev
  IdentityFile id_test
EOF
    for i in $(seq 1 30); do
      if ssh -F /dev/null -i "$tmp/id_test" -p "$port" -o BatchMode=yes -o StrictHostKeyChecking=no \
           -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 -o LogLevel=ERROR dev@127.0.0.1 true 2>/dev/null; then
        echo "测试目标就绪：dev@127.0.0.1:${port}，密钥 $tmp/id_test，配置 $tmp/ssh_config"
        exit 0
      fi
      sleep 1
    done
    echo "容器起来了但 ssh 连不上 127.0.0.1:${port}；docker logs $name 看原因" >&2
    exit 1
    ;;
  *)
    echo "用法：run.sh up|down" >&2
    exit 2
    ;;
esac
