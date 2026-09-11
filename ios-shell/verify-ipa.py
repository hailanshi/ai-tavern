#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
校验打出来的 .ipa 是不是真能装。

不只看「文件在不在」，而是真的解析 Mach-O：
  - CPU 架构必须是 arm64
  - 必须是 MH_EXECUTE（可执行文件），不是空壳
  - LC_ENCRYPTION_INFO_64 的 cryptid 必须是 0（TrollStore 要未加密）
  - Info.plist 里的 CFBundleExecutable 要和主程序文件名对得上

用法: python ios-shell/verify-ipa.py <path-to.ipa>
"""

import json
import os
import plistlib
import struct
import sys
import zipfile

MH_MAGIC_64 = 0xFEEDFACF
MH_EXECUTE = 0x2
CPU_TYPE_ARM64 = 0x0100000C
LC_ENCRYPTION_INFO = 0x21
LC_ENCRYPTION_INFO_64 = 0x2C
LC_LOAD_DYLIB = 0xC

fails = []
warns = []


def ok(m):
    print("  [OK]   " + m)


def bad(m):
    print("  [FAIL] " + m)
    fails.append(m)


def wrn(m):
    print("  [WARN] " + m)
    warns.append(m)


def parse_macho(data):
    """返回 dict: magic/cpu/type/ncmds/cryptid"""
    if len(data) < 32:
        return None

    magic = struct.unpack("<I", data[0:4])[0]

    if magic == 0xCAFEBABE:
        return {"fat": True}
    if magic != MH_MAGIC_64:
        return None

    cpu, _sub, ftype, ncmds, _sizeofcmds, _flags, _res = struct.unpack(
        "<iiIIIII", data[4:32]
    )

    info = {
        "fat": False,
        "cpu": cpu,
        "type": ftype,
        "ncmds": ncmds,
        "cryptid": None,
        "dylibs": [],
    }

    off = 32
    for _ in range(ncmds):
        if off + 8 > len(data):
            break
        cmd, cmdsize = struct.unpack("<II", data[off:off + 8])
        if cmdsize < 8:
            break

        if cmd in (LC_ENCRYPTION_INFO, LC_ENCRYPTION_INFO_64):
            # struct: cmd, cmdsize, cryptoff, cryptsize, cryptid
            if off + 20 <= len(data):
                _c, _s, _coff, _csize, cryptid = struct.unpack(
                    "<IIIII", data[off:off + 20]
                )
                info["cryptid"] = cryptid

        elif cmd == LC_LOAD_DYLIB:
            # struct: cmd, cmdsize, name_offset, timestamp, cur_ver, compat_ver
            if off + 12 <= len(data):
                name_off = struct.unpack("<I", data[off + 8:off + 12])[0]
                start = off + name_off
                end = data.find(b"\x00", start, off + cmdsize)
                if 0 <= start < end:
                    info["dylibs"].append(data[start:end].decode("utf-8", "replace"))

        off += cmdsize

    return info


def main():
    if len(sys.argv) < 2:
        print("用法: python ios-shell/verify-ipa.py <path-to.ipa>")
        return 2

    ipa = sys.argv[1]
    if not os.path.isfile(ipa):
        print("找不到文件: " + ipa)
        return 2

    size_kb = os.path.getsize(ipa) / 1024.0
    print("\n=== 校验 " + os.path.basename(ipa) + " (" + ("%.1f" % size_kb) + " KB) ===\n")

    zf = zipfile.ZipFile(ipa)
    names = zf.namelist()

    # --- 1. 顶层结构必须是 Payload/ ---
    print("[1] 包结构")
    if any(n.startswith("Payload/") for n in names):
        ok("存在 Payload/ 目录")
    else:
        bad("没有 Payload/ 目录，TrollStore 不认")

    top = set(n.split("/")[0] for n in names)
    if top == {"Payload"}:
        ok("压缩包第一层只有 Payload/（路径正确）")
    else:
        wrn("压缩包第一层还有: " + ", ".join(sorted(top - {"Payload"})))

    # 从内部文件路径反推 .app 目录，而不是依赖 zip 里的目录条目
    # （zip 不保证为每一层目录都写条目）
    apps = set()
    for n in names:
        if not n.startswith("Payload/"):
            continue
        rest = n[len("Payload/"):]
        idx = rest.find(".app/")
        if idx >= 0:
            # rest[:idx+5] 已经包含结尾的 "/"，不要再补
            apps.add("Payload/" + rest[:idx + 5])
    apps = sorted(apps)

    if len(apps) == 1:
        ok(".app 唯一: " + apps[0])
    elif not apps:
        bad("Payload/ 下没有 .app")
        print("       包内实际条目（前 15 条）:")
        for n in names[:15]:
            print("         " + n)
    else:
        bad("Payload/ 下有多个 .app: " + str(apps))

    if fails:
        print("\n包结构就不对，后面不用查了")
        return 1

    appdir = apps[0]

    # --- 2. 主程序 ---
    print("\n[2] 主程序")
    # 从 Info.plist 读 CFBundleExecutable，而不是猜
    plist_path = appdir + "Info.plist"
    if plist_path not in names:
        bad("找不到 " + plist_path)
        return 1

    pl = plistlib.loads(zf.read(plist_path))
    exe_name = pl.get("CFBundleExecutable", "")
    if not exe_name:
        bad("Info.plist 里没有 CFBundleExecutable")
        return 1
    ok("CFBundleExecutable = " + exe_name)

    exe_path = appdir + exe_name
    if exe_path not in names:
        bad("主程序文件缺失: " + exe_path + "  —— 这是空壳包，装上必闪退")
        return 1

    exe_data = zf.read(exe_path)
    ok("主程序存在，%.1f KB" % (len(exe_data) / 1024.0))

    info = parse_macho(exe_data)
    if info is None:
        bad("主程序不是合法的 64 位 Mach-O")
    elif info.get("fat"):
        wrn("是 fat 二进制（多架构），TrollStore 能用但偏大")
    else:
        cpu = info["cpu"]
        if cpu == CPU_TYPE_ARM64:
            ok("架构 = arm64")
        else:
            bad("架构不是 arm64 (cpu=0x%X)" % cpu)

        if info["type"] == MH_EXECUTE:
            ok("文件类型 = MH_EXECUTE（可执行）")
        else:
            bad("文件类型不是 MH_EXECUTE (type=%d)，是空壳" % info["type"])

        cid = info["cryptid"]
        if cid == 0:
            ok("cryptid = 0（未加密，TrollStore 可装）")
        elif cid is None:
            wrn("没找到 LC_ENCRYPTION_INFO，可能未加密（真机才最终确定）")
        else:
            bad("cryptid = %d，包被加密了，TrollStore 装不了" % cid)

        # 链接了哪些系统框架。少链一个，对应功能一调用就崩。
        dylibs = info.get("dylibs", [])
        if dylibs:
            print("       链接的框架: " + ", ".join(
                sorted(set(d.split("/")[-1] for d in dylibs))))
        for fw in ("WebKit", "AVFoundation", "UIKit", "Foundation"):
            if any(("/" + fw + ".framework/") in d for d in dylibs):
                ok("已链接 " + fw)
            elif fw == "AVFoundation":
                bad("没链接 AVFoundation —— 语音播放会崩")
            else:
                wrn("没链接 " + fw)

    # --- 3. Info.plist 关键键 ---
    print("\n[3] Info.plist")
    for key, want in [
        ("CFBundleIdentifier", None),
        ("CFBundleDisplayName", None),
        ("MinimumOSVersion", None),
        ("LSMinimumSystemVersion", None),
    ]:
        v = pl.get(key)
        if v is None:
            bad("缺 " + key)
        else:
            ok("%s = %s" % (key, v))

    if pl.get("UIDeviceFamily") == [1]:
        ok("UIDeviceFamily = [1]（iPhone）")
    else:
        wrn("UIDeviceFamily = " + repr(pl.get("UIDeviceFamily")))

    ats = pl.get("NSAppTransportSecurity", {})
    if ats.get("NSAllowsArbitraryLoads"):
        ok("ATS 允许任意加载（能连自建 API）")
    else:
        wrn("ATS 未放开，非 HTTPS 接口会连不上")

    if pl.get("UIFileSharingEnabled"):
        ok("UIFileSharingEnabled（崩溃日志在「文件」App 可见）")
    else:
        wrn("UIFileSharingEnabled 未开")

    # --- 4. 网页资源 ---
    print("\n[4] 网页资源与图标")
    for need, label in [
        (appdir + "index.html", "index.html"),
        (appdir + "www/index.html", "www/index.html"),
        (appdir + "AppIcon60x60@2x.png", "AppIcon60x60@2x.png"),
        (appdir + "AppIcon60x60@3x.png", "AppIcon60x60@3x.png"),
    ]:
        if need in names:
            ok("%s (%.1f KB)" % (label, len(zf.read(need)) / 1024.0))
        else:
            bad("缺 " + label)

    # html 内容得真的是那个应用，不是占位页
    if appdir + "index.html" in names:
        h = zf.read(appdir + "index.html").decode("utf-8", "replace")
        if "chat/completions" in h and "nativeFetch" in h:
            ok("index.html 内容是完整应用（含 API 调用与原生通道）")
        else:
            bad("index.html 内容不完整")

    # --- 5. 签名 ---
    print("\n[5] 签名")
    sig = "_CodeSignature/CodeResources"
    if any(n.startswith(appdir + "_CodeSignature/") for n in names):
        ok("存在 _CodeSignature（ad-hoc 伪签名）")
    else:
        wrn("没有 _CodeSignature —— TrollStore 通常仍可安装")

    print("\n" + "=" * 52)
    if fails:
        print("  结果: %d 项不合格，%d 项警告" % (len(fails), len(warns)))
        for f in fails:
            print("   - " + f)
        print("=" * 52 + "\n")
        return 1
    print("  结果: 全部通过（%d 项警告）" % len(warns))
    print("=" * 52 + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
