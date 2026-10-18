/**
 * 真机全链路：真实 dsh web 实例 + 真实 composer + 真实 lightbox。
 *
 *  1. 往真 composer 里 paste 两张图（DSH 自己的图片入口）；
 *  2. 点开第一张 → 工具条「标注」→ 钉一颗 → 写评论 → 回车确认；
 *  3. 「插入到输入框」→ 断言：不重复插附件（图本来就在输入框里）、
 *     草稿出现「图像 1 … 已在输入框中」，且带 px / ±容差 / 裁切框；
 *  4. 再点开第二张 → 同样标注 → 断言出现「图像 2」，锚点编号重新从 1 开始；
 *  5. 断言附件仍是浏览器里的原图对象（钉只存在于屏幕上，没烧进图）。
 *
 * 用法：node test/real-flow.mjs "http://127.0.0.1:PORT/?token=..."
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof WebSocket !== 'function') {
  console.error('需要 Node ≥ 22（内置 WebSocket）才能跑这套 CDP 测试；当前 ' + process.version);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (!target) {
  console.error('用法: node test/real-flow.mjs http://127.0.0.1:PORT/?token=...');
  process.exit(2);
}
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) {
  console.error('找不到 Chrome');
  process.exit(2);
}
const imageA = readFileSync(join(here, 'image.b64'), 'utf8').trim();
const imageB = readFileSync(join(here, 'image-b.b64'), 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pin-real-flow-'));
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1500,950',
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    'about:blank'
  ],
  { stdio: 'ignore' }
);

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });

const waitFile = (path, timeoutMs) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      if (existsSync(path)) {
        const text = readFileSync(path, 'utf8').trim();
        if (text) return resolve(text);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('devtools timeout'));
      setTimeout(poll, 50);
    })();
  });

let exitCode = 1;
try {
  const [port] = (await waitFile(join(dir, 'DevToolsActivePort'), 15000)).split('\n');
  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {
      /* retry */
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
  const consoleErrors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const text = (message.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (text.toLowerCase().includes('pin-comment')) consoleErrors.push(text);
    }
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out?.exceptionDetails) {
      throw new Error(out.exceptionDetails.text + ' ' + (out.exceptionDetails.exception?.description || ''));
    }
    return out?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: target });
  await sleep(2500);
  await send('Page.navigate', { url: target });
  await sleep(6000);

  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await evaluate(
      '!!(window.__dshImagePinComment && window.__dshImagePinComment.version && document.querySelector("[data-composer-input]"))'
    );
    if (ready) break;
    await sleep(200);
  }
  check('真实实例里 composer 与插件都在', ready);

  const pasteImage = async (b64, name) => {
    await evaluate(`(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], ${JSON.stringify(name)}, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const editor = document.querySelector('[data-composer-input]');
      editor.focus();
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
      return true;
    })()`);
  };

  const thumbCount = () => evaluate('document.querySelectorAll("[data-composer-card] img").length');

  await pasteImage(imageA, 'shot-a.png');
  await sleep(600);
  await pasteImage(imageB, 'shot-b.png');
  let thumbs = 0;
  for (let i = 0; i < 60; i++) {
    thumbs = await thumbCount();
    if (thumbs >= 2) break;
    await sleep(250);
  }
  check('两张图都进了 composer 草稿', thumbs >= 2, '缩略图 ' + thumbs);

  /** 打开第 index 张缩略图 → 标注一个点 → 插入 */
  const annotateThumb = async (index, fx, fy, note) => {
    await evaluate(`(() => {
      const img = document.querySelectorAll('[data-composer-card] img')[${index}];
      img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    let opened = false;
    for (let i = 0; i < 60; i++) {
      opened = await evaluate('!!document.querySelector(".dpc-bar")');
      if (opened) break;
      await sleep(200);
    }
    const info = await evaluate(`(() => {
      const canvas = document.querySelector('.dpc-canvas');
      const dialog = document.querySelector('[data-dpc-root]').parentElement;
      const img = dialog.querySelector('img');
      const rect = img.getBoundingClientRect();
      document.querySelector('.dpc-bar .dpc-btn').click();
      const at = (fx, fy) => ({
        clientX: rect.left + rect.width * fx,
        clientY: rect.top + rect.height * fy,
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true
      });
      canvas.dispatchEvent(new PointerEvent('pointerdown', at(${fx}, ${fy})));
      canvas.dispatchEvent(new PointerEvent('pointerup', at(${fx}, ${fy})));
      const pop = document.querySelector('.dpc-pop');
      const ta = pop && pop.querySelector('textarea');
      const focused = !!ta && document.activeElement === ta;
      if (ta) {
        ta.value = ${JSON.stringify(note)};
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      }
      const state = window.__dshImagePinComment.annotators[0].state;
      return { opened: ${opened}, focused, pins: state.pins.length, natural: state.natural };
    })()`);
    await evaluate('document.querySelector(".dpc-primary").click(); true');
    for (let i = 0; i < 80; i++) {
      if (await evaluate('!document.querySelector(".dpc-bar")')) break;
      await sleep(200);
    }
    await sleep(400);
    return info;
  };

  const draft = () => evaluate('(document.querySelector("[data-composer-input]") || {}).innerText || ""');

  const first = await annotateThumb(0, 0.4, 0.5, '真机：把这里的文案改短一点');
  check('第一张图：落钉 + 评论框聚焦', first.opened && first.focused && first.pins === 1, JSON.stringify(first));

  let text = '';
  for (let i = 0; i < 60; i++) {
    text = String(await draft());
    if (text.includes('图像 1')) break;
    await sleep(250);
  }
  check('第一张图出现「图像 1 … 已在输入框中」', /图像 1（1200×800）锚点 1 处，已在输入框中/.test(text), text.slice(0, 120));
  check('第一张图：坐标带 px / 容差 / 裁切框',
    /px 480,400 \| ±13px \| 裁切 \d+,\d+,\d+,\d+/.test(text), text.slice(0, 260));
  check('第一张图：备注跟着锚点', text.includes('真机：把这里的文案改短一点'));
  check('第一张图：没有重复插附件', (await thumbCount()) === 2, '缩略图 ' + (await thumbCount()));

  const second = await annotateThumb(1, 0.5, 0.5, '真机：第二张图的标题要加粗');
  check('第二张图：落钉成功', second.opened && second.pins === 1, JSON.stringify(second));

  for (let i = 0; i < 60; i++) {
    text = String(await draft());
    if (text.includes('图像 2')) break;
    await sleep(250);
  }
  check('第二张图独立编号为「图像 2」', /图像 2（900×600）锚点 1 处/.test(text), text.slice(-220));
  check('第二张图的锚点编号从 1 重新开始', /图像 2（900×600）[\s\S]*?1\. \(x: 50\.0%, y: 50\.0%/.test(text), text.slice(-220));
  check('第一张图的块仍然在', text.includes('图像 1（1200×800）'));
  check('两张图仍然是 2 个附件（都是原图）', (await thumbCount()) === 2, '缩略图 ' + (await thumbCount()));

  const scheme = await evaluate(`(() => {
    const img = document.querySelectorAll('[data-composer-card] img')[0];
    const src = img.currentSrc || img.src;
    return src.slice(0, 5);
  })()`);
  check('附件仍是浏览器内的原图对象（blob:）', String(scheme) === 'blob:', scheme);
  check('真机：无插件报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  for (const item of results) {
    console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? `  [${item.detail}]` : ''}`);
  }
  const failed = results.filter((item) => !item.pass);
  console.log(failed.length === 0 ? '\n真机全链路通过 ✅' : `\n${failed.length} 项未通过 ❌`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error('真机全链路失败：', error.message);
  for (const item of results) console.log(`${item.pass ? '✓' : '✗'} ${item.name} [${item.detail}]`);
  exitCode = 1;
} finally {
  try {
    child.kill('SIGKILL');
  } catch {
    /* 忽略 */
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(exitCode);
}
