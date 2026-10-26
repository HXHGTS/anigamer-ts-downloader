# 动画疯 Tampermonkey TS 下载管理器

配套脚本：`anigamer-download.user.js`，版本 **1.0.2**。

## 1.0.2 当前页模态窗体

点击播放页右下角「下載 TS（目前頁面）」直接创建当前页的原生 `dialog`，内容样式隔离在 Shadow Root 中。不打开下载管理标签页，不停止页面加载，不替换网站文档根或播放器，不自动操作播放、广告或权限。重复点击只聚焦现有窗体，不创建第二个管理器／队列。

窗体独立滚动、原生模态焦点约束；背景正文暂时锁定滚动，关闭恢复原 overflow 值及优先级，焦点回到原按钮。关闭按钮和 Escape 使用同一流程：闲置时直接关闭；下载期间先确认，确认后 abort 并等待当前队列清理，再移除窗体。拒绝确认则继续下载。关闭后可重新打开，目录授权 handle 不跨窗体保存。

已移除旧 `agdManager` 管理分支及 GM 任务交付轮询。当前集任务直接传给当前页 UI；独立播放准备页的 `agdPrepare` 交接仍保留，但只在用户点击准备链接时打开，不自动打开管理页。

## 边界

仅保存您有权取得、通过网站正常播放已授权的 HLS VOD MPEG-TS。不要传播下载内容；请遵守网站条款与版权规定。

不调用私有 token API、不提取 Cookie、不生成签名、不模拟授权、不自动点击或跳过广告，不解除 DRM、付费或地区限制。原播放器不会被暂停、替换或销毁；模态背景不可交互期间，原播放仍可能继续。

## 安装与使用

1. 桌面 Chrome／Edge 安装并启用 Tampermonkey，将 `.user.js` 全文粘贴保存，按扩展提示启用脚本权限，刷新动画疯播放页。匹配范围为 `https://ani.gamer.com.tw/animeVideo.php*`。
2. 正常登录、完成广告及播放操作，点击「下載 TS（目前頁面）」。不需要允许下载管理弹窗。
3. 选择精确画质（360／540／720／1080p）、本集、本季、指定数字集数或手动勾选。指定格式如 `1-3,5`，只匹配纯数字标签；SP／OVA／小数标签请手动勾选。本季仅指当前页面实际列出的集数，不扫描其他季。
4. **直接点击「選擇輸出資料夾」**，在浏览器原生选择器中给予读写权限，再开始下载。选择器在点击回调中、任何 await 之前调用；返回的 handle 仅保留在原闭包内，不复制到另一 sandbox／窗口或 GM storage。选择器打开期间禁止开始队列，关闭窗体后的迟到结果会被忽略。
5. 当前集优先使用点击时已出现的正常主清单。其他集需在窗体内的同源播放 iframe 中正常完成登录、广告及播放；不会自动点击或设置 autoplay。
6. 若 iframe 被限制，可手动点击「在獨立分頁正常播放／準備本集」。脚本通过随机准备 ID 与 GM storage 交回正常资源。准备页不会被强制关闭，请自行暂停／关闭，避免额外播放；保持下载窗体所在页打开。
7. 每集最多等待正常资源 10 分钟；失败明确停止，不自动跳过，不支持无人值守。授权过期时重新正常播放，再关闭并重开下载窗体。
8. 完成后用 VLC 等检查时长与音画。输出是 TS，不是转封装 MP4。

## 写入、进度、取消

- 串行逐集逐段写入 FileSystemWritableFileStream，不把整集拼成 Blob。显示分段进度、累计 MiB 和已完成集。
- 文件名含标题、集数、画质和随机 UUID，建立前探测同名文件。目录 API 没有跨程序原子的 create-if-absent，理论上仍存在极端竞争风险。
- 单段上限 64 MiB、清单 4 MiB、密钥必须 16 bytes；每次请求含响应体最长 30 秒，最多尝试 3 次，大多数 HTTP 4xx 直接停止。
- 取消中止网络请求，在写入／解密边界检查取消；无法立即中断已在进行的单次磁盘写入或 WebCrypto 运算。关闭窗体等待队列退出，包括 writer.abort 与准备区清理；已经完成的集保留。
- 失败／取消会尝试 writer.abort。新建文件可能留下 0-byte 或其他未完成文件，错误信息给出文件名，需人工检查。为防其他程序替换文件后的误删，不按文件名自动删除。
- 下载中不要刷新、关闭所在播放标签页、撤回权限或休眠。beforeunload 提示不保证能拦截所有异常退出；无断点续传，重试生成新文件名。

## HLS 与存储设计

- 从正常播放的 Resource Timing 查找 `playlist_advance.m3u8`，不硬编码签名、token 或 CDN 地址；主清单按高度精确选择，不静默降级。
- 仅支持 ENDLIST VOD、AVC/AAC MPEG-TS。拒绝直播、fMP4、BYTERANGE、低延迟、discontinuity／GAP、外置音轨、多视角或复杂清单。
- 普通 AES-128 identity 使用正常已授权 fetch 获取密钥、WebCrypto AES-CBC 验证并移除 PKCS#7 padding。显式 IV 为 128 位十六进制；未指定时按 MEDIA-SEQUENCE 加片段序号生成大端 IV。拒绝 SAMPLE-AES、非 identity、DRM 和未知加密。逐个 188-byte TS 包检查同步字节。
- 原生页面 fetch 使用正常 credentials／CORS，不使用 GM_xmlhttpRequest，不伪造请求头绕过限制。动态内容用 textContent，资源 URL 限 HTTPS。
- unsafeWindow 用于页面 fetch／performance／File System Access API，UI 在脚本沙箱创建。不同 Tampermonkey／浏览器版本的桥接兼容性需实机验证。
- GM grants：getValue、setValue、deleteValue、listValues、unsafeWindow。仅准备页交接保存集数及短期签名资源 URL，不保存 Cookie、密钥、目录 handle 或视频。记录最长保留 6 小时，后续播放页加载清理，不是定时后台清理。旧版任务记录也会按过期时间清理；立即清理可用扩展存储管理，勿分享存储内容。

## 本次验证与局限

运行：

```text
node --check anigamer-download.user.js
node --check test-manager-dom.cjs
node test-manager-dom.cjs
git diff --check
```

测试需要 **jsdom**，仅测试使用，脚本运行不依赖 Node 或 jsdom。可在外部临时目录 `npm install --prefix <temp-directory> --no-audit --no-fund jsdom`，设置 `NODE_PATH=<temp-directory>/node_modules` 后运行；无需把依赖加入仓库。

8 组自动测试覆盖真实 jsdom DOM／事件树的当前页挂载、保留站点节点、重复点击、焦点恢复、滚动样式恢复、Escape cancel 事件、同步 picker 调用、迟到选择结果、可见错误、双队列防护、下载中拒绝／确认关闭、网络 abort 及 beforeunload 清理；并覆盖画质、HLS 拒绝条件、IV、TS、集数选择等纯函数断言。

**诚实范围：**jsdom 不实现浏览器原生 dialog top-layer／inert／焦点约束、File System Access 或网络下载，这些 API 使用明确测试替身。没有进行真实浏览器／Tampermonkey 安装、原生 Escape 键分派、原生目录授权、真实文件 abort、准备 iframe／独立播放页交接、全片或全季音画验证。不会把 DOM 测试称为端到端测试。站点结构、清单格式及浏览器策略变化仍可能导致失败。
