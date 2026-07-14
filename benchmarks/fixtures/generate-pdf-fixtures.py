#!/usr/bin/env python3
"""Generate the deterministic, redistributable P0-B1 PDF fixtures."""

from __future__ import annotations

import argparse
import hashlib
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PDF_ROOT = ROOT / "pdf"

FIXTURES = {
    "front-matter-noise": {
        "title": "Synthetic Front Matter Noise",
        "author": "Ada Stone; Ben River",
        "lines": [
            ("Synthetic Front Matter Noise", 18, 760),
            ("Ada Stone, Ben River", 12, 730),
            ("Abstract", 14, 690),
            ("We introduce a focused attention system for controlled translation", 11, 665),
            ("*Equal contribution.", 8, 646),
            ("The method achieves 28.4 BLEU on the EN-DE benchmark.", 11, 625),
            ("Presented at Synthetic Translation Conference 2017.", 8, 604),
            ("Copyright 2026 Codex Paper contributors. Licensed under MIT.", 8, 586),
            ("1 Introduction", 14, 548),
            ("This paper presents a compact method for translation evaluation.", 11, 524),
            ("2 Conclusion", 14, 486),
            ("We demonstrate a 28.4 BLEU result under controlled conditions.", 11, 462),
        ],
    },
    "result-conflict": {
        "title": "Synthetic Translation Result Conflict",
        "author": "Cara North; Dylan West",
        "lines": [
            ("Synthetic Translation Result Conflict", 18, 760),
            ("Cara North, Dylan West", 12, 730),
            ("Abstract", 14, 690),
            ("We present a translation model that reaches 28.4 BLEU on EN-DE.", 11, 665),
            ("On WMT 2014 EN-FR, the model achieves 41.8 BLEU.", 11, 644),
            ("1 Introduction", 14, 606),
            ("The benchmark compares controlled translation systems.", 11, 582),
            ("2 Results", 14, 544),
            ("Table 2: EN-FR BLEU 41.8.", 11, 520),
            ("3 Conclusion", 14, 482),
            ("The prose reports 41.0 BLEU for EN-FR, conflicting with Table 2.", 11, 458),
        ],
    },
}


def pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_content(lines: list[tuple[str, int, int]]) -> bytes:
    commands = []
    for text, size, y in lines:
        commands.append(
            f"BT\n/F1 {size} Tf\n72 {y} Td\n({pdf_escape(text)}) Tj\nET\n"
        )
    return "".join(commands).encode("ascii")


def build_pdf(fixture_id: str) -> bytes:
    fixture = FIXTURES[fixture_id]
    content = build_content(fixture["lines"])
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        (
            f"<< /Title ({pdf_escape(fixture['title'])}) "
            f"/Author ({pdf_escape(fixture['author'])}) "
            "/Creator (Codex Paper deterministic fixture generator 1.0) "
            "/Producer (Codex Paper) /CreationDate (D:20260713000000Z) "
            "/ModDate (D:20260713000000Z) >>"
        ).encode("ascii"),
    ]

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")

    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 6 0 R "
            f"/ID [<{hashlib.sha256(fixture_id.encode()).hexdigest()[:32]}>"
            f"<{hashlib.sha256((fixture_id + '-copy').encode()).hexdigest()[:32]}>] >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(output)


def write_fixture(fixture_id: str, output_root: Path) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    output_path = output_root / f"{fixture_id}.pdf"
    output_path.write_bytes(build_pdf(fixture_id))
    return output_path


def check_fixtures(fixture_ids: list[str]) -> int:
    with tempfile.TemporaryDirectory(prefix="codex-paper-p0-b1-") as temp_dir:
        temp_root = Path(temp_dir)
        failures = []
        for fixture_id in fixture_ids:
            generated = write_fixture(fixture_id, temp_root)
            committed = PDF_ROOT / generated.name
            if not committed.exists():
                failures.append(f"missing committed fixture: {committed.relative_to(ROOT.parent)}")
                continue
            if generated.read_bytes() != committed.read_bytes():
                failures.append(f"fixture is not byte-for-byte reproducible: {generated.name}")
        if failures:
            for failure in failures:
                print(f"FAIL: {failure}")
            return 1
    print(f"PASS: {len(fixture_ids)} deterministic PDF fixture(s) reproduced byte-for-byte")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--fixture", choices=sorted(FIXTURES))
    group.add_argument("--all", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args()

    fixture_ids = sorted(FIXTURES) if args.all or args.check else [args.fixture]
    if args.check:
        return check_fixtures(fixture_ids)

    for fixture_id in fixture_ids:
        output_path = write_fixture(fixture_id, PDF_ROOT)
        digest = hashlib.sha256(output_path.read_bytes()).hexdigest()
        print(f"{output_path}: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
