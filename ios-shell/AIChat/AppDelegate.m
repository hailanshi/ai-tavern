//
//  AppDelegate.m — AIChat
//
//  除了常规的 window 搭建，这里还负责尽早安装崩溃捕获。
//  放在 AppDelegate（而不是 ViewController）是因为它执行得更早，
//  ViewController 初始化阶段的崩溃也能被记录下来。
//

#import "AppDelegate.h"
#import "ViewController.h"

#import <fcntl.h>
#import <unistd.h>
#import <signal.h>
#import <string.h>
#import <stdio.h>
#import <time.h>

#pragma mark - 崩溃日志

// Documents 目录（Info.plist 开了 UIFileSharingEnabled，手机「文件」App 可见）
static NSString *AICrashLogPath(void) {
    NSArray *dirs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    NSString *dir = dirs.count > 0 ? dirs[0] : NSTemporaryDirectory();
    return [dir stringByAppendingPathComponent:@"crash.log"];
}

// 只使用 open/write/close —— 这几个是 async-signal-safe 的，
// 可以在信号处理器里安全调用（NSString/NSData 不行）。
static void AIAppendCrash(const char *msg) {
    if (msg == NULL) return;

    NSString *path = AICrashLogPath();
    const char *cpath = [path fileSystemRepresentation];
    if (cpath == NULL) return;

    int fd = open(cpath, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0) return;

    char stamp[64];
    time_t t = time(NULL);
    struct tm tmv;
    localtime_r(&t, &tmv);
    strftime(stamp, sizeof(stamp), "[%Y-%m-%d %H:%M:%S] ", &tmv);

    ssize_t ignored;
    ignored = write(fd, stamp, strlen(stamp));
    ignored = write(fd, msg, strlen(msg));
    ignored = write(fd, "\n", 1);
    (void)ignored;

    close(fd);
}

static void AIHandleException(NSException *e) {
    NSString *s = [NSString stringWithFormat:@"=== NSException ===\n%@\n%@\n%@\n",
                   e.name ?: @"(nil)",
                   e.reason ?: @"(nil)",
                   [[e callStackSymbols] componentsJoinedByString:@"\n"]];
    AIAppendCrash([s UTF8String]);
}

static void AIHandleSignal(int sig) {
    const char *name = "UNKNOWN";
    switch (sig) {
        case SIGABRT: name = "SIGABRT"; break;
        case SIGSEGV: name = "SIGSEGV"; break;
        case SIGBUS:  name = "SIGBUS";  break;
        case SIGILL:  name = "SIGILL";  break;
        case SIGFPE:  name = "SIGFPE";  break;
        case SIGPIPE: name = "SIGPIPE"; break;
        case SIGTRAP: name = "SIGTRAP"; break;
        default: break;
    }
    char buf[160];
    snprintf(buf, sizeof(buf), "=== Signal %s (%d) ===", name, sig);
    AIAppendCrash(buf);

    // 恢复默认处理并重新抛出，保持系统的崩溃行为（便于 Xcode 调试）
    signal(sig, SIG_DFL);
    raise(sig);
}

static void AIInstallCrashHandlers(void) {
    NSSetUncaughtExceptionHandler(&AIHandleException);
    signal(SIGABRT, AIHandleSignal);
    signal(SIGSEGV, AIHandleSignal);
    signal(SIGBUS,  AIHandleSignal);
    signal(SIGILL,  AIHandleSignal);
    signal(SIGFPE,  AIHandleSignal);
    signal(SIGPIPE, AIHandleSignal);
    signal(SIGTRAP, AIHandleSignal);
}

// 上次运行留下的日志转存为 crash.prev.log，这样「文件」App 里一眼能看出是哪次崩的
static void AIRotateCrashLog(void) {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *cur = AICrashLogPath();
    if (![fm fileExistsAtPath:cur]) return;

    NSArray *dirs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    NSString *dir = dirs.count > 0 ? dirs[0] : NSTemporaryDirectory();
    NSString *prev = [dir stringByAppendingPathComponent:@"crash.prev.log"];

    [fm removeItemAtPath:prev error:NULL];
    [fm moveItemAtPath:cur toPath:prev error:NULL];
}

#pragma mark - AppDelegate

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {

    AIInstallCrashHandlers();
    AIRotateCrashLog();

    self.window = [[UIWindow alloc] initWithFrame:[[UIScreen mainScreen] bounds]];

    ViewController *vc = [[ViewController alloc] init];
    self.window.rootViewController = vc;

    if (@available(iOS 13.0, *)) {
        self.window.backgroundColor = [UIColor blackColor];
    }

    [self.window makeKeyAndVisible];
    return YES;
}

- (void)applicationDidEnterBackground:(UIApplication *)application {
    // 占位：本 App 无后台任务
}

- (void)applicationWillTerminate:(UIApplication *)application {
    // 占位
}

@end
