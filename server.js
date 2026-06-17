import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "shadow-puppet.json");
const port = Number(process.env.PORT || 3023);
const steps = ["接收", "清洁", "补片", "补色", "交付"];

const seed = {
  commissions: [
    {
      id: "SP-001",
      client: "洛川民俗馆",
      roleName: "武生靠旗",
      era: "民国早期",
      damage: "腿部开裂，靠旗缺角",
      missingParts: "右侧靠旗尖",
      colorNotes: "朱砂区域褪色",
      reinforcement: "薄驴皮补片",
      owner: "许岚",
      dueDate: "2026-06-28",
      status: "补片",
      records: [
        { at: "2026-06-10T10:00:00.000Z", step: "接收", note: "登记尺寸和破损" },
        { at: "2026-06-12T14:30:00.000Z", step: "清洁", note: "完成低湿清洁" }
      ]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>皮影修复小作坊</title>
  <style>
    :root { --bg:#f4efe7; --panel:#fff; --ink:#29231e; --muted:#76695f; --line:#ddcfc0; --accent:#7d3f2e; --green:#47705b; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); } h1 { margin:0; font-size:26px; }
    main { display:grid; grid-template-columns:370px 1fr; gap:22px; padding:22px 28px; } form,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    h2 { margin:0 0 12px; font-size:18px; } label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:70px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; padding:3px 8px; border:1px solid var(--line); border-radius:999px; font-size:12px; }
    .done { color:var(--green); font-weight:700; } @media (max-width:900px){ main{grid-template-columns:1fr;padding:16px;} header{padding:18px 16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><h1>皮影修复小作坊</h1><div class="meta">委托、修复步骤、交付状态</div></header>
  <main>
    <form id="form">
      <h2>新增修复委托</h2>
      <label>委托人</label><input name="client" required>
      <label>皮影角色名称</label><input name="roleName" required>
      <label>年代估计</label><input name="era" required>
      <label>破损部位</label><textarea name="damage" required></textarea>
      <label>缺失零件</label><input name="missingParts">
      <label>补色记录</label><textarea name="colorNotes"></textarea>
      <label>加固材料</label><input name="reinforcement" required>
      <label>负责人</label><input name="owner" required>
      <label>预计完成日期</label><input name="dueDate" type="date" required>
      <button>保存委托</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="list"></div>
    </section>
  </main>
  <script>
    const steps = ${JSON.stringify(steps)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const list = document.querySelector("#list");
    let commissions = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function render() {
      stats.innerHTML = steps.map(step => '<div class="stat"><span>'+step+'</span><strong>'+commissions.filter(c => c.status === step).length+'</strong></div>').join("");
      list.innerHTML = commissions.map(c => '<article class="card"><h3>'+c.roleName+'</h3><span class="pill">'+c.status+'</span><div class="meta">'+c.client+' · '+c.era+' · '+c.owner+'</div><div><b>破损</b> '+c.damage+'</div><div><b>材料</b> '+c.reinforcement+'</div><label>更新步骤</label><select data-step="'+c.id+'">'+steps.map(s => '<option>'+s+'</option>').join("")+'</select><input data-note="'+c.id+'" placeholder="步骤备注"><button data-save="'+c.id+'">保存步骤</button><div class="meta">'+c.records.map(r => r.step+"："+r.note).join(" / ")+'</div></article>').join("");
      document.querySelectorAll("[data-step]").forEach(sel => sel.value = commissions.find(c => c.id === sel.dataset.step).status);
      document.querySelectorAll("[data-save]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.save;
        await api('/api/commissions/'+id+'/records', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+id+'"]').value, note: document.querySelector('[data-note="'+id+'"]').value || "步骤完成" }) });
        await load();
      });
    }
    async function load(){ commissions = await api("/api/commissions"); render(); }
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/commissions", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/commissions") return sendJson(res, 200, db.commissions);
    if (req.method === "POST" && url.pathname === "/api/commissions") {
      const input = await body(req);
      const commission = { id: `SP-${Date.now()}`, ...input, status: "接收", records: [{ at: new Date().toISOString(), step: "接收", note: "登记委托" }] };
      db.commissions.unshift(commission);
      await saveDb(db);
      return sendJson(res, 201, commission);
    }
    const match = url.pathname.match(/^\/api\/commissions\/([^/]+)\/records$/);
    if (match && req.method === "POST") {
      const commission = db.commissions.find(item => item.id === match[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const input = await body(req);
      commission.status = input.step;
      commission.records.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
      await saveDb(db);
      return sendJson(res, 200, commission);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Shadow puppet restoration app listening on http://localhost:${port}`));
