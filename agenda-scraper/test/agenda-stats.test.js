// computeAgendaStats buckets, the cross-check and vote counting — run with `npm test`.
// PROJECTED COSTS text and titles are copied from real agendas (meeting and item noted).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeAgendaStats, summarizeItem, requiresVote, linkedGroups, statedAmounts } = require('../lib/agenda-stats');

const item = (number, title, raw = '', { fis = '', section = 'Finance Committee' } = {}) => ({
  number,
  agendaItemId: String(1000 + number),
  fileNumber: `F26-${number}`,
  title: `File No. F26-${number} ${title}`,
  section,
  projectedCosts: raw ? { projectedCostsRaw: raw, fiscalImpactStatement: fis } : undefined,
});
const stats = (items) => computeAgendaStats({ meetingId: '1', formattedDate: '2026-11-05', agendaItems: items });

test('statedAmounts reads figures and scales', () => {
  assert.deepEqual(statedAmounts('in the amount of $1,234.50 and $80 million'), [1234.5, 80000000]);
  assert.deepEqual(statedAmounts('a loan of twenty ($20) million'), [20000000]); // 3/5/26 item 68
  assert.deepEqual(statedAmounts('no money here'), []);
});

test('votes: ceremony, written reports and closed sessions are out; staff reports only if legislative', () => {
  const title = (t, section) => ({ title: t, section });
  assert.equal(requiresVote(title('Presentation of Commendation to the Police Officer of the Month.', 'COMMENDATIONS AND\\OR PRESENTATIONS:')), false);
  assert.equal(requiresVote(title('Staff to provide a written report', 'WRITTEN STAFF REPORTS - (TO BE RECEIVED AND FILED)')), false);
  assert.equal(requiresVote(title('Closed session', '11:00 a.m. - CLOSED SESSION MEETING')), false);
  assert.equal(requiresVote(title('Staff to appear and report on sidewalks', 'STAFF REPORTS AND UNFINISHED BUSINESS - (Items 1 through 2)')), false);
  assert.equal(requiresVote(title('Resolution approving a contract', 'STAFF REPORTS AND UNFINISHED BUSINESS - (Items 1 through 2)')), true);
  assert.equal(requiresVote(title('Special Event Permit: Hot Chocolate Run', 'Neighborhood and Community Affairs Committee')), true);
  assert.equal(requiresVote(title('Review hearing on petition for review', '1:30 P.M. - PUBLIC HEARINGS ON MATTERS FOR REVIEW -')), true);
  // Older scrapes have no sections
  assert.equal(requiresVote(title('Resolution approving a contract')), true);
  assert.equal(requiresVote(title('Staff to report back')), false);
});

test('spending counts every fiscal year, the way the title states the contract', () => {
  // 7/16/26 item 26 INF26-25490 shape
  const s = summarizeItem(item(26, 'Resolution approving the bid in the estimated amount of $1,468,800',
    '41400.240500.546000 $367,200 FY2026 (Estimated Expenditure)\n41400.240500.546000 $1,101,600 FY2027 (Estimated Expenditure) subject to annual appropriation\n'));
  assert.equal(s.kind, 'spending');
  assert.equal(s.amount, 1468800);
  assert.equal(s.check, 'verified');
});

test('inter-fund transfers do not inflate spending', () => {
  // 11/5/26 item 24 shape: the 591xxx row is the other side of a 381xxx row
  const s = summarizeItem(item(24, 'Resolution approving an agreement',
    '41800.222205.381000 $353,609 (Revenue Increase)\n41900.222205.591418 $353,609 (Expenditure Increase)\n41900.222205.563001 $1,000 (Expenditure Increase)\n'));
  assert.equal(s.spending, 1000);
  assert.equal(s.revenue, 0);
});

test('a budget amendment that moves money is a reallocation at the title figure', () => {
  // 7/16/26 item 27 INF26-25588, published as "reallocating $43,306,896.72"
  const s = summarizeItem(item(27,
    'Resolution making certain changes in the budget of the City of Tampa; Approving the transfer, reallocation, and/or appropriation of $43,306,896.72 for the H. F. Curren Master Plan Project',
    '41100.243200.563001.1001944 ($218,622.51) (Expenditure \nDecrease)\nWastewater.\n41100.243200.563001.1001865 $43,306,896.72 (Expenditure Increase)\nWastewater.\n'));
  assert.equal(s.kind, 'reallocation');
  assert.equal(s.amount, 43306896.72);
});

test('a grant-funded budget amendment with no decrease is spending', () => {
  // 11/5/26 item 44 INF26-28232
  const s = summarizeItem(item(44, 'Resolution making certain changes in the budget; approving the transfer, reallocation, and/or appropriation of $1,000,000',
    '41410.239500.334302 $1,000,000 (Revenue Increase)\n41410.239500.564001 $1,000,000 (Expenditure Increase)\n'));
  assert.equal(s.kind, 'spending');
  assert.equal(s.amount, 1000000);
  assert.equal(s.check, 'verified');
});

test('a close-out counts only its final payment, and a pure credit counts nothing', () => {
  // 11/5/26 item 42 INF26-28111
  const final = summarizeItem(item(42, 'Resolution authorizing Change Order 1 Final to Contract 23-C-00014, with a final payment of $5,000',
    '30100.225300.563001.1000001 ($202,772.69) (Expenditure Decrease)\nFund.\n30100.225300.563001.1000001 $5,000 (Expenditure)\nFund.\n'));
  assert.equal(final.kind, 'spending');
  assert.equal(final.amount, 5000);
  assert.equal(final.closeout, true);
  // 6/18/26 item 14 INF26-24458
  const credit = summarizeItem(item(14, 'Resolution authorizing Change Order 1 Final providing a credit to the city in the amount of $14,224.68',
    '40553.244600.563001.0000.1000317.0000000 ($14,224.68) \n(Expenditure) \nWater Bonds.\n'));
  assert.equal(credit.kind, 'none');
  assert.equal(credit.amount, 0);
});

test('debt stays out of spending', () => {
  // 10/15/26 item 90 F26-27178
  const bonds = summarizeItem(item(90, 'Resolution authorizing the issuance of Non-Ad Valorem Revenue Bonds (Ballpark Project) in an aggregate principal amount not exceeding $80,000,000',
    'The adoption of this Resolution is required to initiate validation of debt for the City’s $80 \nmillion Contribution Amount.\n'));
  assert.equal(bonds.kind, 'debt');
  assert.equal(bonds.amount, 80000000);
  const reimbursement = summarizeItem(item(39, 'Reimbursement Resolution allowing the City to reimburse itself an amount not to exceed $26,000,000'));
  assert.equal(reimbursement.kind, 'debt');
  // 9/3/26 item 39 INF26-26425: the phrase is only in the fiscal statement
  const inStatement = summarizeItem(item(39, 'Resolution declaring official intent regarding the South Howard Flood Relief project',
    'None at this time.\n', { fis: 'The Reimbursement Resolution will allow the City to reimburse itself an amount not to exceed $26,000,000' }));
  assert.equal(inStatement.kind, 'debt');
  assert.equal(inStatement.amount, 26000000);
  // A contract paid for from a bond issue is still a contract
  const bondFunded = summarizeItem(item(41, 'Resolution approving a contract in the amount of $5,000',
    '40553.244600.563001 $5,000 (Expenditure)\nWater Bonds.\n', { fis: 'Funds come from the issuance of Series 2024 bonds. This provides $5,000.' }));
  assert.equal(bondFunded.kind, 'spending');
  // 11/5/26 item 49 INF26-28195
  const srf = summarizeItem(item(49, 'Resolution relating to the Florida Department of Environmental Protection State Revolving Fund program; approving the Facilities Plan',
    '$20,000,000 - Loan\n$10,400,000 - TOTAL (estimated loan principal amount)\n', { fis: 'for project financing of $20 million' }));
  assert.equal(srf.kind, 'debt');
  assert.equal(srf.spending, 0);
});

test('a budget amendment inside a bond fund is not debt', () => {
  const s = summarizeItem(item(5, 'Resolution making certain changes in the budget; transfer, reallocation, and/or appropriation of $500 from the issuance of bonds fund',
    '31630.210700.563000 ($500) (Expenditure Decrease)\n31630.210700.563001 $500 (Expenditure Increase)\n'));
  assert.equal(s.kind, 'reallocation');
});

test('adopting the annual budget is its own bucket', () => {
  const s = summarizeItem(item(10, 'Resolution adopting the FY2027 through FY2031 Capital Improvement Budget in the amount of $1,122,611,476',
    '$346,736,959 (FY2027)\n'));
  assert.equal(s.kind, 'annualBudget');
  assert.equal(s.amount, 1122611476);
});

test('rows that match the title are verified; a mismatch goes to review with both figures', () => {
  // 11/5/26 item 35 INF26-27735: FY29 row reads $336,300 where FY28 reads $366,300, $30,000 short of the title
  const raw =
    '41400. 240500. 546000 $335,775 FY2027 (Estimated Expenditure)\nSolid Waste.\n' +
    '41400. 240500. 546000 $366,300 FY2028 (Estimated Expenditure) subject to annual \nappropriation\nSolid Waste.\n' +
    '41400. 240500. 546000 $336,300 FY2029 (Estimated Expenditure) subject to annual \nappropriation\nSolid Waste.\n' +
    '41400. 240500. 546000 $30,525 FY2030 (Estimated Expenditure) subject to annual \nappropriation\nSolid Waste.\n';
  const s = summarizeItem(item(35, 'Resolution approving the bid in the estimated amount of $1,098,900', raw));
  assert.equal(s.check, 'review');
  assert.equal(s.low, 1068900);
  assert.match(s.notes.join(), /\$1,068,900.*\$1,098,900/);
});

test('rows matching the parts staff itemize are verified', () => {
  // 11/5/26 item 41 INF26-28109
  const s = summarizeItem(item(41, 'Resolution authorizing Change Order 1 Final, adding $781,022.21 and $881,210.88',
    '40700.244600.563001.1000317 $781,022.21 (Expenditure)\nWater.\n40554.244600.563001.1000317 $881,210.88 (Expenditure)\nWater.\n'));
  assert.equal(s.amount, 1662233.09);
  assert.equal(s.check, 'verified');
});

test('a row total wildly above the title is flagged, not corrected', () => {
  // 7/31/25 item 70 DEO25-15838: "$2,666,700,000" for $2,666,700; title says $16,000,000
  const s = summarizeItem(item(70, 'Resolution approving the renewal of Agreements in the estimated amount of $16,000,000',
    '$2,666,700,000 FY2025 (Estimated Expenditure) controlled by \nrequisition\n$13,333,300 FY2026 (Estimated Expenditure) controlled by requisition, subject to annual \nappropriation\n'));
  assert.equal(s.check, 'review');
  assert.equal(s.low, 16000000);
  assert.deepEqual(s.figures, [2680033300, 16000000]);
});

test('an annual figure in the title against a multi-year row total is flagged, with the lower as its floor', () => {
  // 3/5/26 item 40 F26-21816: rows total $1,000,000, title quotes $200,000 a year
  const s = summarizeItem(item(40, 'Resolution approving an Agreement for legal services at $200,000 per year',
    '01100.220500.531002 $1,000,000 (Expenditure)\nGeneral Fund.\n'));
  assert.equal(s.check, 'review');
  assert.equal(s.low, 200000);
});

test('a title figure with no amounts on the sheet is flagged, with no floor', () => {
  // 7/16/26 item 79 INF26-25489: left out of the published total that week
  const s = summarizeItem(item(79, 'Resolution authorizing a Design-Build Services Agreement in the amount of $15,018,637.28',
    '40700.244600.563001.1002994\nWater Renewal and Replacement Fund.\nP: 1002994   O: WTR-Water Dept   T: 31   A: \n100453\n'));
  assert.equal(s.kind, 'spending');
  assert.equal(s.source, 'title');
  assert.equal(s.check, 'review');
  assert.equal(s.low, 0);
  assert.match(s.notes.join(), /\$15,018,637\.28/);
});

const contract = (number, amount) => item(number, `Resolution approving a contract in the amount of $${amount.toLocaleString('en-US')}`,
  `01100.225700.534000 $${amount.toLocaleString('en-US')} (Expenditure)\nGeneral Fund.\n`);

test('with nothing flagged the total is exact', () => {
  const s = stats([contract(20, 5000), contract(34, 2000000)]);
  assert.equal(s.spending.total, 2005000);
  assert.equal(s.spending.atLeast, 2005000);
  assert.deepEqual(s.spending.flagged, []);
  assert.deepEqual(s.range.unsettled, []);
});

test('flagged items reach no total or range, and atLeast holds however they settle', () => {
  const s = stats([
    contract(20, 5000),
    contract(34, 2000000),
    // 11/5/26 item 35: rows $30,000 short of the title
    item(35, 'Resolution approving the bid in the estimated amount of $1,098,900', '41400.240500.546000 $1,068,900 (Estimated Expenditure)\nSolid Waste.\n'),
    // 11/5/26 item 46: a vendor's services with only a revenue row
    item(46, 'Resolution authorizing an Amendment to the Agreement for Consultant Services with HNTB in the amount of $999,800',
      '30400.243000.331490.1002794 $999,800 (Revenue Increase)\nTransportation Grants.\n'),
  ]);
  assert.equal(s.spending.total, 2005000);
  assert.deepEqual(s.spending.flagged, [35, 46]);
  assert.equal(s.spending.atLeast, 3073900); // the lower figure for 35, nothing for 46
  assert.equal(s.revenue.total, 0);
  assert.equal(s.range.smallest.number, 20);
  assert.equal(s.range.largest.number, 34);
  assert.deepEqual(s.range.unsettled, []);
});

test('a flagged figure past a range end says that end is not settled', () => {
  const s = stats([
    contract(20, 5000),
    contract(34, 2000000),
    item(79, 'Resolution authorizing an Agreement in the amount of $15,018,637.28', '40700.244600.563001.1002994\nWater Fund.\n'),
  ]);
  assert.equal(s.range.largest.number, 34);
  assert.deepEqual(s.range.unsettled, [79]);
  assert.equal(s.spending.atLeast, 2005000);
});

test('a part with no amounts is not flagged when its linked twin carries them', () => {
  const s = stats([
    item(12, '(Part 1 of 2)(See Item 13) Resolution approving an Agreement in the amount of $625,000', '12500.228990.563001\nFund.\n'),
    item(13, '(Part 2 of 2)(See Item 12) Resolution making certain changes in the budget; transfer, reallocation, and/or appropriation of $625,000',
      '12500.228990.331211 $625,000 (Revenue)\nFund.\n12500.228990.563001 $625,000 (Expenditure Increase)\nFund.\n'),
  ]);
  assert.equal(s.spending.total, 625000);
  assert.deepEqual(s.review, []);
});

test('debt with several figures and none in the title is flagged, not taken at the largest', () => {
  // 11/5/26 item 49 INF26-28195
  const s = stats([
    item(49, 'Resolution relating to the Florida Department of Environmental Protection State Revolving Fund program; approving the Facilities Plan',
      '$20,000,000 - Loan\n', { fis: 'project financing of $20,000,000 with $400,000 capitalized, $20,400,000 total, and principal forgiveness of $10,000,000' }),
  ]);
  assert.equal(s.debt.count, 0);
  assert.deepEqual(s.review.map((r) => r.number), [49]);
  assert.deepEqual(s.spending.flagged, []); // debt doesn't touch the spending total
});

test('revenue stays revenue; a vendor contract with only a revenue row is flagged, not counted', () => {
  // 10/15/26 item 13 PS26-27659: the School Board pays the City for officers
  const paidToCity = summarizeItem(item(13, 'Resolution approving an agreement with the School Board in the amount of $2,753,683',
    '01100.228990.337200 $2,753,683 (Revenue)\nGeneral Fund.\n'));
  assert.equal(paidToCity.kind, 'revenue');
  assert.equal(paidToCity.check, 'verified');
  // 11/5/26 item 46 INF26-28139
  const vendor = summarizeItem(item(46, 'Resolution authorizing an Amendment to the Agreement for Consultant Services with HNTB in the amount of $999,800',
    '30400.243000.331490.1002794 $999,800 (Revenue Increase)\nTransportation Grants.\n'));
  assert.equal(vendor.kind, 'revenue');
  assert.equal(vendor.check, 'review');
});

test('a donation in kind is mentioned, not counted and not flagged', () => {
  // 5/21/26 item 5 PS26-23757
  const s = summarizeItem(item(5, 'Resolution approving the Instrument of Donation for one (1) horse with an estimated value of $7,000'));
  assert.equal(s.kind, 'none');
  assert.equal(s.mentioned, 7000);
  assert.notEqual(s.check, 'review');
});

test('linkedGroups joins See Item references and ignores dangling ones', () => {
  const items = [
    { number: 36, title: '(Part 1 of 3)(See Items 37, & 38)' },
    { number: 37, title: '(Part 2 of 3)(See Items 36 & 38)' },
    { number: 38, title: 'File No. X(Part 3 of 3)(See Item 37)' },
    { number: 71, title: '(Part 1 of 2)(See Item )' }, // 7/31/25 item 71
    { number: 80, title: '(Part 1 of 2)(See Item 999)' },
  ];
  assert.deepEqual(linkedGroups(items), [['36', '37', '38']]);
});

test('linked parts count once, as spending when either part is a contract', () => {
  // 11/5/26 items 47 and 48: both parts carry $919,215.46; a plain sum double-counts it
  const s = stats([
    item(47, '(Part 1 of 2)(See Item 48) Resolution approving Standard Grant Agreement for $800,000 and $119,215.46',
      '41410.239500.334302 $800,000 (Revenue)\n41410.239500.564001 $800,000 (Expenditure Increase)\n41400.239500.564001 $119,215.46 (Expenditure)\n'),
    item(48, '(Part 2 of 2)(See Item 47) Resolution making certain changes in the budget; approving the transfer, reallocation, and/or appropriation of $919,215.46',
      '41410.239500.334302 $800,000 (Revenue)\n41410.239500.564001 $800,000 (Expenditure Increase)\n41400.239500.564001 ($119,215.46) (Expenditure Decrease)\n41400.239500.564001 $119,215.46 (Expenditure Increase)\n'),
  ]);
  assert.equal(s.spending.total, 919215.46);
  assert.equal(s.spending.count, 1);
  assert.equal(s.reallocation.count, 0);
  assert.deepEqual(s.linked, [{ items: [47, 48], countedAs: 47, amount: 919215.46, kind: 'spending' }]);
});

test('a revenue-only first part and its appropriation count once', () => {
  // 11/5/26 items 10 and 11
  const s = stats([
    item(10, '(Part 1 of 2)(See Item 11) Resolution approving the grant for $200,000', '12500.228990.331211 $200,000 (Revenue)\nFund.\n'),
    item(11, '(Part 2 of 2)(See Item 10) Resolution making certain changes in the budget; transfer, reallocation, and/or appropriation of $200,000',
      '12500.228990.331211 $200,000 (Revenue)\nFund.\n12500.228990.540000 $200,000 (Expenditure Increase)\nFund.\n'),
  ]);
  assert.equal(s.spending.total, 200000);
  assert.equal(s.revenue.total, 0);
});

test('debt in a linked group keeps its own bucket', () => {
  // 9/3/26 items 38 and 39: South Howard appropriation and its reimbursement resolution
  const s = stats([
    item(38, '(Part 1 of 2)(See Item 39) Resolution approving a contract in the amount of $50,000', '31700.241800.563000 $50,000 (Expenditure)\nFund.\n'),
    item(39, '(Part 2 of 2)(See Item 38) Reimbursement Resolution not to exceed $26,000,000'),
  ]);
  assert.equal(s.spending.total, 50000);
  assert.equal(s.debt.total, 26000000);
  assert.deepEqual(s.linked, []);
});

test('the range runs through donations and skips nominal $1 deals', () => {
  // 6/4/26 item 10: "accepting a donation ... ($2,000)", the published low end that week
  const s = stats([
    item(10, 'Resolution accepting a donation in the amount of two thousand dollars ($2,000)', '01100.225700.366000 FY26 $2,000 (Revenue)\nGeneral Fund.\n'),
    item(18, 'Resolution approving a lease for $1', '01100.225700.534000 $1 (Expenditure)\nGeneral Fund.\n'),
    item(20, 'Resolution approving a contract in the amount of $5,000', '01100.225700.534000 $5,000 (Expenditure)\nGeneral Fund.\n'),
    item(21, 'Resolution assessing the costs of a lien', '01100.220700.354003 $500 (Revenue)\nGeneral Fund.\n'),
  ]);
  assert.equal(s.range.smallest.number, 10);
  assert.equal(s.range.largest.number, 20);
  assert.equal(s.spending.total, 5001); // the donation and the lien are revenue
  assert.equal(s.revenue.total, 2500);
});

test('counts and the no-data case', () => {
  const s = stats([
    item(1, 'Presentation of Commendation', '', { section: 'COMMENDATIONS AND\\OR PRESENTATIONS:' }),
    item(2, 'Resolution approving an appointment', '', { section: 'BOARD AND ADMINISTRATION APPOINTMENTS' }),
  ]);
  assert.equal(s.itemCount, 2);
  assert.equal(s.voteCount, 1);
  assert.deepEqual(s.noVoteItems.map((i) => i.number), [1]);
  assert.equal(s.hasProjectedCosts, false);
  assert.equal(s.range.smallest, null);
});
