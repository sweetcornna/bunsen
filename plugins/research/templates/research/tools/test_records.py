"""把 rk check 接进项目的测试：总览表的数字逐行对照运行记录，新行没有来源就失败。

    pytest research/tools/test_records.py    或    python3 research/tools/test_records.py
"""
import subprocess
import sys
from pathlib import Path


def test_records():
    rk = Path(__file__).resolve().parent / "rk.py"
    p = subprocess.run([sys.executable, str(rk), "check"], capture_output=True, text=True)
    assert p.returncode == 0, p.stdout + p.stderr


if __name__ == "__main__":
    test_records()
    print("ok")
