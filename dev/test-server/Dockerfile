# 集成测试用的一次性 SSH 目标：sshd + tmux + bash + git + python3，外加一个假的代理程序。
# 只绑定在本机回环地址上，见 run.sh。
FROM alpine:3.20
RUN apk add --no-cache openssh-server tmux bash git python3 rsync coreutils procps \
 && ssh-keygen -A \
 && adduser -D -s /bin/bash dev \
 && passwd -u dev \
 && mkdir -p /home/dev/.ssh /home/dev/.local/bin \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && echo 'AllowTcpForwarding yes' >> /etc/ssh/sshd_config
COPY authorized_keys /home/dev/.ssh/authorized_keys
COPY fake-agent /home/dev/.local/bin/fake-agent
RUN chmod 700 /home/dev/.ssh && chmod 600 /home/dev/.ssh/authorized_keys \
 && chmod +x /home/dev/.local/bin/fake-agent \
 && chown -R dev:dev /home/dev
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
