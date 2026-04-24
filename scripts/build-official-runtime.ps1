param(
    [string]$Version = "dev",
    [ValidateSet("auto", "go", "docker")]
    [string]$Builder = "auto"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ServerDir = Join-Path $Root "servers\github-mcp-server"
$OutDir = Join-Path $Root "runtime\bin"
$OutFile = Join-Path $OutDir "github-mcp-server"
$GoPackage = "./cmd/github-mcp-server"

if (-not (Test-Path (Join-Path $ServerDir "go.mod"))) {
    throw "Official github-mcp-server repo not found at $ServerDir"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Push-Location $ServerDir
try {
    $commit = "unknown"
    try {
        $rawCommit = git rev-parse HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $rawCommit) {
            $commit = $rawCommit.Trim()
        }
        else {
            Write-Warning "Could not read git commit metadata. Continuing with commit=unknown."
            Write-Warning "Optional fix: git config --global --add safe.directory $ServerDir"
        }
    }
    catch {
        Write-Warning "Could not read git commit metadata. Continuing with commit=unknown."
        Write-Warning "Optional fix: git config --global --add safe.directory $ServerDir"
    }

    $date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $ldflags = "-s -w -X main.version=$Version -X main.commit=$commit -X main.date=$date"

    $env:CGO_ENABLED = "0"
    $env:GOOS = "linux"
    $env:GOARCH = "amd64"

    $goCommand = Get-Command go -ErrorAction SilentlyContinue
    if ($Builder -eq "go" -or ($Builder -eq "auto" -and $goCommand)) {
        if (-not $goCommand) {
            throw "Go is not installed or not on PATH. Install Go, add it to PATH, or rerun with -Builder docker."
        }

        go build -ldflags="$ldflags" -o $OutFile $GoPackage
    }
    else {
        $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
        if (-not $dockerCommand) {
            throw "Neither Go nor Docker is available. Install Go from https://go.dev/dl/ or install/start Docker Desktop."
        }

        $dockerConfig = Join-Path $Root ".docker"
        New-Item -ItemType Directory -Force -Path $dockerConfig | Out-Null
        $env:DOCKER_CONFIG = $dockerConfig

        docker info *> $null
        if ($LASTEXITCODE -ne 0) {
            throw "Docker is installed but the Docker daemon is not reachable. Start Docker Desktop, then rerun this script. You can also install Go and rerun with -Builder go."
        }

        $serverMount = $ServerDir -replace "\\", "/"
        $outMount = $OutDir -replace "\\", "/"
        $dockerLdflags = $ldflags.Replace('"', '\"')

        docker run --rm `
            -v "${serverMount}:/src" `
            -v "${outMount}:/out" `
            -w /src `
            -e CGO_ENABLED=0 `
            -e GOOS=linux `
            -e GOARCH=amd64 `
            golang:1.25.9-alpine `
            go build -ldflags="$dockerLdflags" -o /out/github-mcp-server $GoPackage
    }
}
finally {
    Pop-Location
}

Write-Host "Built $OutFile"
