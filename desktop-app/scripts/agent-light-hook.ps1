param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('claude', 'codex')]
  [string]$Source
)

$ErrorActionPreference = 'SilentlyContinue'
try {
  $payload = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
  $client = [Net.Sockets.TcpClient]::new()
  $task = $client.ConnectAsync('127.0.0.1', 48733)
  if (-not $task.Wait(180)) { $client.Dispose(); exit 0 }
  $stream = $client.GetStream()
  $bytes = [Text.Encoding]::UTF8.GetBytes("hook-json $Source $encoded`n")
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
  $client.Close()
} catch {}
exit 0
