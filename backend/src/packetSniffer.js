import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class PacketSniffer extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.tsharkPath = 'C:\\Program Files\\Wireshark\\tshark.exe';
  }

  start(interfaceName = null) {
    if (this.process) return;

    const args = [
      '-l',
      '-n',
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

    if (interfaceName) {
      args.unshift('-i', interfaceName);
    }

    this.process = spawn(this.tsharkPath, args, { windowsHide: true });
    
    let buffer = '';
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

    this.process.stderr.on('data', data => console.error(`tshark stderr: ${data.toString().trim()}`));
    this.process.on('close', code => {
      console.log(`tshark exited with code ${code}`);
      this.process = null;
    });
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
