# RemoteDesk Codex 插件

**0.2.0：Windows、macOS、Linux 电脑端远程 AI 服务。** 基于 Codex App Server（每个远程会话独立进程），提供 TLS 双向认证、设备配对、项目选择、会话历史与事件流、发送/追加/取消、逐次命令审批、提问答复、差异和附件。

鸿蒙客户端和 RustDesk 隧道接入由 [RemoteDeskHarmonyOS](https://github.com/Mydstiny/RemoteDeskHarmonyOS) 后续实现。本仓库已经提供可工作的协议服务与命令行参考客户端；手机 App 的连接界面不包含在此版本中。App 规划复用 `pro.lifetime`，电脑端不伪造购买凭据或单独收费解锁。

需要 Node.js **22.16+**（CI 覆盖 22/24/26）、OpenSSL 3、Codex **0.153.4**、本机 Docker 的 Linux 容器，以及现有 Codex 登录或已配置的模型 provider。引擎和 Docker 不随插件打包。未知引擎版本会拒绝启动，避免内部接口漂移。

远程工具只可在选定项目的 Docker 容器执行：非 root、无网络、只挂载该项目，写命令逐次审批。可读取的项目文件及命令输出会发送给主机配置的模型。请选择允许处理的项目；项目目录含 `.git` 及其内部所有文件。详见 [安全边界](SECURITY.md)。

## 开始使用

从本仓库 Releases 取得固定版本包及 `SHA256SUMS`，校验后解压到长期保留的版本目录。先阅读 [完整安装与操作](docs/operations.md)，或把 [Agent 部署说明](docs/agent-deploy.md) 发给你自己的 Agent。

```sh
node bin/remotedesk-codex.mjs doctor --json
node bin/remotedesk-codex.mjs help
```

`doctor` 只检查当前引擎兼容性；真实启动还检查 Docker 镜像和项目，配对验收才证明客户端可访问。安装 Codex skill/DSH bundle 本身不会开放端口。默认监听 `127.0.0.1:9443`；两插件共用主机时给 DSH 选择另一端口。

局域网连接无需经过 OpenAI 中继：客户端直连电脑上的 HTTPS 服务。**模型计算是否联网取决于电脑配置的 provider**；云模型仍需访问其服务，本地 provider 可在其支持范围内本地运行。插件没有内置模型，也不接管账号。

[操作手册](docs/operations.md) · [Agent 部署](docs/agent-deploy.md) · [协议](docs/protocol.md) · [兼容与验收](docs/compatibility.md) · [English](README.en.md)
