import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SNAPSHOT_SCRIPT = String.raw`
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

# Output final JSON or empty structure fallback
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
`;

export async function collectWindowsSnapshot() {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', SNAPSHOT_SCRIPT],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 12, timeout: 15000 }
  );

  if (!stdout.trim()) {
    return { collectedAt: new Date().toISOString(), connections: [], routes: [], adapters: [] };
  }

  const parsed = JSON.parse(stdout);
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
