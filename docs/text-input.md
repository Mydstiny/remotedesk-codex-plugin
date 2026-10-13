# 免费远端输入识别辅助

此独立元数据服务供 RemoteDesktop 的虚拟键盘使用。它不启动 Codex、DSH 或模型，不读取正文、选区文字、密码、窗口标题或终端内容，不提供注入、shell、文件和 AI 操作。与现有 AI 桥使用不同状态目录、CA、设备授权和端口，基础键盘功能不受 Pro 权益控制。

服务默认监听 `127.0.0.1:9446`，只接受 TLS 1.3。配对邀请码由本机管理员生成，两分钟过期且只能使用一次。配对后的每次请求需要 mTLS 设备证书，设备撤权在查询前后复查。元数据 lease 绑定 runtime、设备 generation、客户端 owner nonce、协议、连接标识、当前显示器和 framebuffer 尺寸；15 秒过期，以服务端单调时间判断。

用 `node bin/remotedesk-text-input.mjs probe` 核验平台 provider 状态。不会弹出或自动授予辅助功能权限。`init <state>` 创建独立私有目录和 CA；`enroll <state> <descriptor.json>` 登记已由操作者确认的捕获桌面；`invite <state> <binding-id>` 生成设备邀请码；`serve <state>` 运行服务。`devices <state>` 列出设备 ID、到期和撤权状态（不输出证书或密钥），再用 `revoke <state> <device-id>` 撤权。部署到 LAN、修改监听地址/证书 SAN 或授权辅助功能需要操作者明确操作，安装本仓库不会自行执行。

捕获登记格式：

```json
{"id":"capture","protocol":"rdp","connectionKey":"<64位小写SHA256>","desktopId":"windows:3:Default","displayId":0,"frame":{"x":0,"y":0,"width":1920,"height":1080},"captureKind":"monitor","outputFrame":{"width":1920,"height":1080},"protocolSessionId":"rdp:3","captureConfirmed":true}
```

connectionKey 来自客户端连接配置摘要，避免端点更改后复用授权；它本身不能证明捕获桌面。操作者必须核验服务进程处于真正的捕获桌面，并确认 displayId、物理像素原点/裁剪和 frame 尺寸。RDP session 与 console、Xvnc 与物理 X11、Moonlight 应用捕获与全桌面均不可互换。未确认的登记被拒绝；尺寸变化需要重新登记，不能仅按宽高近似匹配。v1 仅支持已确认的完整桌面或完整显示器捕获（captureKind=desktop/monitor），拒绝窗口和应用窗口捕获。每份 snapshot 将登记的物理 frame 与 provider 当时的完整 desktopRect/captureRects 核对；outputFrame 是远程流的实际像素尺寸，按显式比例转换，并拒绝未知裁剪、留白或非同宽高比。RDP 还必须把协议 LogonInfo 提供的远端 session ID（protocolSessionId=rdp:<ID>）与 Windows provider 实际进程 session 核对；缺少该协议证明时不提供精确输入识别，xrdp 等未确认映射保留手动/兼容输入。其它协议 protocolSessionId 使用空字符串。此版本仍需要操作者确认捕获生产者正在输出该桌面/显示器；不声称具有 RustDesk/Sunshine 签发的自动捕获证明。

| Provider | 当前源码能力与边界 |
| --- | --- |
| Windows UIA | 当前进程所在 session/desktop；必须匹配 input desktop 与 foreground root；读取 editable/readOnly/enabled/offscreen 和 control/collapsed range geometry；安全桌面拒绝 |
| macOS AX | 需要既有辅助功能授权；TextField/TextArea/ComboBox 的可写属性；不读 value；仅统一显示密度可转换到统一物理像素平面，混合 DPI 返回 unsupported |
| Linux AT-SPI | 系统安装的 PyGObject、Atspi 2、Gdk 3；仅 X11 scale=1，聚焦进程 DISPLAY 要匹配；Wayland、未知尺度及不匹配虚拟桌面返回 unsupported/unavailable |

来源能力逐项返回，缺少 caret 时只有控件矩形。UIA/AX/AT-SPI 不涵盖所有自绘、浏览器、游戏或特权窗口。此服务只观察焦点，不能按控件 token 原子注入普通远程协议输入；其他程序/客户端改焦点仍有竞态，应用必须保持输入序列屏障。

协议 `version=1`，POST `/v1/text-input/pair`、`handshake`、`bind`、`snapshot`。输入对象字段严格白名单。metadata 输出经逐字段重建，运行时 focus ID 加盐 SHA256，绝不透传 provider 对象。native provider 单进程、单查询在途、8192 字节上限与超时；服务至多 16 个请求、32 个 lease。分离 CA/授权不允许 metadata 设备调用 `/v1/rpc`。

测试证据应区分策略、真实 TLS fixture、native 编译/权限 probe、真实远端控件与 HarmonyOS Phone/Pad/PC。fixture 通过不代表平台或真实 LAN 可用。实际设备与远端绑定、中文候选、坐标/DPI、锁屏和撤权仍需单独验收。
