//
//  ViewController.m — AIChat
//
//  壳的职责边界（严格遵守）：
//    1. 把 Resources/index.html 加载进 WKWebView
//    2. 提供 nativeFetch / nativeAbort 原生通道，替 JS 发网络请求
//  —— 除此之外不写任何业务逻辑。所有业务都在 index.html 里。
//
//  为什么需要原生通道：
//    页面通过 file:// 加载，JS 里的 fetch 打外部 API 会被 CORS 拦
//    （接口不带 Access-Control-Allow-Origin，或一带 Origin 就 403）。
//    原生通道只负责「把响应文本搬回来」，不做任何解析。
//

#import "ViewController.h"

#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>

#pragma mark - 弱引用代理（避免 WKUserContentController 强引用 self 造成循环）

@interface AIWeakScriptHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) id<WKScriptMessageHandler> target;
+ (instancetype)proxyWithTarget:(id<WKScriptMessageHandler>)target;
@end

@implementation AIWeakScriptHandler

+ (instancetype)proxyWithTarget:(id<WKScriptMessageHandler>)target {
    AIWeakScriptHandler *p = [[AIWeakScriptHandler alloc] init];
    p.target = target;
    return p;
}

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    id<WKScriptMessageHandler> t = self.target;
    if (t) [t userContentController:userContentController didReceiveScriptMessage:message];
}

@end


#pragma mark - ViewController

@interface ViewController () <WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate,
                              NSURLSessionDataDelegate, UIDocumentPickerDelegate>

@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) NSURLSession *session;

// 串行队列：NSURLSession 的代理回调 + 请求的创建/取消都在这里跑。
// buffers / tasks 两个字典只在这条队列上读写，天然没有竞态。
@property (nonatomic, strong) NSOperationQueue *netQueue;

// reqId -> NSMutableData（未解码完的字节缓冲）
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSMutableData *> *buffers;
// reqId -> NSURLSessionDataTask
@property (nonatomic, strong) NSMutableDictionary<NSString *, NSURLSessionDataTask *> *tasks;
// 标记哪些请求要原始字节（图片下载）：这些请求跳过 UTF-8 解码，整体 base64 回传
@property (nonatomic, strong) NSMutableSet<NSString *> *binaryReqs;

// <input type="file"> 打开文件选择时的回调，必须恰好调用一次
@property (nonatomic, copy) void (^openPanelCompletion)(NSArray<NSURL *> *urls);

@end


@implementation ViewController

#pragma mark - 生命周期

- (void)viewDidLoad {
    [super viewDidLoad];

    self.view.backgroundColor = [UIColor colorWithRed:0.055 green:0.063 blue:0.075 alpha:1.0];
    self.buffers = [NSMutableDictionary dictionary];
    self.tasks = [NSMutableDictionary dictionary];
    self.binaryReqs = [NSMutableSet set];

    [self setupSession];
    [self setupWebView];
    [self loadLocalHTML];
}

- (BOOL)prefersStatusBarHidden { return NO; }

- (UIStatusBarStyle)preferredStatusBarStyle { return UIStatusBarStyleLightContent; }

- (void)dealloc {
    // 代理是弱引用，这里正常释放
    [self.session invalidateAndCancel];
    [self.webView.configuration.userContentController
        removeScriptMessageHandlerForName:@"nativeFetch"];
    [self.webView.configuration.userContentController
        removeScriptMessageHandlerForName:@"nativeAbort"];
    [self.webView.configuration.userContentController
        removeScriptMessageHandlerForName:@"audioSession"];
}

#pragma mark - 搭建

- (void)setupSession {
    NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
    cfg.timeoutIntervalForRequest = 60.0;
    cfg.timeoutIntervalForResource = 300.0;
    cfg.HTTPMaximumConnectionsPerHost = 4;
    cfg.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    // 不用系统代理设置，避免用户开了代理后请求被劫持到奇怪的地方
    cfg.connectionProxyDictionary = @{};

    self.netQueue = [[NSOperationQueue alloc] init];
    self.netQueue.maxConcurrentOperationCount = 1;   // 串行
    self.netQueue.qualityOfService = NSQualityOfServiceUserInitiated;

    self.session = [NSURLSession sessionWithConfiguration:cfg
                                                 delegate:self
                                            delegateQueue:self.netQueue];
}

- (void)setupWebView {
    WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
    // 不开 allowsInlineMediaPlayback 等无关选项，保持最小化

    // 原生通道：JS -> 原生
    AIWeakScriptHandler *proxy = [AIWeakScriptHandler proxyWithTarget:self];
    [cfg.userContentController addScriptMessageHandler:proxy name:@"nativeFetch"];
    [cfg.userContentController addScriptMessageHandler:proxy name:@"nativeAbort"];
    [cfg.userContentController addScriptMessageHandler:proxy name:@"audioSession"];

    // 关键：不要用私有 KVC 给 WKPreferences 设 allowFileAccessFromFileURLs，
    // 不同 iOS 版本行为不一致，会直接抛异常闪退。用原生通道替代。

    CGRect frame = self.view.bounds;
    self.webView = [[WKWebView alloc] initWithFrame:frame configuration:cfg];
    self.webView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;

    // 与页面背景一致，避免加载瞬间白屏闪烁
    UIColor *bg = self.view.backgroundColor;
    self.webView.backgroundColor = bg;
    self.webView.opaque = NO;
    self.webView.scrollView.backgroundColor = bg;

    // 铁律：关掉自动内边距（安全区由页面 CSS 的 env() 自己处理）
    self.webView.scrollView.contentInsetAdjustmentBehavior =
        UIScrollViewContentInsetAdjustmentNever;
    self.webView.scrollView.bounces = YES;
    self.webView.scrollView.alwaysBounceVertical = NO;

    // 铁律：禁止双指缩放（viewport 的 user-scalable=no 在部分机型不生效）
    self.webView.scrollView.pinchGestureRecognizer.enabled = NO;
    self.webView.scrollView.decelerationRate = UIScrollViewDecelerationRateNormal;

    // 长按菜单：只保留复制，避免选中整页后弹出一堆东西
    self.webView.allowsLinkPreview = NO;

    [self.view addSubview:self.webView];
}

// 多候选路径查找 index.html —— 打包方式不同，落点会不一样
- (NSURL *)locateIndexHTML {
    NSBundle *bundle = [NSBundle mainBundle];
    NSString *res = [bundle resourcePath];

    NSMutableArray<NSString *> *candidates = [NSMutableArray array];
    NSString *p;

    p = [bundle pathForResource:@"index" ofType:@"html"];
    if (p) [candidates addObject:p];

    p = [bundle pathForResource:@"index" ofType:@"html" inDirectory:@"www"];
    if (p) [candidates addObject:p];

    if (res) {
        [candidates addObject:[res stringByAppendingPathComponent:@"index.html"]];
        [candidates addObject:[res stringByAppendingPathComponent:@"www/index.html"]];
    }

    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *path in candidates) {
        if (path && [fm fileExistsAtPath:path]) {
            return [NSURL fileURLWithPath:path];
        }
    }
    return nil;
}

- (void)loadLocalHTML {
    NSURL *url = [self locateIndexHTML];

    if (!url) {
        NSString *msg = @"<meta name='viewport' content='width=device-width,initial-scale=1'>"
                         "<body style='background:#0e1013;color:#ff6b6b;font-family:-apple-system;"
                         "padding:40px;text-align:center;line-height:1.8'>"
                         "<h2>index.html 缺失</h2>"
                         "<p>打包时没有把 Resources/index.html 拷进 .app。</p>"
                         "</body>";
        [self.webView loadHTMLString:msg baseURL:nil];
        return;
    }

    // 允许读取 index.html 所在目录（含 www/ 子目录）
    NSURL *dir = [url URLByDeletingLastPathComponent];
    [self.webView loadFileURL:url allowingReadAccessToURL:dir];
}

#pragma mark - WKNavigationDelegate（仅用于排查）

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation
      withError:(NSError *)error {
    NSLog(@"[AIChat] 预加载失败: %@", error);
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation
      withError:(NSError *)error {
    NSLog(@"[AIChat] 加载失败: %@", error);
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    // WebContent 进程被系统回收（内存压力），重新加载
    NSLog(@"[AIChat] WebContent 进程被回收，重新加载");
    [self loadLocalHTML];
}

#pragma mark - <input type="file"> 支持

- (void)webView:(WKWebView *)webView
    runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
              initiatedByFrame:(WKFrameInfo *)frame
             completionHandler:(void (^)(NSArray<NSURL *> * _Nullable))completionHandler {

    UIAlertController *sheet = [UIAlertController alertControllerWithTitle:@"导入角色卡 JSON"
                                                                  message:nil
                                                           preferredStyle:UIAlertControllerStyleActionSheet];

    __weak typeof(self) weakSelf = self;
    [sheet addAction:[UIAlertAction actionWithTitle:@"取消" style:UIAlertActionStyleCancel
                                           handler:^(UIAlertAction *a) {
        completionHandler(nil);
    }]];

    [sheet addAction:[UIAlertAction actionWithTitle:@"从「文件」选择" style:UIAlertActionStyleDefault
                                           handler:^(UIAlertAction *a) {
        __strong typeof(weakSelf) self2 = weakSelf;
        if (!self2) { completionHandler(nil); return; }

        self2.openPanelCompletion = completionHandler;
        UIDocumentPickerViewController *picker =
            [[UIDocumentPickerViewController alloc]
                initWithDocumentTypes:@[@"public.json", @"public.text", @"public.data"]
                               inMode:UIDocumentPickerModeImport];
        picker.delegate = self2;
        [self2 presentViewController:picker animated:YES completion:nil];
    }]];

    // iPhone-only（UIDeviceFamily=[1]），不需要 popover 适配
    [self presentViewController:sheet animated:YES completion:nil];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller
    didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    void (^cb)(NSArray<NSURL *> *) = self.openPanelCompletion;
    self.openPanelCompletion = nil;      // 取出后再清空
    if (cb) cb(urls.count ? urls : nil);
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
    void (^cb)(NSArray<NSURL *> *) = self.openPanelCompletion;
    self.openPanelCompletion = nil;
    if (cb) cb(nil);
}

#pragma mark - 原生取数通道：JS -> 原生

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {

    if ([message.name isEqualToString:@"audioSession"]) {
        [self handleAudioSession:message.body];
        return;
    }

    if ([message.name isEqualToString:@"nativeAbort"]) {
        id body = message.body;
        NSString *reqId = [body isKindOfClass:[NSDictionary class]]
                          ? [self stringValue:body[@"id"]] : nil;
        if (reqId.length == 0) return;
        // 统一丢到 netQueue，和代理回调串行化
        __weak typeof(self) weakSelf = self;
        [self.netQueue addOperationWithBlock:^{ [weakSelf abortRequest:reqId]; }];
        return;
    }

    if (![message.name isEqualToString:@"nativeFetch"]) return;

    NSDictionary *body = message.body;
    if (![body isKindOfClass:[NSDictionary class]]) return;

    // 整个请求生命周期都放在 netQueue 上，buffers/tasks 只在一条队列里被碰
    __weak typeof(self) weakSelf = self;
    [self.netQueue addOperationWithBlock:^{ [weakSelf startRequestWithBody:body]; }];
}

- (void)startRequestWithBody:(NSDictionary *)body {
    NSString *reqId = [self stringValue:body[@"id"]];
    NSString *urlStr = [self stringValue:body[@"url"]];
    if (reqId.length == 0 || urlStr.length == 0) return;

    NSURL *url = [NSURL URLWithString:urlStr];
    if (!url || !url.scheme) {
        [self sendDone:reqId status:0 error:@"无效的 URL"];
        return;
    }

    NSString *method = [self stringValue:body[@"method"]];
    if (method.length == 0) method = @"GET";

    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
    req.HTTPMethod = method;
    req.cachePolicy = NSURLRequestReloadIgnoringLocalCacheData;

    id timeoutVal = body[@"timeout"];
    req.timeoutInterval = [timeoutVal isKindOfClass:[NSNumber class]]
                          ? MAX(5.0, [timeoutVal doubleValue]) : 60.0;

    id headers = body[@"headers"];
    if ([headers isKindOfClass:[NSDictionary class]]) {
        for (id key in headers) {
            id val = headers[key];
            if ([key isKindOfClass:[NSString class]] && [val isKindOfClass:[NSString class]]) {
                [req setValue:val forHTTPHeaderField:key];
            }
        }
    }

    id bodyStr = body[@"body"];
    if ([bodyStr isKindOfClass:[NSString class]] && [bodyStr length] > 0) {
        req.HTTPBody = [bodyStr dataUsingEncoding:NSUTF8StringEncoding];
    }

    self.buffers[reqId] = [NSMutableData data];
    if ([body[@"binary"] boolValue]) [self.binaryReqs addObject:reqId];

    NSURLSessionDataTask *task = [self.session dataTaskWithRequest:req];
    task.taskDescription = reqId;        // 用它把回调关联回 reqId
    self.tasks[reqId] = task;
    [task resume];
}

/*
 切换 AVAudioSession 类别。
 WKWebView 的媒体播放默认走 Ambient，会被手机侧面的静音开关静音 —— 语音消息显然要能听见。
 所以播放前切到 Playback，播完切回来（NotifyOthersOnDeactivation 让别的 App 的音乐恢复）。
 惰性切换，不做成启动就占用：这个 App 主要以文字为主，不该全程霸占音频通道。
*/
- (void)handleAudioSession:(id)body {
    BOOL on = NO;
    if ([body isKindOfClass:[NSDictionary class]]) {
        on = [body[@"on"] boolValue];
    }

    dispatch_async(dispatch_get_main_queue(), ^{
        AVAudioSession *session = [AVAudioSession sharedInstance];
        NSError *err = nil;
        BOOL ok = YES;

        if (on) {
            ok = [session setCategory:AVAudioSessionCategoryPlayback error:&err];
            if (ok) ok = [session setActive:YES error:&err];
        } else {
            ok = [session setActive:NO
                        withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                              error:&err];
            [session setCategory:AVAudioSessionCategoryAmbient error:NULL];
        }

        if (!ok) {
            NSLog(@"[AIChat] 音频通道切换失败(on=%d): %@", (int)on, err);
        }
    });
}

- (void)abortRequest:(NSString *)reqId {
    NSURLSessionDataTask *task = self.tasks[reqId];
    if (task) [task cancel];
    [self.tasks removeObjectForKey:reqId];
    [self.buffers removeObjectForKey:reqId];
    [self.binaryReqs removeObject:reqId];
}

#pragma mark - NSURLSessionDataDelegate：原生 -> JS

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data {

    NSString *reqId = dataTask.taskDescription;
    if (reqId.length == 0) return;

    NSMutableData *buf = self.buffers[reqId];
    if (!buf) {
        buf = [NSMutableData data];
        self.buffers[reqId] = buf;
    }
    [buf appendData:data];

    // 二进制（图片）：原样攒着，绝不能走 drainUTF8 ——
    // 二进制不是 UTF-8，逐字节回退解码会把数据毁掉
    if ([self.binaryReqs containsObject:reqId]) return;

    NSString *text = [self drainUTF8:buf];
    if (text.length > 0) [self sendChunk:reqId text:text];
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error {

    NSString *reqId = task.taskDescription;
    if (reqId.length == 0) return;

    NSInteger status = 0;
    if ([task.response isKindOfClass:[NSHTTPURLResponse class]]) {
        status = ((NSHTTPURLResponse *)task.response).statusCode;
    }

    // ---- 二进制路径：整体 base64 一次回传，包成 JSON 让 JS 知道 MIME ----
    if ([self.binaryReqs containsObject:reqId]) {
        NSMutableData *bin = self.buffers[reqId];
        [self.buffers removeObjectForKey:reqId];
        [self.binaryReqs removeObject:reqId];
        [self.tasks removeObjectForKey:reqId];

        if (error) {
            if (error.code != NSURLErrorCancelled) {
                NSString *m = error.localizedDescription ?: @"图片下载失败";
                if (status > 0) m = [NSString stringWithFormat:@"HTTP %ld：%@", (long)status, m];
                [self sendDone:reqId status:status error:m];
            } else {
                [self sendDone:reqId status:status error:nil];
            }
            return;
        }

        if (bin.length > 0) {
            NSString *mime = @"image/png";
            if ([task.response isKindOfClass:[NSHTTPURLResponse class]]) {
                id ct = ((NSHTTPURLResponse *)task.response).allHeaderFields[@"Content-Type"];
                if ([ct isKindOfClass:[NSString class]] && [ct length] > 0) {
                    NSRange semi = [ct rangeOfString:@";"];
                    mime = (semi.location == NSNotFound) ? ct : [ct substringToIndex:semi.location];
                }
            }
            NSDictionary *env = @{ @"mime": mime,
                                   @"b64": [bin base64EncodedStringWithOptions:0] };
            NSData *jd = [NSJSONSerialization dataWithJSONObject:env options:0 error:NULL];
            NSString *json = jd ? [[NSString alloc] initWithData:jd encoding:NSUTF8StringEncoding] : nil;
            if (json) [self sendChunk:reqId text:json];
        }
        [self sendDone:reqId status:status error:nil];
        return;
    }

    // ---- 文本路径：冲刷缓冲里剩下的完整字节 ----
    NSMutableData *buf = self.buffers[reqId];
    if (buf.length > 0) {
        NSString *rest = [[NSString alloc] initWithData:buf encoding:NSUTF8StringEncoding];
        if (rest.length > 0) [self sendChunk:reqId text:rest];
        [self.buffers removeObjectForKey:reqId];
    }

    [self.tasks removeObjectForKey:reqId];

    if (error) {
        if (error.code == NSURLErrorCancelled) {
            // 用户主动停止。仍然回一个 done —— 否则 JS 侧的 _ncb 回调表
            // 永远删不掉这条记录，反复「发送 -> 停止」会慢慢泄漏。
            [self sendDone:reqId status:status error:nil];
            return;
        }
        NSString *msg = error.localizedDescription ?: @"网络请求失败";
        if (status > 0) {
            msg = [NSString stringWithFormat:@"HTTP %ld：%@", (long)status, msg];
        }
        [self sendDone:reqId status:status error:msg];
    } else {
        // 注意：HTTP 4xx/5xx 走这里（err=nil, status 有值），
        // 由 JS 侧根据 status 决定怎么处理，壳不判断业务
        [self sendDone:reqId status:status error:nil];
    }
}

#pragma mark - UTF-8 安全解码

/*
 NSURLSession 的 didReceiveData 回调会在任意字节位置切断数据，
 一个多字节 UTF-8 字符（中文 3 字节、emoji 4 字节）很可能被劈成两半。
 直接 initWithData:encoding: 会返回 nil，导致丢字。

 做法：从尾部往前逐字节回退，找到第一个能完整解码的位置。
 UTF-8 单字符最长 4 字节，所以最多只需要回退 4 次；
 找不到就说明尾部是不完整字符，原样留在缓冲里等下一批数据。
*/
- (NSString *)drainUTF8:(NSMutableData *)buf {
    NSUInteger len = buf.length;
    if (len == 0) return @"";

    NSUInteger minLen = (len > 4) ? (len - 4) : 0;

    for (NSUInteger tryLen = len; tryLen > minLen; tryLen--) {
        NSData *sub = [buf subdataWithRange:NSMakeRange(0, tryLen)];
        NSString *s = [[NSString alloc] initWithData:sub encoding:NSUTF8StringEncoding];
        if (s) {
            [buf replaceBytesInRange:NSMakeRange(0, tryLen) withBytes:NULL length:0];
            return s;
        }
    }
    return @"";   // 尾部是不完整的多字节字符，等下一批
}

#pragma mark - 回调进 JS

// 所有 evaluateJavaScript 必须回主线程
- (void)evalJS:(NSString *)js {
    if ([NSThread isMainThread]) {
        [self.webView evaluateJavaScript:js completionHandler:nil];
    } else {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.webView evaluateJavaScript:js completionHandler:nil];
        });
    }
}

// 用 NSJSONSerialization 做转义，避免任何引号/换行/emoji 破坏 JS 字面量
- (NSString *)jsonFragment:(NSString *)s {
    if (s == nil) return @"null";
    NSData *d = [NSJSONSerialization dataWithJSONObject:@[s] options:0 error:NULL];
    if (!d) return @"\"\"";
    NSString *j = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
    if (j.length < 2) return @"\"\"";
    // j 形如 ["..."]，去掉外层方括号，留下合法的 JSON 字符串字面量
    return [j substringWithRange:NSMakeRange(1, j.length - 2)];
}

- (void)sendChunk:(NSString *)reqId text:(NSString *)text {
    NSString *js = [NSString stringWithFormat:@"window.__nativeChunk(%@,%@)",
                    [self jsonFragment:reqId], [self jsonFragment:text]];
    [self evalJS:js];
}

- (void)sendDone:(NSString *)reqId status:(NSInteger)status error:(NSString *)error {
    NSString *js = [NSString stringWithFormat:@"window.__nativeDone(%@,%ld,%@)",
                    [self jsonFragment:reqId], (long)status, [self jsonFragment:error]];
    [self evalJS:js];
}

#pragma mark - 小工具

- (NSString *)stringValue:(id)obj {
    if ([obj isKindOfClass:[NSString class]]) return obj;
    if ([obj isKindOfClass:[NSNumber class]]) return [obj stringValue];
    return nil;
}

@end
