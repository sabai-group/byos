#!/usr/bin/env python3
"""Decrypt a BYOS-encrypted supplier name (AES-256-SIV, key = SHA-512(SECRET_ENCRYPTION_KEY), no AAD)."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESSIV


def decrypt_supplier_name(*, secret: str, ciphertext_b64: str) -> str:
    key = hashlib.sha512(secret.encode("utf-8")).digest()  # 64 bytes → AES-256-SIV
    ct = base64.b64decode(ciphertext_b64)
    return AESSIV(key).decrypt(ct, None).decode("utf-8")


def encrypt_supplier_name(*, secret: str, plaintext: str) -> str:
    key = hashlib.sha512(secret.encode("utf-8")).digest()
    ct = AESSIV(key).encrypt(plaintext.encode("utf-8"), None)
    return base64.b64encode(ct).decode("ascii")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--secret",
        default=os.environ.get("SECRET_ENCRYPTION_KEY", ""),
        help="Same as BYOS SECRET_ENCRYPTION_KEY (default: $SECRET_ENCRYPTION_KEY)",
    )
    sub = parser.add_subparsers(dest="command")

    dec = sub.add_parser("decrypt", aliases=["d"], help="decrypt a base64 ciphertext")
    dec.add_argument("ciphertext", help="base64-encoded AES-SIV ciphertext")

    enc = sub.add_parser("encrypt", aliases=["e"], help="encrypt a plaintext supplier name")
    enc.add_argument("name", help="plaintext supplier name")

    from_json = sub.add_parser("from-json", aliases=["j"], help="decrypt from an ingest JSON file")
    from_json.add_argument("file", type=Path, help="email.json or whatsapp.json")

    args = parser.parse_args()
    if not args.secret:
        print("Missing secret: set SECRET_ENCRYPTION_KEY or pass --secret", file=sys.stderr)
        sys.exit(2)

    if args.command in ("decrypt", "d"):
        print(decrypt_supplier_name(secret=args.secret, ciphertext_b64=args.ciphertext))
    elif args.command in ("encrypt", "e"):
        print(encrypt_supplier_name(secret=args.secret, plaintext=args.name))
    elif args.command in ("from-json", "j"):
        data = json.loads(args.file.read_text(encoding="utf-8"))
        ct = data["encrypted_supplier_name"]
        print(decrypt_supplier_name(secret=args.secret, ciphertext_b64=ct))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
