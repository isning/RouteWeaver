"""Receipt safety tests; no CLI process or listener is started."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reference', Path(__file__).with_name('reference-linux-operations.py'))
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)


class ReceiptSafetyTest(unittest.TestCase):
    def test_failed_rerun_invalidates_stale_success_before_binary_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / 'result.json'
            output.write_text('{"status":"passed"}')
            with patch.object(sys, 'argv', ['reference', '--binary', str(root / 'missing'), '--output', str(output)]):
                with self.assertRaises(FileNotFoundError):
                    reference.main()
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
