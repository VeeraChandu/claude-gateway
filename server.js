import http from "node:http";
import { config } from "./config.js";
import {
  anthropicToOpenAI,
  streamOpenAIToAnthropic,
  openAIToAnthropicNonStream
} from "./translator.js";

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Health check & root info
  if (pathname === "/" || pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        gateway: "claude-openai-gateway",
        backend: config.openaiBaseUrl,
        defaultModel: config.defaultModel,
        mappings: config.modelMappings
      })
    );
    return;
  }

  // Models listing
  if (pathname === "/v1/models" || pathname === "/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "claude-3-7-sonnet-20250219", object: "model" },
          { id: "claude-3-5-sonnet-20241022", object: "model" },
          { id: "claude-3-5-haiku-20241022", object: "model" },
          { id: config.defaultModel, object: "model" }
        ]
      })
    );
    return;
  }

  // Token count mock/estimate endpoint
  if (pathname.endsWith("/messages/count_tokens")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const chars = JSON.stringify(parsed).length;
        const estimatedTokens = Math.max(1, Math.round(chars / 4));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: estimatedTokens }));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 100 }));
      }
    });
    return;
  }

  // Handle Messages endpoint (/v1/messages, /messages, /v1/v1/messages)
  const isMessagesEndpoint =
    pathname === "/v1/messages" ||
    pathname === "/messages" ||
    pathname === "/v1/v1/messages";

  if (isMessagesEndpoint && req.method === "POST") {
    const startTime = performance.now();
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;
    });

    req.on("end", async () => {
      try {
        const anthropicBody = JSON.parse(rawBody || "{}");
        const requestedModel = anthropicBody.model || "claude-3-5-sonnet-20241022";
        const resolvedModel = config.resolveModel(requestedModel);

        const openAiPayload = anthropicToOpenAI(anthropicBody, resolvedModel);

        // Determine API key
        let apiKey = config.openaiApiKey;
        const incomingKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace(/^Bearer\s+/i, "");
        // Only use incoming key if config has no key and incomingKey is not a dummy key
        const isDummy = !incomingKey || incomingKey.includes("local") || incomingKey.includes("dummy") || incomingKey.includes("test");
        if (!apiKey && !isDummy) {
          apiKey = incomingKey;
        }

        if (!apiKey) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "authentication_error",
                message: "No OpenAI API key provided. Set OPENAI_API_KEY environment variable or pass x-api-key."
              }
            })
          );
          return;
        }

        const openAiUrl = `${config.openaiBaseUrl}/chat/completions`;

        const openAiRes = await fetch(openAiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify(openAiPayload)
        });

        if (!openAiRes.ok) {
          const errText = await openAiRes.text();
          console.error(`\x1b[31m[Error] OpenAI returned HTTP ${openAiRes.status}:\x1b[0m`, errText);
          let errJson;
          try {
            errJson = JSON.parse(errText);
          } catch {
            errJson = { error: { message: errText } };
          }
          res.writeHead(openAiRes.status, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "api_error",
                message: errJson.error?.message || errText
              }
            })
          );
          return;
        }

        const isStream = openAiPayload.stream;

        if (isStream) {
          const ttftStart = performance.now();
          console.log(
            `\x1b[36m[Claude Code]\x1b[0m ${requestedModel} \x1b[90m->\x1b[0m \x1b[32m${resolvedModel}\x1b[0m (stream started)`
          );

          const thinkingRequested = anthropicBody.thinking?.type === "enabled";
          await streamOpenAIToAnthropic(openAiRes.body, requestedModel, res, thinkingRequested);

          const totalDuration = ((performance.now() - startTime) / 1000).toFixed(2);
          console.log(
            `\x1b[36m[Claude Code]\x1b[0m Stream finished in \x1b[33m${totalDuration}s\x1b[0m`
          );
        } else {
          const json = await openAiRes.json();
          const anthropicResponse = openAIToAnthropicNonStream(json, requestedModel);
          const totalDuration = ((performance.now() - startTime) / 1000).toFixed(2);
          console.log(
            `\x1b[36m[Claude Code]\x1b[0m ${requestedModel} \x1b[90m->\x1b[0m \x1b[32m${resolvedModel}\x1b[0m (non-stream) in \x1b[33m${totalDuration}s\x1b[0m`
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(anthropicResponse));
        }
      } catch (err) {
        console.error("\x1b[31m[Handler Error]\x1b[0m", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "internal_server_error",
                message: err.message
              }
            })
          );
        }
      }
    });
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: {
        type: "not_found",
        message: `Unknown path: ${pathname}`
      }
    })
  );
});

server.listen(config.port, config.host, () => {
  console.log(`\n\x1b[1m\x1b[32m🚀 Claude Code -> OpenAI Gateway running at:\x1b[0m`);
  console.log(`   \x1b[36mhttp://${config.host}:${config.port}\x1b[0m`);
  console.log(`   Backend:        \x1b[33m${config.openaiBaseUrl}\x1b[0m`);
  console.log(`   Default Model:  \x1b[35m${config.defaultModel}\x1b[0m`);
  console.log(`\nTo run Claude Code with this gateway:`);
  console.log(`   export ANTHROPIC_BASE_URL="http://${config.host}:${config.port}"`);
  console.log(`   export ANTHROPIC_API_KEY="dummy-key-or-openai-key"`);
  console.log(`   claude\n`);
});
