import http from "node:http";

let requests = 0;
function translate(prompt) {
  for (let i = 0; i < prompt.length; i++) {
    if (prompt[i] !== "[") continue;
    for (let j = i + 1; j < prompt.length; j++) {
      if (prompt[j] !== "]") continue;
      let batch;
      try {
        batch = JSON.parse(prompt.slice(i, j + 1));
      } catch {
        continue;
      }
      if (
        Array.isArray(batch) &&
        batch.some((item) => String(item.input || "").includes("river")) &&
        batch.every((item) => "id" in item && "input" in item)
      ) {
        return JSON.stringify(
          batch.map((item) => ({
            id: item.id,
            output: String(item.input).toLowerCase().includes("ocean")
              ? "海洋今天很平静。空气很清新。"
              : "河流缓缓流淌。水很清澈。",
          })),
        );
      }
    }
  }
  return "河流缓缓流淌。水很清澈。";
}
const server = http.createServer(async (req, res) => {
  if (
    req.method !== "POST" ||
    req.url !== "/v1/chat/completions" ||
    req.headers.authorization !== "Bearer local-test-only"
  ) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (payload.model !== "local-smoke") {
    res.writeHead(400).end();
    return;
  }
  requests++;
  const content = translate(payload.messages.at(-1).content);
  const body = JSON.stringify({
    id: "local-zotero-test",
    object: "chat.completion",
    model: "local-smoke",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
  });
  res.writeHead(200, { "Content-Type": "application/json" }).end(body);
});
server.listen(0, "127.0.0.1", () =>
  console.log(`PORT=${server.address().port}`),
);
process.on("SIGINT", () => {
  console.log(`REQUESTS=${requests}`);
  server.close();
});
