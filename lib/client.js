/**
 * dsh-image-pin-comment — 浏览器半区（client half）。
 *
 * 在 DSH Web 的图片预览（ImageLightbox：body 级 portal 的
 * `div[role="dialog"][aria-modal="true"] > img`）上加「图钉 + 评论」：
 *
 *   1. 预览打开后，底部出现工具条：「标注」；
 *   2. 点「标注」进入钉图钉模式，图片上点一下落一个编号图钉，
 *      图钉下方立刻弹出评论框，打字回车即保存；
 *   3. 「插入到输入框」把「原图 + 编号图钉」合成为原分辨率 PNG 放进输入框，
 *      同时把一段带坐标的说明写进草稿：
 *
 *        我在图片上标注了 2 处（坐标为锚点占图片宽高的百分比，原图 1909×1231）：
 *        1. (x: 62.4%, y: 18.1%) 这个按钮往左挪 8px
 *        2. (x: 12.0%, y: 80.5%) 这里文字重叠了
 *
 *      模型既看得到图上的钉，也算得出钉在哪 —— 光标位置不再靠猜。
 *
 * 设计取舍（沿用 dsh-image-annotate 的「三个不」）：
 *   - 不注册 slot、不接管原有 lightbox：只在预览 DOM 上叠一层，
 *     预览关闭即整体消失，宿主 React 重渲染也改不坏；
 *   - 不 import 任何 @deepseek-ai/* 包：整包就是一个
 *     `window.__ModuleLoader__.load` 工厂，手写、无构建步骤；
 *   - 所有图钉都以「原图像素坐标」存储，叠加显示 / 导出 / 窗口缩放永远一致。
 *
 * 文本投递优先走宿主公开动作 inputActions.setDraft（通过一个只读的
 * `conversation.input.overlay` 桥接组件拿到），拿不到时退回「合成 paste 事件」，
 * 再退回 execCommand，最后退回复制到剪贴板。
 */
window.__ModuleLoader__.load({
	id: 'dsh-image-pin-comment',
	factory: (require) => {
		'use strict';

		var module = { exports: {} };
		var exports = module.exports;

		/* ==================================================================
		 * 常量与基础工具
		 * ================================================================== */

		var PKG_ID = 'dsh-image-pin-comment';
		var LOG_PREFIX = '[image-pin-comment]';
		var BRIDGE_KEY = '__dshImagePinCommentBridge';

		/** 调试开关：localStorage['dsh-image-pin-comment.debug'] = '1' */
		function debugEnabled() {
			try {
				return localStorage.getItem(PKG_ID + '.debug') === '1';
			} catch (error) {
				return false;
			}
		}

		function log() {
			if (!debugEnabled()) return;
			var args = Array.prototype.slice.call(arguments);
			args.unshift(LOG_PREFIX);
			console.log.apply(console, args);
		}

		function warn() {
			var args = Array.prototype.slice.call(arguments);
			args.unshift(LOG_PREFIX);
			console.warn.apply(console, args);
		}

		function clamp(value, min, max) {
			return Math.max(min, Math.min(max, value));
		}

		function stamp() {
			var d = new Date();
			function pad(n) {
				return n < 10 ? '0' + n : String(n);
			}
			return (
				String(d.getFullYear()) +
				pad(d.getMonth() + 1) +
				pad(d.getDate()) +
				'-' +
				pad(d.getHours()) +
				pad(d.getMinutes()) +
				pad(d.getSeconds())
			);
		}

		/** 用 {name} 占位符做一次朴素替换（不引模板引擎）。 */
		function fmt(template, vars) {
			return String(template).replace(/\{(\w+)\}/g, function (all, key) {
				return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : all;
			});
		}

		var EXTENSION_BY_TYPE = {
			'image/png': 'png',
			'image/jpeg': 'jpg',
			'image/jpg': 'jpg',
			'image/webp': 'webp',
			'image/gif': 'gif',
			'image/avif': 'avif',
			'image/bmp': 'bmp',
			'image/svg+xml': 'svg'
		};

		function extensionFor(type) {
			return EXTENSION_BY_TYPE[String(type || '').toLowerCase()] || 'png';
		}

		function svgIcon(pathData) {
			var NS = 'http://www.w3.org/2000/svg';
			var svg = document.createElementNS(NS, 'svg');
			svg.setAttribute('viewBox', '0 0 24 24');
			svg.setAttribute('width', '16');
			svg.setAttribute('height', '16');
			svg.setAttribute('fill', 'none');
			svg.setAttribute('stroke', 'currentColor');
			svg.setAttribute('stroke-width', '1.7');
			svg.setAttribute('stroke-linecap', 'round');
			svg.setAttribute('stroke-linejoin', 'round');
			svg.setAttribute('aria-hidden', 'true');
			var path = document.createElementNS(NS, 'path');
			path.setAttribute('d', pathData);
			svg.appendChild(path);
			return svg;
		}

		/* ==================================================================
		 * 文案（中英双语，跟随界面语言）
		 * ================================================================== */

		var DICT = {
			zh: {
				annotate: '标注',
				annotateTitle: '在图片上钉图钉并写评论',
				annotateOn: '完成',
				annotateOnTitle: '退出标注模式',
				count: '{n} 处',
				clear: '清空',
				clearTitle: '清空全部图钉',
				insert: '插入到输入框',
				insertTitle: '把原图与坐标说明放进输入框',
				exit: '退出标注',
				empty: '先在图片上点一下钉个图钉吧',
				working: '正在整理标注…',
				attached: '图像 {i} 已加入输入框，写点问题后按 Enter 发送',
				uncertain: '已复制到剪贴板，按 Ctrl+V 贴进输入框',
				textFailed: '坐标说明没能自动写入，已复制到剪贴板',
				exportFailed: '读不到原图，已改为插入像素副本',
				noEditor: '没找到输入框：请先打开一个会话再标注',
				downloaded: '原图已下载（坐标说明见剪贴板）',
				placeholder: '添加评论…',
				hint: 'Enter 保存 · Esc 取消',
				remove: '删除',
				sourceFile: '，附件 {file}',
				sourceAttached: '，已在输入框中',
				blockHeader:
					'【图片标注】图像 {i}（{w}×{h}）锚点 {n} 处{source}。锚点不画在图上，按下面的坐标定位：' +
					'百分比 = 锚点占图片宽高的比例，px = 原图像素坐标，裁切 = 以锚点为中心的方形区域（x0,y0,x1,y1）。',
				blockLine: '{i}. (x: {x}%, y: {y}% | px {px},{py} | ±{tol}px | 裁切 {box})'
			},
			en: {
				annotate: 'Annotate',
				annotateTitle: 'Drop pins on the image and write a note per pin',
				annotateOn: 'Done',
				annotateOnTitle: 'Leave annotation mode',
				count: '{n} pin(s)',
				clear: 'Clear',
				clearTitle: 'Remove every pin',
				insert: 'Add to composer',
				insertTitle: 'Put the original image and its coordinate list into the composer',
				exit: 'Exit annotation',
				empty: 'Click the image to drop a pin first',
				working: 'Collecting the anchors…',
				attached: 'Image {i} added to the composer — type your question and press Enter',
				uncertain: 'Copied to clipboard — press Ctrl+V in the composer',
				textFailed: 'Could not insert the coordinate list — copied to clipboard',
				exportFailed: 'Could not read the original — inserted a pixel copy instead',
				noEditor: 'No composer found — open a session first',
				downloaded: 'Original downloaded (coordinate list is on the clipboard)',
				placeholder: 'Add a comment…',
				hint: 'Enter to save · Esc to cancel',
				remove: 'Delete',
				sourceFile: ', attachment {file}',
				sourceAttached: ', already in the composer',
				blockHeader:
					'[Image annotation] Image {i} ({w}×{h}), {n} anchor(s){source}. The anchors are not drawn on the image — ' +
					'locate them with the coordinates below: percent = anchor position relative to width/height, ' +
					'px = pixel coordinates in the original, crop = square region centred on the anchor (x0,y0,x1,y1).',
				blockLine: '{i}. (x: {x}%, y: {y}% | px {px},{py} | ±{tol}px | crop {box})'
			}
		};

		function detectLocale(ctx) {
			try {
				var locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
				var snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined;
				var id = snapshot && (snapshot.id || snapshot.locale || snapshot.language);
				if (typeof id === 'string' && id.length > 0) {
					return id.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
				}
			} catch (error) {
				/* 忽略：退回 navigator.language */
			}
			var nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
			return nav.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
		}

		function makeTranslator(ctx) {
			var lang = detectLocale(ctx);
			var table = DICT[lang] || DICT.en;
			return function t(key, vars) {
				var value = table[key];
				if (value === undefined) value = key;
				return vars === undefined ? value : fmt(value, vars);
			};
		}

		/* ==================================================================
		 * 样式（只注入一次；全部走 dsh 主题 token，取不到时退回同样的近似值）
		 * ================================================================== */

		var STYLE_TAG_ID = PKG_ID + '/styles.css';

		function injectStyles() {
			if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') !== null) return;
			var style = document.createElement('style');
			style.dataset.plugin = PKG_ID;
			style.dataset.pluginCss = STYLE_TAG_ID;
			style.textContent = [
				'[data-dpc-root]{position:fixed;inset:0;pointer-events:none;z-index:2147482000;' +
					'font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",' +
					'"Hiragino Sans GB","Microsoft YaHei",sans-serif);font-size:14px;line-height:22px;' +
					'color:var(--dsw-alias-label-primary,#0f1115);-webkit-font-smoothing:antialiased}',

				/* 叠加画布：只有进入标注模式才吃指针事件 */
				'.dpc-canvas{position:fixed;pointer-events:none;touch-action:none;' +
					'border-radius:var(--dsw-radius-lg,12px)}',
				'.dpc-canvas[data-dpc-active="1"]{pointer-events:auto;cursor:crosshair}',

				/* 底部工具条 = 原生菜单浮层的材质与圆角 */
				'.dpc-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:20px;pointer-events:auto;display:flex;' +
					'align-items:center;gap:2px;padding:4px;border-radius:var(--dsw-radius-lg,12px);' +
					'background:var(--dsw-menu-surface-fill,var(--dsw-specific-input-major,#fff));' +
					'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));' +
					'color:var(--dsw-alias-label-primary,#0f1115);box-shadow:var(--dsw-elevation-panel);' +
					/* left 已经占了 50%：不给 width:max-content 的话，盒子只按「left 右侧剩余空间」
					   收缩，稍宽就换行 */
					'width:max-content;max-width:min(96vw,880px);flex-wrap:wrap;justify-content:center}',

				'.dpc-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:30px;padding:0 9px;' +
					'border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;flex:none;' +
					'color:var(--dsw-alias-label-secondary,#545557);font-size:13px;line-height:20px;cursor:pointer;' +
					'font-family:inherit;transition:background .12s ease,color .12s ease}',
				'.dpc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#2631480f);' +
					'color:var(--dsw-alias-label-primary,#0f1115)}',
				'.dpc-btn[data-dpc-on="1"]{background:var(--dsw-alias-button-tool-bar-fill,#ebeef2);' +
					'color:var(--dsw-alias-label-primary,#0f1115)}',
				'.dpc-btn[data-dpc-on="1"]:hover{background:var(--dsw-alias-button-tool-bar-hover,#e1e5ee)}',
				'.dpc-btn:disabled{opacity:.4;cursor:not-allowed}',
				'.dpc-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ' +
					'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:-2px}',

				'.dpc-sep{width:1px;height:16px;margin:0 3px;flex:none;background:var(--dsw-alias-border-l3,#0000001f)}',

				'.dpc-count{flex:none;padding:0 6px;font-size:13px;line-height:20px;' +
					'color:var(--dsw-alias-label-secondary,#8b8f98);white-space:nowrap}',

				'.dpc-primary{display:inline-flex;align-items:center;gap:4px;height:30px;margin-left:3px;padding:0 12px;' +
					'border:0;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-button-primary-fill,#4176e6);' +
					'color:var(--dsw-alias-label-primary-foreground,#fff);font-size:13px;line-height:20px;font-weight:500;' +
					'cursor:pointer;white-space:nowrap;font-family:inherit}',
				'.dpc-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#5686fe)}',
				'.dpc-primary:disabled{opacity:.45;cursor:not-allowed}',
				'.dpc-primary[data-dpc-busy="1"]{opacity:.6;cursor:progress}',

				/* 提示条沿用原生 Toast 的面板 */
				'.dpc-toast{position:fixed;top:40px;left:50%;transform:translateX(-50%);pointer-events:none;' +
					'width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;text-align:center;' +
					'border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-toast-bg,#2b3244);' +
					'color:var(--dsw-alias-toast-label,#fff);font-size:14px;line-height:22px;box-shadow:var(--dsw-shadow-lv3)}',

				/* 图钉下的评论气泡 */
				'.dpc-pop{position:fixed;pointer-events:auto;width:280px;padding:8px;display:flex;' +
					'flex-direction:column;gap:6px;border-radius:var(--dsw-radius-lg,12px);' +
					'background:var(--dsw-specific-input-major,#fff);box-shadow:var(--dsw-elevation-panel);' +
					'border:.5px solid var(--dsw-alias-border-l2-darkmode-thin,#0000001a)}',
				'.dpc-pop textarea{width:100%;box-sizing:border-box;min-height:56px;max-height:180px;resize:vertical;' +
					'padding:6px 8px;border:1px solid var(--dsw-alias-border-l3,#0000001f);' +
					'border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);' +
					'color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:13px;line-height:18px;' +
					'outline:none;display:block}',
				'.dpc-pop textarea:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6)}',
				'.dpc-pop textarea::placeholder{color:var(--dsw-alias-label-secondary,#9aa0aa)}',
				'.dpc-pop-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
					'font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,#8b8f98)}',
				'.dpc-del{padding:0;border:0;background:transparent;color:var(--dsw-alias-state-error-primary,#e5484d);' +
					'font-size:12px;line-height:16px;cursor:pointer;font-family:inherit}',
				'.dpc-del:hover{text-decoration:underline}',

				'@media (prefers-reduced-motion:reduce){.dpc-btn{transition:none}}'
			].join('\n');
			document.head.appendChild(style);
		}

		/* ==================================================================
		 * 颜色（canvas 只能吃具体值，所以从主题 token 里现取）
		 * ================================================================== */

		var PIN_COLOR_TOKEN = { token: '--dsw-static-red-500', fallback: '#e5484d' };
		var colorCache = {};

		function tokenColor(entry) {
			if (Object.prototype.hasOwnProperty.call(colorCache, entry.token)) return colorCache[entry.token];
			var value = '';
			try {
				value = (getComputedStyle(document.body).getPropertyValue(entry.token) || '').trim();
			} catch (error) {
				value = '';
			}
			if (value.length === 0) value = entry.fallback;
			colorCache[entry.token] = value;
			return value;
		}

		/* ==================================================================
		 * 图钉绘制：坐标全部是「原图像素」；只画在屏幕叠加层，永不进导出图
		 * ================================================================== */

		/** 图钉半径按图片短边取比例，手机截图和 4K 截图看起来一样大。 */
		function pinRadius(natural) {
			return clamp(Math.min(natural.w, natural.h) * 0.016, 9, 44);
		}

		/**
		 * 画成「空心环 + 中心留空的十字准星 + 右上角编号徽标」：
		 * 环与准星之间那一小块保持完全透明，被指的字符不会被钉挡住 ——
		 * 抠细节的时候（「这是什么字」）全靠这一点。
		 */
		function paintPins(g, pins, natural, hoveredId) {
			if (pins.length === 0 || natural.w < 2) return;
			var r = pinRadius(natural);
			var fill = tokenColor(PIN_COLOR_TOKEN);
			var family = '-apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
			for (var i = 0; i < pins.length; i++) {
				var pin = pins[i];
				var hovered = hoveredId !== undefined && pin.id === hoveredId;

				/* 白色打底描边：任何底图上都看得见 */
				g.beginPath();
				g.arc(pin.x, pin.y, r, 0, Math.PI * 2);
				g.lineWidth = r * (hovered ? 0.62 : 0.5);
				g.strokeStyle = 'rgba(255,255,255,0.95)';
				g.stroke();

				g.beginPath();
				g.arc(pin.x, pin.y, r, 0, Math.PI * 2);
				g.lineWidth = r * (hovered ? 0.38 : 0.3);
				g.strokeStyle = fill;
				g.stroke();

				/* 十字准星：中心留空，只画 r*0.55 → r*1.25 的四段 */
				g.beginPath();
				g.moveTo(pin.x - r * 1.25, pin.y);
				g.lineTo(pin.x - r * 0.55, pin.y);
				g.moveTo(pin.x + r * 0.55, pin.y);
				g.lineTo(pin.x + r * 1.25, pin.y);
				g.moveTo(pin.x, pin.y - r * 1.25);
				g.lineTo(pin.x, pin.y - r * 0.55);
				g.moveTo(pin.x, pin.y + r * 0.55);
				g.lineTo(pin.x, pin.y + r * 1.25);
				g.lineWidth = Math.max(0.8, r * 0.16);
				g.lineCap = 'round';
				g.strokeStyle = fill;
				g.stroke();

				/* 编号徽标：挂在右上，不压锚点 */
				var bx = pin.x + r * 1.55;
				var by = pin.y - r * 1.55;
				var br = r * 0.8;
				g.beginPath();
				g.arc(bx, by, br * 1.16, 0, Math.PI * 2);
				g.fillStyle = 'rgba(255,255,255,0.95)';
				g.fill();
				g.beginPath();
				g.arc(bx, by, br, 0, Math.PI * 2);
				g.fillStyle = fill;
				g.fill();
				g.fillStyle = '#ffffff';
				g.font = '600 ' + (br * 1.3).toFixed(1) + 'px ' + family;
				g.textAlign = 'center';
				g.textBaseline = 'middle';
				g.fillText(String(i + 1), bx, by + br * 0.04);
			}
		}

		/* ==================================================================
		 * 取原图像素：优先 fetch(blob) → ImageBitmap，退回直接绘制 <img>
		 * ================================================================== */

		function loadImageElement(url) {
			return new Promise(function (resolve, reject) {
				var image = new Image();
				image.onload = function () {
					resolve(image);
				};
				image.onerror = function () {
					reject(new Error('image load failed'));
				};
				image.src = url;
			});
		}

		/**
		 * 取得一个可绘制、且不会污染 canvas 的图源。
		 *
		 * lightbox 的 src 可能是 blob:/data:/同源 http(s) 或 dsh 自定义协议；
		 * 直接 drawImage(<img>) 在跨源时会污染画布导致 toBlob 抛 SecurityError，
		 * 所以先尝试 fetch 成 blob 再解码（fetch 走 CORS，失败可捕获）。
		 */
		function loadSource(img) {
			var src = img.currentSrc || img.src;
			var cleanup = [];
			return fetch(src, { credentials: 'include', cache: 'force-cache' })
				.then(function (response) {
					if (!response.ok) throw new Error('HTTP ' + response.status);
					return response.blob();
				})
				.then(function (blob) {
					if (blob.size === 0) throw new Error('empty blob');
					if (typeof createImageBitmap === 'function') {
						return createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(function () {
							var url = URL.createObjectURL(blob);
							cleanup.push(url);
							return loadImageElement(url);
						});
					}
					var objectUrl = URL.createObjectURL(blob);
					cleanup.push(objectUrl);
					return loadImageElement(objectUrl);
				})
				.catch(function (error) {
					log('fetch source failed, falling back to <img>', error);
					return img;
				})
				.then(function (source) {
					return {
						source: source,
						release: function () {
							cleanup.forEach(function (url) {
								try {
									URL.revokeObjectURL(url);
								} catch (ignored) {
									/* 忽略 */
								}
							});
						}
					};
				});
		}

		/* ==================================================================
		 * 输入框投递：图片走 paste → drop → 剪贴板 → 下载；
		 * 文本走 setDraft（宿主动作）→ paste → execCommand → 剪贴板
		 * ================================================================== */

		function composerEditor() {
			/* 输入框就是 Lexical 的 root：`[data-composer-input]` 与
			 * `[data-lexical-editor="true"]` 是同一个 div。优先精确命中前者。 */
			var nodes = document.querySelectorAll(
				'[data-composer-input], [data-lexical-editor="true"], [contenteditable="true"]'
			);
			var best = null;
			var bestScore = -1;
			for (var i = 0; i < nodes.length; i++) {
				var node = nodes[i];
				if (!node.isConnected) continue;
				var rect = node.getBoundingClientRect();
				if (rect.width < 40 || rect.height < 8) continue;
				var score = 0;
				if (node.hasAttribute('data-composer-input')) score += 6;
				if (node.closest('[data-conversation-session]') !== null) score += 2;
				if (node.getAttribute('data-lexical-editor') === 'true') score += 2;
				if (node.getAttribute('role') === 'textbox') score += 1;
				if (score >= bestScore) {
					bestScore = score;
					best = node;
				}
			}
			return best;
		}

		function countBlobImages() {
			var count = 0;
			var images = document.images;
			for (var i = 0; i < images.length; i++) {
				var url = String(images[i].currentSrc || images[i].src || '');
				if (url.indexOf('blob:') === 0) count++;
			}
			return count;
		}

		function waitFor(predicate, timeoutMs) {
			return new Promise(function (resolve) {
				var started = Date.now();
				(function poll() {
					var value;
					try {
						value = predicate();
					} catch (error) {
						value = false;
					}
					if (value) {
						resolve(true);
						return;
					}
					if (Date.now() - started >= timeoutMs) {
						resolve(false);
						return;
					}
					setTimeout(poll, 120);
				})();
			});
		}

		/**
		 * 造一个「带图片文件的 paste 事件」。
		 *
		 * composer 的入口读取 `event.clipboardData.items`（kind === 'file'），
		 * 因此先试真正的 ClipboardEvent；某些实现会静默丢弃 clipboardData
		 * init 成员，那就退回 defineProperty 挂一个同形状的假对象。
		 * 注意：Lexical 会给处理过的事件打 `_lexicalHandled`，所以每次派发
		 * 都必须新建事件，不能复用。
		 */
		function makePasteEvent(file) {
			var dataTransfer = new DataTransfer();
			dataTransfer.items.add(file);
			var event = null;
			try {
				event = new ClipboardEvent('paste', {
					clipboardData: dataTransfer,
					bubbles: true,
					cancelable: true,
					composed: true
				});
				if (!event.clipboardData || event.clipboardData.items.length === 0) event = null;
			} catch (error) {
				event = null;
			}
			if (event === null) {
				event = new Event('paste', { bubbles: true, cancelable: true, composed: true });
				try {
					Object.defineProperty(event, 'clipboardData', {
						value: {
							items: [
								{
									kind: 'file',
									type: file.type,
									getAsFile: function () {
										return file;
									}
								}
							],
							files: [file],
							types: ['Files'],
							getData: function () {
								return '';
							}
						}
					});
				} catch (ignored) {
					/* 忽略：真走到这里只能靠下载兜底 */
				}
			}
			return event;
		}

		/** 造一个「纯文本 paste 事件」，走 composer 自己的粘贴通道。 */
		function makeTextPasteEvent(text) {
			var event = null;
			try {
				var dataTransfer = new DataTransfer();
				dataTransfer.setData('text/plain', text);
				event = new ClipboardEvent('paste', {
					clipboardData: dataTransfer,
					bubbles: true,
					cancelable: true,
					composed: true
				});
				if (!event.clipboardData || event.clipboardData.getData('text/plain') !== text) event = null;
			} catch (error) {
				event = null;
			}
			if (event === null) {
				event = new Event('paste', { bubbles: true, cancelable: true, composed: true });
				try {
					Object.defineProperty(event, 'clipboardData', {
						value: {
							items: [],
							files: [],
							types: ['text/plain'],
							getData: function (type) {
								return type === 'text/plain' || type === 'Text' ? text : '';
							}
						}
					});
				} catch (ignored) {
					/* 忽略 */
				}
			}
			return event;
		}

		function focusEditor(editor) {
			try {
				editor.focus({ preventScroll: true });
			} catch (error) {
				try {
					editor.focus();
				} catch (ignored) {
					/* 忽略 */
				}
			}
		}

		/** 用合成 paste 事件把文件交给 composer 的既有图片入口。返回是否命中编辑器。 */
		function attachViaPaste(file) {
			var editor = composerEditor();
			if (editor === null) return false;
			focusEditor(editor);
			var event = makePasteEvent(file);
			editor.dispatchEvent(event);
			log('paste dispatched; defaultPrevented =', event.defaultPrevented);
			return true;
		}

		/** 退回拖放路径：attachment 的 document 级监听接受 drop。 */
		function attachViaDrop(file) {
			var editor = composerEditor();
			var host = null;
			if (editor !== null) {
				host = editor.closest('form') || editor.parentElement || editor;
			}
			if (host === null) host = document;
			var dataTransfer = new DataTransfer();
			dataTransfer.items.add(file);
			var rect = (editor || host).getBoundingClientRect();
			var clientX = rect.left + Math.max(10, Math.min(rect.width / 2, 60));
			var clientY = rect.top + Math.max(8, Math.min(rect.height / 2, 20));
			var types = ['dragenter', 'dragover', 'drop'];
			for (var i = 0; i < types.length; i++) {
				var event = new DragEvent(types[i], {
					dataTransfer: dataTransfer,
					bubbles: true,
					cancelable: true,
					composed: true,
					clientX: clientX,
					clientY: clientY
				});
				host.dispatchEvent(event);
			}
			log('drop dispatched');
			return true;
		}

		function copyBlobToClipboard(blob) {
			return new Promise(function (resolve) {
				try {
					if (!navigator.clipboard || typeof window.ClipboardItem !== 'function') {
						resolve(false);
						return;
					}
					navigator.clipboard
						.write([new window.ClipboardItem({ 'image/png': blob })])
						.then(function () {
							resolve(true);
						})
						.catch(function (error) {
							log('clipboard write failed', error);
							resolve(false);
						});
				} catch (error) {
					log('clipboard unavailable', error);
					resolve(false);
				}
			});
		}

		function copyTextToClipboard(text) {
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
					navigator.clipboard.writeText(text).catch(function () {
						/* 忽略 */
					});
					return true;
				}
			} catch (error) {
				/* 忽略 */
			}
			return false;
		}

		function downloadBlob(blob, filename) {
			try {
				var url = URL.createObjectURL(blob);
				var link = document.createElement('a');
				link.href = url;
				link.download = filename;
				link.style.display = 'none';
				document.body.appendChild(link);
				link.click();
				link.remove();
				setTimeout(function () {
					try {
						URL.revokeObjectURL(url);
					} catch (ignored) {
						/* 忽略 */
					}
				}, 5000);
			} catch (error) {
				warn('download failed', error);
			}
		}

		function readComposerText(editor) {
			if (editor === null) return '';
			try {
				return String(editor.innerText || editor.textContent || '');
			} catch (error) {
				return '';
			}
		}

		/**
		 * 草稿文本的「空白归一化」索引。
		 *
		 * Lexical 把每段渲染成独立 <p>，innerText 在段之间给出的是 "\n\n"，
		 * 而我们写进去的块用的是单个 "\n" —— 直接 indexOf 会永远匹配不上。
		 * 所以比对时把连续空白压成一个空格，并留住「归一化下标 → 原始下标」
		 * 的映射，好在原始文本上做精确的 splice。
		 */
		function normalizeWithMap(text) {
			var out = '';
			var map = [];
			var lastWasSpace = false;
			for (var i = 0; i < text.length; i++) {
				var ch = text.charAt(i);
				if (/\s/.test(ch)) {
					if (lastWasSpace || out.length === 0) continue;
					out += ' ';
					map.push(i);
					lastWasSpace = true;
				} else {
					out += ch;
					map.push(i);
					lastWasSpace = false;
				}
			}
			if (out.charAt(out.length - 1) === ' ') {
				out = out.slice(0, -1);
				map.pop();
			}
			return { text: out, map: map };
		}

		/** 在原始草稿里定位某块（容忍空白差异），返回 [start, end) 或 null。 */
		function findBlockRange(text, block) {
			if (!text || !block) return null;
			var hay = normalizeWithMap(text);
			var needle = normalizeWithMap(block).text;
			if (needle.length === 0) return null;
			var at = hay.text.indexOf(needle);
			if (at < 0) return null;
			var start = hay.map[at];
			var end = hay.map[at + needle.length - 1] + 1;
			return { start: start, end: end };
		}
		function placeCaret(editor, selectAll) {
			try {
				var range = document.createRange();
				range.selectNodeContents(editor);
				if (!selectAll) range.collapse(false);
				var selection = window.getSelection();
				if (selection !== null) {
					selection.removeAllRanges();
					selection.addRange(range);
				}
			} catch (error) {
				log('caret placement failed', error);
			}
		}

		/**
		 * 把坐标说明写进草稿。
		 *
		 * `replace` 为真时整段替换草稿（同一张图被二次标注，块要就地更新）；
		 * 否则把文本追加到现有草稿后面（用户自己写的问题留在最前面）。
		 *
		 * 一级：宿主公开动作 `inputActions.setDraft`（由 bridge 组件提供），
		 *       它按 \n 拆段落地，换行不会丢；
		 * 二级：合成纯文本 paste，走 composer 自己的粘贴通道；
		 * 三级：execCommand('insertText')；
		 * 都没成 → 复制到剪贴板，让用户自己按 Ctrl+V。
		 */
		function insertTextBlock(text, replace) {
			var bridge = typeof window !== 'undefined' ? window[BRIDGE_KEY] : undefined;
			var actions = bridge && bridge.actions;
			var editor = composerEditor();

			if (actions && typeof actions.setDraft === 'function') {
				try {
					var current = readComposerText(editor);
					var next = text;
					if (!replace && current.trim().length > 0) {
						next = current.replace(/\s+$/, '') + '\n\n' + text;
					}
					actions.setDraft(next);
					log('text inserted via setDraft (replace=' + (replace === true) + ')');
					return Promise.resolve('draft');
				} catch (error) {
					warn('setDraft failed, falling back to paste', error);
				}
			}

			if (editor === null) return Promise.resolve('none');

			focusEditor(editor);
			placeCaret(editor, replace === true);
			var marker = 'x:';
			var event = makeTextPasteEvent(text);
			editor.dispatchEvent(event);
			return waitFor(function () {
				return readComposerText(composerEditor()).indexOf(marker) >= 0;
			}, 600).then(function (pasted) {
				if (pasted) {
					log('text inserted via paste');
					return 'paste';
				}
				try {
					placeCaret(editor, replace === true);
					editor.focus();
					document.execCommand('insertText', false, text);
				} catch (error) {
					warn('execCommand failed', error);
				}
				return waitFor(function () {
					return readComposerText(composerEditor()).indexOf(marker) >= 0;
				}, 600).then(function (inserted) {
					if (inserted) {
						log('text inserted via execCommand');
						return 'exec';
					}
					copyTextToClipboard(text);
					return 'none';
				});
			});
		}

		/** 生成一张图的坐标说明（每张图一块，图内锚点从 1 开始编号）。 */
		function buildImageBlock(index, natural, pins, t, source) {
			var w = Math.max(2, Math.round(natural.w));
			var h = Math.max(2, Math.round(natural.h));
			var tol = Math.round(pinRadius({ w: w, h: h }));
			/* 建议裁切框：以锚点为中心、边长 6 倍容差的方形，并夹在图片内 */
			var half = Math.max(24, tol * 3);
			var lines = [t('blockHeader', { i: index, w: w, h: h, n: pins.length, source: source || '' })];
			for (var i = 0; i < pins.length; i++) {
				var pin = pins[i];
				var px = Math.round(pin.x);
				var py = Math.round(pin.y);
				var box = [
					clamp(px - half, 0, w),
					clamp(py - half, 0, h),
					clamp(px + half, 0, w),
					clamp(py + half, 0, h)
				]
					.map(function (value) {
						return Math.round(value);
					})
					.join(',');
				var head = t('blockLine', {
					i: i + 1,
					x: ((pin.x / natural.w) * 100).toFixed(1),
					y: ((pin.y / natural.h) * 100).toFixed(1),
					px: px,
					py: py,
					tol: tol,
					box: box
				});
				var note = String(pin.note || '').trim();
				lines.push(note.length > 0 ? head + ' ' + note : head);
			}
			return lines.join('\n');
		}

		/* ==================================================================
		 * 一批标注：同一个会话里可以连续标记多张图（图像 1、图像 2…），
		 * 每张图的锚点都从 1 开始编号，编号在各自图的块里独立成立。
		 * 用「上一次写进草稿的块还在不在」来判断这批是否已经结束
		 * （发出去 / 手动清空 → 下一张重新从图像 1 开始）。
		 * ================================================================== */

		/**
		 * 一批标注 = 一条消息里所有被标注过的图。
		 *
		 * entries 按「图片 src」记账：同一张图再次打开标注时，之前钉的锚点会被
		 * 预载回来，编号继续沿用，块就地更新 —— 所以「图像 N 里的编号 1..k」
		 * 永远指同一张图里的同一批锚点，不会因为重复打开而串号。
		 */
		var draftBatch = { sessionKey: null, images: 0, entries: [] };
var lastSessionKey = null;

		function currentSessionKey() {
			var bridge = typeof window !== 'undefined' ? window[BRIDGE_KEY] : undefined;
			/* 会话键要「粘住」：bridge 组件在 composer 重渲染的瞬间可能短暂卸载，
			 * 那一刻若读出 'default'，整批编号会被清掉。 */
			if (bridge && bridge.sessionId) lastSessionKey = bridge.sessionId;
			return lastSessionKey || 'default';
		}

		function ensureBatchFresh() {
			var key = currentSessionKey();
			if (draftBatch.sessionKey !== key) {
				draftBatch = { sessionKey: key, images: 0, entries: [] };
				return;
			}
			if (draftBatch.entries.length === 0) return;
			var text = readComposerText(composerEditor());
			var alive = false;
			for (var i = 0; i < draftBatch.entries.length; i++) {
				if (findBlockRange(text, draftBatch.entries[i].block) !== null) {
					alive = true;
					break;
				}
			}
			/* 一个块都找不到了：上一批已经发出去 / 被清空 —— 重新从「图像 1」开始 */
			if (!alive) draftBatch = { sessionKey: key, images: 0, entries: [] };
		}

		function batchEntryFor(src) {
			if (!src) return null;
			for (var i = 0; i < draftBatch.entries.length; i++) {
				if (draftBatch.entries[i].src === src) return draftBatch.entries[i];
			}
			return null;
		}

		function rememberEntry(entry) {
			var existing = batchEntryFor(entry.src);
			if (existing === null) {
				draftBatch.entries.push(entry);
				draftBatch.images = entry.index;
			} else {
				existing.block = entry.block;
				existing.pins = entry.pins;
				existing.natural = entry.natural;
			}
			draftBatch.sessionKey = currentSessionKey();
		}

		/* ==================================================================
		 * 标注器：一个 lightbox = 一个标注器
		 * ================================================================== */

		var PIN_ID_SEQ = 0;

		function createAnnotator(dialog, img, t) {
			var root = document.createElement('div');
			root.setAttribute('data-dpc-root', '');
			dialog.appendChild(root);

			var canvas = document.createElement('canvas');
			canvas.className = 'dpc-canvas';
			root.appendChild(canvas);

			var bar = document.createElement('div');
			bar.className = 'dpc-bar';
			root.appendChild(bar);

			var toggleButton = document.createElement('button');
			toggleButton.type = 'button';
			toggleButton.className = 'dpc-btn';
			toggleButton.title = t('annotateTitle');
			toggleButton.setAttribute('aria-label', t('annotateTitle'));
			toggleButton.appendChild(svgIcon('M12 21s6.4-5.8 6.4-10.4a6.4 6.4 0 10-12.8 0C5.6 15.2 12 21 12 21z'));
			var toggleLabel = document.createElement('span');
			toggleLabel.textContent = t('annotate');
			toggleButton.appendChild(toggleLabel);
			bar.appendChild(toggleButton);

			bar.appendChild(makeSeparator());

			var countEl = document.createElement('span');
			countEl.className = 'dpc-count';
			bar.appendChild(countEl);

			var clearButton = document.createElement('button');
			clearButton.type = 'button';
			clearButton.className = 'dpc-btn';
			clearButton.title = t('clearTitle');
			clearButton.setAttribute('aria-label', t('clearTitle'));
			clearButton.appendChild(svgIcon('M5 7.5h14M9.5 7.5V5h5v2.5M7 7.5l.8 12h8.4l.8-12'));
			bar.appendChild(clearButton);

			var primaryButton = document.createElement('button');
			primaryButton.type = 'button';
			primaryButton.className = 'dpc-primary';
			primaryButton.title = t('insertTitle');
			primaryButton.appendChild(svgIcon('M20 6.6L9.5 17.4 4 11.9'));
			var primaryLabel = document.createElement('span');
			primaryLabel.textContent = t('insert');
			primaryButton.appendChild(primaryLabel);
			bar.appendChild(primaryButton);

			var toastEl = document.createElement('div');
			toastEl.className = 'dpc-toast';
			toastEl.style.display = 'none';
			root.appendChild(toastEl);

			var pop = document.createElement('div');
			pop.className = 'dpc-pop';
			pop.style.display = 'none';
			root.appendChild(pop);

			var textarea = document.createElement('textarea');
			textarea.placeholder = t('placeholder');
			textarea.rows = 2;
			textarea.setAttribute('aria-label', t('placeholder'));
			pop.appendChild(textarea);

			var foot = document.createElement('div');
			foot.className = 'dpc-pop-foot';
			var hint = document.createElement('span');
			hint.textContent = t('hint');
			foot.appendChild(hint);
			var deleteButton = document.createElement('button');
			deleteButton.type = 'button';
			deleteButton.className = 'dpc-del';
			deleteButton.textContent = t('remove');
			foot.appendChild(deleteButton);
			pop.appendChild(foot);

			var state = {
				active: false,
				pins: [],
				natural: { w: img.naturalWidth || 0, h: img.naturalHeight || 0 },
				rect: null,
				editingId: null,
				hoveredId: null,
				drag: null,
				pending: null,
				busy: false,
				rafId: 0,
				timer: 0
			};

			/* 同一张图再次打开：把这一批里已经钉过的锚点预载回来，
			 * 编号延续，块就地更新，不会出现「图像 3 = 同一张图」的串号。 */
			(function preloadFromBatch() {
				try {
					ensureBatchFresh();
					var entry = batchEntryFor(img.currentSrc || img.src);
					if (entry === null) return;
					state.pins = entry.pins.map(function (pin) {
						return { id: ++PIN_ID_SEQ, x: pin.x, y: pin.y, note: pin.note };
					});
					log('preloaded ' + state.pins.length + ' pin(s) from the current batch');
				} catch (error) {
					warn('preload failed', error);
				}
			})();

			function makeSeparator() {
				var sep = document.createElement('div');
				sep.className = 'dpc-sep';
				return sep;
			}

			/* ------------------------------ 尺寸与重绘 ------------------------------ */

			function syncLayout() {
				var rect = img.getBoundingClientRect();
				if (rect.width < 4 || rect.height < 4) return;
				/* 原图尺寸可能比预览晚到（点开瞬间图还在解码），一旦可用就纠正，
				 * 否则坐标百分比与导出都会跑偏。 */
				if (img.naturalWidth >= 2 && img.naturalHeight >= 2) {
					if (state.natural.w !== img.naturalWidth || state.natural.h !== img.naturalHeight) {
						state.natural = { w: img.naturalWidth, h: img.naturalHeight };
					}
				} else if (state.natural.w < 2 || state.natural.h < 2) {
					state.natural = { w: Math.round(rect.width), h: Math.round(rect.height) };
				}
				state.rect = rect;
				var dpr = window.devicePixelRatio || 1;
				var width = Math.max(1, Math.round(rect.width * dpr));
				var height = Math.max(1, Math.round(rect.height * dpr));
				if (canvas.width !== width || canvas.height !== height) {
					canvas.width = width;
					canvas.height = height;
				}
				canvas.style.left = rect.left + 'px';
				canvas.style.top = rect.top + 'px';
				canvas.style.width = rect.width + 'px';
				canvas.style.height = rect.height + 'px';
				draw();
				positionPopover();
			}

			function draw() {
				var g = canvas.getContext('2d');
				g.setTransform(1, 0, 0, 1, 0, 0);
				g.clearRect(0, 0, canvas.width, canvas.height);
				if (canvas.width < 2 || state.natural.w < 2) return;
				var scale = canvas.width / state.natural.w;
				g.setTransform(scale, 0, 0, scale, 0, 0);
				paintPins(g, state.pins, state.natural, state.hoveredId);
			}

			/* ------------------------------ 坐标换算 ------------------------------ */

			function currentScale() {
				if (state.rect === null || state.natural.w < 2) return 1;
				return state.rect.width / state.natural.w;
			}

			function toNatural(event) {
				var rect = state.rect || img.getBoundingClientRect();
				var scale = rect.width / Math.max(1, state.natural.w);
				return {
					x: clamp((event.clientX - rect.left) / scale, 0, state.natural.w),
					y: clamp((event.clientY - rect.top) / scale, 0, state.natural.h)
				};
			}

			function findPin(id) {
				for (var i = 0; i < state.pins.length; i++) {
					if (state.pins[i].id === id) return state.pins[i];
				}
				return null;
			}

			function hitPin(point) {
				var r = pinRadius(state.natural) * 1.35;
				for (var i = state.pins.length - 1; i >= 0; i--) {
					var pin = state.pins[i];
					var dx = point.x - pin.x;
					var dy = point.y - pin.y;
					if (dx * dx + dy * dy <= r * r) return pin;
				}
				return null;
			}

			/* ------------------------------ 评论气泡 ------------------------------ */

			function positionPopover() {
				if (state.editingId === null || state.rect === null) return;
				var pin = findPin(state.editingId);
				if (pin === null) return;
				var rect = state.rect;
				var scale = rect.width / Math.max(1, state.natural.w);
				var r = pinRadius(state.natural) * scale;
				var popWidth = pop.offsetWidth || 280;
				var popHeight = pop.offsetHeight || 120;
				var left = rect.left + pin.x * scale + r + 10;
				var top = rect.top + pin.y * scale + r + 10;
				if (left + popWidth > window.innerWidth - 12) left = rect.left + pin.x * scale - popWidth - r - 10;
				if (left < 12) left = 12;
				if (top + popHeight > window.innerHeight - 12) top = rect.top + pin.y * scale - popHeight - r - 10;
				if (top < 12) top = 12;
				pop.style.left = Math.round(left) + 'px';
				pop.style.top = Math.round(top) + 'px';
			}

			function openPopover(id, focus) {
				var pin = findPin(id);
				if (pin === null) return;
				state.editingId = id;
				textarea.value = pin.note || '';
				pop.style.display = 'flex';
				positionPopover();
				if (focus !== false) {
					textarea.focus();
					try {
						textarea.setSelectionRange(textarea.value.length, textarea.value.length);
					} catch (ignored) {
						/* 忽略 */
					}
				}
				refresh();
			}

			/**
			 * 保存当前气泡里的备注。
			 *
			 * 这就是「第一次回车」：只把这一颗图钉的内容确认下来，继续标注模式，
			 * 可以接着钉下一颗；真正发出去是回到输入框后的那次回车。
			 */
			function commitPopover(removeIfEmpty) {
				if (state.editingId === null) return;
				var pin = findPin(state.editingId);
				var text = textarea.value.trim();
				if (pin !== null) {
					if (text.length === 0 && removeIfEmpty) {
						removePin(pin.id);
					} else {
						pin.note = text;
					}
				}
				state.editingId = null;
				pop.style.display = 'none';
				try {
					textarea.blur();
				} catch (ignored) {
					/* 忽略 */
				}
				refresh();
				draw();
			}

			function cancelPopover() {
				if (state.editingId === null) return;
				commitPopover(true);
			}

			function removePin(id) {
				for (var i = 0; i < state.pins.length; i++) {
					if (state.pins[i].id === id) {
						state.pins.splice(i, 1);
						break;
					}
				}
				if (state.editingId === id) {
					state.editingId = null;
					pop.style.display = 'none';
				}
				refresh();
				draw();
			}

			/* ------------------------------ 指针交互 ------------------------------ */

			/** 指针捕获只是锦上添花：合成事件（测试/脚本）里 pointerId 不在活动表里会抛，忽略即可。 */
			function capturePointer(pointerId) {
				try {
					if (typeof canvas.setPointerCapture === 'function' && pointerId !== undefined) {
						canvas.setPointerCapture(pointerId);
					}
				} catch (ignored) {
					/* 忽略 */
				}
			}

			function releasePointer(pointerId) {
				try {
					if (typeof canvas.releasePointerCapture === 'function' && pointerId !== undefined) {
						canvas.releasePointerCapture(pointerId);
					}
				} catch (ignored) {
					/* 忽略 */
				}
			}

			function onPointerDown(event) {
				if (!state.active || state.busy) return;
				if (event.button !== undefined && event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();

				/* 气泡开着时先落定气泡（document 捕获阶段通常已经做过，这里兜底），
				 * 然后照常钉下一颗 —— 图钉可以不止一个。 */
				if (state.editingId !== null) commitPopover(false);

				var point = toNatural(event);
				var hit = hitPin(point);
				if (hit !== null) {
					state.drag = { id: hit.id, startX: point.x, startY: point.y, x: hit.x, y: hit.y, moved: false };
					capturePointer(event.pointerId);
					canvas.style.cursor = 'grabbing';
					return;
				}

				state.pending = point;
				capturePointer(event.pointerId);
			}

			function onPointerMove(event) {
				if (!state.active) return;
				var point = toNatural(event);

				if (state.drag !== null) {
					var pin = findPin(state.drag.id);
					if (pin === null) return;
					var dx = point.x - state.drag.startX;
					var dy = point.y - state.drag.startY;
					if (Math.abs(dx) * currentScale() > 2 || Math.abs(dy) * currentScale() > 2) state.drag.moved = true;
					pin.x = clamp(state.drag.x + dx, 0, state.natural.w);
					pin.y = clamp(state.drag.y + dy, 0, state.natural.h);
					draw();
					return;
				}

				if (state.pending !== null) {
					var moved =
						Math.abs(point.x - state.pending.x) * currentScale() > 3 ||
						Math.abs(point.y - state.pending.y) * currentScale() > 3;
					if (moved) {
						state.pending = null;
						canvas.style.cursor = 'crosshair';
					}
					return;
				}

				var hover = hitPin(point);
				var nextHovered = hover === null ? null : hover.id;
				if (nextHovered !== state.hoveredId) {
					state.hoveredId = nextHovered;
					canvas.style.cursor = hover === null ? 'crosshair' : 'pointer';
					draw();
				}
			}

			function onPointerUp(event) {
				if (!state.active || state.busy) return;
				if (state.drag !== null) {
					var drag = state.drag;
					state.drag = null;
					canvas.style.cursor = 'crosshair';
					if (!drag.moved) openPopover(drag.id, true);
					else {
						positionPopover();
						refresh();
					}
					releasePointer(event.pointerId);
					return;
				}
				if (state.pending !== null) {
					var point = state.pending;
					state.pending = null;
					var pin = { id: ++PIN_ID_SEQ, x: point.x, y: point.y, note: '' };
					state.pins.push(pin);
					draw();
					openPopover(pin.id, true);
				}
				releasePointer(event.pointerId);
			}

			function onPointerLeave() {
				if (state.hoveredId !== null && state.drag === null) {
					state.hoveredId = null;
					draw();
				}
			}

			/* ------------------------------ 工具条 ------------------------------ */

			function refresh() {
				countEl.textContent = t('count', { n: state.pins.length });
				clearButton.disabled = state.pins.length === 0;
				primaryButton.disabled = state.pins.length === 0;
				toggleButton.setAttribute('data-dpc-on', state.active ? '1' : '0');
				toggleLabel.textContent = state.active ? t('annotateOn') : t('annotate');
				toggleButton.title = state.active ? t('annotateOnTitle') : t('annotateTitle');
				toggleButton.setAttribute('aria-pressed', state.active ? 'true' : 'false');
				canvas.setAttribute('data-dpc-active', state.active ? '1' : '0');
			}

			function setActive(active) {
				state.active = active;
				if (!active) {
					commitPopover(false);
					state.pending = null;
					state.drag = null;
					state.hoveredId = null;
					pop.style.display = 'none';
				}
				refresh();
				draw();
			}

			toggleButton.addEventListener('click', function (event) {
				event.stopPropagation();
				setActive(!state.active);
			});

			clearButton.addEventListener('click', function (event) {
				event.stopPropagation();
				state.pins.length = 0;
				state.editingId = null;
				pop.style.display = 'none';
				refresh();
				draw();
			});

			primaryButton.addEventListener('click', function (event) {
				event.stopPropagation();
				commit();
			});

			textarea.addEventListener('keydown', function (event) {
				event.stopPropagation();
				if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					commitPopover(true);
					return;
				}
				if (event.key === 'Escape') {
					event.preventDefault();
					cancelPopover();
				}
			});

			textarea.addEventListener('input', function () {
				if (state.editingId === null) return;
				var pin = findPin(state.editingId);
				if (pin !== null) pin.note = textarea.value;
			});

			deleteButton.addEventListener('click', function (event) {
				event.stopPropagation();
				if (state.editingId !== null) removePin(state.editingId);
			});

			/* 点到气泡外面：保存当前备注（备注为空则保持图钉，只是没评论文本） */
			function onDocumentPointerDown(event) {
				if (state.editingId === null) return;
				if (pop.contains(event.target)) return;
				commitPopover(false);
			}
			document.addEventListener('pointerdown', onDocumentPointerDown, true);

			function onKeyDown(event) {
				if (state.editingId !== null) return;
				if (event.key === 'Escape' && state.active) {
					event.preventDefault();
					event.stopPropagation();
					setActive(false);
				}
			}
			window.addEventListener('keydown', onKeyDown, true);

			canvas.addEventListener('pointerdown', onPointerDown);
			canvas.addEventListener('pointermove', onPointerMove);
			canvas.addEventListener('pointerup', onPointerUp);
			canvas.addEventListener('pointercancel', onPointerUp);
			canvas.addEventListener('pointerleave', onPointerLeave);

			/* ------------------------------ 提示条 ------------------------------ */

			function toast(message, duration) {
				toastEl.textContent = message;
				toastEl.style.display = 'block';
				if (state.timer) clearTimeout(state.timer);
				state.timer = setTimeout(function () {
					toastEl.style.display = 'none';
				}, duration || 2600);
			}

			/* ------------------------------ 投递：发原图，不发带钉图 ------------------------------ */

			/**
			 * 取「原图」本身（不改一个像素、不重编码）：
			 * 模型看到的是干净原图，定位完全靠文字里的坐标，图钉只存在于屏幕上。
			 * fetch 拿不到（自定义协议等）才退回「像素副本」这条兜底。
			 */
			function originalFile(baseName) {
				var src = img.currentSrc || img.src;
				return fetch(src, { credentials: 'include' })
					.then(function (response) {
						if (!response.ok) throw new Error('HTTP ' + response.status);
						return response.blob();
					})
					.then(function (blob) {
						if (!blob || blob.size === 0 || String(blob.type).indexOf('image/') !== 0) {
							throw new Error('not an image blob');
						}
						return blob;
					})
					.catch(function (error) {
						log('original fetch failed, re-encoding pixels', error);
						return pixelCopy();
					})
					.then(function (blob) {
						var type = String(blob.type || '').indexOf('image/') === 0 ? blob.type : 'image/png';
						return new File([blob], baseName + '.' + extensionFor(type), { type: type });
					});
			}

			/** 兜底：把 <img> 的像素原尺寸拷一张 PNG（不带任何标注）。 */
			function pixelCopy() {
				return loadSource(img).then(function (loaded) {
					var width = state.natural.w || img.naturalWidth || 0;
					var height = state.natural.h || img.naturalHeight || 0;
					if (width < 2 || height < 2) throw new Error('image size unknown');
					var target = document.createElement('canvas');
					target.width = width;
					target.height = height;
					target.getContext('2d').drawImage(loaded.source, 0, 0, width, height);
					loaded.release();
					return new Promise(function (resolve, reject) {
						target.toBlob(function (blob) {
							if (blob === null) reject(new Error('toBlob returned null'));
							else resolve(blob);
						}, 'image/png');
					});
				});
			}

			/** 这张图是不是本来就在输入框里（草稿附件）—— 是的话不重复插一张。 */
			function alreadyInComposer() {
				var src = String(img.currentSrc || img.src || '');
				if (src.length === 0) return false;
				var thumbs = document.querySelectorAll('[data-composer-card] img');
				for (var i = 0; i < thumbs.length; i++) {
					if (String(thumbs[i].currentSrc || thumbs[i].src || '') === src) return true;
				}
				return false;
			}

			function closeLightbox() {
				var close = dialog.querySelector(':scope > button');
				if (close !== null) {
					close.click();
					return;
				}
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			}

			function setBusy(busy) {
				state.busy = busy;
				primaryButton.setAttribute('data-dpc-busy', busy ? '1' : '0');
				primaryButton.disabled = busy || state.pins.length === 0;
			}

			/**
			 * 收尾：把块写进草稿。
			 * 同一张图在这一批里已经写过块 → 就地把旧块换成新块（编号不变、
			 * 别的图和用户自己写的字都不动）；否则追加到草稿末尾。
			 */
			function finishText(block, entry) {
				var existing = batchEntryFor(entry.src);
				var text = block;
				var replace = false;
				if (existing !== null) {
					var current = readComposerText(composerEditor());
					var range = findBlockRange(current, existing.block);
					if (range !== null) {
						text = current.slice(0, range.start) + block + current.slice(range.end);
						replace = true;
					}
				}
				return insertTextBlock(text, replace).then(function (mode) {
					rememberEntry(entry);
					if (mode === 'none') {
						toast(t('textFailed'), 6000);
					} else {
						toast(t('attached', { i: entry.index }), 4000);
					}
					closeLightbox();
				});
			}

			function commit() {
				if (state.busy) return;
				commitPopover(false);
				if (state.pins.length === 0) {
					toast(t('empty'));
					return;
				}
				setBusy(true);
				toast(t('working'), 60000);
				ensureBatchFresh();
				var src = img.currentSrc || img.src;
				var known = batchEntryFor(src);
				var index = known !== null ? known.index : draftBatch.images + 1;
				var pins = state.pins.map(function (pin) {
					return { x: pin.x, y: pin.y, note: pin.note };
				});

				/* 这张图本来就在输入框里（草稿附件）：只补/更新坐标说明，不重复插附件 */
				if (known !== null || alreadyInComposer()) {
					var attachedBlock = buildImageBlock(index, state.natural, pins, t, t('sourceAttached'));
					finishText(attachedBlock, {
						src: src,
						index: index,
						block: attachedBlock,
						pins: pins,
						natural: { w: state.natural.w, h: state.natural.h }
					}).then(function () {
						setBusy(false);
					});
					return;
				}

				var baseName = 'image-' + index + '-' + stamp();
				originalFile(baseName)
					.then(function (file) {
						var block = buildImageBlock(index, state.natural, pins, t, t('sourceFile', { file: file.name }));
						var entry = {
							src: src,
							index: index,
							block: block,
							pins: pins,
							natural: { w: state.natural.w, h: state.natural.h }
						};
						var before = countBlobImages();
						if (!attachViaPaste(file)) {
							toast(t('noEditor'), 5000);
							copyBlobToClipboard(file);
							return null;
						}
						return waitFor(function () {
							return countBlobImages() > before;
						}, 2200).then(function (appeared) {
							if (appeared) {
								log('attachment confirmed');
								return finishText(block, entry);
							}
							log('attachment not confirmed; trying drop');
							attachViaDrop(file);
							return waitFor(function () {
								return countBlobImages() > before;
							}, 1200).then(function (dropped) {
								if (dropped) return finishText(block, entry);
								return copyBlobToClipboard(file).then(function (copied) {
									if (copied) {
										toast(t('uncertain'), 6000);
										closeLightbox();
										return null;
									}
									downloadBlob(file, file.name);
									copyTextToClipboard(block);
									toast(t('downloaded'), 5000);
									return null;
								});
							});
						});
					})
					.catch(function (error) {
						warn('attach original failed', error);
						toast(t('exportFailed') + (error && error.message ? '：' + error.message : ''), 5000);
					})
					.then(function () {
						setBusy(false);
					});
			}

			/* ------------------------------ 位置同步与生命周期 ------------------------------ */

			var resizeObserver = null;
			if (typeof ResizeObserver === 'function') {
				resizeObserver = new ResizeObserver(function () {
					syncLayout();
				});
				try {
					resizeObserver.observe(img);
				} catch (ignored) {
					/* 忽略 */
				}
			}
			window.addEventListener('resize', syncLayout);
			img.addEventListener('load', syncLayout);
			if (!img.complete) {
				img.addEventListener('load', syncLayout, { once: true });
			}

			refresh();
			syncLayout();
			setTimeout(syncLayout, 60);
			setTimeout(syncLayout, 240);

			function destroy() {
				document.removeEventListener('pointerdown', onDocumentPointerDown, true);
				window.removeEventListener('keydown', onKeyDown, true);
				window.removeEventListener('resize', syncLayout);
				img.removeEventListener('load', syncLayout);
				if (resizeObserver !== null) resizeObserver.disconnect();
				if (state.timer) clearTimeout(state.timer);
				root.remove();
				var registry = window.__dshImagePinComment;
				if (registry) {
					var index = registry.annotators.indexOf(handle);
					if (index >= 0) registry.annotators.splice(index, 1);
				}
			}

			var handle = { dialog: dialog, state: state, setActive: setActive, destroy: destroy };
			var registry = window.__dshImagePinComment;
			if (registry) registry.annotators.push(handle);
			return handle;
		}

		/* ==================================================================
		 * lightbox 观察器
		 * ================================================================== */

		function isLightbox(dialog) {
			/* 结构（dsh-client-ui-primitives ImageLightbox）：
			 * body portal > div[role=dialog][aria-modal=true]
			 *   > div[aria-hidden=true]（遮罩）, img（原图）, button（关闭）
			 * 这里只依赖「dialog 直接子元素里有 img」这个稳定特征。 */
			if (dialog.getAttribute('role') !== 'dialog') return false;
			if (dialog.getAttribute('aria-modal') !== 'true') return false;
			var img = dialog.querySelector(':scope > img');
			return img !== null;
		}

		function startWatcher(t) {
			var annotators = [];
			var known = new WeakSet();
			var scheduled = false;
			var lastRun = 0;

			function reconcile() {
				scheduled = false;
				lastRun = Date.now();
				for (var i = annotators.length - 1; i >= 0; i--) {
					if (!annotators[i].dialog.isConnected) {
						try {
							annotators[i].destroy();
						} catch (error) {
							warn('destroy failed', error);
						}
						annotators.splice(i, 1);
					}
				}
				var dialogs = document.body.querySelectorAll(':scope > div[role="dialog"][aria-modal="true"]');
				for (var j = 0; j < dialogs.length; j++) {
					var dialog = dialogs[j];
					if (known.has(dialog)) continue;
					if (!isLightbox(dialog)) continue;
					var img = dialog.querySelector(':scope > img');
					known.add(dialog);
					try {
						annotators.push(createAnnotator(dialog, img, t));
						log('annotator attached');
					} catch (error) {
						warn('attach failed', error);
					}
				}
			}

			function schedule() {
				if (scheduled) return;
				var elapsed = Date.now() - lastRun;
				if (elapsed > 220) {
					reconcile();
					return;
				}
				scheduled = true;
				setTimeout(function () {
					if (scheduled) reconcile();
				}, 220 - elapsed);
			}

			var observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			reconcile();

			return function stop() {
				observer.disconnect();
				annotators.forEach(function (annotator) {
					try {
						annotator.destroy();
					} catch (error) {
						warn('destroy failed', error);
					}
				});
				annotators.length = 0;
			};
		}

		/* ==================================================================
		 * setDraft 桥：只读地挂在 conversation.input.overlay 上，把宿主公开的
		 * inputActions 记到 window 上，供纯 DOM 的标注层使用。
		 * 拿不到（宿主版本没这个 slot / 没注入 slots 服务）就静默跳过，
		 * 文本改走合成 paste。
		 * ================================================================== */

		function registerBridge(ctx) {
			var react;
			try {
				react = require('react');
			} catch (error) {
				warn('react seed module unavailable; text falls back to paste', error);
				return;
			}
			if (react === null || typeof react.createElement !== 'function') return;

			function Bridge(props) {
				react.useEffect(
					function () {
						var mine = {
							actions: props && props.inputActions ? props.inputActions : null,
							sessionId: props && props.sessionId ? props.sessionId : null
						};
						window[BRIDGE_KEY] = mine;
						return function () {
							/* 只标记失效、不清空：清空会让紧随其后的插入退回 paste 兜底，
							 * 也会让会话键掉回 'default'，把多图标号弄乱。 */
							if (window[BRIDGE_KEY] === mine) mine.stale = true;
						};
					},
					[props && props.inputActions, props && props.sessionId]
				);
				return null;
			}
			Bridge.displayName = 'ImagePinCommentBridge';

			try {
				ctx.slots.inject('conversation.input.overlay', function () {
					/* list slot 必须带 id，否则 ui-slots 会抛
					 * `list slot "conversation.input.overlay" requires options.id`。 */
					return ctx.slots.register(
						{ name: 'conversation.input.overlay', id: 'image-pin-comment-bridge' },
						Bridge
					);
				});
				log('draft bridge registered');
			} catch (error) {
				warn('slot bridge registration failed; text falls back to paste', error);
			}
		}

		/* ==================================================================
		 * 插件入口
		 * ================================================================== */

		function apply(ctx) {
			if (typeof window === 'undefined' || typeof document === 'undefined') return;
			var t = makeTranslator(ctx);
			injectStyles();
			/* 诊断入口：控制台里 `__dshImagePinComment.annotators[0].state` 可看实时状态 */
			if (!window.__dshImagePinComment) {
				window.__dshImagePinComment = { version: '0.2.0', package: PKG_ID, annotators: [] };
			}
			/* 双挂载保护：插件既可能按 bundle 行加载，也可能被本地 install.sh
			 * 追加一行；两条路同时命中时只允许一份观察器，否则会出现两条工具条。 */
			if (!window.__dshImagePinComment.started) {
				window.__dshImagePinComment.started = true;
				var stop = startWatcher(t);
				var dispose = function () {
					/* HMR 重新 apply 时要把闸门放开，否则热更新后不再挂载 */
					window.__dshImagePinComment.started = false;
					stop();
				};
				if (ctx && typeof ctx.effect === 'function') {
					ctx.effect(function () {
						return dispose;
					});
				} else {
					window.addEventListener('beforeunload', dispose);
				}
			}

			if (ctx && typeof ctx.inject === 'function' && !window.__dshImagePinComment.bridgeRequested) {
				window.__dshImagePinComment.bridgeRequested = true;
				try {
					ctx.inject(['slots'], function (scope) {
						registerBridge(scope);
					});
				} catch (error) {
					warn('slots service unavailable; text falls back to paste', error);
				}
			}

			log('ready (v0.2.0)');
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
