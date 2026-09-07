# 交给用户 Agent 的部署任务

可直接复制下面的任务，补充安装主机、版本、项目和监听地址：

> 请将 Mydstiny/remotedesk-codex-plugin 的指定 Release 0.2.0 部署到这台电脑。先阅读固定 commit 下的 README、SECURITY、compatibility.json 与 docs/operations.md，核对 Release 文件 SHA256SUMS；不要运行浮动远程 shell。使用当前用户的现有 Codex provider 登录，不读取、打印或复制账号密钥。安装持久版本目录，核验 Node/OpenSSL/Codex/本机 Docker Linux 容器，将我选定的项目与固定镜像加入独立私有 state。先前台启动并配对参考客户端，验证项目列表、发消息、审批接受/拒绝、取消和停启恢复，再安装用户后台服务。完成后提供主机端点、CA 指纹的可信核对方式、已授权项目、版本、命令与验收结果。保留项目、原有本地会话、模型配置及旧版本回滚材料。没有授权的防火墙/公网/账号改变先说明具体必要性；不暴露原生引擎端口。不在本任务里开发鸿蒙端或宣称手机已验收。

## Agent 执行清单

1. 检查 OS/架构、PATH、精确引擎组件版本；未知组合 fail closed，报告差异。
2. 从可信仓库固定 tag/commit 获取包。私有 GitHub 访问使用用户已有权限，不索取 token。Release checksum 与源码都来自同一仓库，不宣称独立签名认证。
3. 保存安装路径和 state 路径；state 与授权项目绝不重叠。审核镜像 Dockerfile，联网构建后固定 image ID；不在会话中自动安装 host 工具。
4. 按 operations 初始化监听、证书 SAN、项目、provider/model。默认 loopback；LAN 需用户已指定的网卡地址/端口。原生引擎远程端口始终不直接对外。
5. Codex 使用本机 App Server；受限远程会话只提供 Docker 工具，不继承本地 MCP/插件。
6. 前台 `serve`，邀请写入私有文件。只通过可信渠道交给目标客户端，不放日志/聊天/issue；客户端生成独立私钥。
7. 用本包参考客户端完成真实 HTTPS 冒烟测试：项目列表、会话、租约、消息与历史、命令审批接受及拒绝、问题答复、取消、停启后恢复。使用专用测试项目，模型调用可能按现有 provider 计费，应遵循用户预算。
8. 检查服务 render 后安装。核验 service status、退出/重新登录后的启动条件。交付服务端点和操作指南，清理仅本次邀请/测试副本。
9. 遇到 unknown/超时，保留原 UUID/epoch 回执，禁止自动新 ID 重发；恢复遵守 operations。
10. 明确报告真实模型/真实系统/实际手机分别验证到了哪一步。CI 的模型响应使用确定性模拟服务，但引擎本身是真实发行版；不要把它称为云模型账号验收。

升级/回滚/卸载采用 operations 的完整步骤；后台 service uninstall 保留全部 state 和项目。终端日志不得包含私钥、邀请、模型 token 或用户项目内容。
