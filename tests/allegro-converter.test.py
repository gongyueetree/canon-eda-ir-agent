"""Bridge orchestration tests use a stub CLI, not a real native-format acceptance test."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("allegro_convert", Path(__file__).resolve().parents[1] / "scripts/allegro-convert.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConverterTests(unittest.TestCase):
    def test_rejects_unknown_board_and_archive_paths(self):
        with self.assertRaises(ValueError):
            module.convert(b"not Allegro")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("../source.brd", b"bad")
        with self.assertRaises(ValueError):
            module.unpack_request(buffer.getvalue())

    def test_cli_contract_and_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = Path(directory) / "stub-kicad"
            cli.write_text('''#!/usr/bin/env python3
import sys
from pathlib import Path
if sys.argv[1:] == ["version"]:
    print("10.0.0")
else:
    assert sys.argv[1:5] == ["pcb", "import", "--format", "auto"]
    Path(sys.argv[sys.argv.index("-o") + 1]).write_text('(kicad_pcb (version 20260101))')
    Path(sys.argv[sys.argv.index("--report-file") + 1]).write_text('{"test_stub":true}')
''')
            cli.chmod(0o700)
            data = bytearray(512)
            data[2] = 0x14
            result = module.convert(bytes(data), str(cli))
            with zipfile.ZipFile(io.BytesIO(result)) as archive:
                manifest = json.loads(archive.read(module.MANIFEST))
                for key in ("source", "board"):
                    file = manifest[key]
                    self.assertEqual(module.hashlib.sha256(archive.read(file["path"])).hexdigest(), file["sha256"])
                self.assertIn("import-report.json", archive.namelist())
            self.assertFalse(list(Path(directory).glob("*.brd")))


if __name__ == "__main__":
    unittest.main()
