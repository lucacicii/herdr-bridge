export const FRAME_DATA = 0;
export const FRAME_CREDIT = 1;
export const FRAME_CLOSE = 2;
export const FRAME_RESIZE = 3;
export const FRAME_FOCUS = 4;
export const FRAME_FACTS = 5;
export const FRAME_AUTOMATIC_INPUT = 6;

export const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;

export type AgentState = 'idle' | 'working' | 'done' | 'blocked' | 'error' | string;

export interface HcStatus {
  state: AgentState;
  app?: string;
  kind?: string;
  msg?: string;
  progress?: number;
  title?: string;
}

export interface HcForeground {
  pid: number;
  name: string;
  argv: string[];
  cwd: string;
}

export interface HcTerminal {
  address: string;
  name: string | null;
  title: string;
  argv: string[];
  cwd: string;
  state: 'live' | 'finished' | string;
  created_ms: number;
  finished_ms?: number;
  exit_code?: number;
  signal?: number;
  reason?: string;
  cols: number;
  rows: number;
  pid?: number;
  parent?: string;
  keep: boolean;
  labels: Record<string, string>;
  status: HcStatus | null;
  status_ms?: number;
  foreground: HcForeground | null;
  template?: string;
  turn: number;
  screen: string;
}

export interface HcListResult {
  terminals: HcTerminal[];
  hidden_finished: number;
  machines: unknown;
}

export interface HcCoreInfo {
  id: string;
  name: string;
}

export interface HcHelloResult {
  generation: number;
  version: string;
  core: HcCoreInfo;
  framed: boolean;
  methods: string[];
  features: string[];
}

export interface HcStatusResult {
  core: HcCoreInfo;
  version: string;
  live: number;
  finished: number;
  pid: number;
  uptime_ms: number;
}

export interface HcAttachParams {
  terminal: string;
  cols: number;
  rows: number;
  history?: number;
  observe?: boolean;
  resize_notifications?: boolean;
  resumed?: boolean;
}

export interface HcAttachResult {
  channel: number;
  terminal: HcTerminal;
  resize_notifications: boolean;
  automatic_input: boolean;
}

export interface HcRunParams {
  argv?: string[];
  line?: string;
  cwd?: string;
  name?: string;
  keep?: boolean;
  labels?: Record<string, string>;
  size?: { cols: number; rows: number };
}

export interface HcReadResult {
  text: string;
  complete: boolean;
  how: string;
}

export interface HcSubscribeResult {
  channel: number | null;
  seq: number;
  terminals: HcTerminal[];
}

export interface HcFrame {
  channel: number;
  kind: number;
  payload: Buffer;
}

export interface HcEnvStatus {
  hcCli: {
    installed: boolean;
    path?: string;
    version?: string;
  };
  daemon: {
    running: boolean;
    socketPath: string;
    version?: string;
    pid?: number;
    liveTerminals?: number;
    error?: string;
  };
  herdrApp?: {
    installed: boolean;
    path?: string;
  };
}

export interface HcAppSpace {
  id: string;
  name: string;
  folder: string;
  machine?: string | null;
  active?: boolean;
}

export interface HcAppDoc {
  spaces?: HcAppSpace[];
}

export interface HerdrSpace {
  id: string;
  name: string;
  folder: string;
  terminals: HcTerminal[];
  unassigned?: boolean;
}

