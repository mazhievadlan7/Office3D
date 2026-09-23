const fs = require("node:fs");
const http = require("node:http");

const gate = process.argv[2] === "gate";
if (!gate) {
  fs.mkdirSync("/opt/data", { recursive: true });
  fs.appendFileSync("/opt/data/started", `${process.env.TAG}\n`);
  fs.writeFileSync("/opt/data/schema", `${process.env.TAG}\n`);
}
const healthy = gate || process.env.VERSION === "good";
const healthPath = gate ? "/gate/health" : "/health";
http
  .createServer((req, res) => {
    res.writeHead(req.url === healthPath && healthy ? 200 : 503);
    res.end(healthy ? "ok" : "not ready");
  })
  .listen(gate ? 9120 : 8642, "0.0.0.0");
