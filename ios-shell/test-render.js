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
  + ' esc: esc, shorten: shorten, countImgMarkers: countImgMarkers,'
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

console.log('\n' + '='.repeat(52));
console.log('  结果: ' + pass + ' 项通过, ' + fail + ' 项失败');
console.log('='.repeat(52) + '\n');

process.exit(fail ? 1 : 0);
