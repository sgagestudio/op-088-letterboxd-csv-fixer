export const STATUS = {
  READY: 'ready_to_download',
  REVIEW: 'warning_review',
  UNSUPPORTED: 'unsupported_input'
};

export const KIND = {
  SAFE_AUTO_FIX: 'SAFE_AUTO_FIX',
  WARNING_REVIEW: 'WARNING_REVIEW',
  UNSUPPORTED: 'UNSUPPORTED'
};

const LETTERBOXD_HEADERS = ['Title', 'Year', 'imdbID', 'Rating10', 'WatchedDate', 'Tags'];
const KNOWN_IMDB = ['Const', 'Your Rating', 'Date Rated', 'Title', 'URL', 'Title Type', 'IMDb Rating', 'Runtime (mins)', 'Year', 'Genres', 'Num Votes', 'Release Date', 'Directors'];
const KNOWN_LB = ['Title', 'Year', 'imdbID', 'Rating', 'Rating10', 'WatchedDate', 'Tags', 'Review'];

export function transformCsv(input, opts = {}) {
  const filename = opts.filename || 'input.csv';
  const ext = extensionOf(filename);
  const raw = stripBom(String(input ?? ''));
  if (filename && ext && ext !== '.csv' && ext !== '.txt') return unsupported('unsupported_extension', `Unsupported extension ${ext}. Use .csv or pasted CSV text.`);
  if (!raw.trim()) return unsupported('empty_file', 'The CSV is empty.');
  if (/^\s*</.test(raw)) return unsupported('html_error_page', 'This looks like HTML, not CSV.');

  const parsed = parseCsv(raw);
  if (!parsed.ok) return unsupported('malformed_csv', parsed.error, parsed.partialRows || []);
  const { headers, rows } = parsed;
  if (!headers.length) return unsupported('missing_header', 'CSV header row is missing.');
  if (!rows.length) return unsupported('no_data_rows', 'CSV has headers but no data rows.');

  const mapping = detectMapping(headers);
  const headerIssues = validateMapping(mapping, headers);
  if (headerIssues.unsupported) return unsupported(headerIssues.code, headerIssues.message, rows);

  const outRows = [];
  const transformations = [];
  const warnings = [...headerIssues.warnings];
  let dataLoss = 0;
  let ambiguous = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const title = value(row, mapping.title);
    const year = value(row, mapping.year);
    const imdbID = normalizeImdbId(value(row, mapping.imdbID) || extractImdbId(value(row, mapping.url)) || value(row, mapping.const));
    const rating10 = normalizeRating10(value(row, mapping.rating10) || value(row, mapping.yourRating));
    const dateResult = normalizeDate(value(row, mapping.watchedDate) || value(row, mapping.dateRated) || value(row, mapping.date));

    if (!title && !imdbID) {
      warnings.push(warn(rowNumber, 'missing_title_and_id', 'Row has neither Title nor IMDb ID; Letterboxd matching may fail.', row));
      ambiguous += 1;
    }
    if (rating10.kind === KIND.WARNING_REVIEW) {
      warnings.push(warn(rowNumber, rating10.code, rating10.message, row));
      ambiguous += 1;
    }
    if (dateResult.kind === KIND.WARNING_REVIEW) {
      warnings.push(warn(rowNumber, dateResult.code, dateResult.message, row));
      ambiguous += 1;
    }

    const output = {
      Title: title,
      Year: fourDigitYear(year),
      imdbID,
      Rating10: rating10.value,
      WatchedDate: dateResult.value,
      Tags: 'imported-from-imdb'
    };
    outRows.push(output);

    const fields = [
      ['Title', title, title, 'preserve_title', 'Preserve original title'],
      ['Year', year, output.Year, 'normalize_year', 'Keep four-digit year when present'],
      ['imdbID', value(row, mapping.const) || value(row, mapping.url) || value(row, mapping.imdbID), imdbID, 'normalize_imdb_id', 'Letterboxd accepts imdbID exact matching'],
      ['Rating10', value(row, mapping.yourRating) || value(row, mapping.rating10), rating10.value, 'map_rating10', 'IMDb Your Rating is 1-10; Letterboxd supports Rating10'],
      ['WatchedDate', value(row, mapping.dateRated) || value(row, mapping.watchedDate) || value(row, mapping.date), dateResult.value, 'normalize_date', 'Letterboxd WatchedDate requires YYYY-MM-DD']
    ];
    fields.forEach(([field, original, transformed, rule, reason]) => {
      if (original || transformed) transformations.push({ row: rowNumber, field, originalValue: original, transformedValue: transformed, ruleApplied: rule, reason, kind: original === transformed ? 'PRESERVE' : KIND.SAFE_AUTO_FIX });
    });
  });

  const outputCsv = writeCsv(LETTERBOXD_HEADERS, outRows);
  const outputParsed = parseCsv(outputCsv);
  const roundTripOk = outputParsed.ok && outputParsed.rows.length === outRows.length && outputParsed.headers.join('|') === LETTERBOXD_HEADERS.join('|');
  if (!roundTripOk) dataLoss += 1;

  const status = warnings.length ? STATUS.REVIEW : STATUS.READY;
  return {
    status,
    code: warnings.length ? 'converted_with_warnings' : 'converted_ready',
    message: warnings.length ? 'CSV converted, but some rows need review before import.' : 'CSV converted to Letterboxd-compatible format.',
    headers,
    rowCount: rows.length,
    outputHeaders: LETTERBOXD_HEADERS,
    outputCsv,
    transformations,
    warnings,
    unsupported: [],
    dataLossCases: dataLoss,
    ambiguousTransformations: ambiguous,
    roundTrip: { ok: roundTripOk, rowCount: outputParsed.rows?.length ?? 0 },
    filename: 'letterboxd-import-fixed.csv'
  };
}

function detectMapping(headers) {
  const find = (...names) => names.map(n => headers.find(h => h.toLowerCase() === n.toLowerCase())).find(Boolean) || '';
  return {
    const: find('Const', 'imdbID'),
    imdbID: find('imdbID'),
    url: find('URL'),
    title: find('Title', 'Name'),
    year: find('Year'),
    yourRating: find('Your Rating', 'You rated'),
    rating10: find('Rating10'),
    watchedDate: find('WatchedDate', 'Watched Date'),
    dateRated: find('Date Rated', 'Created'),
    date: find('Date')
  };
}

function validateMapping(mapping, headers) {
  const warnings = [];
  const hasAnyKnown = headers.some(h => [...KNOWN_IMDB, ...KNOWN_LB].some(k => k.toLowerCase() === h.toLowerCase()));
  if (!hasAnyKnown) return { unsupported: true, code: 'unknown_csv_schema', message: 'No recognizable IMDb or Letterboxd columns found.' };
  if (!mapping.title && !mapping.const && !mapping.imdbID && !mapping.url) return { unsupported: true, code: 'missing_title_or_id', message: 'Need Title or IMDb identifier to create Letterboxd rows.' };
  if (!mapping.watchedDate && !mapping.dateRated && !mapping.date) warnings.push({ kind: KIND.WARNING_REVIEW, row: 1, code: 'missing_date_column', message: 'No date column found; WatchedDate will be empty and no diary dates will be created.' });
  return { unsupported: false, warnings };
}

function normalizeDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: KIND.WARNING_REVIEW, code: 'empty_date', message: 'Date is empty; WatchedDate left blank.', value: '' };
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { kind: KIND.SAFE_AUTO_FIX, value: `${iso[1]}-${iso[2]}-${iso[3]}` };
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const a = Number(slash[1]), b = Number(slash[2]), y = slash[3];
    if (a > 12 && b <= 12) return { kind: KIND.SAFE_AUTO_FIX, value: `${y}-${pad(b)}-${pad(a)}` };
    if (b > 12 && a <= 12) return { kind: KIND.SAFE_AUTO_FIX, value: `${y}-${pad(a)}-${pad(b)}` };
    return { kind: KIND.WARNING_REVIEW, code: 'ambiguous_slash_date', message: `Ambiguous slash date ${s}; not converted silently.`, value: s };
  }
  const dash = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dash) {
    const a = Number(dash[1]), b = Number(dash[2]), y = dash[3];
    if (a > 12 && b <= 12) return { kind: KIND.SAFE_AUTO_FIX, value: `${y}-${pad(b)}-${pad(a)}` };
    if (b > 12 && a <= 12) return { kind: KIND.SAFE_AUTO_FIX, value: `${y}-${pad(a)}-${pad(b)}` };
    return { kind: KIND.WARNING_REVIEW, code: 'ambiguous_dash_date', message: `Ambiguous dash date ${s}; not converted silently.`, value: s };
  }
  return { kind: KIND.WARNING_REVIEW, code: 'invalid_date', message: `Could not safely normalize date ${s}.`, value: s };
}

function normalizeRating10(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: KIND.WARNING_REVIEW, code: 'empty_rating', message: 'Rating is empty.', value: '' };
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 10) return { kind: KIND.SAFE_AUTO_FIX, value: String(n) };
  return { kind: KIND.WARNING_REVIEW, code: 'invalid_rating10', message: `Rating ${s} is not an integer from 1 to 10.`, value: s };
}

function normalizeImdbId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/tt\d{7,9}/i);
  return m ? m[0].toLowerCase() : s;
}
function extractImdbId(url) { return normalizeImdbId(url); }
function fourDigitYear(raw) { const m = String(raw || '').match(/\b(\d{4})\b/); return m ? m[1] : ''; }
function pad(n) { return String(n).padStart(2, '0'); }
function extensionOf(filename) { const m = String(filename || '').toLowerCase().match(/\.[^.]+$/); return m ? m[0] : ''; }
function stripBom(s) { return s.replace(/^\uFEFF/, ''); }
function value(row, key) { return key ? String(row[key] ?? '').trim() : ''; }
function warn(row, code, message, originalRow) { return { kind: KIND.WARNING_REVIEW, row, code, message, originalRow }; }
function unsupported(code, message, rows = []) { return { status: STATUS.UNSUPPORTED, code, message, rowCount: rows.length, outputCsv: '', transformations: [], warnings: [], unsupported: [{ kind: KIND.UNSUPPORTED, code, message }], dataLossCases: 0, ambiguousTransformations: 0, roundTrip: { ok: false, rowCount: 0 }, filename: '' }; }

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], next = s[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (inQuotes) return { ok: false, error: 'CSV has an unclosed quoted field.', partialRows: rows };
  row.push(field); rows.push(row);
  while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
  if (!rows.length) return { ok: true, headers: [], rows: [] };
  const headers = rows[0].map(h => stripBom(String(h).trim()));
  const data = rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return { ok: true, headers, rows: data };
}

export function writeCsv(headers, rows) {
  return [headers.join(','), ...rows.map(row => headers.map(h => csvCell(row[h] ?? '')).join(','))].join('\n') + '\n';
}
function csvCell(v) { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s; }

export const fixtures = [
  { id:'imdb-valid-iso', expected: STATUS.READY, csv:'Const,Your Rating,Date Rated,Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors\ntt0111161,10,2024-02-19,The Shawshank Redemption,https://www.imdb.com/title/tt0111161/,movie,9.3,142,1994,Drama,2900000,1994-09-10,Frank Darabont' },
  { id:'imdb-uk-date-safe', expected: STATUS.READY, csv:'Const,Your Rating,Date Rated,Title,Year\ntt0137523,9,19/02/2024,Fight Club,1999' },
  { id:'ambiguous-date', expected: STATUS.REVIEW, csv:'Const,Your Rating,Date Rated,Title,Year\ntt0068646,10,02/03/2024,The Godfather,1972' },
  { id:'empty-date', expected: STATUS.REVIEW, csv:'Const,Your Rating,Date Rated,Title,Year\ntt0109830,8,,Forrest Gump,1994' },
  { id:'invalid-rating', expected: STATUS.REVIEW, csv:'Const,Your Rating,Date Rated,Title,Year\ntt0109830,11,2024-02-19,Forrest Gump,1994' },
  { id:'letterboxd-compatible', expected: STATUS.READY, csv:'Title,Year,imdbID,Rating10,WatchedDate\nHeat,1995,tt0113277,9,2024-02-19' },
  { id:'quoted-comma', expected: STATUS.READY, csv:'Const,Your Rating,Date Rated,Title,Year\ntt0087884,8,2024-02-19,"Paris, Texas",1984' },
  { id:'html-error-page', expected: STATUS.UNSUPPORTED, csv:'<html><body>Error</body></html>' },
  { id:'unknown-schema', expected: STATUS.UNSUPPORTED, csv:'Foo,Bar\n1,2' }
];
