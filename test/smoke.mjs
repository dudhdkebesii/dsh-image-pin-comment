/**
 * 离线冒烟测试：把 test/fixture.html 放进真实 Chrome（headless）里跑一遍完整流程，
 * 通过 CDP 读回页面自测结果。
 *
 * 覆盖：
 *   - lightbox 挂载、工具条、图钉落点、评论气泡、回车确认（不发送）、多图钉；
 *   - 坐标百分比换算、草稿合并、附件 PNG 投递、导出分辨率与图钉像素。
 *
 * 两种投递档位各跑一遍：
 *   bridge=1 → 走宿主 setDraft 动作（假宿主提供 inputActions）
 *   bridge=0 → 走合成 paste 兜底
 *
 * 用法：node test/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome；设置 CHROME_PATH 指向可执行文件');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim();
      if (text.length > 0) return text;
    }
    await sleep(50);
  }
  throw new Error('等待 DevToolsActivePort 超时');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.exceptions = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params?.exceptionDetails?.text ?? 'exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.exceptions.push(
          (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
        );
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return result?.result?.value;
  }
}

async function runScenario(bridge) {
  const chrome = findChrome();
  const profileDir = mkdtempSync(join(tmpdir(), 'pin-comment-chrome-'));
  const url = pathToFileURL(join(here, 'fixture.html')).href + (bridge ? '' : '?bridge=0');

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--window-size=1280,900',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      url
    ],
    { stdio: 'ignore' }
  );

  let cdp;
  try {
    const [port] = (await waitForFile(join(profileDir, 'DevToolsActivePort'), 15000)).split('\n');
    let targets = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        targets = await response.json();
        if (targets.some((target) => target.type === 'page' && target.webSocketDebuggerUrl)) break;
      } catch {
        /* 浏览器还没起来 */
      }
      await sleep(100);
    }
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page) throw new Error('没有可用的页面 target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');

    let result = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      result = await cdp.evaluate('window.__testResult ? window.__testResult : null');
      if (result) break;
      await sleep(100);
    }
    if (!result) {
      const bodyText = await cdp.evaluate('document.body.innerText.slice(-1200)');
      throw new Error('页面没有给出结果。日志尾部：\n' + String(bodyText));
    }
    result.exceptions = cdp.exceptions;
    return result;
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
    rmSync(profileDir, { recursive: true, force: true });
  }
}

let failures = 0;
for (const bridge of [true, false]) {
  const label = bridge ? 'setDraft 档位' : 'paste 兜底档位';
  process.stdout.write(`\n=== ${label} ===\n`);
  let result;
  try {
    result = await runScenario(bridge);
  } catch (error) {
    failures++;
    console.log(`✗ 场景执行失败：${error.message}`);
    continue;
  }
  for (const check of result.checks) {
    console.log(`${check.pass ? '✓' : '✗'} ${check.name}${check.detail ? `  [${check.detail}]` : ''}`);
  }
  if (result.exceptions && result.exceptions.length > 0) {
    console.log('页面报错：', result.exceptions.slice(0, 5).join(' | '));
  }
  console.log(`结果：${result.passed}/${result.total} 通过`);
  if (!result.ok) failures++;
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n有 ${failures} 个档位未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);
