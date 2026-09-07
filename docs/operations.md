# Codex 源码诊断与操作

当前仅支持 0.1.0-alpha.1 的源码诊断；没有用户级后台服务或可供鸿蒙配对的端口。

## 前提

使用可信固定提交、Node.js 22+ 和已安装的 Codex CLI 0.153.4。实际引擎集成只在 macOS arm64 / Node 26.4.0 验证；其他平台保持未验收。不要为了通过 doctor 擅自覆盖用户 Codex 安装或修改账号。

## 手工运行

在仓库根目录：

```sh
npm test
node bin/remotedesk-codex.mjs doctor --json
node bin/remotedesk-codex.mjs probe --json
npm pack --dry-run --ignore-scripts
```

`doctor` 只执行 `codex --version`。`probe` 另外启动独立 App Server stdio 子进程，在临时目录中完成 initialize / initialized / thread/start，然后终止子进程并删除本次临时目录。它要求上游确认 read-only、untrusted 和 user approval reviewer。不会发送 turn/start，也不会读取用户历史或调用模型。

引擎本身可能写运行缓存、日志或更新操作状态；`changed=false` 仅指诊断工具不安装服务、不更改用户设置，不是引擎绝对零磁盘写入承诺。运行环境若禁止引擎自己的缓存访问，探针可能返回 PROCESS_CLOSED。不要通过开放 App Server 网络端口处理此错误。

## 输出与故障

输出为固定 JSON 报告，包含 schemaVersion、status、changed、componentVersions、checks、actions、requiresUserAction、warnings 和 capabilities。0 表示执行的检查通过，2 表示阻塞，64 表示参数错误。

| code | 含义与处理 |
| --- | --- |
| CODEX_VERSION_UNVERIFIED | 当前版本未在白名单；提交兼容性验证后才扩大范围 |
| PROCESS_CLOSED / PROCESS_START_FAILED | 检查本机引擎能否正常启动及运行环境权限；不要上传完整运行日志 |
| EXECUTION_PROFILE_MISMATCH | 上游未确认所要求的设置；停止，不自动放宽 |
| REQUEST_TIMEOUT_RECONCILE | 请求结果未知，所有挂起请求结束；禁止自动重发 |
| INVALID_FRAME / FRAME_TOO_LARGE | 协议内容或限额不符，连接已关闭 |

无账户/凭据诊断由此工具执行，doctor 通过也不能证明已登录、额度可用或模型可执行。

## 停止、卸载与后续

命令正常结束即停止；中断命令后检查该次子进程是否已退出。当前没有安装器、launchd/systemd/Windows 服务、开机启动、配对证书或防火墙修改。卸载当前源码工具只需移除本次副本，保留官方 Codex 与用户数据。

标准插件 manifest 与 `skills/remotedesk-setup` 已包含源码诊断流程，但本 alpha 没有发布到插件市场，不修改用户本地 marketplace。发布后的正式安装与更新流程会单独验证。
