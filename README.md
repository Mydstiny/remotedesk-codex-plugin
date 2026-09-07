# RemoteDesk Codex 插件

**0.3.0：使用原生工具，无需 Docker。** 为未来鸿蒙 RemoteDesk Pro 工作台提供可配对的电脑端服务。支持会话和历史、模型/推理强度、流式输出、原生命令与文件操作、审批和问答、继续/取消、分叉、压缩及后台任务控制。

需要 Node.js **22.16+**、OpenSSL 3、Codex **0.153.4**，以及已配置的宿主模型账号。未知引擎/组件版本拒绝启动。模型凭据保留在本机引擎，配对设备只获得明确授权的项目。

原生权限遵循各宿主能力：Codex 默认只读、按需审批，可选择项目写入；DSH 使用原生写入沙箱并逐次审批写文件和 shell。原生读取、网络、提权及后台进程的边界见 [SECURITY](SECURITY.md)，不能视为容器隔离。扩展和子 agent 委派未在此版本开放。

从 [v0.3.0 Release](https://github.com/Mydstiny/remotedesk-codex-plugin/releases/tag/v0.3.0) 下载归档和 SHA256SUMS，核验后解压到持久版本目录，再按 [安装与运维](docs/operations.md) 部署。

```sh
node bin/remotedesk-codex.mjs doctor --json
node bin/remotedesk-codex.mjs help
```

默认监听 `127.0.0.1:9443`。注册 skill/bundle 本身不会开放监听；实际服务、模型账号及客户端连接需要各自验收。首次部署可把 [代理安装说明](docs/agent-deploy.md) 交给本机助手执行。

[English](README.en.md) · [协议](docs/protocol.md) · [兼容性与验证](docs/compatibility.md) · [依赖来源](docs/provenance.json) · [鸿蒙开发边界](docs/roadmap.md)
