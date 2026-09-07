# Codex 安装、运行与维护

## 1. 安装前检查

取得维护者指定的 Release/tag 和完整 commit，检查仓库为 `Mydstiny/remotedesk-codex-plugin`。下载版本 tarball 与 SHA256SUMS，macOS/Linux 用 `shasum -a 256` 或 `sha256sum`，Windows 用 `Get-FileHash -Algorithm SHA256` 核对。GitHub 同源 checksum 用于完整性检查，不是独立签名。

解压到用户有写权限的**持久版本目录**，例如用户应用目录下 `RemoteDesk/codex/0.2.0`；不要让后台服务引用临时目录或下载完成即删除的文件。保留旧版本用于回滚。Node.js、OpenSSL、Docker CLI 和 Codex 必须在启动时 PATH 中可用；用普通用户运行，禁止以 root/SYSTEM 部署。Windows 使用 Docker Desktop Linux 容器模式，Linux 使用用户可访问的本机 Docker socket，macOS 使用本机 Docker Desktop。远端 TCP Docker daemon 不支持。

```sh
node bin/remotedesk-codex.mjs doctor --json
```

### Codex 插件与后台进程

包内 `.codex-plugin/plugin.json` 和 `skills/remotedesk-setup` 用于 Codex 的设置引导；后台服务由下文命令单独管理。只安装 skill 不会启动监听。远程会话使用主机 provider/model，但采用 RemoteDesk 的受限提示与三项动态工具，不继承本地插件、MCP、浏览器、子 Agent、原生 shell 或任意技能执行能力。

官方 App Server 的 `environments: []` 用于每次创建/恢复及每次回合，移除原生执行环境；命令转到项目 Docker。此模式不是完整复制本地 Codex 的所有功能。默认使用已配置模型；本地主机管理员可在 `project-add` 指定 `--provider`、`--model`。未知模型默认为文本；经本地确认支持视觉后才加 `--vision on`。

## 2. 准备执行镜像

插件不会在回合中自动拉取镜像。用仓库的固定基础镜像 Dockerfile 在本机构建，然后记录实际 image ID。自定义镜像须由本地主机管理员审核，包含 `/bin/sh`、Node.js、git 和所需工具链；项目命令无网络，依赖应预装在镜像/项目中。

```sh
docker build -t remotedesk-sandbox:0.2.0 packages/bridge-core/sandbox
docker image inspect remotedesk-sandbox:0.2.0 --format '{{.Id}}'
```

将输出的 `sha256:...` 用于 `--image`。镜像被固定为具体内容，不使用浮动 tag。容器限额：512 MiB 内存、1 CPU、128 PID、180 秒单命令、1 MiB 输出、64 MiB 临时目录。镜像构建可联网；远程回合容器不可联网。macOS/Linux 容器使用当前 UID/GID，Windows 为 1000:1000；项目共享必须允许该用户写入。项目路径不支持逗号或换行。

## 3. 初始化和项目授权

下列是 POSIX shell 示例。在 PowerShell 中使用 `$STATE = Join-Path $env:USERPROFILE '.remotedesk/codex'` 并将 `$STATE` 按普通字符串参数传入。不要复用 shell 的 HOME 变量。

```sh
STATE="$HOME/.remotedesk/codex"
node bin/remotedesk-codex.mjs init --state "$STATE" --host 127.0.0.1 --hosts localhost,127.0.0.1 --port 9443
node bin/remotedesk-codex.mjs project-add --state "$STATE" --id demo --path "/absolute/project" --title "Demo" --image "sha256:<64 hex characters>"
```

请替换示例路径和 image ID。状态目录不能在任何授权项目中，项目不能包含状态目录。初始化只接受新空目录：POSIX 权限 0700；Windows ACL 仅当前用户完全控制。证书、配对、会话映射、操作回执等都保存在此目录，不放入仓库。

局域网：初始化时 `--host` 指定本机 LAN 地址，`--hosts` 同时包含客户端实际使用的 DNS/IP、localhost 和 127.0.0.1。仅证书列出的名称可连接；`0.0.0.0` 是监听地址，不能当客户端证书名。将所选端口仅向需要的局域网开放，插件不会修改防火墙。现有配置变更应停服、编辑私有 `config.json` 并重启；SAN 变化需重新初始化证书和配对，不能使用跳过 TLS 校验。

## 4. 前台启动与配对

```sh
node bin/remotedesk-codex.mjs serve --state "$STATE"
```

成功输出 `ready: true`。在另一个终端生成两分钟有效的单次邀请；它只写入私有状态目录，不把配对码打印到日志：

```sh
node bin/remotedesk-codex.mjs invite --state "$STATE" --projects demo --role operator --out "$STATE/invite.json"
node bin/remotedesk-codex.mjs pair --client "/absolute/private-client" --url "https://127.0.0.1:9443" --invite "$STATE/invite.json"
node bin/remotedesk-codex.mjs read --client "/absolute/private-client" --method project.list
```

远端参考客户端同样从包运行 `pair`，通过可信方式接收邀请文件；配对完成删除传输副本和邀请文件。客户端自己生成私钥，私钥不发给服务端。可签发 `viewer` 只读设备。最多 16 个未撤销设备，每个邀请替代尚未使用的旧邀请。证书有效期 90 天，到期前创建新客户端身份并撤销旧设备，不延长旧私钥身份。

后台日志只应保留启动和错误码，不记录邀请或模型凭据。模型内容、附件及工具输出会正常出现在已授权会话历史中，客户端应当视为项目私有数据。

## 5. 操作会话

协议参数通过 JSON 文件输入，防止 shell 转义破坏内容。`read` 不需要操作 ID；`write` 自动将原始请求、epoch 和 UUID 持久保存到客户端状态目录。

1. `write --method session.create --params create.json`，文件为 `{"projectId":"demo","title":"Remote task"}`，记下返回的 `sessionId`。
2. `write --method lease.acquire --params lease.json`，文件为 `{"sessionId":"<id>"}`，记下 `lease`。
3. `write --method turn.start --params turn.json`，文件为 `{"sessionId":"<id>","lease":"<lease>","text":"Inspect this project"}`。
4. `read --method session.read --params session.json`，文件为 `{"sessionId":"<id>"}`；用返回的 cursor 运行 `watch --cursor <cursor>`，历史分页使用 snapshot.nextCursor 再次读取。
5. `read --method approval.list --params session.json` 获取待处理请求。命令答复 `approval.answer` 的参数为 `{"sessionId":"<id>","lease":"<lease>","approvalId":"<id>","answer":{"decision":"accept"}}`；拒绝用 `decline`，提问答复用 `{"text":"answer"}`。

所有命令都加 `node bin/remotedesk-codex.mjs` 前缀与 `--client "/absolute/private-client"`。写租约 90 秒到期，客户端每 30 秒用 `lease.renew` 续期。断网不会取消已运行任务，但失效租约不再接受审批；显式 `turn.cancel` 才停止回合。支持 `turn.steer`、`session.archive`/`session.resume`、`diff.read` 与 UTF-8/PNG/JPEG 附件，详见 [协议](protocol.md)。模型是否支持图片另看所选 provider。

**超时或 unknown：不要创建新 UUID 重发同一动作。** 使用 `retry --operation <原始ID>` 查询/重试已保存请求；过期 epoch 或 unknown 回执必须核对会话/差异后再决定新动作。服务重启会轮换事件 runtime 并清除旧租约，重新握手、快照和取得租约。SSE 的 RESET_REQUIRED 同样要重新快照，不从零盲目续接。

## 6. 后台服务

确认前台配对成功，Ctrl-C 停止后再安装当前用户服务：

```sh
node bin/remotedesk-codex.mjs service --state "$STATE" --action render
node bin/remotedesk-codex.mjs service --state "$STATE" --action install
node bin/remotedesk-codex.mjs service --state "$STATE" --action status
node bin/remotedesk-codex.mjs service --state "$STATE" --action stop
node bin/remotedesk-codex.mjs service --state "$STATE" --action start
```

macOS：LaunchAgent，用户登录后启动。Linux：systemd user，需正常用户服务管理器；默认退出登录后的行为由该用户会话决定，本工具不修改 linger。Windows：当前登录用户的 Scheduled Task，LeastPrivilege/InteractiveToken，不保存密码，不支持未登录时以 SYSTEM 代运行。服务记录固定 Node 路径、插件路径和必要 PATH/DSH_HOME，不存模型密钥。

stop 会先等待正常退出，再与启动互斥地停止原生管理器，避免刚启动但尚未监听的进程在 stop 返回后继续运行。macOS stop 保留描述文件但卸载当前 job，start 会重新加载。

服务不在崩溃后自动重启，避免不明操作被自动重复。先检查原生管理器状态与会话，再执行 `recover` 清理已确认死亡的本插件锁，随后 start。recover 拒绝活 PID，绝不偷走另一个控制器的锁。Docker 恢复仅删除带本服务 owner 标记且有本服务记录的容器，不运行 prune。

## 7. 升级、回滚、续证和卸载

- **升级**：核验新包和固定兼容版本 → 停止并卸载旧服务注册 → 离线备份整个私有 state 与 DSH 对应会话存储 → 解压新版本到新目录 → DSH 重新 plugin-install 本地包 → 用新目录 service install → 配对/历史/审批/取消回归。备份含私钥，必须保持私有权限。不得复制 state 给第二台机器并同时运行。
- **回滚**：停新服务并卸载注册，保留故障现场，使用旧版本目录重装。0.2.x 仅在状态 schema 兼容时直接复用；跨状态版本使用维护前的完整离线备份，不能把旧数据库与新证书混搭。恢复旧备份会改变已知操作历史，先核对所有未决动作，不自动发起写入。
- **服务证书**：一年有效。`renew-server --state "$STATE"` 使用同一 CA/私钥续期，再正常停启服务。SAN 不变；CA 十年到期必须安排新信任与重新配对。
- **撤销设备**：`status` 获取本服务设备 ID，`revoke --device <id>`。在轮询检测撤销后（正常间隔 500 ms）关闭现有流、拒绝旧审批，并请求取消该设备拥有的远程回合；完成取消仍需引擎与容器确认退出；不会注销主机账号或取消其他本地 Agent。
- **卸载**：先 stop，再 `service --action uninstall`；DSH 用原生 plugin remove 移除此 bundle。保留 state、DSH 会话和用户项目；明确无需历史后再由用户删除这些数据。删除版本目录仅限本插件，不卸载官方引擎、Docker 或模型账号。

## 故障排查

`UNVERIFIED_*`：固定兼容版本不匹配；不要删除版本门。`DOCKER_*`：检查本机 Linux daemon、共享路径、固定镜像及普通用户权限。`PRIVATE_DIRECTORY_*`：核对目录所有者/ACL，不放宽为 everyone。`WORKSPACE_CLEANUP_UNCONFIRMED`/`execution.blocked`：项目写锁仍保留；停止服务，确认 Docker 可用，按 recover 清理后再启动，不可强删锁。`PROJECT_BUSY`：另一个 RemoteDesk 会话正在写同一项目；先查看并停止正确会话。`RESET_REQUIRED`：重新握手/快照。`EPOCH_*_RECONCILE`/`unknown`：核对历史后再操作。命令退出码 0 为当前动作成功，2 为失败或不确定结果。不得把 doctor 成功当作模型账户或设备矩阵通过。
