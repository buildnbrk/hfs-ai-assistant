'use strict';
(function () {

// ── Constants ─────────────────────────────────────────────────────────────────
const AI               = '/~/ai'
const OLLAMA_HOST      = AI + '/ollama'
const WHISPER_URL      = AI + '/whisper'
const WHISPER_MODEL    = 'Systran/faster-whisper-small'
const SILENCE_THRESHOLD = 0.015
const SILENCE_GRACE_MS  = 1500
const IMAGE_MAX_PX     = 1280
const IMAGE_QUALITY    = 0.85
const SAVE_DEBOUNCE    = 2000
const MAX_HISTORY_MSGS = 40   // cap: how many non-system messages to keep in context
const LS               = localStorage
const LS_CHATS_KEY     = 'ai_guest_chats'

const LANG_EXT = {
  js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts',
  py: 'py', python: 'py', html: 'html', css: 'css',
  json: 'json', sh: 'sh', bash: 'sh', yaml: 'yaml',
  yml: 'yml', md: 'md', xml: 'xml', sql: 'sql',
  csv: 'csv', txt: 'txt',
}

// ── State ─────────────────────────────────────────────────────────────────────
let ollamaModel    = (LS.getItem('ai_model') || '').replace(/:latest$/i, '')
let chatTheme      = LS.getItem('ai_theme') ?? null
let personaMode    = LS.getItem('ai_persona') ?? null
let speakMode      = LS.getItem('ai_speak') ?? null
let thinkMode      = LS.getItem('ai_think') ?? null
let numPredict     = LS.getItem('ai_numpredict') !== null ? parseInt(LS.getItem('ai_numpredict'), 10) : null
let temperature    = LS.getItem('ai_temp') !== null ? parseFloat(LS.getItem('ai_temp')) : null

let SRV = { persona: 'prompt1', speak: 'off', think: 'off', numPredict: -1, temperature: 1.0, theme: 'hfs' }

let SERVER_PROMPT1_PROMPT = ''
let SERVER_PROMPT2_PROMPT = ''
let PERSONA_PROMPTS        = { prompt1: '', prompt2: '' }

let SEARCH_EXPLICIT  = buildDefaultSearchPatterns('search,look up,find out,google,check online,check the web')
let SEARCH_RECENCY   = buildDefaultSearchPatterns('latest,currently,right now,today,this week,this year,recently,breaking')
let SEARCH_QUESTIONS = buildDefaultSearchPatterns('who is the,what is the current,who won,what happened,how is')
let SEARCH_TOPICS    = buildDefaultSearchPatterns('price of,weather,score,news,standings,election,earnings,release date,launch')

let panelOpen      = false
let isFullscreen   = false
let history        = []       // { role, content, images? }
let attachments    = []       // { type, name, size, base64, mime, content, thumbDataUrl }
let isStreaming    = false
let abortCtrl      = null
let currentChatId  = null
let chatList       = []
let saveTimer      = null
let historyOpen    = false
let userScrolledUp = false
let isGuest        = false
let uiVisible      = true
let isDragging     = false
let dragOffX = 0, dragOffY = 0
let confirmResolve = null
let editingPersona = null
let savedPanelOpen = false, savedFullscreen = false

let ttsBuffer = '', ttsQueue = [], ttsSpeaking = false, ttsActive = false
let micActive = false, micStream = null, mediaRec = null, audioChunks = []
let audioCtx = null, analyser = null, silTimer = null, speechHeard = false

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

function on(id, ev, fn) {
  const el = $(id)
  if (el) el.addEventListener(ev, fn)
}

function escHtml(t = '') {
  return String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatBytes(b) {
  if (b < 1024) return b + ' B'
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1048576).toFixed(1) + ' MB'
}

// ── marked.js loader ──────────────────────────────────────────────────────────
// Loaded once, then cached. Falls back to a basic renderer if CDN is unavailable.
let markedReady = null

let purifyReady = null

function loadDOMPurify() {
  if (purifyReady) return purifyReady
  purifyReady = new Promise(resolve => {
    if (window.DOMPurify) return resolve(true)
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.5/purify.min.js'
    s.integrity = 'sha384-mX3+OGyRZ5x1s8ikABCJGDOuL7Vc6+V1MHk5fMIX2b/4Kl5ABqGjqYiP9CXifz'
    s.crossOrigin = 'anonymous'
    s.onload  = () => resolve(true)
    s.onerror = () => resolve(false)
    document.head.appendChild(s)
  })
  return purifyReady
}

function loadMarked() {
  if (markedReady) return markedReady
  markedReady = new Promise(resolve => {
    if (window.marked) { configureMarked(); return resolve(true) }
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js'
    s.integrity = 'sha384-s6kP3Bv0CfX7gRMQJzlZzVGz7jX5ItJg9sOHYiS5MUgQ4s1kqCOHqJJuSjLIz+'
    s.crossOrigin = 'anonymous'
    s.onload = () => { configureMarked(); resolve(true) }
    s.onerror = () => resolve(false)   // graceful degradation
    document.head.appendChild(s)
  })
  return markedReady
}

function configureMarked() {
  if (!window.marked) return
  window.marked.setOptions({
    breaks: true,
    gfm: true,
    headerIds: false,
    mangle: false,
  })
  // Custom renderer: add copy/download buttons to code blocks
  const renderer = new window.marked.Renderer()
  renderer.code = function (code, lang) {
    const safeLang = escHtml(lang || 'code')
    const safeCode = escHtml(code)
    return (
      `<div class="ai-code-block">` +
      `<pre><code class="language-${safeLang}">${safeCode}</code></pre>` +
      `<div class="ai-code-hdr">` +
      `<span>${safeLang}</span>` +
      `<button class="ai-copy-btn" onclick="aiCopyCode(this)">Copy</button>` +
      `<button class="ai-copy-btn" onclick="aiDownloadCode(this,'${safeLang}')">Download</button>` +
      `</div></div>`
    )
  }
  window.marked.use({ renderer })
}

function renderMd(text) {
  if (window.marked) {
    try {
      const html = window.marked.parse(text)
      // Sanitize to prevent XSS from AI-generated HTML (e.g. prompt-injected payloads).
      // DOMPurify strips dangerous tags/attributes while keeping safe markdown output intact.
      return window.DOMPurify ? window.DOMPurify.sanitize(html) : html
    } catch (_) {}
  }
  // Fallback: minimal renderer (no marked available)
  return fallbackRenderMd(text)
}

function fallbackRenderMd(text) {
  const codeBlocks = []
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length
    codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') })
    return `\x02CB${idx}\x02`
  })
  html = escHtml(html)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(\S(?:.*?\S)?)\*/g, '<em>$1</em>')
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
  html = html.replace(/\n/g, '<br>')
  html = html.replace(/\x02CB(\d+)\x02/g, (_, idx) => {
    const { lang, code } = codeBlocks[idx]
    const safeLang = escHtml(lang || 'code')
    return (
      `<div class="ai-code-block"><pre><code>${escHtml(code)}</code></pre>` +
      `<div class="ai-code-hdr"><span>${safeLang}</span>` +
      `<button class="ai-copy-btn" onclick="aiCopyCode(this)">Copy</button>` +
      `<button class="ai-copy-btn" onclick="aiDownloadCode(this,'${safeLang}')">Download</button>` +
      `</div></div>`
    )
  })
  return html
}

// ── Code block actions (mobile-safe) ─────────────────────────────────────────
window.aiCopyCode = function (btn) {
  const code = btn.closest('.ai-code-block').querySelector('code')
  const text = code.textContent || ''
  // navigator.clipboard requires a secure context; fall back to execCommand
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text)
      .then(() => flashBtn(btn, 'Copied!', 'Copy'))
      .catch(() => copyFallback(text, btn))
  } else {
    copyFallback(text, btn)
  }
}

function copyFallback(text, btn) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  try { document.execCommand('copy'); flashBtn(btn, 'Copied!', 'Copy') }
  catch (_) { flashBtn(btn, 'Failed', 'Copy') }
  document.body.removeChild(ta)
}

function flashBtn(btn, label, restore, ms = 1500) {
  btn.textContent = label
  setTimeout(() => { btn.textContent = restore }, ms)
}

window.aiDownloadCode = function (btn, lang) {
  const code = btn.closest('.ai-code-block').querySelector('code')
  const text = code.textContent || ''
  const ext  = LANG_EXT[(lang || '').toLowerCase()] || 'txt'
  mobileDownload(text, `code.${ext}`, 'text/plain')
}

// Mobile-safe download: uses a real anchor click; opens as blob URL on iOS
function mobileDownload(text, filename, mime) {
  try {
    const blob = new Blob([text], { type: mime })
    const url  = URL.createObjectURL(blob)
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 3000)
  } catch (err) {
    showError('Download failed: ' + err.message)
  }
}

// ── History capping ───────────────────────────────────────────────────────────
// Keeps the system message + the most recent N non-system messages so the
// context window doesn't grow unbounded across long conversations.
function cappedHistory() {
  const sys  = history.filter(m => m.role === 'system')
  const msgs = history.filter(m => m.role !== 'system')
  const kept = msgs.slice(-MAX_HISTORY_MSGS)
  return [...sys, ...kept]
}

// ── Build HTML ────────────────────────────────────────────────────────────────
function buildHTML() {
  const root = document.createElement('div')
  root.id = 'hfs-ai-root'
  root.innerHTML = `
<button id="hfs-ai-btn" title="AI Assistant&#10;Alt+A — Hide / Show&#10;Right-Click — Reset Position">
  <svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/><circle cx="9" cy="14" r="1.5" fill="#fff" stroke="none"/><circle cx="15" cy="14" r="1.5" fill="#fff" stroke="none"/><path d="M9 18h6"/></svg>
  <div class="ai-online-dot" id="ai-dot"></div>
</button>

<div id="hfs-ai-panel">
  <div id="hfs-ai-header">
    <div class="ai-header-logo">
      <svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/><circle cx="9" cy="14" r="1.5" fill="#5b8af5" stroke="none"/><circle cx="15" cy="14" r="1.5" fill="#5b8af5" stroke="none"/><path d="M9 18h6"/></svg>
      <span id="ai-model-trigger" title="Switch Model" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer">
        <span id="hfs-ai-model-name">${escHtml(ollamaModel)}</span>
        <svg class="ai-model-caret" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
      <div class="ai-status-pill" id="ai-status-pill" title="Ollama Status">
        <div class="ai-status-dot" id="ai-status-dot"></div>
        <span id="ai-status-txt">checking</span>
      </div>
    </div>
    <div id="ai-settings-wrap" style="display:contents">
      <button class="ai-hdr-btn" id="ai-settings-btn" title="Settings">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
      </button>
      <div class="ai-dd ai-settings-dd" id="ai-settings-dd">
        <div id="ai-persona-section">
          <div class="ai-dd-hdr">Persona</div>
          <div class="ai-dd-opt" data-persona="prompt1">
            <span class="ai-dd-label">Prompt 1</span>
            <span class="ai-dd-desc" id="ai-persona-desc-prompt1">Concise Technical</span>
            <button class="ai-prompt-edit-btn" data-edit-persona="prompt1" title="Edit prompt">✎</button>
          </div>
          <div class="ai-dd-opt" data-persona="prompt2">
            <span class="ai-dd-label">Prompt 2</span>
            <span class="ai-dd-desc" id="ai-persona-desc-prompt2">Casual Friend</span>
            <button class="ai-prompt-edit-btn" data-edit-persona="prompt2" title="Edit prompt">✎</button>
          </div>
          <div id="ai-prompt-editor" style="display:none;padding:8px;border-top:1px solid var(--ai-border);margin-top:6px">
            <div class="ai-settings-lbl" id="ai-prompt-editor-label">Edit prompt</div>
            <textarea id="ai-prompt-editor-text" rows="4" style="width:100%;box-sizing:border-box;resize:vertical;background:var(--ai-surface2);color:var(--ai-text);border:1px solid var(--ai-border);border-radius:4px;padding:6px;font-size:12px"></textarea>
            <div style="display:flex;gap:6px;margin-top:6px">
              <button id="ai-prompt-editor-save" class="ai-btn">Save</button>
              <button id="ai-prompt-editor-reset" class="ai-btn">Reset to default</button>
              <button id="ai-prompt-editor-cancel" class="ai-btn">Cancel</button>
            </div>
          </div>
        </div>
        <div id="ai-speak-section">
          <div class="ai-dd-hdr" style="border-top:1px solid var(--ai-border);margin-top:6px;padding-top:10px">Speak</div>
          <div class="ai-dd-opt" data-speak="off"><span class="ai-dd-label">Speak Off</span><span class="ai-dd-desc">No Speaking</span></div>
          <div class="ai-dd-opt" data-speak="stream"><span class="ai-dd-label">Stream Speak</span><span class="ai-dd-desc">Reads While Generating</span></div>
        </div>
        <div id="ai-think-section">
          <div class="ai-dd-hdr" style="border-top:1px solid var(--ai-border);margin-top:6px;padding-top:10px">Think Mode</div>
          <div class="ai-dd-opt" data-think="off"><span class="ai-dd-label">Think Off</span><span class="ai-dd-desc">Standard Response</span></div>
          <div class="ai-dd-opt" data-think="on"><span class="ai-dd-label">Think On</span><span class="ai-dd-desc">Extended Reasoning</span></div>
        </div>
        <div class="ai-dd-hdr" style="border-top:1px solid var(--ai-border);margin-top:6px;padding-top:10px">Theme</div>
        <div class="ai-dd-opt" data-theme="hfs"><span class="ai-dd-label">HFS Theme</span><span class="ai-dd-desc">Match Site</span></div>
        <div class="ai-dd-opt" data-theme="navy"><span class="ai-dd-label">Navy Theme</span><span class="ai-dd-desc">Fixed Navy</span></div>
        <div id="ai-values-section">
          <div class="ai-dd-hdr" style="border-top:1px solid var(--ai-border);margin-top:6px;padding-top:10px">Settings</div>
          <div class="ai-settings-section">
            <div class="ai-settings-lbl">Response (tokens, -1 = unlimited)</div>
            <input type="number" id="ai-np-input" min="-1" max="8192" step="1"
              style="width:100%;box-sizing:border-box;background:var(--ai-surface2);color:var(--ai-text);border:1px solid var(--ai-border);border-radius:4px;padding:6px;font-size:12px">
          </div>
          <div class="ai-settings-section">
            <div class="ai-settings-lbl">Temperature (0 – 2)</div>
            <input type="number" id="ai-tmp-input" min="0" max="2" step="0.05"
              style="width:100%;box-sizing:border-box;background:var(--ai-surface2);color:var(--ai-text);border:1px solid var(--ai-border);border-radius:4px;padding:6px;font-size:12px">
          </div>
        </div>
        <div class="ai-settings-section" style="flex-direction:row;gap:6px">
          <button class="ai-proj-btn danger" onclick="aiResetDefaults()" style="flex:1">Defaults</button>
        </div>
      </div>
    </div>
    <button class="ai-hdr-btn" id="ai-history-btn" title="Chat History">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    </button>
    <button class="ai-hdr-btn" id="ai-newchat-btn" title="New Chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <button class="ai-hdr-btn" id="ai-expand-btn" title="Expand To Fullscreen">
      <svg viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
    </button>
    <button class="ai-hdr-btn" id="ai-close-btn" title="Close">
      <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>

  <!-- Model popover -->
  <div id="hfs-ai-model-pop">
    <div class="ai-model-pop-hdr">Select Model</div>
    <div id="ai-model-list"></div>
  </div>

  <!-- Chat history sidebar -->
  <div id="hfs-ai-history-sidebar">
    <div class="ai-history-hdr">
      <span>Chat History</span>
      <button class="ai-hdr-btn danger" id="ai-deleteall-btn" title="Delete All Chats">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>
      <button class="ai-hdr-btn" id="ai-history-close-btn" title="Close History">
        <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div id="ai-history-list"></div>
  </div>

  <!-- Attachment bar -->
  <div id="hfs-ai-attbar"></div>

  <!-- Messages -->
  <div id="hfs-ai-msgs">
    <div id="hfs-ai-empty">
      <svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/><circle cx="9" cy="14" r="1.5"/><circle cx="15" cy="14" r="1.5"/><path d="M9 18h6"/></svg>
      <div id="hfs-ai-empty-title">AI Assistant</div>
      <div id="hfs-ai-empty-sub">Ask me anything — or click the search button to search the internet</div>
    </div>
  </div>

  <!-- Save indicator -->
  <div id="hfs-ai-saveindicator">saving…</div>

  <!-- Error banner -->
  <div id="hfs-ai-error">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <span id="hfs-ai-errtxt"></span>
  </div>

  <!-- Input area -->
  <div id="hfs-ai-inputarea">
    <div class="ai-input-row">
      <button class="ai-input-btn" id="ai-attach-btn" title="Attach File (Click) — Download Chat (Hold)">
        <svg viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      </button>
      <input type="file" id="ai-file-input" multiple
        accept="image/*,.txt,.md,.json,.csv,.js,.ts,.py,.html,.css,.xml,.yaml,.yml,.sh,.log"
        style="display:none">

      <button class="ai-input-btn" id="ai-search-btn" title="DuckDuckGo Search (Click) — AI Search (Hold)">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>
      <textarea id="hfs-ai-textarea" placeholder="Message…" rows="1"></textarea>
      <button class="ai-input-btn" id="ai-mute-btn" title="Stop Speaking" style="display:none">
        <svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
      </button>
      <button id="hfs-ai-send" title="Send">
        <svg id="ai-send-icon" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        <svg id="ai-stop-icon" viewBox="0 0 24 24" style="display:none"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
        <svg id="ai-mic-icon"  viewBox="0 0 24 24" style="display:none"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/></svg>
      </button>
    </div>
    <div class="ai-input-hint">
      enter=send · shift+enter=newline · <span id="ai-mic-hint">empty=mic · </span>
      <span class="ai-search-info-wrap">
        <span class="ai-search-trigger" id="ai-srch-trigger" onclick="toggleSearchBalloon()">auto-search</span>
        <div class="ai-search-balloon" id="ai-srch-balloon"></div>
      </span>
    </div>
  </div>

  <!-- Confirm dialog -->
  <div id="hfs-ai-confirm">
    <div class="ai-confirm-box">
      <div class="ai-confirm-title" id="ai-confirm-title"></div>
      <div class="ai-confirm-msg"   id="ai-confirm-msg"></div>
      <div class="ai-confirm-btns">
        <button class="ai-confirm-cancel" onclick="confirmResolve(false)">Cancel</button>
        <button class="ai-confirm-ok"     id="ai-confirm-ok" onclick="confirmResolve(true)">Confirm</button>
      </div>
    </div>
  </div>
</div>`
  document.body.appendChild(root)
}

// ── Confirm dialog ────────────────────────────────────────────────────────────
function askConfirm(title, msg, okLabel = 'Confirm') {
  return new Promise(resolve => {
    confirmResolve = resolve
    $('ai-confirm-title').textContent = title
    $('ai-confirm-msg').textContent   = msg
    $('ai-confirm-ok').textContent    = okLabel
    $('hfs-ai-confirm').classList.add('on')
  })
}
window.confirmResolve = function (v) {
  $('hfs-ai-confirm').classList.remove('on')
  if (confirmResolve) { confirmResolve(v); confirmResolve = null }
}

// ── Error banner ──────────────────────────────────────────────────────────────
function showError(msg) {
  $('hfs-ai-errtxt').textContent = msg
  $('hfs-ai-error').classList.add('on')
}
function hideError() { $('hfs-ai-error').classList.remove('on') }

// ── Status / model ────────────────────────────────────────────────────────────
async function checkStatus() {
  $('ai-status-dot').className = 'ai-status-dot'
  $('ai-status-txt').textContent = 'checking'
  try {
    const r = await fetch(OLLAMA_HOST + '/api/tags', { signal: AbortSignal.timeout(6000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    $('ai-status-dot').className   = 'ai-status-dot online'
    $('ai-status-txt').textContent = 'online'
    $('ai-dot').className          = 'ai-online-dot on'
    hideError()
    if (!ollamaModel) {
      const d     = await r.json()
      const first = (d.models || []).map(m => m.name.replace(/:latest$/i, '')).sort()[0]
      if (first) {
        ollamaModel = first
        LS.setItem('ai_model', first)
        $('hfs-ai-model-name').textContent = first
      }
    }
  } catch (_) {
    $('ai-status-dot').className   = 'ai-status-dot error'
    $('ai-status-txt').textContent = 'offline'
    $('ai-dot').className          = 'ai-online-dot'
  }
}
setInterval(checkStatus, 30000)

async function populateModels() {
  const list = $('ai-model-list')
  if (!list) return
  list.innerHTML = `<div class="ai-model-opt active"><span>${escHtml(ollamaModel)}</span></div>`
  try {
    const r = await fetch(OLLAMA_HOST + '/api/tags', { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d      = await r.json()
    const models = (d.models || []).map(m => m.name).sort()
    list.innerHTML = models.map(n =>
      `<div class="ai-model-opt${n === ollamaModel ? ' active' : ''}" data-model="${escHtml(n)}">
        <span>${escHtml(n)}</span>
      </div>`
    ).join('')
    list.querySelectorAll('.ai-model-opt:not(.active)').forEach(el => {
      el.onclick = () => switchModel(el.dataset.model)
    })
  } catch (_) {}
}

async function switchModel(name) {
  if (SRV.lockModel) return
  $('hfs-ai-model-pop').classList.remove('open')
  if (!name || name === ollamaModel) return
  const ok = await askConfirm('Switch Model?', 'This will clear the current conversation.', 'Switch')
  if (!ok) return
  LS.setItem('ai_model', name.replace(/:latest$/i, ''))
  location.reload()
}

function toggleModelPop() {
  const p    = $('hfs-ai-model-pop')
  const open = p.classList.toggle('open')
  if (open) populateModels()
}

// ── Panel open / close / fullscreen ──────────────────────────────────────────
function togglePanel() {
  if (isDragging) return
  panelOpen = !panelOpen
  $('hfs-ai-panel').classList.toggle('open', panelOpen)
  if (panelOpen) { $('hfs-ai-textarea').focus(); checkStatus() }
}

function toggleFullscreen() {
  isFullscreen = !isFullscreen
  const panel = $('hfs-ai-panel')
  panel.classList.toggle('fullscreen', isFullscreen)
  const btn = $('ai-expand-btn')
  btn.title = isFullscreen ? 'Shrink' : 'Expand To Fullscreen'
  btn.querySelector('svg').innerHTML = isFullscreen
    ? '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>'
    : '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'
  if (isFullscreen) {
    if (panel.style.left) {
      LS.setItem('ai_panel_x', parseInt(panel.style.left))
      LS.setItem('ai_panel_y', parseInt(panel.style.top))
    }
    panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = ''
    initSettingsSliders()
  } else {
    const sx = LS.getItem('ai_panel_x'), sy = LS.getItem('ai_panel_y')
    if (sx !== null && sy !== null) {
      panel.style.right = panel.style.bottom = 'auto'
      panel.style.left = sx + 'px'
      panel.style.top  = sy + 'px'
    }
  }
}

// ── Message rendering ─────────────────────────────────────────────────────────
function scrollBottom(force) {
  const box = $('hfs-ai-msgs')
  if (force || !userScrolledUp) box.scrollTop = box.scrollHeight
}

function appendUserMsg(text, atts) {
  $('hfs-ai-empty').style.display = 'none'
  const g = document.createElement('div')
  g.className = 'ai-msg-group user'
  let html = ''
  atts.forEach(a => {
    if (a.type === 'image' && a.thumbDataUrl) {
      html += `<img src="${a.thumbDataUrl}" style="max-width:200px;max-height:150px;border-radius:8px;display:block;margin-bottom:5px;border:1px solid var(--ai-border)">`
    } else {
      html += `<div class="ai-file-badge"><svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" width="10" height="10"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>${escHtml(a.name)}</div>`
    }
  })
  g.innerHTML = `<div class="ai-msg-label">You</div><div class="ai-msg-bubble">${html}${escHtml(text)}</div>`
  $('hfs-ai-msgs').appendChild(g)
  scrollBottom()
}

function appendAiMsg() {
  $('hfs-ai-empty').style.display = 'none'
  const g      = document.createElement('div')
  g.className  = 'ai-msg-group ai'
  const label  = document.createElement('div')
  label.className = 'ai-msg-label'
  label.innerHTML = `<span>${escHtml(ollamaModel)}</span>
    <button class="ai-speak-btn" title="Read Aloud" onclick="aiToggleSpeak(this)">
      <svg id="spkon"  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="11" height="11"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
      <svg id="spkoff" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="11" height="11" style="display:none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
    </button>`
  const bubble  = document.createElement('div')
  bubble.className = 'ai-msg-bubble'
  bubble.innerHTML = '<div class="ai-typing-bub"><div class="ai-typing-dot"></div><div class="ai-typing-dot"></div><div class="ai-typing-dot"></div><span class="ai-typing-phase">working…</span></div>'
  g.appendChild(label)
  g.appendChild(bubble)
  $('hfs-ai-msgs').appendChild(g)
  scrollBottom()

  return {
    bubble,
    finalise(text, stats) {
      bubble.innerHTML = renderMd(text)
      // Override white-space set by CSS for rendered markdown
      bubble.style.whiteSpace = 'normal'
      if (stats) {
        const tps = stats.eval_duration
          ? (stats.eval_count / (stats.eval_duration / 1e9)).toFixed(1)
          : null
        const bar = document.createElement('div')
        bar.className = 'ai-token-stats'
        bar.innerHTML = [
          stats.prompt_eval_count != null ? `<span>prompt <b>${stats.prompt_eval_count}</b></span>` : '',
          stats.eval_count        != null ? `<span>response <b>${stats.eval_count}</b></span>`      : '',
          tps                             ? `<span><b>${tps}</b> tok/s</span>`                       : '',
        ].filter(Boolean).join('')
        bubble.appendChild(bar)
      }
    },
  }
}

// ── Attachments ───────────────────────────────────────────────────────────────
function resizeImg(file, cb) {
  const img = new Image()
  const url = URL.createObjectURL(file)
  img.onload = () => {
    URL.revokeObjectURL(url)
    let { naturalWidth: w, naturalHeight: h } = img
    if (w > IMAGE_MAX_PX || h > IMAGE_MAX_PX) {
      if (w >= h) { h = Math.round(h * IMAGE_MAX_PX / w); w = IMAGE_MAX_PX }
      else        { w = Math.round(w * IMAGE_MAX_PX / h); h = IMAGE_MAX_PX }
    }
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    c.getContext('2d').drawImage(img, 0, 0, w, h)
    cb(c.toDataURL('image/jpeg', IMAGE_QUALITY).split(',')[1])
  }
  img.onerror = () => { URL.revokeObjectURL(url); showError('Could not load image') }
  img.src = url
}

function handleFiles(files) {
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) {
      if (file.size > 10 * 1024 * 1024)              { showError(`Image too large: ${file.name}`); continue }
      if (attachments.filter(a => a.type === 'image').length >= 10) { showError('Max 10 images'); break }
      resizeImg(file, b64 => {
        attachments.push({ type: 'image', name: file.name, size: formatBytes(file.size), base64: b64, mime: 'image/jpeg', thumbDataUrl: 'data:image/jpeg;base64,' + b64 })
        renderAttBar()
      })
    } else {
      if (file.size > 500 * 1024)                       { showError(`File too large: ${file.name}`); continue }
      if (attachments.filter(a => a.type === 'file').length >= 10) { showError('Max 10 files'); break }
      const reader = new FileReader()
      reader.onload  = e => { attachments.push({ type: 'file', name: file.name, size: formatBytes(file.size), content: e.target.result }); renderAttBar() }
      reader.onerror = () => showError(`Could not read file: ${file.name}`)
      reader.readAsText(file)
    }
  }
  $('ai-file-input').value = ''
}

function renderAttBar() {
  const bar = $('hfs-ai-attbar')
  if (!attachments.length) { bar.classList.remove('on'); bar.innerHTML = ''; return }
  bar.classList.add('on')
  bar.innerHTML = attachments.map((a, i) => `
    <div class="ai-att-chip">
      ${a.thumbDataUrl ? `<img src="${a.thumbDataUrl}">` : ''}
      <span class="ai-att-name" title="${escHtml(a.name)}">${escHtml(a.name)}</span>
      <span class="ai-att-size">${a.size}</span>
      <button class="ai-att-rm" onclick="removeAtt(${i})">✕</button>
    </div>`).join('') +
    `<button class="ai-att-clearall" onclick="clearAtts()">clear all</button>`
}
window.removeAtt = function (i) { attachments.splice(i, 1); renderAttBar() }
function clearAtts() { attachments = []; renderAttBar(); $('ai-file-input').value = '' }

// ── Chat persistence ──────────────────────────────────────────────────────────
function genChatId() { return 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) }
function makeChatTitle(text) { return text.replace(/[^\w\s]/g, '').trim().slice(0, 50) || 'Chat' }

function detectGuest() {
  try { isGuest = !HFS.state.username } catch { isGuest = true }
}

// localStorage storage (guests)
function lsSaveChat(id, title, messages) {
  const all = lsGetAllChats()
  all[id] = { id, title, messages, lastActive: Date.now(), messageCount: messages.filter(m => m.role !== 'system').length }
  try { LS.setItem(LS_CHATS_KEY, JSON.stringify(all)) } catch (err) { showError('Storage full: ' + err.message) }
}
function lsGetAllChats() {
  try { return JSON.parse(LS.getItem(LS_CHATS_KEY) || '{}') } catch { return {} }
}
function lsGetChatList() {
  return Object.values(lsGetAllChats()).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))
}
function lsGetChat(id)     { return lsGetAllChats()[id] || null }
function lsDeleteChat(id)  { const all = lsGetAllChats(); delete all[id]; try { LS.setItem(LS_CHATS_KEY, JSON.stringify(all)) } catch (_) {} }
function lsDeleteAllChats(){ try { LS.removeItem(LS_CHATS_KEY) } catch (_) {} }

async function saveChat() {
  detectGuest()
  const userMsgs = history.filter(m => m.role !== 'system')
  if (!userMsgs.length) return
  if (!currentChatId) currentChatId = genChatId()
  const firstUser = userMsgs.find(m => m.role === 'user')
  const title     = firstUser ? makeChatTitle(typeof firstUser.content === 'string' ? firstUser.content : '') : 'Chat'
  const si        = $('hfs-ai-saveindicator')
  if (si) { si.classList.add('on'); setTimeout(() => si.classList.remove('on'), 1200) }
  if (isGuest) {
    lsSaveChat(currentChatId, title, history)
  } else {
    try {
      const r = await fetch(AI + '/chat/' + encodeURIComponent(currentChatId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, messages: history }),
      })
      if (!r.ok) showError(`Save failed: HTTP ${r.status}`)
    } catch (err) {
      showError('Save failed: ' + err.message)
    }
  }
}
function schedSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveChat, SAVE_DEBOUNCE) }

// ── Chat history sidebar ──────────────────────────────────────────────────────
async function loadChatList() {
  detectGuest()
  if (isGuest) {
    chatList = lsGetChatList()
    renderHistorySidebar()
    return
  }
  try {
    const r = await fetch(AI + '/chats')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    chatList = d.chats || []
    renderHistorySidebar()
  } catch (err) {
    showError('Could not load chat list: ' + err.message)
  }
}

function renderHistorySidebar() {
  const list = $('ai-history-list')
  if (!chatList.length) {
    list.innerHTML = '<div class="ai-history-empty">No saved chats yet</div>'
    return
  }
  list.innerHTML = chatList.map(c => {
    const date   = c.lastActive ? new Date(c.lastActive).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
    const active = c.id === currentChatId ? ' active' : ''
    return `<div class="ai-history-item${active}" data-id="${escHtml(c.id)}">
      <div class="ai-history-item-body" onclick="loadChat('${escHtml(c.id)}')">
        <div class="ai-history-title">${escHtml(c.title)}</div>
        <div class="ai-history-meta">${date} · ${c.messageCount} msg${c.messageCount !== 1 ? 's' : ''}</div>
      </div>
      <button class="ai-history-del" title="Delete" onclick="deleteChat('${escHtml(c.id)}', event)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>
    </div>`
  }).join('')
}

function toggleHistorySidebar() {
  historyOpen = !historyOpen
  $('hfs-ai-history-sidebar').classList.toggle('open', historyOpen)
  if (historyOpen) loadChatList()
}

window.loadChat = async function (id) {
  if (id === currentChatId) { toggleHistorySidebar(); return }
  try {
    let data
    if (isGuest) {
      data = lsGetChat(id)
      if (!data) { showError('Chat not found'); return }
    } else {
      const r = await fetch(AI + '/chat/' + encodeURIComponent(id))
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      data = await r.json()
    }
    currentChatId = id
    history       = data.messages || []
    $('hfs-ai-msgs').querySelectorAll('.ai-msg-group').forEach(n => n.remove())
    const visible = history.filter(m => m.role !== 'system')
    $('hfs-ai-empty').style.display = visible.length ? 'none' : ''
    visible.forEach(m => {
      if (m.role === 'user') appendUserMsg(m.content, [])
      else { const { bubble, finalise } = appendAiMsg(); finalise(m.content, null) }
    })
    scrollBottom(true)
    renderHistorySidebar()
    toggleHistorySidebar()
  } catch (err) {
    showError('Could not load chat: ' + err.message)
  }
}

window.deleteChat = async function (id, e) {
  if (e) e.stopPropagation()
  const chat  = chatList.find(c => c.id === id)
  const label = chat ? `"${chat.title}"` : 'this chat'
  const ok    = await askConfirm(`Delete ${label}?`, 'This cannot be undone.', 'Delete')
  if (!ok) return
  try {
    if (isGuest) {
      lsDeleteChat(id)
    } else {
      const r = await fetch(AI + '/chat/' + encodeURIComponent(id), { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
    }
  } catch (err) {
    showError('Delete failed: ' + err.message)
    return
  }
  if (id === currentChatId) {
    currentChatId = null
    history       = []
    $('hfs-ai-msgs').querySelectorAll('.ai-msg-group').forEach(n => n.remove())
    $('hfs-ai-empty').style.display = ''
    initHistory()
  }
  await loadChatList()
}

window.deleteAllChats = async function () {
  if (!chatList.length) return
  const ok = await askConfirm('Delete all chats?', 'This will permanently delete all saved chats and cannot be undone.', 'Delete All')
  if (!ok) return
  try {
    if (isGuest) {
      lsDeleteAllChats()
    } else {
      const errors = []
      await Promise.all(chatList.map(async c => {
        const r = await fetch(AI + '/chat/' + encodeURIComponent(c.id), { method: 'DELETE' })
        if (!r.ok) errors.push(c.id)
      }))
      if (errors.length) showError(`${errors.length} chat(s) could not be deleted`)
    }
  } catch (err) {
    showError('Delete all failed: ' + err.message)
    return
  }
  currentChatId = null
  history       = []
  $('hfs-ai-msgs').querySelectorAll('.ai-msg-group').forEach(n => n.remove())
  $('hfs-ai-empty').style.display = ''
  initHistory()
  await loadChatList()
}

// ── Send message ──────────────────────────────────────────────────────────────
let searchMode = false

async function sendMessage() {
  const ta   = $('hfs-ai-textarea')
  const text = ta.value.trim()
  if (!text || isStreaming) return
  hideError()

  const snappedAtts = attachments.slice()
  const images      = snappedAtts.filter(a => a.type === 'image').map(a => a.base64)
  const files       = snappedAtts.filter(a => a.type === 'file')
  let textContent   = text
  if (files.length) textContent = files.map(f => `File: ${f.name}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n') + '\n\n' + textContent

  const doSearch = searchMode || shouldAutoSearch(text)
  if (doSearch) { searchMode = false; $('ai-search-btn').classList.remove('on') }

  const userMsg = images.length ? { role: 'user', content: textContent, images } : { role: 'user', content: textContent }
  ta.value = ''; ta.style.height = 'auto'; userScrolledUp = false
  appendUserMsg(text, snappedAtts); clearAtts()

  const { bubble, finalise } = appendAiMsg()

  // Web search
  let searchSysMsg = null
  if (doSearch) {
    try {
      const sr = await fetch(AI + '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text }),
      })
      if (sr.ok) {
        const sd = await sr.json()
        if (sd.context) searchSysMsg = { role: 'system', content: sd.context }
      } else {
        showError(`Search failed: HTTP ${sr.status}`)
      }
    } catch (err) {
      showError('Search failed: ' + err.message)
    }
  }

  if (searchSysMsg) history.push(searchSysMsg)
  history.push(userMsg)

  isStreaming = true; setSendUI(true)
  abortCtrl   = new AbortController()
  let fullResp = '', firstChunk = true
  ttsBuffer = ''; ttsQueue = []; ttsSpeaking = false; ttsActive = speakMode === 'stream'

  try {
    const res = await fetch(OLLAMA_HOST + '/api/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  abortCtrl.signal,
      body: JSON.stringify({
        model:      ollamaModel,
        messages:   cappedHistory().filter(m => !(m.role === 'system' && !m.content)),
        stream:     true,
        think:      thinkMode === 'on',
        keep_alive: '24h',
        options:    numPredict !== -1
          ? { num_predict: numPredict, temperature }
          : { temperature },
      }),
    })

    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch (_) {}
      throw new Error(`Ollama error ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`)
    }

    const reader = res.body.getReader()
    const dec    = new TextDecoder()
    let partial  = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      partial += dec.decode(value, { stream: true })
      const lines = partial.split('\n')
      partial     = lines.pop()   // keep incomplete line for next chunk
      for (const line of lines) {
        if (!line.trim()) continue
        let j
        try { j = JSON.parse(line) } catch { continue }
        if (j.message?.content) {
          if (firstChunk) {
            const ph = bubble.querySelector('.ai-typing-phase')
            if (ph) { ph.textContent = 'generating'; ph.style.color = '#5b8af5' }
            await new Promise(r => setTimeout(r, 100))
            bubble.innerHTML    = ''
            bubble.style.whiteSpace = 'pre-wrap'
            firstChunk          = false
          }
          fullResp += j.message.content
          bubble.textContent = fullResp
          bubble.appendChild(Object.assign(document.createElement('span'), { className: 'ai-stream-cursor' }))
          scrollBottom()
          if (speakMode === 'stream') feedTTS(j.message.content, false)
        }
        if (j.done) {
          finalise(fullResp, j)
          history.push({ role: 'assistant', content: fullResp })
          if (speakMode === 'stream') feedTTS('', true)
          schedSave()
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      window.speechSynthesis.cancel()
      if (fullResp) {
        finalise(fullResp, null)
        history.push({ role: 'assistant', content: fullResp })
        schedSave()
      } else {
        bubble.closest('.ai-msg-group')?.remove()
      }
    } else {
      const userMsg2 = err.message.includes('Failed to fetch')
        ? 'Cannot reach Ollama. Check host settings.'
        : err.message
      bubble.innerHTML = `<span style="color:#ff6b6b">⚠ ${escHtml(err.message)}</span>`
      showError(userMsg2)
    }
  } finally {
    isStreaming     = false
    setSendUI(false)
    abortCtrl       = null
    userScrolledUp  = false
    scrollBottom(true)
    checkStatus()
  }
}

function setSendUI(streaming) {
  $('ai-send-icon').style.display = streaming ? 'none' : ''
  $('ai-stop-icon').style.display = streaming ? '' : 'none'
  $('hfs-ai-send').disabled       = false
}

function handleSendStop() {
  if (isStreaming) { if (abortCtrl) abortCtrl.abort() }
  else if (!$('hfs-ai-textarea').value.trim() && !attachments.length) { if (!SRV.disableWhisper) toggleMic() }
  else sendMessage()
}

// ── TTS ───────────────────────────────────────────────────────────────────────
function getVoice() {
  const v = window.speechSynthesis.getVoices()
  return v.find(x => x.lang.startsWith('en')) || v[0] || null
}
function flushTTS() {
  if (!ttsActive || ttsSpeaking || !ttsQueue.length) {
    if (ttsActive && !ttsSpeaking && !ttsQueue.length) {
      const btn = $('ai-mute-btn')
      if (btn) btn.style.display = 'none'
    }
    return
  }
  const s = ttsQueue.shift()
  if (!s.trim()) { flushTTS(); return }
  const u = new SpeechSynthesisUtterance(s)
  const v = getVoice(); if (v) u.voice = v; u.rate = 1.0
  ttsSpeaking = true
  const btn = $('ai-mute-btn'); if (btn) btn.style.display = ''
  u.onend = u.onerror = () => { ttsSpeaking = false; flushTTS() }
  window.speechSynthesis.speak(u)
}
function feedTTS(text, flush) {
  if (!ttsActive) return
  ttsBuffer += text
  const parts = ttsBuffer.split(/(?<=[.!?])\s+/)
  if (flush) {
    parts.forEach(p => { if (p.trim()) ttsQueue.push(p) }); ttsBuffer = ''
  } else {
    for (let i = 0; i < parts.length - 1; i++) { if (parts[i].trim()) ttsQueue.push(parts[i]) }
    ttsBuffer = parts[parts.length - 1]
  }
  flushTTS()
}
function stripMd(text) {
  return text
    .replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
    .replace(/^#+\s/gm, '').trim()
}
window.aiToggleSpeak = function (btn) {
  const bubble = btn.closest('.ai-msg-group').querySelector('.ai-msg-bubble')
  const clone  = bubble.cloneNode(true)
  clone.querySelectorAll('.ai-token-stats').forEach(el => el.remove())
  const text = stripMd(clone.innerText)
  const on   = btn.querySelector('#spkon'), off = btn.querySelector('#spkoff')
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel()
    document.querySelectorAll('.ai-speak-btn.on').forEach(b => {
      b.classList.remove('on')
      b.querySelector('#spkon').style.display  = ''
      b.querySelector('#spkoff').style.display = 'none'
    })
    return
  }
  const doSpeak = () => {
    const u = new SpeechSynthesisUtterance(text)
    const v = getVoice(); if (v) u.voice = v; u.rate = 1.0
    btn.classList.add('on'); on.style.display = 'none'; off.style.display = ''
    u.onend = u.onerror = () => { btn.classList.remove('on'); on.style.display = ''; off.style.display = 'none' }
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u)
  }
  window.speechSynthesis.getVoices().length
    ? doSpeak()
    : (window.speechSynthesis.onvoiceschanged = () => { window.speechSynthesis.onvoiceschanged = null; doSpeak() })
}

// ── Mic / Whisper ─────────────────────────────────────────────────────────────
async function toggleMic() {
  if (micActive) stopMic(false)
  else await startMic()
}
async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) return
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
  catch (err) { showError('Microphone access denied: ' + err.message); return }
  if (speakMode === 'off' && !LS.getItem('ai_mic_speak_set')) {
    LS.setItem('ai_mic_speak_set', '1'); setSpeakMode('stream')
  }
  micActive = true; speechHeard = false; audioChunks = []
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  mediaRec   = new MediaRecorder(micStream, MediaRecorder.isTypeSupported(mime) ? { mimeType: mime } : {})
  mediaRec.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data) }
  mediaRec.onstop = onRecStop; mediaRec.start(100)
  audioCtx  = new (window.AudioContext || window.webkitAudioContext)()
  analyser  = audioCtx.createAnalyser(); analyser.fftSize = 512
  audioCtx.createMediaStreamSource(micStream).connect(analyser)
  $('hfs-ai-send').classList.add('recording')
  $('ai-send-icon').style.display = 'none'; $('ai-mic-icon').style.display = ''
  silTimer  = setTimeout(() => { silTimer = null; stopMic(true) }, 30000)
  watchVol()
}
function watchVol() {
  if (!micActive) return
  const buf = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(buf)
  const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length)
  if (rms > SILENCE_THRESHOLD) {
    if (!speechHeard) { speechHeard = true; clearTimeout(silTimer); silTimer = null }
    else { clearTimeout(silTimer); silTimer = null }
  } else if (speechHeard && !silTimer) {
    silTimer = setTimeout(() => { silTimer = null; stopMic(true) }, SILENCE_GRACE_MS)
  }
  requestAnimationFrame(watchVol)
}
function stopMic(doTx) {
  micActive = false; clearTimeout(silTimer); silTimer = null
  if (analyser) { analyser.disconnect(); analyser = null }
  if (audioCtx) { audioCtx.close(); audioCtx = null }
  if (mediaRec && mediaRec.state !== 'inactive') { mediaRec._tx = doTx; mediaRec.stop() } else resetMic()
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null }
}
function onRecStop() {
  const doTx = mediaRec?._tx ?? false
  const mime  = mediaRec?.mimeType || 'audio/webm'
  const blob  = new Blob(audioChunks, { type: mime })
  audioChunks = []
  if (!doTx || blob.size < 512) { resetMic(); return }
  transcribe(blob, mime)
}
async function transcribe(blob, mime) {
  $('hfs-ai-send').classList.remove('recording'); $('hfs-ai-send').classList.add('transcribing')
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'
  const fd  = new FormData()
  fd.append('file', blob, `rec.${ext}`); fd.append('model', WHISPER_MODEL); fd.append('response_format', 'json')
  try {
    const r = await fetch(WHISPER_URL, { method: 'POST', body: fd })
    if (!r.ok) throw new Error(`Whisper HTTP ${r.status}`)
    const d  = await r.json()
    const tx = (d.text || '').trim()
    if (tx) {
      const ta = $('hfs-ai-textarea')
      ta.value += (ta.value.length && !ta.value.endsWith(' ') ? ' ' : '') + tx
      ta.dispatchEvent(new Event('input'))
      setTimeout(() => sendMessage(), 0)
    }
  } catch (err) {
    showError('Whisper failed: ' + err.message)
  } finally {
    resetMic()
  }
}
function resetMic() {
  micActive = false
  $('hfs-ai-send').classList.remove('recording', 'transcribing')
  $('ai-mic-icon').style.display  = 'none'
  $('ai-send-icon').style.display = ''
}

// ── Web search ────────────────────────────────────────────────────────────────
window.openDDG = function () {
  const q = $('hfs-ai-textarea').value.trim() || (history.filter(m => m.role === 'user').slice(-1)[0]?.content || '')
  window.open('https://duckduckgo.com/?q=' + encodeURIComponent(q), '_blank')
}
window.toggleSearchMode = function (e) {
  if (e) e.preventDefault()
  searchMode = !searchMode
  $('ai-search-btn').classList.toggle('on', searchMode)
  $('ai-search-btn').title = searchMode
    ? 'AI Search: On — Hold To Toggle Off'
    : 'DuckDuckGo Search (Click) — AI Search (Hold)'
}
window.toggleSearchBalloon = function () {
  buildSearchBalloon()
  $('ai-srch-balloon').classList.toggle('on')
}
function buildSearchBalloon() {
  const b = $('ai-srch-balloon'); if (!b) return
  const groups = [
    { label: 'Explicit commands', patterns: SEARCH_EXPLICIT },
    { label: 'Recency signals',   patterns: SEARCH_RECENCY },
    { label: 'Question patterns', patterns: SEARCH_QUESTIONS },
    { label: 'Live data topics',  patterns: SEARCH_TOPICS },
  ]
  b.innerHTML = groups.map(g =>
    `<b>${g.label}</b>` + g.patterns.map(p => `<span class="ai-kw">${escHtml(p.label)}</span>`).join(' ')
  ).join('')
}

// ── Auto-search keyword matching ──────────────────────────────────────────────
function buildDefaultSearchPatterns(csv) {
  return csv.split(',').map(s => s.trim()).filter(Boolean).map(phrase => ({
    re:    new RegExp('\\b' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\b', 'i'),
    label: phrase,
  }))
}
function shouldAutoSearch(text) {
  const t = text.toLowerCase()
  return [...SEARCH_EXPLICIT, ...SEARCH_RECENCY, ...SEARCH_QUESTIONS, ...SEARCH_TOPICS].some(({ re }) => re.test(t))
}

// ── Persona ───────────────────────────────────────────────────────────────────
function updatePersonaDescs() {
  const trunc = s => {
    if (!s) return ''
    s = s.trim().replace(/\s+/g, ' ')
    return s.length > 60 ? s.slice(0, 57) + '…' : s
  }
  const std = $('ai-persona-desc-prompt1'); if (std) std.textContent = trunc(PERSONA_PROMPTS.prompt1) || '(empty)'
  const hum = $('ai-persona-desc-prompt2');    if (hum) hum.textContent = trunc(PERSONA_PROMPTS.prompt2)    || '(empty)'
}
function setPersona(m) {
  personaMode = m; LS.setItem('ai_persona', m)
  document.querySelectorAll('[data-persona]').forEach(el => el.classList.toggle('sel', el.dataset.persona === m))
  $('ai-settings-btn').classList.toggle('active', m !== 'prompt1' || speakMode !== 'off')
  $('ai-settings-dd').classList.remove('open')
  const prompt = PERSONA_PROMPTS[m] || ''
  if (history.length && history[0].role === 'system') history[0].content = prompt
}
function openPromptEditor(m) {
  editingPersona = m
  $('ai-prompt-editor-label').textContent = `Edit ${m === 'prompt2' ? 'Prompt 2' : 'Prompt 1'} prompt`
  $('ai-prompt-editor-text').value        = PERSONA_PROMPTS[m] || ''
  $('ai-prompt-editor').style.display     = 'block'
  $('ai-settings-dd').classList.add('open')
}
function closePromptEditor() { editingPersona = null; $('ai-prompt-editor').style.display = 'none' }
function savePromptEditor() {
  if (!editingPersona) return
  const val = $('ai-prompt-editor-text').value
  PERSONA_PROMPTS[editingPersona] = val
  if (editingPersona === 'prompt1') SERVER_PROMPT1_PROMPT = val; // keep in sync if edited
  LS.setItem(editingPersona === 'prompt1' ? 'ai_prompt_prompt1' : 'ai_prompt_prompt2', val)
  if (personaMode === editingPersona && history.length && history[0].role === 'system') history[0].content = val
  updatePersonaDescs(); closePromptEditor()
}
function resetPromptEditor() {
  if (!editingPersona) return
  const def = editingPersona === 'prompt1' ? SERVER_PROMPT1_PROMPT : SERVER_PROMPT2_PROMPT
  PERSONA_PROMPTS[editingPersona] = def
  LS.removeItem(editingPersona === 'prompt1' ? 'ai_prompt_prompt1' : 'ai_prompt_prompt2')
  if (personaMode === editingPersona && history.length && history[0].role === 'system') history[0].content = def
  $('ai-prompt-editor-text').value = def
  updatePersonaDescs()
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function setTheme(t) {
  chatTheme = t; LS.setItem('ai_theme', t)
  document.querySelectorAll('[data-theme]').forEach(el => el.classList.toggle('sel', el.dataset.theme === t))
  applyTheme()
  $('ai-settings-dd').classList.remove('open')
}
function applyTheme() {
  const root = $('hfs-ai-root')
  if (root) root.setAttribute('data-ai-theme', chatTheme === 'navy' ? 'navy' : 'hfs')
}

// ── Speak ─────────────────────────────────────────────────────────────────────
function setSpeakMode(m, userAction = false) {
  speakMode = m; LS.setItem('ai_speak', m)
  if (m === 'off' && userAction) LS.setItem('ai_mic_speak_set', '1')
  window.speechSynthesis.cancel()
  document.querySelectorAll('[data-speak]').forEach(el => el.classList.toggle('sel', el.dataset.speak === m))
  $('ai-settings-btn').classList.toggle('active', personaMode !== 'prompt1' || m !== 'off')
  $('ai-settings-dd').classList.remove('open')
}

// ── Think mode ────────────────────────────────────────────────────────────────
function setThinkMode(m) {
  thinkMode = m; LS.setItem('ai_think', m)
  document.querySelectorAll('[data-think]').forEach(el => el.classList.toggle('sel', el.dataset.think === m))
  $('ai-settings-dd').classList.remove('open')
}

// ── Settings sliders ──────────────────────────────────────────────────────────
function initSettingsSliders() {
  const npi = $('ai-np-input'); if (!npi) return
  npi.value    = numPredict
  npi.onchange = () => {
    let v = parseInt(npi.value, 10)
    if (isNaN(v) || v < -1) v = -1; if (v > 8192) v = 8192
    npi.value = v; numPredict = v; LS.setItem('ai_numpredict', v)
  }
  const tpi = $('ai-tmp-input'); if (!tpi) return
  tpi.value    = temperature
  tpi.onchange = () => {
    let v = parseFloat(tpi.value)
    if (isNaN(v) || v < 0) v = 0; if (v > 2) v = 2
    tpi.value = v; temperature = v; LS.setItem('ai_temp', v)
  }
}

// ── Admin locks ───────────────────────────────────────────────────────────────
function applyAdminLocks() {
  const show = (id, visible) => { const el = $(id); if (el) el.style.display = visible ? '' : 'none' }
  show('ai-persona-section', !SRV.disablePersonaSwitch)
  show('ai-think-section',   !SRV.disableThink)
  show('ai-values-section',  !SRV.disableAiValues)
  // Hide mic button and hint when Whisper is disabled by admin
  if (SRV.disableWhisper) {
    show('ai-mic-icon', false)
    show('ai-mic-hint', false)
  }
  // Model trigger: hide caret + cursor if locked
  if (SRV.lockModel) {
    const t = $('ai-model-trigger'); if (t) { t.style.cursor = 'default'; t.title = '' }
    const c = document.querySelector('.ai-model-caret'); if (c) c.style.display = 'none'
  }
}

// ── Init history with persona system prompt ───────────────────────────────────
function initHistory() {
  const prompt = PERSONA_PROMPTS[personaMode] || ''
  history = [{ role: 'system', content: prompt }]
}

// ── Chat controls ─────────────────────────────────────────────────────────────
window.aiResetDefaults = async function () {
  $('ai-settings-dd').classList.remove('open')
  const ok = await askConfirm('Reset to defaults?', 'This will reset persona, speak, temperature, and response length to their default values.', 'Reset')
  if (!ok) return
  ;['ai_persona','ai_speak','ai_think','ai_numpredict','ai_temp','ai_mic_speak_set','ai_prompt_prompt1','ai_prompt_prompt2']
    .forEach(k => LS.removeItem(k))
  PERSONA_PROMPTS.prompt1 = SERVER_PROMPT1_PROMPT
  PERSONA_PROMPTS.prompt2    = SERVER_PROMPT2_PROMPT
  updatePersonaDescs()
  personaMode = SRV.persona ?? 'prompt1'
  speakMode   = SRV.speak       ?? 'off'
  thinkMode   = SRV.think       ?? 'off'
  numPredict  = SRV.numPredict  ?? -1
  temperature = SRV.temperature ?? 1.0
  setPersona(personaMode); setSpeakMode(speakMode); setThinkMode(thinkMode); initSettingsSliders()
}

window.aiClearChat = async function () {
  const ok = await askConfirm('Clear conversation?', 'This will clear the current chat.', 'Clear')
  if (!ok) return
  history = []; currentChatId = null; attachments = []; renderAttBar()
  $('hfs-ai-msgs').querySelectorAll('.ai-msg-group').forEach(n => n.remove())
  $('hfs-ai-empty').style.display = ''
  initHistory()
}

window.aiDownloadConvo = function () {
  if (!history.length) return
  const lines = history.filter(m => m.role !== 'system')
    .map(m => `[${m.role === 'user' ? 'You' : ollamaModel}]\n${m.content}`)
  mobileDownload(lines.join('\n\n---\n\n'), `${ollamaModel}-${Date.now()}.txt`, 'text/plain')
}

// ── Drag: floating button ─────────────────────────────────────────────────────
function initDrag() {
  const btn = $('hfs-ai-btn')
  const sx  = LS.getItem('ai_btn_x'), sy = LS.getItem('ai_btn_y')
  if (sx !== null && sy !== null) {
    btn.style.right = btn.style.bottom = 'auto'
    btn.style.left  = sx + 'px'; btn.style.top = sy + 'px'
  }
  btn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    const rect = btn.getBoundingClientRect()
    dragOffX = e.clientX - rect.left; dragOffY = e.clientY - rect.top; isDragging = false
    function onMove(e) {
      const dx = Math.abs(e.clientX - (rect.left + dragOffX)), dy = Math.abs(e.clientY - (rect.top + dragOffY))
      if (!isDragging && (dx > 4 || dy > 4)) isDragging = true
      if (!isDragging) return
      let x = Math.max(0, Math.min(window.innerWidth  - btn.offsetWidth,  e.clientX - dragOffX))
      let y = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, e.clientY - dragOffY))
      btn.style.right = btn.style.bottom = 'auto'
      btn.style.left  = x + 'px'; btn.style.top = y + 'px'
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup',   onUp)
      if (isDragging) {
        LS.setItem('ai_btn_x', parseInt(btn.style.left))
        LS.setItem('ai_btn_y', parseInt(btn.style.top))
        setTimeout(() => { isDragging = false }, 0)
      }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup',   onUp)
  })
}

// ── Drag: panel header ────────────────────────────────────────────────────────
function initPanelDrag() {
  const panel  = $('hfs-ai-panel')
  const handle = $('hfs-ai-header')
  const sx = LS.getItem('ai_panel_x'), sy = LS.getItem('ai_panel_y')
  if (sx !== null && sy !== null) {
    panel.style.right = panel.style.bottom = 'auto'
    panel.style.left  = sx + 'px'; panel.style.top = sy + 'px'
  }
  handle.style.cursor = 'grab'
  let pdragOffX = 0, pdragOffY = 0, pdragging = false
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    if (e.target.closest('button,input,select,.ai-status-pill,#ai-model-trigger')) return
    const rect = panel.getBoundingClientRect()
    pdragOffX  = e.clientX - rect.left; pdragOffY = e.clientY - rect.top; pdragging = false
    handle.style.cursor = 'grabbing'
    function onMove(e) {
      const dx = Math.abs(e.clientX - (rect.left + pdragOffX)), dy = Math.abs(e.clientY - (rect.top + pdragOffY))
      if (!pdragging && (dx > 4 || dy > 4)) pdragging = true
      if (!pdragging) return
      let x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - pdragOffX))
      let y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - pdragOffY))
      panel.style.right = panel.style.bottom = 'auto'
      panel.style.left  = x + 'px'; panel.style.top = y + 'px'
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup',   onUp)
      handle.style.cursor = 'grab'
      if (pdragging) {
        LS.setItem('ai_panel_x', parseInt(panel.style.left))
        LS.setItem('ai_panel_y', parseInt(panel.style.top))
      }
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup',   onUp)
  })
}

// ── Reset positions ───────────────────────────────────────────────────────────
function resetPositions(e) {
  if (e) e.preventDefault()
  ;['ai_btn_x','ai_btn_y','ai_panel_x','ai_panel_y'].forEach(k => LS.removeItem(k))
  const btn   = $('hfs-ai-btn'), panel = $('hfs-ai-panel')
  btn.style.left   = btn.style.top   = btn.style.right   = btn.style.bottom   = ''
  panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = ''
}

// ── Alt+A visibility toggle ───────────────────────────────────────────────────
function toggleUIVisibility() {
  uiVisible = !uiVisible
  const root = $('hfs-ai-root')
  if (!uiVisible) {
    savedPanelOpen = panelOpen; savedFullscreen = isFullscreen
    root.style.display = 'none'
    if (panelOpen) { panelOpen = false; $('hfs-ai-panel').classList.remove('open') }
    LS.setItem('ai_ui_hidden', '1')
  } else {
    root.style.display = ''
    if (savedPanelOpen) {
      panelOpen = true; $('hfs-ai-panel').classList.add('open')
      if (savedFullscreen) {
        isFullscreen = true; $('hfs-ai-panel').classList.add('fullscreen')
        $('hfs-ai-panel').style.left = $('hfs-ai-panel').style.top =
          $('hfs-ai-panel').style.right = $('hfs-ai-panel').style.bottom = ''
        initSettingsSliders()
      }
      $('hfs-ai-textarea').focus()
    }
    LS.removeItem('ai_ui_hidden')
  }
}

function restoreUIVisibility() {
  if (LS.getItem('ai_ui_hidden') === '1') {
    uiVisible = false
    $('hfs-ai-root').style.display = 'none'
  }
}
document.addEventListener('keydown', e => {
  if (e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); toggleUIVisibility() }
})

// ── Wire all events ───────────────────────────────────────────────────────────
function wire() {
  on('hfs-ai-btn',  'click',       togglePanel)
  on('hfs-ai-btn',  'contextmenu', resetPositions)
  on('ai-close-btn','click',       togglePanel)
  on('ai-history-btn',      'click', toggleHistorySidebar)
  on('ai-deleteall-btn',    'click', deleteAllChats)
  on('ai-history-close-btn','click', toggleHistorySidebar)
  on('ai-newchat-btn','click', () => {
    history = []; currentChatId = null; attachments = []; renderAttBar()
    $('hfs-ai-msgs').querySelectorAll('.ai-msg-group').forEach(n => n.remove())
    $('hfs-ai-empty').style.display = ''
    if (historyOpen) { historyOpen = false; $('hfs-ai-history-sidebar').classList.remove('open') }
    initHistory()
  })
  on('ai-expand-btn',   'click', toggleFullscreen)
  on('ai-model-trigger','click', () => { if (!SRV.lockModel) toggleModelPop() })
  on('hfs-ai-send', 'click', handleSendStop)

  // Paperclip: click = attach | right-click / long-press = download chat
  ;(function () {
    const btn = $('ai-attach-btn')
    let holdTimer = null, didHold = false
    async function triggerDownload() {
      if (!history.filter(m => m.role !== 'system').length) return
      const ok = await askConfirm('Download chat?', 'Save the current conversation as a text file.', 'Download')
      if (!ok) return
      aiDownloadConvo()
      btn.classList.add('active'); setTimeout(() => btn.classList.remove('active'), 800)
    }
    btn.addEventListener('click', () => { if (didHold) { didHold = false; return } $('ai-file-input').click() })
    btn.addEventListener('contextmenu', e => { e.preventDefault(); triggerDownload() })
    btn.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      didHold = false
      holdTimer = setTimeout(() => { didHold = true; triggerDownload() }, 600)
    })
    const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null }
    btn.addEventListener('pointerup',    cancelHold)
    btn.addEventListener('pointerleave', cancelHold)
  })()

  // Search: click = DDG | right-click / long-press = toggle AI search
  ;(function () {
    const btn = $('ai-search-btn')
    let holdTimer = null, didHold = false
    btn.addEventListener('click', e => { if (didHold) { didHold = false; return } openDDG(e) })
    btn.addEventListener('contextmenu', e => { e.preventDefault(); toggleSearchMode(e) })
    btn.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      didHold = false
      holdTimer = setTimeout(() => {
        didHold = true; toggleSearchMode()
        btn.classList.add('active'); setTimeout(() => btn.classList.remove('active'), 300)
      }, 600)
    })
    const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null }
    btn.addEventListener('pointerup',    cancelHold)
    btn.addEventListener('pointerleave', cancelHold)
  })()

  on('ai-file-input', 'change', e => handleFiles(e.target.files))
  on('ai-settings-btn','click', () => {
    $('ai-settings-dd').classList.toggle('open')
    if ($('ai-settings-dd').classList.contains('open')) initSettingsSliders()
  })
  on('ai-mute-btn','click', () => {
    window.speechSynthesis.cancel()
    ttsActive = false; ttsQueue = []; ttsBuffer = ''; ttsSpeaking = false
    $('ai-mute-btn').style.display = 'none'
    document.querySelectorAll('.ai-speak-btn.on').forEach(b => {
      b.classList.remove('on')
      b.querySelector('#spkon').style.display  = ''
      b.querySelector('#spkoff').style.display = 'none'
    })
  })

  document.querySelectorAll('[data-persona]').forEach(el => el.addEventListener('click', () => setPersona(el.dataset.persona)))
  document.querySelectorAll('[data-edit-persona]').forEach(el =>
    el.addEventListener('click', e => { e.stopPropagation(); openPromptEditor(el.dataset.editPersona) })
  )
  $('ai-prompt-editor-save').addEventListener('click',   e => { e.stopPropagation(); savePromptEditor() })
  $('ai-prompt-editor-reset').addEventListener('click',  e => { e.stopPropagation(); resetPromptEditor() })
  $('ai-prompt-editor-cancel').addEventListener('click', e => { e.stopPropagation(); closePromptEditor() })
  $('ai-prompt-editor-text').addEventListener('click',   e => e.stopPropagation())

  document.querySelectorAll('[data-speak]').forEach(el => el.addEventListener('click', () => setSpeakMode(el.dataset.speak, true)))
  document.querySelectorAll('[data-think]').forEach(el => el.addEventListener('click', () => setThinkMode(el.dataset.think)))
  document.querySelectorAll('[data-theme]').forEach(el => el.addEventListener('click', () => setTheme(el.dataset.theme)))

  const ta = $('hfs-ai-textarea')
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } })
  ta.addEventListener('input',   () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 150) + 'px' })

  $('hfs-ai-msgs').addEventListener('scroll', () => {
    const b = $('hfs-ai-msgs'); userScrolledUp = (b.scrollHeight - b.scrollTop - b.clientHeight) > 80
  })

  // Close popovers on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#hfs-ai-model-pop')        && !e.target.closest('#ai-model-trigger'))
      $('hfs-ai-model-pop').classList.remove('open')
    if (!e.target.closest('#ai-settings-wrap'))
      $('ai-settings-dd').classList.remove('open')
    if (!e.target.closest('.ai-search-info-wrap'))
      $('ai-srch-balloon').classList.remove('on')
    if (!e.target.closest('#hfs-ai-history-sidebar') && !e.target.closest('#ai-history-btn'))
      if (historyOpen) { historyOpen = false; $('hfs-ai-history-sidebar').classList.remove('open') }
  })

  setPersona(personaMode); setSpeakMode(speakMode); setThinkMode(thinkMode)
  document.querySelectorAll('[data-theme]').forEach(el => el.classList.toggle('sel', el.dataset.theme === chatTheme))
}

// ── Boot: fetch server defaults ───────────────────────────────────────────────
async function fetchDefaults() {
  try {
    const r = await fetch(AI + '/defaults', { signal: AbortSignal.timeout(4000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    SRV = d

    if (d.prompt1Prompt !== undefined) {
      SERVER_PROMPT1_PROMPT     = d.prompt1Prompt
      PERSONA_PROMPTS.prompt1   = d.prompt1Prompt
    }
    if (d.prompt2Prompt !== undefined) {
      SERVER_PROMPT2_PROMPT      = d.prompt2Prompt
      PERSONA_PROMPTS.prompt2    = d.prompt2Prompt
    }

    // User localStorage overrides win over server defaults
    const stdOvr = LS.getItem('ai_prompt_prompt1'), humOvr = LS.getItem('ai_prompt_prompt2')
    if (stdOvr !== null) PERSONA_PROMPTS.prompt1 = stdOvr
    if (humOvr !== null) PERSONA_PROMPTS.prompt2    = humOvr

    // Rebuild search pattern arrays from admin-configured CSV strings
    const toPatterns = str => buildDefaultSearchPatterns(str)
    if (d.searchExplicit  !== undefined) SEARCH_EXPLICIT  = toPatterns(d.searchExplicit)
    if (d.searchRecency   !== undefined) SEARCH_RECENCY   = toPatterns(d.searchRecency)
    if (d.searchQuestions !== undefined) SEARCH_QUESTIONS = toPatterns(d.searchQuestions)
    if (d.searchTopics    !== undefined) SEARCH_TOPICS    = toPatterns(d.searchTopics)

  } catch (_) {
    // Server unavailable — continue with built-in defaults
  }

  // Resolve final values: localStorage > server default > hardcoded default
  if (personaMode === null) personaMode = SRV.persona ?? 'prompt1'
  if (speakMode   === null) speakMode   = SRV.speak        ?? 'off'
  if (thinkMode   === null) thinkMode   = SRV.think        ?? 'off'
  if (numPredict  === null) numPredict  = SRV.numPredict   ?? -1
  if (temperature === null) temperature = SRV.temperature  ?? 1.0

  // Admin hard-locks override user prefs
  if (SRV.disablePersonaSwitch) personaMode = SRV.persona ?? 'prompt1'
  if (SRV.disableThink)         thinkMode   = SRV.think      ?? 'off'
  if (SRV.disableAiValues)      { numPredict = SRV.numPredict ?? -1; temperature = SRV.temperature ?? 1.0 }

  if (!ollamaModel && SRV.model) ollamaModel = SRV.model.replace(/:latest$/i, '')
  if (SRV.lockModel && SRV.model) {
    ollamaModel = SRV.model.replace(/:latest$/i, '')
    LS.setItem('ai_model', ollamaModel)
  }
  if (chatTheme === null) chatTheme = SRV.theme ?? 'hfs'
}

// ── Login / logout watcher ────────────────────────────────────────────────────
function watchLoginTransition() {
  function getLabelText() { return document.querySelector('#login-button .label')?.textContent.trim() || null }
  function isLoginLabel(t) { return !t || t.toLowerCase() === 'login' }
  let lastWasGuest = isLoginLabel(getLabelText())

  function onTransition() {
    const nowGuest = isLoginLabel(getLabelText())
    if (nowGuest === lastWasGuest) return
    lastWasGuest = nowGuest
    if (!$('hfs-ai-root')) { if (!nowGuest) init(); return }
    detectGuest(); currentChatId = null; history = []
    $('hfs-ai-msgs').querySelectorAll('.ai-msg-group').forEach(n => n.remove())
    $('hfs-ai-empty').style.display = ''
    loadChatList()
  }

  const nav = document.querySelector('nav, header, #hfs-menu, body')
  new MutationObserver(onTransition).observe(nav || document.body, { subtree: true, childList: true, characterData: true })
}

// ── Main init ─────────────────────────────────────────────────────────────────
async function init() {
  await Promise.all([fetchDefaults(), loadMarked(), loadDOMPurify()])
  if (SRV.requireLogin && !HFS?.state?.username) { watchLoginTransition(); return }
  buildHTML()
  restoreUIVisibility()
  applyTheme()
  updatePersonaDescs()
  wire()
  applyAdminLocks()
  initDrag()
  initPanelDrag()
  initHistory()
  detectGuest()
  loadChatList()
  checkStatus()
  watchLoginTransition()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()

})()
