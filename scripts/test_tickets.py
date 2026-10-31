import copy
import json
from pathlib import Path
import unittest
from tickets import validate

ROOT = Path(__file__).resolve().parents[1]


class TicketGraphTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / "docs/tickets/catalog.json").read_text())
        self.source = (ROOT / self.data["scope_source"]).read_text()

    def test_current_graph_has_complete_scope(self):
        self.assertEqual(validate(self.data, self.source), [])

    def test_omission_cannot_hide_in_integration_ticket(self):
        changed = copy.deepcopy(self.data)
        for ticket in changed["tickets"]:
            if ticket.get("kind") != "integration":
                ticket["stories"] = [s for s in ticket["stories"] if s != "M04"]
        self.assertTrue(any("M04" in error for error in validate(changed, self.source)))

    def test_cycle_is_rejected(self):
        self.data["tickets"][0]["blocked_by"] = ["RW-24"]
        self.assertTrue(any("cycle" in error for error in validate(self.data, self.source)))

    def test_fake_completion_is_rejected(self):
        self.data["tickets"][-1]["status"] = "verified"
        # Construct missing evidence explicitly; catalog progress may add links.
        self.data["tickets"][-1]["evidence"] = []
        errors = validate(self.data, self.source)
        self.assertTrue(any("positive evidence" in error for error in errors))
        self.assertTrue(any("before blocker" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
