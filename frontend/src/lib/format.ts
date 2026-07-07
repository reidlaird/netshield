// Pure formatting/classification helpers shared across components.
import type { Connection, Investigation, RouterDevice } from '../types';

export function ownerName(investigation: Investigation) {
  if (investigation.owner?.name) return investigation.owner.name;
  // Older cached records predate the owner block; fall back to raw RDAP fields
  if (investigation.rdap && !investigation.rdap.error) {
    return investigation.rdap.name || investigation.rdap.handle || '';
  }
  return '';
}

export function reputationSummary(investigation: Investigation) {
  const rep = investigation.reputation;
  if (!rep) return '';
  const parts: string[] = [];
  if (rep.abuse) {
    parts.push(`AbuseIPDB ${rep.abuse.score}/100${rep.abuse.totalReports ? ` (${rep.abuse.totalReports} reports)` : ''}`);
  }
  if (rep.virusTotal) {
    parts.push(`VirusTotal ${rep.virusTotal.malicious} malicious / ${rep.virusTotal.suspicious} suspicious`);
  }
  return parts.join(' · ');
}

export function formatAsn(investigation: Investigation) {
  const asn = investigation.owner?.asn || investigation.rdap?.asn || '';
  const asname = investigation.owner?.asname || '';
  if (!asn) return '';
  return asname ? `${asn} · ${asname}` : asn;
}

const WELL_KNOWN_PORTS: Record<number, string> = {
  20: 'FTP data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
  80: 'HTTP', 110: 'POP3', 123: 'NTP', 143: 'IMAP', 161: 'SNMP', 194: 'IRC',
  443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 587: 'SMTP submission', 853: 'DNS over TLS',
  993: 'IMAPS', 995: 'POP3S', 1194: 'OpenVPN', 1433: 'MSSQL', 3306: 'MySQL',
  3389: 'RDP', 3478: 'STUN/TURN', 4500: 'IPsec NAT-T', 5060: 'SIP', 5222: 'XMPP',
  5223: 'Push notifications', 5228: 'Google services', 5432: 'PostgreSQL',
  6379: 'Redis', 8080: 'HTTP alt', 8443: 'HTTPS alt', 27017: 'MongoDB', 51820: 'WireGuard'
};

export function serviceName(port: number) {
  return WELL_KNOWN_PORTS[port] || '';
}

export function lastOctet(ip: string) {
  const n = Number(ip.split('.').pop());
  return Number.isFinite(n) ? n : 999;
}

// Best available name for a device: router/DNS hostname, then MAC vendor,
// then a hint that the MAC is randomized so no vendor exists to look up.
export function deviceLabel(device: RouterDevice) {
  if (device.hostname) return device.hostname;
  if (device.vendor) return `${device.vendor} device`;
  if (device.randomizedMac) return 'Unnamed (private MAC)';
  return 'Unnamed device';
}

export function bandClass(type: string) {
  const t = (type || '').toLowerCase();
  if (t.includes('5g')) return 'band-5g';
  if (t.includes('2.4') || t === '2.4g') return 'band-24g';
  if (t.includes('lan') || t.includes('eth')) return 'band-wired';
  return '';
}

// WiFi RSSI (dBm) -> a quick 4-bar strength glyph.
export function signalBars(signal: string) {
  const dbm = Number(signal);
  if (!Number.isFinite(dbm)) return '';
  if (dbm >= -55) return '▂▄▆█';
  if (dbm >= -67) return '▂▄▆';
  if (dbm >= -78) return '▂▄';
  return '▂';
}

export function isLocalAddress(address: string) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|127\.|169\.254\.|fe80:|fc|fd|::1)/i.test(address);
}

export function formatEndpoint(address: string, port: number) {
  let displayAddress = address;
  if (address.includes(':')) {
    if (address.length > 20) {
      const first = address.substring(0, 9);
      const last = address.substring(address.length - 4);
      displayAddress = `${first}…${last}`;
    }
    return `[${displayAddress}]:${port}`;
  }
  return `${displayAddress}:${port}`;
}

export function formatTime(value: string) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function formatDate(value: string) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

export function formatRate(bytesPerSec: number) {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function getProcessTypeClass(name: string) {
  if (!name) return 'process-unknown';
  const lower = name.toLowerCase();
  if (lower === 'system' || lower === 'idle') return 'process-system';
  if (lower.includes('svchost') || lower === 'lsass.exe' || lower === 'services.exe') return 'process-service';
  return 'process-user';
}

export function getStateBadgeClass(state: string) {
  if (!state) return '';
  const lower = state.toLowerCase();
  if (lower === 'established') return 'state-established';
  if (lower === 'listen' || lower === 'listening') return 'state-listening';
  if (lower.includes('wait')) return 'state-waiting';
  if (lower.includes('close') || lower.includes('time')) return 'state-closing';
  return 'state-other';
}

export function getConnectionAlerts(connection: Connection, investigation?: Investigation) {
  const alerts: string[] = [];
  const port = connection.remotePort;
  const isPublic = !isLocalAddress(connection.remoteAddress);

  if (investigation?.reputation?.flagged) {
    alerts.push('Flagged');
  }

  if (port === 80 && isPublic) {
    const lowerProc = connection.processName.toLowerCase();
    if (
      lowerProc.includes('chrome') ||
      lowerProc.includes('brave') ||
      lowerProc.includes('msedge') ||
      lowerProc.includes('firefox') ||
      lowerProc.includes('claude')
    ) {
      alerts.push('HTTP');
    }
  }

  if ((port === 21 || port === 23 || port === 135 || port === 139 || port === 445) && isPublic) {
    alerts.push('Legacy');
  }

  return alerts;
}
