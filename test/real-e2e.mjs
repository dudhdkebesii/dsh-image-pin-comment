/**
 * 真实 DSH Web 实例里的集成检查：把插件塞进真正的 index.html，
 * 确认 client bundle 加载、locale/theme 服务可用、lightbox 观察器挂载、
 * 图钉与评论气泡在真实外壳里工作。
 *
 * 用法：node real-e2e.mjs <baseUrl 或带 token 的 URL>
 */
const target = process.argv[2];
if (!target) {
  console.error('用法: node real-e2e.mjs http://127.0.0.1:PORT/?token=...');
  process.exit(2);
}

if (typeof WebSocket !== 'function') {
  console.error('需要 Node ≥ 22（内置 WebSocket）才能跑这套 CDP 测试；当前 ' + process.version);
  process.exit(2);
}

const { spawn } = await import('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(chrome)) {
  console.error('找不到 Chrome');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profileDir = mkdtempSync(join(tmpdir(), 'pin-real-e2e-'));
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1400,900',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank'
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
      if (Date.now() - started > timeoutMs) return reject(new Error('devtools timeout'));
      setTimeout(poll, 50);
    })();
  });
}

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });

let code = 1;
try {
  const [port] = (await waitFile(join(profileDir, 'DevToolsActivePort'), 15000)).split('\n');
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
  const errors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      errors.push((message.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out?.exceptionDetails) throw new Error(out.exceptionDetails.text + ' ' + (out.exceptionDetails.exception?.description || ''));
    return out?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  // token 走 cookie：先访问一次带 token 的地址
  await send('Page.navigate', { url: target });
  await sleep(1500);
  await send('Page.navigate', { url: target });
  await sleep(4000);

  let mounted = false;
  for (let i = 0; i < 120; i++) {
    mounted = await evaluate('!!(window.__dshImagePinComment && window.__dshImagePinComment.version)');
    if (mounted) break;
    await sleep(250);
  }
  const boot = await evaluate(`(() => {
    const b = window.__DSH_BOOT__;
    const entry = b && b.entries ? b.entries.find((e) => e.id === 'dsh-image-pin-comment') : null;
    return { hasBoot: !!b, entry: entry ? { id: entry.id, url: entry.url } : null, version: window.__dshImagePinComment && window.__dshImagePinComment.version };
  })()`);
  check('真实 DSH 里加载了 client bundle', mounted, JSON.stringify(boot));
  check('boot 清单里有 dsh-image-pin-comment', !!(boot && boot.entry), boot && boot.entry && boot.entry.url);

  // 造一个和 ImageLightbox 同形的预览（真实外壳里没有会话时无法自己弹预览）
  const injected = await evaluate(`(() => {
    const png = 'data:image/png;base64,${readFileSync('/tmp/fixture-image.b64', 'utf8').trim()}';
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.id = 'e2e-lb';
    dialog.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;z-index:999;background:rgba(10,12,18,.6)';
    const mask = document.createElement('div');
    mask.setAttribute('aria-hidden', 'true');
    dialog.appendChild(mask);
    const img = document.createElement('img');
    img.src = png;
    img.style.cssText = 'width:600px;height:400px;object-fit:contain;border-radius:12px;background:#fff';
    dialog.appendChild(img);
    const close = document.createElement('button');
    close.textContent = 'x';
    close.style.cssText = 'position:absolute;top:16px;right:16px;width:32px;height:32px;border-radius:999px;border:0';
    dialog.appendChild(close);
    document.body.appendChild(dialog);
    return true;
  })()`);
  check('注入了一个 ImageLightbox 形状的预览', injected === true);

  let attached = false;
  for (let i = 0; i < 60; i++) {
    attached = await evaluate('!!(window.__dshImagePinComment.annotators && window.__dshImagePinComment.annotators.length === 1)');
    if (attached) break;
    await sleep(150);
  }
  check('观察器在真实外壳里挂上了预览', attached);

  const ui = await evaluate(`(() => {
    const bar = document.querySelector('.dpc-bar');
    const btn = bar ? bar.querySelector('.dpc-btn') : null;
    const css = getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-primary').trim();
    return {
      bar: !!bar,
      label: btn ? btn.textContent : null,
      primary: document.querySelector('.dpc-primary') ? document.querySelector('.dpc-primary').textContent : null,
      themeToken: css.length > 0
    };
  })()`);
  check('工具条渲染在预览上', ui.bar);
  check('工具条用中文文案（跟随 DSH locale）', ui.label === '标注' && String(ui.primary).indexOf('插入到输入框') >= 0, JSON.stringify(ui));
  check('主题 token 可用（--dsw-*）', ui.themeToken);

  // 钉一颗图钉 + 写评论
  const pinFlow = await evaluate(`(() => {
    const canvas = document.querySelector('.dpc-canvas');
    const img = document.querySelector('#e2e-lb img');
    const rect = img.getBoundingClientRect();
    document.querySelector('.dpc-bar .dpc-btn').click();
    const opts = (fx, fy) => ({
      clientX: rect.left + rect.width * fx,
      clientY: rect.top + rect.height * fy,
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true
    });
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts(0.25, 0.3)));
    canvas.dispatchEvent(new PointerEvent('pointerup', opts(0.25, 0.3)));
    const pop = document.querySelector('.dpc-pop');
    const ta = pop ? pop.querySelector('textarea') : null;
    const opened = !!pop && pop.style.display === 'flex' && !!ta;
    if (ta) {
      ta.value = '真实外壳里的第一条评论';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }
    const state = window.__dshImagePinComment.annotators[0].state;
    return {
      opened,
      pins: state.pins.length,
      note: state.pins[0] ? state.pins[0].note : null,
      popHidden: document.querySelector('.dpc-pop').style.display === 'none',
      count: document.querySelector('.dpc-count').textContent,
      x: state.pins[0] ? ((state.pins[0].x / state.natural.w) * 100).toFixed(1) : null,
      y: state.pins[0] ? ((state.pins[0].y / state.natural.h) * 100).toFixed(1) : null
    };
  })()`);
  check('真实外壳里：点图片落钉并弹出评论框', pinFlow.opened, JSON.stringify(pinFlow));
  check('真实外壳里：回车确认备注且气泡收起', pinFlow.pins === 1 && pinFlow.note === '真实外壳里的第一条评论' && pinFlow.popHidden);
  check('真实外壳里：计数与坐标正确', pinFlow.count === '1 处' && pinFlow.x === '25.0' && pinFlow.y === '30.0', JSON.stringify(pinFlow));

  const realErrors = errors.filter((text) => String(text).toLowerCase().includes('pin-comment'));
  check('没有插件相关报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  const failed = results.filter((item) => !item.pass);
  for (const item of results) {
    console.log(`${item.pass ? '✓' : '✗'} ${item.name}${item.detail ? `  [${item.detail}]` : ''}`);
  }
  console.log(failed.length === 0 ? '\n真实实例检查全部通过 ✅' : `\n${failed.length} 项未通过 ❌`);
  code = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error('集成检查失败：', error.message);
  code = 1;
} finally {
  try {
    child.kill('SIGKILL');
  } catch {
    /* 忽略 */
  }
  rmSync(profileDir, { recursive: true, force: true });
  process.exit(code);
}
