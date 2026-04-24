# github-lambda-mcp

Lambda + API Gateway transport for the official GitHub MCP server.

The GitHub implementation is the cloned official repo at:

```text
servers/github-mcp-server
```

The Lambda code in `runtime/` is only a transport bridge. It accepts MCP JSON-RPC over HTTP at `/mcp`, starts the official `github-mcp-server stdio` binary, and forwards `tools/list` and `tools/call` to that process.

## Layout

- `template.yaml` - SAM template for API Gateway + Node.js Lambda.
- `runtime/lambda-handler.js` - HTTP JSON-RPC transport for Lambda.
- `runtime/stdio-bridge.js` - stdio bridge to the official Go server.
- `servers/github-mcp-server` - official GitHub MCP server clone.
- `scripts/build-official-runtime.ps1` - cross-compiles the official Go server for Lambda Linux x86_64.

## Build The Official Server

The Lambda package needs a Linux binary at `runtime/bin/github-mcp-server`.

```powershell
cd C:\Users\jbeem\projects\code\github-lambda-mcp
.\scripts\build-official-runtime.ps1 -Version dev
```

The script defaults to `-Builder auto`: it uses local Go when `go` is on PATH, otherwise it uses Docker. To force Docker:

```powershell
.\scripts\build-official-runtime.ps1 -Version dev -Builder docker
```

If Docker needs to pull `golang:1.25.9-alpine`, make sure Docker Desktop is running and has network access.

If Docker is installed but not running, start Docker Desktop before rerunning the script. The script uses a project-local `.docker/` config directory so it does not need access to `C:\Users\<you>\.docker\config.json`.

If Git reports that `servers/github-mcp-server` has dubious ownership, the build script will continue with `commit=unknown`. To preserve real commit metadata, run:

```powershell
git config --global --add safe.directory C:/Users/jbeem/projects/code/github-lambda-mcp/servers/github-mcp-server
```

That script runs:

```powershell
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/github-mcp-server
```

from the official repo, then places the result where SAM will package it.

## Local Checks

These checks validate the Lambda transport without starting the official server binary:

```powershell
cd C:\Users\jbeem\projects\code\github-lambda-mcp
node --check runtime\lambda-handler.js
node --check runtime\stdio-bridge.js
npm --prefix runtime test
```

After building the official binary and setting a token, you can also try SAM local:

```powershell
$env:GITHUB_PERSONAL_ACCESS_TOKEN = "github_pat_or_ghp_value"
sam local invoke McpFunction -e events\initialize.json
sam local invoke McpFunction -e events\tools-list.json
sam local invoke McpFunction -e events\search-repos.json
```

## Deploy

```powershell
cd C:\Users\jbeem\projects\code\github-lambda-mcp
.\scripts\build-official-runtime.ps1 -Version dev
sam build
sam deploy --guided
```

Useful SAM parameters:

- `GithubPersonalAccessTokenParam`: PAT passed to the official server as `GITHUB_PERSONAL_ACCESS_TOKEN`.
- `GithubToolsetsParam`: comma-separated official toolsets. Default is `default`.
- `GithubToolsParam`: optional comma-separated official tool names to enable in addition to toolsets.
- `GithubReadOnlyParam`: defaults to `true`; set to `false` only when you want write tools active.
- `GithubHostParam`: optional GitHub Enterprise host.
- `McpAuthTokenParam`: optional shared secret expected in the `x-mcp-auth` header.
- `AllowedOriginsParam`: optional comma-separated browser origins.

## MCP Client

Point the client at the deployed `McpEndpoint` output:

```json
{
  "servers": {
    "github-lambda": {
      "type": "http",
      "url": "https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/mcp",
      "headers": {
        "x-mcp-auth": "YOUR_OPTIONAL_SHARED_SECRET"
      }
    }
  }
}
```

The official server controls the available tool names. Examples include `get_file_contents`, `list_issues`, `search_code`, and `search_repositories`, depending on the configured toolsets and token permissions.
