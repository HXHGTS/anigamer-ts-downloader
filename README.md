# 动画疯 Tampermonkey TS 下载管理器

配套脚本：`anigamer-download.user.js`，版本 1.0.1。

## 1.0.1 管理页启动健壮性修复

- `document-start` 时文档根节点可能尚未建立；管理分支在 `window.stop()` 后重新读取根节点，有根则替换、无根则直接挂载，不等待可能不再触发的 `DOMContentLoaded`。无效管理 ID 也先建立可见页面再提示。
- stop、DOM 建壳与异步管理 UI 的异常统一显示为「管理器啟動失敗」，DOM 报错提示本身失败时退回 alert／控制台。没有改变播放、任务交付、下载、授权或加密逻辑。
- 这是启动健壮性修复，不是已确认的现场根因：调用方现场用 1.0.0 新播放页点击按钮及手工管理 URL 均正常显示，未复现原空白。
- 新增无依赖 `test-manager-dom.cjs`。运行 `node test-manager-dom.cjs` 可验证 9 项隔离 DOM 场景；`node test-manager-dom.cjs --baseline` 额外从 Git HEAD 读取旧版，在 mock 的根缺失、stop 清除根、无根且 ID 无效条件下复现旧版未捕获异常（HEAD 升级后不再适用旧版对照）。测试不访问网站、不下载、不执行解密。
- 本次语法检查及 9 项隔离测试通过；mock 不证明真实浏览器解析器／Tampermonkey 注入时序，不能保证阻止脚本注入之前已执行的网站脚本。1.0.1 的实际安装与现场浏览器验证、完整下载验证仍需另行执行。

## 作用与边界

在**独立的同站管理标签页**中，把您有权访问且通过网站正常播放流程取得授权的 HLS VOD 保存成 `.ts`。播放页不会被替换，管理页在 document-start 停止网站加载并建立独立界面，不加载自己的播放器或后台广告。

不调用私有 token API、不提取 Cookie、不生成签名、不模拟授权、不自动点击或跳过广告、不解除 DRM、付费或地区限制。请遵守网站条款与版权规定，勿传播下载内容。

## 安装

1. 使用桌面版 Chrome 或 Edge，安装并启用 Tampermonkey。
2. 在 Tampermonkey 中新建脚本，把配套 `.user.js` 全文粘贴保存；也可通过浏览器／扩展支持的本地脚本安装方式安装。
3. 按 Tampermonkey 当前版本的提示启用用户脚本权限，必要时允许扩展在该网站运行，刷新动画疯播放页。
4. 脚本仅匹配 `https://ani.gamer.com.tw/animeVideo.php*`。不需要额外服务器、Node、下载软件或跨域请求授权。

## 使用

1. 正常登录并打开目标集，正常完成网站要求的广告与播放操作。不要关闭原播放页。
2. 点击右下角「下載 TS（獨立管理頁）」。允许网站弹出窗口，新标签页地址包含随机 `agdManager`。
3. 管理页选择精确画质（360 / 540 / 720 / 1080p），选择本集、本季、指定数字集数或手动勾选。
4. 指定集数格式例如 `1-3,5`。只匹配页面的纯数字标签；SP、OVA、小数标签等请选「手動勾選」。本季仅指原页面 `.season a[data-ani-video-sn]` 实际列出的集数，不会扫描其他季。
5. **先点击「選擇輸出資料夾」**，在浏览器原生选择器中给予读写权限，然后点击开始。文件夹 handle 只在当前管理页内存中保存，不写 GM storage，也不跨刷新恢复。
6. 当前集优先使用点击按钮时已出现的正常主清单 URL。其他集需要正常准备资源：管理页显示同源播放 iframe，您应手动完成登录、广告及播放。
7. 如果 iframe 被限制、自动播放被阻止或无法完成操作，点击框架上方「在獨立分頁正常播放／準備本集」。在新播放页正常操作后，脚本通过随机任务 ID 和 GM storage 把主清单交回管理页。必须保持管理页开着；准备标签页不会被强制关闭，请自行暂停或关闭，避免额外播放。
8. 每集最多等待正常资源 10 分钟。超时会明确停止，不自动跳过集数，也不声称支持无人值守。本集 URL 失效时，请回原页面正常播放，再点击下载建立新任务。
9. 保存后请使用 VLC 等播放器检查时长、声音和画面。输出是 TS，不是转封装 MP4。

## 文件、进度与取消

- 串行按集、按片段下载，逐段写入 `FileSystemWritableFileStream`；不把整集拼成 Blob。内存只保留当前段及其网络缓冲／解密副本，另有清单元数据和当前密钥。
- 显示当前集、分段进度和累计 MiB；完成集单独列出。
- 文件名含标题、集数、画质和随机 UUID。建立前探测同名文件，不会有意覆盖已有文件。浏览器目录 API 没有跨程序原子的 create-if-absent；极端情况下其他程序恰好抢占同一 UUID 名称仍存在理论竞争风险。
- 单个片段限制 64 MiB，清单限制 4 MiB，密钥必须恰好 16 bytes。每次请求含响应体最长 30 秒，最多 3 次尝试；大多数 HTTP 4xx 直接报错。
- 点击取消会终止请求，并在写入／解密边界检查取消；不保证中断正在进行的一次磁盘写入或 WebCrypto 运算。已完成集保留。
- 失败或取消会尝试 `writer.abort()`，通常丢弃未提交内容，但新建文件可能留下 **0-byte 文件**；异常关闭、浏览器崩溃或实现差异也可能留下未完成内容。错误消息会给出文件名，请人工检查删除。为防止文件被其他程序替换后误删，脚本**不会按文件名自动删除**。
- 下载期间请勿刷新、关闭管理页、撤回文件夹权限或让系统休眠。关闭提示不能保证阻止所有异常退出。无断点续传，重试使用新文件名。

## 支持的 HLS 与安全设计

- 从正常播放页的 Resource Timing 中查找 `playlist_advance.m3u8`，不硬编码 CDN 签名、token 或媒体地址。主清单按 `RESOLUTION` 高度精确选择；缺少目标画质就报错，不静默降级。
- 仅支持带 `ENDLIST` 的 VOD MPEG-TS、AVC/AAC 常规 variant。不支持直播、fMP4 `EXT-X-MAP`、BYTERANGE、低延迟分段、discontinuity／GAP、外置音频／多视角或其他复杂清单。部分虽可正常播放的清单会被保守拒绝。
- 支持明文分段以及普通 `AES-128`、`KEYFORMAT=identity`。密钥通过浏览器普通已授权 `fetch` 获取，WebCrypto AES-CBC 验证并移除 PKCS#7 padding；显式 IV 为 128 位十六进制，无 IV 时使用 MEDIA-SEQUENCE 加分段索号的大端 128 位 IV。
- 拒绝 SAMPLE-AES、非 identity KEYFORMAT、DRM 及未知加密。解密后逐个 188-byte TS 包检查 `0x47` 同步字节，拒绝 HTML、JSON、fMP4 或损坏数据，不写入未经验证的段。
- 使用页面原生 `fetch` 与正常浏览器 credentials/CORS，不使用 GM_xmlhttpRequest 绕过 CORS。网站若依赖播放器特殊请求头、Referrer 或不同跨域策略而不能用普通 fetch 读取，脚本会报错，不伪造绕过。
- Tampermonkey 使用 `unsafeWindow` 访问页面的 fetch、performance、窗口与 File System Access API；管理 UI 在脚本沙箱中建立。不同浏览器／Tampermonkey 沙箱版本可能影响 API 桥接；本版本尚未完成实际安装后的全面桥接回归。
- 动态页面内容全部经 `textContent`，不拼接 HTML。资源 URL 限 HTTPS；链接仅由同站路径和校验过的集数构造。
- GM grants：`GM.getValue`、`GM.setValue`、`GM.deleteValue`、`GM.listValues`、`unsafeWindow`。GM storage 保存任务元数据及短期签名资源 URL，不保存 Cookie、密钥、输出目录 handle 或视频。新管理页轮询最多 10 秒处理开页／写任务竞态。
- 任务 6 小时有效。旧记录在后续正常播放页加载时清理，并非到点自动后台清理。若需立即清除签名 URL，请使用 Tampermonkey 的该脚本存储管理功能清除记录；不要把存储内容发给别人。

## 已验证与尚未验证

本次现场已由调用方确认：测试页 `https://ani.gamer.com.tw/animeVideo.php?sn=49789` 标题为「貓與龍 [1]」，DOM 可读第 1–12 集；播放器使用 blob、无 mediaKeys；正常资源列表有主清单，普通已认证 fetch 为 200；主清单有 360/540/720/1080，子清单是普通 AES-128 identity HLS；安全上下文、`crypto.subtle`、`showDirectoryPicker` 可用，无 meta CSP。**未改动现场暂停的原播放器。**

本脚本已通过：

- `node --check` 语法检查。
- 隔离 VM 中 17 项纯函数／WebCrypto 测试：精确画质、相对地址、缺失画质、外部音轨拒绝、AES 密钥 URI 和序号、显式 IV、大端 IV、直播／DRM／SAMPLE-AES／fMP4／BYTERANGE／discontinuity 拒绝、TS 同步检查、集数区间与特殊集处理、AES-CBC padding 往返。

**尚未执行全片或全季下载测试**，未声称已验证实际输出文件的全片音画、所有 Tampermonkey 沙箱组合、iframe／独立准备标签页交接、文件夹授权及取消后的真实磁盘行为。需在您自己的正常授权会话中验证。站点结构、HLS 格式与浏览器策略变化可能导致停止工作。
