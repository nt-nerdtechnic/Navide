/**
 * planRuntime.ts
 *
 * Render-time interactivity layer for `.agent-team/plans/*.html` documents
 * (plan-doc-interactivity Phase B). The plan file on disk stays plain
 * presentational HTML with zero JavaScript; the plan window injects this
 * runtime when building the preview iframe's `srcdoc`
 * (`sandbox="allow-scripts"`, no same-origin).
 *
 * Security model:
 * - Any executable `<script>` the document carries is stripped; only the
 *   `type="application/json"` plan-meta island (data, not code) is kept.
 * - A CSP `<meta>` with a per-render nonce allows only the injected runtime
 *   to execute — inline handlers, `javascript:` URLs, and network access in
 *   the document are blocked.
 * - The runtime binds existing DOM markers only (`li[data-todo-id]`,
 *   section/phase headings); it never evaluates document content.
 * - Frame → host communication is limited to the whitelisted postMessage
 *   events below; the host validates every payload before any disk write.
 *
 * Host-side helpers (outline extraction, message validation) live here too so
 * the protocol has a single home.
 */

/** Frame → host events. Anything else is ignored by the host. */
export const PLAN_RUNTIME_EVENTS = [
  'todo-clicked',
  'section-comment',
  'scroll-pos',
  'open-code',
] as const

/** Upper bound for a section anchor; longer payloads are rejected. */
export const MAX_ANCHOR_LENGTH = 200

export interface PlanRuntimeInit {
  /** Unresolved review-note count per anchor, rendered as heading badges. */
  anchors: Record<string, number>
  /** Localized label for the injected section comment button. */
  commentLabel: string
  /** Scroll offset restored after a reload triggered by a meta write. */
  scrollY: number
}

export type PlanRuntimeMessage =
  | { type: 'todo-clicked'; todoId: string; alt: boolean }
  | { type: 'section-comment'; anchor: string }
  | { type: 'scroll-pos'; y: number }
  | { type: 'open-code'; path: string; line: number }

// Anchors are the leading text of section `<h2>`s and `.phase-head`s (text up
// to the first child element), whitespace-collapsed — the runtime computes the
// same value from the live DOM, so host and frame agree on anchor identity.
const OUTLINE_RE =
  /<h2\b[^>]*>([^<]+)|<div\b[^>]*class=["'][^"']*\bphase-head\b[^"']*["'][^>]*>([^<]+)/gi

/**
 * Extract the outline anchors (document order, deduplicated) from raw plan
 * HTML. Doubles as the whitelist of valid `section-comment` anchors.
 */
export function extractPlanOutline(content: string): string[] {
  const anchors: string[] = []
  for (const match of content.matchAll(OUTLINE_RE)) {
    const text = (match[1] ?? match[2] ?? '').replace(/\s+/g, ' ').trim()
    if (text && text.length <= MAX_ANCHOR_LENGTH && !anchors.includes(text)) anchors.push(text)
  }
  return anchors
}

export interface PlanRuntimeHostHooks {
  /** The plan preview iframe's contentWindow; messages from any other source are ignored. */
  getSourceWindow: () => Window | null | undefined
  /** Todo ids present in the parsed plan-meta; unknown ids are rejected. */
  getTodoIds: () => readonly string[]
  /** Valid outline anchors; unknown anchors are rejected. */
  getAnchors: () => readonly string[]
  onTodoClicked: (todoId: string, alt: boolean) => void
  onSectionComment: (anchor: string) => void
  onScrollPos: (y: number) => void
  onOpenCode: (path: string, line: number) => void
}

/** Upper bounds for open-code payloads; anything beyond is rejected. */
export const MAX_OPEN_CODE_PATH_LENGTH = 512
export const MAX_OPEN_CODE_LINE = 1_000_000

/**
 * Build the host's `message` listener. Every event is validated against the
 * whitelist and its payload schema before the matching hook runs — malformed
 * or non-whitelisted messages are silently dropped, so nothing reaches the
 * meta write path.
 */
export function createPlanRuntimeMessageHandler(
  hooks: PlanRuntimeHostHooks,
): (event: MessageEvent) => void {
  return (event) => {
    const source = hooks.getSourceWindow()
    if (!source || event.source !== source) return
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null) return
    const msg = data as Record<string, unknown>
    switch (msg.type) {
      case 'todo-clicked': {
        const todoId = msg.todoId
        if (typeof todoId !== 'string' || !hooks.getTodoIds().includes(todoId)) return
        hooks.onTodoClicked(todoId, msg.alt === true)
        return
      }
      case 'section-comment': {
        const anchor = msg.anchor
        if (typeof anchor !== 'string' || anchor.length === 0 || anchor.length > MAX_ANCHOR_LENGTH)
          return
        if (!hooks.getAnchors().includes(anchor)) return
        hooks.onSectionComment(anchor)
        return
      }
      case 'scroll-pos': {
        const y = msg.y
        if (typeof y !== 'number' || !Number.isFinite(y) || y < 0) return
        hooks.onScrollPos(y)
        return
      }
      case 'open-code': {
        // Workspace-relative path only: no absolute paths, no backslashes, no
        // `..` traversal, no drive/scheme colons.
        const path = msg.path
        const line = msg.line
        if (typeof path !== 'string' || path.length === 0 || path.length > MAX_OPEN_CODE_PATH_LENGTH)
          return
        if (path.startsWith('/') || path.includes('\\') || path.includes(':')) return
        if (path.split('/').includes('..')) return
        if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return
        if (line > MAX_OPEN_CODE_LINE) return
        hooks.onOpenCode(path, line)
        return
      }
      default:
        return // non-whitelisted event — ignored
    }
  }
}

/**
 * Build the runtime script source injected into the plan document. Pure DOM
 * binding over existing markers; posts only whitelisted events to the host.
 */
export function buildPlanRuntimeScript(init: PlanRuntimeInit): string {
  // JSON-escape "<" so init data (anchor text comes from the document) can
  // never form a "</script>" sequence that terminates the runtime block.
  const initJson = JSON.stringify(init).replace(/</g, '\\u003c')
  return `(function () {
  'use strict';
  var INIT = ${initJson};
  function post(msg) { parent.postMessage(msg, '*'); }

  var style = document.createElement('style');
  style.textContent =
    'li[data-todo-id]{cursor:pointer}' +
    'li[data-todo-id]:hover{background:rgba(125,125,125,0.09)}' +
    '.plan-rt-badge{display:inline-block;margin-left:8px;padding:0 8px;border-radius:99px;' +
    'font-size:11px;font-weight:700;line-height:1.7;vertical-align:2px;' +
    'background:var(--accent-soft,#E8EDFB);color:var(--accent,#3B5BDB)}' +
    '.plan-rt-comment{position:absolute;z-index:9;padding:2px 10px;border-radius:99px;' +
    'border:1px solid var(--accent,#3B5BDB);background:var(--surface,#FFFFFF);' +
    'color:var(--accent,#3B5BDB);font-size:12px;cursor:pointer}' +
    '.plan-rt-comment:hover{background:var(--accent-soft,#E8EDFB)}';
  (document.head || document.documentElement).appendChild(style);

  // Leading text (up to the first child element), whitespace-collapsed —
  // matches the host's extractPlanOutline() regex semantics.
  function leadText(el) {
    var s = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) break;
      if (n.nodeType === 3) s += n.data;
    }
    return s.replace(/\\s+/g, ' ').trim();
  }

  var targets = [];
  var seen = {};
  function addTarget(head, region) {
    var anchor = leadText(head);
    if (!anchor || seen[anchor] === true) return;
    seen[anchor] = true;
    targets.push({ anchor: anchor, head: head, region: region });
  }
  var h2s = document.querySelectorAll('h2');
  for (var i = 0; i < h2s.length; i++) addTarget(h2s[i], h2s[i].closest('section') || h2s[i]);
  var phaseHeads = document.querySelectorAll('.phase-head');
  for (var j = 0; j < phaseHeads.length; j++)
    addTarget(phaseHeads[j], phaseHeads[j].closest('.phase') || phaseHeads[j]);

  // Unresolved-comment badges next to anchored headings.
  for (var k = 0; k < targets.length; k++) {
    var count = INIT.anchors[targets[k].anchor];
    if (typeof count === 'number' && count > 0) {
      var badge = document.createElement('span');
      badge.className = 'plan-rt-badge';
      badge.textContent = String(count);
      targets[k].head.appendChild(badge);
    }
  }

  // Floating comment button shown while hovering a section/phase. Hiding is
  // delayed so moving the pointer onto the button (a body child overlapping
  // the region) does not dismiss it before the click lands.
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'plan-rt-comment';
  btn.textContent = INIT.commentLabel;
  btn.style.display = 'none';
  document.body.appendChild(btn);
  var currentAnchor = '';
  var hideTimer = null;
  function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(function () { btn.style.display = 'none'; }, 250);
  }
  btn.addEventListener('mouseenter', cancelHide);
  btn.addEventListener('mouseleave', scheduleHide);
  btn.addEventListener('click', function () {
    if (currentAnchor) post({ type: 'section-comment', anchor: currentAnchor });
  });
  targets.forEach(function (t) {
    t.region.addEventListener('mouseenter', function () {
      cancelHide();
      currentAnchor = t.anchor;
      btn.style.display = 'block';
      var rect = t.region.getBoundingClientRect();
      btn.style.top = (rect.top + window.scrollY + 6) + 'px';
      btn.style.left = Math.max(0, rect.right + window.scrollX - btn.offsetWidth - 6) + 'px';
    });
    t.region.addEventListener('mouseleave', scheduleHide);
  });

  // In-document todo rows: click cycles, right-click toggles skip — the host
  // routes both through the review toolbar's existing write path.
  var todoRows = document.querySelectorAll('li[data-todo-id]');
  todoRows.forEach(function (row) {
    var todoId = row.getAttribute('data-todo-id') || '';
    if (!todoId) return;
    row.addEventListener('click', function () {
      post({ type: 'todo-clicked', todoId: todoId, alt: false });
    });
    row.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      post({ type: 'todo-clicked', todoId: todoId, alt: true });
    });
  });

  // file:line references in <code> elements become clickable and ask the
  // host to open the editor at that line. Workspace-relative paths only.
  var CODE_REF_RE = /^([A-Za-z0-9_\\-./]+\\.[A-Za-z0-9]+):(\\d{1,7})$/;
  var codeEls = document.querySelectorAll('code');
  codeEls.forEach(function (el) {
    var m = CODE_REF_RE.exec((el.textContent || '').trim());
    if (!m) return;
    var path = m[1];
    if (path.charAt(0) === '/' || path.indexOf('..') !== -1) return;
    var line = parseInt(m[2], 10);
    el.style.cursor = 'pointer';
    el.style.textDecoration = 'underline';
    el.addEventListener('click', function () {
      post({ type: 'open-code', path: path, line: line });
    });
  });

  // Throttled scroll reporting so the host can restore position after the
  // iframe reloads on a meta write.
  var scrollTimer = null;
  window.addEventListener('scroll', function () {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      post({ type: 'scroll-pos', y: window.scrollY });
    }, 250);
  }, { passive: true });
  if (INIT.scrollY > 0) window.scrollTo(0, INIT.scrollY);

  // Host -> frame: outline navigation (the only inbound message handled).
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.type !== 'scroll-to' || typeof d.anchor !== 'string') return;
    for (var m = 0; m < targets.length; m++) {
      if (targets[m].anchor === d.anchor) {
        targets[m].head.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
  });
})();`
}

// Any <script> without type="application/json" is executable — dropped.
// Unclosed script tags survive the regex but are blocked by the CSP nonce.
const EXECUTABLE_SCRIPT_RE =
  /<script\b(?![^>]*type=["']application\/json["'])[^>]*>[\s\S]*?<\/script\s*>/gi

/** Remove executable scripts from a plan document; JSON data islands stay. */
export function stripExecutableScripts(content: string): string {
  return content.replace(EXECUTABLE_SCRIPT_RE, '')
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Build the full srcdoc for the plan preview iframe: strip executable
 * document scripts, inject a nonce'd CSP meta (only the runtime may execute;
 * inline styles and data: images stay allowed for self-contained docs), and
 * append the runtime script before `</body>`.
 */
export function preparePlanDocHtml(
  content: string,
  init: PlanRuntimeInit,
  nonce: string = randomNonce(),
): string {
  const csp =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    `style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${nonce}'">`
  // Unconditionally FIRST in the document: the HTML parser hoists the meta
  // into the implied <head>, and prepending guarantees the policy precedes
  // any stray content before <head> (e.g. an unclosed script the strip regex
  // could not consume).
  const html = csp + stripExecutableScripts(content)
  // "</scr" + "ipt>" keeps this file's own source free of a literal
  // script-close sequence inside a string.
  const runtimeTag = `<script nonce="${nonce}">${buildPlanRuntimeScript(init)}</scr` + 'ipt>'
  const bodyClose = html.search(/<\/body>/i)
  return bodyClose === -1
    ? html + runtimeTag
    : html.slice(0, bodyClose) + runtimeTag + html.slice(bodyClose)
}
