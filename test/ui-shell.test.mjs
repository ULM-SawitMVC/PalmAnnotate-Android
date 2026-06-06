'use strict';

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const sessionsJs = readFileSync(new URL('../js/sessions.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');
const carousel = readFileSync(new URL('../css/carousel.css', import.meta.url), 'utf8');
const uxCompact = readFileSync(new URL('../css/ux-compact.css', import.meta.url), 'utf8');
const capture = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');
const captureFlow = readFileSync(new URL('../js/capture/capture-flow.js', import.meta.url), 'utf8');
const sessionsCss = readFileSync(new URL('../css/sessions.css', import.meta.url), 'utf8');
const themeLight = readFileSync(new URL('../css/theme-light.css', import.meta.url), 'utf8');

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
    'btn-toggle-boxes',
    'btn-prev-pair',
    'btn-next-pair',
    'btn-run-suggestions',
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
    /btnToggleBoxes\.addEventListener\('click', \(\) =>/,
    /btnPrevPair\.addEventListener\('click', \(\) =>/,
    /btnNextPair\.addEventListener\('click', \(\) =>/,
    /btnRunSuggestions\.addEventListener\('click', \(\) =>/,
    /btnToggleDedupSuggestions\.addEventListener\('click', \(\) =>/,
    /btnDedupDelete\.addEventListener\('click', \(\) =>/,
    /getElementById\('btn-toggle-panels'\)\.addEventListener\('click', \(\) =>/,
    /btnMismatchCancel\.addEventListener\('click', \(\) =>/,
    /btnMismatchConfirm\.addEventListener\('click', \(\) =>/,
    /btnCompute\.addEventListener\('click', \(\) => _enqueueOperation/,
    /btnExportYolo\.addEventListener\('click', async \(\) =>/,
    /btnExportJSON\.addEventListener\('click', async \(\) =>/,
    /btnExportCSV\.addEventListener\('click', async \(\) =>/,
    /btnExportIdentity\.addEventListener\('click', async \(\) =>/,
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

  // Single-screen shell viewport safety: the brand header is hidden to reclaim
  // space, the stage is allowed to shrink (min-height:0), the bottom controls are
  // pinned (flex:0 0 auto), and the links list stays one scrollable row — so the
  // Next/Save action row can never be pushed off the viewport by cross-links.
  assert.match(carousel, /body\.crsl-shell \.header \{ display: none; \}/);
  assert.match(carousel, /body\.crsl-shell \.carousel-stage \{ flex: 1 1 0; min-height: 0; \}/);
  assert.match(carousel, /body\.crsl-shell \.carousel-bottom \{ flex: 0 0 auto/);
  assert.match(carousel, /body\.crsl-shell \.crsl-links \{ flex-wrap: nowrap; overflow-x: auto/);
  assert.match(html, /<link rel="stylesheet" href="css\/ux-compact\.css">/);
  assert.match(uxCompact, /body\.crsl-shell \.carousel-topbar[\s\S]*position:\s*absolute/);
  assert.match(uxCompact, /body\.crsl-shell \.crsl-classbar[\s\S]*position:\s*absolute[\s\S]*flex-direction:\s*column/);
  assert.match(uxCompact, /body\.crsl-shell \.crsl-actionrow[\s\S]*flex-wrap:\s*nowrap/);
});

// Regression: on the tablet shell the revealed editor tabs (More → Editor tools)
// used to be a `position: absolute` floating overlay. Tapping "Save Output Again"
// rendered the Results stat cards into the panel, which overpainted/clipped the
// floating bar — the tabs visually vanished and the operator could not switch
// back to Annotate/Editor/Dedup. The fix docks the bar IN-FLOW so it always
// reserves its own height and can never be overpainted by panel content.
test('revealed editor tabs stay docked in-flow so they cannot vanish behind panel content', () => {
  // Isolate the rule block for the revealed tab bar.
  const m = uxCompact.match(/body\.crsl-shell\.crsl-show-tabs \.tabs\s*\{([\s\S]*?)\}/);
  assert.ok(m, 'expected a body.crsl-shell.crsl-show-tabs .tabs rule');
  const rule = m[1];

  // It must be in-flow (relative), reserve space, and must NOT float (absolute),
  // which is what let Results content paint over it.
  assert.match(rule, /position:\s*relative/);
  assert.doesNotMatch(rule, /position:\s*absolute/);
  assert.match(rule, /flex:\s*0 0 auto/);

  // Results must scroll within the remaining height and show a friendly empty
  // state instead of a black void when nothing has been computed yet.
  assert.match(uxCompact, /body\.crsl-shell #results-container[\s\S]*overflow-y:\s*auto/);
  assert.match(uxCompact, /body\.crsl-shell #results-container:empty::after/);

  // The shell tags <body> with the active tab so chrome can be positioned
  // per-panel (e.g. nudging the carousel topbar below the docked bar).
  assert.match(app, /classList\.toggle\('crsl-tab-'\s*\+\s*n/);
});

// Regression: the capture "Review views" screen used to be a narrow 760px card
// with the photo capped at max-height:56vh + object-fit:contain — small,
// letterboxed/cropped on a tablet, with the per-slide Retake clipped. It's now an
// immersive full-bleed layout: the image strip flexes to fill, the photo is
// uncropped, and Retake floats over the photo so it can't be clipped.
test('capture Review views is immersive, full-bleed, and un-clips Retake', () => {
  // Image strip fills the height between the top strip and the bottom bar.
  const stripRule = capture.match(/\.capture-reviewall__strip\s*\{([\s\S]*?)\}/);
  assert.ok(stripRule, 'expected a .capture-reviewall__strip rule');
  assert.match(stripRule[1], /flex:\s*1/);

  // The photo is large + uncropped, not capped at the old 56vh letterbox.
  const imgRule = capture.match(/\.capture-reviewall__img\s*\{([\s\S]*?)\}/);
  assert.ok(imgRule, 'expected a .capture-reviewall__img rule');
  assert.match(imgRule[1], /object-fit:\s*contain/);
  assert.doesNotMatch(imgRule[1], /max-height:\s*56vh/);

  // Retake floats over the photo (absolute) so the strip can't clip it.
  assert.match(capture, /\.capture-reviewall__retake\s*\{[\s\S]*?position:\s*absolute/);

  // The immersive structure (top strip + page dots) is built in JS.
  assert.match(captureFlow, /capture-reviewall--immersive/);
  assert.match(captureFlow, /capture-reviewall__topbar/);
  assert.match(captureFlow, /capture-reviewall__dots/);
  // Button texts the capture-flow tests click by name are preserved.
  assert.match(captureFlow, /'capture-btn capture-btn--outline capture-reviewall__retake', 'Retake'/);
});

// Sessions home / session-detail lists tile into a responsive card grid on wide
// tablets instead of a tall single column wasting the horizontal space.
test('sessions lists become a responsive card grid on wide tablets', () => {
  assert.match(
    sessionsCss,
    /@media \(pointer: coarse\) and \(min-width: 720px\)[\s\S]*\.session-list,\s*\n\s*\.pohon-list\s*\{[\s\S]*?display:\s*grid[\s\S]*?auto-f(it|ill)/,
  );
});

// Centralized theming: all glass/overlay/scrim/on-accent colours are design
// tokens in style.css :root (single source of truth), and the light theme is a
// pure token re-definition — no per-selector repainting. This is the structural
// guard against colours drifting back into scattered hardcoded rgba().
test('design colours are centralized tokens, and light mode flips them in one place', () => {
  // The semantic tokens exist as a single source of truth.
  for (const tok of ['--c-overlay', '--c-glass', '--c-glass-strong', '--c-glass-soft',
                      '--c-scrim', '--c-on-media', '--c-on-accent']) {
    assert.match(style, new RegExp(tok + ':\\s*'), `style.css :root must define ${tok}`);
  }
  // The chrome references the tokens instead of hardcoding dark rgba.
  assert.match(style, /\.header\s*\{[\s\S]*background:\s*var\(--c-glass\)/);
  assert.match(uxCompact, /\.carousel-topbar[\s\S]*background:\s*linear-gradient\([^)]*var\(--c-glass/);
  assert.match(uxCompact, /\.crsl-classbar[\s\S]*background:\s*var\(--c-glass\)/);
  assert.match(capture, /\.capture-overlay[\s\S]*background:\s*var\(--c-overlay\)/);

  // Light theme: loaded last, scheme-declared, system-driven.
  assert.match(html, /<link rel="stylesheet" href="css\/theme-light\.css">/);
  assert.match(html, /<meta name="color-scheme" content="dark light">/);
  assert.ok(
    html.indexOf('css/theme-light.css') > html.indexOf('css/ux-compact.css'),
    'theme-light.css must load after ux-compact.css',
  );
  assert.match(themeLight, /@media \(prefers-color-scheme: light\)/);
  assert.match(themeLight, /color-scheme:\s*light/);
  // It flips the tokens (surfaces, glass, on-accent) in one place …
  assert.match(themeLight, /:root\s*\{[\s\S]*--c-bg:\s*#/);
  assert.match(themeLight, /--c-glass:\s*rgba\(255/);
  assert.match(themeLight, /--c-on-accent:\s*#ffffff/);
  // Capture chrome follows light mode like everything else — NO forced-dark
  // re-pin of the overlay (that made the whole capture screen read as dark mode
  // even when the system was light). Only the photo/camera viewport stays black,
  // which is a media backdrop in capture.css, not a theme token.
  assert.doesNotMatch(themeLight, /\.capture-overlay\s*\{[\s\S]*--c-glass:\s*rgba\(7/);
  assert.match(capture, /\.capture-reviewall__slide[\s\S]*background:\s*#000/);

  // Toasts read off theme tokens (text = --c-text, type = token-coloured
  // border) so they stay legible in light mode — no hardcoded light tints that
  // vanish on the white light-mode surface.
  assert.match(style, /\.toast\s*\{[\s\S]*color:\s*var\(--c-text\)/);
  assert.match(style, /\.toast--success\s*\{\s*border-left:\s*3px solid var\(--c-emerald\)/);
  assert.match(style, /\.toast--error\s*\{\s*border-left:\s*3px solid var\(--c-red\)/);
  assert.doesNotMatch(style, /\.toast--success\s*\{[\s\S]*#bbf7d0/);
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

test('revealed editor-tools bar has a close (x) control wired to hide it', () => {
  // The operator could only dismiss the revealed tabs by reopening
  // More -> Editor tools. There must be an explicit close button now.
  assert.match(html, /id="tabs-close"/);
  assert.match(app, /getElementById\('tabs-close'\)/);
  assert.match(app, /classList\.remove\('crsl-show-tabs'\)/);
  // CSS: hidden by default, shown only on the carousel shell when tabs revealed.
  assert.match(uxCompact, /\.tab-close\s*\{\s*display:\s*none/);
  assert.match(uxCompact, /body\.crsl-shell\.crsl-show-tabs \.tab-close/);
});

test('capture review pre-save check: honest issue count + GPS recovery button', () => {
  // Badge must count the SHOWN (non-info) issues, not the raw list — otherwise a
  // hidden info note made it read "2 issue(s)" with only one line explained.
  assert.match(captureFlow, /const shown = \(report\.issues \|\| \[\]\)\.filter\(i => i\.level !== 'info'\)/);
  assert.match(captureFlow, /shown\.length \? `\$\{shown\.length\} issue\(s\)` : 'OK'/);
  // A "Get GPS" button appears on review when GPS is missing, wired to a fetch.
  assert.match(captureFlow, /capture-qa__gps/);
  assert.match(captureFlow, /'Get GPS'/);
  assert.match(captureFlow, /async function _handleGps/);
  assert.match(captureFlow, /metadata\.gps = gps; _refreshQa\(\)/);
  // CSS for the button exists.
  assert.match(capture, /\.capture-qa__gps/);
});

test('Next tree cancel returns to the session tree list, not the previous annotation', () => {
  // Cancelling the camera during Next tree must navigate to the owning session
  // detail, not strand the operator in the just-saved previous tree.
  assert.match(app, /const tree = await _capturePohon\(session\);\s*\n\s*if \(!tree\) \{[\s\S]*_showSessionDetail\(sessionId\)/);
});

test('portrait: redundant global header is hidden on the home/session views', () => {
  // Home/Start/Detail carry their own header; in portrait the global header's
  // brand text is hidden, which used to leave an orphaned lone logo top-left.
  assert.match(style, /body\.is-home \.header\s*\{\s*display:\s*none/);
});

test('landscape-required tabs show a rotate gate in portrait', () => {
  // Markup + an escape to the touch carousel.
  assert.match(html, /id="rotate-gate"/);
  assert.match(html, /id="rotate-gate-annotate"/);
  assert.match(app, /getElementById\('rotate-gate-annotate'\)/);
  assert.match(app, /_activateTab\('carousel'\)/);
  // Hidden by default; shown only in portrait, only on the width-hungry classic
  // tabs, never on the home views (which may leave a stale crsl-tab-* class).
  assert.match(style, /\.rotate-gate\s*\{[\s\S]*display:\s*none/);
  assert.match(style, /@media \(orientation: portrait\)[\s\S]*body:not\(\.is-home\)\.crsl-tab-annotation \.rotate-gate/);
  assert.match(style, /body:not\(\.is-home\)\.crsl-tab-dedup \.rotate-gate/);
  assert.match(style, /body:not\(\.is-home\)\.crsl-tab-results \.rotate-gate/);
  // The portrait-friendly Annotate carousel is NOT gated.
  assert.doesNotMatch(style, /crsl-tab-carousel \.rotate-gate/);
});

test('over-media capture controls use on-media tokens, not theme-flipping ones', () => {
  // The Cancel / Find camera / source controls sit over the live camera (dark in
  // both themes). They must read light regardless of app theme, so they use the
  // on-media token family — NOT --c-text/--c-border-hover which flip in light mode.
  assert.match(style, /--c-on-media-border:\s*rgba\(255,\s*255,\s*255/);
  // The on-media border token must NOT be redefined by the light theme (stays light).
  assert.doesNotMatch(themeLight, /--c-on-media-border/);
  for (const sel of ['.capture-live__cancel', '.capture-live__refresh', '.capture-cam__cancel']) {
    const block = capture.slice(capture.indexOf(sel));
    const decl = block.slice(0, block.indexOf('}'));
    assert.match(decl, /color:\s*var\(--c-on-media\)/, `${sel} text uses --c-on-media`);
    assert.doesNotMatch(decl, /color:\s*var\(--c-text\)/, `${sel} must not use flipping --c-text`);
  }
  // Top-bar title/subtitle over the camera are pinned to on-media too.
  assert.match(capture, /\.capture-live__top \.capture-title[\s\S]*?color:\s*var\(--c-on-media\)/);
});

test('unassigned class: no default, grey render, YOLO-skip, status + behaviour log', () => {
  const yolo = readFileSync(new URL('../js/yolo-io.js', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../js/canvas.js', import.meta.url), 'utf8');
  const detector = readFileSync(new URL('../js/detect/detector.js', import.meta.url), 'utf8');
  const results = readFileSync(new URL('../js/results.js', import.meta.url), 'utf8');
  // Sentinel + grey colour + YOLO skip.
  assert.match(yolo, /UNASSIGNED_CLASS_ID\s*=\s*-1/);
  assert.match(yolo, /UNASSIGNED_CLASS_NAME\s*=\s*'U'/);
  assert.match(yolo, /filter\(b => isAssignedClassId\(b\.classId\)\)/);
  assert.match(canvas, /U:\s*'#9ca3af'/);
  // Detector + editors no longer default to B2.
  assert.match(detector, /classId:\s*DET_CLASS_ID/);
  assert.doesNotMatch(detector, /DEFAULT_CLASS_ID\s*=\s*1/);
  // compute() surfaces the unassigned count; the UI shows it.
  assert.match(results, /unassignedCount/);
  assert.match(app, /unassigned/);
  assert.match(app, /has-unassigned/);
  // Suggestion-vs-final behaviour log written at save time.
  assert.match(app, /async function _saveAnnotLog/);
  assert.match(app, /annotlog\/\$\{split\}\/\$\{snapshot\.treeName\}/);
  assert.match(app, /suggestions: suggestions\.map\(_annotLogShape\)/);
});

test('creating sessions/trees requires an Export folder first (native)', () => {
  // New Session and Add Tree both gate on a chosen Export folder so every
  // captured tree mirrors into a browsable location.
  assert.match(sessionsJs, /async function _ensureExportFolder\(\)/);
  assert.match(sessionsJs, /SafStore\.isSupported[\s\S]*SafStore\.current\(\)/);
  assert.match(sessionsJs, /if \(!\(await _ensureExportFolder\(\)\)\) return;\s*\n\s*_renderStart\(\)/);
  assert.match(sessionsJs, /if \(!\(await _ensureExportFolder\(\)\)\) return;\s*\n\s*_addPohon\(id, addBtn\)/);
});
