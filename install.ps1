# Bunsen 安装脚本（Windows，PowerShell 5.1 及以上）。
#   irm https://raw.githubusercontent.com/sweetcornna/bunsen/main/install.ps1 | iex
# 可选环境变量：
#   BUNSEN_VERSION      要装的版本，例如 v0.1.0（默认最新）
#   BUNSEN_INSTALL_DIR  安装目录（默认 %LOCALAPPDATA%\Programs\bunsen）
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repo = "sweetcornna/bunsen"
$version = if ($env:BUNSEN_VERSION) { $env:BUNSEN_VERSION } else { "latest" }
$dir = if ($env:BUNSEN_INSTALL_DIR) { $env:BUNSEN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\bunsen" }

if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64" -and $env:PROCESSOR_ARCHITECTURE -ne "ARM64") {
  throw "不支持的架构：$($env:PROCESSOR_ARCHITECTURE)"
}
# ARM64 的 Windows 用 x64 版，经系统自带的仿真运行。
$asset = "bunsen-x86_64-pc-windows-msvc.zip"
$base = if ($version -eq "latest") { "https://github.com/$repo/releases/latest/download" } else { "https://github.com/$repo/releases/download/$version" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("bunsen-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "下载 $asset（$version）…"
  $zip = Join-Path $tmp $asset
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $zip

  # 校验：发布页上有 SHA256SUMS 时核对，对不上就停。
  $sums = Join-Path $tmp "SHA256SUMS"
  $haveSums = $true
  try { Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums } catch { $haveSums = $false }
  if ($haveSums) {
    $line = Get-Content $sums | Where-Object { $_ -match ("\s\*?" + [Regex]::Escape($asset) + "$") } | Select-Object -First 1
    if ($line) {
      $want = ($line -split "\s+")[0].ToLower()
      $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
      if ($want -ne $got) { throw "校验和不一致，已中止（期望 $want，实际 $got）" }
      Write-Host "校验和一致"
    }
  } else {
    Write-Host "没有取到 SHA256SUMS，跳过校验"
  }

  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Copy-Item (Join-Path $tmp "bunsen.exe") (Join-Path $dir "bunsen.exe") -Force
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$exe = Join-Path $dir "bunsen.exe"
Write-Host "已安装：$exe（$(& $exe --version)）"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($userPath -split ";") -contains $dir)) {
  [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(";") + ";" + $dir).TrimStart(";")), "User")
  Write-Host "已把 $dir 加进用户 PATH，重新打开终端后生效。"
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  Write-Host "没找到 ssh：到“设置 > 系统 > 可选功能”里添加 OpenSSH 客户端。"
}
Write-Host ""
Write-Host "开始使用：bunsen serve"
