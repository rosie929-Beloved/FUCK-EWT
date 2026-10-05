// ==UserScript==
// @name         EWT 作业学习助手
// @namespace    https://github.com/rosie929-Beloved/FUCK-EWT
// @version      3.9.0
// @description  升学E网通答题页自动化：自动作答（识图/公式截图/语法填空/手写上传题，答案由智谱 GLM 生成，需自行配置 API Key）/自动过检/自动提交/自批满分；视频页：2X 倍速/自动跳过/自动连播/锁进度条/认真度检测秒过。需配合 ewt-llm-bridge.user.js 使用，使用教程见仓库内《新手指南.md》。
// @author       rosie929-Beloved
// @license      MIT
// @match        https://teacher.ewt360.com/ewtbend/bend/index/index.html*
// @match        http://teacher.ewt360.com/ewtbend/bend/index/index.html*
// @match        https://web.ewt360.com/answer-pc/*
// @match        http://web.ewt360.com/answer-pc/*
// @match        https://web.ewt360.com/site-study/*
// @match        http://web.ewt360.com/site-study/*
// @match        https://web.ewt360.com/*
// @match        http://web.ewt360.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* ============================================================
 * isTrusted 绕过（必须早于平台脚本注册监听时执行，越早越好）
 * 原实现的两个盲点：
 *   1) 只处理经 addEventListener 注册的监听器，抓不到 el.onclick = fn
 *   2) 依赖监听函数源码里出现字面量 "isTrusted"，抓不到闭包/合成事件
 * 加固后：对所有 click/submit/change 事件统一做代理包装。
 * ============================================================ */
(function () {
  'use strict';
  const EVENT_TYPES = ['click', 'submit', 'change'];
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
  const wrappedMap = new WeakMap();
  const DEBUG = false;

  function shouldWrap(type, listener) {
    if (typeof listener !== 'function') return false;
    return EVENT_TYPES.includes(String(type).toLowerCase());
  }

  function wrapListener(listener) {
    let wrapped = wrappedMap.get(listener);
    if (wrapped) return wrapped;
    wrapped = function (event) {
      if (event && typeof event === 'object' && 'isTrusted' in event && event.isTrusted === false) {
        try {
          const proxy = new Proxy(event, {
            get(target, prop) {
              if (prop === 'isTrusted') return true;
              const value = target[prop];
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          if (DEBUG) console.log(`[isTrusted Bypass] ${event.type} isTrusted: false -> true`);
          return listener.call(this, proxy);
        } catch (e) {
          return listener.call(this, event);
        }
      }
      return listener.call(this, event);
    };
    wrappedMap.set(listener, wrapped);
    wrappedMap.set(wrapped, listener);
    return wrapped;
  }

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!shouldWrap(type, listener)) return originalAddEventListener.call(this, type, listener, options);
    return originalAddEventListener.call(this, type, wrapListener(listener), options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const wrapped = typeof listener === 'function' ? wrappedMap.get(listener) : null;
    return originalRemoveEventListener.call(this, type, wrapped || listener, options);
  };

  // onclick / onsubmit / onchange 属性赋值也要拦
  for (const type of EVENT_TYPES) {
    const prop = 'on' + type;
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop) ||
                 Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (!desc || !desc.set) continue;
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get() { return desc.get ? desc.get.call(this) : undefined; },
      set(fn) {
        if (typeof fn === 'function') {
          const self = this;
          const wrapped = function (event) {
            if (event && typeof event === 'object' && 'isTrusted' in event && event.isTrusted === false) {
              try {
                const proxy = new Proxy(event, {
                  get(t, p) { if (p === 'isTrusted') return true; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; },
                });
                return fn.call(self, proxy);
              } catch (e) { return fn.call(self, event); }
            }
            return fn.call(self, event);
          };
          return desc.set.call(this, wrapped);
        }
        return desc.set.call(this, fn);
      },
    });
  }
  if (DEBUG) console.log('[isTrusted Bypass] addEventListener / on* 劫持已启动');
})();

(() => {
  'use strict';
  const APP = 'ewt-study-helper';
  const KEY = 'ewt_study_helper_v3';
  const state = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } })();
  let last = { tasks: [], questions: [] };
  let timer = 0;

  const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
  const text = el => clean(el?.innerText || el?.textContent || '');
  const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const status = s => /已完成|提交成功|已通过/.test(s) ? 'done' : /进行中|作答中/.test(s) ? 'doing' : /未完成|待完成|开始作答|继续作答/.test(s) ? 'todo' : 'unknown';

  /* ============ 隐藏窗口 / 隐蔽点击 工具 start ============ */
  // EWT 会用 document.hidden / visibilitychange 判断切后台，切走就暂停计时。
  // 让页面始终认为自己是「可见 + 聚焦」。
  function installVisibilitySpoof() {
    try {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(document, 'webkitHidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
      // 屏蔽平台注册的 visibilitychange 回调
      const oAdd = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, listener, opts) {
        if (String(type).toLowerCase() === 'visibilitychange') {
          return oAdd.call(this, type, function () {}, opts);
        }
        return oAdd.call(this, type, listener, opts);
      };
    } catch (e) {}
  }
  /* ============ 隐藏窗口 / 隐蔽点击 工具 end ============ */

  function taskCards() {
    const all = [...document.querySelectorAll('[data-task-id],[data-homework-id],[class*="task"],[class*="homework"],li,article,section,div')];
    const out = [], seen = new Set();
    for (const el of all) {
      const s = text(el), cls = String(el.className || '');
      if (s.length < 3 || s.length > 1200 || !/(作业|任务|课程|练习|测验|试卷|视频|完成|提交|学习|导|学|练|homework|task)/i.test(`${cls} ${s}`)) continue;
      if ([...el.children].some(ch => text(ch).length >= 3 && /(作业|任务|课程|练习|测验)/.test(text(ch)))) continue;
      const link = el.matches('a[href]') ? el : el.querySelector('a[href]');
      const id = el.getAttribute('data-task-id') || el.getAttribute('data-homework-id') || link?.href || s.slice(0, 100);
      if (seen.has(id)) continue; seen.add(id);
      out.push({ id, title: clean(el.querySelector('h1,h2,h3,h4,h5,[class*="title"],[class*="name"]')?.textContent || s).slice(0,160), status: status(s), summary: s.slice(0,700), href: link?.href || '' });
    }
    return out;
  }

  function extractQuestions() {
    // 优先使用实测的答题页容器
    const real = [...document.querySelectorAll('.pm-question, .examination-paper-answer .pm-question, .pm-question-content')];
    if (real.length) {
      const out = [];
      for (const root of real) {
        const q = clean(root.querySelector('.pm-question-content, [class*="content"]')?.textContent || root.textContent).slice(0, 1200);
        if (q.length < 5 || q.length > 3000) continue;
        const opts = [...root.querySelectorAll('.pm-option, [class*="option"] label, [class*="option"] li, label')].map(text).filter(Boolean);
        out.push({ index: out.length + 1, question: q, options: [...new Set(opts)].slice(0, 12) });
      }
      if (out.length) return out;
    }
    const roots = [...document.querySelectorAll('[class*="question"],[class*="Question"],[class*="problem"],[class*="exam"],.ant-radio-group,.ant-checkbox-group,fieldset')];
    const candidates = roots.length ? roots : [...document.querySelectorAll('body')];
    const out = [], seen = new Set();
    for (const root of candidates) {
      const s = text(root); if (s.length < 5 || s.length > 3000) continue;
      const opts = [...root.querySelectorAll('label,li,[role="radio"],[role="checkbox"],[class*="option"],[class*="answer"]')].map(text).filter(Boolean);
      const q = clean((root.querySelector('[class*="stem"],[class*="title"],[class*="content"],h1,h2,h3,h4,p')?.textContent || s.split(/(?=[A-D][、.)]\s)/)[0])).slice(0,1200);
      const key = q + '|' + opts.join('|'); if (seen.has(key)) continue;
      if (opts.length || /[？?]$/.test(q) || /[一二三四五六七八九十]、/.test(q)) { seen.add(key); out.push({ index: out.length + 1, question: q, options: [...new Set(opts)].slice(0,12) }); }
    }
    return out;
  }

  function scan() {
    last = { tasks: taskCards(), questions: extractQuestions(), scannedAt: new Date().toISOString(), url: location.href };
    render();
  }

  function download(name, body, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
  function exportData() { download('ewt-study-readonly.json', JSON.stringify(last, null, 2), 'application/json;charset=utf-8'); }
  async function copyQuestions() {
    const body = last.questions.map(q => `${q.index}. ${q.question}${q.options.map((o,i)=>`\n   ${String.fromCharCode(65+i)}. ${o}`).join('')}`).join('\n\n');
    try { await navigator.clipboard.writeText(body || '当前未识别到题目'); alert(body ? '已复制当前题干和选项' : '当前未识别到题目'); } catch { alert('浏览器阻止了复制，请使用导出 JSON'); }
  }

  function exportText() {
    const body = [`EWT 只读学习整理`, `页面：${location.href}`, `扫描时间：${last.scannedAt || ''}`, '', '任务：', ...last.tasks.map((t, i) => `${i + 1}. ${t.title} [${t.status}]${t.href ? `\n   ${t.href}` : ''}`), '', '题目：', ...last.questions.map(q => `${q.index}. ${q.question}\n${q.options.map((o, i) => `   ${String.fromCharCode(65 + i)}. ${o}`).join('\n')}`)].join('\n');
    download('ewt-study-notes.txt', body, 'text/plain;charset=utf-8');
  }

  /* ============ LLM 客户端（通过 ewt-llm-bridge.user.js 中转） ============
   * 本脚本 @grant none，跑在页面上下文，无法直连中转站（CORS + Mixed Content）。
   * 所以把请求交给 bridge 脚本，用 postMessage 通信。
   * 依赖：另装 ewt-llm-bridge.user.js
   */
  const LLM = {
    REQ: 'EWT_LLM_REQUEST',
    RES: 'EWT_LLM_RESPONSE',
    PING: 'EWT_LLM_PING',
    PONG: 'EWT_LLM_PONG',
    FETCH: 'EWT_FETCH_REQUEST',
    FETCH_RES: 'EWT_FETCH_RESPONSE',
    CFG_GET: 'EWT_CFG_GET',
    CFG_SET: 'EWT_CFG_SET',
    CFG_TEST: 'EWT_CFG_TEST',
    CFG_RES: 'EWT_CFG_RESPONSE',
    OPEN_CFG: 'EWT_OPEN_CFG',          // bridge 菜单命令 → 打开配置面板
    seq: 0,
    pending: new Map(),
    fetchPending: new Map(),
    cfgPending: new Map(),
    bridgeAlive: false,
    lastChannel: '',

    init() {
      window.addEventListener('message', (ev) => {
        const d = ev.data;
        if (!d || !d.__ewt) return;
        if (d.__ewt === this.PONG) { this.bridgeAlive = true; return; }
        // bridge 脚本菜单里的「⚙ 配置」被点击 → 通知 UI 打开面板
        if (d.__ewt === this.OPEN_CFG) {
          try { if (typeof ApiConfig !== 'undefined' && ApiConfig.open) ApiConfig.open(); } catch (e) {}
          return;
        }
        // 配置接口响应
        if (d.__ewt === this.CFG_RES && d.id) {
          const cp = this.cfgPending.get(d.id);
          if (!cp) return;
          this.cfgPending.delete(d.id);
          d.ok ? cp.resolve(d) : cp.reject(new Error(d.error || '配置操作失败'));
          return;
        }
        // 文本抓取响应（html2canvas 源码兜底）
        if (d.__ewt === this.FETCH_RES && d.id) {
          const fp = this.fetchPending.get(d.id);
          if (!fp) return;
          this.fetchPending.delete(d.id);
          d.ok ? fp.resolve(d.text) : fp.reject(new Error(d.error || '抓取失败'));
          return;
        }
        if (d.__ewt !== this.RES || !d.id) return;
        const p = this.pending.get(d.id);
        if (!p) return;
        this.pending.delete(d.id);
        if (d.ok) {
          if (d.channel) this.lastChannel = d.channel;
          if (Array.isArray(d.droppedImages) && d.droppedImages.length) {
            log(`⚠ 有 ${d.droppedImages.length} 张图格式不被模型支持，已跳过（${d.droppedImages.join(',')}）`);
          }
          p.resolve(d.answer);
        } else {
          p.reject(new Error(d.error || '未知错误'));
        }
      });
      // 启动时探测 bridge 是否已装
      setTimeout(() => window.postMessage({ __ewt: this.PING }, '*'), 1000);
      setTimeout(() => {
        if (this.bridgeAlive) log('LLM bridge 已连接 ✓（智谱 GLM 主通道）');
        else log('⚠ 未检测到 ewt-llm-bridge 脚本，自动作答无法生成答案');
      }, 2500);
    },

    /* ---- 配置接口（转发给 bridge，bridge 用 GM_setValue 持久化）----
     * 未探测到 bridge 时先快速握手一次：多数情况下 bridge 没装，
     * 让用户等满 35s（真实模型超时余量）体验极差，所以只等 1.2s 就报错。 */
    _cfg(chan, extra, timeoutMs) {
      const send = (wait) => new Promise((resolve, reject) => {
        const id = `${Date.now()}-c${++this.seq}`;
        const timer = setTimeout(() => {
          if (this.cfgPending.has(id)) { this.cfgPending.delete(id); reject(new Error('bridge 未响应（未安装？）')); }
        }, wait);
        this.cfgPending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        window.postMessage({ __ewt: chan, id, ...(extra || {}) }, '*');
      });
      if (this.bridgeAlive) return send(timeoutMs || 10000);
      // 未连接：发一次 PING，1.2s 内没回 PONG 就直接失败，不占着 UI
      window.postMessage({ __ewt: this.PING }, '*');
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (!this.bridgeAlive) reject(new Error('bridge 未响应（未安装？）'));
          else send(timeoutMs || 10000).then(resolve, reject);
        }, 1200);
      });
    },
    getConfig() { return this._cfg(this.CFG_GET, {}, 6000); },
    setConfig(patch) { return this._cfg(this.CFG_SET, { patch }, 6000); },
    testConfig(override) { return this._cfg(this.CFG_TEST, { override }, 35000); },

    ask(payload) {
      return new Promise((resolve, reject) => {
        if (!payload.question) return reject(new Error('空题目'));
        const timeoutMs = payload.__timeoutMs;   // 失败重试时由调用方递增传入
        if (!this.bridgeAlive) {
          // 再探一次，给用户明确的报错而不是干等 95 秒
          window.postMessage({ __ewt: this.PING }, '*');
          return setTimeout(() => {
            if (!this.bridgeAlive) reject(new Error('bridge 脚本未安装/未运行，请先安装 ewt-llm-bridge.user.js'));
            else this._send(payload, resolve, reject, timeoutMs);
          }, 800);
        }
        this._send(payload, resolve, reject, timeoutMs);
      });
    },

    _send(payload, resolve, reject, timeoutMs) {
      const id = `${Date.now()}-${++this.seq}`;
      // 这里的等待必须比 bridge 的总耗时更长，否则自己的定时器会先炸，
      // 把 bridge 那边更详细的错误信息（HTTP 400 / 超时 / 通道失败）盖掉。
      // bridge 侧：主通道 180s，备用通道 25s（可能整机不可达）→ 最坏约 205s，
      // 加上主脚本自身的重试轮次递增，默认给 380s 余量足够。
      const wait = Math.max(60000, Number(timeoutMs) || 380000);
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`等待 bridge 超时（${Math.round(wait / 1000)}s）`)); }
      }, wait);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      window.postMessage({ __ewt: this.REQ, id, payload }, '*');
    },

    // 让 bridge 用 GM_xmlhttpRequest 抓任意文本（绕 CORS/CSP），用于加载 html2canvas 源码
    fetchText(url) {
      return new Promise((resolve, reject) => {
        const id = `${Date.now()}-f${++this.seq}`;
        const timer = setTimeout(() => {
          if (this.fetchPending.has(id)) { this.fetchPending.delete(id); reject(new Error('抓取超时')); }
        }, 20000);
        this.fetchPending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        window.postMessage({ __ewt: this.FETCH, id, url }, '*');
      });
    },
  };

  /* ============ 自动过检（认真度检测） ============
   * 实测（2026-10-05 视频页 teacher.ewt360.com .../#/homework/play-videos）：
   *   弹窗容器 DIV.earnest_check_tip-hAMr7（文字「认真度检测」）
   *     ├─ SPAN.tipTitle-pi0r2   「认真度检测」
   *     ├─ SPAN.tipContent-JAdtk 「老师敲黑板，帮你暂停一下 看看你在不在认真听课～」
   *     ├─ DIV.tipTime-iMZWe     「23s后将错过当前检测」  ← 有倒计时，必须尽快点
   *     └─ SPAN.btn-DOCWn        「点击通过检查」        ← 要点的就是这个
   *   注意：按钮 .btn-DOCWn 与弹窗容器是兄弟关系（btnCount 为 0）。
   *   另有 .action-btn.action-network（"检查网络"），不要误点。
   *   实现：MutationObserver 监听弹窗出现 → 立即点，比轮询快；轮询作兜底。
   */
  const AutoCheckPass = {
    intervalId: null,
    observer: null,
    tick() {
      try {
        // 策略1：弹窗容器 [class*="earnest_check_tip"] 内的按钮（语义化，最稳）
        let btn = null;
        const tip = document.querySelector('[class*="earnest_check_tip"]');
        if (tip) {
          // 按钮可能是容器的兄弟/后代，向上找一层共同父级再搜
          const scope = tip.parentElement || document;
          btn = scope.querySelector('.btn-DOCWn') || scope.querySelector('button,span,a');
          if (btn && text(btn) !== '点击通过检查') btn = null;
        }
        // 策略2：精确类名 .btn-DOCWn，文字必须严格匹配（排除"检查网络"）
        if (!btn) {
          const c = document.querySelector('.btn-DOCWn');
          if (c && text(c) === '点击通过检查') btn = c;
        }
        // 策略3：兜底，按文字找最内层可点元素
        if (!btn) btn = findButtonByText(['点击通过检查']);
        if (!btn) return;
        if (btn.dataset.ewtChecked) return;
        btn.dataset.ewtChecked = 'true';
        btn.click();
        log('已自动通过认真度检测');
        setTimeout(() => { try { delete btn.dataset.ewtChecked; } catch (e) {} }, 3000);
      } catch (e) { log('自动过检出错：' + e.message); }
    },
    start() {
      if (this.intervalId) return;
      this.tick();
      // 轮询兜底（若有倒计时，1s 内也会命中）
      this.intervalId = setInterval(() => this.tick(), 800);
      // MutationObserver：弹窗一插入 DOM 就立刻点，避开倒计时压力
      try {
        if (!this.observer && document.body) {
          this.observer = new MutationObserver(() => this.tick());
          this.observer.observe(document.body, { childList: true, subtree: true });
        }
      } catch (e) { /* 观察失败不影响轮询 */ }
      log('自动过检已开启');
    },
    stop() {
      if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      log('自动过检已关闭');
    },
    stop() {
      if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; log('自动过检已关闭'); }
    },
    toggle(on) { on ? this.start() : this.stop(); }
  };

  /* ============ 自动提交（按 web.ewt360.com/answer-pc/exam/answer 实测 DOM） ============ */
  // 实测结构（2026-10-05）：
  //   <div class="btn-group">
  //     <div class="commit-btn">
  //       <button type="button" class="ant-btn ant-btn-primary my-study-button"><span>提交试卷</span></button>
  //     </div>
  //   </div>
  //   真正可点的是最内层 <button>，.btn-group / .commit-btn 都只是包装 div。
  //   题目容器 .pm-question（id 形如 ewt-question-<数字>）
  //   弹窗是 Ant Design，确认按钮在 .ant-modal 内
  const SUBMIT_SELECTORS = [
    '.commit-btn button.ant-btn',
    'button.ant-btn.ant-btn-primary.my-study-button',
    '.commit-btn',
  ];
  // 文字兜底（排除父容器 .btn-group）
  const SUBMIT_TEXTS = ['提交试卷', '提交作业', '交卷', '确认提交'];
  const CONFIRM_TEXTS = ['确定', '确认', '确认提交', '确定提交', '好的', '提交'];

  /* 共享实现：定位提交确认弹窗的「确认」按钮。
   * AutoSubmit 与 SelfGrade 都调这里，避免两份实现跑偏（曾因同名重复定义踩坑）。
   *
   * 【分层策略，从严到宽，命中即返回】
   *   L1 .confirm-right（平台固定 class，最可靠）
   *   L2 confirm-footer 内确认语义的可见叶子
   *   L3 弹窗容器内 .ant-btn-primary
   *   L4 弹窗容器内确认语义的任意可见叶子
   * 全部**严格限定在可见弹窗容器内**，绝不放宽到全页，避免误点页面其他「确认」文字。
   */
  function findConfirmButtonImpl() {
    const txt = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const isVisible = el => {
      if (!el || el.disabled) return false;
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { return false; }
      if (!r || r.width <= 0 || r.height <= 0) return false;
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { return true; }
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    // 收集可见弹窗容器（优先内层；去掉被包含的外层，避免重复）
    let boxes = [...document.querySelectorAll(
      '.paper-confirm-card .confirm-box, .confirm-box, .ant-modal-body, .ant-modal, [role="dialog"]'
    )].filter(isVisible);
    boxes = boxes.filter(b => !boxes.some(o => o !== b && b.contains(o)));
    if (!boxes.length) return null;

    for (const box of boxes) {
      // L1
      for (const el of box.querySelectorAll('.confirm-right')) {
        if (isVisible(el)) return el;
      }
      // L2
      for (const el of box.querySelectorAll('.confirm-footer span, .confirm-footer button, .confirm-footer div, .confirm-footer a')) {
        if (isVisible(el) && CONFIRM_TEXTS.includes(txt(el))) return el;
      }
      // L3
      for (const el of box.querySelectorAll('.ant-btn-primary')) {
        if (isVisible(el) && txt(el)) return el;
      }
      // L4（只要叶子，避免点到中间容器）
      for (const el of box.querySelectorAll('span, button, .ant-btn, a, div')) {
        if (!isVisible(el)) continue;
        if (el.querySelector('span, button, a')) continue;
        const t = txt(el);
        if (t && CONFIRM_TEXTS.includes(t)) return el;
      }
    }
    return null;
  }

  const AutoSubmit = {
    intervalId: null,
    armed: false,
    pendingConfirm: false,

    isClickable(el) {
      if (!el || el.disabled) return false;
      // 包装 div 不直接点：若内部有真正的 button，交给 button（选择器已优先命中 button）
      if (el.classList.contains('btn-group')) return false;
      if (el.tagName !== 'BUTTON' && el.querySelector('button')) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    },

    /* 节流日志：同样的等待原因每 5 次（约 10 秒）才打一条，避免刷屏。
     * 传 null 表示"已不等待"，清空状态。 */
    throttledLog(msg) {
      const key = msg || null;
      if (key === null) { this._lastWaitMsg = null; this._waitCount = 0; return; }
      if (this._lastWaitMsg !== key) { this._lastWaitMsg = key; this._waitCount = 0; }
      this._waitCount = (this._waitCount || 0) + 1;
      if (this._waitCount === 1 || this._waitCount % 5 === 0) log(msg);
    },

    findSubmitButton() {
      // 1) 精确选择器优先
      for (const sel of SUBMIT_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) {
          if (this.isClickable(el)) return el;
        }
      }
      // 2) 文字兜底
      const nodes = [...document.querySelectorAll('button,div[class*="btn"],span[class*="btn"],a')];
      for (const el of nodes) {
        const t = text(el);
        if (!t || t.length > 12) continue;
        if (!SUBMIT_TEXTS.includes(t)) continue;
        if (this.isClickable(el)) return el;
      }
      return null;
    },

    /* 定位提交确认弹窗的「确认」按钮（AutoSubmit 用）。
     *
     * 【为什么分层】实测确认框主路径是：
     *   .ant-modal-wrap.paper-confirm-card > .ant-modal > … > .confirm-box
     *     .confirm-footer > span.confirm-left（检查一下）/ span.confirm-right（确认）
     *   但平台文案/结构会随版本变化（"已完成全部批改"、"确认提交"…），
     *   旧版本把文案硬编码成正则匹配 → 文案一改就**全部被过滤掉** → 返回 null
     *   → 弹窗点不动（用户反馈的现象）。
     *
     * 【分层策略，从严到宽，命中即返回】
     *   L1 首选 .confirm-right（平台固定 class，最可靠）
     *   L2 confirm-footer 内文案为确认语义的可见叶子
     *   L3 弹窗容器内 .ant-btn-primary
     *   L4 弹窗容器内文案为确认语义的任意可见叶子
     * 所有层都**严格限定在可见弹窗容器内**，绝不放宽到全页，避免误点。
     */
    findConfirmButton() {
      return findConfirmButtonImpl();
    },

    /* ===== 「所有题都已作答」检测 =====
     * 【为什么需要】原来 tick() 只检查"页面上有题目"就点提交 —— 于是脚本刚跑起来、
     *   才答了 1 道题就会把整张卷子交上去。用户要求：**必须全部做完才能提交**。
     *
     * 【实测结构（2026-10-06 语文主观题探测，reportId=2375069824683827778）】
     *   阅读材料 + 一道主观题，DOM 是**三层嵌套**：
     *     <div class="pm-question">
     *       <div class="pm-question-content pm-blanks-normal" id="...349">   ← 材料父级（正文）
     *         <div class="mst-editor-mce-root-block">阅读以下材料…</div>
     *         <div class="pm-question-content pm-blanks-normal pm-question-child" id="...350">  ← 真正的题
     *           <div class="mst-editor-mce-root-block">
     *             <span class="pm-qnum-width">1.</span>
     *             <span>结合文本，分析林语堂"幽默"的文学风格是如何体现的。</span>
     *           </div>
     *         </div>
     *       </div>
     *     </div>
     *   【关键发现】题目节点（…350）内部**只有题干文字，完全没有作答区**！
     *     真正的作答区（上传按钮 / 图片预览）挂在**题目块的兄弟/父级块**上
     *     （与 AutoAnswer 里 parentUploadEls 继承机制是同一现象）。
     *   → 所以"已作答"判定**不能只在题目节点内部找**，必须借 `.pm-question` 外层
     *      或已提交的作答区（`uploadAnchor`）来定位。
     *
     * 逐题判定"已作答"（三类题型各有特征）：
     *   1) 上传型主观题：作图区里出现图片预览（`.ant-upload-list-item-done` / img）
     *      —— 实测页面确实会出现 `ant-upload-list-item-done`。
     *   2) 选择题：选项元素 className 含 selected/active/checked，或内部 radio/checkbox 已勾选。
     *   3) 填空/简答：题块内的 input/textarea 有值（或 contenteditable 有文本）。
     *
     * 【兜底原则】定位不到作答区（纯叙述材料）的题**不算待作答**，避免把材料块
     *   误当成"没做的题"而永远不提交。
     */
    /* 【关键区分】"作答区域"判定必须**精确到题**，不能整块共享。
     *
     * 真实页面上材料父级里挂着作答区（上传按钮），而子题自身内部空无一物。
     * 如果判定时直接扫外层父级，材料下**两个兄弟子题会互相污染** ——
     * 第 1 题传了图，第 2 题也会被算作"已作答"。
     *
     * 正解：AutoAnswer 在解析阶段（collectQuestions）已经**按顺序**把作答容器
     * 分配给对应题目并挂在 el.__ewtAnchor 上；门禁直接复用锚点即可。
     * 所以这里：
     *   · 有锚点 → 只看锚点（绝对精确）
     *   · 无锚点 → 看自身 + 就近配对的兄弟作答区（语法填空 .pmm-xb-line-res）
     */
    // 作答容器选择器（上传/作图区）
    ANS_SEL: '.pm-xb-upload-img-container, .pm-question-upload-box, ' +
             '.pm-upload-oss-wrapper, .pm-upload-oss-box, .pm-subjective-container, ' +
             '[class*="upload-img-container"], [class*="upload-list"]',

    _answerScopes(el, anchor) {
      const scopes = [el];
      if (anchor && anchor !== el) scopes.push(anchor);
      const outer = el.closest('.pm-question');
      if (outer && outer !== el) scopes.push(outer);
      return scopes;
    },

    /* 窄范围：**优先只认锚点**。
     *
     * AutoAnswer 在 collectQuestions 阶段已按顺序把作答容器分配给了对应题目
     * （见 parentUploadEls[parentUploadClaimed]），并挂到 el.__ewtAnchor。
     * 门禁只要复用这个锚点就能精确命中"这道题自己的"作答区，
     * 完全不需要外扩 —— 一外扩就会让材料下兄弟题互相污染。
     *
     * 只有在**没有锚点**时（独立题、非上传型），才退回自身 + 受限兄弟区。
     */
    _localScopes(el, anchor) {
      if (anchor && anchor !== el) return [anchor];
      const scopes = [el];
      /* 语法填空的 .pmm-xb-line-res 与题目块**平级**，但题目块不一定直接挂在
       * 那个共同父级下（实测：<div class="pm-question"><div class="pm-question-content">
       * …</div></div> 与 <div class="pmm-xb-line-res"> 在 body 层同级）。
       * 所以逐层上溯，找"包含 el、且其后紧邻一个 line-res 兄弟"的那一层。 */
      let up = el.parentElement;
      for (let i = 0; i < 4 && up; i++) {
        const kids = [...up.children];
        const idx = kids.indexOf(el);
        // el 直接在这层 → 看紧邻的下一个兄弟
        if (idx >= 0) {
          const next = kids[idx + 1];
          if (next && /xb-line-res|line-res/.test(String(next.className))) { scopes.push(next); break; }
        }
        // el 在这层的后代中 → 找出"位于 el 之后"的第一个 line-res 兄弟
        // （注意方向：用 el.compareDocumentPosition(k) & 4 = k 在 el 之后）
        const after = kids.filter(k => {
          try { return !!(el.compareDocumentPosition(k) & 4); } catch (e) { return false; }
        });
        const sib = after.find(k => /xb-line-res|line-res/.test(String(k.className)));
        if (sib) { scopes.push(sib); break; }
        up = up.parentElement;
      }
      return scopes;
    },

    // 找出题块关联的上传/作答容器
    _findAnswerContainers(el, anchor) {
      const SEL = this.ANS_SEL;
      // 有锚点 → 只用锚点（精确到这道题，杜绝兄弟题互相借用）
      if (anchor && anchor !== el) {
        const list = Array.isArray(anchor) ? anchor : [anchor];
        const out = [];
        for (const a of list) {
          if (!a || a === el || !a.querySelectorAll) continue;
          if (a.matches && a.matches(SEL)) { if (!out.includes(a)) out.push(a); }
          else for (const c of a.querySelectorAll(SEL)) if (!out.includes(c)) out.push(c);
        }
        return this._dedupeNested(out);
      }
      const out = [];
      for (const scope of this._localScopes(el, null)) {
        for (const c of scope.querySelectorAll(SEL)) if (!out.includes(c)) out.push(c);
      }
      return this._dedupeNested(out);
    },

    /* 去掉"被别的匹配项包含"的嵌套节点 —— 否则同一个上传区会因为
     * `.pm-xb-upload-img-container` 和里面的 `.ant-upload-list` 都被命中，
     * 在按顺序分配时把兄弟题的指标错位（实测 F2 场景误判的直接原因）。 */
    _dedupeNested(nodes) {
      return nodes.filter(n => !nodes.some(o => o !== n && o.contains(n)));
    },

    _isQuestionAnswered(el, anchor) {
      const scopes = this._localScopes(el, anchor);

      // ① 上传型：作容器里出现预览图 / 上传完成标记
      for (const box of this._findAnswerContainers(el, anchor)) {
        if (box.querySelector('.ant-upload-list-item-done, .ant-upload-list-item-card-actions, img[src^="http"], img[src^="data:"]')) {
          return true;
        }
      }

      // ② 选择题：选中态（只用窄范围，防兄弟题污染）
      for (const scope of scopes) {
        const optEls = scope.querySelectorAll(
          '.pm-ewt-option-item, [class*="option-item"], [class*="optionItem"], .ant-radio-wrapper, .ant-checkbox-wrapper'
        );
        for (const o of optEls) {
          if (/(^|[\s-])(selected|active|checked)([\s-]|$)/i.test(String(o.className))) return true;
          const inp = o.querySelector('input[type="radio"], input[type="checkbox"]');
          if (inp && inp.checked) return true;
        }
      }

      // ③ 填空/简答：输入框有内容（排除脚本面板与文件框，同样只用窄范围）
      for (const scope of scopes) {
        for (const inp of scope.querySelectorAll('input, textarea')) {
          if (inp.closest('#ewt-study-helper-root')) continue;
          const t = (inp.getAttribute('type') || 'text').toLowerCase();
          if (t === 'checkbox' || t === 'radio' || t === 'hidden' || t === 'file') continue;
          if (String(inp.value || '').trim()) return true;
        }
        for (const ce of scope.querySelectorAll('[contenteditable="true"]')) {
          if (clean(ce.innerText || ce.textContent || '')) return true;
        }
      }

      // ④ 平台显式状态类兜底
      if (/(^|[\s-])(answered|has-answer|is-answer|completed)([\s-]|$)/i.test(String(el.className))) return true;
      return false;
    },

    /* 判断这道题「是否本来就需要作答」。
     * 只有"本身带作答控件"的题才纳入待作答统计 —— 否则纯材料块会被永远判为未完成。 */
    _needsAnswer(el, anchor) {
      // 有作答容器（上传区）
      if (this._findAnswerContainers(el, anchor).length) return true;
      // 有选项
      if (el.querySelector('.pm-ewt-option-item, [class*="option-item"], [class*="optionItem"], .ant-radio-wrapper, .ant-checkbox-wrapper')) return true;
      // 有可见输入框
      for (const inp of el.querySelectorAll('input, textarea')) {
        if (inp.closest('#ewt-study-helper-root')) continue;
        const t = (inp.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox' || t === 'radio' || t === 'hidden' || t === 'file') continue;
        return true;
      }
      if (el.querySelector('[contenteditable="true"]')) return true;
      // 语法填空：作答区是兄弟节点 .pmm-xb-line-res
      let up = el.parentElement;
      for (let i = 0; i < 3 && up; i++) {
        if (up.querySelector('.pmm-xb-line-res, [class*="xb-line-res"], [class*="line-res"]')) return true;
        up = up.parentElement;
      }
      return false;
    },

    /* 返回 {total, answered, pending:[题号]}；判不出题目时返回 null（不阻塞提交） */
    allAnswered() {
      /* 【坑1】`.pm-question` 与 `.pm-question-content` 常常是**父子关系**
       *   （<div class="pm-question"><div class="pm-question-content" id="ewt-question-N">），
       *   一起收集会让外层把内层"吞掉"，导致把外层当非叶子丢弃 → 结果一道题都不剩。
       *   所以：优先取 `.pm-question-content`（真正的题目节点），没有再退回 `.pm-question`。
       *
       * 【坑2】题目节点是**嵌套**的：材料父级里包着子题（.pm-question-child）。
       *   不能简单"有内部题目节点就跳过" —— 那样会把材料里唯一的子题也丢掉，
       *   导致统计到 0 道题 / 或误判。正确做法：**取最内层的那些题**（自身不含别的题目节点），
       *   材料父级本身不计数，但它内部的子题要计数。
       */
      let candidates = [...document.querySelectorAll('.pm-question-content')];
      if (!candidates.length) candidates = [...document.querySelectorAll('.pm-question')];
      if (!candidates.length) candidates = [...document.querySelectorAll('div[id^="ewt-question-"]')];

      const leaves = [];
      const seen = new Set();
      for (const el of candidates) {
        const inner = [...el.querySelectorAll('.pm-question-content, .pm-question, div[id^="ewt-question-"]')]
          .filter(n => n !== el);
        if (inner.length) continue;          // 材料父级，跳过（它的子题会被单独收到）
        const key = el.id || el;
        if (seen.has(key)) continue;
        seen.add(key);
        leaves.push(el);
      }

      /* 【坑3】作答区常常**不在题目节点内部**，而在其材料父级/同级上
       *   （语文主观题：父级块里挂上传区，子题自己空无一物）。
       *   仅靠 el.__ewtAnchor 不够 —— 那个锚点是 AutoAnswer 解析阶段挂的，
       *   若解析尚未跑过（或题目被重新渲染）就取不到。
       *   这里做一次**兜底顺序分配**：对每个"材料父级"，把它名下的作答容器
       *   按文档顺序配给它名下的子题；一个容器只配一道题，杜绝兄弟题互相借用。
       */
      const anchorMap = new Map();   // leafEl → 作答容器
      const parents = [...document.querySelectorAll('.pm-question, .pm-question-content')]
        .filter(p => p.querySelector('.pm-question-child, .pm-question'));
      for (const p of parents) {
        const boxes = this._dedupeNested([...p.querySelectorAll(this.ANS_SEL)]);
        if (!boxes.length) continue;
        const kids = leaves.filter(el => p.contains(el));
        // 只有"多个子题 + 有作答容器"时才需要消歧；单子题直接全给它
        if (kids.length <= 1) {
          if (kids.length === 1) anchorMap.set(kids[0], boxes.length === 1 ? boxes[0] : boxes);
          continue;
        }
        if (boxes.length >= kids.length) {
          kids.forEach((k, i) => anchorMap.set(k, boxes[i]));
        } else if (boxes.length === 1) {
          // 平台通常只放一个共用作答位 → 只配给第一个子题，避免全部误判
          // （后续子题无独立作答区 → _needsAnswer 可能判其不需作答）
          anchorMap.set(kids[0], boxes[0]);
        }
      }

      // 只保留"本来就需要作答"的题（纯材料叙述块不算），并绑定作答锚点
      const list = leaves.filter(el => {
        const anchor = el.__ewtAnchor || anchorMap.get(el);
        if (!anchor) return this._needsAnswer(el, null);
        // 有锚点 → 直接算作需作答（锚点本身就说明分配到了作答区）
        return true;
      });
      if (!list.length) return null;

      const pending = [];
      let answered = 0;
      list.forEach((el, i) => {
        const anchor = el.__ewtAnchor || anchorMap.get(el) || null;
        if (this._isQuestionAnswered(el, anchor)) answered++;
        else {
          // 题号：去掉尾部的点/顿号（"1." → "1"）
          const raw = clean(el.querySelector('.pm-qnum-width')?.textContent || '')
            .replace(/[.．、]\s*$/, '').trim();
          pending.push(raw || String(i + 1));
        }
      });
      return { total: list.length, answered, pending };
    },

    tick() {
      try {
        // 阶段二：等确认弹窗
        if (this.pendingConfirm) {
          const confirm = this.findConfirmButton();
          if (confirm) {
            confirm.click();
            log('已确认提交弹窗');
            this.pendingConfirm = false;
            this.armed = false;
            setToggle('autoSubmit', false); // 提交完成自动关闭，防重复
          } else {
            this.confirmWaited = (this.confirmWaited || 0) + 1;
            // 每 5 次（约 10 秒）提示一次，避免刷屏
            if (this.confirmWaited === 1 || this.confirmWaited % 5 === 0) {
              log(`等待提交确认弹窗…（已等 ${this.confirmWaited * 2}s）`);
            }
            // 【兜底】等了 30s（约 15 次）仍找不到确认按钮 → 可能弹窗结构变了，
            //   或者刚才那次点击没生效。重置标记，让下一轮重新点一次提交按钮。
            if (this.confirmWaited >= 15) {
              log('⚠ 确认弹窗超时未找到，重置后重新尝试点击提交…');
              const b = this.findSubmitButton();
              if (b) delete b.dataset.ewtSubmitting;
              this.pendingConfirm = false;
              this.confirmWaited = 0;
            }
          }
          return;
        }
        if (!this.armed) return;
        const btn = this.findSubmitButton();
        if (!btn) { log('未找到「提交试卷」按钮，等待中…'); return; }
        if (btn.dataset.ewtSubmitting) return;
        // 防误触：页面上必须确实存在题目
        if (!document.querySelector('.pm-question, .examination-paper-answer')) {
          log('页面上未检测到题目，跳过');
          return;
        }

        // 【关键 1】自动做题器还在跑 → 绝不提交（否则会把做了一半的卷子交上去）
        if (typeof AutoAnswer !== 'undefined' && AutoAnswer.running) {
          this.throttledLog('⏳ 自动作答进行中，等做完再提交…');
          return;
        }

        // 【关键 2】所有题都必须"确实判为已作答完"才提交。
        //   allAnswered() 返回 null = 判不出题（DOM 还没渲染好 / 结构不认识），
        //   这时**必须视为"还没做完"**，不能放行 —— 否则做题过程中页面一时
        //   解析不出题目就会立刻点提交。宁可等着，也不能误交。
        const st = this.allAnswered();
        if (!st) {
          this.throttledLog('⏳ 暂时判不出题目结构，等页面稳定后再提交…');
          return;
        }
        if (st.answered < st.total) {
          this.throttledLog(`⏳ 还有 ${st.total - st.answered}/${st.total} 题未作答（未作答：${st.pending.join('、')}），等做完再提交…`);
          return;
        }
        if (st.total === 0) {
          this.throttledLog('⏳ 统计到 0 道题，暂不提交…');
          return;
        }
        this.throttledLog(null);   // 都答完了，清掉节流状态

        btn.dataset.ewtSubmitting = 'true';
        btn.click();
        log(`已点击提交按钮 (${btn.className || btn.tagName})，等待确认弹窗…`);
        this.pendingConfirm = true;
        this.confirmWaited = 0;
      } catch (e) { log('自动提交出错：' + e.message); }
    },

    start() {
      if (this.intervalId) return;
      this.armed = true;
      this.pendingConfirm = false;
      this.intervalId = setInterval(() => this.tick(), 2000);
      log('自动提交已开启（检测到「提交试卷」即点，并自动确认弹窗）');
    },

    stop() {
      this.armed = false;
      this.pendingConfirm = false;
      if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; log('自动提交已关闭'); }
    },

    toggle(on) { on ? this.start() : this.stop(); }
  };

  /* ============ 自批满分（analysis 页「请批改」弹窗） ============
   * 实测结构（2026-10-06，reportId=2375027630925103493）：
   *   自批不是独立页面，而是提交后弹出的浮层：
   *     <div class="proofreadPopModal">
   *       <div class="proofreadPopModal_header">
   *         <span class="proofreadPopModal_header_progressing_count">0/1题</span>   ← 进度
   *         <div class="..._exit_btn"></div>                                     ← 退出
   *       <div class="content-left-scroll"><ul>
   *         <li id="content-left-question-num-0"
   *             class="content-left-question content-left-question-noAnswer content-left-question-pitch">1</li>
   *         └ 状态类：-noAnswer（未批改）/ 批改后变化
   *       <div class="content-right">
   *         <h5 class="content-right-title">请批改</h5>
   *         <div class="content-right-scroll">
   *           <ul></ul>                            ← 「打分」形式：分数档位 li 渲染在这里
   *           <div class="content-right-has">      ← 「对/半对/错」形式：三个无文本 div
   *             <div class="content-right-pub content-right-has-err"></div>     ← 错
   *             <div class="content-right-pub content-right-has-half"></div>    ← 半对
   *             <div class="content-right-pub content-right-has-success"></div> ← 对
   *   三个按钮都【没有文字】—— 靠 class 区分，不能按文本找。
   *
   * 策略：
   *   1) 打分形式（.content-right-scroll ul 里有 li）→ 点最后一个 li（最高档＝满分）
   *   2) 对错形式 → 点 .content-right-has-success
   *   3) 每题批完用「进度计数」或「题号 class」变化验证，未变化则判失败
   *   4) 自动切题：点完当前题若进度没满，点下一个 content-left-question
   */
  const SelfGrade = {
    running: false,
    stopFlag: false,
    minDelay: 700,        // 每次点击后的基础等待
    maxRounds: 60,        // 最多处理 60 题，防死循环

    getDialog() {
      return document.querySelector('.proofreadPopModal') ||
             document.querySelector('[class*="proofreadPopModal"]');
    },

    // 进度计数 "0/1题" → {done:0, total:1}；已全部批完时文本是「全部已自批」
    // 实测：批完 1 题后 progressing_count.textContent === "全部已自批"
    readProgress(dlg) {
      const t = text(dlg?.querySelector('.proofreadPopModal_header_progressing_count'));
      if (/全部已自批|已全部自批/.test(t)) return { done: 1, total: 1, all: true };
      const m = /(\d+)\s*\/\s*(\d+)/.exec(t);
      return m ? { done: +m[1], total: +m[2], all: false } : null;
    },

    // 题号列表：[{el, label, answered, current}]
    // 实测状态类：
    //   未批改 → "content-left-question content-left-question-noAnswer ..."
    //   已批改 → "... content-left-question-success ..."（noAnswer 可能残留，故以 success 为准）
    listQuestions(dlg) {
      return [...dlg.querySelectorAll('.content-left-question')].map(el => {
        const c = String(el.className);
        return {
          el,
          label: text(el),
          // 以 success / err / half 任一出现即为"已批改"
          answered: /content-left-question-(success|err|half|part)/.test(c),
          current: /pitch/.test(c),
        };
      });
    },

    // 找「批改打分」区域里真正要点的元素
    findGradeTarget(dlg) {
      const right = dlg.querySelector('.content-right');
      if (!right) return { kind: 'none', el: null };

      // 形式一：打分档位（ul 里有 li）—— 满分 = 最后一档
      const ul = right.querySelector('.content-right-scroll ul');
      if (ul) {
        const lis = [...ul.querySelectorAll('li')].filter(li => li.getBoundingClientRect().width > 0 || li.children.length || li.textContent.trim());
        if (lis.length) return { kind: 'score', el: lis[lis.length - 1], candidates: lis };
      }

      // 形式二：对 / 半对 / 错（无文本 div，靠 class）—— 选「对」
      const hasBox = right.querySelector('.content-right-has');
      if (hasBox) {
        const ok = hasBox.querySelector('.content-right-has-success') || hasBox.querySelector('.content-right-pub');
        if (ok) return { kind: 'judge', el: ok };
      }
      return { kind: 'none', el: null };
    },

    // 该按钮是否已被选中（实测选中态加 selectPitch-success / selectPitch-*）
    isSelected(el) {
      return /selectPitch/.test(String(el?.className));
    },

    clickEl(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const opts = {
        bubbles: true, cancelable: true, view: window, button: 0,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      };
      try {
        el.dispatchEvent(new MouseEvent('mouseover', opts));
        el.dispatchEvent(new MouseEvent('mousemove', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return true;
      } catch (e) {
        try { el.click(); return true; } catch (e2) { return false; }
      }
    },

    // 点当前题号，切到该题（内容区右侧批改按钮只对当前题生效）
    async waitGradeDone(before, timeoutMs = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await new Promise(r => setTimeout(r, 250));
        const dlg = this.getDialog();
        if (!dlg) return false;
        // 判据1：进度文本变化（"全部已自批" 或 done 增加）
        const p = this.readProgress(dlg);
        if (p && before) {
          if (p.all && !before.all) return true;
          if (p.done > (before.done || 0)) return true;
          if (p.total > 0 && p.done >= p.total && before.done < p.total) return true;
        }
        // 判据2：已批改题数增加（最可靠，实测标在题号 li 的 class 上）
        const answeredNow = this.listQuestions(dlg).filter(x => x.answered).length;
        if (before && answeredNow > (before.answeredCount || 0)) return true;
        // 判据3：目标按钮出现选中态
        const g = this.findGradeTarget(dlg);
        if (g.el && this.isSelected(g.el) && before && !before.selected) return true;
      }
      return false;
    },

    async run() {
      if (this.running) return;
      this.running = true;
      this.stopFlag = false;
      this._submitted = false;
      this._confirmed = false;
      this._skipSet = new Set();
      log('开始自批…');

      let ok = 0, fail = 0, lastHandled = '';
      try {
        for (let round = 0; round < this.maxRounds; round++) {
        if (this.stopFlag) { log('自批已中止'); break; }
        const dlg = this.getDialog();
        if (!dlg) { log('未检测到自批弹窗（.proofreadPopModal），请先进入自批界面'); break; }

        const qs = this.listQuestions(dlg);
        const prog = this.readProgress(dlg);
        // 全部批完 → 结束
        if (prog && prog.all) { log('自批进度已满（全部已自批）'); break; }
        if (prog && prog.total > 0 && prog.done >= prog.total) { log(`自批进度已满（${prog.done}/${prog.total}）`); break; }
        const skipped = this._skipSet || new Set();
        const pending = qs.filter(q => !q.answered && !skipped.has(q.label));
        if (!pending.length) { log('没有待批改题目了'); break; }

        const target = pending[0];

        // 切到该题（点该题号，批改按钮只对当前题生效）
        if (!target.current) {
          this.clickEl(target.el);
          await new Promise(r => setTimeout(r, this.minDelay));
        }

        const dlg2 = this.getDialog();
        if (!dlg2) break;
        const g = this.findGradeTarget(dlg2);
        if (!g.el) {
          // 该题找不到批改按钮（未知题型/还在渲染）→ 记一次，跳过它，别中断整个流程
          if (lastHandled === target.label + '|none') {
            log(`⚠ 题 ${target.label} 连续两次找不到批改按钮，跳过`);
            fail++;
            // 用 done 集合避免反复选中同一题
            this._skipSet = this._skipSet || new Set();
            this._skipSet.add(target.label);
            lastHandled = '';
          } else {
            lastHandled = target.label + '|none';
            await new Promise(r => setTimeout(r, 500));   // 等它渲染
          }
          continue;
        }

        // 防重复处理同一题
        const sig = target.label + '|' + g.kind;
        if (sig === lastHandled) {
          log(`⚠ 题 ${target.label} 点击后状态未变化，停止以避免死循环`);
          fail++; break;
        }
        lastHandled = sig;

        const before = this.readProgress(dlg2) || {};
        before.answeredCount = this.listQuestions(dlg2).filter(x => x.answered).length;
        before.selected = this.isSelected(g.el);

        log(`批改第 ${target.label} 题（形式：${g.kind === 'score' ? '打分-取最高档(满分)' : '对/半对/错-选“对”'}）…`);
        this.clickEl(g.el);

        const done = await this.waitGradeDone(before, 8000);
        if (done) { ok++; log(`  ✓ 第 ${target.label} 题已批（对/满分，已加 ${g.kind === 'score' ? '最高分' : 'success'}）`); }
        else { fail++; log(`  ✗ 第 ${target.label} 题批改后状态未变化（可能未生效）`); }

        await new Promise(r => setTimeout(r, 300));
      }

      const dlgEnd = this.getDialog();
      const pe = this.readProgress(dlgEnd);
      const allDone = pe && (pe.all || (pe.total > 0 && pe.done >= pe.total));
      log(`自批结束：成功 ${ok}，失败 ${fail}${pe ? `，进度 ${pe.all ? '全部已自批' : `${pe.done}/${pe.total}`}` : ''}`);

      // 全部批完 → 点「提交全部自批」并确认（监视器也会兜底，用锁防重复）
      if (allDone && ok > 0 && !this.stopFlag && !this._submitted) {
        log('全部已自批，准备提交…');
        await new Promise(r => setTimeout(r, 800));
        await this.submitAll();
      }
      } catch (e) {
        log('⚠ 自批过程出错：' + (e && e.message ? e.message : e));
      } finally {
        this.running = false;
      }
    },

    /* ---- 提交全部自批 ----
     * 实测（2026-10-06）按钮真身：
     *   <div class="content-main-footer_submit_btn content-main-footer_submit_btn_full">
     *     提交全部自批
     *   </div>
     *   它是 <div>（cursor:pointer / onclick=true），不带 ant-btn。
     * 定位优先级：
     *   1) .content-main-footer_submit_btn_full 精确类
     *   2) footer 内文字「提交全部自批」
     *   3) 弹窗内文字含「提交全部自批」的可点元素
     *   一律排除「不自批了，直接提交」。
     */
    SUBMIT_TEXTS: ['提交全部自批'],

    findSubmitAllButton() {
      const dlg = this.getDialog();
      if (!dlg) return null;
      const isVisible = el => el && el.getBoundingClientRect().width > 0 && !el.disabled;
      const isNotSkip = el => !/不自批|不批改/.test(text(el));

      // 1) 精确类名（实测命中）
      for (const el of dlg.querySelectorAll('.content-main-footer_submit_btn_full, .content-main-footer_submit_btn')) {
        if (isVisible(el) && isNotSkip(el)) return el;
      }

      // 2) footer 内按文字
      const foot = dlg.querySelector('.content-main-footer, footer');
      if (foot) {
        for (const el of foot.querySelectorAll('div, span, button, .ant-btn')) {
          if (el.children.length > 1) continue;
          if (isVisible(el) && isNotSkip(el) && /提交全部自批/.test(text(el))) return el;
        }
      }

      // 3) 弹窗内按文字「提交全部自批」
      for (const el of dlg.querySelectorAll('div, span, button, .ant-btn')) {
        if (el.children.length > 1) continue;
        if (isVisible(el) && isNotSkip(el) && text(el) === '提交全部自批') return el;
      }
      return null;
    },


    // 确认弹窗按钮定位
    // 实测（2026-10-06）确认框结构：
    //   <div class="ant-modal-wrap paper-confirm-card">
    //     <div role="dialog" class="ant-modal" style="width:440px">
    //       <div class="ant-modal-content"><div class="ant-modal-body">
    //         <div class="confirm-box">
    //           <div class="confirm-title">已完成全部批改</div>
    //           <div class="confirm-subtitle">你已完成全部批改，确认提交吗？</div>
    //           <div class="confirm-footer">
    //             <span class="confirm-left">检查一下</span>
    //             <span class="confirm-right">确认</span>   ← 要点的
    //   【坑1】它是 <span>，不是 button / .ant-btn
    //   【坑2】必须严格限定在确认框容器内！否则全页的「提交」「确认」字样会误匹配
    CONFIRM_TEXTS: ['确认', '确定', '确认提交', '确定提交', '好的', '是', '提交'],
    /* 定位提交确认弹窗的「确认」按钮。
     *
     * 【为什么分层】实测确认框主路径是：
     *   .ant-modal-wrap.paper-confirm-card > .ant-modal > … > .confirm-box
     *     .confirm-footer > span.confirm-left（检查一下）/ span.confirm-right（确认）
     *   但平台文案/结构会随版本变化（"已完成全部批改"、"确认提交"…），
     *   早期版本把文案硬编码成 /确认提交|已完成全部批改/ → 文案一变就**全部被过滤掉**
     *   → 返回 null → 弹窗点不动（这正是用户反馈的现象）。
     *
     * 【分层策略，从严到宽，命中即返回】
     *   L1 首选 .confirm-right（平台固定 class，最可靠）
     *   L2 confirm-footer 内文案为确认语义的可见叶子
     *   L3 弹窗容器内 .ant-btn-primary
     *   L4 弹窗容器内文案为确认语义的任意可见 span/button/div（不再要求特定文案正则）
     * 所有层都**严格限定在可见弹窗容器内**，绝不放宽到全页，避免误点。
     */
    /* 定位提交确认弹窗的「确认」按钮。
     * 复用外层共享实现 findConfirmButtonImpl()，与 AutoSubmit 保持同一套逻辑。
     */
    findConfirmButton() {
      return findConfirmButtonImpl();
    },



    // 是否存在确认弹窗（用于监视器判断）
    hasConfirmDialog() {
      return !!this.findConfirmButton();
    },

    async submitAll() {
      // 已点过确认 → 彻底结束
      if (this._confirmed) return true;

      // 还没点过「提交全部自批」→ 先点它
      if (!this._submitted) {
        const btn = this.findSubmitAllButton();
        if (!btn) { log('⚠ 未找到「提交全部自批」按钮（可能未出现或已提交）'); return false; }
        this._submitted = true;
        if (typeof AutoSelfGradeWatch !== 'undefined') AutoSelfGradeWatch.submitted = true;
        log(`→ 点击「${text(btn) || btn.className}」`);
        this.clickEl(btn);
      }

      // 等确认弹窗并点它（最多 10 秒）
      const t0 = Date.now();
      while (Date.now() - t0 < 10000) {
        await new Promise(r => setTimeout(r, 300));
        const cf = this.findConfirmButton();
        if (cf) {
          log(`→ 确认弹窗，点击「${text(cf) || '确认'}」`);
          this.clickEl(cf);
          // 等 600ms 验证是否真的消失
          await new Promise(r => setTimeout(r, 600));
          if (!this.findConfirmButton()) {
            this._confirmed = true;
            if (typeof AutoSelfGradeWatch !== 'undefined') {
              AutoSelfGradeWatch.confirmed = true;
              AutoSelfGradeWatch._confirmed = true;
            }
            log('✓ 确认弹窗已关闭');
            break;
          }
          log('  …确认框仍在，重试点击');
          continue;
        }
        // 没有确认框 + 自批弹窗也消失 = 流程结束
        if (!this.getDialog()) {
          this._confirmed = true;
          if (typeof AutoSelfGradeWatch !== 'undefined') AutoSelfGradeWatch.confirmed = true;
          log('→ 自批弹窗已关闭，提交完成');
          return true;
        }
      }
      
      await new Promise(r => setTimeout(r, 1200));
      const stillThere = !!this.getDialog();
      if (!stillThere) log('✓ 自批已完成并提交');
      else if (this._confirmed) log('✓ 已点击提交并确认');
      else log('⚠ 未检测到确认弹窗（可能在右侧/需手动确认）');
      return true;
    },

    start() { if (this.running) return; this.run(); },
    stop() { this.stopFlag = true; log('自批已停止'); },
    toggle(on) { on ? this.start() : this.stop(); },
  };

  /* ============ 自批监视器 ============
   * 自批弹窗（.proofreadPopModal）是提交后按需弹出的，页面初始不存在。
   * 打开「自批满分」开关后，轮询等待弹窗出现，第一次出现时自动跑一次 SelfGrade，
   * 保证"提交完就能自动满分"，不需要手动再点按钮。
   */
  const AutoSelfGradeWatch = {
    intervalId: null,
    grading: false,     // 是否正在批改
    submitted: false,   // 是否已点过「提交全部自批」
    confirmed: false,   // 是否已点过确认

    check() {
      const dlg = SelfGrade.getDialog();

      // 【最优先】确认弹窗：只要它还在，就点它（点完验证是否消失，没消失下轮继续）
      const cf = SelfGrade.findConfirmButton();
      if (cf) {
        log(`→ 检测到确认弹窗，点击「${text(cf) || '确认'}」`);
        SelfGrade.clickEl(cf);
        this.confirmed = true;
        SelfGrade._confirmed = true;
        return;
      }

      if (!dlg) { this.grading = false; return; }
      if (!dlg.querySelector('.content-right')) return;   // 弹窗内部还没渲染好，下轮再看

      const prog = SelfGrade.readProgress(dlg);
      const allDone = prog && (prog.all || (prog.total > 0 && prog.done >= prog.total));

      // 阶段一：还没批完 → 启动批改
      // 注意：SelfGrade.run() 结束后 running=false。若进度仍未满（有题打不开等），
      //       需要允许重试，否则会永久卡住。用时间戳做 3 秒节流，避免疯狂重启。
      if (!allDone) {
        const canStart = !SelfGrade.running &&
          (!this.grading || (Date.now() - (this.gradingAt || 0) > 3000));
        if (canStart) {
          this.grading = true;
          this.gradingAt = Date.now();
          log('检测到自批弹窗，自动开始自批满分…');
          SelfGrade.start();
        }
        return;
      }

      // 阶段二：全部已自批 → 自动提交（找不到按钮就下轮再看）
      if (allDone && !this.confirmed) {
        const btn = SelfGrade.findSubmitAllButton();
        if (!btn && SelfGrade._submitted) return;   // 已点过提交，等确认框
        if (!btn) return;                            // 提交按钮还没渲染出来，下轮再看
        if (!this.submitted) {
          this.submitted = true;
          log('检测到「全部已自批」，自动提交…');
        }
        SelfGrade.submitAll();
      }
    },

    start() {
      if (this.intervalId) return;
      this.grading = false;
      this.gradingAt = 0;
      this.submitted = false;
      this.confirmed = false;
      this.check();
      this.intervalId = setInterval(() => {
        try { this.check(); } catch (e) { console.warn('[EWT] 自批 check 异常', e); }
      }, 1200);
      log('「自批满分」已就绪：提交后弹出自批框时自动批改并提交');
    },

    // 幂等启动：无论开关状态，确保轮询在跑（供全局弹窗探测器调用）
    ensureRunning() {
      if (this.intervalId) return;      // 已在跑，交给它自己的轮询
      this.start();
      // 同步面板复选框显示为已勾选
      const el = document.querySelector(`#${APP}-root [data-t="autoSelfGrade"]`);
      if (el) el.checked = true;
    },

    stop() {
      if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
      this.grading = false;
      this.submitted = false;
      this.confirmed = false;
      SelfGrade.stop();
      log('「自批满分」已关闭');
    },

    toggle(on) { on ? this.start() : this.stop(); },
  };

  /* ============ 自动作答 ============
   * 实测结构（web.ewt360.com/answer-pc/exam/answer）：
   *   每题：div[id^="ewt-question-"].pm-question-content
   *   题型：含 .pm-question-options 的为选择题，选项节点 .pm-ewt-option-item
   *         无选项的为简答/填空（mst-editor 富文本）
   *   作答区可能在点击选项/点击答题框后才出现，故需要"发现→作答"两阶段。
   */
  /* ---- html2canvas 动态加载器 ----
   * 用途：bizCode=205 这类数学题，所有数学符号都是 <img class="Wirisformula">，
   *       服务端把 MathML 用 JEuclid 转成了 SVG，字形是 <path> 矢量，没有 <text>，
   *       所以 innerText 只能拿到被抠掉符号的残句（"已知向量，，则…"）。
   *       纯文本无解 → 把整道题当图片渲染出来，交给视觉模型直接读。
   * 来源：CDN 优先（jsdelivr → unpkg），失败则用 bridge 的 GM_xmlhttpRequest 兜底。
   */
  const Html2Canvas = {
    lib: null,
    loading: null,
    CDN: [
      'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
      'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
    ],

    // 注入 <script>，成功返回全局对象
    inject(url) {
      return new Promise((ok, no) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        const to = setTimeout(() => { s.remove(); no(new Error('加载超时')); }, 15000);
        s.onload = () => {
          clearTimeout(to);
          if (typeof window.html2canvas === 'function') ok(window.html2canvas);
          else no(new Error('脚本已加载但未暴露 html2canvas'));
        };
        s.onerror = () => { clearTimeout(to); s.remove(); no(new Error('script 加载失败')); };
        (document.head || document.documentElement).appendChild(s);
      });
    },

    // 通过 bridge 用 GM_xmlhttpRequest 拿源码，再 eval（绕 CSP / 弱网）
    async viaBridge(url) {
      const src = await LLM.fetchText(url);
      // eslint-disable-next-line no-new-func
      new Function(src + '\n//# sourceURL=' + url)();
      if (typeof window.html2canvas !== 'function') throw new Error('eval 后仍未暴露 html2canvas');
      return window.html2canvas;
    },

    async load() {
      if (this.lib) return this.lib;
      if (this.loading) return this.loading;
      this.loading = (async () => {
        let lastErr = '';
        for (const url of this.CDN) {
          try { this.lib = await this.inject(url); return this.lib; }
          catch (e) { lastErr = `${url} → ${e.message}`; }
        }
        // 兜底：走 bridge 抓源码
        try { this.lib = await this.viaBridge(this.CDN[0]); return this.lib; }
        catch (e) { lastErr += ` ｜ bridge → ${e.message}`; }
        throw new Error(`html2canvas 加载失败（${lastErr}）`);
      })();
      try { return await this.loading; } finally { this.loading = null; }
    },
  };

  const AutoAnswer = {
    running: false,
    stopFlag: false,
    doneSet: new Set(),

    // 取一道题：题干文本 + 选项文本 + 材料
    parseQuestion(qEl) {
      const id = qEl.id;
      // 题干：去掉选项区和分数标记（innerText 在隐藏元素/部分环境取不到，兜底 textContent）
      const clone = qEl.cloneNode(true);
      clone.querySelectorAll('.pm-question-options, .pm-question-score, .pm-qnum-width, .paper-question-footer').forEach(n => n.remove());

      /* 语法填空：<span class="mst-question-answer-placeholder">X</span> 是**只读回显位**。
       *   空题时内容是空位编号（"1"），已作答时内容是上次的答案（"Covering"）。
       *   它对模型都是噪声：
       *     - 显示 "1" 会污染题干（"1.1 (cover) an area..."）
       *     - 显示 "Covering" 会直接被模型抄成答案（其实题目要求自己填）
       *   统一替换成下划线空位标记，并去掉紧随的空格，避免 "____ (cover)" 变 "____(cover)" 无所谓，
       *   但要去掉题号宽度的残留。 */
      clone.querySelectorAll('.mst-question-answer-placeholder, [class*="answer-placeholder"]')
        .forEach(n => { n.textContent = ' ____ '; });
      const raw = clone.innerText || clone.textContent || '';
      const question = clean(raw).slice(0, 1500);

      // 选项：多策略（不同页面模板 class 可能不同）
      let optionEls = [...qEl.querySelectorAll('.pm-ewt-option-item')];
      if (!optionEls.length) optionEls = [...qEl.querySelectorAll('[class*="option-item"],[class*="optionItem"]')];
      if (!optionEls.length) optionEls = [...qEl.querySelectorAll('.ant-radio-wrapper,.ant-checkbox-wrapper')];
      const options = optionEls.map(o => {
        const tag = clean(o.querySelector('.pm-tag-letter,[class*="tag-letter"]')?.textContent || '');
        const content = clean(o.querySelector('.pm-ewt-option-content,[class*="option-content"]')?.textContent || o.innerText || '');
        return content || tag;
      }).filter(Boolean);

      // 上传型题（主观题）：题目块内含 .pm-xb-upload-img-container / .pm-question-upload-box
      const isUpload = !!qEl.querySelector(
        '.pm-xb-upload-img-container, .pm-question-upload-box, .pm-upload-oss-wrapper, [class*="upload-img-container"]'
      );

      return { id, question, options, optionEls, isChoice: optionEls.length > 0, isUpload, imgEls: this.findImages(qEl) };
    },

    // 找题目相关的图片（排除选项里的小图标、表情等）
    findImages(qEl) {
      const imgs = [...qEl.querySelectorAll('img')].filter(im => {
        const src = im.src || '';
        if (!src) return false;
        // 排除明显的 UI 图标
        if (/(icon|logo|avatar|emoji|sprite)/i.test(src + im.className)) return false;
        // 尺寸过滤：太小的多半是图标
        const w = im.naturalWidth || im.width || 0;
        const h = im.naturalHeight || im.height || 0;
        if (w && h && w < 60 && h < 60) return false;
        return true;
      });
      return imgs;
    },

    // 把一张图转成 dataURL
    // 关键坑：EWT 的题目图是 http://file.ewt360.com/...，
    // 而页面是 https，浏览器 Mixed Content 策略会直接拦掉 http 资源（不是防盗链！）。
    // 解法：一律把 http 升级为 https —— 实测 https://file.ewt360.com/... 会 302 到
    //        https://img2.ewt360.com/...，且目标带 Access-Control-Allow-Origin: *。
    httpCandidates(src) {
      const list = [];
      if (src.startsWith('http://')) list.push('https://' + src.slice(7));
      list.push(src);
      return [...new Set(list)];
    },

    /* 把任意 Image 元素栅格化成 PNG dataURL（保证大模型能吃的格式）。
     * 智谱 vision 只接受 png/jpeg/webp/gif， SVG / avif 等会被直接拒绝（错误码 1210）。
     * 策略：优先 canvas 绘制（对同源或已带 CORS 头的图有效），
     *       canvas 被污染时退化为 fetch 拿 blob → 用 createImageBitmap 重新绘制。 */
    async rasterizeToPng(im) {
      const draw = (source, w, h) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(source, 0, 0, w, h);
        return c.toDataURL('image/png'); // 若污染会抛异常
      };
      const w = im.naturalWidth || im.width;
      const h = im.naturalHeight || im.height;
      if (!(w > 4 && h > 4)) throw new Error('尺寸过小');
      // 1) 直接绘制原 img 元素
      try { return draw(im, w, h); } catch (e) { /* 污染，走 fetch */ }
      // 2) fetch 成 blob → FileReader → Image → 绘制
      const candidates = this.httpCandidates(im.src || '').sort((a, b) => (b.startsWith('https') ? 1 : 0) - (a.startsWith('https') ? 1 : 0));
      let lastErr = '';
      for (const url of candidates) {
        try {
          const res = await fetch(url, { credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer' });
          if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
          const blob = await res.blob();
          const objUrl = URL.createObjectURL(blob);
          try {
            const img2 = await new Promise((ok, no) => {
              const i = new Image();
              i.onload = () => ok(i);
              i.onerror = () => no(new Error('图片解码失败'));
              i.src = objUrl;
            });
            return draw(img2, img2.naturalWidth || w, img2.naturalHeight || h);
          } finally { URL.revokeObjectURL(objUrl); }
        } catch (e) { lastErr = e.message; }
      }
      throw new Error(`栅格化失败(${lastErr})`);
    },

    async toDataUrl(im) {
      const rawSrc = im.src || im.getAttribute('data-src') || '';
      if (rawSrc.startsWith('data:')) {
        // 已经是 dataURL：如果是 SVG 等非位图，仍需栅格化成 PNG
        if (!/^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(rawSrc)) {
          try { return await this.rasterizeToPng(im); } catch (e) { /* 落回原样，由 bridge 过滤 */ }
        }
        return rawSrc;
      }
      // SVG 源（.svg 或 inline svg）直接走栅格化
      if (/\.svg(\?|#|$)/i.test(rawSrc)) {
        return await this.rasterizeToPng(im);
      }

      // 1) 先试 canvas（同源/已允许 CORS 的图最省事）
      try {
        const c = document.createElement('canvas');
        c.width = im.naturalWidth || im.width;
        c.height = im.naturalHeight || im.height;
        if (c.width > 4 && c.height > 4) {
          c.getContext('2d').drawImage(im, 0, 0);
          const out = c.toDataURL('image/png');
          if (out && out.length > 100) return out;
        }
      } catch (e) { /* 跨域污染 canvas，转 fetch */ }

      // 2) fetch，逐个候选 URL 尝试（https 优先，绕 Mixed Content）
      const candidates = this.httpCandidates(rawSrc).sort((a, b) => (b.startsWith('https') ? 1 : 0) - (a.startsWith('https') ? 1 : 0));
      let lastErr = '';
      for (const url of candidates) {
        try {
          const res = await fetch(url, { credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer' });
          if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
          const blob = await res.blob();
          if (!/^image\//.test(blob.type) && blob.size < 100) { lastErr = '非图片响应'; continue; }
          return await new Promise((ok, no) => {
            const fr = new FileReader();
            fr.onload = () => ok(fr.result);
            fr.onerror = () => no(new Error('FileReader 失败'));
            fr.readAsDataURL(blob);
          });
        } catch (e) { lastErr = e.message; }
      }
      throw new Error(`图片获取失败(${lastErr})：${rawSrc.slice(0, 60)}`);
    },

    // 收集一题的所有图片为 dataURL（统一栅格化为 png/jpeg，智谱 vision 只吃位图）
    async collectImages(q) {
      if (!q.imgEls || !q.imgEls.length) return [];
      const out = [];
      const MAX = 4;
      for (const im of q.imgEls.slice(0, MAX)) { // 最多 4 张，防止请求过大
        try {
          const dataUrl = await this.toDataUrl(im);
          const mt = (/^data:([^;]+)/.exec(dataUrl) || [])[1] || '?';
          const kb = Math.round(dataUrl.length * 0.75 / 1024);
          out.push({ dataUrl });
          log(`  ✓ 图${out.length} ${mt} ~${kb}KB`);
        } catch (e) { log('  ✗ 跳过一张图：' + e.message); }
      }
      if (q.imgEls.length > MAX) log(`  （本题共 ${q.imgEls.length} 张，仅取前 ${MAX} 张）`);
      return out;
    },

    /* 判断这一题是不是「符号图片题」——即题干里挂着平台公式图（Wirisformula）。
     * 这类题纯文本必然残缺，必须整题渲染成图给视觉模型。 */
    needsRender(qEl) {
      if (!qEl) return false;
      if (qEl.querySelector('img.Wirisformula, img[class*="Wirisformula"], img[src*="Wirisformula"]')) return true;
      // 兜底：题干文本里出现连续逗号/空格夹着的空档，且图数量多，也按符号题处理
      const imgs = [...qEl.querySelectorAll('img')].filter(im => {
        const w = im.naturalWidth || im.width || 0;
        const h = im.naturalHeight || im.height || 0;
        return w <= 160 && h <= 60 && w > 0;   // 细长小图 = 公式符号
      });
      return imgs.length >= 2;
    },

    /* 把整道题（题干 + 选项，含公式 SVG 图）渲染成一张 PNG。
     * 关键处理：先克隆节点 → 清掉选中态/禁用小图标干扰 → 挂到一个离屏可测量容器，
     *           html2canvas 需要元素在文档流里且有布局尺寸。
     * html2canvas 对跨域 <img> 的处理：EWT 图片带 ACAO:*，useCORS:true 可正常抓取。 */
    async renderQuestionToPng(qEl) {
      if (!qEl) throw new Error('题目节点不存在');
      const h2c = await Html2Canvas.load();

      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;background:#fff;padding:16px;z-index:-1;';
      const clone = qEl.cloneNode(true);
      // 清掉作答按钮/编辑框等无关交互，减少渲染面积
      clone.querySelectorAll('button, .ant-btn, .mst-editor, [contenteditable="true"], .pm-question-score').forEach(n => {
        if (!n.querySelector('img.Wirisformula')) n.remove();
      });
      clone.style.width = '820px';
      holder.appendChild(clone);
      document.body.appendChild(holder);

      try {
        // 等图片解码完成，否则 html2canvas 会画出空白
        const imgs = [...clone.querySelectorAll('img')];
        await Promise.all(imgs.map(im => im.complete ? Promise.resolve() : new Promise(r => {
          im.addEventListener('load', r, { once: true });
          im.addEventListener('error', r, { once: true });
          setTimeout(r, 3000);
        })));
        await new Promise(r => setTimeout(r, 120));

        const canvas = await h2c(clone, {
          backgroundColor: '#ffffff',
          scale: Math.min(2, window.devicePixelRatio || 1.5),
          useCORS: true,
          allowTaint: false,
          logging: false,
          width: 820,
          windowWidth: 820,
        });
        const url = canvas.toDataURL('image/png');
        const kb = Math.round(url.length * 0.75 / 1024);
        log(`  ✓ 整题渲染成 PNG ~${kb}KB (${canvas.width}x${canvas.height})`);
        return url;
      } finally { holder.remove(); }
    },

    /* ===== 上传型主观题：AI 文字答案 → 手写风格图片 → 塞进上传框 =====
     * 实测结构（2026-10-05 bizCode=204 上传题）：
     *   <div class="pm-xb-upload-img-container">
     *     <p class="pm-xb-upload-tit">上传你的答案：最多可上传3张图片（每张不大于20M）</p>
     *     <div class="pm-question-upload-box"><div class="pm-upload-oss-wrapper">
     *       <span class="ant-upload-picture-card-wrapper">
     *         <div class="ant-upload ant-upload-select ant-upload-select-picture-card" style="display:none">
     *           <span tabindex="0" class="ant-upload" role="button">
     *             <input type="file" style="display:none">     ← 隐藏的文件选择
     *           </span>
     *         </div>
     *       </span>
     *       <div class="pm-upload-oss-box"><div class="pm-upload-oss-box-trigger">上传照片</div></div>
     *     </div></div>
     *   </div>
     *
     * 关键：点「上传照片」会弹**系统文件选择框**（用户实测 2026-10-05），
     * 说明走的是标准 <input type="file">。现代浏览器允许脚本用 DataTransfer
     * 构造 File 塞进 input.files 并派发 change —— React 的 Upload 组件会正常接管上传。
     * 所以**不需要知道任何上传接口地址**，全自动可行。
     */

    // 把整段文字渲染成「白底黑字」的 PNG（模拟手写答题纸，便于平台 OCR/人工判分）
    renderAnswerToPng(text, title) {
      const DPR = 2;                       // 2 倍分辨率，保证清晰
      const W = 1000;                      // 逻辑宽度
      const PAD = 48;
      const FONT = '28px "Kaiti SC","KaiTi","楷体",serif';  // 楷体更像手写
      const LINE = 44;

      // 先量高度：用离屏 canvas 试排
      const probe = document.createElement('canvas').getContext('2d');
      probe.font = FONT;
      const maxW = W - PAD * 2;
      const rawLines = String(text).split('\n');
      const lines = [];
      for (const raw of rawLines) {
        if (!raw) { lines.push(''); continue; }
        let cur = '';
        for (const ch of raw) {
          if (probe.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; }
          else cur += ch;
        }
        lines.push(cur);
      }
      const titleH = title ? LINE * 1.6 : 0;
      const H = Math.max(320, PAD * 2 + titleH + lines.length * LINE + 24);

      const cv = document.createElement('canvas');
      cv.width = W * DPR;
      cv.height = H * DPR;
      const ctx = cv.getContext('2d');
      ctx.scale(DPR, DPR);

      // 白底
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);

      let y = PAD;
      ctx.fillStyle = '#000000';
      ctx.textBaseline = 'top';

      if (title) {
        ctx.font = 'bold 24px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.fillText(title, PAD, y);
        y += titleH;
      }

      // 横线格（像答题纸）
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1;
      for (let i = 0; i < lines.length; i++) {
        const ly = y + i * LINE + LINE - 6;
        ctx.beginPath();
        ctx.moveTo(PAD, ly);
        ctx.lineTo(W - PAD, ly);
        ctx.stroke();
      }

      ctx.font = FONT;
      ctx.fillStyle = '#111827';
      lines.forEach((ln, i) => ctx.fillText(ln, PAD, y + i * LINE + 4));

      return cv.toDataURL('image/png');
    },

    // dataURL → File（用于塞进 input.files）
    dataUrlToFile(dataUrl, filename) {
      const [head, b64] = dataUrl.split(',');
      const mime = (/data:([^;]+)/.exec(head) || [])[1] || 'image/png';
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], filename, { type: mime });
    },

    /* ============ 上传题：注入式方案（2026-10-05 实测通过） ============
     *
     * 平台真实机制（从 React fiber 反查得到）：
     *   「上传照片」按钮的 onClick 会动态 createElement('input', type=file)，
     *   用游离 input.click() 打开系统文件框，onchange 里调闭包函数 re(file) ——
     *   该函数自动完成：取 STS 凭证 → 签名 PUT 到 OSS → 登记 → 回填 → submitAnswer。
     *
     * 所以脚本**不需要知道任何上传接口/签名算法**，只要：
     *   1. 劫持 Document.createElement，捕获业务创建的 file input
     *   2. 劫持 HTMLInputElement.click，file input 时不弹框
     *   3. 点目标题的「上传照片」按钮
     *   4. 把渲染好的图片 File 塞进捕获的 input，派发 change
     *   → 业务自己跑完全链路，包括最终 submitAnswer。
     */

    // 注入队列：同一时刻只处理一道题的一个文件
    _uploadQueue: null,   // { file: File, done: Function }
    _uploadHooked: false,

    installUploadInterceptor() {
      if (this._uploadHooked) return;
      // 用 window.* 取全局构造器，兼容沙箱/测试环境
      const W = typeof window !== 'undefined' ? window : globalThis;
      const Doc = W.Document;
      const InputEl = W.HTMLInputElement;
      if (!Doc || !InputEl || !Doc.prototype || !InputEl.prototype) return;
      this._uploadHooked = true;
      const self = this;

      // 1) 捕获 createElement 出来的 file input（先只登记，不急着注入）
      const origCreate = Doc.prototype.createElement;
      Doc.prototype.createElement = function (tag, ...rest) {
        const el = origCreate.call(this, tag, ...rest);
        if (String(tag).toLowerCase() === 'input') {
          self._pendingInput = el;              // 记录"最近创建的 input"
          const origSet = el.setAttribute.bind(el);
          el.setAttribute = function (name, val) {
            origSet(name, val);
            if (String(name).toLowerCase() === 'type' && String(val).toLowerCase() === 'file') {
              el.__ewtIsFile = true;
              self._pendingInput = el;
              self._maybeInject(el, 'setAttribute');
            }
          };
          // 有些写法直接 el.type = 'file'
          try {
            let _t = el.type;
            Object.defineProperty(el, 'type', {
              configurable: true,
              get() { return _t; },
              set(v) {
                _t = v;
                try { origSet('type', v); } catch (e) {}
                if (String(v).toLowerCase() === 'file') {
                  el.__ewtIsFile = true;
                  self._pendingInput = el;
                  self._maybeInject(el, 'type-setter');
                }
              },
            });
          } catch (e) { /* 忽略 */ }
        }
        return el;
      };

      // 2) 拦截 file input 的 click：业务点它的那一刻才是注入的最佳时机（onchange 已绑好）
      const origClick = InputEl.prototype.click;
      InputEl.prototype.click = function () {
        if (this.type === 'file' || this.__ewtIsFile) {
          // 不弹框；同时把「点击时刻」当作最终注入时机
          self._maybeInject(this, 'click');
          return;
        }
        return origClick.apply(this, arguments);
      };
    },

    // 尝试注入：只要队列里有文件且 input 就绪，就注入（带一次性锁）
    _maybeInject(inputEl, from) {
      const job = this._uploadQueue;
      if (!job || !job.file) return;
      if (!inputEl) return;
      // 判定是否 file input：优先看我们打的标记，其次看 type
      let isFile = !!inputEl.__ewtIsFile;
      if (!isFile) { try { isFile = String(inputEl.type).toLowerCase() === 'file'; } catch (e) {} }
      if (!isFile) return;
      if (inputEl.__ewtInjectLock) return;      // 已注入过
      inputEl.__ewtInjectLock = true;
      this._uploadQueue = null;                 // 消费队列
      const file = job.file;
      log(`  ⚙ 捕获到 file input（时机:${from}），注入「${file.name}」(${Math.round(file.size / 1024)}KB)`);
      // 延迟一帧，等业务把 onchange / React handler 绑好
      setTimeout(() => {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          try { inputEl.files = dt.files; }
          catch (e) { Object.defineProperty(inputEl, 'files', { value: dt.files, configurable: true }); }
          log(`  ⚙ 已写入 input.files（${inputEl.files && inputEl.files.length} 个），派发 change`);
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
          if (typeof inputEl.onchange === 'function') {
            try { inputEl.onchange({ target: inputEl }); } catch (e) { log('  ⚠ onchange 抛错：' + e.message); }
          }
          log('  ⚙ change 已派发（注意：这只代表"文件已交给平台"，不代表上传成功）');
          job.done && job.done(true);
        } catch (e) {
          log('  ⚠ 注入失败：' + e.message);
          job.done && job.done(false, e);
        } finally {
          try { delete inputEl.__ewtInjectLock; } catch (e) {}
        }
      }, 50);
    },

    // 把一个 File 通过「点击真实按钮 → 注入」的方式交给平台上传
    injectFileViaButton(btnEl, file, timeoutMs = 60000) {
      return new Promise((resolve, reject) => {
        this.installUploadInterceptor();
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this._uploadQueue = null;
          reject(new Error('注入超时'));
        }, timeoutMs);

        this._uploadQueue = {
          file,
          done: (ok, err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ok ? resolve() : reject(err || new Error('注入失败'));
          },
        };

        // 触发按钮（React 合成事件需要 bubbles）
        btnEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
    },

    // 在题目块里找「上传照片」按钮（找不到则用上传容器兜底）
    findUploadButton(qEl, anchor) {
      const sels = [
        '.pm-upload-oss-box-trigger',
        '.pm-upload-oss-box',
        '.pm-question-upload-box',
        '.pm-xb-upload-img-container',
        '.ant-upload-select',
        '.ant-upload',
      ];
      // 优先在继承来的作答锚点里找（语文主观题：作答区挂在父级块上）
      if (anchor) {
        for (const s of sels) {
          let el = null;
          try { el = anchor.matches && anchor.matches(s) ? anchor : anchor.querySelector(s); } catch (e) {}
          if (el) return el;
        }
      }
      const box = qEl.closest('.pm-question') || qEl;
      for (const s of sels) {
        const el = box.querySelector(s);
        if (el) return el;
      }
      // 语文主观题兜底：子题自身没有作答区，作答区在父级题目块里
      const parentBlock = qEl.parentElement && qEl.parentElement.closest('div[id^="ewt-question-"]');
      if (parentBlock && parentBlock !== qEl) {
        for (const s of sels) {
          const el = parentBlock.querySelector(s);
          if (el) return el;
        }
      }
      return null;
    },

    // 监听指定窗口期内平台是否真的发出了"上传相关"网络请求（凭证 / OSS / 登记）
    _installNetProbe() {
      if (this._netProbed) return;
      this._netProbed = true;
      this._netLog = [];   // { t, method, url, status }
      const push = (method, url) => { try { this._netLog.push({ t: Date.now(), method, url: String(url) }); } catch (e) {} };
      const XO = XMLHttpRequest.prototype.open;
      const XS = XMLHttpRequest.prototype.send;
      const self = this;
      XMLHttpRequest.prototype.open = function (m, u) {
        if (/credential|upload|oss|aliyuncs|submitAnswer/i.test(String(u))) {
          push(m, u);
          this.addEventListener('load', () => {
            const rec = self._netLog[self._netLog.length - 1];
            if (rec && rec.url === String(u)) rec.status = this.status;
          });
        }
        return XO.apply(this, arguments);
      };
      const F = window.fetch;
      if (F) {
        window.fetch = function (input, init) {
          const u = typeof input === 'string' ? input : (input && input.url) || '';
          if (/credential|upload|oss|aliyuncs|submitAnswer/i.test(String(u))) {
            push((init && init.method) || 'GET', u);
            return F.apply(this, arguments).then(r => {
              const rec = self._netLog[self._netLog.length - 1];
              if (rec && rec.url === String(u)) rec.status = r.status;
              return r;
            });
          }
          return F.apply(this, arguments);
        };
      }
    },

    // 在 ms 毫秒窗口内观察是否出现"新的上传请求"，返回请求记录
    async _waitNetUpload(sinceTs, timeoutMs = 20000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const hits = (this._netLog || []).filter(r => r.t >= sinceTs
          && /credential|oss|aliyuncs|upload\/complete/i.test(r.url));
        if (hits.length) return hits;
        await new Promise(r => setTimeout(r, 300));
      }
      return [];
    },

    // 统计某题上传区的图片数量（多重选择器，尽量命中平台真实 DOM）
    countUploadImgs(qEl, anchor) {
      const boxes = [];
      if (anchor) {
        // 锚点本身或它的最近容器
        boxes.push(anchor);
        const c = anchor.closest && anchor.closest('.pm-question-content, .pm-question');
        if (c) boxes.push(c);
      }
      boxes.push(qEl.closest('.pm-question') || qEl);
      const sels = [
        '.pm-upload-oss-box img',
        '.ant-upload-list-item img',
        '.ant-upload-list img',
        '.pm-upload-img-item img',
        '[class*="upload-list"] img',
        '[class*="upload"] img',
      ];
      const set = new Set();
      for (const box of boxes) {
        if (!box || !box.querySelectorAll) continue;
        for (const s of sels) {
          try { box.querySelectorAll(s).forEach(img => set.add(img)); } catch (e) {}
        }
      }
      return set.size;
    },

    // 等待指定题目的图片数量超过 beforeCount（说明新图已出现），并等它「稳定」下来
    async waitUploaded(qEl, beforeCount, timeoutMs = 90000, anchor) {
      const t0 = Date.now();
      let appeared = false;
      // 阶段1：等新图出现
      while (Date.now() - t0 < timeoutMs) {
        if (this.countUploadImgs(qEl, anchor) > beforeCount) { appeared = true; break; }
        await new Promise(r => setTimeout(r, 400));
      }
      if (!appeared) return false;
      // 阶段2：等上传列表项不再是 uploading 状态（antd 会给项加 ant-upload-list-item-uploading）
      const box = qEl.closest('.pm-question') || qEl;
      const scope = anchor || box;
      const t1 = Date.now();
      while (Date.now() - t1 < 30000) {
        const uploading = scope.querySelectorAll
          ? scope.querySelectorAll('.ant-upload-list-item-uploading, [class*="uploading"], .ant-progress').length
          : 0;
        if (uploading === 0) break;
        await new Promise(r => setTimeout(r, 400));
      }
      return true;
    },

    // 上传题全流程：生成图片 → 逐张点按钮注入 → 等待上传完成（最多 3 张）
    // attempt：第几次尝试（重试轮会调大，相应放大注入 / 上传等待超时，给足慢网络时间）
    async fillUpload(q, answer, attempt = 1) {
      const qEl = document.getElementById(q.id);
      if (!qEl) throw new Error('题目已不在页面上');

      // 失败重试时超时递增：注入 60s→90s→120s；上传请求 20s→30s→40s；列表刷新 60s→90s→120s
      const boost = Math.max(0, (Number(attempt) || 1) - 1);
      const injectTo = 60000 + boost * 30000;
      const netTo    = 20000 + boost * 10000;
      const listTo   = 60000 + boost * 30000;
      if (boost > 0) log(`  ↻ 第 ${attempt} 次尝试：注入超时 ${injectTo / 1000}s / 上传等待 ${listTo / 1000}s`);

      // 长答案自动分页（每页最多 ~18 行，避免图片过高）
      const MAX_LINES = 18;
      const rawLines = String(answer).split('\n');
      const pages = [];
      if (rawLines.length <= MAX_LINES) pages.push(rawLines.join('\n'));
      else for (let i = 0; i < rawLines.length; i += MAX_LINES) pages.push(rawLines.slice(i, i + MAX_LINES).join('\n'));

      log(`  ⬆ 本题共需上传 ${Math.min(pages.length, 3)} 张图片`);
      this._installNetProbe();   // 开启网络监听（用于验证上传是否真的发生）

      const title = `第${q.index || ''}题 作答`;
      let n = 0;
      for (const page of pages) {
        if (n >= 3) { log('  ⚠ 已达平台上限 3 张，剩余内容未上传'); break; }

        // 【关键】每张都重新获取按钮：第 1 张上传后 React 会重渲染，旧引用可能已脱离 DOM
        const btn = this.findUploadButton(qEl, q.uploadAnchor);
        if (!btn) { log('  ⚠ 找不到上传按钮（可能已达上限或 DOM 变更）'); break; }
        if (!btn.isConnected) { log('  ⚠ 上传按钮已脱离 DOM，跳过'); break; }

        const png = this.renderAnswerToPng(page, n === 0 ? title : `${title}（续${n}）`);
        const file = this.dataUrlToFile(png, `answer_${q.id}_${n + 1}.png`);
        const before = this.countUploadImgs(qEl, q.uploadAnchor);
        const t0 = Date.now();

        log(`  ⬆ 上传第 ${n + 1} 张（${Math.round(file.size / 1024)}KB），当前已显示 ${before} 张…`);
        try {
          await this.injectFileViaButton(btn, file, injectTo);
        } catch (e) {
          log(`  ⚠ 第 ${n + 1} 张注入失败：${e.message}`);
          break;
        }

        // 真实判据1：是否发出了上传相关请求（凭证 / OSS / 登记）
        const reqs = await this._waitNetUpload(t0, netTo);
        if (!reqs.length) {
          log(`  ✗ 第 ${n + 1} 张：注入后 ${netTo / 1000} 秒内**没有任何上传请求**发出 → 平台没接收这个文件，本次视为失败`);
          break;
        }
        const urls = reqs.map(r => `${r.method} ${r.url.slice(0, 60)}${r.status ? '(HTTP ' + r.status + ')' : ''}`);
        log(`  ⚙ 检测到上传请求 ${reqs.length} 条：\n     ` + urls.join('\n     '));

        // 真实判据2：图片列表是否刷新
        const okUp = await this.waitUploaded(qEl, before, listTo, q.uploadAnchor);
        const nowCount = this.countUploadImgs(qEl, q.uploadAnchor);
        if (okUp) log(`  ✓ 第 ${n + 1} 张上传完成，现在显示 ${nowCount} 张`);
        else log(`  ⚠ 第 ${n + 1} 张：请求已发出但图片列表未刷新（现在 ${nowCount} 张）——可能上传失败或预览未更新`);
        n++;
        await new Promise(r => setTimeout(r, 2000)); // 给平台内部 state / 提交留时间，避免下一张覆盖上一张
      }

      // 【关键】没传满预期页数 → 抛错交给上层重试队列，而不是静默当成功
      const want = Math.min(pages.length, 3);
      if (n < want) {
        throw new Error(`仅上传 ${n}/${want} 张，判定为失败待重试`);
      }
      return n;
    },

    // 收集所有"需要作答"的题，并为其关联所属阅读材料
    collectQuestions() {
      // 多策略匹配题目容器（不同 bizCode / 新版页面结构可能不同）
      let all = [...document.querySelectorAll('div[id^="ewt-question-"].pm-question-content')];
      if (!all.length) all = [...document.querySelectorAll('div[id^="ewt-question-"]')];
      if (!all.length) all = [...document.querySelectorAll('.pm-question-content')];
      if (!all.length) all = [...document.querySelectorAll('.pm-question')];
      if (!all.length) all = [...document.querySelectorAll('[class*="pm-question"]')];

      const out = [];
      let material = ''; // 最近一段材料题的正文，作为后续子题的上下文
      let materialImgs = []; // 最近一段材料题的图片，同样要继承给子题
      let parentUploadEls = []; // 最近一个"带作答区"的父级块里，可继承给子题的上传/作答容器
      let parentUploadClaimed = 0; // 已分配给子题的数量（多子题共用时有意义）
      for (const el of all) {
        const parsed = this.parseQuestion(el);
        // 判断是不是「材料题（父级）」：只看内部是否挂着**另外的**独立题目。
        // 元素自身就是 .pm-question-content 时（205 数学卷 / 204 英语卷均如此），
        // querySelector 会命中自己内层 div，必须排除 self。
        const nested = [...el.querySelectorAll('div[id^="ewt-question-"]')]
            .some(n => n !== el && /pm-question-content/.test(n.className))
          || [...el.querySelectorAll('.pm-question')].some(n => n !== el);

        if (nested) {
          // 材料题（父级，内部挂着子题）→ 登记材料供子题继承。
          // 【重要】语文主观题实测：父级块内除了材料正文和子题，还挂着「作答区」
          //   （.pm-xb-upload-img-container / .pm-subjective-container / 上传按钮），
          //   而子题自身**没有任何作答区** → 子题若只看自己会被误判为"不可作答"而跳过。
          //   所以这里把父级的作答容器也登记下来，供紧随其后的子题继承。
          material = parsed.question;
          materialImgs = parsed.imgEls || [];
          parentUploadEls = [...el.querySelectorAll(
            '.pm-xb-upload-img-container, .pm-upload-oss-wrapper, .pm-subjective-container, .pm-upload-oss-box'
          )];
          parentUploadClaimed = 0;
          continue;
        }

        // 没有独立子题的节点 = 一道「叶子题」，无论选择题还是填空题都应作答。
        // 【重要】旧逻辑这里是 `isChild = !nested && parsed.isChoice`，
        //   导致填空题（无选项 → isChoice=false）全部被判成"材料题"跳过。
        //   实测 bizCode=204 英语单句语法填空 15 道题 → 识别到 0 道。
        //   现改为：只看"有没有嵌套的独立题目"，没有就当作可作答题。
        //
        // 叶子节点还要有「可作答特征」才算题（排除页脚/装饰等无关节点）：
        //   有选项 / 有文本输入区 / 是上传型主观题（内含 file input 或上传容器）
        let hasAnswerArea = parsed.isChoice || parsed.isUpload
          || !!el.querySelector('[contenteditable="true"], textarea, input:not([type="hidden"]), ' +
                                '.mst-question-answer-placeholder, [class*="answer-input"], [class*="blank-input"]');

        // 语文主观题：子题自身无作答区时，继承父级块的作答容器（上传区）
        if (!hasAnswerArea && parentUploadEls.length) {
          hasAnswerArea = true;
          parsed.isUpload = true;
          // 多子题共用时按顺序分配；不够分则都指回第一个（平台通常也只放一个作答位）
          const pick = parentUploadEls[Math.min(parentUploadClaimed, parentUploadEls.length - 1)];
          parsed.uploadAnchor = pick;   // 供 findUploadButton 优先使用
          parentUploadClaimed++;
        }
        // 把作答锚点挂到 DOM 上，供 AutoSubmit.allAnswered() 复用
        // （子题自己内部没有作答区，判定"已作答"时必须看这个锚点）
        if (parsed.uploadAnchor) el.__ewtAnchor = parsed.uploadAnchor;
        if (!hasAnswerArea) continue;

        if (!parsed.question || parsed.question.length < 2) continue;
        parsed.material = material;
        // 图片继承：子题自己的图 + 材料题的图（去重）
        const own = parsed.imgEls || [];
        const merged = [...own];
        for (const im of materialImgs) if (!merged.includes(im)) merged.push(im);
        parsed.imgEls = merged;
        out.push(parsed);
      }
      return out;
    },

    // 诊断：输出为什么识别不到题目
    diagnose() {
      const tests = [
        ['div[id^="ewt-question-"].pm-question-content', document.querySelectorAll('div[id^="ewt-question-"].pm-question-content').length],
        ['div[id^="ewt-question-"]', document.querySelectorAll('div[id^="ewt-question-"]').length],
        ['.pm-question-content', document.querySelectorAll('.pm-question-content').length],
        ['.pm-question', document.querySelectorAll('.pm-question').length],
        ['.pm-ewt-option-item', document.querySelectorAll('.pm-ewt-option-item').length],
        ['.examination-paper-answer', document.querySelectorAll('.examination-paper-answer').length],
      ];
      log('--- 选择器命中数 ---');
      tests.forEach(([sel, n]) => log(`${n > 0 ? '✓' : '✗'} ${sel} → ${n}`));
      const iframes = [...document.querySelectorAll('iframe')];
      log(iframes.length ? `⚠ 页面有 ${iframes.length} 个 iframe，题目可能在 iframe 内` : '无 iframe');
      const allImgs = [...document.querySelectorAll('img')];
      log(`页面 <img> 共 ${allImgs.length} 张`);
      allImgs.slice(0, 8).forEach(im => log(`  ${(im.src||'').slice(0,70)} [${im.naturalWidth}x${im.naturalHeight}]`));
      const qs = this.collectQuestions();
      log(`最终识别到 ${qs.length} 道题`);
      qs.forEach((q, i) => log(`  第${i+1}题: 选项${q.options.length}个, 图片${(q.imgEls||[]).length}张`));
      // 兜底：列出所有 class 含 question 的元素，方便人工判断
      const guess = [...document.querySelectorAll('[class*="question"],[class*="Question"]')].slice(0, 8);
      if (!qs.length && guess.length) {
        log('疑似题目元素（前 8 个）：');
        guess.forEach(e => log(`  <${e.tagName}> ${String(e.className).slice(0, 60)} | ${(e.innerText||'').trim().slice(0,30)}`));
      }
    },

    // 选择题：点对应字母选项
    async fillChoice(q, answer) {
      const letters = (answer.match(/[A-H]/gi) || []).map(c => c.toUpperCase());
      if (!letters.length) throw new Error(`答案无法解析为选项字母: "${answer}"`);
      let filled = 0;
      for (const el of q.optionEls) {
        const tagEl = el.querySelector('.pm-tag-letter,[class*="tag-letter"]');
        let tag = clean(tagEl?.textContent || '').toUpperCase().replace(/[^A-H]/g, '');
        const content = clean(el.textContent || '');
        if (!tag && /^[A-H]/.test(content)) tag = content[0].toUpperCase();
        if (letters.includes(tag) && !/selected|active|checked/.test(el.className)) {
          el.click();
          filled++;
          await new Promise(r => setTimeout(r, 120));
        }
      }
      if (!filled && !letters.length) throw new Error('未填入选中的选项');
      return filled;
    },

    /* ===== 语法填空（bizCode=204 `pm-blanks-normal`）作答区定位 =====
     * 实测真实结构（2026-10-05 英语单句语法填空 15 题）：
     *
     *   <div class="left-box-of-questions">
     *     <div class="pm-question">
     *       <div id="ewt-question-xxx" class="pm-question-content pm-blanks-normal">
     *         <div class="mst-editor-mce-root-block">
     *           <span class="pm-qnum-width">1.</span>
     *           <span class="mst-question-answer-placeholder">Covering</span>   ← 只读回显！不是输入框
     *           <span> (cover) an area about ...</span>
     *         </div>
     *       </div>
     *     </div>
     *     <div class="pmm-xb-line-res">                    ← 真正作答区，是题块的兄弟节点！
     *       <p>填写你的答案：...</p>
     *       <div class="pmm-line-li-box"><div class="pmm-line-li"><div class="pmm-line-input—box">
     *         <span class="ant-input-affix-wrapper pmm-line-li—input">
     *           <input placeholder="请输入答案" maxlength="30" class="ant-input" value="">
     *         </span>
     *       </div></div></div>
     *     </div>
     *     ...
     *
     * 要点：
     *   1. `.mst-question-answer-placeholder` 是**只读回显**（显示上次答案），
     *      往里写 textContent 只会污染题面、平台不认 —— 绝不能碰。
     *   2. 真正的输入框是 `input.ant-input`，且**不在题目块内**，而在紧随其后的
     *      `.pmm-xb-line-res` 里（兄弟节点）。
     *   3. 配对规则：**第 N 道题 → 第 N-1 个 input.ant-input**（按文档顺序一一对应，实测 15/15 全中）。
     *      个别题有多个空位（如最后一题 2 个），会出现输入框数 > 题数。
     */

    // 收集页面所有「真正的」填空输入框（排除脚本面板自己的 checkbox 等）
    collectBlankInputs() {
      return [...document.querySelectorAll('input.ant-input, input[placeholder="请输入答案"]')]
        .filter(el => {
          // 排除我们自己的面板
          if (el.closest('#ewt-study-helper-root')) return false;
          // 排除 checkbox/radio
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          if (t === 'checkbox' || t === 'radio') return false;
          return true;
        });
    },

    // 找到某道题对应的那一个（或多个）填空输入框
    findBlankInputFor(qId) {
      const qEl = document.getElementById(qId);
      if (!qEl) return [];

      // 策略1（最稳）：顺着兄弟节点找 —— 题块 → .pmm-xb-line-res → 里面的 input
      const qBox = qEl.closest('.pm-question') || qEl;
      let sib = qBox.nextElementSibling;
      let guard = 0;
      while (sib && guard++ < 6) {
        const ins = [...sib.querySelectorAll('input.ant-input')];
        if (ins.length) return ins;
        // 若下一个兄弟又是题块，说明这道题没有独立作答区，停
        if (sib.querySelector && sib.querySelector('div[id^="ewt-question-"]')) break;
        sib = sib.nextElementSibling;
      }

      // 策略2：按文档顺序索引配对（第 N 题 → 第 N-1 个输入框）
      const allQs = [...document.querySelectorAll('div[id^="ewt-question-"]')];
      const idx = allQs.indexOf(qEl);
      const inputs = this.collectBlankInputs();
      if (idx >= 0 && inputs[idx]) return [inputs[idx]];
      return [];
    },

    // 简答/填空：写答案到真实作答区
    async fillText(q, answer) {
      const qEl = document.getElementById(q.id);
      if (!qEl) throw new Error('题目已不在页面上');

      // 形态 A：标准 contenteditable / textarea 富文本作答区
      const editors = [...qEl.querySelectorAll('[contenteditable="true"], textarea, .mst-editor-input, [class*="answer-input"]')]
        .filter(el => !/mst-text-indent/.test(el.className));
      if (editors.length) {
        this.insertText(editors[0], answer);
        return 1;
      }

      // 形态 B：语法填空题 —— 输入框在题目块外的 .pmm-xb-line-res 里
      const inputs = this.findBlankInputFor(q.id);
      if (inputs.length) {
        this.fillInput(inputs[0], answer);
        return 1;
      }

      throw new Error('未找到作答输入区（题目块内无编辑器，也未找到对应的 .ant-input 填空框）');
    },

    /* 往 <input class="ant-input"> 写值（React 受控组件）。
     * 必须用原型上的 value setter，绕过 React 对 value 的拦截，
     * 再派发 input 事件让 React onChange 收到 —— 否则状态不同步，
     * 点了提交也带不上这个答案。实测写入后 clear-icon 会从 hidden 变为可见，即状态已同步。 */
    fillInput(el, value) {
      if (!el) return false;
      el.focus();
      try {
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
      } catch (e) { el.value = value; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },

    // 保留：完整鼠标事件序列点击（比 el.click() 更接近真实操作，框架才认）
    clickLike(el) {
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      try {
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      } catch (e) {
        try { el.click(); } catch (e2) { /* 忽略 */ }
      }
    },

    // 富文本安全写入：模拟真实输入事件，否则框架收不到变更
    insertText(el, value) {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
        setter ? setter.call(el, value) : (el.value = value);
      } else {
        el.innerText = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    },

    /* ===== 失败重试配置 =====
     * 自动作答时有些题会失败（bridge 超时、图片太大、上传 403、答案解析失败…）。
     * 策略：全部跑完后，对失败题做多轮重试；每轮：
     *   - LLM 请求超时递增（第 1 轮 380s → 第 2 轮 480s → 第 3 轮 600s）
     *   - 上传等待超时递增（60s → 90s → 120s）
     *   - 轮与轮之间休息 3 秒，避开网络抖动
     */
    RETRY_ROUNDS: 2,                 // 失败后再重试的轮数（总共最多 1+2=3 次尝试）
    RETRY_BASE_TIMEOUT_MS: 380000,   // 首次 LLM 超时
    RETRY_STEP_TIMEOUT_MS: 120000,   // 每轮递增

    async answerOne(q, attempt) {
      const qEl = document.getElementById(q.id);
      if (!qEl) throw new Error('题目已不在页面上');
      let images = [];
      let questionText = q.question;

      // 公式图片题：整题截图
      const symbolQuestion = this.needsRender(qEl);
      if (symbolQuestion) {
        log('本题含公式图（Wirisformula），改用整题截图识别…');
        try {
          const png = await this.renderQuestionToPng(qEl);
          images = [{ dataUrl: png }];
          questionText = q.question;
        } catch (e) {
          log(`⚠ 整题渲染失败（${e.message}），回退为逐图采集`);
          if (q.imgEls && q.imgEls.length) images = await this.collectImages(q);
        }
      } else if (q.imgEls && q.imgEls.length) {
        log(`本题含 ${q.imgEls.length} 张图，正在采集…`);
        images = await this.collectImages(q);
        log(`已采集 ${images.length} 张图`);
      }

      // 失败重试时递增 LLM 超时
      const timeoutMs = this.RETRY_BASE_TIMEOUT_MS + Math.max(0, attempt - 1) * this.RETRY_STEP_TIMEOUT_MS;
      // 题型标记：bridge 据此挑模型（render/upload → 强模型；choice/text → 快模型）
      const kind = symbolQuestion ? 'render' : (q.isUpload ? 'upload' : (q.isChoice ? 'choice' : 'text'));
      log(`请求答案：${(questionText || '').slice(0, 24)}…${attempt > 1 ? `（第 ${attempt} 次尝试，超时 ${Math.round(timeoutMs / 1000)}s）` : ''}`);
      const t0 = Date.now();
      const answer = await LLM.ask({
        question: questionText, options: q.options, material: q.material, images,
        isUpload: !!q.isUpload,
        kind,
        __timeoutMs: timeoutMs,
      });
      const cost = ((Date.now() - t0) / 1000).toFixed(1);
      log(`得到答案：${answer.slice(0, 40)}${LLM.lastChannel ? `  [${LLM.lastChannel}]` : ''}（耗时 ${cost}s）`);

      if (q.isUpload) {
        log('本题为上传型主观题，正在生成答案图片并上传…');
        const n = await this.fillUpload(q, answer, attempt);
        log(`  ✓ 已提交 ${n} 张答案图片`);
      } else if (q.isChoice) {
        await this.fillChoice(q, answer);
      } else {
        await this.fillText(q, answer);
      }
      return true;
    },

    async run() {
      if (this.running) return;
      this.running = true;
      this.stopFlag = false;
      log('开始自动作答…');
      const allQs = this.collectQuestions().filter(q => !this.doneSet.has(q.id));
      log(`发现 ${allQs.length} 道待作答题`);
      let ok = 0, fail = 0;

      // 第一轮：全部题目
      let failed = [];
      for (const q of allQs) {
        if (this.stopFlag) { log('已中止'); break; }
        try {
          await this.answerOne(q, 1);
          this.doneSet.add(q.id);
          ok++;
          log(`已作答 (${ok}/${allQs.length})`);
          await new Promise(r => setTimeout(r, 400));
        } catch (e) {
          fail++;
          failed.push(q);
          log(`✗ 作答失败（将稍后重试）：${e.message}`);
        }
      }

      // 重试轮：对失败的题逐轮重试，超时递增
      for (let round = 1; round <= this.RETRY_ROUNDS && failed.length; round++) {
        if (this.stopFlag) break;
        const tryNo = round + 1;
        const toSec = Math.round((this.RETRY_BASE_TIMEOUT_MS + (tryNo - 1) * this.RETRY_STEP_TIMEOUT_MS) / 1000);
        log(`——— 第 ${round} 轮重试：${failed.length} 道失败题（第 ${tryNo} 次尝试，LLM 超时 ${toSec}s）———`);
        await new Promise(r => setTimeout(r, 3000));   // 歇一下，避开网络抖动
        const still = [];
        for (const q of failed) {
          if (this.stopFlag) break;
          try {
            await this.answerOne(q, tryNo);
            this.doneSet.add(q.id);
            ok++; fail--;
            log(`✓ 重试成功：题 ${q.index}`);
          } catch (e) {
            still.push(q);
            log(`✗ 重试仍失败：题 ${q.index} → ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 500));
        }
        failed = still;
        if (!failed.length) { log('所有失败题均已重试成功'); break; }
      }

      if (failed.length) log(`⚠ 仍失败 ${failed.length} 道：${failed.map(q => q.index).join(', ')}`);
      log(`自动作答结束：成功 ${ok}，失败 ${fail}`);
      this.running = false;
      // 作答结束后唤醒提交检查：若此时已开自动提交，立刻复核一次门禁
      if (typeof AutoSubmit !== 'undefined' && AutoSubmit.armed) {
        log('自动作答已结束，交给自动提交复核门禁…');
        setTimeout(() => { try { AutoSubmit.tick(); } catch (e) {} }, 1500);
      }
    },

    start() {
      if (this.running) return;
      this.run();
    },
    stop() {
      this.stopFlag = true;
      this.running = false;
      log('自动作答已停止');
    },
    toggle(on) { on ? this.start() : this.stop(); },
  };

  /* ============ 视频模块（移植并改造自 main.user.js） ============
   * 原 main.user.js 硬编码哈希类名（.listCon-zrsBh / .item-blpma / .btn-DOCWn），
   * CSS Modules 构建产物，平台更新即失效。这里改为「语义文字 + 模糊匹配」优先，
   * 哈希类名仅作最后兜底。
   * 视频页：teacher.ewt360.com/...#/homework/play-videos
   */

  // 找可见、可点的按钮（按文字）
  function findButtonByText(texts) {
    const nodes = [...document.querySelectorAll('button,span,div,a')];
    for (const el of nodes) {
      const t = text(el);
      if (!t || t.length > 12) continue;
      if (!texts.includes(t)) continue;
      if (el.disabled) continue;
      // 排除内含其它可点按钮的包装容器
      if (el.tagName !== 'BUTTON' && el.querySelector('button')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // 找最内层：如果自己不是button但内部有同文字的button，用内部的
      const btn = el.querySelector('button');
      return btn || el;
    }
    return null;
  }

  /* ---- 倍速（点播放器菜单里的 2X，不做任何突破） ----
   * 注：曾实现过直接改 video.playbackRate 开到 10X/16X，但平台会检测并暂停播放，
   *    弹「检测到第三方辅助工具」并拒绝记录学习数据，已移除高倍速方案。
   *    现在只点菜单里平台自己提供的 2X。
   */
  const SpeedControl = {
    intervalId: null,
    target: '2X',
    tick() {
      try {
        const items = document.querySelectorAll('.vjs-menu-content .vjs-menu-item');
        let matched = null;
        for (const it of items) {
          const t = (it.querySelector('.vjs-menu-item-text')?.textContent || '').trim();
          if (t === this.target) { matched = it; break; }
        }
        if (!matched) return;
        if (matched.classList.contains('vjs-selected')) return;
        matched.click();
        log(`已设为 ${this.target} 倍速`);
      } catch (e) { log('倍速出错：' + e.message); }
    },
    start() {
      if (this.intervalId) return;
      this.tick();
      this.intervalId = setInterval(() => this.tick(), 3000);
      log('倍速已开启（目标 ' + this.target + '）');
    },
    stop() {
      if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; log('倍速已关闭'); }
    },
    toggle(on) { on ? this.start() : this.stop(); }
  };

  /* ---- 自动跳过 / 下一节 ---- */
  const AutoSkip = {
    intervalId: null,
    tick() {
      try {
        const btn = findButtonByText(['跳过', '跳过本节', '下一节', '下一个']);
        if (!btn) return;
        if (btn.dataset.ewtSkipped) return;
        btn.dataset.ewtSkipped = 'true';
        btn.click();
        log('已自动跳过');
        setTimeout(() => delete btn.dataset.ewtSkipped, 4000);
      } catch (e) { log('跳过出错：' + e.message); }
    },
    start() {
      if (this.intervalId) return;
      this.intervalId = setInterval(() => this.tick(), 1200);
      log('自动跳过已开启');
    },
    stop() {
      if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; log('自动跳过已关闭'); }
    },
    toggle(on) { on ? this.start() : this.stop(); }
  };

  /* ---- 自动连播（进度达标后切下一个视频） ----
   * 实测（2026-10-05）：视频页 .listCon-zrsBh（容器，n:3）、.lessonList-XSVei（n:3）。
   * main.user.js 用的是 .item-blpma / .item-blpma.active-EI2Hl，先按它试，失败再降级。
   */
  const AutoPlay = {
    intervalId: null,
    threshold: 0.97,       // 进度比阈值（仅在无 ended 时兜底，取接近真播完）
    RETRY_MS: 3000,        // 点击后 3 秒仍无变化才允许重试
    NO_VIDEO_GRACE: 8000,  // 无 video 元素时，需连续观察这么久才认为「视频真的结束」（防切清晰度/缓冲误判）
    SWITCH_COOLDOWN: 6000, // 两次切换之间的最小间隔，防连环误切
    lastActiveIdx: -1,
    lastSwitchAt: 0,
    noVideoSince: 0,       // 本轮「无 video」状态的起始时间
    lastProgress: 0,       // 上一次看到 video 时的播放进度比（用于判断消失是否=播完）
    seenVideo: false,      // 本会话是否见过 video（区分"从未加载"和"播放中消失"）
    findAll() {
      // 策略1：main.user.js 实测的类名
      const c1 = document.querySelector('.listCon-zrsBh');
      if (c1) {
        const items = [...c1.querySelectorAll('.item-blpma')];
        if (items.length) return items;
      }
      // 策略2：.lessonList-XSVei 的子元素
      const c2 = document.querySelector('.lessonList-XSVei');
      if (c2 && c2.children.length >= 2) return [...c2.children];
      // 策略3：语义降级 —— 找含 active 子项且有多个兄弟的容器
      for (const el of document.querySelectorAll('[class*="listCon"],[class*="lessonList"],[class*="listContainer"]')) {
        const kids = [...el.children];
        if (kids.length >= 2) return kids;
      }
      return [];
    },
    isActive(el) {
      return /active|current|playing|selected/i.test(el.className);
    },
    // 取「正在播放的」video：优先未暂停、有进度的那个
    pickVideo() {
      const vs = [...document.querySelectorAll('video')];
      if (!vs.length) return null;
      if (vs.length === 1) return vs[0];
      // 多个时：排除 ended 且未播放的，挑 currentTime 最大且 duration 有效的
      const cand = vs.filter(v => v.duration && !isNaN(v.duration) && v.duration > 0);
      if (cand.length) return cand.sort((a, b) => b.currentTime - a.currentTime)[0];
      return vs[0];
    },
    tick() {
      try {
        const list = this.findAll();
        if (list.length < 2) return;
        const video = this.pickVideo();

        // 定位当前项：优先 active；结束页可能没有 active，则找已标记 played 的最后一项
        let idx = list.findIndex(el => this.isActive(el));
        if (idx < 0) {
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].dataset.ewtPlayed) { idx = i; break; }
          }
        }
        if (idx < 0) return;
        if (idx + 1 >= list.length) return; // 已是最后一个

        const now = Date.now();

        // ===== 判定「是否该切下一个」=====
        let shouldAdvance = false;
        let reason = '';

        if (video) {
          this.noVideoSince = 0;   // 有 video，清零无视频计时
          this.seenVideo = true;
          const dur = video.duration;
          const cur = video.currentTime;
          // 记录本轮看到的最大进度，供"video 消失"时判断是否是正常播完
          if (dur && !isNaN(dur) && dur > 1) this.lastProgress = cur / dur;
          if (video.ended) {
            shouldAdvance = true; reason = 'video.ended';
          } else if (dur && !isNaN(dur) && dur > 1 && cur / dur >= this.threshold) {
            shouldAdvance = true; reason = '进度 ' + (cur / dur * 100).toFixed(1) + '% ≥ ' + (this.threshold * 100) + '%';
          }
        } else {
          // 没有 video：三种可能 ——
          //   ① 正常播完（结束页会移除 video）→ 应尽快切
          //   ② 切清晰度/缓冲导致 video 瞬时消失 → 绝不能切
          //   ③ 一进页面就是结束页（从未见过 video）→ 应尽快切
          // 区分：若消失前进度已达阈值 → 立即切；若从未见过 video → 短宽限；
          //       否则需连续 NO_VIDEO_GRACE 毫秒都无 video 才切（防止误判）。
          if (!this.noVideoSince) this.noVideoSince = now;
          const waited = now - this.noVideoSince;
          if (this.lastProgress >= this.threshold) {
            shouldAdvance = true; reason = 'video 消失（消失前进度 ' + (this.lastProgress * 100).toFixed(1) + '%）';
          } else if (!this.seenVideo && waited >= 2000) {
            shouldAdvance = true; reason = '进入即无 video（' + Math.round(waited / 1000) + 's）';
          } else if (waited >= this.NO_VIDEO_GRACE) {
            shouldAdvance = true; reason = '无 video 持续 ' + Math.round(waited / 1000) + 's';
          }
        }

        if (!shouldAdvance) return;

        // 冷却：两次切换间隔太短，很可能是误判，跳过本次
        if (now - this.lastSwitchAt < this.SWITCH_COOLDOWN) {
          log(`连播：切到第${idx + 2}条被冷却拦截（${reason}）`);
          return;
        }

        const next = list[idx + 1];
        if (next.dataset.ewtPlayed) {
          const at = Number(next.dataset.ewtPlayedAt || 0);
          if (now - at < this.RETRY_MS) return; // 刚点过，等一等
          delete next.dataset.ewtPlayed; // 超时未生效，重试
          log(`重试切换下一个视频（上次点击未生效）`);
        }
        next.dataset.ewtPlayed = 'true';
        next.dataset.ewtPlayedAt = String(now);
        this.lastSwitchAt = now;
        this.noVideoSince = 0;
        this.lastProgress = 0;
        this.clickItem(next);
        log(`已自动切换到下一个视频（${idx + 2}/${list.length}）｜原因：${reason}`);
      } catch (e) { log('连播出错：' + e.message); }
    },
    /* 用完整鼠标事件序列点击列表项。
     * 部分前端框架（React 合成事件、或自实现长按判定）不响应裸 el.click()，
     * 需要补 mousedown / mouseup。这里把两种都做一遍，兼容性最好。 */
    clickItem(el) {
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      try {
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
      } catch (e) {
        try { el.click(); } catch (e2) {}
      }
    },
    // 诊断：输出 AutoPlay 眼中看到的东西，便于排查连播失效
    diagnose() {
      const list = this.findAll();
      log('--- 连播诊断 ---');
      const v = document.querySelector('video');
      if (v) {
        log(`video: dur=${v.duration} cur=${v.currentTime?.toFixed?.(1)} ended=${v.ended} paused=${v.paused} readyState=${v.readyState}`);
        if (v.duration && !isNaN(v.duration)) log(`进度比: ${(v.currentTime / v.duration * 100).toFixed(1)}% (阈值 ${this.threshold * 100}%)`);
      } else {
        log('video: ✗ 页面上没有 <video> 元素（结束页可能是这种）');
      }
      log(`列表项数: ${list.length}`);
      list.forEach((el, i) => {
        const c = typeof el.className === 'string' ? el.className : '';
        log(`  [${i}] active=${this.isActive(el)} played=${!!el.dataset.ewtPlayed} | ${c.slice(0, 45)} | ${(el.innerText || '').trim().slice(0, 20)}`);
      });
      if (!list.length) {
        log('未找到列表容器，尝试列出候选：');
        document.querySelectorAll('[class*="listCon"],[class*="lessonList"],[class*="lesson"]').forEach(el => {
          log(`  <${el.tagName}> ${(typeof el.className === 'string' ? el.className : '').slice(0, 50)} (子元素 ${el.children.length})`);
        });
      }
      // 结束页提示
      const hints = [...document.querySelectorAll('div,section,span')].filter(el => {
        const t = (el.innerText || '').trim();
        return t && t.length < 30 && /播放完成|已完成|视频结束|继续学习|下一个/.test(t);
      });
      if (hints.length) {
        log('结束页提示元素:');
        hints.slice(0, 5).forEach(el => log(`  ${(typeof el.className === 'string' ? el.className : '').slice(0, 50)} | ${(el.innerText || '').trim().slice(0, 25)}`));
      }
    },
    markCurrent() {
      // 把当前 active 项标记为"已播放"，作为后续连播定位的锚点
      const list = this.findAll();
      for (const el of list) {
        if (this.isActive(el)) el.dataset.ewtPlayed = 'true';
      }
    },
    start() {
      if (this.intervalId) return;
      this.markCurrent();
      // 立即跑一次 tick：让它尽快感知当前是否已有 video / 是否处于结束页
      this.tick();
      this.intervalId = setInterval(() => this.tick(), 2000);
      log('自动连播已开启');
    },
    stop() {
      if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; log('自动连播已关闭'); }
    },
    toggle(on) { on ? this.start() : this.stop(); }
  };

  /* ---- 锁定进度条（禁止拖动） ---- */
  const ProgressLock = {
    enabled: false,
    toggle(on) {
      this.enabled = on;
      const id = `${APP}-progress-lock`;
      if (on) {
        if (document.getElementById(id)) return;
        const s = document.createElement('style');
        s.id = id;
        s.textContent = '[class*="progress"]{pointer-events:none!important;cursor:not-allowed!important;}';
        (document.head || document.documentElement).appendChild(s);
        log('进度条已锁定');
      } else {
        document.getElementById(id)?.remove();
        log('进度条已解锁');
      }
    },
  };

  /* ============ 日志 ============ */
  const logs = [];
  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logs.push(line);
    if (logs.length > 60) logs.shift();
    const p = document.getElementById(`${APP}-log`);
    if (p) { p.textContent = logs.slice(-12).join('\n'); p.scrollTop = p.scrollHeight; }
    console.log('[EWT]', msg);
    // 同步刷新状态条（面板顶部，保证不用滚动就能看到）
    const st = document.getElementById(`${APP}-status`);
    if (st) st.textContent = msg;
  }

  /* ============ 面板 ============ */
  function setToggle(id, on) {
    state[id] = on;
    save();
    const el = document.querySelector(`#${APP}-root [data-t="${id}"]`);
    if (el) el.checked = on;
  }

  function render() {
    const p = document.getElementById(`${APP}-panel`); if (!p) return;
    p.querySelector('.summary').textContent = `任务 ${last.tasks.length} 项｜题目 ${last.questions.length} 道｜当前路由：${location.hash || '(无)'}`;
    const list = p.querySelector('.list');
    const tasks = last.tasks.map(t => `<div class="item"><b>${esc(t.title)}</b><span class="badge ${t.status}">${t.status === 'done' ? '已完成' : t.status === 'todo' ? '待处理' : t.status === 'doing' ? '进行中' : '未识别'}</span><small>${esc(t.summary)}</small></div>`).join('');
    const qs = last.questions.map(q => `<div class="item"><b>${q.index}. ${esc(q.question)}</b>${q.options.length ? `<small>${q.options.map((o,i)=>`${String.fromCharCode(65+i)}. ${esc(o)}`).join('<br>')}</small>` : ''}</div>`).join('');
    list.innerHTML = (tasks || qs) ? `${tasks}<h4>当前题目</h4>${qs || '<small>未识别到题目。可切换到具体作答页面后重新扫描。</small>'}` : '<small>当前页面未识别到任务或题目。</small>';
  }

  /* ============ API 设置弹层（智谱 GLM） ============
   * 用户在这里填自己的 API Key；保存后由 bridge 用 GM_setValue 持久化（跨站点共享）。
   * 主脚本不落任何 Key（页面上下文 localStorage 会随站点隔离，且开源后不该存这里）。
   */
  const ApiConfig = {
    el: null,
    cache: null,

    open() {
      const box = document.getElementById(`${APP}-cfg`);
      if (!box) { init(); }
      const b2 = document.getElementById(`${APP}-cfg`);
      if (!b2) return;
      b2.hidden = false;
      this.load();
    },

    close() {
      const box = document.getElementById(`${APP}-cfg`);
      if (box) box.hidden = true;
    },

    setStatus(msg, kind) {
      const s = document.getElementById(`${APP}-cfg-status`);
      if (!s) return;
      s.textContent = msg || '';
      s.className = 'cfg-status' + (kind ? ' ' + kind : '');
    },

    /* 拉取 bridge 里的当前配置填入表单 */
    async load() {
      const keyEl = document.getElementById(`${APP}-cfg-key`);
      if (!keyEl) return;
      this.setStatus('读取中…');
      try {
        const res = await LLM.getConfig();
        const c = res.config || {};
        this.cache = c;
        keyEl.value = c.apiKey || '';
        document.getElementById(`${APP}-cfg-base`).value = c.baseUrl || '';
        document.getElementById(`${APP}-cfg-mv`).value = c.modelVision || '';
        document.getElementById(`${APP}-cfg-md`).value = c.modelDeep || '';
        document.getElementById(`${APP}-cfg-to`).value = c.timeout || 180000;
        // 采样 / 推理参数
        document.getElementById(`${APP}-cfg-temp`).value = (c.temperature === 0 || c.temperature) ? c.temperature : '';
        document.getElementById(`${APP}-cfg-effort`).value = c.reasoningEffort || '';
        // 用 placeholder 展示生效默认值
        document.getElementById(`${APP}-cfg-base`).placeholder = c.defaultBaseUrl || '';
        document.getElementById(`${APP}-cfg-mv`).placeholder = c.defaultModelVision || '';
        document.getElementById(`${APP}-cfg-md`).placeholder = c.defaultModelDeep || '';
        document.getElementById(`${APP}-cfg-temp`).placeholder = String(c.defaultTemperature != null ? c.defaultTemperature : 0.1);
        if (c.keyUrl) document.getElementById(`${APP}-cfg-keylink`).href = c.keyUrl;
        if (c.docs) document.getElementById(`${APP}-cfg-docs`).textContent = c.docs;
        // 生效参数摘要：温度 / 思考强度 / top_p
        const eff = `温度 ${c.effectiveTemperature != null ? c.effectiveTemperature : 0.1}` +
          `、top_p ${c.defaultTopP != null ? c.defaultTopP : 0.95}` +
          `、思考 ${c.effectiveReasoningEffort || '默认(max)'}`;
        this.setStatus(
          c.configured ? `已配置 ｜ ${c.effectiveModelVision} ｜ ${eff}` : '尚未配置，请填写 API Key',
          c.configured ? 'ok' : 'warn'
        );
      } catch (e) {
        this.setStatus('无法读取配置：' + (e.message || e) + '（bridge 脚本是否已安装？）', 'err');
      }
    },

    collect() {
      // 超时必须归一化：input 里可能填 0 / 负数 / 非数字，
      // `Number(-5) || 180000` 会把 -5 原样留下 → 请求立即超时且无明显提示。
      const rawTo = Number(document.getElementById(`${APP}-cfg-to`).value);
      const timeout = (!isFinite(rawTo) || rawTo < 5000) ? 180000 : rawTo;
      // temperature：0 是合法值（最确定），用 '' 表示"用默认"。其余非法值一律空串（交给 bridge 回落）。
      const rawTemp = document.getElementById(`${APP}-cfg-temp`).value.trim();
      let temperature = '';
      if (rawTemp !== '') {
        const n = Number(rawTemp);
        temperature = (isFinite(n) && n >= 0 && n <= 2) ? n : '';
      }
      // reasoning_effort：空 = 用官方默认(max)；只接受 low/high/max
      const rawEffort = document.getElementById(`${APP}-cfg-effort`).value;
      const reasoningEffort = ['low', 'high', 'max'].indexOf(rawEffort) >= 0 ? rawEffort : '';
      return {
        apiKey: (document.getElementById(`${APP}-cfg-key`).value || '').trim(),
        baseUrl: (document.getElementById(`${APP}-cfg-base`).value || '').trim(),
        modelVision: (document.getElementById(`${APP}-cfg-mv`).value || '').trim(),
        modelDeep: (document.getElementById(`${APP}-cfg-md`).value || '').trim(),
        timeout,
        temperature,
        reasoningEffort,
      };
    },

    async save() {
      this.setStatus('保存中…');
      try {
        const res = await LLM.setConfig(this.collect());
        this.cache = res.config;
        this.setStatus('已保存 ✓ 立即生效', 'ok');
        log('API 设置已保存');
      } catch (e) {
        this.setStatus('保存失败：' + (e.message || e), 'err');
      }
    },

    async test() {
      const btn = document.getElementById(`${APP}-cfg-test`);
      const old = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
      this.setStatus('正在测试连通性（最多 30s）…');
      try {
        const res = await LLM.testConfig(this.collect());
        const r = res.result || {};
        if (r.ok) this.setStatus(`连通成功 ✓ 模型 ${r.model} 返回「${r.text}」`, 'ok');
        else this.setStatus('测试失败：' + (r.error || '未知错误'), 'err');
      } catch (e) {
        this.setStatus('测试失败：' + (e.message || e), 'err');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = old || '测试连接'; }
      }
    },

    async clear() {
      if (!confirm('确定清空已保存的 API Key 吗？')) return;
      this.setStatus('清空中…');
      try {
        await LLM.setConfig({ apiKey: '', baseUrl: '', modelVision: '', modelDeep: '' });
        ['key', 'base', 'mv', 'md'].forEach(k => { const el = document.getElementById(`${APP}-cfg-${k}`); if (el) el.value = ''; });
        this.setStatus('已清空', 'warn');
      } catch (e) {
        this.setStatus('清空失败：' + (e.message || e), 'err');
      }
    },

    /* 显示/隐藏 Key 明文 */
    toggleReveal() {
      const el = document.getElementById(`${APP}-cfg-key`);
      if (!el) return;
      el.type = el.type === 'password' ? 'text' : 'password';
    },
  };

  function init() {
    if (!document.body) return;
    // 自愈：SPA 可能重建 body，导致我们的 root 被移除。已存在则跳过。
    if (document.getElementById(`${APP}-root`)) return;
    const root = document.createElement('section'); root.id = `${APP}-root`;
    root.innerHTML = `<button class="fab">📖</button><div id="${APP}-panel" hidden>
      <b>EWT 作业学习助手</b>
      <div class="warn">自动作答的答案由 ewt-llm-bridge 脚本生成。所有功能默认关闭。</div>
      <div id="${APP}-status" class="status">就绪</div>
      <div class="group-title">答题页</div>
      <div class="toggles">
        <label class="tg"><input type="checkbox" data-t="autoAnswer"><span>自动作答</span></label>
        <label class="tg"><input type="checkbox" data-t="autoCheckPass"><span>自动过检</span></label>
        <label class="tg"><input type="checkbox" data-t="autoSubmit"><span>自动提交</span></label>
        <label class="tg"><input type="checkbox" data-t="autoSelfGrade"><span>自批满分</span></label>
      </div>
      <div class="group-title">视频页</div>
      <div class="toggles">
        <label class="tg"><input type="checkbox" data-t="speedControl"><span>倍速(2X)</span></label>
        <label class="tg"><input type="checkbox" data-t="autoSkip"><span>自动跳过</span></label>
        <label class="tg"><input type="checkbox" data-t="autoPlay"><span>自动连播</span></label>
        <label class="tg"><input type="checkbox" data-t="lockProgress"><span>锁进度条</span></label>
      </div>
      <div class="summary">扫描中…</div>
      <div class="actions"><button data-a="apiConfig">⚙ API 设置</button><button data-a="answer">开始作答</button><button data-a="selfGrade">自批满分</button><button data-a="diag">诊断题目</button><button data-a="playDiag">连播诊断</button><button data-a="videoAll">视频一键全套</button><button data-a="scan">重新扫描</button><button data-a="copy">复制题目</button><button data-a="export">导出 JSON</button><button data-a="text">导出笔记</button><button data-a="hide">隐藏</button></div>
      <pre id="${APP}-log" class="log"></pre>
      <div class="list"></div>
    </div>
    <div id="${APP}-cfg" class="cfg" hidden>
      <b>⚙ API 设置（智谱 GLM）</b>
      <p class="cfg-docs" id="${APP}-cfg-docs">在智谱开放平台申请 API Key 后填入即可。</p>
      <label class="cfg-row"><span>API Key</span>
        <span class="cfg-keywrap">
          <input id="${APP}-cfg-key" type="password" placeholder="形如 xxxxxxxx.yyyyyyyy" autocomplete="off" spellcheck="false">
          <button type="button" id="${APP}-cfg-reveal" title="显示/隐藏">👁</button>
        </span>
      </label>
      <label class="cfg-row"><span>接口地址</span>
        <input id="${APP}-cfg-base" type="text" placeholder="https://open.bigmodel.cn/api/paas/v4" spellcheck="false">
      </label>
      <label class="cfg-row"><span>带图题模型</span>
        <input id="${APP}-cfg-mv" type="text" placeholder="glm-5.3-flashx" spellcheck="false">
      </label>
      <label class="cfg-row"><span>长答案模型</span>
        <input id="${APP}-cfg-md" type="text" placeholder="glm-5.3-flash" spellcheck="false">
      </label>
      <label class="cfg-row"><span>超时(ms)</span>
        <input id="${APP}-cfg-to" type="number" min="10000" step="1000" placeholder="180000">
      </label>
      <label class="cfg-row"><span>温度</span>
        <input id="${APP}-cfg-temp" type="number" min="0" max="2" step="0.1" placeholder="0.1">
      </label>
      <label class="cfg-row"><span>思考强度</span>
        <select id="${APP}-cfg-effort">
          <option value="">默认（官方 max）</option>
          <option value="max">max（最强推理）</option>
          <option value="high">high</option>
          <option value="low">low（更快更省）</option>
        </select>
      </label>
      <div class="cfg-hint">留空则使用默认值（灰色示例即默认）。温度越低答案越稳定（0~2，推荐 0.1）；GLM-5.3 系列思考链强制开启，选 low 可显著提速省费。Key 仅保存在本机，不会上传到任何服务器。</div>
      <div class="cfg-status" id="${APP}-cfg-status"></div>
      <div class="cfg-actions">
        <button type="button" id="${APP}-cfg-save">保存</button>
        <button type="button" id="${APP}-cfg-test">测试连接</button>
        <button type="button" id="${APP}-cfg-clear">清空</button>
        <a id="${APP}-cfg-keylink" href="https://open.bigmodel.cn/usercenter/apikeys" target="_blank" rel="noopener">申请 Key ↗</a>
        <button type="button" id="${APP}-cfg-close">关闭</button>
      </div>
    </div>`;
    document.body.appendChild(root); const p = root.querySelector('div[id]');
    root.querySelector('.fab').onclick = () => { p.hidden = !p.hidden; if (!p.hidden) scan(); };
    root.querySelector('[data-a="scan"]').onclick = scan;
    root.querySelector('[data-a="copy"]').onclick = copyQuestions;
    root.querySelector('[data-a="export"]').onclick = exportData;
    root.querySelector('[data-a="text"]').onclick = exportText;
    root.querySelector('[data-a="hide"]').onclick = () => p.hidden = true;
    // API 设置弹层
    root.querySelector('[data-a="apiConfig"]').onclick = () => ApiConfig.open();
    root.querySelector(`#${APP}-cfg-save`).onclick = () => ApiConfig.save();
    root.querySelector(`#${APP}-cfg-test`).onclick = () => ApiConfig.test();
    root.querySelector(`#${APP}-cfg-clear`).onclick = () => ApiConfig.clear();
    root.querySelector(`#${APP}-cfg-close`).onclick = () => ApiConfig.close();
    root.querySelector(`#${APP}-cfg-reveal`).onclick = () => ApiConfig.toggleReveal();
    root.querySelector('[data-a="answer"]').onclick = () => {
      log('点击了「开始作答」');
      const qs = AutoAnswer.collectQuestions();
      log(`识别到 ${qs.length} 道可作答题`);
      if (!qs.length) { AutoAnswer.diagnose(); return; }
      AutoAnswer.start();
    };
    root.querySelector('[data-a="diag"]').onclick = () => AutoAnswer.diagnose();
    root.querySelector('[data-a="selfGrade"]').onclick = () => {
      log('点击了「自批满分」');
      if (!SelfGrade.getDialog()) { log('⚠ 未检测到自批弹窗，请先进入批改界面（提交后自动弹出）'); return; }
      SelfGrade.start();
    };
    root.querySelector('[data-a="playDiag"]').onclick = () => AutoPlay.diagnose();

    root.querySelector('[data-t="autoAnswer"]').onchange = e => { state.autoAnswer = e.target.checked; save(); AutoAnswer.toggle(e.target.checked); };
    root.querySelector('[data-t="autoCheckPass"]').onchange = e => { state.autoCheckPass = e.target.checked; save(); AutoCheckPass.toggle(e.target.checked); };
    root.querySelector('[data-t="autoSubmit"]').onchange = e => { state.autoSubmit = e.target.checked; save(); AutoSubmit.toggle(e.target.checked); };
    root.querySelector('[data-t="autoSelfGrade"]').onchange = e => { state.autoSelfGrade = e.target.checked; save(); AutoSelfGradeWatch.toggle(e.target.checked); };
    root.querySelector('[data-t="speedControl"]').onchange = e => { state.speedControl = e.target.checked; save(); SpeedControl.toggle(e.target.checked); };
    root.querySelector('[data-t="autoSkip"]').onchange = e => { state.autoSkip = e.target.checked; save(); AutoSkip.toggle(e.target.checked); };
    root.querySelector('[data-t="autoPlay"]').onchange = e => { state.autoPlay = e.target.checked; save(); AutoPlay.toggle(e.target.checked); };
    root.querySelector('[data-t="lockProgress"]').onchange = e => { state.lockProgress = e.target.checked; save(); ProgressLock.toggle(e.target.checked); };

    // 视频一键全套
    root.querySelector('[data-a="videoAll"]').onclick = () => {
      const on = !state.videoAllOn;
      state.videoAllOn = on;
      // 视频页的「题目」就是过检动作，所以全套要包含 autoCheckPass
      ['speedControl', 'autoSkip', 'autoPlay', 'lockProgress', 'autoCheckPass'].forEach(id => {
        state[id] = on;
        const el = root.querySelector(`[data-t="${id}"]`);
        if (el) el.checked = on;
      });
      save();
      SpeedControl.toggle(on);
      AutoSkip.toggle(on);
      AutoPlay.toggle(on);
      ProgressLock.toggle(on);
      AutoCheckPass.toggle(on);
      log(on ? '视频全套已开启（过检+倍速+连播）' : '视频全套已关闭');
    };

    // 恢复上次开关状态（自动作答不自动恢复，避免刷新即跑）
    if (state.autoCheckPass) { root.querySelector('[data-t="autoCheckPass"]').checked = true; AutoCheckPass.start(); }
    if (state.autoSubmit) { root.querySelector('[data-t="autoSubmit"]').checked = true; AutoSubmit.start(); }
    if (state.autoSelfGrade) { root.querySelector('[data-t="autoSelfGrade"]').checked = true; AutoSelfGradeWatch.start(); }
    if (state.speedControl) { root.querySelector('[data-t="speedControl"]').checked = true; SpeedControl.start(); }
    if (state.autoSkip) { root.querySelector('[data-t="autoSkip"]').checked = true; AutoSkip.start(); }
    if (state.autoPlay) { root.querySelector('[data-t="autoPlay"]').checked = true; AutoPlay.start(); }
    if (state.lockProgress) { root.querySelector('[data-t="lockProgress"]').checked = true; ProgressLock.toggle(true); }

    scan();
    // 答题页 DOM 变动极频繁（长文章/滚动），用更长防抖，避免卡顿
    const isAnswerPage = /answer-pc\/exam/.test(location.pathname);
    const debounce = isAnswerPage ? 2500 : 800;
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, debounce); }).observe(document.body, { childList:true, subtree:true, characterData:true });
  }

  function injectStyle() {
    if (!document.head) return false;
    if (document.getElementById(`${APP}-style`)) return true;
    const style = document.createElement('style');
    style.id = `${APP}-style`;
    style.textContent = `#${APP}-root{position:fixed;right:18px;bottom:18px;z-index:2147483647;font:14px/1.45 system-ui;color:#172033}.fab{width:48px;height:48px;border:0;border-radius:50%;background:#2563eb;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 4px 16px #0003}#${APP}-panel{width:min(520px,calc(100vw - 36px));max-height:min(720px,calc(100vh - 90px));overflow:auto;margin-bottom:10px;padding:14px;border:1px solid #dbeafe;border-radius:12px;background:#fff;box-shadow:0 8px 30px #0003}.warn{margin:8px 0;padding:8px;background:#eff6ff;color:#1e40af;font-size:12px}.status{margin:8px 0;padding:6px 8px;background:#ecfdf5;color:#065f46;font-size:12px;font-weight:bold;border-radius:6px;border:1px solid #a7f3d0}.group-title{margin:10px 0 4px;font-size:12px;font-weight:bold;color:#334155;border-left:3px solid #2563eb;padding-left:6px}.toggles{display:flex;gap:16px;margin:8px 0}.tg{display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer}.summary{color:#64748b;font-size:12px}.actions{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.actions button{padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;cursor:pointer}.log{margin:0 0 8px;padding:6px;max-height:120px;overflow:auto;background:#0f172a;color:#7dd3fc;font-size:11px;border-radius:6px;white-space:pre-wrap}.item{padding:8px 0;border-top:1px solid #e5e7eb}.item small{display:block;margin-top:4px;color:#64748b}.badge{float:right;padding:2px 5px;border-radius:4px;font-size:11px}.badge.done{background:#dcfce7;color:#166534}.badge.todo{background:#fef3c7;color:#92400e}.badge.doing{background:#dbeafe;color:#1e40af}.item .task-link{display:inline-block;margin-top:5px;color:#2563eb}h4{margin:12px 0 4px}.toggles{flex-wrap:wrap;gap:12px}.cfg{position:fixed;right:18px;bottom:78px;z-index:2147483647;width:min(420px,calc(100vw - 36px));max-height:calc(100vh - 110px);overflow:auto;margin:0;padding:14px;border:1px solid #bfdbfe;border-radius:12px;background:#f8fbff;box-shadow:0 8px 30px #0005;font:14px/1.45 system-ui;color:#172033}.cfg-docs{margin:6px 0 10px;font-size:12px;color:#475569}.cfg-row{display:flex;align-items:center;gap:8px;margin:7px 0;font-size:13px}.cfg-row>span:first-child{width:82px;flex:none;color:#334155}.cfg-row input{flex:1;min-width:0;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font:12px/1.4 ui-monospace,Consolas,monospace;background:#fff;color:#172033}.cfg-row select{flex:1;min-width:0;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font:12px/1.4 system-ui;background:#fff;color:#172033}.cfg-keywrap{flex:1;display:flex;gap:4px;min-width:0}.cfg-keywrap input{flex:1}.cfg-keywrap button{flex:none;padding:0 8px;border:1px solid #cbd5e1;border-radius:6px;background:#f1f5f9;cursor:pointer}.cfg-hint{margin:8px 0;font-size:11px;color:#64748b}.cfg-status{margin:8px 0;min-height:16px;font-size:12px;font-weight:bold}.cfg-status.ok{color:#047857}.cfg-status.warn{color:#b45309}.cfg-status.err{color:#b91c1c}.cfg-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px}.cfg-actions button{padding:6px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer}.cfg-actions button:disabled{opacity:.6;cursor:default}.cfg-actions a{margin-left:auto;font-size:12px;color:#2563eb}`;
    document.head.appendChild(style);
    return true;
  }

  // isTrusted 劫持必须尽早；UI 等 DOM 就绪。两者分开处理。
  console.log('%c[EWT] 脚本已加载 v3.9.0 @ ' + location.href, 'color:#2563eb;font-weight:bold');
  // 测试钩子：仅供 jsdom 回归测试读取内部模块，生产环境无副作用
  try { window.__EWT_TEST__ = { AutoAnswer, AutoSubmit, LLM, Html2Canvas, AutoCheckPass, AutoPlay, SpeedControl, SelfGrade, AutoSelfGradeWatch, ApiConfig }; } catch (e) {}
  // 上传拦截器尽早安装（需在业务点击前完成劫持）
  try { AutoAnswer.installUploadInterceptor(); } catch (e) { console.warn('[EWT] 上传拦截器安装失败', e); }
  installVisibilitySpoof();
  LLM.init();

  /* ---- 自批弹窗常驻探测器 ----
   * 自批弹窗可能在任意页面/任意时刻出现（提交后、从 report/analysis 页「去批改」进入等），
   * 且渲染有延迟（弹窗本体先出现，.content-right 等内部结构后出现）。
   *
   * 设计要点（v3.8.3 重写）：
   *   - 不再用一次性 handed 标记 —— 弹窗渲染是异步的，第一次扫到时内部可能还没好。
   *   - 改为：只要弹窗存在，就【持续】调用 ensureRunning()（幂等，内部有 intervalId 守卫）。
   *   - 弹窗消失时把 handed 复位，以便下次再进入自批时重新接管。
   *   - 独立于面板开关，也独立于 init() 时机。
   */
  (function watchSelfGradePopModal() {
    let lastLogged = false;
    setInterval(() => {
      const dlg = document.querySelector('.proofreadPopModal, [class*="proofreadPopModal"]');
      if (!dlg) { lastLogged = false; return; }
      // 持续驱动（ensureRunning 幂等，不会重复创建轮询）
      try {
        AutoSelfGradeWatch.ensureRunning();
        if (!lastLogged) {
          lastLogged = true;
          console.log('[EWT] 检测到自批弹窗，自动接管（批改→提交→确认）');
        }
      } catch (e) { console.warn('[EWT] 自批接管失败', e); }
    }, 1000);
  })();
  (function boot() {
    if (document.body) {
      if (!injectStyle()) { setTimeout(boot, 50); return; }
      init();
      return;
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        if (!injectStyle()) { setTimeout(boot, 50); return; }
        init();
      }, { once: true });
    } else {
      setTimeout(boot, 50);
    }
  })();
  // 兜底自愈：每 3 秒检查 root 是否还在（应对 SPA 重建 body / 路由切换）
  setInterval(() => {
    if (!document.body) return;
    if (!document.getElementById(`${APP}-style`)) injectStyle();
    if (!document.getElementById(`${APP}-root`)) init();
  }, 3000);
})();
