# 实验室档案（示例）

复制到 `~/.config/research-plugin/lab.md` 后按实际情况填写。这个文件只留在本机，不进任何仓库。密钥和口令不写在这里，只写它们所在的文件路径。

## 网络
- 接入方式：Tailscale，登录时接受子网路由（`--accept-routes`）
- 没有 TUN 设备时：用户态模式加 SOCKS5 代理

## 主机
| 别名 | 地址 | 用户 | 端口 | 备注 |
|---|---|---|---|---|
| `gpu-a` | 192.168.0.10 | someone | 22 | 协调主机，协作文档在这台 |
| `gpu-b` | 192.168.0.11 | someone | 2022 | |

## 密钥
- 私钥目录：`~/.config/research-plugin/keys/`（哪把对应哪台主机没有标明时，都试一下）
- 用来核对 `authorized_keys` 的公钥：`~/.config/research-plugin/keys/<名字>.pub`

## 任务层级
| 层级 | 可用的卡 |
|---|---|
| 层级 1 | 全部 |
| 层级 2 | 只能用 <型号> |

- 层级是上限。
- 层级 1 的任务先用层级 2 用不了的卡。

## 协作
- 协调主机：`gpu-a`
- 共享目录：`~/collab`（协作文档 `COLLAB.md` 与 `collab.py` 都在这里；没有就新建并告诉用户）

## 网页服务（任务用得到时再登录）
- 地址：https://example.invalid/
- 用户名：<用户名>
- 口令文件：`~/.config/research-plugin/secrets/web-password`
