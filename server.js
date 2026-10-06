const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const config = require("./src/config");
const store = require("./src/store");

const {
  MarketEngine
} = require("./src/market");

const {
  SignalEngine
} = require("./src/engine");

const {
  createTracker
} = require("./src/tracker");

const {
  snapshot
} = require("./src/indicators");

const {
  enforceHardRR,
  HARD_MIN_RR
} = require("./src/risk-guard");

const {
  sendOwnerMessage,
  createNewConversation,
  getConversation,
  listConversations,
  deleteConversation,
  getOwnerWorkspaceState,
  getOwnerChatState
} = require("./src/owner-chat");

const clients = new Set();

function broadcast(event, payload) {
  if (!payload) return;

  const message =
    `event: ${event}\n` +
    `data: ${JSON.stringify(payload)}\n\n`;

  for (
    const client of
    [...clients]
  ) {
    try {
      client.write(message);
    } catch {
      clients.delete(client);
    }
  }
}

const tracker =
  createTracker({ broadcast });

let engine;

const market =
  new MarketEngine({
    onTick: ({ price }) => {
      tracker(
        config.publicSymbol,
        price
      );

      broadcast(
        "market-price",
        {
          symbol:
            config.publicSymbol,

          price,

          at:
            Date.now()
        }
      );
    },

    onCandleClose:
      event => {
        engine
          ?.onCandleClose(event)
          .catch(
            error =>
              console.error(
                "[AI]",
                error.message
              )
          );
      },

    onState:
      state => {
        broadcast(
          "market-status",
          state
        );
      }
  });

engine =
  new SignalEngine({
    market,
    broadcast
  });

function sendJson(
  res,
  status,
  body
) {
  const payload =
    JSON.stringify(body);

  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Content-Length":
        Buffer.byteLength(
          payload
        ),

      "Cache-Control":
        "no-store"
    }
  );

  res.end(payload);
}

function readJson(req) {
  return new Promise(
    (resolve, reject) => {
      let raw = "";

      req.on(
        "data",
        chunk => {
          raw += chunk;

          if (
            raw.length >
            1_000_000
          ) {
            reject(
              new Error(
                "Payload too large"
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => {
          if (!raw) {
            resolve({});
            return;
          }

          try {
            resolve(
              JSON.parse(raw)
            );
          } catch {
            reject(
              new Error(
                "Invalid JSON"
              )
            );
          }
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

function ownerAuthorized(req) {
  const supplied =
    String(
      req.headers[
        "x-owner-key"
      ] || ""
    );

  const expected =
    String(
      config.ownerApiKey
    );

  if (
    !supplied ||
    supplied.length !==
      expected.length
  ) {
    return false;
  }

  try {
    return crypto
      .timingSafeEqual(
        Buffer.from(
          supplied
        ),

        Buffer.from(
          expected
        )
      );
  } catch {
    return false;
  }
}

function normalizeSymbol(value) {
  const symbol =
    String(
      value || ""
    ).toUpperCase();

  return store.SYMBOLS
    .includes(symbol)
    ? symbol
    : null;
}

function currentOwnerContext() {
  let liveSnapshot = null;

  if (
    Number.isFinite(
      market.price
    )
  ) {
    try {
      liveSnapshot =
        snapshot(
          market.book,
          market.price
        );
    } catch {
      liveSnapshot = null;
    }
  }

  return {
    market:
      market.status(),

    aiEngine:
      engine.status(),

    liveSnapshot
  };
}

const mime = {
  ".html":
    "text/html; charset=utf-8",

  ".js":
    "text/javascript; charset=utf-8",

  ".css":
    "text/css; charset=utf-8",

  ".json":
    "application/json; charset=utf-8"
};

function serveStatic(
  urlPath,
  res
) {
  let relative =
    decodeURIComponent(
      urlPath
    );

  if (relative === "/") {
    relative =
      "/index.html";
  }

  const file =
    path.normalize(
      path.join(
        config.publicDir,
        relative
      )
    );

  if (
    !file.startsWith(
      config.publicDir
    )
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(
    file,
    (error, stat) => {
      if (
        error ||
        !stat.isFile()
      ) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      res.writeHead(
        200,
        {
          "Content-Type":
            mime[
              path.extname(file)
            ] ||
            "application/octet-stream",

          "Cache-Control":
            "no-cache"
        }
      );

      fs.createReadStream(
        file
      ).pipe(res);
    }
  );
}

const server =
  http.createServer(
    async (req, res) => {
      const url =
        new URL(
          req.url,
          `http://${req.headers.host || "localhost"}`
        );

      if (
        url.pathname ===
          "/api/health" &&
        req.method === "GET"
      ) {
        sendJson(
          res,
          200,
          {
            ok: true,

            service:
              "COSUMIO SIGNAL Phase 4",

            market:
              market.status(),

            ai:
              engine.status(),

            ownerChat:
              getOwnerChatState(),

            time:
              new Date()
                .toISOString()
          }
        );

        return;
      }

      if (
        url.pathname ===
          "/api/signals" &&
        req.method === "GET"
      ) {
        const symbol =
          normalizeSymbol(
            url.searchParams
              .get("symbol")
          );

        if (!symbol) {
          sendJson(
            res,
            400,
            {
              error:
                "Valid symbol required"
            }
          );

          return;
        }

        sendJson(
          res,
          200,
          {
            symbol,

            items:
              store.list(symbol)
          }
        );

        return;
      }

      if (
        url.pathname ===
          "/api/market/status" &&
        req.method === "GET"
      ) {
        sendJson(
          res,
          200,
          market.status()
        );

        return;
      }

      if (
        url.pathname ===
          "/api/ai/status" &&
        req.method === "GET"
      ) {
        sendJson(
          res,
          200,
          engine.status()
        );

        return;
      }

      if (
        url.pathname ===
          "/api/stream" &&
        req.method === "GET"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "text/event-stream",

            "Cache-Control":
              "no-cache, no-transform",

            "Connection":
              "keep-alive",

            "X-Accel-Buffering":
              "no"
          }
        );

        res.write(
          'event: connected\n' +
          'data: {"ok":true}\n\n'
        );

        clients.add(res);

        const ping =
          setInterval(
            () => {
              try {
                res.write(
                  ": keepalive\n\n"
                );
              } catch {}
            },
            20000
          );

        req.on(
          "close",
          () => {
            clearInterval(
              ping
            );

            clients.delete(
              res
            );
          }
        );

        return;
      }

      if (
        url.pathname
          .startsWith(
            "/api/owner/"
          ) &&
        !ownerAuthorized(req)
      ) {
        sendJson(
          res,
          401,
          {
            error:
              "Unauthorized"
          }
        );

        return;
      }

      if (
        url.pathname ===
          "/api/owner/workspace" &&
        req.method === "GET"
      ) {
        sendJson(
          res,
          200,
          getOwnerWorkspaceState()
        );

        return;
      }

      if (
        url.pathname ===
          "/api/owner/conversations" &&
        req.method === "GET"
      ) {
        sendJson(
          res,
          200,
          {
            conversations:
              listConversations()
          }
        );

        return;
      }

      if (
        url.pathname ===
          "/api/owner/conversations" &&
        req.method === "POST"
      ) {
        try {
          const body =
            await readJson(req);

          const conversation =
            createNewConversation(
              body?.title
            );

          sendJson(
            res,
            201,
            {
              ok: true,
              conversation
            }
          );
        } catch (error) {
          sendJson(
            res,
            400,
            {
              error:
                error.message
            }
          );
        }

        return;
      }

      const conversationMatch =
        url.pathname.match(
          /^\/api\/owner\/conversations\/([^/]+)$/
        );

      if (
        conversationMatch &&
        req.method === "GET"
      ) {
        const conversation =
          getConversation(
            decodeURIComponent(
              conversationMatch[1]
            )
          );

        if (!conversation) {
          sendJson(
            res,
            404,
            {
              error:
                "Conversation not found"
            }
          );

          return;
        }

        sendJson(
          res,
          200,
          {
            conversation
          }
        );

        return;
      }

      if (
        conversationMatch &&
        req.method === "DELETE"
      ) {
        const removed =
          deleteConversation(
            decodeURIComponent(
              conversationMatch[1]
            )
          );

        sendJson(
          res,
          removed ? 200 : 404,
          removed
            ? {
                ok: true
              }
            : {
                error:
                  "Conversation not found"
              }
        );

        return;
      }

      if (
        url.pathname ===
          "/api/owner/chat" &&
        req.method === "POST"
      ) {
        try {
          const body =
            await readJson(req);

          const result =
            await sendOwnerMessage(
              body.conversationId,
              body.message,
              currentOwnerContext()
            );

          sendJson(
            res,
            200,
            {
              ok: true,

              conversationId:
                result.conversationId,

              message:
                result.text,

              responseId:
                result.responseId,

              responseStatus:
                result.status,

              saved:
                result.saved
            }
          );
        } catch (error) {
          sendJson(
            res,
            400,
            {
              error:
                error.message
            }
          );
        }

        return;
      }

      if (
        url.pathname ===
          "/api/owner/signal" &&
        req.method === "POST"
      ) {
        try {
          const body =
            await readJson(req);

          const symbol =
            normalizeSymbol(
              body.symbol
            );

          const side =
            String(
              body.side || ""
            ).toUpperCase();

          const execution =
            String(
              body.execution || ""
            ).toUpperCase();

          const status =
            String(
              body.status || "WAIT"
            ).toUpperCase();

          if (
            !symbol ||
            !["BUY", "SELL"]
              .includes(side) ||
            !["MARKET", "LIMIT"]
              .includes(
                execution
              )
          ) {
            sendJson(
              res,
              400,
              {
                error:
                  "Invalid signal"
              }
            );

            return;
          }

          for (
            const key of
            [
              "entry",
              "sl",
              "tp",
              "rr"
            ]
          ) {
            if (
              body[key] == null ||
              String(
                body[key]
              ).trim() === ""
            ) {
              sendJson(
                res,
                400,
                {
                  error:
                    `${key} required`
                }
              );

              return;
            }
          }

          const rrCheck =
            enforceHardRR(
              {
                side,
                entry: body.entry,
                sl: body.sl,
                tp: body.tp
              },
              config.minRR
            );

          if (!rrCheck.ok) {
            sendJson(
              res,
              400,
              {
                error:
                  rrCheck.reason,
                hardMinRR:
                  HARD_MIN_RR
              }
            );

            return;
          }

          const item =
            store.addSignal({
              symbol,
              side,
              execution,

              entry:
                rrCheck.entry,

              sl:
                rrCheck.sl,

              tp:
                rrCheck.tp,

              rr:
                `1:${rrCheck.rr}`,

              confidence:
                body.confidence,

              status,

              source:
                "OWNER"
            });

          broadcast(
            "signal",
            item
          );

          sendJson(
            res,
            201,
            {
              ok: true,
              item
            }
          );
        } catch (error) {
          sendJson(
            res,
            400,
            {
              error:
                error.message
            }
          );
        }

        return;
      }

      if (
        url.pathname ===
          "/api/owner/analyze" &&
        req.method === "POST"
      ) {
        try {
          const result =
            await engine.manual();

          sendJson(
            res,
            200,
            {
              ok: true,

              result,

              ai:
                engine.status()
            }
          );
        } catch (error) {
          sendJson(
            res,
            400,
            {
              error:
                error.message,

              ai:
                engine.status()
            }
          );
        }

        return;
      }

      serveStatic(
        url.pathname,
        res
      );
    }
  );

server.listen(
  config.port,
  config.host,
  () => {
    console.log(
      `COSUMIO SIGNAL Phase 4: http://${config.host}:${config.port}`
    );

    console.log(
      `Owner AI Console: http://${config.host}:${config.port}/owner.html`
    );

    console.log(
      `Market ${config.marketSymbol} -> ${config.publicSymbol}`
    );

    console.log(
      `AI model: ${config.openaiModel}`
    );

    console.log(
      `AUTO_PUBLISH: ${config.autoPublish}`
    );

    console.log(
      `HARD MIN RR: 1:${HARD_MIN_RR}`
    );

    console.log(
      `AI COST GUARD: ${config.aiDailyRequestLimit === 0 ? "unlimited" : `${config.aiDailyRequestLimit} requests/day`} | cooldown ${config.aiCooldownSeconds}s`
    );

    console.log(
      "Owner history + memory: persistent"
    );

    if (
      !config.twelveDataApiKey
    ) {
      console.warn(
        "WAITING: TWELVE_DATA_API_KEY missing"
      );
    }

    if (
      !config.openaiApiKey
    ) {
      console.warn(
        "WAITING: OPENAI_API_KEY missing"
      );
    }
  }
);

market.start();
