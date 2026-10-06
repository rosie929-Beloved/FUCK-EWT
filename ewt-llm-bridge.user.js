// ==UserScript==
// @name         EWT LLM Bridge (答案生成管道)
// @namespace    https://github.com/rosie929-Beloved/FUCK-EWT
// @version      3.0.1
// @description  负责调用智谱 GLM 生成答案，通过 postMessage 与主脚本通信。API Key 由用户在界面里自行配置、本地保存（GM_setValue），不会上传到任何服务器，也不会写进脚本源码。另提供 GM 文本抓取（用于加载 html2canvas）。不做任何 DOM 操作。
// @author       rosie929-Beloved
// @match        https://web.ewt360.com/answer-pc/*
// @match        http://web.ewt360.com/answer-pc/*
// @match        https://web.ewt360.com/*
// @match        http://web.ewt360.com/*
// @match        https://teacher.ewt360.com/*
// @match        http://teacher.ewt360.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

/**
 * 为什么必须单独一个脚本：
 *   GM_xmlhttpRequest 需要 @grant，脚本会被包进沙箱，
 *   沙箱里劫持 EventTarget.prototype 对页面无效 → 主脚本的 isTrusted 绕过会失效。
 *   所以把「网络请求」和「DOM/劫持」拆成两个脚本，用 postMessage 通信。
 */
(function () {
  'use strict';

  /* ==================================================================
   *  GLM 配置层（v3.0.0）
   *  ------------------------------------------------------------------
   *  本脚本只支持智谱 GLM（BigModel）一条通道 —— OpenAI 兼容协议、官方直连。
   *
   *  为什么做成「用户自己填 Key」：
   *    - 脚本要开源，不能内置任何人的 Key（内置 Key 会被人刷爆、也有泄露风险）；
   *    - 用户在「主脚本 → ⚙ API 设置」里填自己的 Key，本地保存（GM_setValue），不外传。
   *
   *  配置结构（存于 GM key = CONFIG_KEY）：
   *    {
   *      apiKey:      'xxxxx.yyyyy',   // 智谱 API Key（必填）
   *      baseUrl:     '',              // 留空 → 用默认官方地址
   *      modelVision: '',              // 带图/快档模型；留空 → 用 DEFAULT_MODELS.vision
   *      modelDeep:   '',              // 长答案/上传型模型；留空 → 用 DEFAULT_MODELS.deep
   *      timeout:     180000
   *    }
   * ================================================================== */

  const CONFIG_KEY = 'ewt_llm_config';

  /* 固定通道信息（智谱 GLM） */
  const PROVIDER = {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    docs: '在「智谱开放平台」申请 API Key 后填入即可。glm-5.3-flash / glm-5.3-flashx 支持图片输入。',
  };

  /* ============ 模型分档（2026-10-06 实测得出的关键优化）============
   * 原来所有题型都用 glm-5.3-flash，它是**常开思维链**的推理模型
   * （实测关不掉，报「该模型始终思考，不支持关闭思考」），reasoning_tokens 随难度爆炸：
   *   上传型主观题单题实测最坏 **98.8 秒 / 4571 reasoning tokens**。
   *
   * 【硬约束】只有 glm-5.3-flash / glm-5.3-flashx 支持图片输入！
   *   实测其余模型（glm-5、5.1、5.2、5.3、glm-5-turbo、glm-4.5-flash、glm-4.5-air）
   *   传 image_url 一律报「messages.content.type 参数非法，取值范围 ['text']」。
   *   → 所以不能简单地把图片题丢给快模型，只能在这两个之间选。
   *
   * 实测耗时对比（同题）：
   *   题型                glm-5.3-flash        glm-5.3-flashx
   *   带图识别              3.7s                 1.4s        ← 快 2.6 倍，答案一致
   *   纯文本选择题          3.3s                 1.4s
   *   上传型长答案         29.8s（2941 tok）     31.2s         ← 需要长推理时反而不占优
   *
   * 所以策略：
   *   - 带图/公式题 → glm-5.3-flashx（支持图 + 明显更快，答案质量实测一致）
   *   - 上传型主观题 → glm-5.3-flash（要长链条推理，实测质量更稳）
   *   - 纯文本选择/简答 → glm-5.3-flashx（同族里最快的）
   */
  const DEFAULT_MODELS = {
    vision: 'glm-5.3-flashx',   // 支持图片，快（带图题 / 公式题）
    deep: 'glm-5.3-flash',      // 支持图片，长推理更稳（上传型主观题）
  };

  /* ============ 采样 / 推理参数（对齐智谱官方推荐）============
   * 官方对 GLM-5.3-Flash/FlashX 的推荐：temperature:1、top_p:0.95、reasoning_effort:max
   *   https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
   *
   * 我们的取值策略：
   *   - temperature 默认 **0.1**（官方建议 1）：答题要答案稳定可复现，低温度更合适。
   *     同一道题重复调用应给出相同选项，高温度会漂移。
   *   - top_p 固定 0.95（官方推荐，无理由偏离）。
   *   - reasoning_effort 默认 **不传**（= 官方默认 max）；可选 low / high / max。
   *     GLM-5.3 系列 minds 常开且关不掉，想提速省钱就设 low —— 这是官方给的正规途径。
   *   - thinking 固定 {type:'enabled', clear_thinking:false}（该系列唯一合法值）。 */
  const DEFAULT_SAMPLING = {
    temperature: 0.1,
    topP: 0.95,
    reasoningEffort: '',   // '' = 不传，用官方默认；可选 'low' | 'high' | 'max'
  };
  const VALID_EFFORTS = ['low', 'high', 'max'];

  /* 默认配置：不内置任何 Key，未配置就是未配置 */
  const DEFAULT_CONFIG = {
    apiKey: '',
    baseUrl: '',
    modelVision: '',
    modelDeep: '',
    timeout: 180000,
    temperature: DEFAULT_SAMPLING.temperature,
    reasoningEffort: DEFAULT_SAMPLING.reasoningEffort,
  };

  /* ---- 配置持久化（兼容 GM_* 与 localStorage 回退）---- */
  function storageGet(key, def) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, def);
    } catch (e) {}
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? def : JSON.parse(raw);
    } catch (e) { return def; }
  }
  function storageSet(key, val) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; }
    } catch (e) {}
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* 读取配置（补全默认字段） */
  function loadConfig() {
    const raw = storageGet(CONFIG_KEY, null);
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...raw };
  }

  function saveConfig(patch) {
    const next = { ...loadConfig(), ...(patch || {}) };
    storageSet(CONFIG_KEY, next);
    return next;
  }

  /* 安全转字符串：容忍配置里被写入非字符串（数字 / null / 对象等脏数据）。
   * 【为什么需要】GM_setValue 在部分管理器里做 JSON 序列化，旧版本残留或手工改配置
   * 都可能让字段变成数字/对象；直接 .trim() 会抛 "xxx.trim is not a function"，整条链路崩。 */
  function str(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
  }

  /* 去掉 URL 结尾的斜杠：用户从文档复制 baseUrl 常带尾斜杠，
   * 直接拼 `/chat/completions` 会得到 `.../v4//chat/completions`（双斜杠），
   * 部分网关会因此 404 或路由错误。 */
  function rstripSlash(u) {
    return str(u).trim().replace(/\/+$/, '');
  }

  /* 归一化超时：必须是 >= 5000ms 的有限正数，否则回落默认。
   * 【为什么】`Number(-5) || 180000` 里 -5 是真值会原样返回，
   * 负/零超时传给 GM_xmlhttpRequest 会导致"立即超时"，表现为每题必失败且无提示。 */
  function normTimeout(v, def) {
    const n = Number(v);
    if (!isFinite(n) || n < 5000) return def || 180000;
    return n;
  }

  /* 归一化 temperature：必须在 [0, 2]，否则回落默认。0 是合法值（最确定），不能用 ||。 */
  function normTemperature(v, def) {
    if (v === '' || v === null || v === undefined) return def;
    const n = Number(v);
    if (!isFinite(n) || n < 0 || n > 2) return def;
    return n;
  }

  /* 归一化 reasoning_effort：只接受 low/high/max，其余（含空）→ ''（不传，用官方默认）*/
  function normEffort(v) {
    const s = str(v).trim().toLowerCase();
    return VALID_EFFORTS.indexOf(s) >= 0 ? s : '';
  }

  /* 把配置解析成实际生效的运行参数 */
  function resolveEffective(cfg) {
    const c = cfg || loadConfig();
    return {
      name: PROVIDER.name,
      baseUrl: rstripSlash(c.baseUrl) || PROVIDER.baseUrl,
      modelVision: str(c.modelVision).trim() || DEFAULT_MODELS.vision,
      modelDeep: str(c.modelDeep).trim() || DEFAULT_MODELS.deep,
      apiKey: str(c.apiKey).trim(),
      timeout: normTimeout(c.timeout, 180000),
      temperature: normTemperature(c.temperature, DEFAULT_SAMPLING.temperature),
      reasoningEffort: normEffort(c.reasoningEffort),
      topP: DEFAULT_SAMPLING.topP,
      supportsImages: true,   // 智谱 5.3-flash / flashx 支持图片
      docs: PROVIDER.docs,
      keyUrl: PROVIDER.keyUrl,
      configured: !!str(c.apiKey).trim(),
    };
  }

  /* 每次请求现读配置，保证 UI 一改就生效 */
  function currentEff() {
    return resolveEffective(loadConfig());
  }

  /* 挑模型：payload.kind 由主脚本给出（choice / text / upload / render）
   *   - 上传型主观题（答案长、要推理）→ modelDeep
   *   - 其余（带图题、公式题、选择填空）→ modelVision */
  function pickModel(payload, eff) {
    const e = eff || currentEff();
    if (!payload) return e.modelVision;
    const kind = payload.kind;
    if (kind === 'upload' || (!kind && payload.isUpload)) return e.modelDeep || e.modelVision;
    return e.modelVision;
  }

  /* 运行期：组装成单条 provider */
  function buildProviders() {
    const e = currentEff();
    return [{
      name: e.name,
      enabled: true,
      priority: 0,
      preferred: true,
      baseUrl: e.baseUrl,
      model: e.modelVision,
      apiKey: e.apiKey,
      wireApi: 'chat',
      extraHeaders: {},
      supportsImages: e.supportsImages,
      timeout: e.timeout,
      temperature: e.temperature,
      topP: e.topP,
      reasoningEffort: e.reasoningEffort,
    }];
  }

  // 主脚本 ← bridge 的请求/响应都用这个前缀
  const REQ = 'EWT_LLM_REQUEST';
  const RES = 'EWT_LLM_RESPONSE';
  const PING = 'EWT_LLM_PING';
  const PONG = 'EWT_LLM_PONG';
  const FETCH = 'EWT_FETCH_REQUEST';       // 主脚本请求抓取一段文本源码（如 html2canvas）
  const FETCH_RES = 'EWT_FETCH_RESPONSE';

  // 响应主脚本的存活探测
  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.__ewt === PING) {
      window.postMessage({ __ewt: PONG }, '*');
    }
  });
  // 主动广播一次，主脚本可能比 bridge 晚启动
  setTimeout(() => window.postMessage({ __ewt: PONG }, '*'), 1500);

  function reply(id, ok, payload) {
    window.postMessage({ __ewt: RES, id, ok, ...payload }, '*');
  }

  function buildInput(payload) {
    const { question, options, material } = payload;
    let p = '';
    if (Array.isArray(payload.images) && payload.images.length) {
      // 注意：请求体里图片内容块在文本之前（对齐官方示例顺序），这里如实描述，别说反。
      p += `（本题附有 ${payload.images.length} 张图片，位于本条文本之前，请结合图片作答）\n\n`;
    }
    if (material) p += `【阅读材料】\n${material}\n\n`;
    p += `【题目】\n${question}\n`;
    if (payload.isUpload) {
      // 上传型主观题：答案会被渲染成图片提交，需要完整可判分的解答
      p += `\n这是一道需要手写上传答案的主观题。请给出完整、可直接作为答卷提交的解答：`;
      p += `\n- 分步骤书写，每一步单独一行，公式和关键推导写清楚；`;
      p += `\n- 不要题号、不要"答案："前缀、不要开场白和总结套话；`;
      p += `\n- 直接输出解答正文即可（可用换行分段，但不要用 Markdown 记号如 ** 或 #）。`;
    } else if (options && options.length) {
      p += `\n【选项】\n${options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}\n`;
      p += `\n这是选择题，只输出选项字母（如 A 或 ABD），不要任何其它文字。`;
    } else {
      p += `\n这是简答题，直接给出要填写的答案内容，不要题号、不要"答案："前缀、不要解析。控制在 100 字以内。`;
    }
    return p;
  }

  /* 智谱 vision 只接受 png/jpeg/webp/gif 的 dataURL，
   * SVG / 其它格式会被拒（错误码 1210 图片输入格式/解析错误），必须先过滤。
   * 返回可用的图片数组；被丢弃的会带原因。 */
  const IMG_OK = /^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i;
  function filterImages(images) {
    const okList = [];
    const dropped = [];
    if (!Array.isArray(images)) return { okList, dropped };
    for (const img of images) {
      if (!img || !img.dataUrl) continue;
      if (IMG_OK.test(img.dataUrl)) okList.push(img);
      else {
        const m = /^data:([^;]+)/.exec(img.dataUrl);
        dropped.push(m ? m[1] : '未知格式');
      }
    }
    return { okList, dropped };
  }

  /* 构造 chat/completions 请求体（智谱 GLM）
   *
   * 【参数依据】智谱官方对 GLM-5.3-Flash/FlashX 的推荐设置：
   *   temperature: 1、top_p: 0.95、reasoning_effort: max
   *   thinking.type 仅支持 enabled（该系列不支持关闭思考），
   *   并建议设置 thinking.clear_thinking: false。
   * 参考：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
   *
   * 【与官方的两处有意偏离】
   *   1) temperature 我们默认 0.1 而非 1：这是"答题"场景，要的是**答案稳定可复现**，
   *      高温度会让同一道题多次调用给出不同选项。可由用户在配置里改回 1。
   *   2) reasoning_effort 默认不传（即官方默认 max）；用户嫌慢/费钱可在配置里设 low。
   *
   * 【图片顺序】采用官方示例的顺序：image_url 内容块在前、text 在后。
   *   官方示例（视觉 grounding）即为此顺序，实测更贴合其训练分布。
   */
  function buildChatBody(p, payload) {
    const content = [];
    // 先放图片（官方示例顺序：image → text）
    if (p.supportsImages && Array.isArray(payload.images) && payload.images.length) {
      for (const img of payload.images) {
        if (!img || !img.dataUrl) continue;
        content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      }
    }
    // 再放文本
    content.push({ type: 'text', text: buildInput(payload) });

    const body = {
      model: p.model,
      messages: [{ role: 'user', content }],
      stream: false,
      // 【别用 `Number(x) || 0.1`】temperature=0 是合法值（最确定），
      // 但 0 是假值会被 || 吃掉 → 必须用显式判断。resolveEffective 已归一化，
      // 这里只是防御 p.temperature 缺失。
      temperature: (p.temperature === 0 || p.temperature) ? Number(p.temperature) : DEFAULT_SAMPLING.temperature,
      top_p: (p.topP === 0 || p.topP) ? Number(p.topP) : DEFAULT_SAMPLING.topP,
      // GLM-5.3 系列强制思考，显式声明以对齐官方推荐（clear_thinking:false 保留思考内容）
      thinking: { type: 'enabled', clear_thinking: false },
    };
    // reasoning_effort 只有在用户显式配置时才传，避免覆盖官方默认(max)
    if (p.reasoningEffort) body.reasoning_effort = p.reasoningEffort;
    return body;
  }

  /* 构造 responses 请求体（OpenAI /responses 协议）
   * 当前 GLM 通道走 chat/completions，保留此函数以备扩展。 */
  function buildResponsesBody(p, payload) {
    const content = [{ type: 'input_text', text: buildInput(payload) }];
    if (p.supportsImages && Array.isArray(payload.images) && payload.images.length) {
      for (const img of payload.images) {
        if (!img || !img.dataUrl) continue;
        content.push({ type: 'input_image', image_url: img.dataUrl });
      }
    }
    return {
      model: p.model,
      input: [{ role: 'user', content }],
      store: false,
    };
  }

  /* 从响应中提取文本（兼容 chat/completions 与 responses 两种协议）
   *
   * 注意：GLM-5.3 系列「强制思考且不可关闭」（官方限制），思考内容写在
   * message.reasoning_content 里，而 message.content 才是正文。
   * 当 max_tokens 过小、token 全被思考链吃掉时，content 会是空串而
   * reasoning_content 有内容 —— 这时退而取 reasoning_content，
   * 避免把"有响应"误判成"返回内容为空"。 */
  function extractText(json) {
    let out = '';
    // chat/completions
    const c = json.choices && json.choices[0];
    if (c) {
      if (c.message && typeof c.message.content === 'string') out = c.message.content;
      else if (typeof c.text === 'string') out = c.text;
      // 正文为空时，退回思考内容（GLM-5.3 被 max_tokens 截断的典型情形）
      if (!out && c.message && typeof c.message.reasoning_content === 'string') {
        out = c.message.reasoning_content;
      }
    }
    // responses（保留：日后若再加 responses 协议的通道可直接用）
    if (!out && Array.isArray(json.output)) {
      for (const item of json.output) {
        if (Array.isArray(item.content)) {
          for (const cc of item.content) {
            if (cc.type === 'output_text' && cc.text) out += cc.text;
          }
        }
        // reasoning summary 兜底
        if (!out && item.type === 'reasoning' && Array.isArray(item.summary)) {
          for (const s of item.summary) {
            if (s && s.type === 'summary_text' && s.text) out += s.text;
          }
        }
      }
    }
    if (!out) out = json.output_text || '';
    return out;
  }

  /* 调用单个通道 */
  function callOne(p, payload) {
    const timeout = normTimeout(p.timeout, 180000);
    return new Promise((resolve, reject) => {
      let url, body;
      if (p.wireApi === 'responses') {
        url = `${p.baseUrl}/responses`;
        body = buildResponsesBody(p, payload);
      } else {
        url = `${p.baseUrl}/chat/completions`;
        body = buildChatBody(p, payload);
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${p.apiKey}`,
          ...(p.extraHeaders || {}),
        },
        data: JSON.stringify(body),
        timeout,
        onload: (res) => {
          try {
            if (res.status < 200 || res.status >= 300) {
              return reject(new Error(`HTTP ${res.status}: ${String(res.responseText).slice(0, 200)}`));
            }
            const json = JSON.parse(res.responseText);
            let out = extractText(json);
            /* 上传型主观题要保留换行（答案会渲染成多行图片）；
             * 其它题型压成单行即可，避免多余空白。 */
            if (payload && payload.isUpload) {
              out = String(out).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
            } else {
              out = String(out).replace(/\s+/g, ' ').trim();
            }
            if (!out) return reject(new Error('模型返回空内容'));
            resolve(out);
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error('网络错误（跨域/不可达）')),
        ontimeout: () => reject(new Error(`请求超时 ${timeout / 1000}s`)),
      });
    });
  }

  /* 每道题都重新读配置、按顺序尝试 */
  async function callLLM(payload) {
    const eff = currentEff();
    if (!eff.configured) {
      throw new Error('尚未配置 API Key：请在页面右下角「⚙ API 设置」里填写智谱 Key。');
    }
    if (!eff.baseUrl) {
      throw new Error('尚未配置接口地址（Base URL）：请在「⚙ API 设置」里填写。');
    }

    const list = buildProviders();
    const order = list.map((p, i) => i).filter(i => list[i].enabled !== false);
    const errs = [];
    if (!order.length) throw new Error('没有可用通道');

    // 按题型选模型（带图/公式题走 vision 档，上传主观题走 deep 档）
    const model = pickModel(payload, eff);

    // 若通道不支持图片，直接剔除 images，避免报「content.type 非法」
    let req = payload;
    if (Array.isArray(payload && payload.images) && payload.images.length && !eff.supportsImages) {
      console.warn(`[EWT Bridge] 通道「${eff.name}」不支持图片输入，本题图片将被忽略`);
      req = { ...payload, images: [] };
    }

    for (const idx of order) {
      const p = Object.assign({}, list[idx], { model });
      try {
        const answer = await callOne(p, req);
        return { answer, channel: `${p.name}/${p.model}` };
      } catch (e) {
        errs.push(`${p.name}→${e.message}`);
        console.warn(`[EWT Bridge] 通道「${p.name}」失败：${e.message}`);
        warnIfUnreachable(p, e);
      }
    }
    throw new Error(`调用失败：${errs.join(' | ')}`);
  }

  /* 连续不可达时给一次醒目提示 */
  const _failStreak = new Map();
  const WARN_AFTER = 3;
  function warnIfUnreachable(p, e) {
    const unreachable = /网络错误|请求超时|不可达/.test(String(e && e.message));
    const n = unreachable ? (_failStreak.get(p.name) || 0) + 1 : 0;
    _failStreak.set(p.name, n);
    if (unreachable && n === WARN_AFTER) {
      console.error(
        `%c[EWT Bridge] ⚠ 通道「${p.name}」连续 ${n} 次不可达（${p.baseUrl}）。\n` +
        `  请检查网络，或在「⚙ API 设置」里换一个厂商 / 修正 Base URL。`,
        'color:#dc2626;font-weight:bold'
      );
    }
  }

  /* 规范化答案：去掉常见前缀/引号/句号，选择题只留字母 */
  function normalizeAnswer(raw, payload) {
    let s = String(raw).trim();
    // 去掉 markdown 包裹
    s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
    // 去掉常见前缀
    s = s.replace(/^(答案|正确答案|答案是|答|选择|应该选|选项)\s*[:：]?\s*/i, '').trim();
    s = s.replace(/^[「『"'“”‘’]+|[」』"'“”‘’]+$/g, '').trim();
    s = s.replace(/[。．.；;]\s*$/, '').trim();

    const isChoice = Array.isArray(payload.options) && payload.options.length > 0;
    if (isChoice) {
      // 只保留 A-H 字母（去重、排序）
      const letters = [...new Set((s.match(/[A-Ha-h]/g) || []).map(c => c.toUpperCase()))].sort();
      if (letters.length) return letters.join('');
    }
    return s;
  }

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.__ewt !== FETCH || !d.id || !d.url) return;
    try {
      const text = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: d.url,
          timeout: 20000,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) resolve(res.responseText);
            else reject(new Error(`HTTP ${res.status}`));
          },
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('超时')),
        });
      });
      window.postMessage({ __ewt: FETCH_RES, id: d.id, ok: true, text }, '*');
    } catch (e) {
      window.postMessage({ __ewt: FETCH_RES, id: d.id, ok: false, error: e.message || String(e) }, '*');
    }
  });

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.__ewt !== REQ || !d.id) return;
    try {
      const payload = d.payload || {};
      // 图片格式预过滤：智谱只吃位图，SVG 等会被拒
      const { okList, dropped } = filterImages(payload.images);
      if (dropped.length) {
        console.warn(`[EWT Bridge] 已丢弃 ${dropped.length} 张不支持的图片格式：${dropped.join(', ')}`);
      }
      const clean = { ...payload, images: okList };
      const res = await callLLM(clean);
      const answer = normalizeAnswer(res.answer, payload);
      if (!answer) throw new Error('答案规范化后为空');
      reply(d.id, true, { answer, channel: res.channel, droppedImages: dropped });
    } catch (e) {
      reply(d.id, false, { error: e.message || String(e) });
    }
  });

  /* ============ 配置接口（主脚本 ↔ bridge）============
   *   GET  → 返回当前配置（含示例 keyUrl / docs / 默认模型，供 UI 渲染）
   *   SET  → 写入配置（patch 形式），返回写入后的配置
   *   TEST → 用指定配置（或当前配置）发一次最小请求，验证 Key / 地址是否可用
   */
  const CFG_GET = 'EWT_CFG_GET';
  const CFG_SET = 'EWT_CFG_SET';
  const CFG_TEST = 'EWT_CFG_TEST';
  const CFG_RES = 'EWT_CFG_RESPONSE';

  function cfgReply(id, ok, payload) {
    window.postMessage({ __ewt: CFG_RES, id, ok, ...payload }, '*');
  }

  /* 暴露给 UI 的「当前配置快照」：包含用户可改字段 + 只读的默认值/帮助信息 */
  function configSnapshot() {
    const c = loadConfig();
    const e = resolveEffective(c);
    return {
      // 一律转成字符串回给 UI，避免把脏数据（数字/对象）塞进 input.value
      apiKey: str(c.apiKey),
      baseUrl: str(c.baseUrl),
      modelVision: str(c.modelVision),
      modelDeep: str(c.modelDeep),
      timeout: normTimeout(c.timeout, 180000),
      temperature: e.temperature,
      reasoningEffort: e.reasoningEffort,
      // 只读参考
      effectiveBaseUrl: e.baseUrl,
      effectiveModelVision: e.modelVision,
      effectiveModelDeep: e.modelDeep,
      effectiveTemperature: e.temperature,
      effectiveReasoningEffort: e.reasoningEffort,
      defaultBaseUrl: PROVIDER.baseUrl,
      defaultModelVision: DEFAULT_MODELS.vision,
      defaultModelDeep: DEFAULT_MODELS.deep,
      defaultTemperature: DEFAULT_SAMPLING.temperature,
      defaultTopP: DEFAULT_SAMPLING.topP,
      validEfforts: VALID_EFFORTS.slice(),
      keyUrl: PROVIDER.keyUrl,
      docs: PROVIDER.docs,
      configured: e.configured,
    };
  }

  /* 连通测试：发一条极短请求，只看能否拿到合法响应。
   * 用配置里生效的 baseUrl + vision 模型 + 明文 key。
   *
   * ⚠️ max_tokens 不能给小：GLM-5.3 系列强制思考且不可关闭，
   *    思维链会先消耗 token。若上限太小（如 8），token 全花在思考上，
   *    正文被截断成空串，会被误报为「返回内容为空」。
   *    这里给足 512，并把 reasoning_effort 压到 low 以加快返回。 */
  function testConfig(override) {
    const merged = { ...loadConfig(), ...(override || {}) };
    const e = resolveEffective(merged);
    if (!e.apiKey) return { ok: false, error: '未填写 API Key' };
    if (!e.baseUrl) return { ok: false, error: '未填写接口地址' };
    const model = e.modelVision;
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${e.baseUrl}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${e.apiKey}`,
        },
        data: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '回复一个字：好' }],
          stream: false,
          max_tokens: 512,
          thinking: { type: 'enabled', clear_thinking: false },
          reasoning_effort: 'low',
        }),
        timeout: 30000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            let hint = String(res.responseText || '').slice(0, 200);
            if (res.status === 401) hint = 'API Key 无效或已过期（401）';
            else if (res.status === 403) hint = '无权限访问该模型（403），请确认 Key 已开通对应模型';
            else if (res.status === 404) hint = '接口地址或模型名不存在（404），请检查 Base URL / 模型名';
            else if (res.status === 429) hint = '请求过于频繁或余额不足（429）';
            resolve({ ok: false, error: `HTTP ${res.status}：${hint}` });
            return;
          }
          try {
            const json = JSON.parse(res.responseText);
            const text = extractText(json);
            if (!text) { resolve({ ok: false, error: '接口可用，但返回内容为空' }); return; }
            resolve({ ok: true, text: String(text).slice(0, 40), model });
          } catch (err) {
            resolve({ ok: false, error: '返回内容无法解析为 JSON：' + String(err.message || err) });
          }
        },
        onerror: () => resolve({ ok: false, error: '网络错误（不可达 / 跨域被拦截）' }),
        ontimeout: () => resolve({ ok: false, error: '请求超时 30s' }),
      });
    });
  }

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || !d.id) return;
    if (d.__ewt === CFG_GET) {
      try { cfgReply(d.id, true, { config: configSnapshot() }); }
      catch (e) { cfgReply(d.id, false, { error: e.message || String(e) }); }
      return;
    }
    if (d.__ewt === CFG_SET) {
      try {
        saveConfig(d.patch || {});
        cfgReply(d.id, true, { config: configSnapshot() });
      } catch (e) { cfgReply(d.id, false, { error: e.message || String(e) }); }
      return;
    }
    if (d.__ewt === CFG_TEST) {
      try {
        const result = await testConfig(d.override);
        cfgReply(d.id, true, { result });
      } catch (e) { cfgReply(d.id, false, { error: e.message || String(e) }); }
      return;
    }
  });

  /* 脚本菜单快捷入口：打开配置面板时，主脚本会监听该消息 */
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('⚙ 配置智谱 API Key', () => {
        window.postMessage({ __ewt: 'EWT_OPEN_CFG' }, '*');
      });
    }
  } catch (e) {}

  console.log(
    `%c[EWT Bridge] 就绪 v3.0.0 → 通道 ${PROVIDER.name}` +
    (loadConfig().apiKey ? '（已配置 Key）' : '（⚠ 未配置 Key，请在页面「⚙ API 设置」里填写）'),
    'color:#0ea5e9;font-weight:bold'
  );
})();
