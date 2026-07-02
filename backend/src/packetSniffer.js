import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

const RESTART_DELAY_MS = 5000;
const MAX_RESTARTS = 5;

export class PacketSniffer extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.tsharkPath = process.env.TSHARK_PATH || 'C:\\Program Files\\Wireshark\\tshark.exe';
    this.status = { state: 'stopped', detail: '' };
    this.adapterAliases = [];
    this.restartCount = 0;
    this.restartTimer = null;
    this.stopping = false;
  }

  setStatus(state, detail = '') {
    this.status = { state, detail };
    this.emit('status', this.status);
  }

  // Parse `tshark -D` output: "9. \Device\NPF_{GUID} (Ethernet)"
  listInterfaces() {
    return new Promise((resolve) => {
      execFile(this.tsharkPath, ['-D'], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        const interfaces = [];
        for (const line of stdout.split(/\r?\n/)) {
          const match = line.match(/^\d+\.\s+(\S+)(?:\s+\((.+)\))?\s*$/);
          if (match) interfaces.push({ device: match[1], name: match[2] || match[1] });
        }
        resolve(interfaces);
      });
    });
  }

  // Prefer interfaces matching the adapter aliases the collector reports as
  // having addresses; otherwise fall back to every real capture interface so
  // traffic is counted even when the alias names don't line up.
  pickInterfaces(interfaces, adapterAliases) {
    const aliases = new Set(adapterAliases.map((a) => String(a).toLowerCase()));
    const usable = interfaces.filter((iface) =>
      !/loopback/i.test(iface.device) && !/^etwdump$/i.test(iface.device)
    );
    const matched = usable.filter((iface) => aliases.has(iface.name.toLowerCase()));
    return matched.length ? matched : usable;
  }

  async start(adapterAliases = []) {
    if (this.process) return;
    this.stopping = false;
    this.adapterAliases = adapterAliases;

    if (!fs.existsSync(this.tsharkPath)) {
      this.setStatus('error', `tshark not found at ${this.tsharkPath} — install Wireshark or set TSHARK_PATH`);
      return;
    }

    const interfaces = await this.listInterfaces();
    const selected = this.pickInterfaces(interfaces, adapterAliases);
    if (!selected.length) {
      this.setStatus('error', 'tshark reported no capture interfaces (is Npcap installed?)');
      return;
    }

    const args = [
      '-l',
      '-n',
      // Default capture filter: set before the first -i so it applies to all interfaces
      '-f', 'tcp or udp',
      ...selected.flatMap((iface) => ['-i', iface.device]),
      '-T', 'fields',
      '-e', 'frame.len',
      '-e', 'ip.src',
      '-e', 'ip.dst',
      '-e', 'ipv6.src',
      '-e', 'ipv6.dst',
      '-e', 'tcp.srcport',
      '-e', 'tcp.dstport',
      '-e', 'udp.srcport',
      '-e', 'udp.dstport',
      '-e', 'tls.handshake.extensions_server_name',
      '-e', 'http.host',
      '-e', 'dns.qry.name',
      '-e', 'dns.a',
      '-e', 'dns.aaaa',
      '-E', 'separator=;'
    ];

    this.process = spawn(this.tsharkPath, args, { windowsHide: true });
    this.setStatus('running', `capturing on ${selected.map((i) => i.name).join(', ')}`);

    let buffer = '';
    let stderrTail = '';
    this.process.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        const [
          frameLen, ipSrc, ipDst, ipv6Src, ipv6Dst,
          tcpSrc, tcpDst, udpSrc, udpDst,
          sni, httpHost, dnsQry, dnsA, dnsAaaa
        ] = line.split(';');

        const srcIp = ipSrc || ipv6Src;
        const dstIp = ipDst || ipv6Dst;
        const srcPort = tcpSrc || udpSrc;
        const dstPort = tcpDst || udpDst;
        const proto = tcpSrc ? 'TCP' : (udpSrc ? 'UDP' : 'Other');
        const len = parseInt(frameLen, 10) || 0;

        // Parse DNS responses
        const resolvedIps = [];
        if (dnsA) resolvedIps.push(...dnsA.split(','));
        if (dnsAaaa) resolvedIps.push(...dnsAaaa.split(','));

        const domains = [];
        if (sni) domains.push(...sni.split(','));
        if (httpHost) domains.push(...httpHost.split(','));
        if (dnsQry) domains.push(...dnsQry.split(','));

        this.emit('packet', {
          srcIp, dstIp,
          srcPort: parseInt(srcPort, 10) || 0,
          dstPort: parseInt(dstPort, 10) || 0,
          proto, len,
          domains: domains.filter(Boolean),
          resolvedIps: resolvedIps.filter(Boolean)
        });
      }
    });

    this.process.stderr.on('data', data => {
      const text = data.toString().trim();
      stderrTail = text.slice(-300);
      console.error(`tshark stderr: ${text}`);
    });

    this.process.on('error', (err) => {
      console.error(`tshark failed to start: ${err.message}`);
      this.process = null;
      this.setStatus('error', `tshark failed to start: ${err.message}`);
    });

    this.process.on('close', code => {
      console.log(`tshark exited with code ${code}`);
      this.process = null;
      if (this.stopping) {
        this.setStatus('stopped', '');
        return;
      }
      if (this.restartCount >= MAX_RESTARTS) {
        this.setStatus('error', `tshark keeps exiting (code ${code}). ${stderrTail}`.trim());
        return;
      }
      this.restartCount += 1;
      this.setStatus('error', `tshark exited (code ${code}), restarting… ${stderrTail}`.trim());
      this.restartTimer = setTimeout(() => this.start(this.adapterAliases), RESTART_DELAY_MS);
    });
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.setStatus('stopped', '');
  }
}
