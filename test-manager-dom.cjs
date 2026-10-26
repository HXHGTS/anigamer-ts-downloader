'use strict';
// Real jsdom tree/events, with explicit browser API doubles. No live site/media.
// Install jsdom externally (e.g. under your temp root) and set NODE_PATH, or
// install it locally without committing node_modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, 'anigamer-download.user.js'), 'utf8');
const tick = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
const button = (root, text) => [...root.querySelectorAll('button')].find(x => x.textContent.includes(text));
let count = 0;
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }
async function fixture(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body style="overflow:scroll"><h1>Fixture</h1><video></video><div class="season"><a data-ani-video-sn="1">1</a><a data-ani-video-sn="2">2</a></div></body></html>', { url: 'https://example.invalid/animeVideo.php?sn=1', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  let fetches = 0, aborted = 0, prompts = 0, picks = 0, unloads = 0, writerAborts = 0;
  let releaseAbort;
  w.TextDecoder = TextDecoder;
  const directory = { name: 'Synthetic folder', async getFileHandle(_name, config) {
    if (!config?.create) throw new w.DOMException('missing', 'NotFoundError');
    return { async createWritable() { return { async abort() {
      writerAborts++;
      if (options.delayWriterAbort) await new Promise(resolve => { releaseAbort = resolve; });
    } }; } };
  } };
  let allowClose = true, releasePicker;
  // jsdom does not implement native modal top-layer/inert/focus trapping.
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.alert = message => { throw Error(`Unexpected alert: ${message}`); };
  w.confirm = () => { prompts++; return allowClose; };
  w.stop = w.open = () => { throw Error('must not stop playback/open a manager tab'); };
  const add = w.addEventListener.bind(w), remove = w.removeEventListener.bind(w);
  w.addEventListener = (type, ...args) => { if (type === 'beforeunload') unloads++; return add(type, ...args); };
  w.removeEventListener = (type, ...args) => { if (type === 'beforeunload') unloads--; return remove(type, ...args); };
  w.performance.getEntriesByType = () => [{ name: 'https://example.invalid/playlist_advance.m3u8' }];
  w.fetch = (_url, { signal }) => {
    fetches++;
    if (options.delayWriterAbort && fetches < 3) {
      const text = fetches === 1 ? '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\na.m3u8' : '#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST';
      let sent = false;
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/vnd.apple.mpegurl' }, body: { getReader: () => ({ async read() { if (sent) return { done: true }; sent = true; return { done: false, value: new TextEncoder().encode(text) }; }, async cancel() {}, releaseLock() {} }) } });
    }
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new w.DOMException('cancel', 'AbortError')); }, { once: true }));
  };
  w.showDirectoryPicker = () => {
    picks++;
    if (options.pickerError) throw Error('synthetic picker failure');
    if (options.pendingPicker) return new Promise(resolve => { releasePicker = resolve; });
    return Promise.resolve(directory);
  };
  w.GM = { async listValues() { return []; }, async getValue() { throw Error('no task handoff reads'); }, async setValue() { throw Error('no task handoff writes'); } };
  w.eval(source);
  await tick();
  const launcher = button(d, '下載 TS');
  assert.ok(launcher);
  launcher.focus(); launcher.click();
  const host = [...d.body.children].find(x => x.shadowRoot), root = host.shadowRoot, dialog = root.querySelector('dialog');
  assert.ok(dialog.open);
  return { dom, w, d, launcher, host, root, dialog, close: () => button(root, '關閉').click(), choose: () => button(root, '選擇輸出').click(), start: () => button(root, '開始').click(), allow: value => { allowClose = value; }, release: () => releasePicker({ name: 'Late folder' }), releaseAbort: () => releaseAbort(), stats: () => ({ fetches, aborted, prompts, picks, unloads, writerAborts }) };
}
(async () => {
  await test('actual DOM: current-page modal, unchanged site, duplicate launch focuses existing dialog', async () => {
    const f = await fixture();
    const video = f.d.querySelector('video'), body = f.d.body, html = f.d.documentElement;
    f.launcher.click();
    assert.equal([...body.children].filter(x => x.shadowRoot).length, 1);
    assert.equal(f.root.activeElement, f.dialog);
    assert.equal(f.d.querySelector('video'), video);
    assert.equal(f.d.body, body); assert.equal(f.d.documentElement, html);
    assert.equal(body.style.overflow, 'hidden');
    assert.ok(f.root.querySelector('style').textContent.includes('overflow:auto'));
    f.close(); await tick();
    assert.equal(f.host.isConnected, false); assert.equal(f.d.activeElement, f.launcher);
    assert.equal(f.stats().unloads, 0); assert.equal(body.style.overflow, 'scroll');
    f.launcher.click(); assert.ok([...body.children].some(x => x.shadowRoot));
    f.dom.window.close();
  });
  await test('Escape cancel event closes idle modal and restores focus', async () => {
    const f = await fixture();
    const event = new f.w.Event('cancel', { cancelable: true });
    f.dialog.dispatchEvent(event); await tick();
    assert.equal(event.defaultPrevented, true); assert.equal(f.host.isConnected, false);
    assert.equal(f.d.activeElement, f.launcher); f.dom.window.close();
  });
  await test('picker called synchronously; pending selection cannot resurrect closed UI', async () => {
    const f = await fixture({ pendingPicker: true });
    f.choose(); assert.equal(f.stats().picks, 1); f.close(); await tick();
    f.release(); await tick(); assert.equal(f.host.isConnected, false);
    assert.equal(f.stats().unloads, 0); f.dom.window.close();
  });
  await test('picker errors and missing folder are visible', async () => {
    const f = await fixture({ pickerError: true });
    f.start(); assert.match(f.dialog.textContent, /請先點選資料夾/);
    f.choose(); await tick(); assert.match(f.dialog.textContent, /synthetic picker failure/);
    f.close(); await tick(); f.dom.window.close();
  });
  await test('single queue; busy close declines then confirms, aborts network and waits cleanup', async () => {
    const f = await fixture();
    f.choose(); await tick(); f.start(); f.start(); await tick();
    assert.equal(f.stats().fetches, 1);
    f.allow(false); f.close(); await tick();
    assert.equal(f.host.isConnected, true); assert.equal(f.stats().aborted, 0);
    f.allow(true); f.dialog.dispatchEvent(new f.w.Event('cancel', { cancelable: true }));
    await tick();
    assert.equal(f.stats().aborted, 1); assert.equal(f.stats().prompts, 2);
    assert.equal(f.host.isConnected, false); assert.equal(f.stats().unloads, 0);
    f.dom.window.close();
  });
  await test('close waits for writer abort before removing modal', async () => {
    const f = await fixture({ delayWriterAbort: true });
    f.choose(); await tick(); f.start(); await tick();
    assert.equal(f.stats().fetches, 3, f.dialog.textContent);
    f.close(); await tick();
    assert.equal(f.stats().writerAborts, 1); assert.equal(f.host.isConnected, true);
    f.releaseAbort(); await tick();
    assert.equal(f.host.isConnected, false); assert.equal(f.stats().unloads, 0);
    f.dom.window.close();
  });
  await test('invalid task initialization remains visible and closable', async () => {
    const f = await fixture(); f.close(); await tick();
    f.d.querySelector('.season').remove(); f.w.alert = message => { assert.match(message, /集數清單/); };
    f.launcher.click(); assert.equal([...f.d.body.children].some(x => x.shadowRoot), false);
    f.dom.window.close();
  });
  await test('pure functions: variants, playlist restrictions, TS and episode selection', async () => {
    let api;
    vm.runInNewContext(source, { window: {}, location: { href: 'https://example.invalid/?sn=1' }, URL, __AGD_TEST_EXPORT__: value => { api = value; } });
    const base = 'https://example.invalid/master.m3u8';
    assert.equal(api.master('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\na.m3u8', base, 720).url, 'https://example.invalid/a.m3u8');
    assert.throws(() => api.master('#EXTM3U', base, 1080));
    const vod = '#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST';
    assert.equal(api.media(vod, base).length, 1);
    for (const prefix of ['#EXT-X-MAP:URI="x"', '#EXT-X-BYTERANGE:10', '#EXT-X-DISCONTINUITY', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="x"', '#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="drm",URI="x"']) assert.throws(() => api.media(vod.replace('#EXTINF', prefix + '\n#EXTINF'), base));
    assert.throws(() => api.media(vod.replace('#EXT-X-ENDLIST', ''), base));
    assert.equal(api.sequenceIV(256n)[14], 1); assert.equal(api.sequenceIV(256n)[15], 0);
    assert.equal(api.explicitIV('0x' + '01'.repeat(16))[0], 1);
    const bytes = new Uint8Array(188); bytes[0] = 0x47; api.tsValid(bytes);
    bytes[0] = 0; assert.throws(() => api.tsValid(bytes));
    const episodes = [{ sn: '1', label: '1' }, { sn: '2', label: 'SP' }];
    assert.equal(api.selectEpisodes(episodes, 'specified', '1', '1').length, 1);
    assert.throws(() => api.selectEpisodes(episodes, 'specified', '2', '1'));
  });
  console.log(`${count} groups passed. jsdom uses modal/picker/fetch doubles: not a browser/Tampermonkey or full-download E2E test.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
