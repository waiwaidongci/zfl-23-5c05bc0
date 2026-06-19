import http from "node:http";

const port = Number(process.env.PORT || 3023);
const host = process.env.HOST || "localhost";
const baseUrl = `http://${host}:${port}`;

const endpoints = [
  { path: "/", name: "首页", expectHtml: true },
  { path: "/api/commissions", name: "委托列表 API" },
  { path: "/api/materials", name: "材料列表 API" },
  { path: "/api/members", name: "成员列表 API" },
  { path: "/api/step-templates", name: "步骤模板 API" }
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body, raw: true });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("请求超时"));
    });
  });
}

async function runHealthCheck() {
  console.log(`🧪 健康检查 - ${baseUrl}`);
  console.log("=".repeat(50));

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const endpoint of endpoints) {
    const url = `${baseUrl}${endpoint.path}`;
    try {
      const res = await fetchJson(url);
      const ok = res.status >= 200 && res.status < 300;

      if (ok) {
        console.log(`✅ ${endpoint.name} (${endpoint.path}) - ${res.status}`);
        passed++;
      } else {
        console.log(`❌ ${endpoint.name} (${endpoint.path}) - ${res.status}`);
        failed++;
      }
      results.push({ name: endpoint.name, path: endpoint.path, status: res.status, ok });
    } catch (err) {
      console.log(`❌ ${endpoint.name} (${endpoint.path}) - ${err.message}`);
      failed++;
      results.push({ name: endpoint.name, path: endpoint.path, error: err.message, ok: false });
    }
  }

  console.log("=".repeat(50));
  console.log(`通过: ${passed} / 失败: ${failed} / 总计: ${endpoints.length}`);

  if (failed > 0) {
    console.log("\n❌ 健康检查未通过");
    process.exit(1);
  } else {
    console.log("\n✅ 健康检查全部通过");
    process.exit(0);
  }
}

runHealthCheck().catch((err) => {
  console.error("健康检查执行失败:", err);
  process.exit(1);
});
