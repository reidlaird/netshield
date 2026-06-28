import net from 'node:net';

const IPV4_PRIVATE_RANGES = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
  ['0.0.0.0', 8],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
];

export function stripIpv6Scope(address = '') {
  return String(address).split('%')[0];
}

export function normalizeAddress(address = '') {
  return stripIpv6Scope(String(address).trim()).toLowerCase();
}

function ipv4ToInt(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((acc, part) => ((acc << 8) + part) >>> 0, 0);
}

function ipv4InCidr(address, base, prefix) {
  const addrInt = ipv4ToInt(address);
  const baseInt = ipv4ToInt(base);
  if (addrInt === null || baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addrInt & mask) === (baseInt & mask);
}

export function isPrivateOrReservedIP(address) {
  const normalized = normalizeAddress(address);
  const family = net.isIP(normalized);
  if (!family) return true;

  if (family === 4) {
    return IPV4_PRIVATE_RANGES.some(([base, prefix]) => ipv4InCidr(normalized, base, prefix));
  }

  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('fec0:') ||
    normalized.startsWith('2001:db8:')
  );
}

export function makeConnectionId(connection) {
  return [
    connection.protocol || 'TCP',
    normalizeAddress(connection.localAddress),
    Number(connection.localPort || 0),
    normalizeAddress(connection.remoteAddress),
    Number(connection.remotePort || 0),
    Number(connection.pid || 0)
  ].join('|');
}

export function normalizeConnection(raw, previous, now = new Date().toISOString()) {
  const normalized = {
    id: '',
    protocol: raw.protocol || 'TCP',
    localAddress: normalizeAddress(raw.localAddress),
    localPort: Number(raw.localPort || 0),
    remoteAddress: normalizeAddress(raw.remoteAddress),
    remotePort: Number(raw.remotePort || 0),
    state: raw.state || 'Unknown',
    pid: Number(raw.pid || raw.owningProcess || 0),
    processName: raw.processName || 'Unknown',
    processPath: raw.processPath || '',
    interfaceAlias: raw.interfaceAlias || '',
    gateway: raw.gateway || '',
    firstSeen: previous?.firstSeen || raw.firstSeen || now,
    lastSeen: now,
    status: 'open'
  };
  normalized.id = makeConnectionId(normalized);
  return normalized;
}

function materiallyChanged(previous, next) {
  return (
    previous.state !== next.state ||
    previous.processName !== next.processName ||
    previous.processPath !== next.processPath ||
    previous.interfaceAlias !== next.interfaceAlias ||
    previous.gateway !== next.gateway
  );
}

export function diffConnections(previousMap, rawConnections, now = new Date().toISOString()) {
  const nextMap = new Map();
  const added = [];
  const updated = [];
  const closed = [];

  for (const raw of rawConnections) {
    const id = makeConnectionId({
      protocol: raw.protocol || 'TCP',
      localAddress: raw.localAddress,
      localPort: raw.localPort,
      remoteAddress: raw.remoteAddress,
      remotePort: raw.remotePort,
      pid: raw.pid || raw.owningProcess
    });
    const previous = previousMap.get(id);
    const next = normalizeConnection(raw, previous, now);
    nextMap.set(next.id, next);

    if (!previous) {
      added.push(next);
    } else if (materiallyChanged(previous, next)) {
      updated.push(next);
    }
  }

  for (const previous of previousMap.values()) {
    if (!nextMap.has(previous.id)) {
      closed.push({ ...previous, status: 'closed', lastSeen: now });
    }
  }

  return {
    snapshot: Array.from(nextMap.values()),
    nextMap,
    added,
    updated,
    closed
  };
}

export function publicRemoteConnections(connections) {
  return connections.filter((connection) => !isPrivateOrReservedIP(connection.remoteAddress));
}
