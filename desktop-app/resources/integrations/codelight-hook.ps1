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
  # A Codex process spawned by Claude is a delegated worker. Pass the parent
  # identity to CodeLight so Windows follows the same top-level-only rule as
  # macOS: Codex completion stays silent and Claude owns the visible result.
  if ($Source.ToLowerInvariant() -in @('codex', 'codex-cli', 'openai')) {
    $isClaudeChild = -not [string]::IsNullOrWhiteSpace($env:CODEX_COMPANION_SESSION_ID) -or
      -not [string]::IsNullOrWhiteSpace($env:CLAUDE_PLUGIN_DATA) -or
      $env:CLAUDE_CODE_CHILD_SESSION -in @('1', 'true', 'yes', 'on') -or
      (($env:CLAUDECODE -in @('1', 'true', 'yes', 'on')) -and -not [string]::IsNullOrWhiteSpace($env:CLAUDE_CODE_ENTRYPOINT))
    if ($isClaudeChild) {
      try {
        $data = $payload | ConvertFrom-Json
        $data | Add-Member -NotePropertyName '_codelight_parent_provider' -NotePropertyValue 'claude' -Force
        $payload = $data | ConvertTo-Json -Compress -Depth 64
      } catch {}
    }
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
