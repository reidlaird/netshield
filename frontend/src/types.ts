// Shared shapes for the dashboard: server payloads (status, connections,
// investigations, router state) and the UI's filter/sort unions.

export type CollectorStatus = {
  collector: 'starting' | 'running' | 'error';
  lastError: string;
  collectedAt: string;
  adapters: Adapter[];
  routes: DefaultRoute[];
  sniffer?: { state: 'stopped' | 'running' | 'error'; detail: string };
};

export type Adapter = {
  interfaceAlias: string;
  ipv4: string[];
  ipv6: string[];
  gateway: string[];
};

export type DefaultRoute = {
  destinationPrefix: string;
  gateway: string;
  interfaceAlias: string;
  routeMetric: number;
};

export type Settings = {
  selectedAdapter: string;
  pollIntervalMs: number;
  historyRetentionDays: number;
  geoIpDatabasePath: string;
  optionalApisEnabled: boolean;
};

export type Connection = {
  id: string;
  protocol: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  state: string;
  pid: number;
  processName: string;
  processPath: string;
  interfaceAlias: string;
  gateway: string;
  firstSeen: string;
  lastSeen: string;
  status: 'open' | 'closed';
  deviceName?: string;
};

export type RouterDevice = {
  mac: string;
  ip: string;
  hostname: string;
  vendor?: string;
  randomizedMac?: boolean;
  connectionType: string;
  signal: string;
  linkRate: string;
  online: boolean;
};

export type RouterGateway = {
  model: string;
  productId: string;
  firmware: string;
  ip: string;
  serial: string;
};

export type RouterState = {
  configured: boolean;
  collectedAt: string;
  devices: RouterDevice[];
  gateway: RouterGateway | null;
  error: string;
};

export type Investigation = {
  ip: string;
  checkedAt: string;
  privateAddress: boolean;
  ptr: string[];
  dnsCacheHints: Array<{ Entry?: string; Name?: string; Type?: string; Data?: string }>;
  rdap: null | {
    handle?: string;
    name?: string;
    countryCode?: string;
    country?: string;
    asn?: string;
    links?: string[];
    error?: string;
  };
  owner?: null | {
    name: string;
    isp: string;
    asn: string;
    asname: string;
    error: string;
  };
  geo: {
    countryCode: string;
    country: string;
    city?: string;
    latitude: number | null;
    longitude: number | null;
    source: string;
  };
  reputation?: null | {
    checkedAt: string;
    sources: string[];
    abuse: null | { score: number; totalReports: number; lastReportedAt: string; usageType: string };
    virusTotal: null | { malicious: number; suspicious: number; harmless: number; undetected: number };
    flagged: boolean;
    error: string;
  };
  fromCache?: boolean;
};

export type RouteTrace = {
  target: string;
  checkedAt: string;
  hops: Array<{ hop: number; address: string; latenciesMs: number[]; timedOut: boolean }>;
  error?: string;
};

export type ConnectionStats = {
  bytesIn: number;
  bytesOut: number;
  bytesInRate?: number;
  bytesOutRate?: number;
  domains: string[];
};

export type SavedReport = {
  id: string;
  filename: string;
  target: string;
  generatedAt: string;
  hopCount: number;
  processName: string;
  sizeBytes: number;
};

export type SortKey = 'processName' | 'remote' | 'local' | 'interfaceAlias' | 'transfer' | 'lastSeen';

export type MetricFilter = 'all' | 'public' | 'processes' | 'ipv6';

export type SidebarPanelId = 'history' | 'reports' | 'settings' | 'devices';

export const EMPTY_STATUS: CollectorStatus = {
  collector: 'starting',
  lastError: '',
  collectedAt: '',
  adapters: [],
  routes: []
};

export const EMPTY_ROUTER: RouterState = {
  configured: false,
  collectedAt: '',
  devices: [],
  gateway: null,
  error: ''
};

export const EMPTY_SETTINGS: Settings = {
  selectedAdapter: '',
  pollIntervalMs: 2000,
  historyRetentionDays: 7,
  geoIpDatabasePath: '',
  optionalApisEnabled: false
};
