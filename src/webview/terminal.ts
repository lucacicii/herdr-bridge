import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};

const vscode = acquireVsCodeApi();
const initialTerminalId = document.body.dataset.terminalId;
if (initialTerminalId) {
  vscode.setState({ terminalId: initialTerminalId });
}

const container = document.getElementById('terminal-container')!;
const titleEl = document.getElementById('term-title')!;
const dimsEl = document.getElementById('term-dims')!;
const fitBtn = document.getElementById('btn-fit') as HTMLButtonElement;
const ctrlCBtn = document.getElementById('btn-ctrlc') as HTMLButtonElement;
const nativeBtn = document.getElementById('btn-native') as HTMLButtonElement;

function cssVar(name: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

const term = new Terminal({
  cursorBlink: true,
  scrollback: 5000,
  convertEol: false,
  fontSize: Number.parseInt(cssVar('--vscode-editor-font-size', '13'), 10) || 13,
  fontFamily: cssVar(
    '--vscode-terminal-font-family',
    cssVar('--vscode-editor-font-family', 'Menlo, Monaco, monospace')
  ),
  theme: {
    background: cssVar('--vscode-terminal-background', cssVar('--vscode-editor-background', '#111111')),
    foreground: cssVar('--vscode-terminal-foreground', cssVar('--vscode-foreground', '#cccccc')),
    cursor: cssVar('--vscode-terminalCursor-foreground', '#ffffff'),
    selectionBackground: cssVar('--vscode-terminal-selectionBackground', 'rgba(255,255,255,0.2)'),
  },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());
term.open(container);

let autoFit = true;

function updateDimsLabel(cols: number, rows: number): void {
  dimsEl.textContent = `${cols}×${rows}`;
}

function fitAndNotify(): void {
  if (!autoFit) {
    return;
  }
  const proposed = fitAddon.proposeDimensions();
  if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) {
    return;
  }
  if (proposed.cols !== term.cols || proposed.rows !== term.rows) {
    term.resize(proposed.cols, proposed.rows);
    updateDimsLabel(proposed.cols, proposed.rows);
    vscode.postMessage({ type: 'resize', cols: proposed.cols, rows: proposed.rows });
  }
}

// Custom file path link provider (`path/file.ts:12:4`)
const PATH_LINK_RE = /(?:~\/|\/|\.\.?\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_.\-\/]+\.[A-Za-z0-9]+(?::(\d+)(?::(\d+))?)?/g;

term.registerLinkProvider({
  provideLinks(bufferLineNumber, callback) {
    const line = term.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }
    const text = line.translateToString(true);
    const links = [];
    PATH_LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PATH_LINK_RE.exec(text)) !== null) {
      const raw = match[0];
      const colonIdx = raw.indexOf(':');
      const filePath = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
      const lineNum = match[1] ? Number.parseInt(match[1], 10) : 1;
      const colNum = match[2] ? Number.parseInt(match[2], 10) : 1;
      const startX = match.index + 1;
      const endX = match.index + raw.length;
      links.push({
        range: {
          start: { x: startX, y: bufferLineNumber },
          end: { x: endX, y: bufferLineNumber },
        },
        text: raw,
        activate() {
          vscode.postMessage({
            type: 'openLink',
            filePath,
            line: Number.isFinite(lineNum) ? lineNum : 1,
            column: Number.isFinite(colNum) ? colNum : 1,
          });
        },
      });
    }
    callback(links);
  },
});

term.onData((data) => {
  vscode.postMessage({ type: 'input', data });
});

term.textarea?.addEventListener('focus', () => {
  vscode.postMessage({ type: 'focus', focused: true });
});

term.textarea?.addEventListener('blur', () => {
  vscode.postMessage({ type: 'focus', focused: false });
});

container.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text/plain');
  if (text && text.includes('\n')) {
    event.preventDefault();
    vscode.postMessage({ type: 'paste', text, bracketed: true });
  }
});

container.addEventListener('dragover', (event) => {
  event.preventDefault();
});

container.addEventListener('drop', (event) => {
  event.preventDefault();
  const uriList = event.dataTransfer?.getData('text/uri-list');
  if (uriList) {
    vscode.postMessage({ type: 'dropUris', uriList });
  }
});

fitBtn.addEventListener('click', () => {
  autoFit = !autoFit;
  fitBtn.textContent = autoFit ? 'Fit: On' : 'Fit: Off';
  fitBtn.classList.toggle('active', !autoFit);
  if (autoFit) {
    fitAndNotify();
  }
  term.focus();
});

ctrlCBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'interrupt' });
  term.focus();
});

nativeBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'switchMode' });
});

const resizeObserver = new ResizeObserver(() => {
  fitAndNotify();
});
resizeObserver.observe(container);

window.addEventListener('message', (event) => {
  const msg = event.data as
    | { type: 'ready'; address?: string; title: string; cols: number; rows: number }
    | { type: 'data'; data: string }
    | { type: 'resize'; cols: number; rows: number }
    | { type: 'closed'; reason: string }
    | { type: 'error'; message: string };

  switch (msg.type) {
    case 'ready':
      if (msg.address) {
        vscode.setState({ terminalId: msg.address });
      }
      titleEl.textContent = msg.title;
      if (msg.cols > 0 && msg.rows > 0 && (msg.cols !== term.cols || msg.rows !== term.rows)) {
        term.resize(msg.cols, msg.rows);
      }
      updateDimsLabel(term.cols, term.rows);
      term.focus();
      break;
    case 'data':
      term.write(msg.data);
      break;
    case 'resize':
      if (!autoFit && msg.cols > 0 && msg.rows > 0) {
        term.resize(msg.cols, msg.rows);
        updateDimsLabel(msg.cols, msg.rows);
      }
      break;
    case 'closed':
      term.write(`\r\n\x1b[90m[herdr-core detached: ${msg.reason}]\x1b[0m\r\n`);
      break;
    case 'error':
      term.write(`\r\n\x1b[31m[herdr-core error: ${msg.message}]\x1b[0m\r\n`);
      break;
  }
});

fitAddon.fit();
updateDimsLabel(term.cols, term.rows);
vscode.postMessage({ type: 'ready', cols: term.cols, rows: term.rows });
