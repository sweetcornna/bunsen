#!/usr/bin/env bash
# 启动（或重建）集成测试用的 SSH 目标容器，并生成连接它用的一次性密钥与 ssh 配置。
#   dev/test-server/run.sh up      构建并启动，监听 127.0.0.1:2222
#   dev/test-server/run.sh down    停止并删除容器
# 生成物都在 dev/test-server/.tmp/ 下（已被 .gitignore 忽略）：
#   id_test / id_test.pub   一次性密钥
#   ssh_config              `Host bunsen-test` 一个块，可直接作为“上传的 ssh 配置”
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$here/.tmp"
name=bunsen-test-ssh
case "${1:-up}" in
  down)
    docker rm -f "$name" >/dev/null 2>&1 || true
    echo "已删除容器 $name"
    ;;
  up)
    mkdir -p "$tmp"
    [ -f "$tmp/id_test" ] || ssh-keygen -q -t ed25519 -N "" -C bunsen-test -f "$tmp/id_test"
    cp "$tmp/id_test.pub" "$here/authorized_keys"
    docker build -q -t bunsen-test-ssh "$here" >/dev/null
    rm -f "$here/authorized_keys"
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" -p 127.0.0.1:2222:22 bunsen-test-ssh >/dev/null
    cat > "$tmp/ssh_config" <<EOF
Host bunsen-test
  HostName 127.0.0.1
  Port 2222
  User dev
  IdentityFile id_test
EOF
    for i in $(seq 1 30); do
      if ssh -F /dev/null -i "$tmp/id_test" -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=no \
           -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 -o LogLevel=ERROR dev@127.0.0.1 true 2>/dev/null; then
        echo "测试目标就绪：dev@127.0.0.1:2222，密钥 $tmp/id_test，配置 $tmp/ssh_config"
        exit 0
      fi
      sleep 1
    done
    echo "容器起来了但 ssh 连不上；docker logs $name 看原因" >&2
    exit 1
    ;;
  *)
    echo "用法：run.sh up|down" >&2
    exit 2
    ;;
esac
