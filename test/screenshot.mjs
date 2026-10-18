/**
 * 用 fixture 拍一张 docs/preview.png（README 用）。
 * 不参与测试断言，纯粹是为了有个看得见的预览图。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) {
  console.error('找不到 Chrome，跳过截图');
  process.exit(0);
}

const imageA = readFileSync(join(here, 'image.b64'), 'utf8').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profileDir = mkdtempSync(join(tmpdir(), 'pin-comment-shot-'));
const url = pathToFileURL(join(here, 'fixture.html')).href + '?auto=0';

const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--allow-file-access-from-files',
    '--hide-scrollbars',
    '--window-size=1280,860',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    url
  ],
  { stdio: 'ignore' }
);

function waitFile(path, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      if (existsSync(path)) {
        const text = readFileSync(path, 'utf8').trim();
        if (text) return resolve(text);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('devtools port timeout'));
      setTimeout(poll, 50);
    })();
  });
}

try {
  const [port] = (await waitFile(join(profileDir, 'DevToolsActivePort'), 15000)).split('\n');
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    } catch {
      /* 还没起来 */
    }
    if (!page) await sleep(100);
  }
  if (!page) throw new Error('no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;

  await send('Runtime.enable');
  for (let i = 0; i < 80; i++) {
    if (await evaluate('!!window.__fixtureApplied')) break;
    await sleep(100);
  }

  /* 造一个和 ImageLightbox 同形的预览 */
  await evaluate(`(() => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.id = 'shot-lb';
    dialog.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;z-index:10;' +
      'background:rgba(12,14,20,.66)';
    const mask = document.createElement('div');
    mask.setAttribute('aria-hidden', 'true');
    dialog.appendChild(mask);
    const img = document.createElement('img');
    img.id = 'shot';
    img.src = 'data:image/png;base64,${imageA}';
    img.style.cssText = 'position:relative;width:640px;height:427px;object-fit:contain;border-radius:12px;background:#fff';
    dialog.appendChild(img);
    const close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = 'position:absolute;top:18px;right:18px;width:32px;height:32px;border-radius:999px;' +
      'border:0;background:#fff;font-size:16px';
    dialog.appendChild(close);
    document.body.appendChild(dialog);
    return true;
  })()`);

  for (let i = 0; i < 60; i++) {
    if (await evaluate('!!document.querySelector(".dpc-bar")')) break;
    await sleep(120);
  }

  /* 钉两颗，第二颗的气泡留着打开，再拍图 */
  await evaluate(`(() => {
    const canvas = document.querySelector('.dpc-canvas');
    const img = document.getElementById('shot');
    const rect = img.getBoundingClientRect();
    document.querySelector('.dpc-bar .dpc-btn').click();
    const tap = (fx, fy) => {
      const opts = {
        clientX: rect.left + rect.width * fx,
        clientY: rect.top + rect.height * fy,
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
      canvas.dispatchEvent(new PointerEvent('pointerup', opts));
    };
    const typeAndEnter = (text) => {
      const ta = document.querySelector('.dpc-pop textarea');
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
    tap(0.28, 0.26);
    typeAndEnter('把这个按钮往左挪 8px');
    tap(0.62, 0.6);
    return true;
  })()`);
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'preview.png'), Buffer.from(shot.data, 'base64'));
  console.log('docs/preview.png written');
} finally {
  try {
    child.kill('SIGKILL');
  } catch {
    /* 忽略 */
  }
  rmSync(profileDir, { recursive: true, force: true });
}
