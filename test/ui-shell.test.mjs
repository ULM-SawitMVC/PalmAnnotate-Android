'use strict';

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const sessionsJs = readFileSync(new URL('../js/sessions.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');
const carousel = readFileSync(new URL('../css/carousel.css', import.meta.url), 'utf8');
const capture = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');

test('critical UI buttons exist and are wired to click handlers', () => {
  const requiredIds = [
    'btn-load-folder',
    'btn-load-folder-hero',
    'btn-load-session',
    'btn-capture-tree',
    'btn-capture-tree-hero',
    'btn-prev-tree',
    'btn-next-tree',
    'btn-pick-output-dir',
    'btn-pick-labels-dir',
    'btn-clear-labels-dir',
    'btn-cfg-confirm',
    'btn-save-output',
    'btn-delete-bbox',
    'btn-detect-side',
    'btn-toggle-magnifier',
    'btn-prev-pair',
    'btn-next-pair',
    'btn-run-suggestions',
    'btn-toggle-dedup-magnifier',
    'btn-toggle-dedup-suggestions',
    'btn-dedup-delete',
    'btn-toggle-panels',
    'btn-mismatch-cancel',
    'btn-mismatch-confirm',
    'btn-compute',
    'btn-export-yolo',
    'btn-export-json',
    'btn-export-csv',
    'btn-export-identity',
  ];

  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is present in index.html`);
  }

  const handlerChecks = [
    /btnLoadFolder\.addEventListener\('click', \(\) => _triggerLoadFolder\(\)\)/,
    /btnLoadFolderHero\.addEventListener\('click', \(\) => _triggerLoadFolder\(\)\)/,
    /btnLoadSession\.addEventListener\('click', \(\) => inputSession\.click\(\)\)/,
    /btnCaptureTree\)\s+btnCaptureTree\.addEventListener\('click', \(\) => _startCapture\(\)\)/,
    /btnCaptureTreeHero\)\s+btnCaptureTreeHero\.addEventListener\('click', \(\) => _startCapture\(\)\)/,
    /btnPrevTree\.addEventListener\('click', \(\) => _navigateTree\('prev'\)\)/,
    /btnNextTree\.addEventListener\('click', \(\) => _navigateTree\('next'\)\)/,
    /btnPickOutputDir\.addEventListener\('click', async \(\) =>/,
    /btnPickLabelsDir\.addEventListener\('click', async \(\) =>/,
    /btnClearLabelsDir\.addEventListener\('click', \(\) =>/,
    /btnCfgConfirm\.addEventListener\('click', async \(\) =>/,
    /btnSaveOutput\.addEventListener\('click', \(\) => _enqueueOperation/,
    /btnDeleteBbox\.addEventListener\('click', \(\) =>/,
    /btnDetectSide\.addEventListener\('click', \(\) => _detectCurrentSide\(\)\)/,
    /btnToggleMagnifier\.addEventListener\('click', \(\) =>/,
    /btnPrevPair\.addEventListener\('click', \(\) =>/,
    /btnNextPair\.addEventListener\('click', \(\) =>/,
    /btnRunSuggestions\.addEventListener\('click', \(\) =>/,
    /btnToggleDedupMagnifier\.addEventListener\('click', \(\) =>/,
    /btnToggleDedupSuggestions\.addEventListener\('click', \(\) =>/,
    /btnDedupDelete\.addEventListener\('click', \(\) =>/,
    /getElementById\('btn-toggle-panels'\)\.addEventListener\('click', \(\) =>/,
    /btnMismatchCancel\.addEventListener\('click', \(\) =>/,
    /btnMismatchConfirm\.addEventListener\('click', \(\) =>/,
    /btnCompute\.addEventListener\('click', \(\) => _enqueueOperation/,
    /btnExportYolo\.addEventListener\('click', \(\) =>/,
    /btnExportJSON\.addEventListener\('click', \(\) =>/,
    /btnExportCSV\.addEventListener\('click', \(\) =>/,
    /btnExportIdentity\.addEventListener\('click', \(\) =>/,
  ];

  for (const pattern of handlerChecks) {
    assert.match(app, pattern, `handler pattern missing: ${pattern}`);
  }
});

test('Android load/save flow is platform-aware instead of using web-only folder input', () => {
  assert.match(app, /function _triggerLoadFolder\(\)/);
  assert.match(app, /Storage\.isNative\(\)\s*\)\s*\{\s*_loadFolderNative\(\)/);
  assert.match(app, /DatasetManager\.loadFromAdapter\(\)/);
  assert.match(app, /ProjectConfig\.get\(\)\.hasOutputDir/);
  assert.match(app, /ProjectConfig\.get\(\)\.hasLabelsDir/);
  assert.match(app, /app-external PalmAnnotate|PalmAnnotate app storage/);
});

test('viewport and touch CSS cover Android phone and tablet targets', () => {
  assert.match(
    html,
    /<meta name="viewport" content="width=device-width, initial-scale=1\.0, viewport-fit=cover">/
  );
  assert.doesNotMatch(html, /maximum-scale|user-scalable\s*=\s*no/i);

  assert.match(app, /matchMedia && window\.matchMedia\('\(pointer: coarse\)'\)\.matches/);
  assert.match(app, /_activateTab\('carousel'\)/);

  assert.match(style, /min-height:\s*100dvh/);
  // Notch / cutout safety: viewport opts into the display cutout and the shell
  // pads itself with the safe-area insets so 9:16 phones don't clip content.
  assert.match(style, /env\(safe-area-inset-top\)/);
  assert.match(style, /env\(safe-area-inset-bottom\)/);
  assert.match(style, /\.editor-canvas,\s*\.dedup-canvas \{ touch-action: none; \}/);
  assert.match(carousel, /\.carousel-canvas[\s\S]*touch-action:\s*none/);
  assert.match(carousel, /\.carousel-stage[\s\S]*touch-action:\s*pan-y/);
  assert.match(capture, /env\(safe-area-inset-top\)/);
  assert.match(capture, /\.capture-btn[\s\S]*min-height:\s*56px/);
  assert.match(capture, /@media \(pointer: coarse\) and \(max-width: 480px\) and \(min-aspect-ratio: 9 \/ 20\) and \(max-aspect-ratio: 9 \/ 16\)[\s\S]*\.capture-preview__img[\s\S]*max-height:\s*54dvh/);
  assert.match(capture, /@media \(pointer: coarse\) and \(min-width: 900px\) and \(max-width: 1180px\) and \(max-aspect-ratio: 4 \/ 3\)[\s\S]*\.capture-panel[\s\S]*max-width:\s*620px/);

  for (const breakpoint of ['900px', '640px', '560px', '420px']) {
    assert.match(style, new RegExp(`@media \\(max-width: ${breakpoint}\\)`));
  }
  assert.match(capture, /@media \(max-width: 380px\)/);

  assert.match(style, /@media \(pointer: coarse\)[\s\S]*min-height:\s*44px/);
  assert.match(style, /@media \(pointer: coarse\) and \(max-width: 640px\)[\s\S]*\.annotation-layout[\s\S]*flex-direction:\s*column/);
  assert.match(style, /@media \(pointer: coarse\) and \(min-width: 641px\) and \(max-width: 1180px\)/);
  assert.match(style, /@media \(pointer: coarse\) and \(max-width: 480px\) and \(min-aspect-ratio: 9 \/ 20\) and \(max-aspect-ratio: 9 \/ 16\)[\s\S]*\.tabs[\s\S]*flex-wrap:\s*nowrap/);
  assert.match(style, /@media \(pointer: coarse\) and \(max-width: 480px\) and \(min-aspect-ratio: 9 \/ 20\) and \(max-aspect-ratio: 9 \/ 16\)[\s\S]*\.tree-save-status,\s*\.save-counter[\s\S]*display:\s*none/);
  assert.match(carousel, /@media \(pointer: coarse\) and \(max-width: 480px\) and \(min-aspect-ratio: 9 \/ 20\) and \(max-aspect-ratio: 9 \/ 16\)[\s\S]*\.crsl-thumbs[\s\S]*display:\s*none/);
  assert.match(carousel, /@media \(pointer: coarse\) and \(max-width: 480px\) and \(min-aspect-ratio: 9 \/ 20\) and \(max-aspect-ratio: 9 \/ 16\)[\s\S]*\.crsl-action[\s\S]*min-height:\s*44px/);
  assert.match(style, /@media \(pointer: coarse\) and \(min-aspect-ratio: 3 \/ 2\) and \(max-width: 1280px\)/);
  assert.match(style, /@media \(pointer: coarse\) and \(min-width: 900px\) and \(max-width: 1180px\) and \(max-aspect-ratio: 4 \/ 3\)/);
  assert.match(carousel, /@media \(pointer: coarse\) and \(min-width: 900px\) and \(max-width: 1180px\) and \(max-aspect-ratio: 4 \/ 3\)[\s\S]*\.crsl-thumb[\s\S]*width:\s*56px/);
});

test('capture-first session shell is present and wired (home ⇄ editor routing)', () => {
  // index.html ships the home container, the header Home button, and loads the
  // Sessions stylesheet + controller.
  assert.match(html, /<div class="home hidden" id="home-view">/);
  assert.match(html, /id="btn-home"/);
  assert.match(html, /<link rel="stylesheet" href="css\/sessions\.css">/);
  assert.match(html, /<script src="js\/sessions\.js"><\/script>/);
  // sessions.js must load before app.js (app wires SessionsUI on boot).
  assert.ok(
    html.indexOf('js/sessions.js') < html.indexOf('js/app.js'),
    'sessions.js loads before app.js'
  );

  // app.js routes between the Sessions home and the annotation editor, and
  // exposes the capture/open hooks SessionsUI calls.
  assert.match(app, /function _enterEditorView\(\)/);
  assert.match(app, /async function _showHome\(\)/);
  assert.match(app, /async function _capturePohon\(session\)/);
  assert.match(app, /async function _openPohonByName\(name, sessionId\)/);
  assert.match(app, /CaptureFlow\.start\(\{[\s\S]*session: \{[\s\S]*treeId: session\.nextId/);
  assert.match(app, /SessionsUI\.init\(\{[\s\S]*capture: \(session\) => _capturePohon\(session\)/);
  assert.match(app, /openPohon: \(name, sessionId\) => _openPohonByName\(name, sessionId\)/);
  assert.match(app, /if \(btnHome\)\s+btnHome\.addEventListener\('click', \(\) => _onHomeButton\(\)\)/);
  // The editor's Home button returns to the owning session when we came from one.
  assert.match(app, /function _onHomeButton\(\)[\s\S]*_showSessionDetail\(_activeSessionId\)/);
  assert.match(app, /async function _showSessionDetail\(id\)[\s\S]*SessionsUI\.showDetail\(id\)/);
  assert.match(app, /window\.PalmAnnotateHandleBack = function \(\)/);
  assert.match(app, /SessionsUI\.handleBack\(\)/);
  // Boot lands on the home view rather than auto-entering the editor.
  assert.match(app, /async function _bootView\(\)[\s\S]*_restoreCapturedTrees\(\)[\s\S]*_showHome\(\)/);
  assert.match(sessionsJs, /function handleBack\(\)[\s\S]*_view === 'detail'[\s\S]*_renderHome\(\)[\s\S]*return true/);
  assert.match(sessionsJs, /return \{ init, showHome, showDetail, refresh, handleBack \}/);

  // sessions.css carries the home/start/detail surfaces and header routing.
  const sessions = readFileSync(new URL('../css/sessions.css', import.meta.url), 'utf8');
  assert.match(sessions, /#home-view\.home/);
  assert.match(sessions, /body:not\(\.is-home\) #btn-home/);
  assert.match(sessions, /\.is-home #btn-load-folder/);
});

test('dedup help and global shortcuts are exposed for keyboard and touch operators', () => {
  assert.match(html, /id="btn-dedup-help"/);
  assert.match(html, /aria-label="Help"/);
  assert.match(html, /title="Click left bbox[\s\S]*Left\/Right arrows[\s\S]*1-4\s+change selected bbox class[\s\S]*Del\s+delete selected bbox"/);

  assert.match(app, /document\.addEventListener\('keydown', \(e\) =>/);
  assert.ok(app.includes("case '[':"), 'previous tree shortcut exists');
  assert.ok(app.includes("_navigateTree('prev')"), 'previous tree handler exists');
  assert.ok(app.includes("case ']':"), 'next tree shortcut exists');
  assert.ok(app.includes("_navigateTree('next')"), 'next tree handler exists');
  assert.match(app, /tab === 'dedup' && \(e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'\)/);
  assert.match(app, /DedupUI\.showPair\(_currentPair, 'left'\)/);
  assert.match(app, /DedupUI\.showPair\(_currentPair, 'right'\)/);
  assert.match(app, /case 'q': case 'Q':[\s\S]*_activateSidePill\(si\); _initEditor\(si\)/);
  assert.match(app, /case 'e': case 'E':[\s\S]*_activateSidePill\(si\); _initEditor\(si\)/);
  assert.match(app, /case 'r': case 'R':[\s\S]*ActiveSession\.runSuggestions\(\); DedupUI\.refresh\(\)/);
  assert.match(app, /case '1': case '2': case '3': case '4':[\s\S]*DedupUI\.changeSelectedClass\(e\.key\)/);
  assert.match(app, /case 'Delete': case 'Backspace':[\s\S]*DedupUI\.deleteSelected\(\)/);
});
