'use strict';
// Dependency-free isolated DOM regression. No site, network, media or crypto calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, 'anigamer-download.user.js'), 'utf8');
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
async function run(code, options = {}) {
  let failOnce = !!options.renderFailure;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.style = {}; this.text = ''; }
    append(...items) { for (const item of items) this.appendChild(item); }
    appendChild(item) { item.parentNode = this; this.children.push(item); return item; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(x => x.textContent).join('\n'); }
    addEventListener() {}
  }
  const document = {
    documentElement: options.noRoot ? null : new Element('html'), readyState: 'loading',
    createElement(tag) {
      if (failOnce && tag === 'style') { failOnce = false; throw Error('synthetic render failure'); }
      return new Element(tag);
    },
    appendChild(root) { assert.equal(this.documentElement, null); this.documentElement = root; return root; },
    replaceChild(root, old) {
      if (!old) throw TypeError('oldChild is null');
      assert.equal(old, this.documentElement); this.documentElement = root;
    },
    addEventListener() { throw Error('manager must not wait for DOMContentLoaded'); }
  };
  let reads = 0, stops = 0;
  const alerts = [], errors = [];
  const window = {
    stop() { stops++; if (options.stopRemovesRoot) document.documentElement = null; if (options.stopFailure) throw Error('synthetic stop failure'); },
    addEventListener() {}, alert(message) { alerts.push(message); }
  };
  const task = { created: Date.now(), title: 'Synthetic UI fixture', currentSN: '1', episodes: [{ sn: '1', label: '1' }] };
  const context = {
    URL, URLSearchParams, document, window,
    location: { href: `https://example.invalid/animeVideo.php?sn=1&agdManager=${options.invalidID ? 'invalid' : id}` },
    console: { error(...args) { errors.push(args); } },
    setTimeout(callback) { queueMicrotask(callback); },
    GM: { async getValue() { reads++; if (options.storageFailure) throw Error('synthetic storage failure'); return options.missingTask || reads <= (options.delayedReads || 0) ? undefined : task; } }
  };
  let thrown;
  try { vm.runInNewContext(code, context, { timeout: 1000 }); } catch (error) { thrown = error; }
  for (let i = 0; i < 2000; i++) await Promise.resolve();
  return { thrown, text: document.documentElement?.textContent || '', reads, stops, alerts, errors };
}
(async () => {
  if (process.argv.includes('--baseline')) {
    const baseline = execFileSync('git', ['-C', __dirname, 'show', 'HEAD:anigamer-download.user.js'], { encoding: 'utf8' });
    for (const options of [{ noRoot: true }, { stopRemovesRoot: true }, { noRoot: true, invalidID: true }]) {
      const result = await run(baseline, options);
      assert.ok(result.thrown, 'baseline must reproduce an uncaught startup exception');
      console.log(`BASELINE reproduced ${JSON.stringify(options)}: ${result.thrown.message}`);
    }
  }
  const cases = [
    ['existing root', {}, '就緒'],
    ['missing root / no DOMContentLoaded', { noRoot: true }, '就緒'],
    ['stop removes root', { stopRemovesRoot: true }, '就緒'],
    ['invalid ID without root', { noRoot: true, invalidID: true }, '管理器識別碼不合法'],
    ['storage rejects', { storageFailure: true }, '管理器啟動失敗：synthetic storage failure'],
    ['render throws', { renderFailure: true }, '管理器啟動失敗：synthetic render failure'],
    ['stop throws', { stopFailure: true }, '管理器啟動失敗：synthetic stop failure'],
    ['task handoff delayed', { delayedReads: 3 }, '就緒'],
    ['task never arrives', { missingTask: true }, '任務不存在／已逾期']
  ];
  for (const [name, options, expected] of cases) {
    const result = await run(source, options);
    assert.equal(result.thrown, undefined, name);
    assert.ok(result.text.includes(expected), `${name}: ${result.text}`);
    assert.equal(result.stops, 1, name);
    if (options.invalidID || options.renderFailure || options.stopFailure) assert.equal(result.reads, 0, name);
    if (options.missingTask) assert.equal(result.reads, 100, name);
    console.log(`PASS ${name}`);
  }
  console.log(`${cases.length} isolated DOM tests passed. Mock does not establish real browser parser or userscript sandbox behavior.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
