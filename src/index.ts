#!/usr/bin/env node
import { getParamValue, getAuthValue } from "@chatmcp/sdk/utils/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  Tool,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { RestServerTransport } from "@chatmcp/sdk/server/rest.js";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";

// support for mcp.so
const ai302ApiKey = getParamValue("302ai_api_key");
const languageParam = getParamValue("language");
const mode = getParamValue("mode") || "stdio";
const port = getParamValue("port") || 9593;
const endpoint = getParamValue("endpoint") || "/rest";
const httpEndpoint = getParamValue("http_endpoint") || "/mcp";

dotenv.config();

class AI302Api {
  private baseUrl = process.env.BASE_URL || "https://api.302.ai/mcp";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  async listTools(language?: string): Promise<Tool[]> {
    const url = new URL(`${this.baseUrl}/v1/tool/api-key`);

    url.searchParams.append("apiKey", this.apiKey);

    if (language) {
      url.searchParams.append("lang", language);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "x-api-key": this.apiKey,
      },
    });

    if (!response.ok) {
      let errorDetails = `HTTP ${response.status}: ${response.statusText}`;
      
      try {
        const errorBody = await response.text();
        errorDetails += ` - ${errorBody}`;
      } catch (parseError) {
        // Ignore parse error
      }

      throw new McpError(ErrorCode.InternalError, errorDetails);
    }

    const data = await response.json();
    return data.tools;
  }

  async callTool(name: string, arguments_: any): Promise<any> {
    const requestBody = {
      nameOrId: name,
      arguments: arguments_,
    };

    const response = await fetch(`${this.baseUrl}/v1/tool/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let errorDetails = `HTTP ${response.status}: ${response.statusText}`;
      
      try {
        const errorBody = await response.text();
        errorDetails += ` - ${errorBody}`;
      } catch (parseError) {
        // Ignore parse error
      }

      throw new McpError(ErrorCode.InternalError, errorDetails);
    }

    const data = await response.json();

    return data;
  }
}

class AI302Server {
  private server: Server;
  private api: AI302Api | null = null;
  private transports: {
    [sessionId: string]: SSEServerTransport | StreamableHTTPServerTransport;
  } = {};
  // Store API keys by session ID
  private sessionApiKeys: { [sessionId: string]: string } = {};

  constructor() {
    this.server = new Server(
      {
        name: "302ai-custom-mcp",
        version: "0.1.9",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      },
    );

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      // console.error("[MCP Error]", error);
    };

    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    this.setupToolHandlers();
  }

  private getApiInstance(
    request?: any,
    extra?: { authInfo?: Record<string, any>; sessionId?: string },
  ): AI302Api {
    // 1. Check extra.authInfo parameter
    const apiKeyFromExtra = extra?.authInfo?.["AI302_API_KEY"];
    if (apiKeyFromExtra) {
      if (!this.api || this.api.getApiKey() !== apiKeyFromExtra) {
        this.api = new AI302Api(apiKeyFromExtra);
      }
      return this.api;
    }

    // 2. Check global param (from command line/mcp.so)
    const apiKeyFromParam = ai302ApiKey !== "YOUR_API_KEY_HERE" && ai302ApiKey;
    if (apiKeyFromParam) {
      if (!this.api || this.api.getApiKey() !== apiKeyFromParam) {
        this.api = new AI302Api(apiKeyFromParam);
      }
      return this.api;
    }

    // 3. Check auth within request._meta (passed via getAuthValue)
    const apiKeyFromAuth = request && getAuthValue(request, "AI302_API_KEY");
    if (apiKeyFromAuth) {
      if (!this.api || this.api.getApiKey() !== apiKeyFromAuth) {
        this.api = new AI302Api(apiKeyFromAuth);
      }
      return this.api;
    }

    // 4. Check for sessionId in extra directly (this matches the actual structure)
    if (extra && extra.sessionId) {
      const apiKeyFromSession = this.sessionApiKeys[extra.sessionId];
      if (apiKeyFromSession) {
        if (!this.api || this.api.getApiKey() !== apiKeyFromSession) {
          this.api = new AI302Api(apiKeyFromSession);
        }
        return this.api;
      }
    }

    // 5. Check environment variable
    const apiKeyFromEnv = process.env["AI302_API_KEY"];
    if (apiKeyFromEnv) {
      if (!this.api || this.api.getApiKey() !== apiKeyFromEnv) {
        this.api = new AI302Api(apiKeyFromEnv);
      }
      return this.api;
    }

    // If no key found, throw error
    throw new McpError(
      ErrorCode.InvalidParams,
      "API key is required to call the tool",
    );
  }

  private getLanguage(
    request?: any,
    extra?: { authInfo?: Record<string, any> },
  ): string | undefined {
    // 1. Check extra.authInfo parameter
    const langFromExtra = extra?.authInfo?.LANGUAGE;
    if (langFromExtra) {
      return langFromExtra;
    }

    // 2. Check global param
    const langFromParam =
      languageParam !== "YOUR_LANGUAGE_HERE" && languageParam;
    if (langFromParam) {
      return langFromParam;
    }

    // 3. Check auth within request._meta
    const langFromAuth = request && getAuthValue(request, "LANGUAGE");
    if (langFromAuth) {
      return langFromAuth;
    }

    // 4. Check environment variable
    const langFromEnv = process.env.LANGUAGE;
    if (langFromEnv) {
      return langFromEnv;
    }

    return undefined;
  }

  private async setupToolHandlers(): Promise<void> {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async (request, extra) => {
        let api: AI302Api;
        let language: string | undefined;
        try {

          // No need to modify the request object, just pass extra with sessionId directly
          api = this.getApiInstance(request, extra);
          language = this.getLanguage(request, extra);
          const tools = await api.listTools(language);
          return { tools };
        } catch (error) {
          throw error;
        }
      },
    );

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        try {
          // No need to modify the request object, just pass extra with sessionId directly
          const api = this.getApiInstance(request, extra);

          const toolName = request.params.name;
          const toolArgs = request.params.arguments;

          const content = await api.callTool(toolName, toolArgs);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ content }, null, 2),
              },
            ],
          };
        } catch (error) {
          throw error;
        }
      },
    );
  }

  async run(): Promise<void> {
    // for mcp.so
    if (mode === "rest") {
      const transport = new RestServerTransport({
        port: Number(port),
        endpoint: endpoint,
      });
      await this.server.connect(transport);

      await transport.startServer();
      console.log(`REST server listening on port ${port} at endpoint ${endpoint}`);
      return;
    } else if (mode === "sse") {
      const app = express();
      // app.use(express.json()); // Middleware to parse JSON bodies for /messages -- REMOVED

      app.get("/sse", async (_: Request, res: Response) => {
        const transport = new SSEServerTransport("/messages", res);
        this.transports[transport.sessionId] = transport;

        res.on("close", () => {
          delete this.transports[transport.sessionId];
        });

        try {
          await this.server.connect(transport);
        } catch (error) {
          console.error(`Error connecting transport for session ${transport.sessionId}`, error);
          if (!res.headersSent) {
            res.status(500).send("Failed to establish MCP connection");
          }
          delete this.transports[transport.sessionId];
        }
      });

      // Handle SSE messages
      // Apply express.json() middleware ONLY to the /messages route
      app.post(
        "/messages",
        express.json(),
        async (req: Request, res: Response) => {
          const sessionId = req.query.sessionId as string;

          const transport = this.transports[sessionId];
          if (transport) {
            try {
              // Extract auth info from headers
              const apiKey = req.headers["x-api-key"] as string | undefined;
              // Simple language extraction, might need refinement based on header value
              const languageHeader = req.headers["accept-language"] as
                | string
                | undefined;
              const language = languageHeader?.split(",")[0].split(";")[0]; // Basic parsing

              // Prepare extra data
              let extra: { authInfo?: Record<string, any> } = {};
              const authData: Record<string, any> = {};
              if (apiKey) authData["AI302_API_KEY"] = apiKey;
              if (language) authData["LANGUAGE"] = language;

              if (Object.keys(authData).length > 0) {
                extra.authInfo = authData;
              }

              // Check if the transport is SSEServerTransport and has handleMessage
              if (transport instanceof SSEServerTransport) {
                // Call handleMessage directly, passing the parsed body and extra auth info
                await transport.handleMessage(req.body, extra as any);
                // Send response manually as handleMessage doesn't
                if (!res.headersSent) {
                  res.writeHead(202).end("Accepted");
                }
              } else {
                // This should never happen, as only SSEServerTransport should be mapped to /messages
                console.error(`Unexpected transport type for /messages endpoint: ${transport.constructor.name}`);
                if (!res.headersSent) {
                  res
                    .status(500)
                    .send("Internal Server Error: Unexpected transport type");
                }
              }
            } catch (error) {
              console.error(`Error handling POST message for session ${sessionId}`, error);
              if (!res.headersSent) {
                res.status(500).send("Internal Server Error handling message");
              }
            }
          } else {
            console.warn(`No transport found for session ID: ${sessionId} on /messages POST`);
            res.status(400).send("No transport found for sessionId");
          }
        },
      );

      app.listen(Number(port), () => {
        console.log(`SSE server listening on port ${port}. Use endpoint /sse for connections.`);
      });
      return;
    } else if (mode === "streamable-http") {
      const app = express();
      // Use express.json() middleware to parse the body for us
      app.use(express.json());

      // Handle POST requests for client-to-server communication
      app.post(httpEndpoint, async (req: Request, res: Response) => {
        try {
          const parsedBody = req.body;

          // Check for existing session ID
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          let transport: StreamableHTTPServerTransport;

          if (sessionId && this.transports[sessionId]) {
            // Reuse existing transport
            transport = this.transports[
              sessionId
            ] as StreamableHTTPServerTransport;

            // Update API key for existing session if provided in query
            if (req.query["x-api-key"]) {
              this.sessionApiKeys[sessionId] = req.query["x-api-key"] as string;
            }
          } else if (!sessionId && isInitializeRequest(req.body)) {
            // Use req.body here
            // New initialization request

            // Extract auth info from headers or query params
            const apiKey =
              (req.headers["x-api-key"] as string | undefined) ||
              (req.query["x-api-key"] as string | undefined);

            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sessionId) => {

                // Store the transport by session ID
                this.transports[sessionId] = transport;

                // Store API key by session ID if available
                if (apiKey) {
                  this.sessionApiKeys[sessionId] = apiKey;
                }
              },
            });

            // Clean up transport when closed
            transport.onclose = () => {
              if (transport.sessionId) {
                delete this.transports[transport.sessionId];
                delete this.sessionApiKeys[transport.sessionId];
              }
            };

            // Connect to the MCP server
            await this.server.connect(transport);
          } else {
            // Invalid request
            res.status(400).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
              },
              id: null,
            });
            return;
          }

          // DO NOT modify the parsed body, just pass it directly
          await transport.handleRequest(req, res, parsedBody);
        } catch (error) {
          console.error("Error handling StreamableHTTP request", error);
          if (!res.headersSent) {
            res.status(500).send("Internal Server Error handling message");
          }
        }
      });

      app.listen(Number(port), () => {
        console.log(`StreamableHTTP server listening on port ${port}. Use endpoint ${httpEndpoint} for connections.`);
      });
      return;
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

const server = new AI302Server();
server.run();