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
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// support for mcp.so
const ai302ApiKey = getParamValue("302ai_api_key");
const languageParam = getParamValue("language");
const mode = getParamValue("mode") || "stdio";
const port = getParamValue("port") || 9593;
const endpoint = getParamValue("endpoint") || "/rest";
const httpEndpoint = getParamValue("http_endpoint") || "/mcp";

dotenv.config();

// Logger utility
class Logger {
  private logDir: string;
  private logFile: string;

  constructor() {
    this.logDir = join(process.cwd(), "logs");
    this.logFile = join(this.logDir, `mcp-${new Date().toISOString().split('T')[0]}.log`);
    
    // Ensure log directory exists
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  private log(level: string, message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const logMessage = data 
      ? `[${timestamp}] ${level}: ${message} ${JSON.stringify(data)}\n`
      : `[${timestamp}] ${level}: ${message}\n`;
    
    try {
      appendFileSync(this.logFile, logMessage);
    } catch (error) {
      // Silently fail to avoid console output
    }
  }

  info(message: string, data?: any) {
    this.log("INFO", message, data);
  }

  error(message: string, data?: any) {
    this.log("ERROR", message, data);
  }

  warn(message: string, data?: any) {
    this.log("WARN", message, data);
  }
}

const logger = new Logger();

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

    logger.info("Sending listTools request", {
      url: url.toString(),
      language: language,
    });

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
        logger.error("API Error Response", {
          status: response.status,
          statusText: response.statusText,
          body: errorBody,
        });
        errorDetails += ` - ${errorBody}`;
      } catch (parseError) {
        logger.error("Failed to parse error response", parseError);
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

    logger.info("Sending tool call request", {
      url: `${this.baseUrl}/v1/tool/call`,
      body: requestBody,
    });

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
        logger.error("API Error Response", {
          status: response.status,
          statusText: response.statusText,
          body: errorBody,
        });
        errorDetails += ` - ${errorBody}`;
      } catch (parseError) {
        logger.error("Failed to parse error response", parseError);
      }

      throw new McpError(ErrorCode.InternalError, errorDetails);
    }

    const data = await response.json();
    logger.info("Tool call result", data);

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
        version: "0.1.8",
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
      logger.error("[MCP Error]", error);
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
    logger.info("getApiInstance received extra", extra);
    // 1. Check extra.authInfo parameter
    const apiKeyFromExtra = extra?.authInfo?.["302AI_API_KEY"];
    logger.info(`getApiInstance apiKeyFromExtra check resulted in: ${apiKeyFromExtra}`);
    if (apiKeyFromExtra) {
      logger.info("Using API key from 'extra.authInfo' parameter");
      if (!this.api || this.api.getApiKey() !== apiKeyFromExtra) {
        this.api = new AI302Api(apiKeyFromExtra);
      }
      return this.api;
    }

    // 2. Check global param (from command line/mcp.so)
    const apiKeyFromParam = ai302ApiKey !== "YOUR_API_KEY_HERE" && ai302ApiKey;
    if (apiKeyFromParam) {
      logger.info("Using API key from global param");
      if (!this.api || this.api.getApiKey() !== apiKeyFromParam) {
        this.api = new AI302Api(apiKeyFromParam);
      }
      return this.api;
    }

    // 3. Check auth within request._meta (passed via getAuthValue)
    const apiKeyFromAuth = request && getAuthValue(request, "302AI_API_KEY");
    if (apiKeyFromAuth) {
      logger.info("Using API key from request meta auth");
      if (!this.api || this.api.getApiKey() !== apiKeyFromAuth) {
        this.api = new AI302Api(apiKeyFromAuth);
      }
      return this.api;
    }

    // 4. Check for sessionId in extra directly (this matches the actual structure)
    if (extra && extra.sessionId) {
      const apiKeyFromSession = this.sessionApiKeys[extra.sessionId];
      if (apiKeyFromSession) {
        logger.info(`Using API key from session storage for session: ${extra.sessionId}`);
        if (!this.api || this.api.getApiKey() !== apiKeyFromSession) {
          this.api = new AI302Api(apiKeyFromSession);
        }
        return this.api;
      }
    }

    // 5. Check environment variable
    const apiKeyFromEnv = process.env["302AI_API_KEY"];
    if (apiKeyFromEnv) {
      logger.info("Using API key from environment variable");
      if (!this.api || this.api.getApiKey() !== apiKeyFromEnv) {
        this.api = new AI302Api(apiKeyFromEnv);
      }
      return this.api;
    }

    // If no key found, throw error
    logger.error("API key not found in extra, global param, request meta, or env var.");
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
      logger.info("Using language from 'extra.authInfo' parameter");
      return langFromExtra;
    }

    // 2. Check global param
    const langFromParam =
      languageParam !== "YOUR_LANGUAGE_HERE" && languageParam;
    if (langFromParam) {
      logger.info("Using language from global param");
      return langFromParam;
    }

    // 3. Check auth within request._meta
    const langFromAuth = request && getAuthValue(request, "LANGUAGE");
    if (langFromAuth) {
      logger.info("Using language from request meta auth");
      return langFromAuth;
    }

    // 4. Check environment variable
    const langFromEnv = process.env.LANGUAGE;
    if (langFromEnv) {
      logger.info("Using language from environment variable");
      return langFromEnv;
    }

    logger.info("Language not found in extra, global param, request meta, or env var.");
    return undefined;
  }

  private async setupToolHandlers(): Promise<void> {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async (request, extra) => {
        logger.info("Entered ListToolsRequest handler with extra", extra);
        logger.info("ListToolsRequestSchema extra", extra);
        let api: AI302Api;
        let language: string | undefined;
        try {
          logger.info("Attempting to get API instance in ListToolsRequest handler");

          // No need to modify the request object, just pass extra with sessionId directly
          api = this.getApiInstance(request, extra);
          logger.info("Successfully got API instance in ListToolsRequest handler");
          language = this.getLanguage(request, extra);
          logger.info(`Language resolved to: ${language} in ListToolsRequest handler`);
          const tools = await api.listTools(language);
          logger.info("Successfully listed tools in ListToolsRequest handler");
          return { tools };
        } catch (error) {
          logger.error("Error inside ListToolsRequest handler", error instanceof Error ? error.stack : error);
          throw error;
        }
      },
    );

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        logger.info("Entered CallToolRequest handler with extra", extra);
        logger.info("CallToolRequestSchema extra", extra);
        try {
          // No need to modify the request object, just pass extra with sessionId directly
          const api = this.getApiInstance(request, extra);
          logger.info("Successfully got API instance in CallToolRequest handler");

          const toolName = request.params.name;
          const toolArgs = request.params.arguments;
          logger.info(`Calling backend tool: ${toolName}`);
          logger.info("Backend tool arguments", toolArgs);

          const content = await api.callTool(toolName, toolArgs);
          logger.info("Successfully called tool in CallToolRequest handler");
          logger.info("Backend tool result", content);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ content }, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error("Error inside CallToolRequest handler", error instanceof Error ? error.stack : error);
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
      logger.info(`REST server listening on port ${port} at endpoint ${endpoint}`);
      return;
    } else if (mode === "sse") {
      const app = express();
      // app.use(express.json()); // Middleware to parse JSON bodies for /messages -- REMOVED

      app.get("/sse", async (_: Request, res: Response) => {
        logger.info("Received GET request for /sse");
        const transport = new SSEServerTransport("/messages", res);
        this.transports[transport.sessionId] = transport;
        logger.info(`SSE connection established with session ID: ${transport.sessionId}`);

        res.on("close", () => {
          logger.info(`SSE connection closed for session ID: ${transport.sessionId}`);
          delete this.transports[transport.sessionId];
        });

        try {
          logger.info(`Attempting server connect for session ID: ${transport.sessionId}`);
          await this.server.connect(transport);
          logger.info(`Server connect successful for session ID: ${transport.sessionId}`);
        } catch (error) {
          logger.error(`Error connecting transport for session ${transport.sessionId}`, error instanceof Error ? error.stack : error);
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
          logger.info(`Received POST request for /messages with session ID: ${sessionId}`);
          logger.info("Request headers", req.headers);
          logger.info("Request body", req.body);

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

              logger.info(`Extracted API Key: ${apiKey ? "***" : "Not Found"}, Language: ${language}`);

              // Prepare extra data
              let extra: { authInfo?: Record<string, any> } = {};
              const authData: Record<string, any> = {};
              if (apiKey) authData["302AI_API_KEY"] = apiKey;
              if (language) authData["LANGUAGE"] = language;

              if (Object.keys(authData).length > 0) {
                extra.authInfo = authData;
              }

              logger.info(`Handling message for session ID: ${sessionId} with extra`, extra);

              // Check if the transport is SSEServerTransport and has handleMessage
              if (transport instanceof SSEServerTransport) {
                // Call handleMessage directly, passing the parsed body and extra auth info
                await transport.handleMessage(req.body, extra as any);
                logger.info(`handleMessage successful for session ID: ${sessionId}`);
                // Send response manually as handleMessage doesn't
                if (!res.headersSent) {
                  res.writeHead(202).end("Accepted");
                }
              } else {
                // This should never happen, as only SSEServerTransport should be mapped to /messages
                logger.error(`Unexpected transport type for /messages endpoint: ${transport.constructor.name}`);
                if (!res.headersSent) {
                  res
                    .status(500)
                    .send("Internal Server Error: Unexpected transport type");
                }
              }
            } catch (error) {
              logger.error(`Error handling POST message for session ${sessionId}`, error instanceof Error ? error.stack : error);
              if (!res.headersSent) {
                res.status(500).send("Internal Server Error handling message");
              }
            }
          } else {
            logger.warn(`No transport found for session ID: ${sessionId} on /messages POST`);
            res.status(400).send("No transport found for sessionId");
          }
        },
      );

      app.listen(Number(port), () => {
        logger.info(`SSE server listening on port ${port}. Use endpoint /sse for connections.`);
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
          logger.info("Request params", params);
          logger.info("Request query", req.query);
          logger.info("Request body", req.body);

          // The express.json() middleware has already parsed the body into req.body
          const parsedBody = req.body;
          logger.info("Request body parsed by middleware", parsedBody);

          // Check for existing session ID
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          let transport: StreamableHTTPServerTransport;

          if (sessionId && this.transports[sessionId]) {
            // Reuse existing transport
            transport = this.transports[
              sessionId
            ] as StreamableHTTPServerTransport;
            logger.info(`Using existing session: ${sessionId}`);

            // Update API key for existing session if provided in query
            if (req.query["x-api-key"]) {
              this.sessionApiKeys[sessionId] = req.query["x-api-key"] as string;
              logger.info(`Updated API key for session: ${sessionId}`);
            }
          } else if (!sessionId && isInitializeRequest(req.body)) {
            // Use req.body here
            // New initialization request
            logger.info("Creating new StreamableHTTP session for initialize request");

            // Extract auth info from headers or query params
            const apiKey =
              (req.headers["x-api-key"] as string | undefined) ||
              (req.query["x-api-key"] as string | undefined);
            const language = req.headers["accept-language"] as
              | string
              | undefined;

            logger.info(`Extracted API Key from request: ${apiKey ? "***" : "Not Found"}`);

            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sessionId) => {
                logger.info(`StreamableHTTP session initialized with ID: ${sessionId}`);

                // Store the transport by session ID
                this.transports[sessionId] = transport;

                // Store API key by session ID if available
                if (apiKey) {
                  this.sessionApiKeys[sessionId] = apiKey;
                  logger.info(`Stored API key for new session: ${sessionId}`);
                }
              },
            });

            // Clean up transport when closed
            transport.onclose = () => {
              if (transport.sessionId) {
                logger.info(`Closing StreamableHTTP session: ${transport.sessionId}`);
                delete this.transports[transport.sessionId];
                delete this.sessionApiKeys[transport.sessionId];
              }
            };

            logger.info("Connecting new StreamableHTTP transport to server");
            // Connect to the MCP server
            await this.server.connect(transport);
          } else {
            // Invalid request
            logger.info("Invalid StreamableHTTP request: no valid session ID for non-initialize request");
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

          logger.info(`Handling StreamableHTTP request for session ID: ${transport.sessionId}`);

          // DO NOT modify the parsed body, just pass it directly
          await transport.handleRequest(req, res, parsedBody);
        } catch (error) {
          logger.error("Error handling StreamableHTTP request", error instanceof Error ? error.stack : error);
          if (!res.headersSent) {
            res.status(500).send("Internal Server Error handling message");
          }
        }
      });

      app.listen(Number(port), () => {
        logger.info(`StreamableHTTP server listening on port ${port}. Use endpoint ${httpEndpoint} for connections.`);
      });
      return;
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

const server = new AI302Server();
server.run();
