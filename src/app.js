import { transformCsv, fixtures } from './transformer.js';
import { analytics, sizeBucket } from './analytics.js';

const state = { text: fixtures[0].csv, filename: 'ratings.csv', report: null, started: false };
const app = document.querySelector('#app');
analytics.markLanding();
render();

function markStarted(sourceType = 'paste') {
  if (!state.started) {
    state.started = true;
    analytics.track('tool_started', { source_type: sourceType });
  }
}

function resultEvent(report) {
  if (report.status === 'ready_to_download') return 'successful_result';
  if (report.status === 'warning_review') return 'warning_result';
  if (report.status === 'unsupported_input') return 'unsupported_result';
  return 'error';
}

function runTransform(sourceType = 'paste') {
  markStarted(sourceType);
  analytics.track('input_loaded', { source_type: sourceType, input_size_bucket: sizeBucket(state.text.length) });
  analytics.track('analysis_started', { source_type: sourceType });
  const startedAt = performance.now();
  try {
    state.report = transformCsv(state.text, { filename: state.filename });
    const elapsed = performance.now() - startedAt;
    const common = {
      status_code: state.report.status,
      warning_count: state.report.warnings?.length ?? 0,
      row_count_bucket: sizeBucket(state.report.rowCount ?? 0),
      ambiguous_count: state.report.warnings?.filter?.(w => String(w.code || '').includes('ambiguous'))?.length ?? 0,
      data_loss_flag: (state.report.dataLossCases ?? 0) > 0,
      elapsed_bucket: elapsed < 50 ? 'lt_50ms' : elapsed < 250 ? '50_250ms' : 'gte_250ms',
      source_type: sourceType
    };
    analytics.track('analysis_completed', common);
    analytics.track(resultEvent(state.report), common);
  } catch (error) {
    analytics.track('error', { error_code: 'transform_exception', source_type: sourceType });
    throw error;
  }
}

function render() {
  app.innerHTML = `
    <section class="hero">
      <p class="eyebrow">OP-088 · Limited public experiment</p>
      <h1>Fix your Letterboxd import CSV before you upload it.</h1>
      <p class="lede">Preflight an IMDb or compatible CSV, normalize safe fields and date formats, and download a Letterboxd-compatible CSV without silently changing ambiguous watched dates.</p>
      <div class="hero-actions"><a class="cta primary-link" href="#tool">Check my CSV</a><span class="privacy-chip">Runs locally in your browser</span></div>
      <p class="scope">This is a fixer/preflight utility. It does not replace Letterboxd’s official importer and it does not connect to your Letterboxd or IMDb account.</p>
    </section>

    <section class="value-grid" aria-label="How it works">
      <article><span>1</span><h2>Load a CSV</h2><p>Paste text or choose an IMDb/compatible CSV from your device.</p></article>
      <article><span>2</span><h2>Review safe fixes</h2><p>See normalized headers, ratings and dates, plus warnings for values that need human review.</p></article>
      <article><span>3</span><h2>Download the result</h2><p>Get a UTF-8 Letterboxd-compatible CSV and inspect the transformation report before importing.</p></article>
    </section>

    <section class="problem panel-copy">
      <p class="eyebrow">The problem</p>
      <h2>CSV imports fail quietly when headers, dates or quoting are wrong.</h2>
      <p>Letterboxd supports CSV and IMDb exports, but watched-date meaning matters. This tool checks the file before import, applies only deterministic fixes and flags ambiguous dates instead of guessing.</p>
    </section>

    <section class="example panel-copy" aria-label="Before and after example">
      <p class="eyebrow">Synthetic example</p>
      <h2>See exactly what changes before you download.</h2>
      <div class="example-grid">
        <div><h3>IMDb-style input</h3><pre>Const,Your Rating,Date Rated,Title,Year\ntt1375666,8,2024-01-02,Inception,2010</pre></div>
        <div><h3>Letterboxd-compatible output</h3><pre>Title,Year,imdbID,Rating10,WatchedDate,Tags\nInception,2010,tt1375666,8,2024-01-02,</pre></div>
      </div>
      <p class="muted">Synthetic example only. Ambiguous date formats are not silently rewritten.</p>
    </section>

    <section id="tool" class="grid">
      <div class="panel">
        <h2>Preflight / fix CSV</h2>
        <label>Open CSV <input id="file" type="file" accept=".csv,.txt,.html"></label>
        <textarea id="input" spellcheck="false" aria-label="CSV input"></textarea>
        <div class="actions">
          <button class="primary" id="transform">Analyze and fix</button>
          <button id="clear">Clear</button>
          ${state.report?.outputCsv ? '<button id="download">Download fixed CSV</button>' : ''}
        </div>
        <details class="fixture-box"><summary>Try synthetic examples</summary><div class="fixtures">${fixtures.map(f => `<button data-fixture="${f.id}">${escapeHtml(f.id)}</button>`).join('')}</div></details>
      </div>
      <div class="panel">
        <h2>Report</h2>
        <div id="report">${state.report ? reportHtml(state.report) : '<p class="muted">Run the preflight to see safe fixes, warnings and output integrity.</p>'}</div>
      </div>
    </section>

    <section class="details-grid">
      <article class="panel-copy"><p class="eyebrow">Supported inputs</p><h2>Focused scope</h2><ul><li>IMDb ratings/checkins-style CSV fields.</li><li>Letterboxd-compatible CSV columns.</li><li>UTF-8 CSV with quoted commas/newlines.</li><li>ISO dates and unambiguous slash/dash date normalization.</li></ul></article>
      <article class="panel-copy"><p class="eyebrow">Limitations</p><h2>No guessing</h2><ul><li>No account sync or API integration.</li><li>No movie metadata enrichment or title matching.</li><li>Ambiguous dates stay unchanged and require review.</li><li>Unsupported schemas are rejected rather than invented.</li></ul></article>
    </section>

    <section class="privacy panel-copy">
      <p class="eyebrow">Privacy</p>
      <h2>Your CSV stays on your device.</h2>
      <p>The transformation runs in the browser. The analytics design is limited to coarse usage events and must never include CSV content, movie titles, IMDb IDs, watched dates or filenames.</p>
    </section>

    <section class="faq panel-copy">
      <p class="eyebrow">FAQ</p>
      <h2>Before you import</h2>
      <details><summary>Does this import data into Letterboxd?</summary><p>No. It prepares a CSV for you to review and then import using Letterboxd’s official importer.</p></details>
      <details><summary>Will it change ambiguous dates automatically?</summary><p>No. Only deterministic date conversions are applied. Ambiguous values are preserved and marked for review.</p></details>
      <details><summary>Does it upload my CSV?</summary><p>No. The current tool processes the CSV locally in the browser.</p></details>
      <details><summary>What if Letterboxd still cannot match a film?</summary><p>This tool does not perform movie matching or metadata enrichment. Use Letterboxd’s import preview to review title matches.</p></details>
      <details><summary>Is this affiliated with Letterboxd or IMDb?</summary><p>No. It is an independent preflight/fixer utility.</p></details>
    </section>

    <section class="feedback panel-copy">
      <p class="eyebrow">Feedback — future launch</p>
      <h2>Found a CSV pattern the tool cannot classify?</h2>
      <p>A future feedback route may accept error codes or unsupported schema types. Raw CSV content should not be requested by default.</p>
    </section>

    <footer><p>Independent utility. Not affiliated with Letterboxd or IMDb. Final importing and title matching happen in Letterboxd.</p></footer>`;
  document.querySelector('#input').value = state.text;
  bind();
}

function bind() {
  document.querySelector('#input').addEventListener('focus', () => markStarted('paste'));
  document.querySelector('#input').addEventListener('input', e => { state.text = e.target.value; });
  document.querySelector('#file').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    markStarted('file');
    state.filename = file.name;
    state.text = await file.text();
    runTransform('file');
    render();
  });
  document.querySelector('#transform').addEventListener('click', () => {
    state.text = document.querySelector('#input').value;
    runTransform('paste');
    render();
  });
  document.querySelector('#clear').addEventListener('click', () => { state.text = ''; state.report = null; render(); });
  document.querySelector('#download')?.addEventListener('click', () => {
    analytics.track('download', {
      status_code: state.report.status,
      row_count_bucket: sizeBucket(state.report.rowCount ?? 0),
      warning_count: state.report.warnings?.length ?? 0,
      download_clicked: true
    });
    const blob = new Blob(['\uFEFF' + state.report.outputCsv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.report.filename || 'letterboxd-import-fixed.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
  document.querySelectorAll('[data-fixture]').forEach(btn => btn.addEventListener('click', () => {
    const fixture = fixtures.find(f => f.id === btn.dataset.fixture);
    state.filename = fixture.id.includes('html') ? 'error.html' : 'ratings.csv';
    state.text = fixture.csv;
    runTransform('fixture');
    render();
  }));
}

function reportHtml(r) {
  return `
    <p><span class="status ${r.status}">${escapeHtml(r.status)}</span></p>
    <dl>
      <div><dt>Code</dt><dd>${escapeHtml(r.code)}</dd></div>
      <div><dt>Rows</dt><dd>${r.rowCount ?? 0}</dd></div>
      <div><dt>Warnings</dt><dd>${r.warnings?.length ?? 0}</dd></div>
      <div><dt>Data loss</dt><dd>${r.dataLossCases ?? 0}</dd></div>
      <div><dt>Round trip</dt><dd>${r.roundTrip?.ok ? 'ok' : 'not-ok'}</dd></div>
    </dl>
    <p><strong>${escapeHtml(r.message)}</strong></p>
    ${r.outputCsv ? `<h3>Output preview</h3><pre id="output-preview">${escapeHtml(r.outputCsv.slice(0, 2000))}</pre>` : ''}
    ${r.transformations?.length ? `<h3>Transformations</h3><pre>${escapeHtml(JSON.stringify(r.transformations.slice(0, 20), null, 2))}</pre>` : ''}
    ${r.warnings?.length ? `<h3>Warnings / review</h3><pre>${escapeHtml(JSON.stringify(r.warnings.slice(0, 20), null, 2))}</pre>` : ''}
    ${r.unsupported?.length ? `<h3>Unsupported</h3><pre>${escapeHtml(JSON.stringify(r.unsupported, null, 2))}</pre>` : ''}`;
}
function escapeHtml(v) { return String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
