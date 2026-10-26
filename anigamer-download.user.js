// ==UserScript==
// @name         動畫瘋 已授權 HLS → TS 管理器
// @namespace    local.anigamer.authorized-download
// @version      1.0.0
// @description  在獨立同站頁面保存正常播放已授權的 VOD MPEG-TS；不繞過廣告、登入或 DRM。
// @match        https://ani.gamer.com.tw/animeVideo.php*
// @run-at       document-start
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';
  const page = typeof unsafeWindow === 'object' ? unsafeWindow : window;
  const params = new URL(location.href).searchParams;
  const managerID = params.get('agdManager');
  const PREFIX = 'agd.v1.';
  const MAX_AGE = 6 * 60 * 60 * 1000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fail = message => { throw new Error(message); };
  const cancelled = signal => { if (signal?.aborted) throw new DOMException('已取消', 'AbortError'); };
  const snOK = sn => /^\d{1,12}$/.test(String(sn));
  const idOK = id => /^[a-f0-9-]{20,64}$/.test(id || '');
  function webURL(value, base) {
    const u = new URL(value, base);
    if (u.protocol !== 'https:' || u.username || u.password) fail('拒絕非 HTTPS 或含帳密的資源網址');
    return u.href;
  }
  function resourceURLs(win) {
    try {
      return win.performance.getEntriesByType('resource').map(x => x.name)
        .filter(x => /\/playlist_advance\.m3u8(?:\?|$)/i.test(x));
    } catch { return []; }
  }
  function cleanName(value) {
    return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || '動畫';
  }
  function attrs(line) {
    const out = Object.create(null);
    const text = line.slice(line.indexOf(':') + 1);
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)(?:,|$)/g;
    let m, end = 0;
    while ((m = re.exec(text))) {
      if (m.index !== end || Object.hasOwn(out, m[1])) fail('不合法或重複的 HLS 屬性');
      out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
      end = re.lastIndex;
    }
    if (end !== text.length) fail('無法解析 HLS 屬性');
    return out;
  }
  function linesOf(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') fail('回應不是 HLS 清單（可能登入失效或錯誤頁）');
    return lines;
  }
  function master(text, base, height) {
    const lines = linesOf(text), variants = [];
    if (lines.some(x => /^#EXT-X-(SESSION-KEY|DEFINE|CONTENT-STEERING|I-FRAME-STREAM-INF)/.test(x))) fail('不支援此主清單功能');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-MEDIA:')) {
        const a = attrs(lines[i]);
        if (a.TYPE === 'AUDIO' || a.TYPE === 'VIDEO') fail('不支援分離音軌／多視角，請勿下載無聲或錯誤音軌');
      }
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const a = attrs(lines[i]), next = lines[++i];
      if (!next || next.startsWith('#')) fail('主清單缺少 variant URL');
      if (a.AUDIO || a.VIDEO) fail('不支援複雜／外置音軌');
      const match = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
      if (!match) fail('主清單缺少可驗證的解析度');
      if (a.CODECS && !/^(?:avc1\.[a-f\d]+|mp4a\.40\.\d+)(?:,(?:avc1\.[a-f\d]+|mp4a\.40\.\d+))*$/i.test(a.CODECS)) fail('僅支援 AVC/AAC MPEG-TS variant');
      variants.push({ height: Number(match[2]), bandwidth: Number(a.BANDWIDTH) || 0, url: webURL(next, base) });
    }
    const found = variants.filter(x => x.height === Number(height)).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!found) fail(`找不到精確 ${height}p 畫質；可用：${[...new Set(variants.map(x => x.height))].join(', ') || '無'}`);
    return found;
  }
  function explicitIV(text) {
    if (!/^0x[\da-f]{32}$/i.test(text)) fail('AES IV 必須是 128 位十六進位數');
    return Uint8Array.from(text.slice(2).match(/../g), x => parseInt(x, 16));
  }
  function sequenceIV(sequence) {
    let n = BigInt(sequence);
    if (n < 0n || n >= (1n << 128n)) fail('AES 序號超出範圍');
    const iv = new Uint8Array(16);
    for (let i = 15; i >= 0; i--) { iv[i] = Number(n & 255n); n >>= 8n; }
    return iv;
  }
  function media(text, base) {
    const lines = linesOf(text), segments = [];
    if (!lines.includes('#EXT-X-ENDLIST')) fail('拒絕直播／尚未結束的清單：必須有 ENDLIST');
    let sequence = 0n, key = null, duration = null, ended = false, hasSequence = false;
    for (const line of lines.slice(1)) {
      if (ended) fail('ENDLIST 後存在額外內容');
      if (/^#EXT-X-(MAP|BYTERANGE|PART|PRELOAD-HINT|SKIP|DISCONTINUITY|GAP|DEFINE|I-FRAMES-ONLY|STREAM-INF|SESSION-KEY|BITRATE)/.test(line)) fail('不支援 fMP4、位元範圍、間斷、低延遲或其他複雜清單');
      if (line.startsWith('#EXT-X-PLAYLIST-TYPE:') && line !== '#EXT-X-PLAYLIST-TYPE:VOD') fail('僅支援 VOD');
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const s = line.split(':')[1];
        if (hasSequence || segments.length || !/^\d+$/.test(s)) fail('不合法的 MEDIA-SEQUENCE');
        sequence = BigInt(s); hasSequence = true;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const a = attrs(line);
        if (a.KEYFORMAT && a.KEYFORMAT !== 'identity') fail('拒絕 DRM／非 identity KEYFORMAT');
        if (a.KEYFORMATVERSIONS && a.KEYFORMATVERSIONS !== '1') fail('不支援 KEYFORMATVERSIONS');
        if (a.METHOD === 'NONE') key = null;
        else {
          if (a.METHOD !== 'AES-128') fail('拒絕 SAMPLE-AES／DRM 或未知加密方式');
          if (!a.URI) fail('AES KEY 缺少 URI');
          key = { url: webURL(a.URI, base), iv: a.IV ? explicitIV(a.IV) : null };
        }
      } else if (line.startsWith('#EXTINF:')) {
        if (duration !== null) fail('EXTINF 缺少分段 URI');
        duration = Number(line.slice(8).split(',')[0]);
        if (!Number.isFinite(duration) || duration <= 0) fail('分段長度不合法');
      } else if (line === '#EXT-X-ENDLIST') {
        if (duration !== null) fail('最後分段缺少 URI');
        ended = true;
      } else if (!line.startsWith('#')) {
        if (duration === null) fail('分段缺少 EXTINF');
        segments.push({ url: webURL(line, base), sequence: sequence + BigInt(segments.length), key, duration });
        duration = null;
      } else if (!/^#(?:EXTM3U|EXT-X-(VERSION|TARGETDURATION|INDEPENDENT-SEGMENTS|ALLOW-CACHE|PROGRAM-DATE-TIME|START):?)/.test(line)) {
        if (line.startsWith('#EXT')) fail(`不支援的 HLS 標記：${line.split(':')[0]}`);
      }
    }
    if (!segments.length) fail('空白媒體清單');
    return segments;
  }
  function tsValid(bytes) {
    if (bytes.length < 188 || bytes.length % 188 !== 0) fail('分段不是完整 MPEG-TS（拒絕 HTML、fMP4 或未知資料）');
    for (let i = 0; i < bytes.length; i += 188) if (bytes[i] !== 0x47) fail('MPEG-TS 同步位元組驗證失敗');
    return bytes;
  }
  function selectEpisodes(episodes, mode, specification, currentSN) {
    if (mode === 'current') return episodes.filter(x => x.sn === currentSN);
    if (mode === 'season') return [...episodes];
    const requested = new Set();
    if (!specification.trim()) fail('請輸入指定集數');
    for (const part of specification.split(/[,，]/)) {
      const m = /^\s*(\d{1,4})(?:\s*-\s*(\d{1,4}))?\s*$/.exec(part);
      if (!m) fail('集數格式應為 1-3,5；特殊集請改用下方勾選');
      const a = Number(m[1]), b = Number(m[2] || m[1]);
      if (a > b || b - a > 1000) fail('集數範圍不合法');
      for (let n = a; n <= b; n++) requested.add(n);
    }
    const selected = episodes.filter(x => /^\d+$/.test(x.label) && requested.has(Number(x.label)));
    for (const n of requested) if (!selected.some(x => Number(x.label) === n)) fail(`頁面上沒有純數字第 ${n} 集；特殊標籤請手動勾選`);
    return selected;
  }

  // Export only in an isolated, explicitly supplied unit-test harness, never on the site.
  if (typeof globalThis.__AGD_TEST_EXPORT__ === 'function') {
    globalThis.__AGD_TEST_EXPORT__({ attrs, master, media, explicitIV, sequenceIV, tsValid, selectEpisodes, cleanName });
    return;
  }

  async function prune() {
    for (const key of await GM.listValues()) {
      if (!key.startsWith(PREFIX)) continue;
      const value = await GM.getValue(key);
      if (!value || !Number.isFinite(value.created) || Date.now() - value.created > MAX_AGE) await GM.deleteValue(key);
    }
  }
  function node(tag, text, parent, properties = {}) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    Object.assign(el, properties);
    parent?.append(el);
    return el;
  }
  function episodeData() {
    const seen = new Set(), episodes = [];
    for (const a of document.querySelectorAll('.season a[data-ani-video-sn]')) {
      const sn = a.dataset.aniVideoSn, label = a.textContent.trim();
      if (!snOK(sn) || seen.has(sn) || !label) continue;
      seen.add(sn); episodes.push({ sn, label });
    }
    const currentSN = params.get('sn');
    if (!snOK(currentSN)) fail('播放頁 sn 不合法');
    if (!seen.has(currentSN)) fail('集數清單尚未載入或未包含本集，請等頁面載入後重試');
    return { title: document.querySelector('h1')?.textContent.trim() || '動畫', currentSN, episodes };
  }
  if (managerID !== null) {
    // Stop before the site's player/ad scripts execute. Never run playback in this branch.
    window.stop();
    if (!idOK(managerID)) { document.documentElement.textContent = '管理器識別碼不合法'; return; }
    const shell = document.createElement('html');
    const head = document.createElement('head'), body = document.createElement('body');
    shell.append(head, body);
    document.replaceChild(shell, document.documentElement);
    node('meta', undefined, head, { name: 'referrer', content: 'strict-origin-when-cross-origin' });
    node('title', '動畫瘋 TS 下載管理', head);
    node('style', 'body{font:16px system-ui;max-width:1050px;margin:30px auto;padding:0 18px;color:#222;background:#fafafa}button,input,select{font:inherit;margin:5px;padding:7px}button{cursor:pointer}fieldset{margin:16px 0}label{display:inline-block;margin:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:12px}iframe{width:100%;height:560px;border:1px solid #aaa}progress{width:100%}a{color:#0758a0}', head);
    manager(body).catch(error => node('p', `管理器啟動失敗：${error.message}`, body));
    return;
  }
  // Normal playback remains unchanged, including ads and authorization.
  async function playback() {
    await prune().catch(() => {});
    const prepareID = params.get('agdPrepare');
    if (idOK(prepareID)) {
      const pendingKey = PREFIX + 'prepare.' + prepareID;
      const pending = await GM.getValue(pendingKey);
      if (pending && Date.now() - pending.created < MAX_AGE && pending.sn === params.get('sn')) {
        const timer = setInterval(async () => {
          const urls = resourceURLs(page);
          if (!urls.length) return;
          clearInterval(timer);
          await GM.setValue(PREFIX + 'ready.' + prepareID, { created: Date.now(), sn: pending.sn, url: urls.at(-1) });
        }, 1500);
        setTimeout(() => clearInterval(timer), 10 * 60 * 1000);
      }
    }
    if (window.top !== window.self) return;
    const button = node('button', '下載 TS（獨立管理頁）', document.body);
    Object.assign(button.style, { position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483647' });
    button.addEventListener('click', async () => {
      let data;
      try { data = episodeData(); } catch (error) { alert(error.message); return; }
      const id = crypto.randomUUID(), url = new URL(location.href);
      url.search = new URLSearchParams({ sn: data.currentSN, agdManager: id });
      // Open synchronously in the user's click; manager polls storage to resolve the write race.
      const tab = page.open(url.href, '_blank');
      if (!tab) { alert('新頁被阻擋：請允許此網站彈出視窗後重試'); return; }
      try {
        await GM.setValue(PREFIX + 'task.' + id, { ...data, created: Date.now(), masterURL: resourceURLs(page).at(-1) || null });
      } catch { alert('任務寫入失敗，請關閉空白管理頁重試'); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => playback().catch(console.error), { once: true });
  else playback().catch(console.error);

  async function request(url, signal, kind = 'bytes') {
    webURL(url);
    for (let attempt = 0; attempt < 3; attempt++) {
      cancelled(signal);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        // Native fetch with normal browser credentials/CORS; no Cookie extraction or GM cross-origin bypass.
        const response = await page.fetch(url, { credentials: 'include', signal: controller.signal, cache: 'no-store' });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}；登入／授權過期請重新正常播放準備`);
          error.noRetry = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
          throw error;
        }
        if (response.status === 206) fail('不支援部分內容回應');
        const type = response.headers.get('content-type') || '';
        if (/text\/html|application\/json/i.test(type)) fail('資源回傳錯誤頁而非媒體');
        const maximum = kind === 'text' ? 4 * 1024 * 1024 : kind === 'key' ? 16 : 64 * 1024 * 1024;
        const reader = response.body?.getReader();
        if (!reader) fail('瀏覽器無法串流讀取回應');
        const chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maximum) fail('單一資源超出安全大小上限');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const result = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        return { value: kind === 'text' ? new TextDecoder().decode(result) : result, url: response.url || url };
      } catch (error) {
        cancelled(signal);
        if (attempt === 2 || error.noRetry) throw new Error(error.name === 'AbortError' ? '請求逾時（30 秒，已有限重試）' : error.message);
        await sleep(500 * (attempt + 1));
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      }
    }
  }
  async function manager(body) {
    node('h1', '動畫瘋：已授權 TS 下載管理', body);
    node('p', '只保存您有權取得、正常播放已授權的資源。不繞廣告、付費、地區限制或 DRM。跨集通常需逐集正常操作，並非無人值守下載器。', body);
    const status = node('pre', '等待播放頁交付任務…', body);
    let task;
    for (let i = 0; i < 100; i++) {
      task = await GM.getValue(PREFIX + 'task.' + managerID);
      if (task) break;
      await sleep(100);
    }
    if (!task || !Number.isFinite(task.created) || Date.now() - task.created > MAX_AGE) fail('任務不存在／已逾期（6 小時），請回播放頁重新建立');
    if (!snOK(task.currentSN) || !Array.isArray(task.episodes) || task.episodes.length > 1000 || !task.episodes.length || task.episodes.some(e => !snOK(e.sn) || typeof e.label !== 'string') || new Set(task.episodes.map(e => e.sn)).size !== task.episodes.length || !task.episodes.some(e => e.sn === task.currentSN)) fail('任務資料不合法');
    node('h2', task.title, body);
    const controls = node('fieldset', undefined, body);
    node('legend', '下載選項', controls);
    const qualityLabel = node('label', '畫質', controls), quality = node('select', undefined, qualityLabel);
    for (const h of [360, 540, 720, 1080]) node('option', `${h}p`, quality, { value: String(h), selected: h === 720 });
    const mode = node('select', undefined, controls);
    for (const [value, text] of [['current', '本集'], ['season', '頁面本季全部'], ['specified', '指定數字集數'], ['checked', '手動勾選（含特殊集）']]) node('option', text, mode, { value });
    const specification = node('input', undefined, controls, { placeholder: '1-3,5', 'ariaLabel': '指定集數' });
    const checks = node('div', undefined, controls), boxes = [];
    for (const e of task.episodes) {
      const label = node('label', undefined, checks);
      const box = node('input', undefined, label, { type: 'checkbox', checked: e.sn === task.currentSN });
      node('span', `${e.label}（${e.sn}）`, label); boxes.push({ e, box });
    }
    node('p', '「本季」僅指目前頁面列出的集數；數字指定只匹配純數字標籤。SP／OVA／小數集數等請選手動勾選。不會猜測或掃描其他季。', controls);
    const choose = node('button', '選擇輸出資料夾', controls), start = node('button', '開始下載', controls);
    const cancel = node('button', '取消本次佇列', body, { disabled: true });
    const progress = node('progress', undefined, body, { max: 1, value: 0 });
    const preparation = node('section', undefined, body);
    let directory = null, controller = null, busy = false;
    status.textContent = '就緒。請先選資料夾，再開始；若本集尚未正常播放，仍需準備授權。';
    choose.onclick = async () => {
      try {
        if (typeof page.showDirectoryPicker !== 'function') fail('需桌面 Chrome／Edge 的 File System Access API；無法在此瀏覽器保存');
        directory = await page.showDirectoryPicker({ mode: 'readwrite', id: 'agd-download' });
        status.textContent = `已選資料夾：${directory.name}（handle 只保存在此頁記憶體）`;
      } catch (error) { status.textContent = `選資料夾未完成：${error.message}`; }
    };
    cancel.onclick = () => controller?.abort();
    const beforeUnload = event => { if (busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    start.onclick = async () => {
      if (busy) return;
      if (!directory) { status.textContent = '請先點選資料夾；瀏覽器權限必須來自使用者點擊。'; return; }
      let queue;
      try {
        queue = mode.value === 'checked' ? boxes.filter(x => x.box.checked).map(x => x.e) : selectEpisodes(task.episodes, mode.value, specification.value, task.currentSN);
        if (!queue.length) fail('未選擇任何集數');
      } catch (error) { status.textContent = error.message; return; }
      busy = true; controls.disabled = true; cancel.disabled = false;
      controller = new AbortController();
      let completed = 0;
      try {
        for (const episode of queue) {
          cancelled(controller.signal);
          const prefix = `[${completed + 1}/${queue.length}] 第 ${episode.label} 集`;
          status.textContent = `${prefix}：準備正常播放資源…`;
          // A captured URL is used only once. Expired URLs fail openly; never mint tokens.
          const masterURL = episode.sn === task.currentSN && task.masterURL ? task.masterURL : await prepare(episode, controller.signal, preparation, status);
          if (episode.sn === task.currentSN) task.masterURL = null;
          const m = await request(masterURL, controller.signal, 'text');
          const variant = master(m.value, m.url, quality.value);
          const p = await request(variant.url, controller.signal, 'text');
          const segments = media(p.value, p.url);
          const name = await download(directory, `${cleanName(task.title)}_第${cleanName(episode.label)}集_${variant.height}p`, segments, controller.signal, (i, bytes) => {
            progress.max = segments.length; progress.value = i;
            status.textContent = `${prefix}：${i}/${segments.length} 段，${(bytes / 1048576).toFixed(1)} MiB\n請勿關閉或重新整理管理頁。`;
          });
          completed++;
          node('p', `完成：${name}`, body);
        }
        status.textContent = `下載完成：${completed} 集。請使用 VLC 等播放器檢查音畫完整性。`;
      } catch (error) {
        status.textContent = `${controller.signal.aborted ? '已取消' : '下載停止'}，已完成 ${completed} 集。\n${error.message}\n不會自動跳過失敗集。授權失效時，請回原播放頁正常播放後重新建立管理任務。失敗檔可能留下空檔，請檢查輸出資料夾。`;
      } finally {
        preparation.replaceChildren(); busy = false; controls.disabled = false; cancel.disabled = true; controller = null;
      }
    };
  }
  async function prepare(episode, signal, container, status) {
    const id = crypto.randomUUID(), pendingKey = PREFIX + 'prepare.' + id, readyKey = PREFIX + 'ready.' + id;
    await GM.setValue(pendingKey, { created: Date.now(), sn: episode.sn });
    const url = new URL('/animeVideo.php', location.origin);
    url.search = new URLSearchParams({ sn: episode.sn, agdPrepare: id });
    container.replaceChildren();
    node('h3', `準備第 ${episode.label} 集（最長 10 分鐘）`, container);
    node('p', '請在下方正常完成登入、播放及廣告操作。此框架不自動點擊、不設定 autoplay、不移除廣告。若框架被網站／瀏覽器限制，點下列連結在獨立播放頁正常操作，保持管理頁開啟；腳本會交付資源。偵測到正常主清單後會移除框架停止額外播放。', container);
    node('a', '在獨立分頁正常播放／準備本集', container, { href: url.href, target: '_blank', rel: 'noopener' });
    const frame = node('iframe', undefined, container, { src: url.href, title: `正常播放第 ${episode.label} 集` });
    status.textContent = `等待第 ${episode.label} 集正常播放授權。請操作框架或上方獨立播放頁連結；不是無人值守。`;
    try {
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        cancelled(signal);
        // Some sandboxes expose only the wrapper performance; the child script/GM path is a fallback.
        const urls = resourceURLs(frame.contentWindow);
        if (urls.length) return webURL(urls.at(-1));
        const ready = await GM.getValue(readyKey);
        if (ready && ready.sn === episode.sn && Date.now() - ready.created < MAX_AGE) return webURL(ready.url);
        await sleep(1000);
      }
      fail('10 分鐘內未取得正常主清單；可能框架被限制、廣告未完成、未登入或無播放權限。請用獨立播放頁正常準備再重試。');
    } finally {
      frame.remove(); container.replaceChildren();
      await Promise.allSettled([GM.deleteValue(pendingKey), GM.deleteValue(readyKey)]);
    }
  }
  async function uniqueFile(directory, stem) {
    // Directory API has no atomic create-if-absent; UUID + existence probe avoids normal collisions.
    for (let attempt = 0; attempt < 5; attempt++) {
      const name = `${stem}_${crypto.randomUUID()}.ts`;
      try { await directory.getFileHandle(name); continue; }
      catch (error) { if (error.name !== 'NotFoundError') throw error; }
      return { name, handle: await directory.getFileHandle(name, { create: true }) };
    }
    fail('無法建立唯一檔名');
  }
  async function download(directory, stem, segments, signal, update) {
    cancelled(signal);
    const { name, handle } = await uniqueFile(directory, stem);
    let writer = null, lastKeyURL = null, lastKey = null, written = 0;
    try {
      writer = await handle.createWritable({ keepExistingData: false, mode: 'exclusive' });
      for (let i = 0; i < segments.length; i++) {
        cancelled(signal);
        const segment = segments[i];
        let bytes = (await request(segment.url, signal)).value;
        if (segment.key) {
          if (segment.key.url !== lastKeyURL) {
            const raw = (await request(segment.key.url, signal, 'key')).value;
            if (raw.byteLength !== 16) fail('AES-128 key 長度不是 16 bytes');
            lastKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
            lastKeyURL = segment.key.url;
          }
          if (!bytes.length || bytes.length % 16) fail('AES-CBC 密文長度不合法');
          // WebCrypto validates/removes PKCS#7 padding. Never remove padding again.
          bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: segment.key.iv || sequenceIV(segment.sequence) }, lastKey, bytes));
        } else { lastKeyURL = null; lastKey = null; }
        tsValid(bytes); cancelled(signal);
        await writer.write(bytes);
        written += bytes.byteLength; update(i + 1, written);
      }
      cancelled(signal);
      await writer.close(); writer = null;
      return name;
    } catch (error) {
      if (writer) await writer.abort().catch(() => {});
      // Never removeEntry by name here: another program could have replaced that entry.
      throw new Error(`${signal.aborted ? '使用者取消' : error.message}\n未完成檔名：${name}。已嘗試 abort，可能留下 0-byte 檔；請自行確認並刪除，不會自動按檔名刪除。`);
    }
  }
})();
