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
import { betterFetch } from "@better-fetch/fetch";
import { RestServerTransport } from "@chatmcp/sdk/server/rest.js";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import bodyParser from "body-parser";
import getRawBody from "raw-body";

// support for mcp.so
const ai302ApiKey = getParamValue("302ai_api_key");
const languageParam = getParamValue("language");
const mode = getParamValue("mode") || "stdio";
const port = getParamValue("port") || 9593;
const endpoint = getParamValue("endpoint") || "/rest";
const httpEndpoint = getParamValue("http_endpoint") || "/mcp";

dotenv.config();

interface ToolCallResponse {
  result: any;
  logs: any;
}

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
    const url = new URL(`${this.baseUrl}/list-tools/custom`);

    if (language) {
      url.searchParams.append("lang", language);
    }

    const { data, error } = await betterFetch<{
      tools: Tool[];
    }>(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "x-api-key": this.apiKey,
      },
    });

    if (error) {
      throw new McpError(
        ErrorCode.InternalError,
        error.message ?? "Unknown error",
      );
    }

    return data.tools;
  }

  async callTool(name: string, arguments_: any): Promise<ToolCallResponse> {
    const { data, error } = await betterFetch<ToolCallResponse>(
      `${this.baseUrl}/call-tool/${name}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "x-api-key": this.apiKey,
        },
        body: {
          arguments: arguments_,
        },
      },
    );

    console.log(`Tool call result:`, JSON.stringify(data, null, 2));

    if (error) {
      throw new McpError(
        ErrorCode.InternalError,
        error.message ?? "Unknown error",
      );
    }

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
        version: "0.1.5",
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
      console.error("[MCP Error]", error);
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
    console.log(
      "getApiInstance received extra:",
      JSON.stringify(extra, null, 2),
    );
    // 1. Check extra.authInfo parameter
    const apiKeyFromExtra = extra?.authInfo?.["302AI_API_KEY"];
    console.log(
      `getApiInstance apiKeyFromExtra check resulted in: ${apiKeyFromExtra}`,
    );
    if (apiKeyFromExtra) {
      console.log("Using API key from 'extra.authInfo' parameter");
      if (!this.api || this.api.getApiKey() !== apiKeyFromExtra) {
        this.api = new AI302Api(apiKeyFromExtra);
      }
      return this.api;
    }

    // 2. Check global param (from command line/mcp.so)
    const apiKeyFromParam = ai302ApiKey !== "YOUR_API_KEY_HERE" && ai302ApiKey;
    if (apiKeyFromParam) {
      console.log("Using API key from global param");
      if (!this.api || this.api.getApiKey() !== apiKeyFromParam) {
        this.api = new AI302Api(apiKeyFromParam);
      }
      return this.api;
    }

    // 3. Check auth within request._meta (passed via getAuthValue)
    const apiKeyFromAuth = request && getAuthValue(request, "302AI_API_KEY");
    if (apiKeyFromAuth) {
      console.log("Using API key from request meta auth");
      if (!this.api || this.api.getApiKey() !== apiKeyFromAuth) {
        this.api = new AI302Api(apiKeyFromAuth);
      }
      return this.api;
    }

    // 4. Check for sessionId in extra directly (this matches the actual structure)
    if (extra && extra.sessionId) {
      const apiKeyFromSession = this.sessionApiKeys[extra.sessionId];
      if (apiKeyFromSession) {
        console.log(
          `Using API key from session storage for session: ${extra.sessionId}`,
        );
        if (!this.api || this.api.getApiKey() !== apiKeyFromSession) {
          this.api = new AI302Api(apiKeyFromSession);
        }
        return this.api;
      }
    }

    // 5. Check environment variable
    const apiKeyFromEnv = process.env["302AI_API_KEY"];
    if (apiKeyFromEnv) {
      console.log("Using API key from environment variable");
      if (!this.api || this.api.getApiKey() !== apiKeyFromEnv) {
        this.api = new AI302Api(apiKeyFromEnv);
      }
      return this.api;
    }

    // If no key found, throw error
    console.error(
      "API key not found in extra, global param, request meta, or env var.",
    );
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
      console.log("Using language from 'extra.authInfo' parameter");
      return langFromExtra;
    }

    // 2. Check global param
    const langFromParam =
      languageParam !== "YOUR_LANGUAGE_HERE" && languageParam;
    if (langFromParam) {
      console.log("Using language from global param");
      return langFromParam;
    }

    // 3. Check auth within request._meta
    const langFromAuth = request && getAuthValue(request, "LANGUAGE");
    if (langFromAuth) {
      console.log("Using language from request meta auth");
      return langFromAuth;
    }

    // 4. Check environment variable
    const langFromEnv = process.env.LANGUAGE;
    if (langFromEnv) {
      console.log("Using language from environment variable");
      return langFromEnv;
    }

    console.log(
      "Language not found in extra, global param, request meta, or env var.",
    );
    return undefined;
  }

  private async setupToolHandlers(): Promise<void> {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async (request, extra) => {
        console.log(
          "Entered ListToolsRequest handler with extra:",
          JSON.stringify(extra, null, 2),
        );
        console.log(
          "ListToolsRequestSchema extra:",
          JSON.stringify(extra, null, 2),
        );
        let api: AI302Api;
        let language: string | undefined;
        try {
          console.log(
            "Attempting to get API instance in ListToolsRequest handler",
          );

          // No need to modify the request object, just pass extra with sessionId directly
          api = this.getApiInstance(request, extra);
          console.log(
            "Successfully got API instance in ListToolsRequest handler",
          );
          language = this.getLanguage(request, extra);
          console.log(
            `Language resolved to: ${language} in ListToolsRequest handler`,
          );
          const tools = await api.listTools(language);
          console.log("Successfully listed tools in ListToolsRequest handler");
          return { tools };
        } catch (error) {
          console.error(
            "Error inside ListToolsRequest handler:",
            error instanceof Error ? error.stack : error,
          );
          throw error;
        }
      },
    );

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        console.log(
          "Entered CallToolRequest handler with extra:",
          JSON.stringify(extra, null, 2),
        );
        console.log(
          "CallToolRequestSchema extra:",
          JSON.stringify(extra, null, 2),
        );
        try {
          // No need to modify the request object, just pass extra with sessionId directly
          const api = this.getApiInstance(request, extra);
          console.log(
            "Successfully got API instance in CallToolRequest handler",
          );

          const toolName = request.params.name;
          const toolArgs = request.params.arguments;
          console.log(`Calling backend tool: ${toolName}`);
          console.log(
            `Backend tool arguments:`,
            JSON.stringify(toolArgs, null, 2),
          );

          const { result, logs } = await api.callTool(toolName, toolArgs);
          console.log("Successfully called tool in CallToolRequest handler");
          console.log(`Backend tool result:`, JSON.stringify(result, null, 2));
          console.log(`Backend tool logs:`, JSON.stringify(logs, null, 2));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ result, logs }, null, 2),
              },
            ],
          };
        } catch (error) {
          console.error(
            "Error inside CallToolRequest handler:",
            error instanceof Error ? error.stack : error,
          );
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
      console.log(
        `REST server listening on port ${port} at endpoint ${endpoint}`,
      );
      return;
    } else if (mode === "sse") {
      const app = express();
      // app.use(express.json()); // Middleware to parse JSON bodies for /messages -- REMOVED

      app.get("/sse", async (_: Request, res: Response) => {
        console.log("Received GET request for /sse");
        const transport = new SSEServerTransport("/messages", res);
        this.transports[transport.sessionId] = transport;
        console.log(
          `SSE connection established with session ID: ${transport.sessionId}`,
        );

        res.on("close", () => {
          console.log(
            `SSE connection closed for session ID: ${transport.sessionId}`,
          );
          delete this.transports[transport.sessionId];
        });

        try {
          console.log(
            `Attempting server connect for session ID: ${transport.sessionId}`,
          );
          await this.server.connect(transport);
          console.log(
            `Server connect successful for session ID: ${transport.sessionId}`,
          );
        } catch (error) {
          console.error(
            `Error connecting transport for session ${transport.sessionId}:`,
            error instanceof Error ? error.stack : error,
          );
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
          console.log(
            `Received POST request for /messages with session ID: ${sessionId}`,
          );
          console.log(`Request headers:`, JSON.stringify(req.headers, null, 2));
          console.log(`Request body:`, JSON.stringify(req.body, null, 2));

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

              console.log(
                `Extracted API Key: ${apiKey ? "***" : "Not Found"}, Language: ${language}`,
              ); // Log extracted values

              // Prepare extra data
              let extra: { authInfo?: Record<string, any> } = {};
              const authData: Record<string, any> = {};
              if (apiKey) authData["302AI_API_KEY"] = apiKey;
              if (language) authData["LANGUAGE"] = language;

              if (Object.keys(authData).length > 0) {
                extra.authInfo = authData;
              }

              console.log(
                `Handling message for session ID: ${sessionId} with extra:`,
                JSON.stringify(extra),
              );

              // Check if the transport is SSEServerTransport and has handleMessage
              if (transport instanceof SSEServerTransport) {
                // Call handleMessage directly, passing the parsed body and extra auth info
                await transport.handleMessage(req.body, extra as any);
                console.log(
                  `handleMessage successful for session ID: ${sessionId}`,
                );
                // Send response manually as handleMessage doesn't
                if (!res.headersSent) {
                  res.writeHead(202).end("Accepted");
                }
              } else {
                // This should never happen, as only SSEServerTransport should be mapped to /messages
                console.error(
                  `Unexpected transport type for /messages endpoint: ${transport.constructor.name}`,
                );
                if (!res.headersSent) {
                  res
                    .status(500)
                    .send("Internal Server Error: Unexpected transport type");
                }
              }
            } catch (error) {
              console.error(
                `Error handling POST message for session ${sessionId}:`,
                error instanceof Error ? error.stack : error,
              ); // Enhanced log
              if (!res.headersSent) {
                res.status(500).send("Internal Server Error handling message");
              }
            }
          } else {
            console.warn(
              `No transport found for session ID: ${sessionId} on /messages POST`,
            );
            res.status(400).send("No transport found for sessionId");
          }
        },
      );

      app.listen(Number(port), () => {
        console.log(
          `SSE server listening on port ${port}. Use endpoint /sse for connections.`,
        );
      });
      return;
    } else if (mode === "streamable-http") {
      const app = express();
      // Use express.json() middleware to parse the body for us
      app.use(express.json());

      // Handle POST requests for client-to-server communication
      app.post(httpEndpoint, async (req: Request, res: Response) => {
        try {
          // Log request parameters
          const params = req.params;
          console.log("Request params:", JSON.stringify(params, null, 2));
          console.log("Request query:", JSON.stringify(req.query, null, 2));
          console.log("Request body:", JSON.stringify(req.body, null, 2));

          // The express.json() middleware has already parsed the body into req.body
          const parsedBody = req.body;
          console.log(
            "Request body parsed by middleware:",
            JSON.stringify(parsedBody, null, 2),
          );

          // Check for existing session ID
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          let transport: StreamableHTTPServerTransport;

          if (sessionId && this.transports[sessionId]) {
            // Reuse existing transport
            transport = this.transports[
              sessionId
            ] as StreamableHTTPServerTransport;
            console.log(`Using existing session: ${sessionId}`);

            // Update API key for existing session if provided in query
            if (req.query["x-api-key"]) {
              this.sessionApiKeys[sessionId] = req.query["x-api-key"] as string;
              console.log(`Updated API key for session: ${sessionId}`);
            }
          } else if (!sessionId && isInitializeRequest(req.body)) {
            // Use req.body here
            // New initialization request
            console.log(
              `Creating new StreamableHTTP session for initialize request`,
            );

            // Extract auth info from headers or query params
            const apiKey =
              (req.headers["x-api-key"] as string | undefined) ||
              (req.query["x-api-key"] as string | undefined);
            const language = req.headers["accept-language"] as
              | string
              | undefined;

            console.log(
              `Extracted API Key from request: ${apiKey ? "***" : "Not Found"}`,
            );

            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sessionId) => {
                console.log(
                  `StreamableHTTP session initialized with ID: ${sessionId}`,
                );

                // Store the transport by session ID
                this.transports[sessionId] = transport;

                // Store API key by session ID if available
                if (apiKey) {
                  this.sessionApiKeys[sessionId] = apiKey;
                  console.log(`Stored API key for new session: ${sessionId}`);
                }
              },
            });

            // Clean up transport when closed
            transport.onclose = () => {
              if (transport.sessionId) {
                console.log(
                  `Closing StreamableHTTP session: ${transport.sessionId}`,
                );
                delete this.transports[transport.sessionId];
                delete this.sessionApiKeys[transport.sessionId];
              }
            };

            console.log(`Connecting new StreamableHTTP transport to server`);
            // Connect to the MCP server
            await this.server.connect(transport);
          } else {
            // Invalid request
            console.log(
              `Invalid StreamableHTTP request: no valid session ID for non-initialize request`,
            );
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

          console.log(
            `Handling StreamableHTTP request for session ID: ${transport.sessionId}`,
          );

          // DO NOT modify the parsed body, just pass it directly
          await transport.handleRequest(req, res, parsedBody);
        } catch (error) {
          console.error(
            `Error handling StreamableHTTP request:`,
            error instanceof Error ? error.stack : error,
          );
          if (!res.headersSent) {
            res.status(500).send("Internal Server Error handling message");
          }
        }
      });

      app.listen(Number(port), () => {
        console.log(
          `StreamableHTTP server listening on port ${port}. Use endpoint ${httpEndpoint} for connections.`,
        );
      });
      return;
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

const server = new AI302Server();
server.run();
