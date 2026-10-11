"""Fixture tests for the reallocation rule in opengov.reconcile.

Run from the repo root:  npm run test:opengov
(or  .venv/bin/python3 -m unittest discover -s opengov/tests -t .)

Rows mirror the shape lib/projected-costs-parser.js emits; dollar figures
come from real Summary Sheets so each case pins an agenda item we have seen.
"""
import unittest

from opengov.reconcile import _aggregate_rows, _compute_reallocation


def _row(code, value, row_type, marker):
    return {
        "accountCode": code,
        "value": value,
        "type": row_type,
        "marker": marker,
        "subjectToAppropriation": False,
    }


def _reallocation(rows):
    return _compute_reallocation(rows, _aggregate_rows(rows)["committed"])


class ReallocationRuleTests(unittest.TestCase):
    def test_close_out_on_one_line_is_not_a_reallocation(self):
        # INF26-27468, 2026-10-15: Change Order 2 Final de-obligates the unspent
        # contract balance and releases $10,000 retainage on the same account
        # code. The clerk marked the final payment "Expenditure Increase".
        rows = [
            _row("31801.241800.563000.1000750", 1886910.73,
                 "expenditure_decrease", "Expenditure Decrease"),
            _row("31801.241800.563000.1000750", 10000.0,
                 "expenditure", "Expenditure Increase"),
        ]
        self.assertIsNone(_reallocation(rows))

    def test_equal_amounts_on_one_line_stay_a_balanced_reallocation(self):
        # MAM26-27135, 2026-10-15: "reallocates funds in the total amount of
        # $130,000". Both rows parsed to the same code because the project
        # segment was lost, but the sides balance, so it keeps the
        # "Reallocated" headline and raises no warning.
        rows = [
            _row("31400.243000.560005", 130000.0,
                 "expenditure_decrease", "Expenditure Decrease"),
            _row("31400.243000.560005", 130000.0,
                 "expenditure", "Expenditure Increase"),
        ]
        result = _reallocation(rows)
        self.assertIsNotNone(result)
        self.assertTrue(result["balanced"])

    def test_plain_final_payment_is_not_a_reallocation(self):
        # The older close-out shape: decrease plus a plain "Expenditure" row,
        # on different lines. No "Increase" marker, so no reallocation.
        rows = [
            _row("31801.241800.563000.1000750", 32804.33,
                 "expenditure_decrease", "Expenditure decrease"),
            _row("31801.241800.563001.1000750", 24999.11,
                 "expenditure", "Expenditure"),
        ]
        self.assertIsNone(_reallocation(rows))

    def test_unbalanced_transfer_across_lines_is_flagged(self):
        # CRA26-26778, 2026-09-10: $1,000,000 out of one line, $1,192,418 into
        # two others. Different codes, so it is a reallocation, and it does
        # not balance.
        rows = [
            _row("20603.221000.583000.1002100", 1000000.0,
                 "expenditure_decrease", "Expenditure Decrease"),
            _row("20603.221000.563000.1002101", 1092418.0,
                 "expenditure", "Expenditure Increase"),
            _row("20603.221000.534000.1002101", 100000.0,
                 "expenditure", "Expenditure Increase"),
        ]
        result = _reallocation(rows)
        self.assertIsNotNone(result)
        self.assertFalse(result["balanced"])
        self.assertEqual(result["imbalance"], 192418.0)

    def test_balanced_transfer_across_lines(self):
        rows = [
            _row("01100.220904.531000", 5000.0,
                 "expenditure_decrease", "Expenditure Decrease"),
            _row("01100.220904.534000", 5000.0,
                 "expenditure", "Expenditure Increase"),
        ]
        result = _reallocation(rows)
        self.assertIsNotNone(result)
        self.assertTrue(result["balanced"])
        self.assertEqual(result["imbalance"], 0.0)

    def test_rows_without_codes_keep_the_old_behaviour(self):
        # A missing account code is not evidence of a single line; the
        # reallocation block is still produced so the warning can surface.
        rows = [
            _row(None, 5000.0, "expenditure_decrease", "Expenditure Decrease"),
            _row(None, 4000.0, "expenditure", "Expenditure Increase"),
        ]
        result = _reallocation(rows)
        self.assertIsNotNone(result)
        self.assertFalse(result["balanced"])


if __name__ == "__main__":
    unittest.main()
