#!/usr/bin/env python3
"""
Strips all images (and charts containing images) from an Excel (.xlsx) file.

Usage: reads raw xlsx bytes from stdin, writes cleaned xlsx bytes to stdout.
Exit code 0 on success, non-zero on failure (stderr has the error message).
"""
import sys
from io import BytesIO

from openpyxl import load_workbook


def strip_images(data: bytes) -> bytes:
    wb = load_workbook(BytesIO(data))
    for ws in wb.worksheets:
        ws._images = []
        ws._charts = []
    out = BytesIO()
    wb.save(out)
    return out.getvalue()


def main() -> None:
    raw = sys.stdin.buffer.read()
    if not raw:
        sys.exit("No input received on stdin")
    try:
        cleaned = strip_images(raw)
    except Exception as exc:
        sys.exit(f"Failed to strip images: {exc}")
    sys.stdout.buffer.write(cleaned)


if __name__ == "__main__":
    main()
