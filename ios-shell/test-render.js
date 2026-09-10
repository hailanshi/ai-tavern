/* =========================================================================
   app.html 气泡渲染逻辑的回归测试
   用法（仓库根目录）:  node ios-shell/test-render.js

   在 node 里造一套最小 DOM 桩，把 app.html 的 <script> 整体跑起来，
   然后直接调用 splitImgMarkers / renderBubbleBody 验证行为。

   重点覆盖那些「只有真机上才暴露、但其实是纯逻辑」的分支：
     - 流式输出到一半的半截标记（[[IMG: 橘粉 还没闭合）
     - 配图的四种状态：待生成 / 成功 / 失败 / 被清理
     - 多张图、图在文字中间、文本里出现类似但不合法的写法
   ========================================================================= */

var fs = require('fs');
var path = require('path');

var htmlPath = path.join(__dirname, '..', 'app.html');
var html = fs.readFileSync(htmlPath, 'utf8');
var m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('找不到 <script> 块'); process.exit(2); }
var src = m[1];

/* ------------------------- 最小 DOM 桩 ------------------------- */
function makeEl() {
  var el = {
    style: {}, value: '', textContent: '', innerHTML: '', className: '',
    checked: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () {}, removeChild: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    focus: function () {}, select: function () {}, click: function () {},
    getContext: function () { return { fillRect: function () {}, drawImage: function () {} }; },
    toDataURL: function () { return 'data:image/jpeg;base64,STUB'; }
  };
  return el;
}

var store = {};
var sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  JSON: JSON, Math: Math, Date: Date, Number: Number, String: String,
  Array: Array, Object: Object, Error: Error, isNaN: isNaN, parseInt: parseInt,
  TextDecoder: function () { this.decode = function () { return ''; }; },
  Image: function () { this.src = ''; },
  AbortController: function () { this.abort = function () {}; this.signal = {}; },
  document: {
    getElementById: function () { return makeEl(); },
    querySelectorAll: function () { return []; },
    createElement: function () { return makeEl(); },
    addEventListener: function () {},
    body: makeEl()
  }
};
sandbox.window = sandbox;
sandbox.localStorage = {
  getItem: function (k) { return store[k] === undefined ? null : store[k]; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
};

/* 把要测的函数导出到返回值 */
var exportTail = '\nreturn { splitImgMarkers: splitImgMarkers, renderBubbleBody: renderBubbleBody,'
  + ' esc: esc, shorten: shorten, collectMarkers: collectMarkers, splitBubbles: splitBubbles,'
  + ' shouldAutoGreet: shouldAutoGreet,'
  + ' evictImages: evictImages, imageBytes: imageBytes, _db: function(){ return DB; },'
  + ' _setDB: function(d){ DB = d; }, _defaults: defaultSettings };';

var api;
try {
  api = new Function('window', 'document', 'localStorage', 'console', 'setTimeout',
                     'clearTimeout', 'TextDecoder', 'Image', 'AbortController',
                     src + exportTail)(
    sandbox.window, sandbox.document, sandbox.localStorage, console, setTimeout,
    clearTimeout, sandbox.TextDecoder, sandbox.Image, sandbox.AbortController);
} catch (e) {
  console.error('加载 app.html 脚本失败: ' + e.message);
  process.exit(2);
}

/* ------------------------- 断言 ------------------------- */
var fail = 0, pass = 0;
function eq(label, got, want) {
  if (got === want) { console.log('  ✓ ' + label); pass++; }
  else {
    console.log('  ✗ ' + label);
    console.log('      期望: ' + JSON.stringify(want));
    console.log('      实际: ' + JSON.stringify(got));
    fail++;
  }
}
function has(label, hay, needle) {
  if (String(hay).indexOf(needle) >= 0) { console.log('  ✓ ' + label); pass++; }
  else {
    console.log('  ✗ ' + label + ' —— 没找到 ' + JSON.stringify(needle));
    console.log('      实际: ' + JSON.stringify(hay));
    fail++;
  }
}
function hasNot(label, hay, needle) {
  if (String(hay).indexOf(needle) < 0) { console.log('  ✓ ' + label); pass++; }
  else {
    console.log('  ✗ ' + label + ' —— 不该出现 ' + JSON.stringify(needle));
    console.log('      实际: ' + JSON.stringify(hay));
    fail++;
  }
}

console.log('\n=== 气泡渲染回归测试 ===\n');

/* --- 1. 标记切分 --- */
console.log('[1] splitImgMarkers');
var p1 = api.splitImgMarkers('先看这个 [[IMG: 晚霞]] 好看吧');
eq('文字-图-文字 切成 3 段', p1.length, 3);
eq('第1段是文字', p1[0].type, 'text');
eq('第2段是图', p1[1].type, 'img');
eq('描述提取正确', p1[1].prompt, '晚霞');
eq('第3段是文字', p1[2].type, 'text');

var p2 = api.splitImgMarkers('[[IMG: 只有图]]');
eq('整条只有一个标记', p2.length, 1);
eq('是图段', p2[0].type, 'img');

var p3 = api.splitImgMarkers('完全没有标记');
eq('无标记时只有一段文字', p3.length, 1);
eq('是文字段', p3[0].type, 'text');

var p4 = api.splitImgMarkers('两张 [[IMG: 甲]] 和 [[IMG: 乙]] 都给你');
eq('多标记切成 5 段', p4.length, 5);
eq('第一张描述', p4[1].prompt, '甲');
eq('第二张描述', p4[3].prompt, '乙');

var p5 = api.splitImgMarkers('带空格 [[IMG:   前后有空格   ]] 结束');
eq('描述两端空格被吃掉', p5[1].prompt, '前后有空格');

/* --- 2. 流式中的半截标记（最容易出视觉 bug 的地方）--- */
console.log('\n[2] 流式输出到一半');
var h1 = api.splitImgMarkers('等一下我找找 [[IMG: 橘粉色的');
eq('半截标记产生 pending 图片段', h1[1].type, 'img');
eq('pending 段没有描述', h1[1].prompt, '');
eq('pending 标记为 true', h1[1].pending, true);
hasNot('半截状态不显示原始语法',
  api.renderBubbleBody({ content: '等一下我找找 [[IMG: 橘粉色的', streaming: true }, 0), '[[IMG:');

var h2 = api.splitImgMarkers('普通文字 [[IMG');
eq('刚打出 [[IMG 还没冒号也能兜住', h2.length, 2);
hasNot('[[IMG 不泄露到界面', api.renderBubbleBody({ content: '普通文字 [[IMG', streaming: true }, 0), '[[IMG');

// 逐字流式：每个中间态都不能泄露原始语法
var seq = ['[', '[[', '[[I', '[[IM', '[[IMG', '[[IMG:', '[[IMG: 橘', '[[IMG: 橘粉'];
var leaked = '';
for (var si = 0; si < seq.length; si++) {
  var hh = api.renderBubbleBody({ content: '我找找 ' + seq[si], streaming: true }, 0);
  if (hh.indexOf('[[IMG') >= 0 || hh.indexOf('[[IM') >= 0) leaked = seq[si];
}
eq('逐字流式全程不泄露标记语法', leaked, '');

// 单个 '[' 不算标记开头，应该原样显示（避免正常文字被吞）
var hSingle = api.splitImgMarkers('数组下标 arr[');
eq("单个 '[' 不当作标记", hSingle.length, 1);
eq("单个 '[' 保持文字段", hSingle[0].type, 'text');

// 流结束后仍未闭合 -> 当普通文字显示，不能永远转圈
var hUnclosed = api.renderBubbleBody({ content: '他说 [[IMG: 忘了闭合', streaming: false }, 0);
hasNot('未闭合标记不再显示转圈', hUnclosed, '正在生成图片');
has('未闭合标记当普通文字显示', hUnclosed, '忘了闭合');

/* --- 3. 配图四种状态 --- */
console.log('\n[3] renderBubbleBody 状态渲染');
var msgWait = { content: '给你看 [[IMG: 晚霞]]', images: [{ prompt: '晚霞', data: null, error: null }] };
has('待生成 -> 显示生成中', api.renderBubbleBody(msgWait, 0), '正在生成图片');

var msgOk = { content: '给你看 [[IMG: 晚霞]]',
              images: [{ prompt: '晚霞', data: 'data:image/jpeg;base64,AAAA', error: null }] };
var hOk = api.renderBubbleBody(msgOk, 0);
has('成功 -> 输出 img 标签', hOk, '<img class="bub-img"');
has('成功 -> src 用图片数据', hOk, 'data:image/jpeg;base64,AAAA');
hasNot('成功 -> 不再显示生成中', hOk, '正在生成图片');

var msgErr = { content: '给你看 [[IMG: 晚霞]]',
               images: [{ prompt: '晚霞', data: null, error: 'HTTP 401 无效的 Key' }] };
var hErr = api.renderBubbleBody(msgErr, 0);
has('失败 -> 显示失败原因', hErr, '配图失败');
has('失败 -> 可点击重试', hErr, 'window.retryImage(0,0)');

var msgEvt = { content: '给你看 [[IMG: 晚霞]]',
               images: [{ prompt: '晚霞', data: null, error: null, evicted: true }] };
has('被清理 -> 显示已清理', api.renderBubbleBody(msgEvt, 0), '配图已清理');

console.log('\n[4] 文字完整性（配图永远不能吃掉文字）');
var msgMix = { content: '开头 [[IMG: 图]] 结尾',
               images: [{ prompt: '图', data: 'data:image/jpeg;base64,BB', error: null }] };
var hMix = api.renderBubbleBody(msgMix, 0);
has('图片前的文字还在', hMix, '开头');
has('图片后的文字还在', hMix, '结尾');

var hEsc = api.renderBubbleBody({ content: '<script>alert(1)</scr' + 'ipt> [[IMG: x]]' }, 0);
hasNot('文字被 HTML 转义（防注入）', hEsc, '<script>');
has('转义后仍保留可见内容', hEsc, '&lt;script&gt;');

console.log('\n[5] 消息序号正确传进重试回调');
var hIdx = api.renderBubbleBody({ content: '[[IMG: x]]',
                                  images: [{ prompt: 'x', data: null, error: 'boom' }] }, 7);
has('用了传入的消息序号', hIdx, 'window.retryImage(7,0)');

/* --- 6. 存储预算回收 --- */
console.log('\n[6] 配图配额回收');
function mkDB(n, sizeEach) {
  var msgs = [];
  for (var i = 0; i < n; i++) {
    msgs.push({ role: 'assistant', content: 'msg' + i,
                images: [{ prompt: 'p' + i, data: new Array(sizeEach + 1).join('x'), ts: i }] });
  }
  return { settings: api._defaults(), chars: [], convs: [{ id: 'c', charId: 'x', msgs: msgs }] };
}

api._setDB(mkDB(3, 1000));
eq('预算内不回收', api.evictImages(false), 0);
eq('图片字节统计正确', api.imageBytes(), 3000);

// 6 张 × 600KB = 3.6MB，超过 2.5MB 预算
api._setDB(mkDB(6, 600 * 1024));
var before = api.imageBytes();
var dropped = api.evictImages(false);
var after = api.imageBytes();
eq('超预算触发回收', dropped > 0, true);
eq('回收后落到预算内', after <= 2.5 * 1024 * 1024, true);
eq('回收后确实变小了', after < before, true);
eq('被清的图标记了 evicted', api._db().convs[0].msgs[0].images[0].evicted, true);
eq('最旧的先被清（第0条）', api._db().convs[0].msgs[0].images[0].data, null);
eq('最新的保留（第5条）', typeof api._db().convs[0].msgs[5].images[0].data, 'string');
eq('文字一条没丢', api._db().convs[0].msgs[0].content, 'msg0');

api._setDB(mkDB(6, 600 * 1024));
eq('forceAll 全清', api.evictImages(true), 6);
eq('全清后字节为 0', api.imageBytes(), 0);

/* --- 7. 连发多条 --- */
console.log('\n[7] splitBubbles 连发多条');
eq('单条不分', api.splitBubbles('你好', false).length, 1);
var b2 = api.splitBubbles('你好|||在吗', false);
eq('切成两条', b2.length, 2);
eq('第一条内容', b2[0], '你好');
eq('第二条内容', b2[1], '在吗');
eq('三条', api.splitBubbles('a|||b|||c', false).length, 3);

eq('流式中结尾单个 | 要藏起来', api.splitBubbles('你好|', true).length, 1);
eq('流式中结尾 || 要藏起来', api.splitBubbles('你好||', true).length, 1);
eq('流式中结尾 ||| 不产生空气泡', api.splitBubbles('你好|||', true).length, 1);
eq('流式下已分好的两条不受影响', api.splitBubbles('你好|||在', true).length, 2);
eq('非流式下 | 是字面量', api.splitBubbles('你好|', false)[0], '你好|');
eq('非流式下 || 是字面量', api.splitBubbles('a||b', false)[0], 'a||b');
eq('空内容留一个空段', api.splitBubbles('', false).length, 1);

/* --- 8. 多气泡渲染 --- */
console.log('\n[8] 多气泡渲染');
var hMulti = api.renderBubbleBody({ content: '第一句|||第二句|||第三句' }, 0);
eq('渲染出 3 个气泡', (hMulti.match(/class="bub"/g) || []).length, 3);
has('第一句在', hMulti, '第一句');
has('第三句在', hMulti, '第三句');
hasNot('分隔符不外泄', hMulti, '|||');

var mBoth = { content: '看这个 [[IMG: 晚霞]]|||好看吧',
              images: [{ kind: 'img', prompt: '晚霞', data: 'data:image/jpeg;base64,ZZ' }] };
var hBoth = api.renderBubbleBody(mBoth, 0);
eq('图文分条 -> 2 个气泡', (hBoth.match(/class="bub"/g) || []).length, 2);
has('图片挂在第一段', hBoth, 'data:image/jpeg;base64,ZZ');
has('文字在第二段', hBoth, '好看吧');

/* --- 9. 表情包 --- */
console.log('\n[9] 表情包标记');
var mk = api.collectMarkers('文字 [[IMG: 风景]] 中间 [[STICKER: 大笑]] 结尾');
eq('收集到 2 个标记', mk.length, 2);
eq('第一个是图片', mk[0].kind, 'img');
eq('第二个是表情包', mk[1].kind, 'sticker');
eq('图片描述解析正确', mk[0].prompt, '风景');
eq('表情包描述解析正确', mk[1].prompt, '大笑');

var hSt = api.renderBubbleBody({ content: '[[STICKER: 大笑]]',
  images: [{ kind: 'sticker', prompt: '大笑', data: 'data:image/jpeg;base64,ST' }] }, 0);
has('表情包用小图样式', hSt, 'class="bub-sticker"');

var hStPart = api.renderBubbleBody({ content: '等我 [[STIC', streaming: true }, 0);
hasNot('流式中 [[STIC 不泄露', hStPart, '[[STIC');
has('显示表情包占位', hStPart, '正在做表情包');

// 下标对齐：关了表情包也要占位，否则后面的图会串位
var mSkip = { content: '[[STICKER: 甲]]|||[[IMG: 乙]]',
              images: [{ kind: 'sticker', prompt: '甲', skipped: true },
                       { kind: 'img', prompt: '乙', data: 'data:image/jpeg;base64,EE' }] };
var hSkip = api.renderBubbleBody(mSkip, 0);
has('被跳过的表情包后面的图片仍正确', hSkip, 'data:image/jpeg;base64,EE');

/* --- 10. 主动问候真值表 --- */
console.log('\n[10] shouldAutoGreet 真值表');
var NOW = 1700000000000;
function st(over) {
  var s = api._defaults();
  s.autoGreet = true; s.autoIdleMin = 10; s.autoMax = 3;
  for (var k in (over || {})) s[k] = over[k];
  return s;
}
function cv(over) {
  var c = { msgs: [{ role: 'user', content: 'x' }], updatedAt: NOW - 20 * 60000, autoStreak: 0 };
  for (var k in (over || {})) c[k] = over[k];
  return c;
}
function ui(over) {
  var u = { view: 'chat', generating: false, visible: true, armedAt: 0 };
  for (var k in (over || {})) u[k] = over[k];
  return u;
}

eq('全部满足 -> true', api.shouldAutoGreet(NOW, cv(), st(), ui()), true);
eq('开关关 -> false', api.shouldAutoGreet(NOW, cv(), st({ autoGreet: false }), ui()), false);
eq('默认设置就是关的', api.shouldAutoGreet(NOW, cv(), api._defaults(), ui()), false);
eq('不在聊天页 -> false', api.shouldAutoGreet(NOW, cv(), st(), ui({ view: 'home' })), false);
eq('正在生成 -> false', api.shouldAutoGreet(NOW, cv(), st(), ui({ generating: true })), false);
eq('App 在后台 -> false', api.shouldAutoGreet(NOW, cv(), st(), ui({ visible: false })), false);
eq('还在冷却期 -> false', api.shouldAutoGreet(NOW, cv(), st(), ui({ armedAt: NOW + 1000 })), false);
eq('静默时长不够 -> false',
  api.shouldAutoGreet(NOW, cv({ updatedAt: NOW - 5 * 60000 }), st(), ui()), false);
eq('刚好达到静默阈值 -> true',
  api.shouldAutoGreet(NOW, cv({ updatedAt: NOW - 10 * 60000 }), st(), ui()), true);
eq('连续数达上限 -> false', api.shouldAutoGreet(NOW, cv({ autoStreak: 3 }), st(), ui()), false);
eq('上限内 -> true', api.shouldAutoGreet(NOW, cv({ autoStreak: 2 }), st(), ui()), true);
eq('autoMax=0 -> false', api.shouldAutoGreet(NOW, cv(), st({ autoMax: 0 }), ui()), false);
eq('autoIdleMin=0 -> false', api.shouldAutoGreet(NOW, cv(), st({ autoIdleMin: 0 }), ui()), false);
eq('没有对话 -> false', api.shouldAutoGreet(NOW, null, st(), ui()), false);
eq('空对话 -> false', api.shouldAutoGreet(NOW, cv({ msgs: [] }), st(), ui()), false);
eq('刚建的空对话不触发（防开局自说自话）',
  api.shouldAutoGreet(NOW, cv({ msgs: [], updatedAt: NOW - 99 * 60000 }), st(), ui()), false);

console.log('\n' + '='.repeat(52));
console.log('  结果: ' + pass + ' 项通过, ' + fail + ' 项失败');
console.log('='.repeat(52) + '\n');

process.exit(fail ? 1 : 0);
