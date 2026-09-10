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
// 脚本里用的是 window.atob（浏览器里裸的 atob 挂在 window 上），所以桩也要挂在 window 上
sandbox.atob = global.atob;
sandbox.localStorage = {
  getItem: function (k) { return store[k] === undefined ? null : store[k]; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
};

/* 把要测的函数导出到返回值 */
var exportTail = '\nreturn { splitImgMarkers: splitImgMarkers, renderBubbleBody: renderBubbleBody,'
  + ' esc: esc, shorten: shorten, collectMarkers: collectMarkers, splitBubbles: splitBubbles,'
  + ' shouldAutoGreet: shouldAutoGreet, dataUrlToBlob: dataUrlToBlob, estimateSec: estimateSec,'
  + ' mediaSkipped: mediaSkipped, ttsReady: ttsReady, voiceForChar: voiceForChar,'
  + ' evictMedia: evictMedia, mediaBytes: mediaBytes, _db: function(){ return DB; },'
  + ' _setDB: function(d){ DB = d; }, _defaults: defaultSettings };';

// 语音相关：脚本里用到 atob / Blob / Uint8Array，node 18+ 全局就有，直接透传
var api;
try {
  api = new Function('window', 'document', 'localStorage', 'console', 'setTimeout',
                     'clearTimeout', 'TextDecoder', 'Image', 'AbortController',
                     'atob', 'Blob', 'Uint8Array', 'Audio', 'URL',
                     src + exportTail)(
    sandbox.window, sandbox.document, sandbox.localStorage, console, setTimeout,
    clearTimeout, sandbox.TextDecoder, sandbox.Image, sandbox.AbortController,
    global.atob, global.Blob, global.Uint8Array,
    function AudioStub(){ this.play = function(){ return { then: function(){} }; }; },
    { createObjectURL: function(){ return 'blob:stub'; },
      revokeObjectURL: function(){} });
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
var msgWait = { content: '给你看 [[IMG: 晚霞]]', media: [{ prompt: '晚霞', data: null, error: null }] };
has('待生成 -> 显示生成中', api.renderBubbleBody(msgWait, 0), '正在生成图片');

var msgOk = { content: '给你看 [[IMG: 晚霞]]',
              media: [{ prompt: '晚霞', data: 'data:image/jpeg;base64,AAAA', error: null }] };
var hOk = api.renderBubbleBody(msgOk, 0);
has('成功 -> 输出 img 标签', hOk, '<img class="bub-img"');
has('成功 -> src 用图片数据', hOk, 'data:image/jpeg;base64,AAAA');
hasNot('成功 -> 不再显示生成中', hOk, '正在生成图片');

var msgErr = { content: '给你看 [[IMG: 晚霞]]',
               media: [{ prompt: '晚霞', data: null, error: 'HTTP 401 无效的 Key' }] };
var hErr = api.renderBubbleBody(msgErr, 0);
has('失败 -> 显示失败原因', hErr, '配图失败');
has('失败 -> 可点击重试', hErr, 'window.retryImage(0,0)');

var msgEvt = { content: '给你看 [[IMG: 晚霞]]',
               media: [{ prompt: '晚霞', data: null, error: null, evicted: true }] };
has('被清理 -> 显示已清理', api.renderBubbleBody(msgEvt, 0), '配图已清理');

console.log('\n[4] 文字完整性（配图永远不能吃掉文字）');
var msgMix = { content: '开头 [[IMG: 图]] 结尾',
               media: [{ prompt: '图', data: 'data:image/jpeg;base64,BB', error: null }] };
var hMix = api.renderBubbleBody(msgMix, 0);
has('图片前的文字还在', hMix, '开头');
has('图片后的文字还在', hMix, '结尾');

var hEsc = api.renderBubbleBody({ content: '<script>alert(1)</scr' + 'ipt> [[IMG: x]]' }, 0);
hasNot('文字被 HTML 转义（防注入）', hEsc, '<script>');
has('转义后仍保留可见内容', hEsc, '&lt;script&gt;');

console.log('\n[5] 消息序号正确传进重试回调');
var hIdx = api.renderBubbleBody({ content: '[[IMG: x]]',
                                  media: [{ prompt: 'x', data: null, error: 'boom' }] }, 7);
has('用了传入的消息序号', hIdx, 'window.retryImage(7,0)');

/* --- 6. 存储预算回收 --- */
console.log('\n[6] 配图配额回收');
function mkDB(n, sizeEach) {
  var msgs = [];
  for (var i = 0; i < n; i++) {
    msgs.push({ role: 'assistant', content: 'msg' + i,
                media: [{ prompt: 'p' + i, data: new Array(sizeEach + 1).join('x'), ts: i }] });
  }
  return { settings: api._defaults(), chars: [], convs: [{ id: 'c', charId: 'x', msgs: msgs }] };
}

api._setDB(mkDB(3, 1000));
eq('预算内不回收', api.evictMedia(false), 0);
eq('图片字节统计正确', api.mediaBytes(), 3000);

// 6 张 × 600KB = 3.6MB，超过 2.5MB 预算
api._setDB(mkDB(6, 600 * 1024));
var before = api.mediaBytes();
var dropped = api.evictMedia(false);
var after = api.mediaBytes();
eq('超预算触发回收', dropped > 0, true);
eq('回收后落到预算内', after <= 2.5 * 1024 * 1024, true);
eq('回收后确实变小了', after < before, true);
eq('被清的图标记了 evicted', api._db().convs[0].msgs[0].media[0].evicted, true);
eq('最旧的先被清（第0条）', api._db().convs[0].msgs[0].media[0].data, null);
eq('最新的保留（第5条）', typeof api._db().convs[0].msgs[5].media[0].data, 'string');
eq('文字一条没丢', api._db().convs[0].msgs[0].content, 'msg0');

api._setDB(mkDB(6, 600 * 1024));
eq('forceAll 全清', api.evictMedia(true), 6);
eq('全清后字节为 0', api.mediaBytes(), 0);

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
              media: [{ kind: 'img', prompt: '晚霞', data: 'data:image/jpeg;base64,ZZ' }] };
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
  media: [{ kind: 'sticker', prompt: '大笑', data: 'data:image/jpeg;base64,ST' }] }, 0);
has('表情包用小图样式', hSt, 'class="bub-sticker"');

var hStPart = api.renderBubbleBody({ content: '等我 [[STIC', streaming: true }, 0);
hasNot('流式中 [[STIC 不泄露', hStPart, '[[STIC');
has('显示表情包占位', hStPart, '正在做表情包');

// 下标对齐：关了表情包也要占位，否则后面的图会串位
var mSkip = { content: '[[STICKER: 甲]]|||[[IMG: 乙]]',
              media: [{ kind: 'sticker', prompt: '甲', skipped: true },
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

/* --- 11. 语音 --- */
console.log('\n[11] 语音消息');

var vmark = api.collectMarkers('说点话 [[VOICE: 今天天气不错]] 结束');
eq('识别 VOICE 标记', vmark.length, 1);
eq('kind 是 voice', vmark[0].kind, 'voice');
eq('内容解析正确', vmark[0].prompt, '今天天气不错');

var mixed = api.collectMarkers('[[IMG: 图]] [[STICKER: 表情]] [[VOICE: 话]]');
eq('三种标记都能识别', mixed.length, 3);
eq('顺序 1 = img', mixed[0].kind, 'img');
eq('顺序 2 = sticker', mixed[1].kind, 'sticker');
eq('顺序 3 = voice', mixed[2].kind, 'voice');

// 逐字流式：[[V / [[VO 这些中间态不能漏出原始语法
var vseq = ['[', '[[', '[[V', '[[VO', '[[VOI', '[[VOIC', '[[VOICE', '[[VOICE:'];
var vleak = '';
for (var vi = 0; vi < vseq.length; vi++) {
  var vh = api.renderBubbleBody({ content: '我说 ' + vseq[vi], streaming: true }, 0);
  if (vh.indexOf('[[V') >= 0 || vh.indexOf('[[VO') >= 0) vleak = vseq[vi];
}
eq('逐字流式不泄露 [[V 前缀', vleak, '');

var vMsg = { content: '[[VOICE: 今天天气不错]]',
             media: [{ kind: 'voice', prompt: '今天天气不错',
                       data: 'data:audio/mp3;base64,AAA', sec: 4 }] };
var vHtml = api.renderBubbleBody(vMsg, 0);
has('渲染出播放器', vHtml, 'class="bub-voice');
has('显示时长', vHtml, '4″');
has('点击回调带正确下标', vHtml, 'window.toggleVoice(0,0)');
has('显示字幕', vHtml, 'class="vv-text"');
has('字幕是原文', vHtml, '今天天气不错');

var vErr = { content: '[[VOICE: 这句话不能丢]]',
             media: [{ kind: 'voice', prompt: '这句话不能丢', data: null, error: 'invalid token' }] };
var vErrHtml = api.renderBubbleBody(vErr, 0);
has('失败时可点击重试', vErrHtml, 'window.retryImage(0,0)');
has('失败提示写的是语音', vErrHtml, '语音生成失败');
has('失败时文字仍然可见', vErrHtml, '这句话不能丢');

var vSkip = { content: '[[VOICE: 没开语音]]',
              media: [{ kind: 'voice', prompt: '没开语音', data: null, skipped: true }] };
var vSkipHtml = api.renderBubbleBody(vSkip, 0);
hasNot('未开启时不显示转圈', vSkipHtml, '正在合成语音');
has('未开启时提示未生成', vSkipHtml, '语音未生成');
has('未开启时文字仍可见', vSkipHtml, '没开语音');

has('被清理的语音有提示',
  api.renderBubbleBody({ content: '[[VOICE: 清理了]]',
    media: [{ kind: 'voice', prompt: '清理了', data: null, evicted: true }] }, 0), '语音已清理');

// 上一轮的遗留 bug：skipped 的表情包会永远转圈
var stSkip = { content: '[[STICKER: 笑]]',
               media: [{ kind: 'sticker', prompt: '笑', data: null, skipped: true }] };
hasNot('被跳过的表情包不再永远转圈',
  api.renderBubbleBody(stSkip, 0), '正在做表情包');

// base64 -> Blob
var blob = api.dataUrlToBlob('data:audio/mp3;base64,SGVsbG8=');
eq('dataUrlToBlob 返回 Blob', blob ? typeof blob.size : 'none', 'number');
eq('解码字节数正确', blob ? blob.size : -1, 5);
eq('MIME 解析正确', blob ? blob.type : '', 'audio/mp3');
eq('非法输入返回 null', api.dataUrlToBlob('nonsense'), null);

eq('短句时长至少 1 秒', api.estimateSec('你好'), 1);
eq('8 字约 2 秒', api.estimateSec('今天天气真不错呀'), 2);
eq('空内容兜底 1 秒', api.estimateSec(''), 1);

/* --- 12. 语音和图片共用预算 --- */
console.log('\n[12] 媒体预算（语音 + 图片）');
function pad(n) { return new Array(n + 1).join('x'); }
api._setDB({
  settings: api._defaults(), chars: [], v: 1,
  convs: [{ id: 'c', charId: 'x', msgs: [
    { role: 'assistant', content: 'a',
      media: [{ kind: 'voice', prompt: 'v', data: pad(1000), ts: 1 }] },
    { role: 'assistant', content: 'b',
      media: [{ kind: 'img', prompt: 'i', data: pad(2000), ts: 2 }] }
  ] }]
});
eq('语音和图片一起计入预算', api.mediaBytes(), 3000);
var vDropped = api.evictMedia(true);
eq('回收把语音也清掉', vDropped, 2);
eq('清完后预算归零', api.mediaBytes(), 0);
eq('文字没被清', api._db().convs[0].msgs[0].content, 'a');

/* --- 13. 功能开关判定 --- */
console.log('\n[13] 语音配置门槛');
api._setDB({ settings: api._defaults(), chars: [], v: 1, convs: [] });
eq('默认没开语音', api.ttsReady(), false);
eq('没开时语音标记被 skip', api.mediaSkipped('voice'), true);
eq('没配生图时图片标记也被 skip', api.mediaSkipped('img'), true);

api._db().settings.ttsEnabled = true;
api._db().settings.ttsAppId = 'app123';
eq('只填 AppID 还不算就绪', api.ttsReady(), false);
api._db().settings.ttsToken = 'tok';
eq('填全了才算就绪', api.ttsReady(), true);
eq('就绪后不再 skip', api.mediaSkipped('voice'), false);

api._db().chars = [{ id: 'c1', name: '甲', voice: 'BV999_streaming' }];
api._db().settings.ttsVoice = 'BV001_streaming';
eq('角色自带音色优先', api.voiceForChar('c1'), 'BV999_streaming');
eq('角色没设则用全局',
  (function () { api._db().chars[0].voice = ''; return api.voiceForChar('c1'); })(),
  'BV001_streaming');
eq('查不到角色时用全局', api.voiceForChar('nope'), 'BV001_streaming');

console.log('\n' + '='.repeat(52));
console.log('  结果: ' + pass + ' 项通过, ' + fail + ' 项失败');
console.log('='.repeat(52) + '\n');

process.exit(fail ? 1 : 0);
