# RemoteDesk Codex 插件

RemoteDesk 鸿蒙 Pro 远程 AI 工作台的 Codex 电脑端组件。当前为 **0.1.0-alpha.1 / AI0 开发探针**，不是可以从手机连接的正式插件。

源码与版本直接在本 GitHub 仓库管理。鸿蒙 App 在 [RemoteDeskHarmonyOS](https://github.com/Mydstiny/RemoteDeskHarmonyOS) 独立开发。当前不需要公网服务器，不启动任何网络监听。

## 现在可以做什么

- 检测已安装 Codex 版本；通过真实 App Server stdio 握手并创建只读临时会话。
- 测试分帧、请求关联、大小/并发上限、退出/超时清理和默认拒绝审批。

尚未提供：远程聊天、模型回合控制、可信执行沙盒、安装器、设备配对、后台服务、鸿蒙工作台或 RustDesk 隧道。

## 运行源码诊断

使用维护者提供的固定提交检出本仓库，安装 Node.js 22 或更高版本后，在仓库根目录运行：

```sh
npm test
node bin/remotedesk-codex.mjs doctor --json
```

当前没有 npm 包依赖；无需执行远程安装脚本。`doctor` 成功只表示当前检查通过，`remoteAccess` 始终为 `false`。真实引擎验证仅覆盖文档中的指定组合。

[详细操作](docs/operations.md) · [让用户 Agent 操作](docs/agent-deploy.md) · [兼容表](docs/compatibility.md) · [路线图](docs/roadmap.md) · [English](README.en.md)

鸿蒙端最终使用同一项 `pro.lifetime` 买断权益；本 alpha 不解锁或售卖未完成能力。
