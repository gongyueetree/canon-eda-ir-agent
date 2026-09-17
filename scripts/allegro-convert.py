#!/usr/bin/env python3
"""Allegro .brd -> traceable Refir ZIP. Requires KiCad 10+ with Allegro importer.

Offline: python3 scripts/allegro-convert.py board.brd -o board-refir.zip
Service: ALLEGRO_CONVERTER_TOKEN=... python3 scripts/allegro-convert.py --serve 127.0.0.1:8788
No proprietary parser code or KiCad binaries are bundled.
"""
import argparse
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import zipfile

MAX_SOURCE = 50 * 1024 * 1024
MAX_WEB = 4 * 1024 * 1024
MANIFEST = "refir-allegro.json"


def is_allegro(data):
    return len(data) >= 256 and (data[2:4] in (b"\x13\x00", b"\x14\x00", b"\x15\x00") or data[0xf8:0xfb] == b"all")


def kicad_version(cli):
    result = subprocess.run([cli, "version"], capture_output=True, text=True, timeout=15, check=True)
    version = result.stdout.strip()
    match = re.search(r"\b(\d+)\.", version)
    if not match or int(match.group(1)) < 10:
        raise ValueError("KiCad 10 or newer with Allegro importer is required")
    return version


def convert(data, cli="kicad-cli", source_name="source.brd"):
    if len(data) > MAX_SOURCE:
        raise ValueError("Allegro input exceeds 50 MiB")
    if not is_allegro(data):
        raise ValueError("File does not have an Allegro binary board signature")
    if Path(source_name).name != source_name or any(c in source_name for c in "\\:/\x00") or not source_name.lower().endswith(".brd"):
        raise ValueError("Invalid source filename")
    version = kicad_version(cli)
    with tempfile.TemporaryDirectory(prefix="refir-allegro-") as directory:
        root = Path(directory)
        source, target, report = root / "source.brd", root / "board.kicad_pcb", root / "import-report.json"
        source.write_bytes(data)
        # --format auto is deliberate: KiCad 10 detects Allegro by content; its
        # CLI format hints do not include an explicit 'allegro' option.
        with (root / "converter.log").open("wb") as log:
            result = subprocess.run([cli, "pcb", "import", "--format", "auto", "--report-format", "json", "--report-file", str(report), "-o", str(target), str(source)], stdout=log, stderr=subprocess.STDOUT, timeout=120, cwd=root, check=False)
        if result.returncode != 0 or not target.exists():
            raise ValueError(f"KiCad PCB import failed (exit {result.returncode}); check that the installed build supports this Allegro version")
        if target.stat().st_size > MAX_SOURCE:
            raise ValueError("Converted PCB exceeds Refir's 50 MiB single-file limit")
        board = target.read_bytes()
        if not board.lstrip().startswith(b"(kicad_pcb"):
            raise ValueError("Converter did not produce a KiCad PCB")
        manifest = {"format": "refir-allegro", "version": 1,
                    "source": {"path": source_name, "sha256": hashlib.sha256(data).hexdigest()},
                    "board": {"path": "board.kicad_pcb", "sha256": hashlib.sha256(board).hexdigest()},
                    "converter": {"name": "KiCad CLI Allegro importer", "version": version}}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(source_name, data)
            archive.writestr("board.kicad_pcb", board)
            archive.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2))
            for name in ("import-report.json", "converter.log"):
                path = root / name
                if path.exists() and path.stat().st_size <= 1024 * 1024:
                    archive.write(path, name)
        return buffer.getvalue()


def unpack_request(body):
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        entries = archive.infolist()
        if len(entries) != 1 or entries[0].filename != "source.brd" or entries[0].file_size > MAX_SOURCE:
            raise ValueError("Expected a single source.brd of at most 50 MiB")
        # No extraction to disk: client paths can never escape the temporary directory.
        data = archive.read(entries[0])
        if len(data) > MAX_SOURCE:
            raise ValueError("Input too large")
        return data


def serve(address, cli):
    token = os.environ.get("ALLEGRO_CONVERTER_TOKEN", "")
    if len(token) < 32:
        raise ValueError("Set ALLEGRO_CONVERTER_TOKEN to a secret of at least 32 characters")
    kicad_version(cli)
    slot = threading.BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(150)

        def reply(self, status, payload, content_type="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + token).encode()):
                return self.reply(401, b'{"error":"unauthorized"}')
            if self.path != "/convert":
                return self.reply(404, b'{"error":"not found"}')
            if not slot.acquire(blocking=False):
                return self.reply(429, b'{"error":"converter busy"}')
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_WEB:
                    return self.reply(413, b'{"error":"web upload limit: 4 MiB compressed; use offline converter"}')
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError("Truncated request")
                result = convert(unpack_request(body), cli)
                if len(result) > MAX_WEB:
                    return self.reply(413, b'{"error":"web output limit: 4 MiB compressed; use offline converter"}')
                self.reply(200, result, "application/zip")
            except (ValueError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
                self.reply(422, json.dumps({"error": str(error)}).encode())
            finally:
                slot.release()

    host, port = address.rsplit(":", 1)
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?")
    parser.add_argument("-o", "--output")
    parser.add_argument("--cli", default=os.environ.get("KICAD_CLI", "kicad-cli"))
    parser.add_argument("--serve", metavar="HOST:PORT")
    args = parser.parse_args()
    try:
        if args.serve:
            serve(args.serve, args.cli)
        else:
            if not args.input or not args.output:
                parser.error("supply input.brd and --output result.zip, or --serve")
            path = Path(args.input)
            if path.stat().st_size > MAX_SOURCE:
                raise ValueError("Allegro input exceeds 50 MiB")
            result = convert(path.read_bytes(), args.cli, path.name)
            # Never overwrite the original design or an existing conversion.
            with open(args.output, "xb") as output:
                output.write(result)
            print(f"Created {args.output}; upload this ZIP to Refir. Conversion fidelity is partial.")
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Allegro conversion failed: {error}\n")


if __name__ == "__main__":
    main()
