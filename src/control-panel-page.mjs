// Local control panel page shared by the RemoteDesk host plugins (Codex, DSH, Claude Agent).
// The page is served with `default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'`,
// so everything (styles, icons, script) stays inline and no external resource is loaded.

const ENGINES = new Set(["codex", "dsh", "claudecode"]);

const STYLE = `
:root{color-scheme:light dark;--panel-bg:#f4f5f7;--panel-surface:#ffffff;--panel-surface-2:#f7f8fa;--panel-border:#e3e6eb;--panel-text:#15181d;--panel-muted:#5a6371;--panel-faint:#8b94a1;--panel-input:#ffffff;--panel-input-border:#d4d9e0;--ok:#16884a;--ok-bg:#e6f5ec;--warn:#9a6200;--warn-bg:#fff3d9;--bad:#c0362c;--bad-bg:#fdebe9;--accent:#2f6fed;--accent-ink:#ffffff;--shadow:0 1px 2px rgba(16,24,40,.04),0 6px 20px rgba(16,24,40,.06);--radius:18px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei","Segoe UI",sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
:root[data-engine=codex]{--accent:#0d8a66}
:root[data-engine=dsh]{--accent:#4d6bfe}
:root[data-engine=claudecode]{--accent:#c2603d}
@media(prefers-color-scheme:dark){:root{--panel-bg:#0d0f12;--panel-surface:#15181d;--panel-surface-2:#1b1f25;--panel-border:#292e36;--panel-text:#eef1f5;--panel-muted:#a5aebb;--panel-faint:#747e8c;--panel-input:#101317;--panel-input-border:#353c46;--ok:#4ade80;--ok-bg:#11301f;--warn:#fbbf24;--warn-bg:#3a2c0c;--bad:#f87171;--bad-bg:#3a1616;--accent-ink:#0b0d10;--shadow:0 1px 2px rgba(0,0,0,.35),0 10px 28px rgba(0,0,0,.28)}:root[data-engine=codex]{--accent:#3cc99d}:root[data-engine=dsh]{--accent:#8299ff}:root[data-engine=claudecode]{--accent:#e3906f}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;min-height:100vh;color:var(--panel-text);background:var(--panel-bg);background-image:radial-gradient(1100px 420px at 50% -160px,color-mix(in srgb,var(--accent) 16%,transparent),transparent 72%);background-repeat:no-repeat}
main{max-width:1120px;margin:0 auto;padding:28px 20px 40px}
h1,h2,h3,p{margin:0}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.82em}
.muted{color:var(--panel-muted)}.faint{color:var(--panel-faint)}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:14px;min-width:0}
.mark{flex:none;width:46px;height:46px;border-radius:14px;display:grid;place-items:center;color:#fff;background:linear-gradient(140deg,color-mix(in srgb,var(--accent) 78%,#fff),var(--accent) 55%,color-mix(in srgb,var(--accent) 70%,#000));box-shadow:0 6px 18px color-mix(in srgb,var(--accent) 35%,transparent)}
.mark svg{width:26px;height:26px}
.title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h1{font-size:1.38rem;font-weight:650;letter-spacing:-.01em}
.engine{font-size:.78rem;font-weight:600;padding:3px 10px;border-radius:999px;color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent);border:1px solid color-mix(in srgb,var(--accent) 28%,transparent)}
.subtitle{margin-top:3px;font-size:.88rem;color:var(--panel-muted)}
.top-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;font-size:.84rem;font-weight:600;background:var(--panel-surface);border:1px solid var(--panel-border);box-shadow:var(--shadow);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--panel-faint)}
.pill.ok .dot{background:var(--ok);box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 55%,transparent);animation:pulse 2.2s infinite}
.pill.warn .dot{background:var(--warn)}.pill.bad .dot{background:var(--bad)}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 50%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
button{font:inherit;cursor:pointer;border-radius:11px;border:1px solid transparent;padding:9px 15px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:7px;transition:background .15s,border-color .15s,transform .1s,opacity .15s}
button:active{transform:translateY(1px)}
button:disabled{opacity:.55;cursor:wait}
button svg{width:16px;height:16px;flex:none}
.btn-primary{background:var(--accent);color:var(--accent-ink);box-shadow:0 4px 14px color-mix(in srgb,var(--accent) 30%,transparent)}
.btn-primary:hover{background:color-mix(in srgb,var(--accent) 88%,#000)}
.btn-ghost{background:var(--panel-surface);color:var(--panel-text);border-color:var(--panel-border)}
.btn-ghost:hover{background:var(--panel-surface-2)}
.btn-danger{background:transparent;color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,transparent);padding:6px 12px;font-size:.84rem}
.btn-danger:hover{background:var(--bad-bg)}
.btn-block{width:100%;padding:12px 16px}
button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible,.option:focus-within{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}
.notice{margin-top:18px;border-radius:14px;padding:11px 14px;font-size:.9rem;background:color-mix(in srgb,var(--accent) 11%,var(--panel-surface));color:var(--panel-text);border:1px solid color-mix(in srgb,var(--accent) 25%,transparent)}
.notice.error{background:var(--bad-bg);color:var(--bad);border-color:color-mix(in srgb,var(--bad) 30%,transparent)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:22px}
.kpi{background:var(--panel-surface);border:1px solid var(--panel-border);border-radius:16px;padding:14px 16px;box-shadow:var(--shadow);min-width:0}
.kpi-label{font-size:.8rem;color:var(--panel-muted)}
.kpi-value{margin-top:2px;font-size:1.7rem;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.layout{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px;margin-top:16px;align-items:start}
.column{display:grid;gap:16px;min-width:0}
.card{background:var(--panel-surface);border:1px solid var(--panel-border);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow);min-width:0}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
.card-head h2{font-size:1.02rem;font-weight:650}
.card-head p{margin-top:2px;font-size:.84rem;color:var(--panel-muted)}
.step{font-size:.78rem;font-weight:650;letter-spacing:.02em;color:var(--panel-muted);margin:16px 0 8px;text-transform:uppercase}
.options{display:grid;gap:8px}
.options.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.option{position:relative;display:flex;align-items:flex-start;gap:10px;padding:11px 13px;border:1px solid var(--panel-border);border-radius:13px;background:var(--panel-surface-2);cursor:pointer;min-width:0;transition:border-color .15s,background .15s}
.option:hover{border-color:color-mix(in srgb,var(--accent) 40%,var(--panel-border))}
.option:has(input:checked){border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,var(--panel-surface))}
.option input{margin:3px 0 0;accent-color:var(--accent);flex:none}
.option b{display:block;font-size:.92rem;font-weight:600}
.option small{display:block;font-size:.8rem;color:var(--panel-muted);overflow-wrap:anywhere}
.result{margin-top:18px;padding-top:18px;border-top:1px dashed var(--panel-border)}
.result-grid{display:grid;grid-template-columns:auto minmax(0,1fr);gap:20px;align-items:start}
.qr-wrap{position:relative;width:228px;max-width:100%}
.qr-box{width:228px;max-width:100%;aspect-ratio:1;padding:12px;border-radius:16px;background:#fff;color:#111;border:1px solid var(--panel-border);display:grid;place-items:center;box-shadow:var(--shadow)}
.qr-box svg{display:block;width:100%;height:auto}
.qr-expired{position:absolute;inset:0;border-radius:16px;display:grid;place-items:center;align-content:center;gap:10px;text-align:center;background:color-mix(in srgb,var(--panel-surface) 88%,transparent);backdrop-filter:blur(3px);font-weight:600}
.tabs{display:inline-flex;padding:3px;border-radius:12px;background:var(--panel-surface-2);border:1px solid var(--panel-border);gap:2px}
.tab{background:transparent;color:var(--panel-muted);padding:6px 12px;border-radius:9px;font-size:.86rem}
.tab[aria-selected=true]{background:var(--panel-surface);color:var(--panel-text);box-shadow:0 1px 3px rgba(16,24,40,.12)}
.timer{margin-top:14px}
.timer-row{display:flex;justify-content:space-between;font-size:.84rem;color:var(--panel-muted);font-variant-numeric:tabular-nums}
.bar{margin-top:6px;height:6px;border-radius:999px;background:var(--panel-surface-2);border:1px solid var(--panel-border);overflow:hidden}
.bar span{display:block;height:100%;width:100%;background:var(--accent);border-radius:inherit;transition:width .25s linear}
.bar.low span{background:var(--warn)}
.how{margin:14px 0 0;padding:0;list-style:none;display:grid;gap:7px;counter-reset:how;font-size:.88rem;color:var(--panel-muted)}
.how li{display:flex;gap:9px;align-items:baseline}
.how li::before{counter-increment:how;content:counter(how);flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:.72rem;font-weight:700;color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}
.pair-link{padding:12px;border-radius:12px;background:var(--panel-input);border:1px solid var(--panel-border);font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.76rem;line-height:1.55;max-height:150px;overflow:auto;overflow-wrap:anywhere;user-select:all}
.row-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
details{margin-top:12px}
summary{cursor:pointer;font-size:.86rem;color:var(--panel-muted);border-radius:8px;width:fit-content}
textarea,input[type=text]{width:100%;font:inherit;color:var(--panel-text);background:var(--panel-input);border:1px solid var(--panel-input-border);border-radius:11px;padding:10px 12px}
textarea{margin-top:8px;min-height:150px;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.76rem}
input[type=text]:focus,textarea:focus{border-color:var(--accent)}
.field{display:grid;gap:5px;margin-top:10px}
.field label{font-size:.82rem;font-weight:600;color:var(--panel-muted)}
.list{display:grid;gap:10px}
.item{display:flex;gap:12px;align-items:flex-start;padding:12px;border-radius:14px;border:1px solid var(--panel-border);background:var(--panel-surface-2);min-width:0}
.item-icon{flex:none;width:36px;height:36px;border-radius:11px;display:grid;place-items:center;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
.item-icon svg{width:19px;height:19px}
.item-body{flex:1;min-width:0}
.item-title{font-weight:600;font-size:.94rem;overflow-wrap:anywhere}
.item-sub{font-size:.78rem;color:var(--panel-faint);overflow-wrap:anywhere}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
.chip{font-size:.74rem;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--panel-surface);border:1px solid var(--panel-border);color:var(--panel-muted);white-space:nowrap}
.chip.ok{color:var(--ok);background:var(--ok-bg);border-color:transparent}.chip.warn{color:var(--warn);background:var(--warn-bg);border-color:transparent}.chip.bad{color:var(--bad);background:var(--bad-bg);border-color:transparent}
.chip.accent{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);border-color:transparent}
.empty{padding:22px 12px;text-align:center;border:1px dashed var(--panel-border);border-radius:14px;color:var(--panel-muted);font-size:.9rem}
.kv{display:grid;gap:10px}
.kv-row{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:.9rem;min-width:0}
.kv-row>span:first-child{color:var(--panel-muted);flex:none}
.kv-row>span:last-child{text-align:right;overflow-wrap:anywhere;min-width:0}
.tips{margin:0;padding:0;list-style:none;display:grid;gap:10px;font-size:.86rem;color:var(--panel-muted)}
.tips li{display:flex;gap:10px;align-items:flex-start}
.tips svg{flex:none;width:17px;height:17px;margin-top:2px;color:var(--accent)}
footer{margin-top:26px;text-align:center;font-size:.8rem;color:var(--panel-faint)}
.skeleton{color:var(--panel-faint)}
@media(max-width:900px){.layout{grid-template-columns:minmax(0,1fr)}}
@media(max-width:640px){main{padding:20px 14px 32px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.result-grid{grid-template-columns:minmax(0,1fr)}.qr-wrap,.qr-box{width:100%;max-width:260px;margin:0 auto}.options.two{grid-template-columns:minmax(0,1fr)}.top-actions{width:100%}.top-actions .pill{flex:1;justify-content:center}h1{font-size:1.2rem}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

const ICON = {
  mark: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='4' width='18' height='12' rx='2.5'/><path d='M8 20h8M12 16v4'/><path d='M12 7.2l.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9z' fill='currentColor' stroke='none'/></svg>",
  refresh: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M20 11a8 8 0 0 0-14.6-4.5L4 8'/><path d='M4 4v4h4'/><path d='M4 13a8 8 0 0 0 14.6 4.5L20 16'/><path d='M20 20v-4h-4'/></svg>",
  qr: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='7' height='7' rx='1.5'/><rect x='14' y='3' width='7' height='7' rx='1.5'/><rect x='3' y='14' width='7' height='7' rx='1.5'/><path d='M14 14h3v3M21 14v.01M14 21h3M21 18v3'/></svg>",
  copy: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='9' y='9' width='12' height='12' rx='2.5'/><path d='M5 15V5a2 2 0 0 1 2-2h10'/></svg>",
  plus: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round'><path d='M12 5v14M5 12h14'/></svg>",
  shield: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'/><path d='M9 12l2 2 4-4'/></svg>",
  lock: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='4' y='11' width='16' height='10' rx='2.5'/><path d='M8 11V8a4 4 0 0 1 8 0v3'/></svg>",
  clock: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 7v5l3 2'/></svg>",
  info: "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round'><circle cx='12' cy='12' r='9'/><path d='M12 11v5M12 8h.01'/></svg>",
};

const BODY = `
<main>
<header class='top'>
<div class='brand'><div class='mark' aria-hidden='true'>${ICON.mark}</div><div><div class='title-row'><h1>RemoteDesk 控制面板</h1><span class='engine' id='engine-chip'>主机桥</span></div><div class='subtitle' id='subtitle'>正在加载状态…</div></div></div>
<div class='top-actions'><span class='pill' id='service-pill'><span class='dot'></span><span id='service-pill-text'>检查中</span></span><button id='refresh' class='btn-ghost' type='button' aria-label='刷新状态'>${ICON.refresh}<span>刷新状态</span></button></div>
</header>
<div id='notice' class='notice' role='status' aria-live='polite' hidden></div>
<section class='kpis' id='summary' aria-label='连接摘要'>
<div class='kpi'><div class='kpi-label'>项目</div><div class='kpi-value skeleton'>—</div></div><div class='kpi'><div class='kpi-label'>已配对设备</div><div class='kpi-value skeleton'>—</div></div><div class='kpi'><div class='kpi-label'>会话</div><div class='kpi-value skeleton'>—</div></div><div class='kpi'><div class='kpi-label'>操作记录</div><div class='kpi-value skeleton'>—</div></div>
</section>
<section class='layout'>
<div class='column'>
<article class='card'>
<div class='card-head'><div><h2>配对新设备</h2><p>在手机或平板的 RemoteDesk 里添加这台电脑。邀请 120 秒内有效，只能使用一次。</p></div></div>
<form id='invite-form'>
<div class='step'>1 · 可访问的项目</div><div class='options' id='project-checks'><div class='empty'>加载中…</div></div>
<div class='step'>2 · 权限</div>
<div class='options two' role='radiogroup' aria-label='权限'>
<label class='option'><input type='radio' name='role' value='operator' checked><span><b>可操作</b><small>可以对话、批准操作和查看差异</small></span></label>
<label class='option'><input type='radio' name='role' value='viewer'><span><b>只读</b><small>只能查看项目和会话</small></span></label>
</div>
<div class='step'>3 · 生成邀请</div>
<button type='submit' class='btn-primary btn-block'>${ICON.qr}<span>生成 120 秒邀请</span></button>
</form>
<div id='invite-result' class='result' hidden>
<div class='result-grid'>
<div class='qr-wrap'><div id='pair-qr' class='qr-box' role='img' aria-label='配对二维码'></div><div id='qr-expired' class='qr-expired' hidden><span>邀请已过期</span><button type='button' class='btn-primary' id='regenerate'>${ICON.refresh}<span>重新生成</span></button></div></div>
<div>
<div class='tabs' role='tablist' aria-label='配对方式'><button type='button' class='tab' role='tab' data-method='qr' aria-selected='true'>二维码（默认）</button><button type='button' class='tab' role='tab' data-method='link' aria-selected='false'>链接配对</button></div>
<div class='timer' id='timer'><div class='timer-row'><span id='timer-text'>剩余 120 秒</span><span>单次有效</span></div><div class='bar' id='timer-bar'><span></span></div></div>
<div id='pair-qr-help'><ol class='how'><li>打开 RemoteDesk → AI 主机 → 添加或编辑这台电脑</li><li>用系统相机扫描二维码，把扫描结果粘贴到“配对邀请”</li><li>保存并配对，完成后关闭本页的邀请</li></ol></div>
<div id='pair-link' hidden><div class='pair-link' id='pair-link-value'></div><ol class='how'><li>复制链接，通过可信渠道发到要配对的设备</li><li>在 RemoteDesk 的“配对邀请”里粘贴链接后保存</li></ol></div>
<div class='row-actions'><button id='copy-link' type='button' class='btn-ghost'>${ICON.copy}<span>复制配对链接</span></button><button id='copy-payload' type='button' class='btn-ghost'>${ICON.copy}<span>复制邀请 JSON</span></button></div>
</div>
</div>
<details><summary>显示完整邀请 JSON（手动导入备用）</summary><textarea id='invite-output' readonly aria-label='完整邀请 JSON'></textarea></details>
</div>
</article>
<article class='card'>
<div class='card-head'><div><h2>已配对设备</h2><p>“已配对”表示证书仍然有效，不代表设备此刻在线。</p></div></div>
<div id='devices' class='list'><div class='empty'>加载中…</div></div>
</article>
</div>
<div class='column'>
<article class='card'>
<div class='card-head'><div><h2>服务</h2><p>手机通过局域网连接下面的监听地址。</p></div></div>
<div id='service' class='kv'><div class='empty'>加载中…</div></div>
</article>
<article class='card'>
<div class='card-head'><div><h2>项目</h2><p>远程设备只能访问已授权的项目目录。</p></div></div>
<div id='projects' class='list'><div class='empty'>加载中…</div></div>
<details id='project-add'><summary>添加项目</summary>
<form id='project-form'>
<div class='field'><label for='project-id'>项目 ID</label><input type='text' id='project-id' required pattern='[A-Za-z0-9_-]+' maxlength='100' placeholder='my-project' autocomplete='off'></div>
<div class='field'><label for='project-path'>本机项目目录</label><input type='text' id='project-path' required placeholder='/absolute/project/path' autocomplete='off'></div>
<div class='field'><label for='project-title'>显示名称</label><input type='text' id='project-title' maxlength='200' placeholder='可选'></div>
<div class='row-actions'><button type='submit' class='btn-primary'>${ICON.plus}<span>添加项目</span></button></div>
</form>
</details>
</article>
<article class='card'>
<div class='card-head'><div><h2>安全提示</h2></div></div>
<ul class='tips'>
<li>${ICON.lock}<span>本面板只绑定 127.0.0.1，令牌只保存在当前标签页。</span></li>
<li>${ICON.shield}<span>邀请含设备证书材料，只通过可信渠道传给要配对的设备；配对后删除传输副本。</span></li>
<li>${ICON.clock}<span>不再使用的设备请及时撤销，撤销后它立即失去访问权限。</span></li>
</ul>
</article>
</div>
</section>
<footer id='footer'>RemoteDesk 主机桥 · 面板只绑定 127.0.0.1</footer>
</main>
`;

const SCRIPT = `
const ENGINE_NAMES={codex:['Codex','OpenAI Codex'],dsh:['DSH','DeepSeek Harness'],claudecode:['Claude Agent','Claude Agent SDK']};
const ENGINE=document.documentElement.dataset.engine||'';
const initialToken=new URLSearchParams(location.search).get('token');
if(initialToken){sessionStorage.setItem('remotedesk.panel.token',initialToken);history.replaceState(null,'','/');}
const token=sessionStorage.getItem('remotedesk.panel.token')||'';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const ICON_DEVICE="<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='6' y='2.5' width='12' height='19' rx='2.5'/><path d='M11 18.5h2'/></svg>";
const ICON_FOLDER="<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/></svg>";
let currentData=null,currentInvite=null,currentLink='',currentQr='',method='qr',timer=0;
const checkedProjects=new Set();let projectsSeen=false;
function engineLabel(engine){return (ENGINE_NAMES[engine]||[engine||'主机桥'])[0];}
function notice(message,error=false){const el=$('notice');el.textContent=message;el.className=error?'notice error':'notice';el.hidden=!message;}
async function api(path,options={}){const headers=Object.assign({'Authorization':'Bearer '+token},options.headers||{});if(options.body)headers['Content-Type']='application/json';const response=await fetch(path,Object.assign({},options,{headers}));let data;try{data=await response.json()}catch{data={}}if(!response.ok)throw new Error(data.error||('HTTP_'+response.status));return data;}
async function copyText(value,message){try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(value);else{const helper=document.createElement('textarea');helper.value=value;helper.style.position='fixed';helper.style.opacity='0';document.body.appendChild(helper);helper.select();const copied=document.execCommand('copy');helper.remove();if(!copied)throw new Error('COPY_UNAVAILABLE')}notice(message)}catch{notice('复制失败，请展开完整 JSON 后手动复制。',true)}}
function base64Url(value){const bytes=new TextEncoder().encode(value);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).split('+').join('-').split('/').join('_').replace(/=+$/,'');}
function pairingLink(invite,data){const service=data?.service;const host=typeof service?.host==='string'?service.host.trim():'';const port=Number(service?.port);let url='';if(host!==''&&Number.isInteger(port)&&port>0&&port<65536){const authority=host.includes(':')&&!host.startsWith('[')?'['+host+']':host;url='https://'+authority+':'+String(port)}const payload={type:'remotedesk-pair',version:1,engine:data?.engine||ENGINE,...(url===''?{}:{url}),invite:{code:invite.code,expires:invite.expires,ca:invite.ca,serverInstance:invite.serverInstance}};return 'remotedesk://pair?data='+base64Url(JSON.stringify(payload));}
function qrMarkup(result,invite){if(typeof result.qrSvg==='string'&&result.qrSvg.startsWith('<svg'))return result.qrSvg;if(typeof qrcode==='function'){try{const generator=qrcode(0,'M');generator.addData(JSON.stringify(invite),'Byte');generator.make();return generator.createSvgTag(4,4,'RemoteDesk pairing QR','RemoteDesk');}catch{}}return '';}
function serviceStatus(service){if(service.running)return ['ok','运行中'];if(service.lock==='stale')return ['warn','锁文件陈旧'];return ['bad','未运行'];}
function renderService(data){const service=data.service;const [cls,label]=serviceStatus(service);$('service-pill').className='pill '+cls;$('service-pill-text').textContent=label;const address=esc(service.host)+':'+esc(service.port);const loopback=/^(127\\.|localhost$|::1$)/.test(String(service.host||''));$('service').innerHTML='<div class="kv-row"><span>状态</span><span class="chip '+cls+'">'+label+'</span></div><div class="kv-row"><span>监听地址</span><span class="mono">'+address+'</span></div>'+(loopback?'<div class="notice" style="margin-top:2px">当前只监听本机，手机和平板暂时无法连接。需要远程使用时，用局域网地址重新初始化服务。</div>':'')+'<div class="kv-row"><span>进程</span><span class="mono">'+esc(service.pid||'—')+'</span></div><div class="kv-row"><span>控制面板</span><span class="mono">127.0.0.1:'+esc(data.panel?.port||location.port)+'</span></div>';}
function kpi(label,value){return '<div class="kpi"><div class="kpi-label">'+label+'</div><div class="kpi-value">'+value+'</div></div>';}
function renderSummary(data){const paired=data.devices.filter(d=>d.status==='paired').length;const operations=Object.values(data.operations||{}).reduce((a,b)=>a+b,0);$('summary').innerHTML=kpi('项目',data.projects.length)+kpi('已配对设备',paired)+kpi('会话',data.sessions.length)+kpi('操作记录',operations);}
function renderProjects(data){$('projects').innerHTML=data.projects.map(p=>'<div class="item"><div class="item-icon">'+ICON_FOLDER+'</div><div class="item-body"><div class="item-title">'+esc(p.title)+'</div><div class="item-sub mono">'+esc(p.path)+'</div><div class="chips"><span class="chip">'+esc(p.id)+'</span>'+(p.provider?'<span class="chip accent">'+esc(p.provider)+'</span>':'')+(p.model?'<span class="chip">'+esc(p.model)+'</span>':'')+'</div></div></div>').join('')||'<div class="empty">尚未配置项目，先在下方添加一个本机目录。</div>';
if(!projectsSeen&&data.projects.length===1)checkedProjects.add(data.projects[0].id);projectsSeen=true;
$('project-checks').innerHTML=data.projects.map(p=>'<label class="option"><input type="checkbox" name="project" value="'+esc(p.id)+'"'+(checkedProjects.has(p.id)?' checked':'')+'><span><b>'+esc(p.title)+'</b><small class="mono">'+esc(p.id)+'</small></span></label>').join('')||'<div class="empty">先在右侧“项目”里添加项目</div>';
document.querySelectorAll('input[name=project]').forEach(input=>input.addEventListener('change',()=>{if(input.checked)checkedProjects.add(input.value);else checkedProjects.delete(input.value);}));}
function deviceStatus(d){if(d.status==='paired')return ['ok','已配对'];if(d.status==='revoked')return ['bad','已撤销'];return ['warn','已过期'];}
function renderDevices(data){const rows=data.devices.slice().sort((a,b)=>(a.revoked===b.revoked?0:a.revoked?1:-1)).map(d=>{const [cls,label]=deviceStatus(d);return '<div class="item"><div class="item-icon">'+ICON_DEVICE+'</div><div class="item-body"><div class="item-title">'+esc(d.name||'未命名设备')+'</div><div class="item-sub mono" title="'+esc(d.id)+'">'+esc(d.id)+'</div><div class="chips"><span class="chip '+cls+'">'+label+'</span><span class="chip">'+(d.role==='operator'?'可操作':'只读')+'</span>'+(d.projects||[]).map(p=>'<span class="chip">'+esc(p)+'</span>').join('')+'</div></div>'+(d.revoked?'':'<button class="btn-danger revoke" type="button" data-device="'+esc(d.id)+'">撤销</button>')+'</div>';}).join('');
$('devices').innerHTML=rows||'<div class="empty">还没有配对设备。生成邀请后，用手机上的 RemoteDesk 完成配对。</div>';
document.querySelectorAll('.revoke').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('撤销此设备的远程访问？'))return;button.disabled=true;try{await api('/api/revoke',{method:'POST',body:JSON.stringify({device:button.dataset.device})});notice('设备已撤销');await refresh(false)}catch(error){notice(error.message,true)}finally{button.disabled=false}}));}
function render(data){currentData=data;const engine=data.engine||ENGINE;if(engine&&ENGINE_NAMES[engine])document.documentElement.dataset.engine=engine;const names=ENGINE_NAMES[engine]||[engine,engine];$('engine-chip').textContent=names[0];$('footer').textContent='RemoteDesk 主机桥 · '+names[1]+' · 面板只绑定 127.0.0.1';$('subtitle').textContent='仅限本机访问 · 更新于 '+new Date().toLocaleTimeString();renderService(data);renderSummary(data);renderProjects(data);renderDevices(data);}
async function refresh(clear=true){if(!token){notice('控制令牌缺失。请使用插件启动时输出的本机面板 URL 打开。',true);return}try{if(clear)notice('');render(await api('/api/status'))}catch(error){notice(error.message,true)}}
function showMethod(next){method=next;document.querySelectorAll('.tab').forEach(tab=>tab.setAttribute('aria-selected',String(tab.dataset.method===method)));const link=method==='link';$('pair-qr').parentElement.hidden=link;$('pair-qr-help').hidden=link;$('pair-link').hidden=!link;}
function tick(){if(!currentInvite)return;const left=Math.max(0,currentInvite.expires-Date.now());const seconds=Math.ceil(left/1000);$('timer-text').textContent=left>0?'剩余 '+seconds+' 秒':'邀请已过期';const bar=$('timer-bar');bar.firstElementChild.style.width=Math.min(100,left/1200)+'%';bar.classList.toggle('low',seconds<=20);$('qr-expired').hidden=left>0;if(left<=0){clearInterval(timer);timer=0;}}
function renderInvite(result){const invite=result.invite;currentInvite=invite;currentLink=typeof result.pairingLink==='string'&&result.pairingLink?result.pairingLink:pairingLink(invite,currentData);currentQr=qrMarkup(result,invite);$('invite-output').value=JSON.stringify(invite,null,2);$('pair-qr').innerHTML=currentQr||'<span class="muted">二维码暂时不可用，请切换到链接配对。</span>';$('pair-link-value').textContent=currentLink;$('invite-result').hidden=false;showMethod(currentQr?'qr':'link');if(timer)clearInterval(timer);tick();timer=setInterval(tick,250);$('invite-result').scrollIntoView({behavior:'smooth',block:'nearest'});}
$('refresh').addEventListener('click',()=>refresh(true));
document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>showMethod(tab.dataset.method)));
$('copy-link').addEventListener('click',()=>copyText(currentLink,'配对链接已复制'));
$('copy-payload').addEventListener('click',()=>copyText(JSON.stringify(currentInvite,null,2),'邀请 JSON 已复制'));
$('regenerate').addEventListener('click',()=>$('invite-form').requestSubmit());
$('project-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{await api('/api/project',{method:'POST',body:JSON.stringify({id:$('project-id').value,path:$('project-path').value,title:$('project-title').value||undefined})});event.target.reset();$('project-add').open=false;notice('项目已添加；服务重启后会加载新的项目配置');await refresh(false)}catch(error){notice(error.message,true)}finally{button.disabled=false}});
$('invite-form').addEventListener('submit',async event=>{event.preventDefault();const projects=[...document.querySelectorAll('input[name=project]:checked')].map(input=>input.value);if(!projects.length){notice('至少选择一个项目',true);return}const role=document.querySelector('input[name=role]:checked')?.value||'operator';const button=event.target.querySelector('button[type=submit]');button.disabled=true;try{const result=await api('/api/invite',{method:'POST',body:JSON.stringify({projects,role})});renderInvite(result);notice('邀请已生成，120 秒后过期')}catch(error){notice(error.message,true)}finally{button.disabled=false}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(false);});
setInterval(()=>{if(!document.hidden)refresh(false);},15000);
refresh();
`;

/**
 * Returns the control panel page for one engine. `qrScript` is an optional inline QR generator for engines whose
 * invite route returns only the invite (DSH); the others send the QR markup with the invite.
 */
export function controlPanelPage(engine, qrScript = "") {
  const id = ENGINES.has(engine) ? engine : "";
  return [
    "<!doctype html>",
    "<html lang='zh-CN'" + (id ? " data-engine='" + id + "'" : "") + ">",
    "<head>",
    "<meta charset='utf-8'>",
    "<meta name='viewport' content='width=device-width, initial-scale=1'>",
    "<meta name='color-scheme' content='light dark'>",
    "<title>RemoteDesk 控制面板</title>",
    "<style>" + STYLE + "</style>",
    "</head>",
    "<body>",
    BODY,
    "<script>",
    qrScript,
    SCRIPT,
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}
