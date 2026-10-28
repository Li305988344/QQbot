# -*- coding: utf-8 -*-
"""生成 edge-tts 中文音色对比样本（一次性辅助脚本）。

为什么用脚本而不是命令行直接传 --text：
中文文本经过 cmd/PowerShell 传到子进程时编码链路极不可靠（同一台机器上已经
因为这件事把 .ps1 脚本整体解成乱码过一次）。这里把文本从 UTF-8 文件读进来，
命令行上不出现任何中文。
"""
import asyncio
import pathlib
import sys

import edge_tts

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parent
OUT = REPO / "voice-samples" / "edge"
# 文本文件名曾叫 _sample_text.txt；已重命名为 voice-sample-text.txt，与本脚本一起放在 ops/。
TEXT_FILE = ROOT / "voice-sample-text.txt"

# 顺序即展示顺序：从「最像真人聊天」到「特殊用途」。
# 只挑对这个机器人（闲聊/吐槽/撒娇）可能有用的，方言和播音腔放最后当对照。
VOICES = [
    ("zh-CN-XiaoxiaoNeural", "晓晓", "女-温暖自然", "+0%", "+0Hz"),
    ("zh-CN-XiaoyiNeural", "晓伊", "女-活泼可爱", "+8%", "+30Hz"),
    ("zh-CN-YunxiNeural", "云希", "男-阳光少年", "+0%", "+0Hz"),
    ("zh-CN-YunxiaNeural", "云夏", "男-可爱小男孩", "+5%", "+20Hz"),
    ("zh-CN-YunjianNeural", "云健", "男-激情解说", "-5%", "-10Hz"),
    ("zh-CN-YunyangNeural", "云扬", "男-播音腔", "+0%", "+0Hz"),
    ("zh-CN-liaoning-XiaobeiNeural", "晓北", "女-东北话", "+0%", "+0Hz"),
    ("zh-CN-shaanxi-XiaoniNeural", "晓妮", "女-陕西话", "+0%", "+0Hz"),
]


async def main() -> int:
    text = TEXT_FILE.read_text(encoding="utf-8").strip()
    if not text:
        print("FAIL: 样本文本为空")
        return 1
    OUT.mkdir(exist_ok=True)
    # 清掉旧样本，避免上次残留的文件让人误以为是新生成的
    for old in OUT.glob("*.mp3"):
        old.unlink()

    print(f"text ({len(text)} chars): {text}")
    print("-" * 60)
    failed = 0
    for index, (voice, nick, desc, rate, pitch) in enumerate(VOICES, start=1):
        name = f"{index}-{nick}-{voice.split('-')[-1].replace('Neural', '')}.mp3"
        path = OUT / name
        try:
            communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
            await communicate.save(str(path))
            size = path.stat().st_size
            print(f"OK   {name}  {size // 1024}KB  ({desc} {voice})")
        except Exception as error:  # noqa: BLE001 - 网络/服务端错误都要报出来而不是整体崩掉
            failed += 1
            print(f"FAIL {voice}: {type(error).__name__}: {error}")
    print("-" * 60)
    print(f"done: {len(VOICES) - failed}/{len(VOICES)} ok -> {OUT}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
