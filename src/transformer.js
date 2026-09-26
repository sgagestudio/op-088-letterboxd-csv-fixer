export const STATUS = {
  READY: 'ready_to_download',
  REVIEW: 'warning_review',
  UNSUPPORTED: 'unsupported_input'
};

export const KIND = {
  PRESERVED: 'PRESERVED',
  SAFELY_TRANSFORMED: 'SAFELY_TRANSFORMED',
  SAFE_AUTO_FIX: 'SAFE_AUTO_FIX',
  WARNING_REVIEW: 'WARNING_REVIEW',
  UNSUPPORTED: 'UNSUPPORTED'
};

export const LETTERBOXD_FIELDS = [
  'LetterboxdURI','tmdbID','imdbID','Title','Year','Directors',
  'Rating','Rating10','WatchedDate','Rewatch','Tags','Review'
];

const KNOWN_IMDB = [
  'Const','Your Rating','Date Rated','Title','URL','Title Type','IMDb Rating',
  'Runtime (mins)','Year','Genres','Num Votes','Release Date','Directors'
];

const ONE_MB = 1024 * 1024;

export function transformCsv(input, opts = {}) {
  const filename = opts.filename || 'input.csv';
  const treatDateRatedAsWatchedDate = opts.treatDateRatedAsWatchedDate === true;
  const ext = extensionOf(filename);
  const raw = stripBom(String(input ?? ''));

  if (filename && ext && ext !== '.csv' && ext !== '.txt') {
    return unsupported('unsupported_extension', `Unsupported extension ${ext}. Use .csv or pasted CSV text.`);
  }
  if (!raw.trim()) return unsupported('empty_file', 'The CSV is empty.');
  if (/^\s*</.test(raw)) return unsupported('html_error_page', 'This looks like HTML, not CSV.');

  const parsed = parseCsv(raw);
  if (!parsed.ok) return unsupported(parsed.code || 'malformed_csv', parsed.error, parsed.partialRows || []);
  const { headers, rows } = parsed;
  if (!headers.length) return unsupported('missing_header', 'CSV header row is missing.');
  if (!rows.length) return unsupported('no_data_rows', 'CSV has headers but no data rows.');

  const headerValidation = validateHeaders(headers);
  if (!headerValidation.ok) {
    return unsupported(headerValidation.code, headerValidation.message, rows);
  }

  const mapping = detectMapping(headers);
  const mappingValidation = validateMapping(mapping, headers);
  if (mappingValidation.unsupported) {
    return unsupported(mappingValidation.code, mappingValidation.message, rows);
  }

  const recognizedInputHeaders = headers.filter(isLetterboxdField);
  const outputHeaders = buildOutputHeaders(headers, mapping, treatDateRatedAsWatchedDate);
  const outRows = [];
  const transformations = [];
  const fieldAudit = [];
  const warnings = [...mappingValidation.warnings];
  let semanticDataLoss = 0;
  let ambiguous = 0;

  for (let index = 0; index < rows.length; index++) {
    const rowInfo = rows[index];
    const row = rowInfo.object;
    const rowNumber = index + 2;

    if (rowInfo.cells.length !== headers.length) {
      const code = rowInfo.cells.length > headers.length ? 'extra_csv_fields' : 'missing_csv_fields';
      warnings.push(warn(rowNumber, code,
        `Row has ${rowInfo.cells.length} values but header has ${headers.length}; conversion is not safe.`, rowInfo.cells));
      return unsupported(code, `Row ${rowNumber} has ${rowInfo.cells.length} values but header has ${headers.length}.`, rows);
    }

    const output = {};
    for (const h of outputHeaders) output[h] = '';

    // Preserve recognized Letterboxd fields first.
    for (const h of recognizedInputHeaders) {
      output[h] = rawValue(row, h);
      fieldAudit.push(audit(rowNumber, h, rawValue(row, h), output[h], KIND.PRESERVED, 'Recognized Letterboxd field preserved.'));
    }

    // Core matching fields from IMDb/compatible input.
    if (!recognizedInputHeaders.includes('Title') && mapping.title) {
      output.Title = rawValue(row, mapping.title);
      transformations.push(change(rowNumber, 'Title', rawValue(row, mapping.title), output.Title, 'map_title', 'Map source title to Letterboxd Title', KIND.SAFELY_TRANSFORMED));
    }
    if (!recognizedInputHeaders.includes('Year') && mapping.year) {
      const original = rawValue(row, mapping.year);
      const normalized = fourDigitYear(original);
      output.Year = normalized;
      transformations.push(change(rowNumber, 'Year', original, normalized, 'normalize_year', 'Keep a four-digit year when present', original === normalized ? KIND.PRESERVED : KIND.SAFELY_TRANSFORMED));
    }

    if (!recognizedInputHeaders.includes('imdbID')) {
      const original = rawValue(row, mapping.const) || rawValue(row, mapping.url);
      if (original) {
        output.imdbID = normalizeImdbId(original);
        transformations.push(change(rowNumber, 'imdbID', original, output.imdbID, 'normalize_imdb_id', 'Map IMDb identifier to Letterboxd imdbID', original === output.imdbID ? KIND.PRESERVED : KIND.SAFELY_TRANSFORMED));
      }
    }

    // Rating handling: preserve existing Letterboxd Rating/Rating10; map IMDb rating only if no Letterboxd rating is present.
    if (!recognizedInputHeaders.includes('Rating') && !recognizedInputHeaders.includes('Rating10') && mapping.yourRating) {
      const original = rawValue(row, mapping.yourRating);
      if (original) {
        const rr = normalizeRating10(original);
        output.Rating10 = rr.value;
        if (rr.kind === KIND.WARNING_REVIEW) {
          warnings.push(warn(rowNumber, rr.code, rr.message, original));
          ambiguous++;
        }
        transformations.push(change(rowNumber, 'Rating10', original, rr.value, 'map_rating10', 'Map IMDb Your Rating to Letterboxd Rating10', rr.kind === KIND.WARNING_REVIEW ? KIND.WARNING_REVIEW : KIND.SAFELY_TRANSFORMED));
      }
    }

    // Existing WatchedDate is handled independently from IMDb Date Rated.
    if (recognizedInputHeaders.includes('WatchedDate')) {
      const original = rawValue(row, 'WatchedDate');
      if (original) {
        const dr = normalizeDate(original);
        if (dr.kind === KIND.WARNING_REVIEW) {
          warnings.push(warn(rowNumber, dr.code, dr.message, original));
          ambiguous++;
          if (dr.impossible) {
            output.WatchedDate = '';
            semanticDataLoss++;
            fieldAudit.push(audit(rowNumber, 'WatchedDate', original, '', KIND.WARNING_REVIEW, 'Impossible calendar date removed from output and surfaced for review.'));
          } else {
            output.WatchedDate = original;
            fieldAudit.push(audit(rowNumber, 'WatchedDate', original, original, KIND.WARNING_REVIEW, 'Ambiguous/unrecognized date preserved for review.'));
          }
        } else {
          output.WatchedDate = dr.value;
          fieldAudit.push(audit(rowNumber, 'WatchedDate', original, dr.value, original === dr.value ? KIND.PRESERVED : KIND.SAFELY_TRANSFORMED, 'Validate/normalize existing WatchedDate.'));
        }
      }
    } else if (mapping.dateRated) {
      const original = rawValue(row, mapping.dateRated);
      if (treatDateRatedAsWatchedDate) {
        const dr = normalizeDate(original);
        if (dr.kind === KIND.WARNING_REVIEW) {
          warnings.push(warn(rowNumber, dr.code, dr.message, original));
          ambiguous++;
          output.WatchedDate = dr.impossible ? '' : original;
          if (dr.impossible) semanticDataLoss++;
          transformations.push(change(rowNumber, 'WatchedDate', original, output.WatchedDate, 'date_rated_to_watched_date', 'User explicitly chose to treat IMDb Date Rated as watched date; empty, ambiguous or invalid values require review.', KIND.WARNING_REVIEW));
        } else {
          output.WatchedDate = dr.value;
          transformations.push(change(rowNumber, 'WatchedDate', original, dr.value, 'date_rated_to_watched_date', 'User explicitly chose to treat IMDb Date Rated as watched date.', KIND.SAFELY_TRANSFORMED));
        }
      } else if (original) {
        warnings.push(warn(rowNumber, 'date_rated_not_watched_by_default', 'IMDb Date Rated is activity/rating time, not necessarily the real watched date. It was not copied to WatchedDate because the option is off.', original));
        transformations.push(change(rowNumber, 'Date Rated', original, original, 'preserve_date_rated_in_report', 'Date Rated is retained in the report only; user must explicitly opt in before it can become WatchedDate.', KIND.WARNING_REVIEW));
        ambiguous++;
      }
    }

    const title = output.Title || rawValue(row, mapping.title);
    const imdbID = output.imdbID || '';
    const tmdbID = output.tmdbID || '';
    const uri = output.LetterboxdURI || '';
    if (!title && !imdbID && !tmdbID && !uri) {
      return unsupported('missing_title_and_id', `Row ${rowNumber} has no recognized film matcher (LetterboxdURI, tmdbID, imdbID or Title).`, rows);
    }

    // Explicit audit for every recognized Letterboxd input field.
    for (const h of recognizedInputHeaders) {
      if (h === 'WatchedDate') continue;
      const original = rawValue(row, h);
      const transformed = output[h] ?? '';
      const classification = original === transformed ? KIND.PRESERVED : KIND.WARNING_REVIEW;
      fieldAudit.push(audit(rowNumber, h, original, transformed, classification,
        classification === KIND.PRESERVED ? 'Recognized Letterboxd field preserved.' : 'Recognized field changed; review required.'));
      if (original !== transformed) semanticDataLoss++;
    }

    outRows.push(output);
  }

  const outputCsv = writeCsv(outputHeaders, outRows);
  if (new TextEncoder().encode(outputCsv).length > ONE_MB) {
    warnings.push(warn(1, 'OUTPUT_EXCEEDS_LETTERBOXD_IMPORT_LIMIT',
      'Generated CSV exceeds approximately 1 MB. Letterboxd documents a 1 MB import limit; inspect the result and split it manually if needed.', ''));
  }

  const outputParsed = parseCsv(outputCsv);
  const structuralRoundTripOk = outputParsed.ok &&
    outputParsed.rows.length === outRows.length &&
    outputParsed.headers.join('|') === outputHeaders.join('|');

  if (!structuralRoundTripOk) semanticDataLoss++;

  // SAFE semantic invariant: no recognized Letterboxd field may be silently dropped.
  const silentKnownFieldLoss = fieldAudit.filter(x =>
    x.classification !== KIND.WARNING_REVIEW &&
    x.originalValue !== '' &&
    x.transformedValue === ''
  );
  if (silentKnownFieldLoss.length) semanticDataLoss += silentKnownFieldLoss.length;

  const status = warnings.length || semanticDataLoss > 0 ? STATUS.REVIEW : STATUS.READY;
  return {
    status,
    code: warnings.length || semanticDataLoss > 0 ? 'converted_with_warnings' : 'converted_ready',
    message: status === STATUS.READY
      ? 'CSV preflight completed with only preserved or safe transformations.'
      : 'CSV preflight completed, but one or more values need review before import.',
    headers,
    rowCount: rows.length,
    outputHeaders,
    outputCsv,
    transformations,
    fieldAudit,
    warnings,
    unsupported: [],
    structuralRoundTripOk,
    semanticDataLoss,
    dataLossCases: semanticDataLoss,
    ambiguousTransformations: ambiguous,
    roundTrip: { ok: structuralRoundTripOk, rowCount: outputParsed.rows?.length ?? 0 },
    outputBytes: new TextEncoder().encode(outputCsv).length,
    filename: 'letterboxd-import-fixed.csv',
    options: { treatDateRatedAsWatchedDate }
  };
}

function buildOutputHeaders(headers, mapping, treatDateRatedAsWatchedDate) {
  const out = [];
  for (const h of LETTERBOXD_FIELDS) if (headers.some(x => sameHeader(x, h))) out.push(h);
  if (!out.includes('Title') && mapping.title) out.push('Title');
  if (!out.includes('Year') && mapping.year) out.push('Year');
  if (!out.includes('imdbID') && (mapping.const || mapping.url)) out.push('imdbID');
  if (!out.includes('Rating') && !out.includes('Rating10') && mapping.yourRating) out.push('Rating10');
  if (!out.includes('WatchedDate') && mapping.dateRated && treatDateRatedAsWatchedDate) out.push('WatchedDate');
  return LETTERBOXD_FIELDS.filter(h => out.includes(h));
}

function detectMapping(headers) {
  const find = (...names) => names.map(n => headers.find(h => sameHeader(h, n))).find(Boolean) || '';
  return {
    const: find('Const'),
    url: find('URL'),
    title: find('Title', 'Name'),
    year: find('Year'),
    yourRating: find('Your Rating', 'You rated'),
    dateRated: find('Date Rated', 'Created')
  };
}

function validateHeaders(headers) {
  if (headers.some(h => !String(h).trim())) return { ok:false, code:'empty_header', message:'CSV contains an empty or whitespace-only header.' };
  const seen = new Set();
  for (const h of headers) {
    const key = h.trim().toLowerCase();
    if (seen.has(key)) return { ok:false, code:'duplicate_header', message:`CSV contains duplicate header: ${h}` };
    seen.add(key);
  }
  return { ok:true };
}

function validateMapping(mapping, headers) {
  const warnings = [];
  const hasKnown = headers.some(h => [...KNOWN_IMDB, ...LETTERBOXD_FIELDS].some(k => sameHeader(h, k)));
  if (!hasKnown) return { unsupported:true, code:'unknown_csv_schema', message:'No recognizable IMDb or Letterboxd columns found.' };
  const hasMatcher = headers.some(h => ['LetterboxdURI','tmdbID','imdbID','Title'].some(k => sameHeader(h,k))) || mapping.const || mapping.url || mapping.title;
  if (!hasMatcher) return { unsupported:true, code:'missing_title_or_id', message:'Need LetterboxdURI, tmdbID, imdbID or Title to create Letterboxd rows.' };
  return { unsupported:false, warnings };
}

export function normalizeDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind:KIND.WARNING_REVIEW, code:'empty_date', message:'Date is empty; no WatchedDate will be created.', value:'', impossible:false };

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const y=Number(iso[1]), m=Number(iso[2]), d=Number(iso[3]);
    if (!isRealDate(y,m,d)) return { kind:KIND.WARNING_REVIEW, code:'invalid_calendar_date', message:`Impossible calendar date ${s}; not written to WatchedDate.`, value:'', impossible:true };
    return { kind:KIND.SAFE_AUTO_FIX, value:`${iso[1]}-${iso[2]}-${iso[3]}`, impossible:false };
  }

  const m = s.match(/^(\d{1,2})([\/-])(\d{1,2})\2(\d{4})$/);
  if (m) {
    const a=Number(m[1]), b=Number(m[3]), y=Number(m[4]);
    if (a > 12 && b <= 12) {
      if (!isRealDate(y,b,a)) return { kind:KIND.WARNING_REVIEW, code:'invalid_calendar_date', message:`Impossible calendar date ${s}; not written to WatchedDate.`, value:'', impossible:true };
      return { kind:KIND.SAFE_AUTO_FIX, value:`${y}-${pad(b)}-${pad(a)}`, impossible:false };
    }
    if (b > 12 && a <= 12) {
      if (!isRealDate(y,a,b)) return { kind:KIND.WARNING_REVIEW, code:'invalid_calendar_date', message:`Impossible calendar date ${s}; not written to WatchedDate.`, value:'', impossible:true };
      return { kind:KIND.SAFE_AUTO_FIX, value:`${y}-${pad(a)}-${pad(b)}`, impossible:false };
    }
    if (a < 1 || b < 1 || a > 31 || b > 31) return { kind:KIND.WARNING_REVIEW, code:'invalid_calendar_date', message:`Impossible calendar date ${s}; not written to WatchedDate.`, value:'', impossible:true };
    return { kind:KIND.WARNING_REVIEW, code:m[2] === '/' ? 'ambiguous_slash_date' : 'ambiguous_dash_date', message:`Ambiguous date ${s}; not reinterpreted silently.`, value:s, impossible:false };
  }

  return { kind:KIND.WARNING_REVIEW, code:'invalid_date', message:`Could not safely normalize date ${s}.`, value:s, impossible:false };
}

function isRealDate(y,m,d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1) return false;
  const days = [31, isLeapYear(y)?29:28, 31,30,31,30,31,31,30,31,30,31];
  return d <= days[m-1];
}
function isLeapYear(y) { return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); }

function normalizeRating10(raw) {
  const s=String(raw||'').trim();
  if (!s) return { kind:KIND.WARNING_REVIEW, code:'empty_rating', message:'Rating is empty.', value:'' };
  const n=Number(s);
  if (Number.isInteger(n) && n>=1 && n<=10) return { kind:KIND.SAFE_AUTO_FIX, value:String(n) };
  return { kind:KIND.WARNING_REVIEW, code:'invalid_rating10', message:`Rating ${s} is not an integer from 1 to 10.`, value:s };
}

function isLetterboxdField(h) { return LETTERBOXD_FIELDS.some(k => sameHeader(h,k)); }
function sameHeader(a,b) { return String(a||'').trim().toLowerCase() === String(b||'').trim().toLowerCase(); }
function canonicalHeader(h) { return LETTERBOXD_FIELDS.find(k => sameHeader(h,k)) || h; }
function normalizeImdbId(raw) { const s=String(raw||'').trim(); if(!s)return ''; const m=s.match(/tt\d{7,9}/i); return m?m[0].toLowerCase():s; }
function fourDigitYear(raw) { const m=String(raw||'').match(/\b(\d{4})\b/); return m?m[1]:String(raw||'').trim(); }
function pad(n){return String(n).padStart(2,'0');}
function extensionOf(filename){const m=String(filename||'').toLowerCase().match(/\.[^.]+$/);return m?m[0]:'';}
function stripBom(s){return s.replace(/^\uFEFF/,'');}
function rawValue(row,key){return key?String(row[key]??'').trim():'';}
function warn(row,code,message,originalValue){return {kind:KIND.WARNING_REVIEW,row,code,message,originalValue};}
function change(row,field,originalValue,transformedValue,ruleApplied,reason,kind){return {row,field,originalValue,transformedValue,ruleApplied,reason,kind};}
function audit(row,field,originalValue,transformedValue,classification,reason){return {row,field,originalValue,transformedValue,classification,reason};}
function unsupported(code,message,rows=[]){return {status:STATUS.UNSUPPORTED,code,message,rowCount:rows.length,outputCsv:'',transformations:[],fieldAudit:[],warnings:[],unsupported:[{kind:KIND.UNSUPPORTED,code,message}],structuralRoundTripOk:false,semanticDataLoss:0,dataLossCases:0,ambiguousTransformations:0,roundTrip:{ok:false,rowCount:0},outputBytes:0,filename:''};}

export function parseCsv(text) {
  const rawRows=[]; let row=[],field='',inQuotes=false;
  const s=String(text||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  for(let i=0;i<s.length;i++){
    const ch=s[i],next=s[i+1];
    if(inQuotes){
      if(ch==='"'&&next==='"'){field+='"';i++;}
      else if(ch==='"') inQuotes=false;
      else field+=ch;
    }else{
      if(ch==='"') inQuotes=true;
      else if(ch===','){row.push(field);field='';}
      else if(ch==='\n'){row.push(field);rawRows.push(row);row=[];field='';}
      else field+=ch;
    }
  }
  if(inQuotes) return {ok:false,code:'malformed_csv',error:'CSV has an unclosed quoted field.',partialRows:rawRows};
  row.push(field); rawRows.push(row);
  while(rawRows.length&&rawRows[rawRows.length-1].every(c=>c==='')) rawRows.pop();
  if(!rawRows.length) return {ok:true,headers:[],rows:[]};

  const headers=rawRows[0].map(h=>canonicalHeader(stripBom(String(h).trim())));
  const hv=validateHeaders(headers);
  if(!hv.ok) return {ok:false,code:hv.code,error:hv.message,partialRows:rawRows.slice(1)};

  const rows=[];
  for(let i=1;i<rawRows.length;i++){
    const cells=rawRows[i];
    const object={};
    headers.forEach((h,j)=>{object[h]=cells[j]??'';});
    rows.push({cells,object});
  }
  return {ok:true,headers,rows};
}

export function writeCsv(headers, rows) {
  return [headers.map(csvCell).join(','),...rows.map(row=>headers.map(h=>csvCell(row[h]??'')).join(','))].join('\n')+'\n';
}
function csvCell(v){const s=String(v);return /[",\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;}

export const fixtures = [
  {id:'imdb-date-rated-default-off',expected:STATUS.REVIEW,csv:'Const,Your Rating,Date Rated,Title,Year\ntt0111161,10,2024-02-19,The Shawshank Redemption,1994'},
  {id:'imdb-date-rated-opt-in',expected:STATUS.READY,options:{treatDateRatedAsWatchedDate:true},csv:'Const,Your Rating,Date Rated,Title,Year\ntt0137523,9,19/02/2024,Fight Club,1999'},
  {id:'ambiguous-date',expected:STATUS.REVIEW,options:{treatDateRatedAsWatchedDate:true},csv:'Const,Your Rating,Date Rated,Title,Year\ntt0068646,10,02/03/2024,The Godfather,1972'},
  {id:'letterboxd-compatible',expected:STATUS.READY,csv:'Title,Year,imdbID,Rating10,WatchedDate,Tags,Review\nHeat,1995,tt0113277,9,2024-02-19,noir,"Great film"'},
  {id:'quoted-comma',expected:STATUS.REVIEW,csv:'Const,Your Rating,Date Rated,Title,Year\ntt0087884,8,2024-02-19,"Paris, Texas",1984'},
  {id:'html-error-page',expected:STATUS.UNSUPPORTED,csv:'<html><body>Error</body></html>'},
  {id:'unknown-schema',expected:STATUS.UNSUPPORTED,csv:'Foo,Bar\n1,2'}
];
