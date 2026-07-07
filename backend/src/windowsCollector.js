import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';

const execFileAsync = promisify(execFile);

const SNAPSHOT_FUNCTION = String.raw`
function Get-NetShieldSnapshot {
  $ErrorActionPreference = "SilentlyContinue"
  $activeStates = @("Established", "SynSent", "SynReceived", "FinWait1", "FinWait2", "CloseWait", "Closing", "LastAck")

  # Get connections safely
  $connections = @()
  try {
    $connections = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {
      $_.RemoteAddress -and
      $_.RemotePort -and
      $activeStates -contains "$($_.State)" -and
      $_.RemoteAddress -notin @("0.0.0.0", "::", "127.0.0.1", "::1")
    })
  } catch {}

  # Get IP address mapping safely
  $ipMap = @{}
  try {
    Get-NetIPAddress -ErrorAction SilentlyContinue | ForEach-Object {
      $ipMap[$_.IPAddress] = @{
        InterfaceAlias = $_.InterfaceAlias
        InterfaceIndex = $_.InterfaceIndex
      }
    }
  } catch {}

  # Get routes safely
  $routes = @()
  try {
    $routes = @(Get-NetRoute -ErrorAction SilentlyContinue | Where-Object {
      $_.DestinationPrefix -eq "0.0.0.0/0" -or $_.DestinationPrefix -eq "::/0"
    } | Sort-Object RouteMetric | ForEach-Object {
      [pscustomobject]@{
        destinationPrefix = $_.DestinationPrefix
        gateway = $_.NextHop
        interfaceAlias = $_.InterfaceAlias
        interfaceIndex = $_.ifIndex
        routeMetric = $_.RouteMetric
      }
    })
  } catch {}

  # Get processes and executable paths safely (handle access restrictions)
  $processes = @{}
  if ($connections) {
    $connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
      if ($_ -and -not $processes.ContainsKey("$($_)")) {
        try {
          $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
          if ($process) {
            $path = ""
            try {
              $path = $process.Path
            } catch {
              # Catch access denied or security exception for elevated/system processes
              $path = ""
            }
            $processes["$($_)"] = @{
              processName = $process.ProcessName
              processPath = $path
            }
          }
        } catch {}
      }
    }
  }

  # Construct row results safely
  $rows = @()
  if ($connections) {
    $rows = @($connections | ForEach-Object {
      $local = $ipMap[$_.LocalAddress]
      $familyRoute = if ($_.RemoteAddress -like "*:*") { "::/0" } else { "0.0.0.0/0" }
      $route = $null
      if ($routes) {
        $route = @($routes | Where-Object { $_.destinationPrefix -eq $familyRoute } | Select-Object -First 1)[0]
      }
      $process = $processes["$($_.OwningProcess)"]

      [pscustomobject]@{
        protocol = "TCP"
        localAddress = $_.LocalAddress
        localPort = $_.LocalPort
        remoteAddress = $_.RemoteAddress
        remotePort = $_.RemotePort
        state = "$($_.State)"
        pid = $_.OwningProcess
        processName = if ($process) { $process.processName } else { "Unknown" }
        processPath = if ($process) { $process.processPath } else { "" }
        interfaceAlias = if ($local) { $local.InterfaceAlias } elseif ($route) { $route.interfaceAlias } else { "" }
        gateway = if ($route) { $route.gateway } else { "" }
      }
    })
  }

  # Get adapters safely
  $adapters = @()
  try {
    $adapters = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | ForEach-Object {
      [pscustomobject]@{
        interfaceAlias = $_.InterfaceAlias
        ipv4 = @($_.IPv4Address | ForEach-Object { $_.IPAddress })
        ipv6 = @($_.IPv6Address | ForEach-Object { $_.IPAddress })
        gateway = @($_.IPv4DefaultGateway + $_.IPv6DefaultGateway | Where-Object { $_ } | ForEach-Object { $_.NextHop })
      }
    })
  } catch {}

  # Output final JSON (single compressed line) or empty structure fallback
  try {
    [pscustomobject]@{
      collectedAt = (Get-Date).ToUniversalTime().ToString("o")
      connections = $rows
      routes = $routes
      adapters = $adapters
    } | ConvertTo-Json -Depth 8 -Compress
  } catch {
    Write-Output '{"collectedAt":"","connections":[],"routes":[],"adapters":[]}'
  }
}
`;

const ONE_SHOT_SCRIPT = SNAPSHOT_FUNCTION + '\nGet-NetShieldSnapshot\n';

// Persistent mode: one PowerShell process stays alive and emits a snapshot
// line for every request line it reads on stdin. Cmdlet module load (~1-2s)
// is paid once instead of on every 2-second poll, and steady-state cost drops
// from a full process spawn to a pipe round-trip. The loop exits when stdin
// closes, so the child dies naturally with the Node server.
const SERVER_SCRIPT = SNAPSHOT_FUNCTION + String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $request = [Console]::In.ReadLine()
  if ($null -eq $request) { break }
  Get-NetShieldSnapshot
}
`;

const REQUEST_TIMEOUT_MS = 15000;

class PersistentCollector {
  constructor() {
    this.proc = null;
    this.pending = null;
    this.chain = Promise.resolve();
  }

  snapshot() {
    // Serialize requests: one line in, one line out, strictly in order.
    const run = this.chain.then(() => this.requestSnapshot());
    this.chain = run.catch(() => {});
    return run;
  }

  ensureProcess() {
    if (this.proc) return;
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SERVER_SCRIPT],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      // The loop only ever prints snapshot JSON; ignore any stray banner text.
      if (!line.startsWith('{')) return;
      const pending = this.pending;
      if (!pending) return;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(line);
    });
    proc.on('error', () => this.handleExit(proc));
    proc.on('exit', () => this.handleExit(proc));
    this.proc = proc;
  }

  handleExit(proc) {
    if (this.proc !== proc) return;
    this.proc = null;
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error('collector process exited'));
    }
  }

  requestSnapshot() {
    return new Promise((resolve, reject) => {
      try {
        this.ensureProcess();
        this.pending = {
          resolve,
          reject,
          timer: setTimeout(() => {
            // A wedged request means a wedged process: kill it so the next
            // request starts fresh instead of reading this request's late reply.
            this.pending = null;
            reject(new Error(`snapshot timed out after ${REQUEST_TIMEOUT_MS}ms`));
            this.kill();
          }, REQUEST_TIMEOUT_MS)
        };
        this.proc.stdin.write('snapshot\n');
      } catch (error) {
        this.pending = null;
        this.kill();
        reject(error);
      }
    });
  }

  kill() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch {}
    }
  }

  get pid() {
    return this.proc?.pid ?? null;
  }
}

const persistentCollector = new PersistentCollector();

async function collectOnce() {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ONE_SHOT_SCRIPT],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 12, timeout: REQUEST_TIMEOUT_MS }
  );
  return stdout;
}

export async function collectWindowsSnapshot() {
  let raw;
  try {
    raw = await persistentCollector.snapshot();
  } catch {
    // Persistent process died or timed out; take this snapshot the old
    // one-shot way. The next call re-spawns the persistent process.
    raw = await collectOnce();
  }
  return normalizeSnapshot(raw);
}

export function normalizeSnapshot(raw) {
  if (!raw || !String(raw).trim()) {
    return { collectedAt: new Date().toISOString(), connections: [], routes: [], adapters: [] };
  }
  const parsed = JSON.parse(raw);
  return {
    collectedAt: parsed.collectedAt || new Date().toISOString(),
    connections: ensureArray(parsed.connections),
    routes: ensureArray(parsed.routes),
    adapters: ensureArray(parsed.adapters)
  };
}

export function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// Exposed for tests and diagnostics.
export const _collector = persistentCollector;
