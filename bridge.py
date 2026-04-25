from fastmcp.server import create_proxy
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
import sys
import os

MCP_AUTH_TOKEN = os.environ.get("MCP_AUTH_TOKEN", "43b31035-c338-424f-9630-547c5b5afb68")
MCP_URL = os.environ.get("MCP_URL", "https://pjclc1167d.execute-api.us-east-1.amazonaws.com/mcp")

transport = StreamableHttpTransport(MCP_URL, headers={"x-mcp-auth": MCP_AUTH_TOKEN})
client = Client(transport)
proxy = create_proxy(client, name="github-lambda-mcp")

if __name__ == "__main__":
    try:
        proxy.run()
    except Exception as e:
        print(f"Bridge Error: {e}", file=sys.stderr)
