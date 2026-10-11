// parseProjectedCostsRows account-code shapes — run with `npm test`.
// Every code here is copied from a real Summary Sheet (meeting and item noted).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseProjectedCostsRows } = require('../lib/projected-costs-parser');

const row = (code, rest = '$1,000 FY27 (Expenditure)') => `${code} ${rest}\nGeneral Fund. Some Dept.\n`;

test('plain fund.dept.object and fund.dept.object.project are unchanged', () => {
  const rows = parseProjectedCostsRows(row('01100.214700.546000') + row('12525.228990.534009.1002507'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].accountCode, '01100.214700.546000');
  assert.equal(rows[0].project, null);
  assert.equal(rows[1].accountCode, '12525.228990.534009.1002507');
  assert.equal(rows[1].project, '1002507');
});

test('a 0000 program placeholder before the project is skipped, project kept', () => {
  // 10/15/26 item 68 MAM26-27135: both rows used to collapse to the same code.
  const text =
    '31400.243000.560005.0000.1000576 $130,000 (Expenditure Decrease)\n' +
    'Utilities Services Tax Capital Projects Fund, Red Light Camera project\n' +
    '31400.243000.560005.0000.1003027 $130,000 (Expenditure Increase)\n' +
    'Utilities Services Tax Capital Projects Fund, West Riverwalk Phase II\n';
  const rows = parseProjectedCostsRows(text);
  assert.deepEqual(rows.map((r) => r.accountCode), ['31400.243000.560005.1000576', '31400.243000.560005.1003027']);
  assert.deepEqual(rows.map((r) => r.project), ['1000576', '1003027']);
  assert.deepEqual(rows.map((r) => r.type), ['expenditure_decrease', 'expenditure']);
});

test('placeholder written with a dot and a space still parses', () => {
  // 7/31/25 item 33 INF25-15885
  const rows = parseProjectedCostsRows(row('30600.243000.563001.0000. 1002350'));
  assert.equal(rows[0].accountCode, '30600.243000.563001.1002350');
});

test('trailing 0000000 task placeholder after the project is dropped', () => {
  // 8/28/25 item 70 INF25-15849
  const rows = parseProjectedCostsRows(row('41100.243200.563001.0000.1001865.0000000'));
  assert.equal(rows[0].accountCode, '41100.243200.563001.1001865');
  assert.equal(rows[0].project, '1001865');
});

test('trailing 0000 after a project is dropped', () => {
  // 7/16/26 item 80 INF26-25629
  const rows = parseProjectedCostsRows(row('31630.214400.562001.1000986.0000'));
  assert.equal(rows[0].accountCode, '31630.214400.562001.1000986');
});

test('hyphen separators parse like dots', () => {
  // 7/31/25 item 71 INF25-15438 (with a leading 6-digit award number)
  const rows = parseProjectedCostsRows(row('000165 61900-213800-563001-0000-1002878-0000000'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fund, '61900');
  assert.equal(rows[0].accountCode, '61900.213800.563001.1002878');
});

test('an all-zero project means no project', () => {
  // 4/16/26 item 43 DEO26-22903 and the hyphen form documented in opengov/parse_account_code.py
  const rows = parseProjectedCostsRows(row('100671 62400 213831 549008 0000 0000000') + row('01100-232900-534007-0000000'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].accountCode, '62400.213831.549008');
  assert.equal(rows[0].project, null);
  assert.equal(rows[1].accountCode, '01100.232900.534007');
  assert.equal(rows[1].project, null);
});

test('a 7-digit project with leading zeros is kept as written', () => {
  // 7/31/25 item 22 INF25-15810
  const rows = parseProjectedCostsRows(row('61900 213800 563001 0000 0000491'));
  assert.equal(rows[0].accountCode, '61900.213800.563001.0000491');
});

test('placeholder matching never reaches into the next row', () => {
  const text = '01100.215000.552003 FY26 $1 (Expenditure)\n31801.241800.563000.1000750 $2 (Expenditure)\n';
  const rows = parseProjectedCostsRows(text);
  assert.deepEqual(rows.map((r) => r.accountCode), ['01100.215000.552003', '31801.241800.563000.1000750']);
});
