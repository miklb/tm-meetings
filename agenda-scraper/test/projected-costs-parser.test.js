// parseProjectedCostsRows account codes, amounts and types — run with `npm test`.
// Every code here is copied from a real Summary Sheet (meeting and item noted).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseProjectedCostsRows, classifyTypeMarker } = require('../lib/projected-costs-parser');

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

// --- Amounts and types. Each case is a shape that used to lose or misstate money.

const values = (rows) => rows.map((r) => r.value);
const types = (rows) => rows.map((r) => r.type);

test('every wording of a decrease is typed as a decrease', () => {
  for (const [marker, type] of [
    ['Expenditure Decrease', 'expenditure_decrease'],
    ['Expense decrease', 'expenditure_decrease'], // 10/23/25 item 39
    ['Decrease Expenditure', 'expenditure_decrease'], // 7/30/26 item 36
    ['decrease expenditure', 'expenditure_decrease'],
    ['Expenditure reduction', 'expenditure_decrease'], // 8/27/26 item 51
    ['Expense reduction', 'expenditure_decrease'],
    ['Revenue reduction', 'revenue_decrease'],
    ['Estimated Revenue Decrease', 'revenue_decrease'],
    ['Revenue Decrease - Monthly Reduction, Duration to be Determined', 'revenue_decrease'],
  ]) {
    assert.equal(classifyTypeMarker(marker).type, type, marker);
  }
  for (const [marker, type] of [
    ['Expenditure', 'expenditure'],
    ['Estimated Expenditure, subject to annual appropriation', 'expenditure'],
    ['Increase Expenditure', 'expenditure'],
    ['Revenue FY2026 - Subject to Annual Appropriation', 'revenue'],
    ['Amount to be determined', 'unknown'],
  ]) {
    assert.equal(classifyTypeMarker(marker).type, type, marker);
  }
});

test('a parenthesized amount is a decrease even under a bare "Expenditure" marker', () => {
  // 6/18/26 item 14 INF26-24458: "providing a credit to the city in the amount of $14,224.68"
  const rows = parseProjectedCostsRows('40553.244600.563001.0000.1000317.0000000 ($14,224.68) \n(Expenditure) \nWater Bonds\n');
  assert.deepEqual(types(rows), ['expenditure_decrease']);
  assert.equal(rows[0].signedValue, -14224.68);
});

test('a parenthetical ahead of the real marker does not hide it', () => {
  // 11/5/26 item 55 DEO26-27671: rows used to be typed unknown and left out of every total
  const text =
    '12220.218800.534007.1003022 (FY27) - $225,000 (Expenditure)\nHOPWA Grant.\n' +
    '12220.218800.534007.TBD (FY28) - $225,000 (Expenditure) Contingent upon available \nfunds\nHOPWA Grant.\n';
  const rows = parseProjectedCostsRows(text);
  assert.deepEqual(types(rows), ['expenditure', 'expenditure']);
  assert.deepEqual(rows.map((r) => r.fiscalYear), ['FY27', 'FY28']);
  assert.deepEqual(rows.map((r) => r.subjectToAppropriation), [false, true]);
});

test('with no marker the object code gives the type', () => {
  // 11/5/26 item 9 PS26-27940: "(UASI)" in the description used to be read as the marker
  const spend = parseProjectedCostsRows('12525.228990.534009.1002974 $150,680.08\nUrban Area Security Initiative (UASI) Grants Fund.\n');
  assert.deepEqual(types(spend), ['expenditure']);
  assert.equal(spend[0].marker, '');
  // 8/28/25 item 26 INF25-16456, the low end of that week's published range
  const noParens = parseProjectedCostsRows('41000.244300.546002 FY2025 $14,698\nWastewater Operations\n');
  assert.deepEqual(values(noParens), [14698]);
  const revenue = parseProjectedCostsRows('01100.228990.351101 $500\nGeneral Fund.\n');
  assert.deepEqual(types(revenue), ['revenue']);
});

test('a fund name in parentheses is not a marker', () => {
  const rows = parseProjectedCostsRows('41100.243200.563001 $5,000 (Water Revenue Bond Fund)\n');
  assert.deepEqual(types(rows), ['expenditure']);
});

test('a marker with no parentheses is read when it follows the amount', () => {
  // 11/6/25 item 25 F25-18616
  const rows = parseProjectedCostsRows(
    '14105.226800.534000 – ($52,095.78) (Expenditure Decrease)\nSouth Tampa Tree Trust Fund.\n' +
    '14105.226800.591301 - $52,095.78 Expenditure Increase South Tampa Tree Trust Fund.\n' +
    '30100.234110.381000 - $334,748.48 Revenue Increase Citywide Capital Project Improvements Fund.\n'
  );
  assert.deepEqual(types(rows), ['expenditure_decrease', 'expenditure', 'revenue']);
});

test('an amount with no dollar sign directly after the code still counts', () => {
  // 11/5/26 item 51 F26-28231 and 8/21/25 item 11 CRA25-16848
  const rows = parseProjectedCostsRows(
    '01100.234100.531002 (40,000) (Expenditure Decrease)\n\nGeneral Fund.\n' +
    '61800 213801 361101 68,700 (Revenue)\nCentral Park CRA Fund.\n'
  );
  assert.deepEqual(values(rows), [40000, 68700]);
  assert.deepEqual(types(rows), ['expenditure_decrease', 'revenue']);
});

test('a comma-grouped figure in a description is not an amount', () => {
  const rows = parseProjectedCostsRows('01100.213700.582505 (Expenditure) General Fund. Serving 100,000 residents.\n');
  assert.deepEqual(rows, []);
});

test('amount-first rows keep their own amount and code', () => {
  // 10/23/25 item 3 PS25-18003
  const firstLayout = parseProjectedCostsRows(
    '$28,583 01100.228990.546000 FY26 (Expenditure)\nGeneral Fund.\n' +
    '$30,000 01100.228990.546001 FY27 (Expenditure), subject to annual appropriation.\nGeneral Fund.\n'
  );
  assert.deepEqual(values(firstLayout), [28583, 30000]);
  assert.deepEqual(firstLayout.map((r) => r.accountCode), ['01100.228990.546000', '01100.228990.546001']);
  assert.deepEqual(firstLayout.map((r) => r.subjectToAppropriation), [false, true]);
  // 8/28/25 item 44 DEO25-16854: the second row's amount used to land on the first row's code
  const fiscalImpact = parseProjectedCostsRows(
    'Fiscal Impact: $55,072.00 (Expenditure Increase) Account: 62200.243000.560005.1001518\n' +
    'Fiscal Impact: $430.08 (Revenue Decrease - Monthly Reduction, Duration to be Determined) Account: 01100.228905.362004\n'
  );
  assert.deepEqual(fiscalImpact.map((r) => [r.accountCode, r.value, r.type]), [
    ['62200.243000.560005.1001518', 55072, 'expenditure'],
    ['01100.228905.362004', 430.08, 'revenue_decrease'],
  ]);
});

test('sheets with no account code still yield rows', () => {
  // 7/16/26 item 81 MAM26-25566: title says $3,800,000
  const estimated = parseProjectedCostsRows(
    'Controlled by Requisition FY2026 $632,000 Estimated Amount\n' +
    'Controlled by Requisition FY2027 $3,168,000 Estimated Amount, subject to annual \nappropriation\n'
  );
  assert.deepEqual(values(estimated), [632000, 3168000]);
  assert.deepEqual(types(estimated), ['expenditure', 'expenditure']);
  assert.deepEqual(estimated.map((r) => r.accountCode), [null, null]);
  assert.deepEqual(estimated.map((r) => r.subjectToAppropriation), [false, true]);
  // 7/17/25 item 44 MAM25-15646
  const parens = parseProjectedCostsRows(
    '$91,700 FY2025 (Estimated Expenditure) controlled by requisition\n' +
    '$458,300 FY2026 (Estimated Expenditure) controlled by requisition, subject to annual appropriation\n'
  );
  assert.deepEqual(values(parens), [91700, 458300]);
});

test('"Estimated Amount" rows with a code add up to the title', () => {
  // 7/16/26 item 40 DEO26-25344: only the first row used to parse; title says $571,352
  const rows = parseProjectedCostsRows(
    '01100.228905.552007 FY26 $323,500 (Expenditure)\nGeneral Fund\n' +
    '01100.228905.546002 FY27 $48,400 Estimated Amount, subject to annual appropriation \nEstimated Amount\nGeneral Fund\n' +
    '01100.228905.546002 FY28 $48,400 Estimated Amount, subject to annual appropriation\nGeneral Fund\n' +
    '01100.228905.546002 FY29 $49,852 Estimated Amount, subject to annual appropriation\nGeneral Fund\n' +
    '01100.228905.546002 FY30 $49,852 Estimated Amount, subject to annual appropriation\nGeneral Fund\n' +
    '01100.228905.546002 FY31 $51,348 Estimated Amount, subject to annual appropriation\nGeneral Fund\n'
  );
  assert.equal(rows.reduce((s, r) => s + r.value, 0), 571352);
  assert.ok(types(rows).every((t) => t === 'expenditure'));
});

test('one amount over several codes is one row with pooled codes', () => {
  // 8/28/25 item 70 INF25-15849, the top of that week's published range
  const funding = parseProjectedCostsRows(
    'Funding of $81,546,855 (Expenditure)\n' +
    '41100.243200.563001.0000.1001865.0000000\nWastewater Capital/Construction Fund.\n' +
    '41154.243200.563001.0000.1001865.0000000\nWastewater Future Debt Capital Projects Fund.\n'
  );
  assert.deepEqual(values(funding), [81546855]);
  assert.equal(funding[0].accountCode, null);
  assert.deepEqual(funding[0].pooledCodes, ['41100.243200.563001.1001865', '41154.243200.563001.1001865']);
  // 3/26/26 item 72 INF26-22316: a fund name in parens used to be the marker and
  // the FY27 amount landed on the FY26 list's last code; title says $50,700,000
  const paving = parseProjectedCostsRows(
    'FY2026 Funding of $12,675,000 will be provided subject to availability \nof funding:\n' +
    '30534.243000.563001.0000000 (AFT Surtax Funds)\n31400.243000.563001.1000576 (Utilities tax Capital Projects Fund)\n' +
    'FY2027  Funding of $38,025,000 will be provided subject to availability of funding:\n' +
    '30534.243000.563001.0000000 (AFT Surtax Funds)\n31400.243000.563001.1000576 (Utilities tax Capital Projects Fund)\n'
  );
  assert.deepEqual(paving.map((r) => [r.fiscalYear, r.value, r.type]), [
    ['FY26', 12675000, 'expenditure'],
    ['FY27', 38025000, 'expenditure'],
  ]);
});

test('a total line above its rows is not another row', () => {
  // 7/31/25 item 71 INF25-15438
  const rows = parseProjectedCostsRows(
    '($4,955,424.50) Expenditure\n' +
    '61900-213800-563001-0000-1002878-0000000 $2,700,000 (Expenditure) (FY2025)\nChannel District CRA Fund.\n' +
    '61900-213800-563001-0000-1002878-0000000 $2,255,424.50 (Expenditure) (FY2026)\nChannel District CRA Fund.\n'
  );
  assert.deepEqual(values(rows), [2700000, 2255424.5]);
  assert.deepEqual(types(rows), ['expenditure', 'expenditure']);
});

test('typos in the amount are read as what they mean', () => {
  // 8/7/25 item 42 MAM25-16029: title says $955,540 = $119,440 + $836,100
  const thousands = parseProjectedCostsRows(
    '$119,440 FY2025 (Estimated Expenditure) controlled by requisition\n' +
    '$836.100 FY2026 (Estimated Expenditure) controlled by requisition, subject to annual \nappropriation\n'
  );
  assert.deepEqual(values(thousands), [119440, 836100]);
  assert.equal(thousands[1].amount, '$836,100');
  // 5/7/26 item 111 MAM26-23075: project number run into the amount
  const project = parseProjectedCostsRows('30600.243000.563001 $5,800,000.1002350 FY2027 (Estimated Expenditure) subject to \nannual appropriation\n');
  assert.deepEqual(values(project), [5800000]);
  assert.equal(parseProjectedCostsRows('01100.215000.552003 $1,234.56 (Expenditure)\n')[0].value, 1234.56);
});

test('rates, narrative figures and prose are not rows', () => {
  for (const text of [
    // 8/28/25 item 6 PS25-16779
    '40100 224900 531002 (Amount to be determined) based on the \nnumber\nof parking citation sessions ($200 p/ session).\nParking.\n' +
      '01100 220901 531002 (Amount to be determined) based on the number of sessions ($250-$300 p/ session).\nGeneral Fund.\n',
    '01100.225700.347217 $75 per day based on usage (Revenue)\nGeneral Fund.\n', // 8/6/26 item 16
    '01100.228990.351101. Amount TBD $50 per penalty paid. FY2026 \n(Revenue)\nGeneral Fund.\n', // 10/23/25 item 2
    // 6/18/26 item 13 INF26-24275
    '01100.239400.369936 (Revenue) Amount to be determined based upon usage. The budget will include revenues of $4.0 million.\n',
    // 10/15/26 item 90 F26-27178
    'The adoption of this Resolution is required to initiate validation of debt for the City’s $80 \nmillion Contribution Amount.\n',
    '$422,138,440 (FY2026)\n', // 9/16/25 item 10 B2026-2
    '$15,110.89\n', // 8/28/25 item 45 DEO25-16858
    // 11/5/26 item 49 INF26-28195: a loan, not spending
    'The proceeds will be deposited in a new fund.\n$20,000,000 - Loan\n$20,400,000 - SUBTOTAL (loan amount)\n($10,000,000) - less principal forgiveness\n$10,400,000 - TOTAL (estimated loan principal amount)\n',
    '40700.244600.563001.1002994\nWater Renewal and Replacement Fund.\nP: 1002994   O: WTR-Water Dept   T: 31   A: \n100453\n', // 7/16/26 item 79
  ]) {
    assert.deepEqual(parseProjectedCostsRows(text), [], text);
  }
});

test('contract metadata lines do not become rows', () => {
  // 10/23/25 item 3 shape with the metadata line from 8/28/25 item 72 MAM25-16849
  const rows = parseProjectedCostsRows(
    '$2,000,000 30600.243000.560005.1002890 (Expenditure Increase)\nLocal Option.\n' +
    'P: 1002890 O: TSS E: CTPA Prof Svcs Capital T: 31 A: 100654 $2,000,000\n'
  );
  assert.deepEqual(values(rows), [2000000]);
});

test('malformed account codes still start their own row', () => {
  // 8/21/25 item 11 CRA25-16848: no separators at all
  const glued = parseProjectedCostsRows('61800213801319100$2,015,250 (Revenue)\nCentral Park CRA Fund.\n61900 213801 319100 $13,461,774 (Revenue)\n');
  assert.deepEqual(glued.map((r) => [r.accountCode, r.value]), [['61800.213801.319100', 2015250], ['61900.213801.319100', 13461774]]);
  // 12/18/25 item 7 PS25-19317: object missing a digit; its $133,392 used to vanish
  const shortObject = parseProjectedCostsRows('12500.228990.552005.1002929 $20,600 (Expenditure Increase)\nTools.\n12500.228990.55100.1002929 $133,392 (Expenditure Increase)\nOffice Supplies.\n');
  assert.deepEqual(values(shortObject), [20600, 133392]);
  assert.equal(shortObject[1].project, '1002929');
  // 8/27/26 item 8 PS26-26363: fund missing a digit; used to match "28990.514000.100301"
  const shortFund = parseProjectedCostsRows('1250.228990.514000.1003010 $183,637 FY2026 (Expenditure Increase)\nHIDTA Fund.\n');
  assert.equal(shortFund[0].accountCode, '1250.228990.514000.1003010');
  // 10/23/25 item 28 F25-17885: fund with an extra digit
  const longFund = parseProjectedCostsRows('011000.220902.571007 FY26 $876,118.83 (Expenditure)\nGeneral Fund.\n');
  assert.equal(longFund[0].accountCode, '011000.220902.571007');
  // 3/5/26 item 67 MAM26-20885: object and project with no separator
  const gluedProject = parseProjectedCostsRows('31630 210700 3840011002122 $6,863,085 1002122 (Revenue \nIncrease)\nNon Ad Valorem Bonds.\n');
  assert.equal(gluedProject[0].accountCode, '31630.210700.384001.1002122');
  assert.deepEqual(types(gluedProject), ['revenue']);
  // 2026-07-16 item 79: a 6-digit award number before a code doesn't start one
  const award = parseProjectedCostsRows('T: 31   A: \n100453\n40554.244600.563001.1002994 $5 (Expenditure)\n');
  assert.equal(award[0].accountCode, '40554.244600.563001.1002994');
});

test('descriptions lose the stray ) left by a parenthesized fiscal year', () => {
  const rows = parseProjectedCostsRows('61900-213800-563001-0000-1002878-0000000 $2,700,000 (Expenditure) (FY2025)\nChannel District CRA Fund.\n');
  assert.equal(rows[0].description, 'Channel District CRA Fund.');
});
