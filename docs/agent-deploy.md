# 交给本机助手的安装指令

> 请完整部署 Mydstiny/remotedesk-codex-plugin 的固定 v0.3.0 Release。先阅读对应固定 tag/commit 的 README、SECURITY、compatibility.json 和 docs/operations.md，下载归档并核验 SHA256SUMS，不执行浮动远程 shell。使用当前用户的现有 Codex 模型配置，不读取/显示/复制密钥。无需 Docker。选择我已授权的项目和监听地址，安装到持久版本目录，state 放在项目以外的私有目录。保持原生 Codex 默认只读和按需审批，其他权限由控制端明确选择。先前台启动，通过参考客户端完成配对、真实模型消息、原生文件/命令接受和拒绝、问答、取消、后台任务及停启历史验证，再安装当前用户后台服务。用原生权限说明真实的读取、网络、提权和后台进程范围，不承诺容器隔离。完成后提供版本/包哈希、持久路径、主机端点、项目、服务状态与逐项结果；如遇 unknown 保留原操作身份并核对，不盲目重试。不更改代理、防火墙、公开网络暴露或主机账号，不开发鸿蒙客户端或宣称手机已验收。

固定归档与 SHA256SUMS 在 [Release](https://github.com/Mydstiny/remotedesk-codex-plugin/releases/tag/v0.3.0)。公开下载不需要 GitHub token。部署助手应记录解析到的 tag commit 与包哈希，先检查现有安装，复用原私有 state 的信任与历史，不覆盖配置或重新签发身份。
