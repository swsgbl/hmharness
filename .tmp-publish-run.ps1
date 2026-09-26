param([string]$Token)
$env:NODE_AUTH_TOKEN = $Token
Set-Location G:\hmharness
node scripts/publish.cjs
