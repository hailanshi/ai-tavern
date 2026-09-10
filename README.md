# AI 酒馆 · 单文件 HTML + WKWebView 壳

一个离线可跑的中文 AI 角色扮演聊天工具（SillyTavern 精简版），
业务 100% 写在单个 `app.html` 里，外面套一个只做容器的 iOS 壳，
用 GitHub 的免费 macOS 服务器编译成 TrollStore 可装的 `.ipa`。

**不需要 Mac，不需要 Apple 开发者账号。**

---

## 目录结构

```
.
├─ app.html                             ← 唯一业务源文件（改这个）
├─ README.md
├─ .github/workflows/build-ipa.yml      ← 云端编译流水线
└─ ios-shell/
   ├─ check.js                          ← 交付前自检
   ├─ make_icons.py                     ← 生成图标（零依赖）
   └─ AIChat/
      ├─ main.m
      ├─ AppDelegate.h / .m             ← 窗口 + 崩溃捕获
      ├─ ViewController.h / .m          ← WKWebView 容器 + 原生取数通道
      ├─ Info.plist
      ├─ project.yml                    ← xcodegen 工程描述
      └─ Resources/
         ├─ index.html                  ← app.html 的副本（打包用）
         ├─ AppIcon60x60@2x.png         ← 120×120
         └─ AppIcon60x60@3x.png         ← 180×180
```

> **改代码只改 `app.html`。** 改完必须同步一份到 `Resources/index.html`：
> ```bash
> cp app.html ios-shell/AIChat/Resources/index.html
> ```
> 云端流水线也会自动做这一步，所以其实你只推 `app.html` 就够了。

---

## 一、先在电脑上跑跑看

双击 `app.html` 用浏览器打开即可，UI 完全能用。

但**浏览器里调 API 大概率会被 CORS 拦**（接口不返回 `Access-Control-Allow-Origin`）。
这不是 bug，正是壳里那条原生通道要解决的问题。所以：

- 只想看界面 → 浏览器直接开
- 想真正聊天 → 走下面的打包流程，装到手机上

---

## 二、傻瓜版打包教程

### 第 1 步：注册 GitHub

去 <https://github.com/signup> 注册一个账号（免费）。已有就跳过。

### 第 2 步：建仓库

1. 右上角 **+** → **New repository**
2. **Repository name** 随便填，比如 `aichat`
3. 选 **Public**（公开仓库的 Actions 分钟数完全免费；私有仓库每月只有 2000 分钟）
4. **不要**勾 "Add a README file"
5. 点 **Create repository**

### 第 3 步：把文件传上去

在新建好的仓库页面点 **uploading an existing file**，然后把**这些文件和文件夹整个拖进去**：

```
app.html
README.md
.github/            ← 整个文件夹（里面有 workflows/build-ipa.yml）
ios-shell/          ← 整个文件夹
```

> `.github` 是隐藏文件夹，拖拽时确认它真的进去了。
> 如果拖不进去，就先把其他文件传完，再单独建文件：
> 仓库页 **Add file → Create new file**，文件名输入
> `.github/workflows/build-ipa.yml`，把内容粘进去。

填个提交信息，点 **Commit changes**。

### 第 4 步：等 Actions 变绿

1. 点仓库顶部的 **Actions** 标签
2. 左边选 **Build IPA**
3. 会看到一条正在跑的记录（黄点）→ 等 3~6 分钟
4. 变成 **绿色勾** 就成功了；**红色叉** 说明失败，点进去看日志

### 第 5 步：下载 ipa

1. 点进那次绿色的构建
2. 拉到底部 **Artifacts** 区域
3. 下载 **AIChat-ipa**（是个 zip）
4. 解压得到 `AIChat.ipa`

### 第 6 步：装到 iPhone

1. 把 `AIChat.ipa` 传到手机上（AirDrop / 微信文件传输 / iCloud 都行）
2. 用 **TrollStore** 打开这个 ipa → **Install**
3. 回到桌面，图标出现，开用

### 第 7 步：填 API

打开 App → 右上角 **设置**：

| 字段 | 填什么 |
|---|---|
| API 地址 | `https://api.deepseek.com/v1` |
| API Key | 你的 key（[DeepSeek 开放平台](https://platform.deepseek.com)申请） |
| 模型名 | `deepseek-chat` |
| 温度 | `0.8 ~ 1.2` 之间随便调 |

点 **测试 API 连接**，看到 ✅ 就成了。回首页选角色开聊。

> 任何 OpenAI 兼容接口都行，比如 Kimi、通义、本地 Ollama、one-api 中转等，
> 只要把地址和模型名换掉即可。

---

## 三、改点什么

### 改 App 名字

| 想改的地方 | 改哪个文件 |
|---|---|
| 桌面图标下的名字 | `ios-shell/AIChat/Info.plist` → `CFBundleDisplayName` |
| 图标 | 改 `ios-shell/make_icons.py` 里的配色，然后 `python ios-shell/make_icons.py` |
| 内置角色 | `app.html` 里搜 `function demoChars()` |

### 改 Bundle ID

`ios-shell/AIChat/project.yml` → `PRODUCT_BUNDLE_IDENTIFIER`。
换一个独一无二的值，避免和别人的冲突。

### 改完别忘了

```bash
cp app.html ios-shell/AIChat/Resources/index.html   # 同步业务文件
node ios-shell/check.js                             # 自检，必须 0 错误
```

然后 `git push`，Actions 会自动重新编译。

---

## 四、本地自检

没有 Mac 也能查掉大部分问题：

```bash
node ios-shell/check.js
```

会检查 10 组东西：JS 语法与旧 iOS 兼容性、`window` 挂载完整性、
CSS/DOM 铁律、功能点、ObjC 壳结构、Info.plist、project.yml、
Actions 工作流、图标规格、资源同步。

**推之前务必跑一遍**，能省掉好几轮云端编译。

---

## 五、踩过的坑（都已在代码里规避）

| 坑 | 表现 | 规避方式 |
|---|---|---|
| macos-14 的 Xcode 15.4 读不了新格式工程 | `future Xcode project file format (77)` | 固定 `runs-on: macos-15` |
| 不看退出码 | 编译失败照样"成功"，产出空壳 ipa，**装上必闪退** | `exit ${PIPESTATUS[0]}` + `test -f $APP/AIChat` 双重校验 |
| 忘了拷 index.html | 装上是白屏 | 打包步骤先 `cp` 再 `codesign`（顺序不能反） |
| 忘了拷图标 | 桌面图标是白块 | 同上，`cp` 两个 PNG |
| zip 路径不对 | `upload-artifact` 报"找不到文件" | zip 输出到 `$GITHUB_WORKSPACE`，upload path 与之对齐，自检脚本会校验一致性 |
| 动态 `el.onclick = fn` | WKWebView 里按钮看得见点不动 | 全部改成内联 `onclick="window.xxx()"`，函数显式挂 `window` |
| 弹窗用闭包回调 | 点"确定"没反应 | 回调存全局 `__confirmCb = {fn, arg}`，统一走 `doConfirmOK()` |
| 私有 KVC `allowFileAccessFromFileURLs` | 某些 iOS 直接抛异常闪退 | 完全不用，改用 `nativeFetch` 原生通道 |
| CSS `inset` 简写 | 旧 iOS 不认，弹窗错位 | 全部写 `top/left/right/bottom` |
| YAML 里 `NO` 没加引号 | 被解析成布尔，pbxproj 里写成 `= false` | 全部写成 `"NO"` / `"YES"`，自检脚本会查 |
| NSURLSession 分片切断多字节字符 | 中文/emoji 变乱码 | `drainUTF8:` 逐字节回退找可解码边界 |

---

## 六、已知限制（如实说明）

1. **本机没有产出 `.ipa`。** 当前环境是 Windows，没有 iOS 工具链，
   无法在这里编译。`.ipa` 必须由 GitHub Actions 的 macOS 机器产出——
   也就是走上面第二节的流程。我**没有**伪造一个假装能用的 ipa。

2. **iOS 12 / 13 上可能上下留黑边。** `UILaunchScreen` 空字典是 iOS 14+ 的机制。
   不过 TrollStore 本身要求 iOS 14+，所以实际不会遇到。

3. **导出聊天记录的「下载」按钮在 App 内可能无效。**
   WKWebView 对 `<a download>` 支持不完整。已经同时提供**复制**按钮作为可靠路径，
   导出弹窗里点「复制」再粘到备忘录即可。

4. **上下文只带最近 50 条消息**（见 `app.html` 的 `buildMessages`）。
   再早的仍存在本地、界面上也看得到，只是不再发给模型，避免超出上下文窗口。
   嫌少可以改那个 `50`。

5. **API Key 明文存在 localStorage。** 只在本机，不会上传到任何第三方
   （只会随请求发给你自己填的那个 API 地址）。但知道手机密码的人能看到。
   别在别人的设备上填自己的 key。

6. **流式输出在壳里走原生通道，不是 fetch。** 因为 `file://` 页面的 fetch 会被 CORS 拦。
   壳只负责把响应文本搬回来，SSE 的解析、拼装、错误处理全在 JS 里。

---

## 七、它是怎么工作的

```
┌─────────────────────────────────────────┐
│  WKWebView                              │
│  ┌───────────────────────────────────┐  │
│  │  index.html（全部业务逻辑）        │  │
│  │   · 角色管理 / 聊天 / 设置         │  │
│  │   · localStorage 持久化            │  │
│  │   · SSE 解析、提示词拼装           │  │
│  └────────────┬──────────────────────┘  │
│               │ postMessage              │
│               │ {id,url,method,headers,  │
│               │  body,stream}            │
│  ┌────────────▼──────────────────────┐  │
│  │  ViewController.m（纯搬运）        │  │
│  │   NSURLSession → 分片回传文本       │  │
│  └────────────┬──────────────────────┘  │
└───────────────┼─────────────────────────┘
                │ HTTPS
                ▼
        api.deepseek.com/v1/chat/completions
```

壳把每个数据分片通过 `evaluateJavaScript` 调 `window.__nativeChunk(id, text)` 回传，
JS 侧做 SSE 行缓冲（`makeSSEParser`）后增量渲染。

浏览器环境下没有 `window.webkit.messageHandlers.nativeFetch`，
`hasNative()` 返回 false，自动回退到标准 `fetch` + `ReadableStream`。
流式失败且一个字都没收到时，再自动降级为非流式请求。
