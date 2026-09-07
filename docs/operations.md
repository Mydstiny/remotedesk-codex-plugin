# 安装与运维：原生版 0.3.0

## 准备

核对 README、compatibility.json、SECURITY 和 Release 的 SHA256SUMS。将归档解压到当前用户可写的持久版本目录，例如 `RemoteDesk/codex/0.3.0`。所有命令从该目录运行。使用普通用户；不要让服务引用临时目录，不以 root/SYSTEM 运行。

需要 Node.js 22.16+、OpenSSL 3、Codex **0.153.4**。使用宿主原有 provider 配置，不复制/显示密钥，不修改全局模型默认值。`doctor --json` 只验证版本和结构，实际模型调用需单独测试。无需容器、镜像或 Docker daemon。

## 初始化和授权项目

```sh
STATE="$HOME/.remotedesk/codex"
node bin/remotedesk-codex.mjs init --state "$STATE" --host 127.0.0.1 --hosts localhost,127.0.0.1 --port 9443
node bin/remotedesk-codex.mjs project-add --state "$STATE" --id demo --path "/absolute/project" --title "Demo"
```

将示例路径替换为本机已授权目录。在 PowerShell 中用 `$STATE = Join-Path $env:USERPROFILE '.remotedesk/codex'`；不要覆盖 HOME。初始化只接受新的私有空目录；state 与所有项目都不能互相包含。已有 state 可在停服并备份后升级，不重新 init 覆盖证书。

`project-add` 可选 `--provider`、`--model`；模型凭据只在宿主原生配置中设置。`--vision on|off` 是本机对图片能力的显式覆盖。远端只能选择已配置 provider/model，不能传 endpoint 或密钥。

局域网部署时，`--host` 使用明确的本机 LAN 地址，`--hosts` 包含客户端使用的地址、localhost 和 127.0.0.1。按需要授权防火墙访问，插件不会改变防火墙/代理。禁止跳过 TLS 证书检查；监听 `0.0.0.0` 不能替代有效 SAN。

## 启动、配对和本机验收

```sh
node bin/remotedesk-codex.mjs serve --state "$STATE"
```

看到 `ready: true` 后，在另一终端创建两分钟有效的邀请并配对参考客户端：

```sh
node bin/remotedesk-codex.mjs invite --state "$STATE" --projects demo --role operator --out "$STATE/invite.json"
node bin/remotedesk-codex.mjs pair --client "/absolute/private-client" --url "https://127.0.0.1:9443" --invite "$STATE/invite.json"
node bin/remotedesk-codex.mjs read --client "/absolute/private-client" --method project.list
```

邀请通过可信渠道传递；不要贴进公开聊天或日志，配对完成删除传输副本。每个客户端本地生成私钥。可签发 viewer；最多 16 个未撤销设备。模型内容与工具结果属于会话历史，应保持私有。

协议参数通过 JSON 文件传给 `write --method <method> --params <file>`，并附 `--client`。按顺序测试：session.create → lease.acquire → turn.start → approval.list/approval.answer → session.read；然后检查命令接受/拒绝、取消、归档/恢复、重启后的历史。租约 90 秒有效，每 30 秒续期。`model.list` 返回可选模型与强度，`session.update` 修改标题/设置；`session.fork`、`session.compact` 和 `terminal.list/stop` 用法见 [协议](protocol.md)。

审批须展示完整原生命令、文件变更和权限范围。普通批准用 `{"decision":"accept"}`；拒绝/取消用 decline/cancel；结构化问题用 `{"answers":{"questionId":{"answers":["所选答案"]}}}`。Codex 原生权限请求接受时还要明确 `"scope":"turn"`。不要持久记住整类命令的允许规则。

Codex 默认 read-only/on-request，显式 workspace-write 允许沙箱内原生写入；DSH 默认 workspace-write 且写/edit/shell 逐次批准。工具输出中的错误、回合 failed、unknown 都不是验收通过。无需文件浏览专用接口：由原生 read/search 工具读取项目，差异由原生事件提供。

## 用户后台服务

先停止前台服务，再从持久版本目录运行：

```sh
node bin/remotedesk-codex.mjs service --state "$STATE" --action render
node bin/remotedesk-codex.mjs service --state "$STATE" --action install
node bin/remotedesk-codex.mjs service --state "$STATE" --action status
node bin/remotedesk-codex.mjs service --state "$STATE" --action stop
node bin/remotedesk-codex.mjs service --state "$STATE" --action start
```

macOS 使用 LaunchAgent；Linux 使用 systemd user；Windows 使用当前用户 LeastPrivilege/InteractiveToken 计划任务。默认按用户登录会话启动，不自动修改 linger 或保存账号密码。服务使用固定 Node/插件路径和必要 PATH，模型密钥不写入服务定义。stop 等待本插件原生活动清理；崩溃后不会自动重启或重复模型请求。

## 未知结果与崩溃恢复

超时或 unknown 时保留原 operationId/epoch，使用 `retry --operation <id>`，先核对历史，不换 UUID 重复派发。重启后重新握手、读取快照和取得租约；旧审批不可复用。

如果出现 NATIVE_ACTIVITY_RECONCILIATION_REQUIRED，先停服，再运行：

```sh
node bin/remotedesk-codex.mjs recover --state "$STATE" --action inspect
```

检查列出的原生会话/后台活动，在宿主原生工具或系统进程管理器中确认它们已停止。任意自行脱离的进程不在自动管理保证内。只有实际完成此检查后，才能把返回的精确 acknowledgement 值传给：

```sh
node bin/remotedesk-codex.mjs recover --state "$STATE" --confirm-native-cleanup "<acknowledgement>"
```

此确认是操作者对原生工作已清理的声明；命令本身不杀进程。记录变化使旧摘要失效，活 PID 始终拒绝恢复。不确定时保留锁，不能强删。旧版留下 container 记录时，应先使用旧版清理；新版不会调用 Docker 处理旧活动。

## 升级、续证和卸载

升级顺序：停旧服务 → 备份私有 state/原生历史 → 解压并核验新目录 → DSH 重新 plugin-install → 从新目录安装服务 → 配对/模型/审批/取消/历史回归。0.2.0 升级改变工具和权限合同，先停止所有旧活动；不要把原生新版状态直接交给旧执行器继续工作。回滚使用维护前完整备份并核对未决操作。

`renew-server --state "$STATE"` 续签同一 CA/SAN 的服务证书后需重启。设备证书 90 天、服务证书一年、CA 十年；更换身份需要重新配对和撤销旧设备。`status` 查看设备 ID，`revoke --device <id>` 撤销并请求取消其远程活动。卸载前 stop，再 `service --action uninstall`；保留项目、state、原生账号和用户历史。

常见错误：UNVERIFIED_* 表示版本不匹配；PRIVATE_DIRECTORY_* 表示权限不安全；PROJECT_BUSY 表示另一 RemoteDesk 会话持有项目；APPROVAL_STALE 表示租约/设备/请求已变化；NATIVE_SESSION_* 或 unknown 需要核对原生历史。命令退出 0 仅表示本次动作成功，2 表示失败或未知。
