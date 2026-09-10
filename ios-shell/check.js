/* =========================================================================
   AIChat 交付前自检
   用法（仓库根目录）:  node ios-shell/check.js

   在没有 Mac 的机器上尽量把能查的都查掉：
     [1] HTML 语法 / 旧 iOS 兼容语法
     [2] window 挂载完整性（WKWebView 铁律）
     [3] CSS / DOM 铁律
     [4] 关键功能点
     [5] ObjC 结构 + 壳的铁律
     [6] Info.plist
     [7] project.yml
     [8] GitHub Actions 工作流
     [9] 图标（尺寸 / 无 alpha）
    [10] 资源同步（app.html == Resources/index.html）
   ========================================================================= */

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.resolve(__dirname, '..');
var P = function () {
  var a = [ROOT].concat(Array.prototype.slice.call(arguments));
  return path.join.apply(path, a);
};

var fail = 0, warn = 0;
function ok(m)   { console.log('  \u2713 ' + m); }
function bad(m)  { console.log('  \u2717 ' + m); fail++; }
function wrn(m)  { console.log('  ! ' + m); warn++; }
function head(m) { console.log('\n' + m); }
function read(p) { return fs.readFileSync(p, 'utf8'); }
function exists(p) { return fs.existsSync(p); }

function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/@?"(\\.|[^"\\])*"/g, '""');
}

function countBalanced(src, open, close) {
  var s = stripCommentsAndStrings(src);
  var n = 0, min = 0;
  for (var i = 0; i < s.length; i++) {
    if (s[i] === open) n++;
    else if (s[i] === close) { n--; if (n < min) min = n; }
  }
  return { depth: n, min: min };
}

// =========================================================================
head('=== AIChat 交付前自检 ===');

/* ---------------------------------------------------------------- [1] */
head('[1] app.html — JS 语法与兼容性');
var htmlPath = P('app.html');
if (!exists(htmlPath)) { bad('app.html 不存在'); process.exit(1); }
var html = read(htmlPath);

var m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { bad('找不到 <script> 块'); process.exit(1); }
var js = m[1];

try {
  new Function(js);
  ok('内联 JS 语法正确（' + js.split('\n').length + ' 行）');
} catch (e) {
  bad('语法错误: ' + e.message);
}

var stripped = stripCommentsAndStrings(js);
[
  [/\?\./, '可选链 ?.'],
  [/\?\?/, '空值合并 ??'],
  [/\.flat\s*\(/, '.flat()'],
  [/\bObject\.assign\b/, 'Object.assign'],
  [/\bArray\.from\b/, 'Array.from'],
  [/\.includes\s*\(/, '.includes()'],
  [/\blet\s+[A-Za-z_$]/, 'let 声明'],
  [/\bconst\s+[A-Za-z_$]/, 'const 声明'],
  [/=>/, '箭头函数']
].forEach(function (p) {
  if (p[0].test(stripped)) bad('发现 ' + p[1]); else ok('无 ' + p[1]);
});

/* ---------------------------------------------------------------- [2] */
head('[2] window 挂载完整性（WKWebView 铁律）');
var called = {};
var re = /on(?:click|input|change)\s*=\s*"window\.([A-Za-z_$][\w$]*)\(/g, mm;
while ((mm = re.exec(html))) called[mm[1]] = true;
var re2 = /showConfirm\([^,]+,[^,]+,\s*'([A-Za-z_$][\w$]*)'/g;
while ((mm = re2.exec(js))) called[mm[1]] = true;

var missing = [];
Object.keys(called).sort().forEach(function (fn) {
  if (!new RegExp('window\\.' + fn + '\\s*=').test(js)) {
    var declared = new RegExp('function\\s+' + fn + '\\s*\\(').test(js);
    missing.push(fn + (declared ? '（已定义但未挂 window）' : '（完全未定义）'));
  }
});
if (missing.length) missing.forEach(function (x) { bad('未挂载: ' + x); });
else ok('全部 ' + Object.keys(called).length + ' 个内联调用函数均已挂到 window');

/* ---------------------------------------------------------------- [3] */
head('[3] CSS / DOM 铁律');
if (/[^-]\binset\s*:/.test(html)) bad('使用了 CSS inset 简写'); else ok('无 CSS inset 简写');
if (/\.onclick\s*=/.test(stripped)) bad('存在 el.onclick = fn 动态绑定'); else ok('无动态 onclick 赋值');
if (/<img[^>]+src\s*=\s*["']https?:/i.test(html)) bad('存在外链图片'); else ok('无外链图片');
if (/<script[^>]+src=/i.test(html)) bad('存在外链脚本'); else ok('无外链脚本');
if (/@import|cdn\.|unpkg|jsdelivr|googleapis/i.test(html)) bad('存在 CDN 引用'); else ok('无 CDN 引用');
if (/showConfirm\([^)]*function\s*\(/.test(js)) bad('确认弹窗传入了闭包回调');
else ok('确认弹窗用全局 {函数名,参数}，无闭包回调');

var masks = (html.match(/class="mask"/g) || []).length;
var dlgs = (html.match(/class="dlg"/g) || []).length;
if (masks === dlgs && masks > 0) ok(masks + ' 个弹窗结构完整（标题/滚动区/按钮分离）');
else bad('弹窗数量不匹配 mask=' + masks + ' dlg=' + dlgs);

/* ---------------------------------------------------------------- [4] */
head('[4] 功能点');
function need(re, label, hay) { if (re.test(hay || js)) ok(label); else bad('缺少 ' + label); }
need(/maximum-scale=1/, 'viewport 锁定缩放', html);
need(/user-scalable=no/, 'viewport 禁止缩放', html);
need(/viewport-fit=cover/, 'viewport-fit=cover', html);
need(/env\(safe-area-inset-top\)/, '顶部安全区', html);
need(/env\(safe-area-inset-bottom\)/, '底部安全区', html);
need(/touch-action:manipulation/, 'touch-action:manipulation', html);
need(/font-size:16px/, '输入框 16px 防放大', html);
need(/localStorage/, 'localStorage 持久化');
need(/\/chat\/completions/, '调用 /chat/completions');
need(/getReader/, '流式 SSE 读取');
need(/TextDecoder/, 'TextDecoder 流式解码');
need(/Authorization/, 'Authorization 头');
need(/\[DONE\]/, 'SSE [DONE] 终止标记');
need(/fallbackNonStream/, '流式失败自动降级');
need(/nativeFetch/, '原生 nativeFetch 通道');
need(/nativeAbort/, '原生 nativeAbort 通道');
need(/first_mes/, '兼容 SillyTavern first_mes');
need(/不要暴露自己是AI/, '固定人设指令');
need(/apiGetText/, 'apiGetText 封装');

// --- 图片功能 ---
need(/\[\[IMG:/, '[[IMG: ...]] 标记解析');
need(/renderBubbleBody/, 'renderBubbleBody 气泡渲染');
need(/imgReady/, 'imgReady 配置检查');
need(/generateImage/, 'generateImage 生图调用');
need(/images\/generations/, '调用 /images/generations');
need(/compressToDataURL/, 'canvas 压缩图片');
need(/nativeFetchBinary/, '原生二进制下载通道');
need(/evictImages/, '配图配额回收');
need(/IMG_BUDGET/, '图片存储预算');
need(/retryImage/, '配图失败重试');
need(/你只能发送纯文字消息/, '图片关闭时的「不许承诺发图」提示');
need(/你可以给用户发图片/, '图片开启时的发图指令');

// 图片不能出现在导出数据里（几 MB 文本会让 textarea 卡死）
if (/images:\s*\(m\.images \|\| \[\]\)\.map\(function\(im\)\{\s*return im;\s*\}\)/.test(js)) {
  bad('导出时包含了图片 base64 数据');
} else {
  ok('导出只含配图描述，不含 base64 数据');
}

// 渲染路径必须用 innerHTML，textContent 会把图片抹掉
if (/bub\.textContent\s*=/.test(stripped)) bad('updateLastBubble 仍用 textContent（会抹掉图片）');
else ok('气泡渲染走 innerHTML，图片不会被抹掉');

var constDef = js.match(/var\s+STORE_KEY\s*=\s*'([^']+)'/);
if (constDef) ok('存储键统一常量 ' + constDef[1] + '（' + (js.match(/STORE_KEY/g) || []).length + ' 处引用）');
else wrn('未找到 STORE_KEY 常量');

/* ---------------------------------------------------------------- [5] */
head('[5] ObjC 壳');
var shellDir = P('ios-shell', 'AIChat');
var mustExist = [
  'main.m', 'AppDelegate.h', 'AppDelegate.m', 'ViewController.h', 'ViewController.m',
  'Info.plist', 'project.yml',
  'Resources/index.html', 'Resources/AppIcon60x60@2x.png', 'Resources/AppIcon60x60@3x.png'
];
mustExist.forEach(function (f) {
  if (exists(path.join(shellDir, f))) ok('存在 ' + f); else bad('缺少 ' + f);
});

['main.m', 'AppDelegate.m', 'ViewController.m'].forEach(function (f) {
  var p = path.join(shellDir, f);
  if (!exists(p)) return;
  var src = read(p);

  [['{', '}'], ['(', ')'], ['[', ']']].forEach(function (pair) {
    var r = countBalanced(src, pair[0], pair[1]);
    if (r.depth !== 0 || r.min < 0) bad(f + ' 括号不平衡 ' + pair[0] + pair[1] + ' (depth=' + r.depth + ')');
  });

  var ni = (src.match(/@interface/g) || []).length;
  var no = (src.match(/@implementation/g) || []).length;
  var ne = (src.match(/@end/g) || []).length;
  if (ne !== ni + no) bad(f + ' @interface/@implementation 与 @end 数量不匹配 (' + ni + '+' + no + ' vs ' + ne + ')');
  else ok(f + ' 括号平衡，@end 数量正确');
});

var vc = read(path.join(shellDir, 'ViewController.m'));
[
  [/addScriptMessageHandler:.*name:@"nativeFetch"/, '注册 nativeFetch handler'],
  [/addScriptMessageHandler:.*name:@"nativeAbort"/, '注册 nativeAbort handler'],
  [/contentInsetAdjustmentBehavior\s*=\s*[\s\S]{0,60}Never/, 'contentInsetAdjustmentBehavior = Never'],
  [/pinchGestureRecognizer\.enabled\s*=\s*NO/, '禁用双指缩放'],
  [/loadFileURL:.*allowingReadAccessToURL:/, 'loadFileURL 加载本地 html'],
  [/didReceiveData:/, 'NSURLSession 流式接收'],
  [/drainUTF8/, 'UTF-8 边界安全解码'],
  [/evaluateJavaScript/, '回传 JS'],
  [/runOpenPanelWithParameters/, '支持 input[type=file]'],
  [/binaryReqs/, '二进制请求标记集合'],
  [/base64EncodedStringWithOptions/, '图片字节 base64 回传']
].forEach(function (p) {
  if (p[0].test(vc)) ok(p[1]); else bad('壳缺少：' + p[1]);
});

// 二进制数据绝不能走 UTF-8 逐字节解码，否则图片会烂掉
if (/binaryReqs containsObject:reqId\]\) return;/.test(vc)) {
  ok('二进制路径在 drainUTF8 之前就分流了');
} else {
  bad('二进制数据可能被 drainUTF8 破坏 —— 图片会解码失败');
}

// 明确禁止的私有 KVC（必须先剥掉注释，否则注释里提到这些名字也会误报）
var vcCode = vc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
if (/allowFileAccessFromFileURLs/.test(vcCode)) bad('壳里用了私有 KVC allowFileAccessFromFileURLs');
else ok('未使用私有 KVC allowFileAccessFromFileURLs');

if (/setValue:[\s\S]{0,40}forKey:[\s\S]{0,40}WKPreferences/.test(vcCode)) bad('对 WKPreferences 用了 KVC');
else ok('未对 WKPreferences 使用 KVC');

var ad = read(path.join(shellDir, 'AppDelegate.m'));
if (/NSSetUncaughtExceptionHandler/.test(ad)) ok('已装未捕获异常处理器'); else bad('缺未捕获异常处理器');
if (/AIHandleSignal/.test(ad) && /signal\(SIGABRT/.test(ad)) ok('已装信号处理器'); else bad('缺信号处理器');
if (/crash\.log/.test(ad)) ok('崩溃日志写入 Documents/crash.log'); else bad('缺崩溃日志写入');
if (/AIRotateCrashLog/.test(ad)) ok('启动时轮转 crash.log -> crash.prev.log'); else wrn('未轮转崩溃日志');

/* ---------------------------------------------------------------- [6] */
head('[6] Info.plist');
var plistSrc = read(path.join(shellDir, 'Info.plist'));
try {
  // Node 没有内置 plist 解析器，做关键键的存在性 + XML 结构检查
  var openTags = (plistSrc.match(/<dict>/g) || []).length;
  var closeTags = (plistSrc.match(/<\/dict>/g) || []).length;
  if (openTags !== closeTags) bad('<dict> 标签不匹配 ' + openTags + ' vs ' + closeTags);
  else ok('<dict> 标签配对正确（' + openTags + ' 对）');

  if (/^<\?xml/.test(plistSrc.trim())) ok('XML 声明存在'); else bad('缺 XML 声明');
  if (/<!DOCTYPE plist/.test(plistSrc)) ok('DOCTYPE 存在'); else bad('缺 DOCTYPE');

  // 用 indexOf 而不是正则：plist 里字符串值是包在 <string> 里的，
  // 裸值（<dict/> <true/>）才是紧跟在 <key> 后面。用正则会误判。
  [
    ['CFBundleExecutable', '$(EXECUTABLE_NAME)'],
    ['CFBundleIdentifier', '$(PRODUCT_BUNDLE_IDENTIFIER)'],
    ['LSMinimumSystemVersion', '12.0'],
    ['MinimumOSVersion', '12.0'],
    ['UILaunchScreen', '<dict/>'],
    ['UIFileSharingEnabled', '<true/>'],
    ['LSSupportsOpeningDocumentsInPlace', '<true/>'],
    ['NSAllowsArbitraryLoads', '<true/>'],
    ['UIDeviceFamily', '<integer>1</integer>'],
    ['CFBundleIconFiles', 'AppIcon60x60']
  ].forEach(function (c) {
    var keyTag = '<key>' + c[0] + '</key>';
    var at = plistSrc.indexOf(keyTag);
    if (at < 0) { bad(c[0] + ' 缺失'); return; }
    // 在 key 之后的一小段窗口里找期望值
    var seg = plistSrc.substr(at + keyTag.length, 140);
    if (seg.indexOf(c[1]) >= 0) ok(c[0] + ' = ' + c[1]);
    else bad(c[0] + ' 的值不对（期望包含 ' + c[1] + '）');
  });
} catch (e) { bad('Info.plist 解析异常: ' + e.message); }

/* ---------------------------------------------------------------- [7] */
head('[7] project.yml');
var projSrc = read(path.join(shellDir, 'project.yml'));
[
  [/deploymentTarget:\s*"12\.0"/, 'deploymentTarget 12.0'],
  [/ARCHS:\s*"arm64"/, 'ARCHS arm64'],
  [/INFOPLIST_FILE:\s*Info\.plist/, 'INFOPLIST_FILE 指向 Info.plist'],
  [/GENERATE_INFOPLIST_FILE:\s*"NO"/, 'GENERATE_INFOPLIST_FILE=NO（不覆盖手写 plist）'],
  [/CODE_SIGNING_REQUIRED:\s*"NO"/, 'CODE_SIGNING_REQUIRED=NO'],
  [/CODE_SIGNING_ALLOWED:\s*"NO"/, 'CODE_SIGNING_ALLOWED=NO'],
  [/TARGETED_DEVICE_FAMILY:\s*"1"/, 'TARGETED_DEVICE_FAMILY=1（仅 iPhone）'],
  [/sdk:\s*WebKit\.framework/, '链接 WebKit'],
  [/sdk:\s*UIKit\.framework/, '链接 UIKit'],
  [/^schemes:/m, '定义了 schemes']
].forEach(function (p) {
  if (p[0].test(projSrc)) ok(p[1]); else bad('project.yml 缺少：' + p[1]);
});

// 未加引号的 YES/NO 会被 YAML 1.1 解析成布尔值，写进 pbxproj 变成非标准的 = false
var unquoted = projSrc.match(/^\s+[A-Z_]+:\s*(YES|NO)\s*$/gm);
if (unquoted) bad('存在未加引号的 YES/NO（会被解析成布尔）: ' + unquoted.join(', '));
else ok('所有 YES/NO 均已加引号');

/* ---------------------------------------------------------------- [8] */
head('[8] GitHub Actions 工作流');
var wfPath = P('.github', 'workflows', 'build-ipa.yml');
if (!exists(wfPath)) { bad('工作流文件不存在'); }
else {
  var wf = read(wfPath);
  [
    [/runs-on:\s*macos-15/, 'runs-on: macos-15（Xcode 16）'],
    [/PIPESTATUS\[0\]/, '用真实退出码判断编译结果（防空壳包）'],
    [/test -f "\$APP\/\$\{APP_NAME\}"|test -f "\$APP\/\$APP_NAME"/, '校验主程序存在'],
    [/xcodegen generate/, '调用 xcodegen'],
    [/cp app\.html .*Resources\/index\.html/, '同步 app.html -> Resources/index.html'],
    [/cp Resources\/index\.html "\$APP\/index\.html"/, '把 index.html 拷进 .app'],
    [/cp Resources\/index\.html "\$APP\/www\/index\.html"/, '拷贝 www/index.html'],
    [/cp Resources\/AppIcon60x60@2x\.png/, '拷贝 2x 图标'],
    [/cp Resources\/AppIcon60x60@3x\.png/, '拷贝 3x 图标'],
    [/codesign --force --sign -/, 'ad-hoc 伪签名'],
    [/zip -qry "\$\{GITHUB_WORKSPACE\}\/\$\{APP_NAME\}\.ipa" Payload/, 'zip 打包路径正确'],
    [/unzip -l/, '校验 IPA 内容'],
    [/if:\s*failure\(\)/, '失败时输出日志'],
    [/actions\/upload-artifact@v4/, '上传 artifact']
  ].forEach(function (p) {
    if (p[0].test(wf)) ok(p[1]); else bad('工作流缺少：' + p[1]);
  });

  // zip 输出路径 vs upload path 必须一致
  var zipOut = /zip -qry "\$\{GITHUB_WORKSPACE\}\/\$\{APP_NAME\}\.ipa"/.test(wf);
  var upPath = /path:\s*\$\{\{\s*env\.APP_NAME\s*\}\}\.ipa/.test(wf);
  if (zipOut && upPath) ok('zip 输出路径与 upload path 一致');
  else bad('zip 输出路径与 upload path 不一致，会报「找不到文件」');

  // 不能把 ipa 压在 _payload 里面
  if (/zip[^\n]*_payload[^\n]*\.ipa/.test(wf)) bad('ipa 被压进了 _payload 内部');
  else ok('ipa 输出在仓库根目录，不在 _payload 内');
}

/* ---------------------------------------------------------------- [9] */
head('[9] 图标');
[['AppIcon60x60@2x.png', 120], ['AppIcon60x60@3x.png', 180]].forEach(function (t) {
  var p = path.join(shellDir, 'Resources', t[0]);
  if (!exists(p)) { bad(t[0] + ' 不存在'); return; }
  var buf = fs.readFileSync(p);
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') { bad(t[0] + ' 不是 PNG'); return; }
  var w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  var depth = buf[24], ctype = buf[25];
  if (w !== t[1] || h !== t[1]) bad(t[0] + ' 尺寸错误 ' + w + 'x' + h + '，应为 ' + t[1]);
  else if (ctype !== 2) bad(t[0] + ' 颜色类型 ' + ctype + '（应为 2=RGB，无 alpha 通道）');
  else if (depth !== 8) bad(t[0] + ' 位深 ' + depth + '（应为 8）');
  else ok(t[0] + ' ' + w + 'x' + h + ' 8-bit RGB 无透明通道');
});

/* ---------------------------------------------------------------- [10] */
head('[10] 资源同步');
var resHtml = path.join(shellDir, 'Resources', 'index.html');
if (exists(resHtml)) {
  if (read(resHtml) === read(htmlPath)) ok('Resources/index.html 与 app.html 完全一致');
  else bad('Resources/index.html 与 app.html 不一致 —— 重新 cp 一次');
} else bad('Resources/index.html 不存在');

/* ---------------------------------------------------------------- [11] */
head('[11] 气泡渲染回归测试');
var testFile = P('ios-shell', 'test-render.js');
if (!exists(testFile)) {
  wrn('test-render.js 不存在，跳过');
} else {
  try {
    var out = require('child_process').execFileSync(
      process.execPath, [testFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    var passed = out.match(/(\d+) 项通过/);
    var line = out.split('\n').filter(function (l) { return l.indexOf('结果:') >= 0; })[0] || '';
    if (/\d+ 项失败/.test(line) && !/ 0 项失败/.test(line)) {
      bad('渲染测试有失败项：' + line.trim());
      console.log(out);
    } else {
      ok('渲染测试全部通过（' + (passed ? passed[1] : '?') + ' 项）');
    }
  } catch (e) {
    bad('渲染测试失败');
    var o = (e.stdout || '') + (e.stderr || '');
    if (o) console.log(o);
  }
}

/* ---------------------------------------------------------------- 汇总 */
console.log('\n' + '='.repeat(52));
console.log('  体积: app.html = ' + (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1) + ' KB');
console.log('  结果: ' + fail + ' 个错误, ' + warn + ' 个警告');
console.log('='.repeat(52) + '\n');

process.exit(fail ? 1 : 0);
