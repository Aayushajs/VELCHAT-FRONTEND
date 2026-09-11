/**
 * Visual formatting for the two Google Sheets tabs — same palette as the local Excel report
 * (build_excel_report.py), applied via the Sheets API's batchUpdate.
 *
 * Deliberately CONDITIONAL FORMATTING, not per-cell coloring written by push-pull.mjs: a rule like
 * "if this cell reads PASS, color it green" lives on the SHEET itself, so it colors a value the
 * instant a person types it in by hand — it doesn't wait for the next sync cycle to notice and
 * repaint. That matters here specifically because manual edits are the whole point of this sheet.
 *
 * Applied ONCE per spreadsheet (idempotent — checked via a marker in the developer metadata), so
 * re-running the sync a thousand times never stacks a thousand duplicate conditional-format rules.
 */
const HEADER_BG = { red: 0x1f / 255, green: 0x29 / 255, blue: 0x37 / 255 };
const WHITE = { red: 1, green: 1, blue: 1 };
const BAND_EVEN = { red: 0.98, green: 0.98, blue: 0.99 };

const COLORS = {
  PASS: {
    bg: { red: 0xd1 / 255, green: 0xfa / 255, blue: 0xe5 / 255 },
    fg: { red: 0x06 / 255, green: 0x5f / 255, blue: 0x46 / 255 },
  },
  FAIL: {
    bg: { red: 0xfe / 255, green: 0xe2 / 255, blue: 0xe2 / 255 },
    fg: { red: 0x99 / 255, green: 0x1b / 255, blue: 0x1b / 255 },
  },
  BLOCKED: {
    bg: { red: 0xfe / 255, green: 0xf3 / 255, blue: 0xc7 / 255 },
    fg: { red: 0x92 / 255, green: 0x40 / 255, blue: 0x0e / 255 },
  },
  SKIPPED: {
    bg: { red: 0xf3 / 255, green: 0xf4 / 255, blue: 0xf6 / 255 },
    fg: { red: 0x6b / 255, green: 0x72 / 255, blue: 0x80 / 255 },
  },
  FLAKY: {
    bg: { red: 0xff / 255, green: 0xed / 255, blue: 0xd5 / 255 },
    fg: { red: 0x9a / 255, green: 0x34 / 255, blue: 0x12 / 255 },
  },
  MANUAL: {
    bg: { red: 0xdb / 255, green: 0xea / 255, blue: 0xfe / 255 },
    fg: { red: 0x1e / 255, green: 0x3a / 255, blue: 0x8a / 255 },
  },
};

const SEVERITY_COLORS = {
  P0: { bg: { red: 0xdc / 255, green: 0x26 / 255, blue: 0x26 / 255 }, fg: WHITE },
  P1: { bg: { red: 0xf9 / 255, green: 0x73 / 255, blue: 0x16 / 255 }, fg: WHITE },
  P2: {
    bg: { red: 0xfb / 255, green: 0xbf / 255, blue: 0x24 / 255 },
    fg: { red: 0x1f / 255, green: 0x29 / 255, blue: 0x37 / 255 },
  },
  P3: {
    bg: { red: 0xd1 / 255, green: 0xd5 / 255, blue: 0xdb / 255 },
    fg: { red: 0x1f / 255, green: 0x29 / 255, blue: 0x37 / 255 },
  },
};

const BUG_STATUS_COLORS = {
  Open: {
    bg: { red: 0xfe / 255, green: 0xe2 / 255, blue: 0xe2 / 255 },
    fg: { red: 0x99 / 255, green: 0x1b / 255, blue: 0x1b / 255 },
  },
  'In Progress': {
    bg: { red: 0xfe / 255, green: 0xf3 / 255, blue: 0xc7 / 255 },
    fg: { red: 0x92 / 255, green: 0x40 / 255, blue: 0x0e / 255 },
  },
  Fixed: {
    bg: { red: 0xd1 / 255, green: 0xfa / 255, blue: 0xe5 / 255 },
    fg: { red: 0x06 / 255, green: 0x5f / 255, blue: 0x46 / 255 },
  },
  Closed: {
    bg: { red: 0xd1 / 255, green: 0xfa / 255, blue: 0xe5 / 255 },
    fg: { red: 0x06 / 255, green: 0x5f / 255, blue: 0x46 / 255 },
  },
  "Won't Fix": {
    bg: { red: 0xf3 / 255, green: 0xf4 / 255, blue: 0xf6 / 255 },
    fg: { red: 0x6b / 255, green: 0x72 / 255, blue: 0x80 / 255 },
  },
  Duplicate: {
    bg: { red: 0xf3 / 255, green: 0xf4 / 255, blue: 0xf6 / 255 },
    fg: { red: 0x6b / 255, green: 0x72 / 255, blue: 0x80 / 255 },
  },
};

const headerRequest = (sheetId, columnCount) => ({
  repeatCell: {
    range: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: 0,
      endColumnIndex: columnCount,
    },
    cell: {
      userEnteredFormat: {
        backgroundColor: HEADER_BG,
        textFormat: { foregroundColor: WHITE, bold: true, fontSize: 10 },
        verticalAlignment: 'MIDDLE',
        wrapStrategy: 'WRAP',
      },
    },
    fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)',
  },
});

const freezeAndFilter = (sheetId, columnCount, frozenColumnCount = 0) => [
  {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount } },
      fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
    },
  },
  {
    setBasicFilter: {
      filter: {
        range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: columnCount },
      },
    },
  },
];

const bandingRequest = (sheetId, columnCount) => ({
  addBanding: {
    bandedRange: {
      range: { sheetId, startRowIndex: 0, endColumnIndex: columnCount },
      rowProperties: { headerColor: HEADER_BG, firstBandColor: WHITE, secondBandColor: BAND_EVEN },
    },
  },
});

const wrapDataRequest = (sheetId, columnCount, columns) => ({
  repeatCell: {
    range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
    cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
    fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
  },
});

const widthRequest = (sheetId, columnIndex, pixelSize) => ({
  updateDimensionProperties: {
    range: { sheetId, dimension: 'COLUMNS', startIndex: columnIndex, endIndex: columnIndex + 1 },
    properties: { pixelSize },
    fields: 'pixelSize',
  },
});

/** One conditional-format rule: an exact-text match on `columnIndex` colors the WHOLE row's cell. */
function exactTextRule(sheetId, columnIndex, text, { bg, fg }, bold = true) {
  return {
    addConditionalFormatRule: {
      rule: {
        ranges: [
          {
            sheetId,
            startRowIndex: 1,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1,
          },
        ],
        booleanRule: {
          condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] },
          format: { backgroundColor: bg, textFormat: { foregroundColor: fg, bold } },
        },
      },
      index: 0,
    },
  };
}

/** Anything in `columnIndex` that ISN'T one of `knownValues` — i.e. a human typed something custom. */
function manualFallbackRule(sheetId, columnIndex, knownValues, colLetter) {
  const notEqual = knownValues.map((v) => `${colLetter}2<>"${v}"`).join(',');
  return {
    addConditionalFormatRule: {
      rule: {
        ranges: [
          {
            sheetId,
            startRowIndex: 1,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1,
          },
        ],
        booleanRule: {
          condition: {
            type: 'CUSTOM_FORMULA',
            values: [{ userEnteredValue: `=AND(${colLetter}2<>"",AND(${notEqual}))` }],
          },
          format: {
            backgroundColor: COLORS.MANUAL.bg,
            textFormat: { foregroundColor: COLORS.MANUAL.fg, bold: true, italic: true },
          },
        },
      },
      index: 0,
    },
  };
}

const tabColorRequest = (sheetId, color) => ({
  updateSheetProperties: { properties: { sheetId, tabColor: color }, fields: 'tabColor' },
});

export function testResultsFormatRequests(sheetId) {
  const cols = 7; // A..G
  const reqs = [
    tabColorRequest(sheetId, { red: 0x6d / 255, green: 0x28 / 255, blue: 0xd9 / 255 }), // violet — VelChat brand
    headerRequest(sheetId, cols),
    ...freezeAndFilter(sheetId, cols, 0),
    bandingRequest(sheetId, cols),
    wrapDataRequest(sheetId, cols),
    widthRequest(sheetId, 0, 420), // Test
    widthRequest(sheetId, 1, 140), // Device
    widthRequest(sheetId, 2, 220), // Result
    widthRequest(sheetId, 3, 90), // Bug
    widthRequest(sheetId, 4, 220), // Evidence
    widthRequest(sheetId, 5, 110), // Test ID
    widthRequest(sheetId, 6, 170), // Feature
  ];
  const statuses = ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'FLAKY'];
  for (const s of statuses) reqs.push(exactTextRule(sheetId, 2, s, COLORS[s]));
  reqs.push(manualFallbackRule(sheetId, 2, statuses, 'C'));
  // Bug column: bold red whenever it names an id.
  reqs.push({
    addConditionalFormatRule: {
      rule: {
        ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 }],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=D2<>"—"' }] },
          format: { textFormat: { foregroundColor: COLORS.FAIL.fg, bold: true } },
        },
      },
      index: 0,
    },
  });
  return reqs;
}

export function bugsFormatRequests(sheetId) {
  const cols = 27; // A..AA
  const reqs = [
    tabColorRequest(sheetId, { red: 0xdb / 255, green: 0x27 / 255, blue: 0x77 / 255 }), // pink — VelChat brand, distinct from Test Results
    headerRequest(sheetId, cols),
    ...freezeAndFilter(sheetId, cols, 1), // freeze Bug ID column too — helps when scrolling right
    bandingRequest(sheetId, cols),
    wrapDataRequest(sheetId, cols),
    widthRequest(sheetId, 0, 90), // Bug ID
    widthRequest(sheetId, 1, 90), // Jira ID
    widthRequest(sheetId, 3, 320), // Title
    widthRequest(sheetId, 6, 190), // Status
    widthRequest(sheetId, 16, 340), // Steps
    widthRequest(sheetId, 17, 300), // Expected
    widthRequest(sheetId, 18, 340), // Actual
    widthRequest(sheetId, 19, 300), // User Impact
    widthRequest(sheetId, 22, 260), // Evidence
  ];
  for (const [status, palette] of Object.entries(BUG_STATUS_COLORS))
    reqs.push(exactTextRule(sheetId, 6, status, palette));
  reqs.push(manualFallbackRule(sheetId, 6, Object.keys(BUG_STATUS_COLORS), 'G'));
  for (const [sev, palette] of Object.entries(SEVERITY_COLORS))
    reqs.push(exactTextRule(sheetId, 4, sev, palette));
  return reqs;
}
