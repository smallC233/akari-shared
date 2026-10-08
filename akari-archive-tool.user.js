// ==UserScript==
// @name         Daily Akari 存档工具
// @namespace    local.akari.archive.tool
// @version      1.1.3
// @description  查看 / 备份 / 修改 dailyakari.com 的本地点灯进度（localStorage: archiveCompletion）
// @author       smallC233
// @match        https://dailyakari.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      janko.at
// @connect      dailyakari.com
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      gitee.com
// @homepageURL  https://github.com/smallC233/akari-shared
// @supportURL   https://github.com/smallC233/akari-shared
// @updateURL    https://raw.githubusercontent.com/smallC233/akari-shared/main/akari-archive-tool.user.js
// @downloadURL  https://raw.githubusercontent.com/smallC233/akari-shared/main/akari-archive-tool.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ============================ 一、存档数据层 ============================
   * 网站把进度存在 localStorage["archiveCompletion"]，结构：
   *   { "关卡编号": { "acc": 准确率 0~1 } }
   *   acc === 1        -> 完美！（列表里金色边框 + 星标）
   *   有键但 acc !== 1 -> 普通通关（显示 round(acc*100)%）
   *   没有这个键       -> 未通关
   * 第 1 关 = 2025-01-06，之后一天一关、不跳号。
   * ====================================================================== */

  var STORAGE_KEY = 'archiveCompletion';
  var FIRST_UTC = Date.UTC(2025, 0, 6);
  var DAY_MS = 86400000;
  var BACKUP_KEY = 'backups';      // 存在 GM 存储里，不动网站的 localStorage
  var MAX_BACKUPS = 30;
  var POS_KEY = 'uiPos';

  // ---------- 油猴存储（降级方案：没有 GM_* 时用带前缀的 localStorage） ----------
  var hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function kvGet(key, dflt) {
    try {
      if (hasGM) {
        var v = GM_getValue(key, undefined);
        return v === undefined ? dflt : v;
      }
      var rawVal = localStorage.getItem('akariTool:' + key);
      return rawVal === null ? dflt : JSON.parse(rawVal);
    } catch (e) { return dflt; }
  }

  function kvSet(key, val) {
    try {
      if (hasGM) GM_setValue(key, val);
      else localStorage.setItem('akariTool:' + key, JSON.stringify(val));
    } catch (e) { /* 存不下就算了，不影响主流程 */ }
  }

  // ---------- 抓取（跨域用 GM_xmlhttpRequest，没有 GM 就退回 fetch） ----------
  function gmFetch(url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url: url,
          onload: function (r) {
            if (r.status >= 200 && r.status < 300) resolve(r.responseText);
            else reject(new Error('HTTP ' + r.status));
          },
          onerror: function () { reject(new Error('网络错误')); },
          ontimeout: function () { reject(new Error('超时')); }
        });
      } else {
        fetch(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        }).then(resolve, reject);
      }
    });  }

  // ---------- 日期 <-> 编号 ----------
  function numberOf(y, m, d) {
    return Math.round((Date.UTC(y, m - 1, d) - FIRST_UTC) / DAY_MS) + 1;
  }
  function dateOfNumber(n) {
    return new Date(FIRST_UTC + (Number(n) - 1) * DAY_MS).toISOString().slice(0, 10);
  }
  function todayNumber() {
    var d = new Date();
    return numberOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  function parseTarget(text) {
    var s = String(text || '').trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      var n = Number(s);
      return n >= 1 ? { n: n } : null;
    }
    var m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
    if (!m) return null;
    var num = numberOf(+m[1], +m[2], +m[3]);
    return num >= 1 ? { n: num } : null;
  }

  // ---------- 读 ----------
  function raw() {
    var v = localStorage.getItem(STORAGE_KEY);
    return v == null ? '' : v;
  }

  function load() {
    var text = raw();
    if (!text) return {};
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      throw new Error('archiveCompletion 不是合法 JSON，已停手。原始内容前 200 字：' + text.slice(0, 200));
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('archiveCompletion 结构异常，已停手。内容：' + text.slice(0, 200));
    }
    return parsed;
  }

  function stateOf(entry) {
    if (entry === undefined || entry === null) return 'none';
    var acc = typeof entry === 'object' ? entry.acc : entry;
    if (typeof acc !== 'number' || isNaN(acc)) return 'dirty';
    return acc >= 1 ? 'perfect' : 'solved';
  }

  var STATE_TEXT = { perfect: '完美！', solved: '通关', none: '未通关', dirty: '数据异常' };

  function stateLabel(n, data) {
    var entry = data[n];
    var st = stateOf(entry);
    if (st === 'solved') return '通关 ' + Math.round(entry.acc * 100) + '%';
    if (st === 'dirty') return '数据异常';
    return STATE_TEXT[st];
  }

  // ---------- 备份 ----------
  function getBackups() {
    var list = kvGet(BACKUP_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function countKeys(text) {
    try { return Object.keys(JSON.parse(text)).length; } catch (e) { return 0; }
  }

  // 把一段旧内容压进备份栈（和最近一份相同就跳过）
  function pushBackup(text, note) {
    if (!text) return;
    var list = getBackups();
    if (list.length && list[0].raw === text) return;
    list.unshift({ t: new Date().toISOString(), note: note || '', raw: text, count: countKeys(text) });
    kvSet(BACKUP_KEY, list.slice(0, MAX_BACKUPS));
  }

  // ---------- 写 ----------
  var pending = false;   // 已写入 localStorage，但当前页面仍可能用旧的内存副本

  function write(data, note) {
    pushBackup(raw(), note);           // 改动前的样子自动存一份
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    pending = true;
    render();
    return data;
  }

  function makeEntry(mode, accuracy) {
    if (mode === 'perfect') return { acc: 1 };
    if (mode === 'solved') {
      var acc = accuracy === undefined ? 0 : Number(accuracy);
      if (!isFinite(acc) || acc < 0) throw new Error('准确率需要 0~1 之间的数字，收到：' + accuracy);
      if (acc >= 1) return { acc: 1 };
      return { acc: acc };
    }
    throw new Error('未知状态：' + mode);
  }

  function setState(n, mode, accuracy) {
    n = Number(n);
    if (!isFinite(n) || n < 1 || Math.floor(n) !== n) throw new Error('关卡编号要是 >=1 的整数，收到：' + n);
    var data = load();
    if (mode === 'none') delete data[n];
    else data[n] = makeEntry(mode, accuracy);
    write(data, '#' + n + ' -> ' + mode);
    return data[n];
  }

  function setMany(map) {
    var data = load();
    Object.keys(map).forEach(function (k) {
      var v = map[k];
      if (v === 'none') delete data[Number(k)];
      else data[Number(k)] = makeEntry(Array.isArray(v) ? v[0] : v, Array.isArray(v) ? v[1] : undefined);
    });
    write(data, '批量修改 ' + Object.keys(map).length + ' 关');
  }

  function restoreRaw(text, note) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('备份内容不是合法 JSON'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('备份内容不是对象');
    pushBackup(raw(), note || '还原前');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    pending = true;
    render();
    return Object.keys(parsed).length;
  }

  // ---------- 导出 / 导入 ----------
  function downloadText(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function stampNow() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  function downloadBackup() {
    var text = raw() || '{}';
    pushBackup(text, '手动备份');
    downloadText('akari-archiveCompletion-' + stampNow() + '.json', text);
  }

  /* ================= 二、让站点玩不了的题也能玩 =================
   * 站点对第三方转载题只存了「作者 + 来源链接」，题目数据（puzzlink）是 null，
   * 服务端 /archivepuzzle 也直接返回 400。这里做的事：
   *   1. 从来源站（目前支持 janko.at）抓题目文本，或让用户手动录入网格
   *   2. 用 pzpr 的编码方式拼成 puzz.link 的 akari URL，缓存在本地
   *   3. 在页面发 XHR 时把 /archivelist 与 /archivepuzzle 的响应改掉，
   *      让网站以为这题本来就能玩（用的还是网站自己的播放器，成绩照常记录）
   * ============================================================ */

  var CONV_KEY = 'conversions';       // { 关卡编号: {src,url,cols,rows,updated} }
  var INDEX_KEY = 'archiveIndex';     // { 关卡编号: 归档条目 }（来自 archivelist）
  var PAD_KEY = 'padPortrait';        // 竖版题是否补成方形
  var SHARED_KEY = 'sharedRepo';      // 共享库仓库（"用户名/仓库名" 或完整 URL）
  var SHARED_FILE = 'data/puzzles.json';
  var SCRIPT_VERSION = '1.1.3';

  // ↓↓↓ 改成你自己的仓库（形如 "用户名/仓库名"，例如 "akari-user/akari-shared"）。
  //     填在这里，朋友装上这个脚本就自带你的默认数据源，不用自己配；
  //     面板里也能临时改（改的是本机设置，不会动代码）。
  var SHARED_REPO_DEFAULT = 'smallC233/akari-shared';

  // ---------- 在页面环境里给 XMLHttpRequest 打补丁 ----------
  // 注意：必须在 Angular 发请求之前装好，所以脚本以 document-start 运行
  var PATCH_SRC = [
    '(function(){',
    '  if (window.__akariXhrPatched) return;',
    '  window.__akariXhrPatched = true;',
    '  var proto = XMLHttpRequest.prototype;',
    '  var origOpen = proto.open, origSend = proto.send;',
    '  var dText = Object.getOwnPropertyDescriptor(proto, "responseText");',
    '  var dResp = Object.getOwnPropertyDescriptor(proto, "response");',
    '  window.__AKARI_SUPPORT__ = window.__AKARI_SUPPORT__ || {};',
    '  window.__AKARI_ENTRIES__ = window.__AKARI_ENTRIES__ || {};',
    '  proto.open = function(method, url){ try { this.__akariUrl = String(url); } catch(e){} return origOpen.apply(this, arguments); };',
    '  proto.send = function(){',
    '    try {',
    '      var url = this.__akariUrl || "";',
    '      var support = window.__AKARI_SUPPORT__ || {};',
    '      var m = /archivepuzzle\\?number=(\\d+)/.exec(url);',
    '      if (m && support[m[1]]) {',
    '        var payload = JSON.stringify(support[m[1]]);',
    '        Object.defineProperty(this, "responseText", { configurable: true, get: function(){ return payload; } });',
    '        Object.defineProperty(this, "response", { configurable: true, get: function(){ return JSON.parse(payload); } });',
    '        Object.defineProperty(this, "status", { configurable: true, get: function(){ return 200; } });',
    '        Object.defineProperty(this, "statusText", { configurable: true, get: function(){ return "OK"; } });',
    '        try {',
    '          var pm = /akari\\/(\\d+)\\/(\\d+)\\/(.*)$/.exec(support[m[1]].puzzlink || "");',
    '          if (pm) {',
    '            var want = "#akari/" + pm[1] + "/" + pm[2] + "/" + pm[3].replace(/\\/$/, "");',
    '            if (location.hash !== want) history.replaceState(history.state, "", location.pathname + location.search + want);',
    '          }',
    '        } catch (e) {}',
    '      } else if (url.indexOf("archivelist") >= 0) {',
    '        var self = this;',
    '        var transform = function(raw){',
    '          if (typeof raw !== "string") return raw;',
    '          try {',
    '            var j = JSON.parse(raw);',
    '            if (j && j.entries) {',
    '              var sup = window.__AKARI_SUPPORT__ || {};',
    '              for (var i = 0; i < j.entries.length; i++) {',
    '                var e = j.entries[i];',
    '                window.__AKARI_ENTRIES__[e.dailyNumber] = e;',
    '                var s = sup[e.dailyNumber];',
    '                if (s) {',
    '                  var copy = {};',
    '                  for (var k in e) copy[k] = e[k];',
    '                  copy.puzzlink = s.puzzlink; copy.isPlayable = 1;',
    '                  j.entries[i] = copy;',
    '                }',
    '              }',
    '            }',
    '            return JSON.stringify(j);',
    '          } catch (err) { return raw; }',
    '        };',
    '        Object.defineProperty(this, "responseText", { configurable: true, get: function(){ return transform(dText.get.call(self)); } });',
    '        Object.defineProperty(this, "response", { configurable: true, get: function(){',
    '          var raw = dResp.get.call(self);',
    '          return transform(typeof raw === "string" ? raw : JSON.stringify(raw));',
    '        } });',
    '      }',
    '    } catch (e) {}',
    '    return origSend.apply(this, arguments);',
    '  };',
    '})();'
  ].join('\n');

  var pageWin = null;

  function installXhrPatch() {
    pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    var modes = [
      function () { pageWin.eval(PATCH_SRC); },
      function () {
        var s = document.createElement('script');
        s.textContent = PATCH_SRC;
        var parent = document.head || document.documentElement || document.body;
        if (!parent) throw new Error('no parent node');
        parent.appendChild(s);
        s.remove();
      },
      function () { (0, eval)(PATCH_SRC); }
    ];
    for (var i = 0; i < modes.length; i++) {
      try {
        modes[i]();
        if (pageWin.__akariXhrPatched) return;
      } catch (e) { /* 换下一种方式 */ }
    }
    console.error('[Akari] 拦截器安装失败，站点自带的题仍然能玩，但来源题转换不可用。');
  }

  // ---------- puzz.link (pzpr) 的 akari 编码 ----------
  // 格子值：-1 = 白格, -2 = 黑格无数字, 0..4 = 黑格带数字
  function decodeBody(body, total) {
    var grid = new Array(total);
    for (var k = 0; k < total; k++) grid[k] = -1;
    var c = 0;
    for (var i = 0; i < body.length; i++) {
      var ca = body.charAt(i);
      if (ca >= '0' && ca <= '4') grid[c] = parseInt(ca, 16);
      else if (ca >= '5' && ca <= '9') { grid[c] = parseInt(ca, 16) - 5; c++; }
      else if (ca >= 'a' && ca <= 'e') { grid[c] = parseInt(ca, 16) - 10; c += 2; }
      else if (ca >= 'g' && ca <= 'z') c += parseInt(ca, 36) - 16;
      else if (ca === '.') grid[c] = -2;
      c++;
      if (c >= total) break;
    }
    return grid;
  }

  function encodeBody(grid) {
    var cm = '', count = 0;
    for (var c = 0; c < grid.length; c++) {
      var pstr = '', qn = grid[c];
      if (qn >= 0) {
        if (c + 1 < grid.length && grid[c + 1] !== -1) {
          pstr = qn.toString(16);
        } else if (c + 2 < grid.length && grid[c + 2] !== -1) {
          pstr = (5 + qn).toString(16); c++;
        } else {
          pstr = (10 + qn).toString(16); c += 2;
        }
      } else if (qn === -2) {
        pstr = '.';
      } else {
        count++;
      }
      if (count === 0) cm += pstr;
      else if (pstr || count === 20) { cm += (count + 15).toString(36) + pstr; count = 0; }
    }
    if (count > 0) cm += (count + 15).toString(36);
    return cm;
  }

  function buildPuzzlink(cols, rows, grid) {
    var body = encodeBody(grid);
    if (!/[a-zA-Z0-9]/.test(body.charAt(body.length - 1))) body += '/';
    return 'https://puzz.link/p?akari/' + cols + '/' + rows + '/' + body;
  }

  // 网站的播放器总是把盘面摆成横版：竖版题（行比列多）会被它整体转 90°。
  // 用黑格把竖版补成正方形就能避免旋转（黑格只是墙，不影响题目本身）。
  function padToSquare(cols, rows, grid) {
    if (cols >= rows) return { cols: cols, rows: rows, grid: grid, padded: false };
    var n = rows, off = Math.floor((n - cols) / 2);
    var g = new Array(n * n);
    for (var i = 0; i < g.length; i++) g[i] = -2;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) g[r * n + off + c] = grid[r * cols + c];
    }
    return { cols: n, rows: n, grid: g, padded: true };
  }

  function parsePuzzlinkUrl(url) {
    var m = /akari\/(\d+)\/(\d+)\/(.*)$/.exec(url);
    if (!m) return null;
    return { cols: +m[1], rows: +m[2], body: m[3].replace(/\/$/, '') };
  }

  // 编码完立刻解回来逐格比对，确认没编错再存。
  // 注意：末尾不是字母数字时 buildPuzzlink 会补一个 "/"，
  // 所以取 body 必须用 parsePuzzlinkUrl（会把结尾斜杠去掉），
  // 直接 split('/').pop() 在那种情况下会取到空字符串而误报自检失败。
  function buildVerified(cols, rows, grid) {
    var url = buildPuzzlink(cols, rows, grid);
    var p = parsePuzzlinkUrl(url);
    var back = p ? decodeBody(p.body, cols * rows) : [];
    if (JSON.stringify(back) !== JSON.stringify(grid)) throw new Error('转换自检没通过，已放弃');
    return url;
  }

  // 实际送给播放器的 URL（按当前设置决定要不要补边）
  function effectiveUrl(conv) {
    var pad = kvGet(PAD_KEY, true) !== false;
    if (!pad || !conv || !(conv.cols < conv.rows)) return conv ? conv.url : null;
    var p = parsePuzzlinkUrl(conv.url);
    if (!p) return conv.url;
    var grid = decodeBody(p.body, conv.cols * conv.rows);
    var sq = padToSquare(conv.cols, conv.rows, grid);
    return buildPuzzlink(sq.cols, sq.rows, sq.grid);
  }

  function rotateGrid(cols, rows, grid, dir) {
    var out = new Array(cols * rows);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var v = grid[r * cols + c];
        if (dir === 'cw') out[c * rows + (rows - 1 - r)] = v;   // 新盘面 cols' = rows
        else out[(cols - 1 - c) * rows + r] = v;
      }
    }
    return { cols: rows, rows: cols, grid: out };
  }

  // ---------- janko.at 的题目文本 ----------
  function parseJankoData(html) {
    var m = /<script[^>]*id="data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) throw new Error('页面里没有找到题目数据（可能不是 janko.at 的题）');
    var text = m[1];
    var size = null;
    var sm = /\bsize\s+(\d+)(?:\s*x\s*(\d+))?/.exec(text);
    if (sm) {
      size = { cols: +sm[1], rows: sm[2] ? +sm[2] : +sm[1] };
    } else {
      var rm = /^\s*rows\s+(\d+)\s*$/m.exec(text);
      var cm2 = /^\s*cols\s+(\d+)\s*$/m.exec(text);
      if (!rm || !cm2) throw new Error('题目数据里没有尺寸信息');
      size = { cols: +cm2[1], rows: +rm[1] };
    }
    var pm = /\[problem\]([\s\S]*?)(?=\n?\[|$)/.exec(text);
    if (!pm) throw new Error('题目数据里没有 [problem] 段');
    var rows = pm[1].trim().split(/\r?\n/).map(function (l) {
      return l.trim().split(/\s+/).filter(Boolean);
    });
    return { size: size, rows: rows };
  }

  // ---------- 文本网格 -> 格子数组（也是手动录题用的格式） ----------
  function gridFromText(text) {
    var raw = String(text || '');
    // 如果用户直接粘了 janko.at 的整段数据，自动取出 [problem]
    var pm = /\[problem\]([\s\S]*?)(?=\n?\[|$)/.exec(raw);
    if (pm) raw = pm[1];
    var lines = raw.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
    if (!lines.length) throw new Error('没有内容');
    var rows = lines.map(function (l) {
      return l.replace(/[,、]/g, ' ').split(/\s+/).filter(Boolean);
    });
    var cols = rows[0].length;
    var grid = [];
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].length !== cols) {
        throw new Error('第 ' + (r + 1) + ' 行有 ' + rows[r].length + ' 格，但第一行有 ' + cols + ' 格');
      }
      for (var i = 0; i < rows[r].length; i++) {
        var t = rows[r][i];
        if (t === '-' || t === '.' || t === '_' || t === '·' || t === '＋' || t === '+') grid.push(-1);
        else if (t === 'x' || t === 'X' || t === '#' || t === '■' || t === '＊' || t === '*') grid.push(-2);
        else if (/^[0-4]$/.test(t)) grid.push(+t);
        else throw new Error('第 ' + (r + 1) + ' 行第 ' + (i + 1) + ' 格看不懂：「' + t + '」（只能填 0-4、x、-）');
      }
    }
    if (rows.length < 2 || cols < 2) throw new Error('题目太小了（至少 2x2）');
    return { cols: cols, rows: rows.length, grid: grid };
  }

  // ---------- 缓存与「网站以为能玩」的映射表 ----------
  var conversions = kvGet(CONV_KEY, {});
  if (!conversions || typeof conversions !== 'object') conversions = {};
  var archiveIndex = kvGet(INDEX_KEY, {});
  if (!archiveIndex || typeof archiveIndex !== 'object') archiveIndex = {};

  function saveConversions() { kvSet(CONV_KEY, conversions); }
  function saveIndex() { kvSet(INDEX_KEY, archiveIndex); }

  function entryOf(n) {
    var live = (pageWin && pageWin.__AKARI_ENTRIES__) ? pageWin.__AKARI_ENTRIES__[n] : null;
    return live || archiveIndex[n] || null;
  }

  function supportEntry(n) {
    var conv = conversions[n];
    if (!conv) return null;
    var o = entryOf(n) || {};
    return {
      puzzlink: effectiveUrl(conv),
      difficulty: o.difficulty == null ? 3 : o.difficulty,
      source: o.source || conv.source || null,
      license: o.license || null,
      author: o.author || (conv.src === 'janko' ? 'Otto Janko' : '手动录入'),
      isSpecial: o.isSpecial || 0,
      isNoRot: o.isNoRot || 0,
      socialUrl: o.socialUrl || null,
      puzzleId: o.puzzleId || (900000 + Number(n)),
      dailyNumber: Number(n),
      dateKey: o.dateKey || dateOfNumber(n),
      highlightType: o.highlightType || null,
      isPlayable: 1
    };
  }

  function refreshSupport() {
    if (!pageWin) return;
    var obj = pageWin.__AKARI_SUPPORT__ = pageWin.__AKARI_SUPPORT__ || {};
    Object.keys(obj).forEach(function (k) { if (!conversions[k]) delete obj[k]; });
    Object.keys(conversions).forEach(function (k) {
      var e = supportEntry(k);
      if (e) obj[k] = e;
    });
  }

  // 把一条转换结果存起来
  function storeConversion(n, conv) {
    n = String(n);
    conv.updated = new Date().toISOString();
    conversions[n] = conv;
    saveConversions();
    refreshSupport();
    return conv;
  }

  // 抓 janko.at 的题并转换
  function convertJanko(n, sourceUrl) {
    if (!sourceUrl) {
      var e = entryOf(n);
      sourceUrl = e && e.source;
    }
    if (!sourceUrl || !/janko\.at/.test(sourceUrl)) {
      return Promise.reject(new Error('这一关的来源不是 janko.at，需要手动录题'));
    }
    return gmFetch(sourceUrl).then(function (html) {
      var p = parseJankoData(html);
      var grid = [];
      for (var r = 0; r < p.size.rows; r++) {
        if (!p.rows[r] || p.rows[r].length !== p.size.cols) throw new Error('第 ' + (r + 1) + ' 行格数不对');
        for (var i = 0; i < p.rows[r].length; i++) {
          var t = p.rows[r][i];
          if (t === '-') grid.push(-1);
          else if (t === 'x' || t === 'X') grid.push(-2);
          else if (/^[0-4]$/.test(t)) grid.push(+t);
          else throw new Error('看不懂的格子：「' + t + '」');
        }
      }
      return storeConversion(n, {
        src: 'janko', url: buildVerified(p.size.cols, p.size.rows, grid),
        cols: p.size.cols, rows: p.size.rows, source: sourceUrl
      });
    });
  }

  // 手动录题
  function setManual(n, text) {
    var g = gridFromText(text);
    return storeConversion(n, {
      src: 'manual', url: buildVerified(g.cols, g.rows, g.grid),
      cols: g.cols, rows: g.rows, gridText: String(text)
    });
  }

  function removeConversion(n) {
    delete conversions[n];
    saveConversions();
    refreshSupport();
  }

  /* ---------- 共享库：从 GitHub 仓库拉取 / 导出自己录入的题目 ---------- */

  function sharedRepo() {
    var v = kvGet(SHARED_KEY, null);
    if (v === null || v === undefined || v === '') return String(SHARED_REPO_DEFAULT || '');
    return String(v).trim();
  }

  // 支持 "用户名/仓库名"、"https://github.com/用户名/仓库名" 或完整文件 URL
  function sharedUrls() {
    var repo = sharedRepo().trim().replace(/\/+$/, '');
    if (!repo) return [];
    if (/^https?:\/\//i.test(repo) && !/^https?:\/\/github\.com\//i.test(repo)) return [repo];
    var m = /^(?:https?:\/\/github\.com\/)?([\w.\-]+)\/([\w.\-]+?)(?:\.git)?$/.exec(repo);
    if (!m) return [];
    var user = m[1], name = m[2];
    // 顺序：先 raw（内容最新），不通再走 jsDelivr（国内更稳，但有缓存），最后 Gitee 镜像
    return [
      'https://raw.githubusercontent.com/' + user + '/' + name + '/main/' + SHARED_FILE,
      'https://cdn.jsdelivr.net/gh/' + user + '/' + name + '@main/' + SHARED_FILE,
      'https://gitee.com/' + user + '/' + name + '/raw/main/' + SHARED_FILE
    ];
  }

  // 校验一条外来数据：URL 结构、尺寸、解码再编码都要对得上，否则丢弃
  function sanitizeConv(rec) {
    if (!rec || typeof rec !== 'object') return null;
    var url = String(rec.url || '');
    var p = parsePuzzlinkUrl(url);
    if (!p) return null;
    if (!p.body.length || !/^[.0-9a-eg-z]+$/.test(p.body)) return null;
    var cols = Number(rec.cols), rows = Number(rec.rows);
    if (!isFinite(cols) || !isFinite(rows) || cols < 2 || rows < 2) { cols = p.cols; rows = p.rows; }
    if (cols !== p.cols || rows !== p.rows) return null;
    var grid = decodeBody(p.body, cols * rows);
    if (encodeBody(grid) !== p.body) return null;
    var out = {
      src: rec.src === 'janko' ? 'janko' : (rec.src === 'manual' ? 'manual' : 'shared'),
      url: url, cols: cols, rows: rows,
      updated: typeof rec.updated === 'string' ? rec.updated : new Date().toISOString()
    };
    if (rec.source) out.source = String(rec.source);
    if (typeof rec.gridText === 'string' && rec.gridText) out.gridText = rec.gridText;
    return out;
  }

  // 合并：只补本地没有的关卡，本地已有的原样保留（绝不覆盖）
  function mergeShared(json) {
    var incoming;
    if (json && typeof json === 'object' && json.conversions && typeof json.conversions === 'object') incoming = json.conversions;
    else if (json && typeof json === 'object' && !Array.isArray(json)) incoming = json;
    else throw new Error('文件内容不是 JSON 对象');

    var added = 0, skipped = 0, invalid = [];
    Object.keys(incoming).forEach(function (k) {
      if (!/^\d+$/.test(k)) return;
      if (conversions[k]) { skipped++; return; }
      var rec = sanitizeConv(incoming[k]);
      if (!rec) { invalid.push(k); return; }
      conversions[k] = rec;
      added++;
    });
    if (added) { saveConversions(); refreshSupport(); }
    return { added: added, skipped: skipped, invalid: invalid };
  }

  function sharedPull() {
    var urls = sharedUrls();
    if (!urls.length) {
      if (ui.shareMsg) ui.shareMsg.textContent = '先在下面填共享仓库（用户名/仓库名）再点保存，或让脚本作者把默认仓库填进脚本里。';
      return Promise.resolve(null);
    }
    if (ui.shareMsg) ui.shareMsg.textContent = '正在拉取共享库…';
    var errors = [];
    var chain = Promise.resolve(null);
    urls.forEach(function (u) {
      chain = chain.then(function (got) {
        if (got) return got;
        return gmFetch(u).then(function (txt) { return JSON.parse(txt); },
          function (e) { errors.push(u.split('/')[2] + ' ' + e.message); return null; });
      });
    });
    return chain.then(function (json) {
      if (!json) {
        if (ui.shareMsg) ui.shareMsg.textContent = '拉取失败：' + (errors.join('；') || '没有可用的地址');
        return null;
      }
      var r;
      try { r = mergeShared(json); } catch (e) {
        if (ui.shareMsg) ui.shareMsg.textContent = '共享库内容有问题：' + e.message;
        return null;
      }
      var msg = '拉取完成：新增 ' + r.added + ' 条，本地已有 ' + r.skipped + ' 条（保持原样，未覆盖）';
      if (r.invalid.length) msg += '，忽略无效 ' + r.invalid.length + ' 条（#' + r.invalid.slice(0, 10).join(', #') + '）';
      if (r.added) msg += '。刷新页面后归档列表里这些题就会显示为可玩。';
      if (ui.shareMsg) ui.shareMsg.textContent = msg;
      renderSources();
      return r;
    });
  }

  function sharedExportText() {
    return JSON.stringify({
      format: 1,
      exportedAt: new Date().toISOString(),
      scriptVersion: SCRIPT_VERSION,
      count: Object.keys(conversions).length,
      conversions: conversions
    }, null, 2);
  }

  function sharedExport() {
    var n = Object.keys(conversions).length;
    if (!n) {
      if (ui.shareMsg) ui.shareMsg.textContent = '本地还没有转换/录入过题目，没什么可导出的。';
      return null;
    }
    downloadText('akari-shared-' + stampNow() + '.json', sharedExportText());
    if (ui.shareMsg) ui.shareMsg.textContent = '已导出 ' + n + ' 条到 json 文件。把它合并进仓库的 ' + SHARED_FILE + ' 即可（格式是 {format, exportedAt, count, conversions}）。';
    return n;
  }

  // ---------- 打开某关（走站内路由，不整页刷新） ----------
  // 把当前这关的题目写进 URL 的 hash（形如 #akari/W/H/body）。
  // Daily Akari 的「分享链接」就是这么带题目的，Akari Solver 之类的扩展会优先读它，
  // 读到就不会再去请求 /archivepuzzle（那对我们转化的题会返回 400）。
  // 用 replaceState 是为了不触发 hashchange（避免扩展重复往播放器里塞一遍题目）。
  function ensurePuzzleHash() {
    var m = /^\/archive\/(\d+)/.exec(location.pathname);
    if (!m) return;
    var conv = conversions[m[1]];
    if (!conv) return;
    var p = parsePuzzlinkUrl(effectiveUrl(conv));
    if (!p) return;
    var want = '#akari/' + p.cols + '/' + p.rows + '/' + p.body;
    if (location.hash === want) return;
    try { history.replaceState(history.state, '', location.pathname + location.search + want); } catch (e) {}
  }

  function openPuzzle(n) {
    var path = '/archive/' + n;
    if (location.pathname === path) { location.reload(); return; }
    try {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (e) {
      location.assign(path);
      return;
    }
    ensurePuzzleHash();
    setTimeout(function () {
      if (location.pathname !== path || !document.querySelector('iframe[src*="akari.html"]')) {
        location.assign(path);
      }
    }, 2500);
  }

  installXhrPatch();
  refreshSupport();

  /* ============================ 三、界面 ============================ */

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.wrap{position:fixed;z-index:2147483000;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    '  font-size:13px;line-height:1.45;color:#e9edf2;text-align:left;direction:ltr}',
    '.pill{display:none;align-items:center;gap:.4em;padding:.5em .85em;border-radius:999px;border:1px solid #4a5568;',
    '  background:#1c2029;color:#e9edf2;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.5)}',
    '.pill:hover{border-color:#e8d754}',
    '.wrap.collapsed .pill{display:inline-flex}',
    '.wrap.collapsed .panel{display:none}',
    '.panel{width:min(94vw,470px);max-height:min(78vh,720px);display:flex;flex-direction:column;border-radius:12px;',
    '  background:#15181f;border:1px solid #39414f;box-shadow:0 12px 40px rgba(0,0,0,.6);overflow:hidden}',
    '.hd{display:flex;align-items:center;gap:.5em;padding:.6em .8em;background:#1c2029;border-bottom:1px solid #39414f;',
    '  cursor:move;user-select:none}',
    '.hd .title{font-weight:700}',
    '.hd .sp{flex:1}',
    '.body{padding:.7em .8em .8em;display:flex;flex-direction:column;gap:.55em;overflow:auto}',
    '.row{display:flex;gap:.4em;flex-wrap:wrap}',
    '.spacer{flex:1}',
    '.btn{padding:.35em .6em;border-radius:7px;border:1px solid #4a5568;background:#242a35;color:#e9edf2;font:inherit;cursor:pointer}',
    '.btn:hover{border-color:#8b98ac;background:#2c3441}',
    '.btn.mini{padding:.1em .45em;line-height:1.2}',
    '.btn.ok{border-color:#3f8f5f;color:#8ff0b3}',
    '.btn.mid{border-color:#3f7f9f;color:#8fd6f0}',
    '.btn.no{border-color:#8f4f57;color:#f0a0a8}',
    'input[type=text],input[type=search],select{padding:.35em .5em;border-radius:7px;border:1px solid #4a5568;background:#22262f;',
    '  color:#e9edf2;font:inherit;min-width:0}',
    '.row input[type=text]{flex:1 1 200px}',
    '.sec input[type=text],.sec input[type=search]{flex:0 0 auto;width:100%;height:auto}',
    '.warn{padding:.5em .6em;border-radius:8px;background:#3a2f16;border:1px solid #8a6d2a;color:#ffdd8a;font-size:12px}',
    '.hint{font-size:12px;color:#a9b4c4;align-self:center}',
    '.hint.bad{color:#f0a0a8}',
    '.summary{font-size:12px;color:#a9b4c4}',
    '.list{border:1px solid #39414f;border-radius:9px;overflow:auto;max-height:44vh;background:#12151b}',
    '.item{display:flex;align-items:center;gap:.5em;padding:.34em .55em;border-bottom:1px solid #232833}',
    '.item:last-child{border-bottom:0}',
    '.item .no{width:3.4em;color:#8f9bad;font-variant-numeric:tabular-nums}',
    '.item .d{width:6.6em;color:#8f9bad;font-variant-numeric:tabular-nums}',
    '.item .st{flex:1}',
    '.item.perfect .st{color:#e8d754;font-weight:700}',
    '.item.solved .st{color:#7fe0a0}',
    '.item.none .st{color:#7d8798}',
    '.item .ops{display:flex;gap:.25em}',
    '.item .ops .btn{font-size:11px;padding:.1em .4em}',
    '.empty{padding:.9em;color:#8f9bad;text-align:center}',
    '.foot{font-size:11px;color:#7d8798}',
    '.link{background:none;border:0;color:#8fd6f0;text-decoration:underline;cursor:pointer;font:inherit;padding:0}',
    '.hist-item{display:flex;align-items:center;gap:.5em;padding:.4em .55em;border-bottom:1px solid #232833}',
    '.hist-item .t{flex:1;font-variant-numeric:tabular-nums}',
    '.sec{border:1px solid #39414f;border-radius:9px;padding:.5em .55em;display:flex;flex-direction:column;gap:.45em}',
    '.sec-hd{display:flex;align-items:center;gap:.4em;font-weight:700}',
    '.src-item{display:flex;align-items:center;gap:.4em;padding:.3em .35em;border-top:1px solid #232833}',
    '.src-item:first-child{border-top:0}',
    '.src-item .no{width:3.2em;color:#8f9bad;font-variant-numeric:tabular-nums}',
    '.src-item .d{width:6.4em;color:#8f9bad;font-variant-numeric:tabular-nums}',
    '.src-item .au{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    'textarea{width:100%;min-height:9em;padding:.4em .5em;border-radius:7px;border:1px solid #4a5568;background:#22262f;',
    '  color:#e9edf2;font:12px/1.4 ui-monospace,Consolas,monospace;resize:vertical}',
    '.grid-preview{display:inline-block;border-collapse:collapse;font:11px/1.1 ui-monospace,monospace}',
    '.grid-preview td{width:1.4em;height:1.4em;text-align:center;border:1px solid #39414f;color:#e9edf2}',
    '.grid-preview td.b{background:#000;color:#ffe08a;font-weight:700}',
    '.grid-preview td.w{background:#2b3240;color:#5a6474}',
    '.badge{font-size:11px;padding:.05em .35em;border-radius:5px;border:1px solid #4a5568;color:#a9b4c4}',
    '.chk{display:flex;align-items:flex-start;gap:.4em;font-size:12px;color:#c6cedb;cursor:pointer}',
    '.chk input{margin-top:.15em;accent-color:#7fe0a0}',
    '[hidden]{display:none !important}'
  ].join('\n');

  var ui = {};

  function buildUI() {
    var old = document.getElementById('akari-tool-host');
    if (old) old.remove();

    var host = document.createElement('div');
    host.id = 'akari-tool-host';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'wrap collapsed';
    wrap.innerHTML = [
      '<button class="pill" id="pill" title="Daily Akari 存档工具">存档 <span id="pillCount"></span></button>',
      '<div class="panel" id="panel">',
      '  <div class="hd" id="hd"><span class="title">Daily Akari 存档</span><span class="sp"></span>',
      '    <button class="btn mini" id="btnMin" title="收起">—</button></div>',
      '  <div class="body">',
      '    <div class="warn" id="warn" hidden></div>',
      '    <div class="row">',
      '      <button class="btn" id="btnBackup">下载备份</button>',
      '      <button class="btn" id="btnImport">导入备份</button>',
      '      <button class="btn" id="btnHistory">历史备份</button>',
      '      <button class="btn" id="btnReload">刷新页面</button>',
      '    </div>',
      '    <div class="row">',
      '      <input type="text" id="inp" placeholder="关卡编号（123）或日期（2026-05-20）" spellcheck="false">',
      '    </div>',
      '    <div class="row">',
      '      <span class="hint" id="hint">输入编号或日期后点右边按钮</span>',
      '      <span class="spacer"></span>',
      '      <button class="btn ok" data-mk="perfect">完美</button>',
      '      <button class="btn mid" data-mk="solved">普通通关</button>',
      '      <button class="btn no" data-mk="none">未通关</button>',
      '    </div>',
      '    <div class="row">',
      '      <input type="search" id="q" placeholder="搜索编号或日期" spellcheck="false">',
      '      <select id="view">',
      '        <option value="recorded">仅已记录</option>',
      '        <option value="all">全部关卡</option>',
      '        <option value="perfect">只看完美</option>',
      '        <option value="solved">只看普通通关</option>',
      '        <option value="none">只看未通关</option>',
      '      </select>',
      '    </div>',
      '    <div class="summary" id="sum"></div>',
      '    <div class="list" id="list"></div>',
      '    <div class="list" id="hist" hidden></div>',
      '    <div class="sec" id="srcSec">',
      '      <div class="sec-hd">站点玩不了的题 <span class="badge" id="srcCount">—</span>',
      '        <span class="spacer"></span>',
      '        <button class="btn mini" id="btnSrcLoad">刷新索引</button></div>',
      '      <div class="row">',
      '        <button class="btn" id="btnConvAll">转换全部 janko.at 关卡</button>',
      '      </div>',
      '      <label class="chk"><input type="checkbox" id="padChk"> 竖版题补成方形（播放器总是按横版摆盘，竖版会被转 90°）</label>',
      '      <div class="hint" id="convProg"></div>',
      '      <input type="search" id="srcQ" placeholder="搜索编号 / 作者 / 来源域名" spellcheck="false">',
      '      <div class="list" id="srcList" style="max-height:26vh"></div>',
      '    </div>',
      '    <div class="sec" id="shareSec">',
      '      <div class="sec-hd">共享库 <span class="badge" id="shareCount">—</span>',
      '        <span class="spacer"></span>',
      '        <button class="btn mini" id="btnShareSave">保存仓库</button></div>',
      '      <input type="text" id="shareRepo" placeholder="用户名/仓库名，例如 akari-user/akari-shared" spellcheck="false">',
      '      <div class="row">',
      '        <button class="btn ok" id="btnSharePull">拉取所有题目</button>',
      '        <button class="btn" id="btnShareExport">导出我的条目</button>',
      '      </div>',
      '      <div class="hint" id="shareMsg">拉取只补本地没有的关卡，本地已有的不会被覆盖。</div>',
      '    </div>',
      '    <div class="sec" id="editSec" hidden>',
      '      <div class="sec-hd">手动录题 <span class="badge" id="edNo">—</span>',
      '        <span class="spacer"></span>',
      '        <button class="btn mini" id="edBack">返回</button></div>',
      '      <div class="hint">对着来源里的题图，按行抄进来：<b>-</b> 空格、<b>0-4</b> 数字提示、<b>x</b> 黑格。空格或逗号分隔都行，也可以直接粘 janko.at 的 [problem] 那段。</div>',
      '      <textarea id="edText" spellcheck="false" placeholder="10x10 的例子：&#10;- - 2 - - - - - - -&#10;x x - - - - x - - x&#10;..."></textarea>',
      '      <div class="hint" id="edHint"></div>',
      '      <div id="edPreview"></div>',
      '      <div class="row">',
      '        <button class="btn mini" id="edRotL">↺ 左转 90°</button>',
      '        <button class="btn mini" id="edRotR">↻ 右转 90°</button>',
      '      </div>',
      '      <div class="row">',
      '        <button class="btn ok" id="edPlay">保存并试玩</button>',
      '        <button class="btn" id="edSave">仅保存</button>',
      '        <button class="btn no" id="edDel">删除这关的录入</button>',
      '      </div>',
      '    </div>',
      '    <div class="foot">数据位置：localStorage["archiveCompletion"]，只存在本机本浏览器。改完刷新页面生效。</div>',
      '  </div>',
      '</div>',
      '<input type="file" id="file" accept="application/json,.json" hidden>'
    ].join('\n');
    root.appendChild(wrap);

    ui = {
      host: host, root: root, wrap: wrap,
      pill: wrap.querySelector('#pill'),
      pillCount: wrap.querySelector('#pillCount'),
      panel: wrap.querySelector('#panel'),
      hd: wrap.querySelector('#hd'),
      warn: wrap.querySelector('#warn'),
      inp: wrap.querySelector('#inp'),
      hint: wrap.querySelector('#hint'),
      q: wrap.querySelector('#q'),
      view: wrap.querySelector('#view'),
      sum: wrap.querySelector('#sum'),
      list: wrap.querySelector('#list'),
      hist: wrap.querySelector('#hist'),
      file: wrap.querySelector('#file'),
      srcSec: wrap.querySelector('#srcSec'),
      srcCount: wrap.querySelector('#srcCount'),
      srcList: wrap.querySelector('#srcList'),
      srcQ: wrap.querySelector('#srcQ'),
      convProg: wrap.querySelector('#convProg'),
      editSec: wrap.querySelector('#editSec'),
      edNo: wrap.querySelector('#edNo'),
      edText: wrap.querySelector('#edText'),
      edHint: wrap.querySelector('#edHint'),
      edPreview: wrap.querySelector('#edPreview'),
      padChk: wrap.querySelector('#padChk'),
      shareCount: wrap.querySelector('#shareCount'),
      shareRepo: wrap.querySelector('#shareRepo'),
      shareMsg: wrap.querySelector('#shareMsg')
    };

    // ---------- 事件 ----------
    ui.pill.addEventListener('click', function () { setCollapsed(false); });
    wrap.querySelector('#btnMin').addEventListener('click', function () { setCollapsed(true); });
    wrap.querySelector('#btnBackup').addEventListener('click', function () {
      downloadBackup();
      flash('已导出备份文件');
    });
    wrap.querySelector('#btnReload').addEventListener('click', function () { location.reload(); });
    wrap.querySelector('#btnHistory').addEventListener('click', showHistory);
    wrap.querySelector('#btnImport').addEventListener('click', function () { ui.file.click(); });
    ui.file.addEventListener('change', function () {
      var f = ui.file.files && ui.file.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var n = restoreRaw(String(fr.result), '导入 ' + f.name);
          alert('已导入 ' + n + ' 条记录。刷新页面后生效。');
        } catch (e) { alert('导入失败：' + e.message); }
      };
      fr.readAsText(f);
      ui.file.value = '';
    });

    ui.inp.addEventListener('input', updateHint);
    ui.inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') applyInput('perfect');
    });
    ui.q.addEventListener('input', render);
    ui.q.addEventListener('keydown', function (e) { e.stopPropagation(); });
    ui.view.addEventListener('change', render);

    // ---------- 来源题 / 手动录题 ----------
    ui.srcQ.addEventListener('input', renderSources);
    ui.srcQ.addEventListener('keydown', function (e) { e.stopPropagation(); });
    wrap.querySelector('#btnSrcLoad').addEventListener('click', function () { loadIndex(true); });
    wrap.querySelector('#btnConvAll').addEventListener('click', convertAllJanko);
    wrap.querySelector('#btnShareSave').addEventListener('click', function () {
      var v = ui.shareRepo.value.trim().replace(/\/+$/, '');
      kvSet(SHARED_KEY, v);
      var urls = sharedUrls();
      ui.shareMsg.textContent = !v
        ? '已清空共享仓库设置。'
        : (urls.length ? '已保存。拉取地址：' + urls[0] : '这个仓库地址看不懂，用「用户名/仓库名」或完整 URL。');
    });
    wrap.querySelector('#btnSharePull').addEventListener('click', function () { sharedPull(); });
    wrap.querySelector('#btnShareExport').addEventListener('click', function () { sharedExport(); });
    ui.shareRepo.addEventListener('keydown', function (e) { e.stopPropagation(); });
    ui.padChk.addEventListener('change', function () {
      kvSet(PAD_KEY, !!ui.padChk.checked);
      refreshSupport();
      renderSources();
      ui.convProg.textContent = ui.padChk.checked
        ? '已开启竖版补方：重开一次题目即可生效。'
        : '已关闭竖版补方：竖版题会被播放器转 90° 显示。';
    });
    ui.edText.addEventListener('input', renderEditorPreview);
    ui.edText.addEventListener('keydown', function (e) { e.stopPropagation(); });
    wrap.querySelector('#edRotL').addEventListener('click', function () { rotateEditor('ccw'); });
    wrap.querySelector('#edRotR').addEventListener('click', function () { rotateEditor('cw'); });
    wrap.querySelector('#edBack').addEventListener('click', function () {
      ui.editSec.hidden = true;
      ui.srcSec.hidden = false;
    });
    wrap.querySelector('#edSave').addEventListener('click', function () { saveEditor(false); });
    wrap.querySelector('#edPlay').addEventListener('click', function () { saveEditor(true); });
    wrap.querySelector('#edDel').addEventListener('click', function () {
      if (!editingNumber) return;
      if (!confirm('删掉第 ' + editingNumber + ' 关的录入数据？')) return;
      removeConversion(editingNumber);
      alert('已删除。');
      ui.editSec.hidden = true;
      ui.srcSec.hidden = false;
      renderSources();
    });

    ui.srcList.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!b) return;
      var n = b.getAttribute('data-n');
      var act = b.getAttribute('data-act');
      if (act === 'play') { openPuzzle(n); return; }
      if (act === 'convert') { convertOne(n, b); return; }
      if (act === 'manual') { openEditor(n); return; }
      if (act === 'source') {
        var ent = entryOf(n);
        if (ent && ent.source) window.open(ent.source, '_blank', 'noopener');
        return;
      }
      if (act === 'reconvert') {
        if (!confirm('重新抓取并转换第 ' + n + ' 关？')) return;
        convertOne(n, b, true);
        return;
      }
    });

    Array.prototype.forEach.call(wrap.querySelectorAll('.body [data-mk]'), function (b) {
      b.addEventListener('click', function () { applyInput(b.getAttribute('data-mk')); });
    });

    ui.list.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-n]') : null;
      if (!b) return;
      var n = Number(b.getAttribute('data-n'));
      var mk = b.getAttribute('data-mk');
      try {
        setState(n, mk, mk === 'solved' ? askAccuracy(n) : undefined);
      } catch (err) { alert(err.message); }
    });

    ui.hist.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-i]') : null;
      if (!b) return;
      var i = Number(b.getAttribute('data-i'));
      var bk = getBackups()[i];
      if (!bk) return;
      if (!confirm('用 ' + fmtTime(bk.t) + ' 的备份（' + bk.count + ' 条记录）覆盖当前存档？\n当前内容会先自动备份一份。')) return;
      try {
        restoreRaw(bk.raw, '还原 ' + bk.t);
        ui.hist.hidden = true;
        ui.list.hidden = false;
        alert('已还原。刷新页面后生效。');
      } catch (err) { alert(err.message); }
    });

    enableDrag(wrap, ui.hd);
    document.documentElement.appendChild(host);

    applyPos();
    setCollapsed(kvGet('collapsed', true) === true);
    ui.padChk.checked = kvGet(PAD_KEY, true) !== false;
    ui.shareRepo.value = sharedRepo();
    render();
  }

  // ---------- 交互小工具 ----------
  function flash(msg) {
    if (!ui.sum) return;
    ui.sum.textContent = msg;
    setTimeout(render, 1200);
  }

  function setCollapsed(v) {
    ui.wrap.classList.toggle('collapsed', !!v);
    kvSet('collapsed', !!v);
    if (!v) render();
  }

  function updateHint() {
    var t = parseTarget(ui.inp.value);
    if (!ui.inp.value.trim()) {
      ui.hint.className = 'hint';
      ui.hint.textContent = '输入编号或日期后点右边按钮';
      return;
    }
    if (!t) {
      ui.hint.className = 'hint bad';
      ui.hint.textContent = '格式看不懂，试试 123 或 2026-05-20';
      return;
    }
    var data = load();
    ui.hint.className = 'hint';
    ui.hint.textContent = '#' + t.n + '（' + dateOfNumber(t.n) + '）：' + stateLabel(t.n, data) +
      (t.n >= todayNumber() ? ' · 今天或未来，归档里可能还没有' : '');
  }

  function applyInput(mode) {
    var t = parseTarget(ui.inp.value);
    if (!t) { ui.hint.className = 'hint bad'; ui.hint.textContent = '先填一个关卡编号或日期'; return; }
    try {
      setState(t.n, mode, mode === 'solved' ? askAccuracy(t.n) : undefined);
      updateHint();
    } catch (e) { alert(e.message); }
  }

  // mode='solved' 时问一下要显示的准确率（直接确定就用默认值）
  function askAccuracy(n) {
    var cur = load()[n];
    var def = cur && typeof cur.acc === 'number' && cur.acc < 1 ? Math.round(cur.acc * 100) : 0;
    var ans = prompt('第 ' + n + ' 关显示多少准确率？（0~99，直接点确定 = ' + def + '）', String(def));
    if (ans === null) return undefined;
    var pct = Number(String(ans).replace('%', '').trim());
    if (!isFinite(pct) || pct < 0 || pct > 99) return undefined;
    return pct / 100;
  }

  // ---------- 拖动 ----------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function applyPos() {
    var p = kvGet(POS_KEY, null);
    if (!p || typeof p.right !== 'number' || typeof p.bottom !== 'number') return;
    ui.wrap.style.right = clamp(p.right, 0, 100000) + 'px';
    ui.wrap.style.bottom = clamp(p.bottom, 0, 100000) + 'px';
  }

  function enableDrag(wrap, handle) {
    if (!wrap.style.right) wrap.style.right = '16px';
    if (!wrap.style.bottom) wrap.style.bottom = '16px';
    var dragging = false, startX = 0, startY = 0, startR = 0, startB = 0;

    handle.addEventListener('pointerdown', function (e) {
      // 标题栏里有按钮，点在按钮上时不要开始拖拽
      // （否则 setPointerCapture + preventDefault 会把按钮的点击事件吞掉）
      if (e.target && e.target.closest && e.target.closest('button,input,select,textarea,a,label')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startR = parseFloat(wrap.style.right) || 16;
      startB = parseFloat(wrap.style.bottom) || 16;
      if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      wrap.style.right = clamp(startR - (e.clientX - startX), 0, Math.max(0, innerWidth - 60)) + 'px';
      wrap.style.bottom = clamp(startB - (e.clientY - startY), 0, Math.max(0, innerHeight - 40)) + 'px';
    });
    handle.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      kvSet(POS_KEY, { right: parseFloat(wrap.style.right) || 16, bottom: parseFloat(wrap.style.bottom) || 16 });
    });
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------- 列表渲染 ----------
  function render() {
    if (!ui.list) return;
    var data, err = null;
    try { data = load(); } catch (e) { data = {}; err = e.message; }

    var recorded = Object.keys(data).filter(function (k) { return /^\d+$/.test(k); })
      .map(Number).sort(function (a, b) { return a - b; });
    var perfect = 0, solved = 0;
    recorded.forEach(function (n) {
      var st = stateOf(data[n]);
      if (st === 'perfect') perfect++;
      else if (st === 'solved') solved++;
    });
    ui.pillCount.textContent = recorded.length ? '(' + recorded.length + ')' : '';

    if (err) {
      ui.sum.textContent = err;
    } else {
      var newest = recorded.length ? recorded[recorded.length - 1] : 0;
      ui.sum.textContent = '已记录 ' + recorded.length + ' 关：完美 ' + perfect + ' · 普通 ' + solved +
        (recorded.length ? '（最新 #' + newest + ' ' + dateOfNumber(newest) + '）' : '');
    }

    renderWarning();

    var view = ui.view.value;
    var q = ui.q.value.trim();
    var nums;
    if (view === 'all' || view === 'none') {
      nums = [];
      var last = todayNumber() - 1;          // 今天的还没进归档
      for (var i = 1; i <= last; i++) nums.push(i);
    } else {
      nums = recorded;
    }

    var frag = document.createDocumentFragment();
    var shown = 0;
    for (var j = 0; j < nums.length; j++) {
      var n = nums[j];
      var st = stateOf(data[n]);
      if (view === 'perfect' && st !== 'perfect') continue;
      if (view === 'solved' && st !== 'solved') continue;
      if (view === 'none' && st !== 'none') continue;
      if (view === 'recorded' && st === 'none') continue;
      var date = dateOfNumber(n);
      if (q && String(n) !== q && date.indexOf(q) === -1) continue;
      frag.appendChild(buildRow(n, date, st, data[n]));
      shown++;
    }

    while (ui.list.firstChild) ui.list.removeChild(ui.list.firstChild);
    if (!shown) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = err ? '存档读取失败，请看控制台' : '没有符合条件的关卡';
      ui.list.appendChild(empty);
    } else {
      ui.list.appendChild(frag);
    }
    renderSources();
  }

  function renderWarning() {
    if (!pending) { ui.warn.hidden = true; ui.warn.textContent = ''; return; }
    ui.warn.hidden = false;
    ui.warn.textContent = '改动已写入本地存档，但当前页面还在用旧数据 —— 继续玩之前先刷新，否则本站结算可能覆盖你的修改。';
    var btn = document.createElement('button');
    btn.className = 'link';
    btn.textContent = '立即刷新';
    btn.addEventListener('click', function () { location.reload(); });
    ui.warn.appendChild(document.createTextNode(' '));
    ui.warn.appendChild(btn);
  }

  function buildRow(n, date, st, entry) {
    var el = document.createElement('div');
    el.className = 'item ' + st;

    var no = document.createElement('span');
    no.className = 'no';
    no.textContent = '#' + n;

    var d = document.createElement('span');
    d.className = 'd';
    d.textContent = date;

    var s = document.createElement('span');
    s.className = 'st';
    s.textContent = st === 'solved' ? '通关 ' + Math.round(entry.acc * 100) + '%' :
      st === 'dirty' ? '数据异常' : (st === 'perfect' ? '完美！' : '未通关');

    var ops = document.createElement('span');
    ops.className = 'ops';
    [['perfect', '完美'], ['solved', '通关'], ['none', '清除']].forEach(function (pair) {
      var b = document.createElement('button');
      b.className = 'btn';
      b.textContent = pair[1];
      b.setAttribute('data-n', n);
      b.setAttribute('data-mk', pair[0]);
      ops.appendChild(b);
    });

    el.appendChild(no);
    el.appendChild(d);
    el.appendChild(s);
    el.appendChild(ops);
    return el;
  }

  function showHistory() {
    var list = getBackups();
    while (ui.hist.firstChild) ui.hist.removeChild(ui.hist.firstChild);
    ui.list.hidden = true;
    ui.hist.hidden = false;

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有历史备份（每次修改前会自动存一份）';
      ui.hist.appendChild(empty);
    } else {
      list.forEach(function (bk, i) {
        var el = document.createElement('div');
        el.className = 'hist-item';
        var t = document.createElement('span');
        t.className = 't';
        t.textContent = fmtTime(bk.t) + ' · ' + bk.count + ' 条' + (bk.note ? ' · ' + bk.note : '');
        var b = document.createElement('button');
        b.className = 'btn mini';
        b.textContent = '还原';
        b.setAttribute('data-i', i);
        el.appendChild(t);
        el.appendChild(b);
        ui.hist.appendChild(el);
      });
    }

    var back = document.createElement('button');
    back.className = 'btn';
    back.textContent = '返回列表';
    back.style.margin = '.5em';
    back.addEventListener('click', function () {
      ui.hist.hidden = true;
      ui.list.hidden = false;
    });
    ui.hist.appendChild(back);
  }

  /* ---------- 来源题列表 / 转换 / 手动录题 ---------- */

  var editingNumber = null;

  function isJankoSource(src) { return !!src && /janko\.at/i.test(src); }

  function allEntries() {
    var out = {};
    var live = (pageWin && pageWin.__AKARI_ENTRIES__) ? pageWin.__AKARI_ENTRIES__ : {};
    Object.keys(archiveIndex).forEach(function (k) { out[k] = archiveIndex[k]; });
    Object.keys(live).forEach(function (k) { out[k] = live[k]; });
    return out;
  }

  function unplayableEntries() {
    var all = allEntries();
    return Object.keys(all).map(Number).filter(function (n) {
      return all[n] && all[n].isPlayable === 0;
    }).sort(function (a, b) { return a - b; }).map(function (n) { return all[n]; });
  }

  function renderSources() {
    if (!ui.srcList) return;
    var list = unplayableEntries();
    var convCount = list.filter(function (e) { return conversions[e.dailyNumber]; }).length;
    ui.srcCount.textContent = list.length ? (list.length + ' 关，已转 ' + convCount) : '还没索引';
    if (ui.shareCount) ui.shareCount.textContent = '本地 ' + Object.keys(conversions).length + ' 条';

    var q = ui.srcQ.value.trim().toLowerCase();
    var frag = document.createDocumentFragment();
    var shown = 0;
    list.forEach(function (e) {
      var n = e.dailyNumber;
      var conv = conversions[n];
      var host = e.source ? String(e.source).replace(/^https?:\/\//, '').split('/')[0] : '';
      var text = ('#' + n + ' ' + (e.dateKey || '') + ' ' + (e.author || '') + ' ' + host).toLowerCase();
      if (q && text.indexOf(q) === -1) return;
      var row = document.createElement('div');
      row.className = 'src-item';
      var no = document.createElement('span'); no.className = 'no'; no.textContent = '#' + n;
      var d = document.createElement('span'); d.className = 'd'; d.textContent = e.dateKey || dateOfNumber(n);
      var au = document.createElement('span'); au.className = 'au';
      au.textContent = (e.author || '未知') + (conv ? ' · 已转' : '') +
        (conv && conv.cols < conv.rows && kvGet(PAD_KEY, true) !== false ? ' · 竖版补方' : '');
      au.title = (e.author || '') + '\n' + (e.source || '无来源');
      row.appendChild(no); row.appendChild(d); row.appendChild(au);

      var ops = document.createElement('span'); ops.className = 'ops';
      function mk(label, act, cls) {
        var b = document.createElement('button');
        b.className = 'btn mini' + (cls ? ' ' + cls : '');
        b.textContent = label;
        b.setAttribute('data-n', n);
        b.setAttribute('data-act', act);
        ops.appendChild(b);
        return b;
      }
      if (conv) {
        mk(conv.src === 'janko' ? '试玩' : '试玩', 'play', 'ok');
        mk(conv.src === 'janko' ? '重新转换' : '重新录入', conv.src === 'janko' ? 'reconvert' : 'manual');
      } else if (isJankoSource(e.source)) {
        mk('转换并试玩', 'convert', 'ok');
      } else {
        mk('录题', 'manual', 'ok');
      }
      if (e.source) mk('来源', 'source');
      row.appendChild(ops);
      frag.appendChild(row);
      shown++;
    });

    while (ui.srcList.firstChild) ui.srcList.removeChild(ui.srcList.firstChild);
    if (!shown) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = list.length ? '没有匹配的' : '点「刷新索引」抓取归档里玩不了的题（约 6 次请求）';
      ui.srcList.appendChild(empty);
    } else {
      ui.srcList.appendChild(frag);
    }
  }

  var indexLoading = false;
  function loadIndex(showMsg) {
    if (indexLoading) return Promise.resolve();
    indexLoading = true;
    var pages = [1, 2, 3, 4, 5, 6];
    if (showMsg) ui.convProg.textContent = '正在抓取归档索引…';
    var chain = Promise.resolve();
    pages.forEach(function (p) {
      chain = chain.then(function () {
        var url = 'https://dailyakari.com/archivelist?unsolved=0&difficulty=0&sort=0&page=' + p;
        return gmFetch(url).then(function (txt) {
          var j = JSON.parse(txt);
          (j.entries || []).forEach(function (e) { archiveIndex[e.dailyNumber] = e; });
          if (showMsg) ui.convProg.textContent = '正在抓取归档索引… 第 ' + p + ' 页';
          return j.areMore;
        }).catch(function () { return false; });
      });
    });
    return chain.then(function () {
      saveIndex();
      indexLoading = false;
      if (showMsg) {
        ui.convProg.textContent = '索引已更新：' + unplayableEntries().length + ' 关玩不了，其中 janko.at ' +
          unplayableEntries().filter(function (e) { return isJankoSource(e.source); }).length + ' 关可以自动转换';
      }
      renderSources();
    }, function (e) {
      indexLoading = false;
      if (showMsg) ui.convProg.textContent = '索引抓取失败：' + e.message;
    });
  }

  function convertOne(n, btn, force) {
    var e = entryOf(n) || {};
    if (!isJankoSource(e.source)) { openEditor(n); return Promise.resolve(); }
    if (btn) { btn.disabled = true; btn.textContent = '抓取中…'; }
    ui.convProg.textContent = '正在抓取 janko.at 第 ' + n + ' 关…';
    return convertJanko(n, e.source).then(function () {
      ui.convProg.textContent = '第 ' + n + ' 关已转换，正在打开…';
      renderSources();
      openPuzzle(n);
    }, function (err) {
      ui.convProg.textContent = '第 ' + n + ' 关转换失败：' + err.message;
      if (btn) { btn.disabled = false; btn.textContent = force ? '重新转换' : '转换并试玩'; }
    });
  }

  function convertAllJanko() {
    var work = function () {
      var todo = unplayableEntries().filter(function (e) {
        return isJankoSource(e.source) && !conversions[e.dailyNumber];
      });
      if (!todo.length) {
        ui.convProg.textContent = '没有需要转换的 janko.at 关卡了。';
        return;
      }
      var done = 0, failed = [];
      var chain = Promise.resolve();
      todo.forEach(function (e) {
        chain = chain.then(function () {
          ui.convProg.textContent = '正在转换 ' + (done + failed.length + 1) + '/' + todo.length + ' …（#' + e.dailyNumber + '）';
          return convertJanko(e.dailyNumber, e.source).then(function () {
            done++;
          }, function () {
            failed.push(e.dailyNumber);
            done++;
          }).then(function () { return new Promise(function (r) { setTimeout(r, 250); }); });
        });
      });
      return chain.then(function () {
        ui.convProg.textContent = '转换完成：成功 ' + (done - failed.length) + ' 关' +
          (failed.length ? '，失败 ' + failed.length + ' 关（#' + failed.join(', #') + '）' : '') + '。刷新归档列表就能玩。';
        renderSources();
      });
    };
    if (!unplayableEntries().length) return loadIndex(true).then(work);
    return work();
  }

  function conversionGrid(conv) {
    var m = /akari\/(\d+)\/(\d+)\/(.*)$/.exec(conv.url);
    if (!m) return null;
    return { cols: +m[1], rows: +m[2], body: m[3].replace(/\/$/, '') };
  }

  function gridToText(cols, rows, grid) {
    var out = [];
    for (var r = 0; r < rows; r++) {
      var line = [];
      for (var c = 0; c < cols; c++) {
        var v = grid[r * cols + c];
        line.push(v === -1 ? '-' : (v === -2 ? 'x' : String(v)));
      }
      out.push(line.join(' '));
    }
    return out.join('\n');
  }

  function openEditor(n) {
    editingNumber = Number(n);
    ui.edNo.textContent = '#' + n + ' · ' + dateOfNumber(n);
    var text = '';
    var conv = conversions[n];
    if (conv) {
      if (conv.gridText) text = conv.gridText;
      else {
        var g = conversionGrid(conv);
        if (g) text = gridToText(g.cols, g.rows, decodeBody(g.body, g.cols * g.rows));
      }
    }
    ui.edText.value = text;
    ui.srcSec.hidden = true;
    ui.editSec.hidden = false;
    renderEditorPreview();
  }

  function renderEditorPreview() {
    if (!ui.edPreview) return;
    while (ui.edPreview.firstChild) ui.edPreview.removeChild(ui.edPreview.firstChild);
    var text = ui.edText.value;
    if (!text.trim()) { ui.edHint.className = 'hint'; ui.edHint.textContent = '把题目网格粘进来'; return; }
    var g;
    try { g = gridFromText(text); } catch (e) {
      ui.edHint.className = 'hint bad';
      ui.edHint.textContent = e.message;
      return;
    }
    ui.edHint.className = 'hint';
    ui.edHint.textContent = g.cols + ' × ' + g.rows + '，黑格 ' + g.grid.filter(function (v) { return v !== -1; }).length +
      ' 个，数字 ' + g.grid.filter(function (v) { return v >= 0; }).length + ' 个' +
      (g.rows > g.cols && kvGet(PAD_KEY, true) !== false
        ? '（竖版：播放时会补成 ' + g.rows + '×' + g.rows + ' 的方形，免得被播放器转 90°）'
        : '');
    var table = document.createElement('table');
    table.className = 'grid-preview';
    for (var r = 0; r < g.rows; r++) {
      var tr = document.createElement('tr');
      for (var c = 0; c < g.cols; c++) {
        var v = g.grid[r * g.cols + c];
        var td = document.createElement('td');
        if (v === -1) { td.className = 'w'; td.textContent = '·'; }
        else if (v === -2) { td.className = 'b'; }
        else { td.className = 'b'; td.textContent = v; }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    ui.edPreview.appendChild(table);
  }

  function saveEditor(play) {
    if (!editingNumber) return;
    try {
      setManual(editingNumber, ui.edText.value);
      ui.convProg.textContent = '第 ' + editingNumber + ' 关已保存到本地。';
      if (play) openPuzzle(editingNumber);
      else { ui.editSec.hidden = true; ui.srcSec.hidden = false; renderSources(); }
    } catch (e) {
      ui.edHint.className = 'hint bad';
      ui.edHint.textContent = e.message;
    }
  }

  // 把编辑框里的网格整体转 90°（题目和解答一起转，题目本身不变）
  function rotateEditor(dir) {
    var g;
    try { g = gridFromText(ui.edText.value); } catch (e) {
      ui.edHint.className = 'hint bad';
      ui.edHint.textContent = e.message;
      return;
    }
    var r = rotateGrid(g.cols, g.rows, g.grid, dir);
    ui.edText.value = gridToText(r.cols, r.rows, r.grid);
    renderEditorPreview();
  }

  /* ============================ 四、控制台 API + 启动 ============================ */

  var AK = {
    STORAGE_KEY: STORAGE_KEY,
    load: load,
    raw: raw,
    list: function () {
      var data = load();
      var rows = Object.keys(data).filter(function (k) { return /^\d+$/.test(k); })
        .map(Number).sort(function (a, b) { return a - b; })
        .map(function (n) { return { 编号: n, 日期: dateOfNumber(n), 状态: stateLabel(n, data) }; });
      console.table(rows);
      console.log('[AK] 共 ' + rows.length + ' 关有记录');
      return rows;
    },
    get: function (n) {
      var data = load();
      var out = {
        编号: Number(n),
        日期: dateOfNumber(n),
        状态: stateLabel(n, data),
        原始数据: data[n] === undefined ? null : data[n]
      };
      console.log(out);
      return out;
    },
    set: setState,
    setDate: function (date, mode, acc) {
      var t = parseTarget(date);
      if (!t) throw new Error('日期格式应为 2026-05-20');
      return setState(t.n, mode, acc);
    },
    bulk: setMany,
    remove: function (n) { return setState(n, 'none'); },
    restore: restoreRaw,
    backup: downloadBackup,
    backups: getBackups,
    open: function () { setCollapsed(false); },
    // 来源题：把站点玩不了的题变成可玩
    convert: function (n) { return convertJanko(n); },
    convertAll: convertAllJanko,
    manualSet: function (n, text) {
      var c = setManual(n, text);
      return { 编号: Number(n), 尺寸: c.cols + 'x' + c.rows, puzzlink: c.url };
    },
    removeConversion: function (n) { removeConversion(n); },
    conversions: function () { return conversions; },
    index: function () { return allEntries(); },
    unplayable: function () {
      var rows = unplayableEntries().map(function (e) {
        return {
          编号: e.dailyNumber, 日期: e.dateKey, 作者: e.author,
          来源: e.source || '', 能否自动转换: isJankoSource(e.source) ? 'janko.at' : '',
          已转换: conversions[e.dailyNumber] ? '是' : ''
        };
      });
      console.table(rows);
      return rows;
    },
    refreshIndex: function () { return loadIndex(true); },
    openPuzzle: openPuzzle,
    // 共享库
    sharedRepo: function (v) { if (v !== undefined) kvSet(SHARED_KEY, String(v)); return sharedRepo(); },
    sharedUrls: sharedUrls,
    sharedPull: sharedPull,
    sharedExport: sharedExport,
    sharedExportText: sharedExportText,
    mergeShared: mergeShared,
    help: function () {
      console.log([
        'Daily Akari 存档工具（界面和这些控制台命令功能一样）',
        "  数据位置 localStorage['archiveCompletion']：{ 关卡编号: { acc: 0~1 } }，acc===1 即完美",
        '  AK.list()                             查看所有记录',
        '  AK.get(123)                           看某一关',
        "  AK.set(123,'perfect')                 完美 / 'solved' 普通通关 / 'none' 未通关",
        "  AK.set(123,'solved',0.87)             普通通关、显示 87%",
        "  AK.setDate('2026-05-20','perfect')    按日期改",
        "  AK.bulk({123:'perfect',124:'solved'}) 批量",
        '  AK.backup()                           下载备份文件',
        '  AK.restore(json文本)                  用备份整体还原',
        '  AK.backups()                          查看自动备份（每次改动前都会存）',
        '',
        '  玩站点不让玩的题（第三方转载题）：',
        '  AK.unplayable()                       列出站点玩不了的关卡',
        '  AK.refreshIndex()                     抓取归档索引（约 6 次请求）',
        '  AK.convert(105)                       抓 janko.at 的第 105 关并转换',
        '  AK.convertAll()                       转换全部 janko.at 关卡',
        "  AK.manualSet(139, '- - 2 ...')        手动录入其他来源的题",
        '  AK.openPuzzle(105)                    打开某一关',
        '  AK.conversions()                      查看已转换/已录入的题',
        '',
        '  共享库（和朋友交换已录入的题目）：',
        '  AK.sharedRepo()                       看当前共享仓库',
        "  AK.sharedRepo('user/repo')            设置共享仓库",
        '  AK.sharedUrls()                       看实际会去拉的地址',
        '  AK.sharedPull()                       拉取（只补本地没有的，不覆盖）',
        '  AK.sharedExport()                     导出本地条目为 json 文件',
        '',
        '  AK.open()                             展开面板',
        '  改动后刷新页面才会对网站界面生效。'
      ].join('\n'));
    }
  };

  try {
    var pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    pageWin.AK = AK;
  } catch (e) { /* 个别管理器不给 unsafeWindow，忽略即可 */ }

  function start() {
    try {
      if (!getBackups().length) pushBackup(raw(), '首次运行自动备份');
      buildUI();

      // 网站自己写入时（比如在本站完成一关）同步刷新面板
      var last = raw();
      setInterval(function () {
        var now = raw();
        if (now !== last) { last = now; render(); }
        ensurePuzzleHash();
      }, 2000);

      // 站内路由切换后把题目写进 hash（供 Akari Solver 之类的扩展读取）
      window.addEventListener('popstate', function () { setTimeout(ensurePuzzleHash, 500); });

      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('打开 / 收起 Akari 存档工具', function () {
          setCollapsed(!ui.wrap.classList.contains('collapsed'));
        });
        GM_registerMenuCommand('下载 Akari 存档备份', downloadBackup);
      }
    } catch (e) {
      console.error('[Akari 存档工具] 启动失败：', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
