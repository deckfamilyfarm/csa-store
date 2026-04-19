const express = require("express");
const http = require("http");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 5176);
const apiTarget = new URL(process.env.API_TARGET || "http://127.0.0.1:5177");
const distDir = path.join(__dirname, "design", "template", "vite-app", "dist");

function proxyApi(req, res) {
  const target = new URL(req.originalUrl, apiTarget);
  const headers = { ...req.headers, host: target.host };

  const proxyReq = http.request(
    target,
    {
      method: req.method,
      headers
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    console.error("API proxy error:", error.message);
    if (!res.headersSent) {
      res.status(502).type("text/plain").send("API proxy failed");
    } else {
      res.end();
    }
  });

  req.pipe(proxyReq);
}

app.use("/api", proxyApi);
app.use(express.static(distDir, { index: "index.html" }));
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }

  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Store web server listening on :${port}`);
  console.log(`Proxying /api to ${apiTarget.origin}`);
});
