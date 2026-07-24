param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Event = '',
  [string]$Session = 'manual'
)
$ErrorActionPreference = 'SilentlyContinue'
try {
  $payload = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($payload)) {
    if ([string]::IsNullOrWhiteSpace($Event)) { exit 0 }
    $payload = @{ hook_event_name = $Event; session_id = $Session; project = $Session } | ConvertTo-Json -Compress
  }
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
  $client = [Net.Sockets.TcpClient]::new()
  if (-not $client.ConnectAsync('127.0.0.1', 48733).Wait(220)) { $client.Dispose(); exit 0 }
  $stream = $client.GetStream()
  $bytes = [Text.Encoding]::UTF8.GetBytes("hook-json $Source $encoded`n")
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
  $client.Close()
} catch {}
exit 0
