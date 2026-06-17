import http from "node:http";
import { mkdir, readFile, writeFile, unlink, readdir, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { dirname, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "shadow-puppet.json");
const uploadsDir = join(__dirname, "uploads");
const port = Number(process.env.PORT || 3023);
const defaultSteps = ["接收", "清洁", "补片", "补色", "交付"];
const allowedImageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const maxFileSize = 10 * 1024 * 1024;

async function ensureUploadsDir() {
  if (!existsSync(uploadsDir)) await mkdir(uploadsDir, { recursive: true });
}

function parseMultipart(body, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from("--" + boundary);
  const endBoundaryBuffer = Buffer.from("--" + boundary + "--");
  
  let start = 0;
  while (start < body.length) {
    const boundaryIdx = body.indexOf(boundaryBuffer, start);
    if (boundaryIdx === -1) break;
    
    const nextBoundaryIdx = body.indexOf(boundaryBuffer, boundaryIdx + boundaryBuffer.length);
    const isEnd = body.indexOf(endBoundaryBuffer, boundaryIdx) === boundaryIdx;
    if (isEnd) break;
    
    const partStart = boundaryIdx + boundaryBuffer.length + 2;
    const partEnd = nextBoundaryIdx !== -1 ? nextBoundaryIdx - 2 : body.length;
    
    const headersEnd = body.indexOf("\r\n\r\n", partStart);
    if (headersEnd === -1) break;
    
    const headersRaw = body.slice(partStart, headersEnd).toString("utf8");
    const contentStart = headersEnd + 4;
    const content = body.slice(contentStart, partEnd);
    
    const headers = {};
    headersRaw.split("\r\n").forEach(line => {
      const [key, val] = line.split(": ");
      if (key && val) headers[key.toLowerCase()] = val;
    });
    
    const disposition = headers["content-disposition"] || "";
    const nameMatch = disposition.match(/name="([^"]+)"/);
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    
    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: headers["content-type"],
      content
    });
    
    start = nextBoundaryIdx !== -1 ? nextBoundaryIdx : body.length;
  }
  
  return parts;
}

function sanitizeFilename(filename) {
  const ext = extname(filename).toLowerCase();
  const name = basename(filename, extname(filename)).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_");
  return `${name}${ext}`;
}

const seedTemplates = [
  { id: "TPL-DEFAULT", name: "标准流程", description: "通用五步修复流程", steps: ["接收", "清洁", "补片", "补色", "交付"] },
  { id: "TPL-WUSHENG", name: "武生靠旗", description: "武生靠旗类皮影修复", steps: ["接收", "拆解", "清洁", "补片", "缝制靠旗", "补色", "组装", "交付"] },
  { id: "TPL-DANJIAO", name: "旦角头饰", description: "旦角头饰类精细修复", steps: ["接收", "拆卸头饰", "清洁", "补片", "头饰重绘", "补色", "组装头饰", "交付"] },
  { id: "TPL-BACKDROP", name: "影窗布景", description: "影窗布景大幅修复", steps: ["接收", "展开检查", "清洁", "拼接补片", "补色", "托裱", "交付"] }
];

const seed = {
  stepTemplates: seedTemplates,
  clients: [
    {
      id: "CL-001",
      name: "洛川民俗馆",
      contact: "张馆长",
      phone: "0911-3821234",
      address: "陕西省延安市洛川县凤栖街道",
      remark: "长期合作客户，主要修复民国时期皮影"
    }
  ],
  commissions: [
    {
      id: "SP-001",
      clientId: "CL-001",
      client: "洛川民俗馆",
      roleName: "武生靠旗",
      era: "民国早期",
      damage: "腿部开裂，靠旗缺角",
      missingParts: "右侧靠旗尖",
      colorNotes: "朱砂区域褪色",
      reinforcement: "薄驴皮补片",
      materials: [
        { materialId: "MAT-1", name: "薄驴皮补片", batch: "LP-2026-A01", quantity: 2 }
      ],
      owner: "许岚",
      dueDate: "2026-06-28",
      status: "补片",
      records: [
        { at: "2026-06-10T10:00:00.000Z", step: "接收", note: "登记尺寸和破损" },
        { at: "2026-06-12T14:30:00.000Z", step: "清洁", note: "完成低湿清洁" }
      ],
      images: {
        before: [],
        during: [],
        after: []
      }
    }
  ],
  materials: [
    {
      id: "MAT-1",
      name: "薄驴皮补片",
      category: "皮料",
      batch: "LP-2026-A01",
      stock: 50,
      unit: "张",
      remark: "陕西洛川产，厚度0.8mm"
    },
    {
      id: "MAT-2",
      name: "朱砂矿物颜料",
      category: "颜料",
      batch: "ZS-2026-B03",
      stock: 200,
      unit: "克",
      remark: "特级纯天然朱砂粉"
    },
    {
      id: "MAT-3",
      name: "石黄矿物颜料",
      category: "颜料",
      batch: "SH-2026-B01",
      stock: 150,
      unit: "克",
      remark: "老矿坑料，色泽沉稳"
    },
    {
      id: "MAT-4",
      name: "鱼鳔胶",
      category: "胶料",
      batch: "YJ-2026-C02",
      stock: 80,
      unit: "克",
      remark: "传统手工熬制"
    },
    {
      id: "MAT-5",
      name: "骨胶",
      category: "胶料",
      batch: "GJ-2026-C01",
      stock: 120,
      unit: "克",
      remark: "高纯度牛骨胶粒"
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return JSON.parse(JSON.stringify(seed));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  let migrated = false;
  if (!db.stepTemplates || !db.stepTemplates.length) {
    db.stepTemplates = JSON.parse(JSON.stringify(seedTemplates));
    migrated = true;
  }
  if (db.commissions) {
    for (const c of db.commissions) {
      if (!c.steps || !Array.isArray(c.steps) || !c.steps.length) {
        c.steps = [...defaultSteps];
        migrated = true;
      }
      if (!c.images || typeof c.images !== "object") {
        c.images = { before: [], during: [], after: [] };
        migrated = true;
      } else {
        if (!Array.isArray(c.images.before)) { c.images.before = []; migrated = true; }
        if (!Array.isArray(c.images.during)) { c.images.during = []; migrated = true; }
        if (!Array.isArray(c.images.after)) { c.images.after = []; migrated = true; }
      }
    }
  }
  if (migrated) await saveDb(db);
  return db;
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
    :root { --bg:#f4efe7; --panel:#fff; --ink:#29231e; --muted:#76695f; --line:#ddcfc0; --accent:#7d3f2e; --green:#47705b; --orange:#c4702c; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); } h1 { margin:0; font-size:26px; }
    .tabs { display:flex; gap:4px; padding:14px 28px 0; background:#fff; border-bottom:1px solid var(--line); }
    .tab { padding:10px 18px; background:var(--bg); border:1px solid var(--line); border-bottom:none; border-radius:8px 8px 0 0; cursor:pointer; font-size:14px; }
    .tab.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .tab-content { display:none; padding:22px 28px; }
    .tab-content.active { display:block; }
    .two-col { display:grid; grid-template-columns:370px 1fr; gap:22px; }
    form,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    h2 { margin:0 0 12px; font-size:18px; } label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    textarea { min-height:70px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:var(--muted); }
    button.small { padding:6px 10px; font-size:12px; }
    .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; padding:3px 8px; border:1px solid var(--line); border-radius:999px; font-size:12px; }
    .done { color:var(--green); font-weight:700; }
    .material-list { display:grid; gap:10px; }
    .material-card { display:grid; gap:6px; }
    .stock-actions { display:flex; gap:8px; align-items:center; }
    .stock-actions input { width:90px; }
    .stock-actions button { padding:8px 10px; font-size:13px; }
    .stock-low { color:var(--orange); font-weight:700; }
    .material-select { margin:8px 0; padding:10px; background:var(--bg); border-radius:6px; }
    .material-select-item { display:flex; gap:8px; align-items:center; margin:6px 0; }
    .material-select-item input[type=checkbox] { width:auto; }
    .material-select-item input[type=number] { width:80px; }
    .mat-chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
    .mat-chip { background:var(--bg); border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:11px; color:var(--muted); }
    .client-detail { background:#fff; border:1px solid var(--line); border-radius:8px; padding:20px; }
    .client-detail h3 { margin:0 0 12px; font-size:18px; }
    .client-info-row { display:grid; grid-template-columns:80px 1fr; gap:6px 12px; margin:4px 0; font-size:14px; }
    .client-info-row .label { color:var(--muted); text-align:right; }
    .client-commission-list { margin-top:16px; }
    .client-commission-item { background:var(--bg); border-radius:6px; padding:10px 14px; margin:8px 0; }
    .client-select-area { margin:8px 0; padding:10px; background:var(--bg); border-radius:6px; }
    .client-new-fields { display:none; margin-top:8px; padding:10px; background:#fff; border:1px solid var(--line); border-radius:6px; }
    .client-new-fields.visible { display:block; }
    .client-new-fields label { margin:6px 0 3px; }
    .client-new-fields input { padding:7px; }
    .modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.6); display:none; align-items:center; justify-content:center; z-index:1000; }
    .modal-overlay.active { display:flex; }
    .modal { background:#fff; border-radius:12px; width:90%; max-width:900px; max-height:90vh; overflow:hidden; display:flex; flex-direction:column; }
    .modal-header { padding:18px 24px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; }
    .modal-header h3 { margin:0; font-size:20px; }
    .modal-close { background:none; border:0; font-size:28px; cursor:pointer; color:var(--muted); padding:0; line-height:1; }
    .modal-body { padding:20px 24px; overflow-y:auto; }
    .stage-tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin-bottom:20px; }
    .stage-tab { padding:10px 20px; background:var(--bg); border:1px solid var(--line); border-bottom:none; border-radius:8px 8px 0 0; cursor:pointer; font-size:14px; position:relative; }
    .stage-tab.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .stage-tab .count { display:inline-block; margin-left:8px; padding:1px 8px; background:rgba(0,0,0,0.1); border-radius:999px; font-size:12px; }
    .stage-tab.active .count { background:rgba(255,255,255,0.25); }
    .stage-content { display:none; }
    .stage-content.active { display:block; }
    .image-upload-area { border:2px dashed var(--line); border-radius:8px; padding:30px; text-align:center; cursor:pointer; transition:all 0.2s; margin-bottom:20px; }
    .image-upload-area:hover { border-color:var(--accent); background:var(--bg); }
    .image-upload-area.dragover { border-color:var(--accent); background:var(--bg); }
    .image-upload-area input { display:none; }
    .image-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; }
    .image-card { background:var(--bg); border:1px solid var(--line); border-radius:8px; overflow:hidden; position:relative; }
    .image-thumb { width:100%; height:140px; background:#eee; display:flex; align-items:center; justify-content:center; overflow:hidden; }
    .image-thumb img { width:100%; height:100%; object-fit:cover; }
    .image-card-body { padding:10px; }
    .image-card-body .filename { font-size:12px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-bottom:6px; }
    .image-card-body textarea { width:100%; padding:6px; border:1px solid var(--line); border-radius:4px; font-size:12px; min-height:50px; resize:vertical; }
    .image-card-body .date { font-size:11px; color:var(--muted); margin-top:6px; }
    .image-actions { position:absolute; top:6px; right:6px; display:flex; gap:4px; }
    .image-actions button { background:rgba(0,0,0,0.7); color:#fff; border:0; width:28px; height:28px; border-radius:4px; cursor:pointer; font-size:14px; padding:0; }
    .image-actions button:hover { background:var(--accent); }
    .empty-state { text-align:center; padding:40px 20px; color:var(--muted); }
    .empty-state .icon { font-size:48px; margin-bottom:12px; opacity:0.5; }
    .images-btn { margin-top:8px; background:var(--green); color:#fff; border:0; border-radius:6px; padding:8px 12px; font-size:13px; cursor:pointer; }
    .images-btn:hover { opacity:0.9; }
    .schedule-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; }
    .schedule-stats .stat.overdue strong { color:#c0392b; }
    .schedule-stats .stat.due-soon strong { color:#e67e22; }
    .schedule-stats .stat.on-track strong { color:var(--green); }
    .schedule-filter { display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap; align-items:center; }
    .schedule-filter select { width:auto; min-width:150px; }
    .schedule-filter .filter-label { color:var(--muted); font-size:13px; margin-right:4px; }
    .kanban { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
    .kanban-column { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px; min-height:200px; }
    .kanban-column-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding-bottom:8px; border-bottom:2px solid var(--line); }
    .kanban-column-header h3 { margin:0; font-size:15px; }
    .kanban-column.overdue .kanban-column-header { border-color:#c0392b; }
    .kanban-column.overdue .kanban-column-header h3 { color:#c0392b; }
    .kanban-column.due-soon .kanban-column-header { border-color:#e67e22; }
    .kanban-column.due-soon .kanban-column-header h3 { color:#e67e22; }
    .kanban-column.on-track .kanban-column-header { border-color:var(--green); }
    .kanban-column.on-track .kanban-column-header h3 { color:var(--green); }
    .kanban-count { background:#fff; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:700; }
    .kanban-card { background:#fff; border:1px solid var(--line); border-radius:6px; padding:12px; margin-bottom:10px; cursor:pointer; transition:all 0.2s; }
    .kanban-card:hover { box-shadow:0 2px 8px rgba(0,0,0,0.1); transform:translateY(-2px); }
    .kanban-card.expanded { border-color:var(--accent); box-shadow:0 2px 8px rgba(125,63,46,0.2); }
    .kanban-card-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; }
    .kanban-card-title { font-weight:700; font-size:14px; margin:0; }
    .kanban-card-badge { padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700; }
    .kanban-card-badge.overdue { background:#c0392b; color:#fff; }
    .kanban-card-badge.due-soon { background:#e67e22; color:#fff; }
    .kanban-card-badge.on-track { background:var(--green); color:#fff; }
    .kanban-card-meta { font-size:12px; color:var(--muted); margin:3px 0; }
    .kanban-card-status { display:inline-block; padding:2px 8px; background:var(--bg); border-radius:4px; font-size:12px; margin-top:4px; }
    .kanban-card-details { display:none; margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); }
    .kanban-card.expanded .kanban-card-details { display:block; }
    .kanban-card-details label { font-size:12px; margin:8px 0 4px; }
    .kanban-card-details input, .kanban-card-details select, .kanban-card-details textarea { font-size:13px; padding:6px; }
    .kanban-card-actions { display:flex; gap:6px; margin-top:10px; }
    .kanban-card-actions button { padding:6px 12px; font-size:12px; }
    .kanban-empty { text-align:center; padding:30px 10px; color:var(--muted); font-size:13px; }
    .owner-section { margin-bottom:20px; }
    .owner-header { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:var(--bg); border-radius:6px; margin-bottom:10px; }
    .owner-header h4 { margin:0; font-size:14px; }
    .owner-stats { display:flex; gap:12px; font-size:12px; }
    .owner-stats span { color:var(--muted); }
    .owner-stats .overdue { color:#c0392b; font-weight:700; }
    .owner-stats .due-soon { color:#e67e22; font-weight:700; }
    .owner-stats .on-track { color:var(--green); font-weight:700; }
    .schedule-view-toggle { display:flex; gap:4px; }
    .schedule-view-toggle button { padding:6px 12px; font-size:12px; background:var(--bg); border:1px solid var(--line); border-radius:6px; cursor:pointer; }
    .schedule-view-toggle button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .steps-progress { display:flex; gap:2px; margin-top:8px; flex-wrap:wrap; }
    .steps-progress .step-dot { width:20px; height:6px; border-radius:3px; background:var(--line); }
    .steps-progress .step-dot.done { background:var(--green); }
    .steps-progress .step-dot.current { background:var(--accent); }
    @media (max-width:900px){ .two-col{grid-template-columns:1fr;} header{padding:18px 16px;} .tabs{padding:12px 16px 0;} .tab-content{padding:16px;} .stats{grid-template-columns:1fr 1fr;} .image-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));} .kanban{grid-template-columns:1fr;} .schedule-stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header>
    <h1>皮影修复小作坊</h1>
    <div class="meta">委托、修复步骤、材料台账</div>
  </header>
  <div class="tabs">
    <div class="tab active" data-tab="commissions">修复委托</div>
    <div class="tab" data-tab="schedule">修复排期</div>
    <div class="tab" data-tab="clients">客户档案</div>
    <div class="tab" data-tab="materials">材料台账</div>
    <div class="tab" data-tab="templates">步骤模板</div>
  </div>

  <div class="tab-content active" id="tab-commissions">
    <div class="two-col">
      <form id="form">
        <h2>新增修复委托</h2>
        <label>委托人</label>
        <div class="client-select-area">
          <select id="clientSelect" name="clientId">
            <option value="">— 选择已有客户 —</option>
          </select>
          <div style="text-align:center;color:var(--muted);margin:6px 0;font-size:13px;">或录入新客户</div>
          <input id="newClientName" name="client" placeholder="客户名称">
          <div class="client-new-fields" id="clientNewFields">
            <label>联系人</label><input name="clientContact" placeholder="联系人姓名">
            <label>电话</label><input name="clientPhone" placeholder="联系电话">
            <label>地址</label><input name="clientAddress" placeholder="地址">
          </div>
        </div>
        <label>皮影角色名称</label><input name="roleName" required>
        <label>年代估计</label><input name="era" required>
        <label>破损部位</label><textarea name="damage" required></textarea>
        <label>缺失零件</label><input name="missingParts">
        <label>补色记录</label><textarea name="colorNotes"></textarea>
        <label>加固材料</label><input name="reinforcement">
        <label>选用材料</label>
        <div class="material-select" id="materialSelect"></div>
        <label>修复步骤模板</label>
        <select id="templateSelect" name="templateId">
          <option value="">— 标准流程（默认）—</option>
        </select>
        <div id="commissionStepsArea" style="margin-top:10px;padding:10px;background:var(--bg);border-radius:6px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span class="meta" style="font-size:12px;">当前步骤（可调整）</span>
            <button type="button" id="resetStepsBtn" class="small secondary">重置为模板</button>
          </div>
          <div id="commissionStepList"></div>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <input id="commissionNewStepInput" placeholder="添加自定义步骤" style="flex:1;padding:7px;font-size:13px;">
            <button type="button" id="commissionAddStepBtn" class="small secondary">添加</button>
          </div>
        </div>
        <label>负责人</label><input name="owner" required>
        <label>预计完成日期</label><input name="dueDate" type="date" required>
        <button type="submit">保存委托</button>
      </form>
      <section>
        <div class="stats" id="stats"></div>
        <div class="grid" id="list"></div>
      </section>
    </div>
  </div>

  <div class="tab-content" id="tab-schedule">
    <div class="schedule-stats" id="scheduleStats"></div>
    <div class="schedule-filter">
      <span class="filter-label">查看方式：</span>
      <div class="schedule-view-toggle">
        <button type="button" class="active" data-schedule-view="status">按状态</button>
        <button type="button" data-schedule-view="owner">按负责人</button>
      </div>
      <span class="filter-label" style="margin-left:10px;">负责人筛选：</span>
      <select id="ownerFilter">
        <option value="">全部负责人</option>
      </select>
      <button type="button" class="small secondary" id="refreshScheduleBtn" style="margin-left:auto;">🔄 刷新</button>
    </div>
    <div id="scheduleView"></div>
  </div>

  <div class="tab-content" id="tab-clients">
    <div class="two-col">
      <form id="clientForm">
        <h2>新增客户</h2>
        <label>客户名称</label><input name="name" required>
        <label>联系人</label><input name="contact" placeholder="联系人姓名">
        <label>电话</label><input name="phone" placeholder="联系电话">
        <label>地址</label><input name="address" placeholder="地址">
        <label>备注</label><textarea name="remark"></textarea>
        <button type="submit">保存客户</button>
      </form>
      <section>
        <div class="grid" id="clientList"></div>
        <div id="clientDetail" style="display:none;margin-top:22px;"></div>
      </section>
    </div>
  </div>

  <div class="tab-content" id="tab-materials">
    <div class="two-col">
      <form id="materialForm">
        <h2>新增材料</h2>
        <label>材料名称</label><input name="name" required>
        <label>类别</label>
        <select name="category">
          <option value="皮料">皮料</option>
          <option value="颜料">颜料</option>
          <option value="胶料">胶料</option>
          <option value="工具">工具</option>
          <option value="其他">其他</option>
        </select>
        <label>批次号</label><input name="batch">
        <label>库存数量</label><input name="stock" type="number" min="0" value="0">
        <label>单位</label><input name="unit" placeholder="如：张、克、个" value="个">
        <label>备注</label><textarea name="remark"></textarea>
        <button type="submit">添加材料</button>
      </form>
      <section>
        <h2 style="margin-bottom:12px;">材料库存</h2>
        <div class="material-list" id="materialList"></div>
      </section>
    </div>
  </div>

  <div class="tab-content" id="tab-templates">
    <div class="two-col">
      <form id="templateForm">
        <h2>新增步骤模板</h2>
        <label>模板名称</label><input name="name" required placeholder="如：武生靠旗">
        <label>模板说明</label><textarea name="description" placeholder="简要描述适用场景"></textarea>
        <label>修复步骤（按顺序）</label>
        <div id="templateStepList" style="margin-bottom:10px;"></div>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <input id="newStepInput" placeholder="输入步骤名称" style="flex:1;">
          <button type="button" id="addStepBtn" class="small secondary">添加步骤</button>
        </div>
        <button type="submit">保存模板</button>
      </form>
      <section>
        <h2 style="margin-bottom:12px;">模板列表</h2>
        <div class="grid" id="templateList"></div>
        <div id="templateEditor" style="display:none;margin-top:22px;">
          <div class="client-detail">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <h3 id="editTplTitle">编辑模板</h3>
              <button class="small secondary" id="cancelEditTplBtn">返回列表</button>
            </div>
            <label>模板名称</label><input id="editTplName">
            <label>模板说明</label><textarea id="editTplDesc"></textarea>
            <label>修复步骤</label>
            <div id="editTplSteps" style="margin-bottom:10px;"></div>
            <div style="display:flex;gap:6px;margin-bottom:10px;">
              <input id="editNewStepInput" placeholder="输入步骤名称" style="flex:1;">
              <button type="button" id="editAddStepBtn" class="small secondary">添加步骤</button>
            </div>
            <div style="display:flex;gap:8px;">
              <button id="saveTplBtn">保存修改</button>
              <button class="secondary" id="deleteTplBtn">删除模板</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>

  <div class="modal-overlay" id="imagesModal">
    <div class="modal">
      <div class="modal-header">
        <h3 id="modalTitle">影像档案</h3>
        <button class="modal-close" id="modalClose">&times;</button>
      </div>
      <div class="modal-body">
        <div class="stage-tabs" id="stageTabs">
          <div class="stage-tab active" data-stage="before">修复前 <span class="count" id="count-before">0</span></div>
          <div class="stage-tab" data-stage="during">修复中 <span class="count" id="count-during">0</span></div>
          <div class="stage-tab" data-stage="after">修复后 <span class="count" id="count-after">0</span></div>
        </div>
        <div class="stage-content active" id="stage-before">
          <div class="image-upload-area" data-upload="before">
            <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple>
            <div>📷 点击或拖拽上传修复前的图片</div>
            <div class="meta" style="margin-top:6px;">支持 JPG、PNG、GIF、WebP，单张最大 10MB</div>
          </div>
          <div class="image-grid" id="grid-before"></div>
        </div>
        <div class="stage-content" id="stage-during">
          <div class="image-upload-area" data-upload="during">
            <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple>
            <div>📷 点击或拖拽上传修复中的图片</div>
            <div class="meta" style="margin-top:6px;">支持 JPG、PNG、GIF、WebP，单张最大 10MB</div>
          </div>
          <div class="image-grid" id="grid-during"></div>
        </div>
        <div class="stage-content" id="stage-after">
          <div class="image-upload-area" data-upload="after">
            <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple>
            <div>📷 点击或拖拽上传修复后的图片</div>
            <div class="meta" style="margin-top:6px;">支持 JPG、PNG、GIF、WebP，单张最大 10MB</div>
          </div>
          <div class="image-grid" id="grid-after"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const defaultSteps = ${JSON.stringify(defaultSteps)};
    let commissions = [];
    let materials = [];
    let clients = [];
    let stepTemplates = [];
    let currentTab = "commissions";
    let selectedClientId = null;
    let currentCommissionSteps = [...defaultSteps];
    let editingTemplateId = null;
    let editingTemplateSteps = [];
    let newTemplateSteps = ["接收", "清洁", "补片", "补色", "交付"];

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }

    document.querySelectorAll(".tab").forEach(tab => {
      tab.onclick = async () => {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
        currentTab = tab.dataset.tab;
        if (currentTab === "schedule" && !scheduleData) {
          await loadSchedule();
        }
      };
    });

    document.querySelectorAll("[data-schedule-view]").forEach(btn => {
      btn.onclick = () => {
        scheduleView = btn.dataset.scheduleView;
        localStorage.setItem("scheduleView", scheduleView);
        renderSchedule();
      };
    });

    const ownerFilterSelect = document.getElementById("ownerFilter");
    if (ownerFilterSelect) {
      ownerFilterSelect.onchange = () => {
        scheduleOwnerFilter = ownerFilterSelect.value;
        localStorage.setItem("scheduleOwnerFilter", scheduleOwnerFilter);
        renderSchedule();
      };
    }

    const refreshScheduleBtn = document.getElementById("refreshScheduleBtn");
    if (refreshScheduleBtn) {
      refreshScheduleBtn.onclick = async () => {
        await loadSchedule();
        await loadAll();
      };
    }

    function renderCommissions() {
      const stats = document.querySelector("#stats");
      const list = document.querySelector("#list");
      const stepCounts = {};
      for (const c of commissions) {
        (c.steps || defaultSteps).forEach(s => { if (!stepCounts[s]) stepCounts[s] = 0; });
        if (!stepCounts[c.status]) stepCounts[c.status] = 0;
      }
      const allSteps = Object.keys(stepCounts);
      stats.innerHTML = allSteps.map(step => '<div class="stat"><span>'+step+'</span><strong>'+commissions.filter(c => c.status === step).length+'</strong></div>').join("");
      list.innerHTML = commissions.map(c => {
        const cSteps = c.steps || defaultSteps;
        const matChips = (c.materials && c.materials.length) ? c.materials.map(m => '<span class="mat-chip">'+m.name+' ×'+m.quantity+(m.batch?' ('+m.batch+')':'')+'</span>').join("") : '';
        const tplBadge = c.templateName ? '<span class="pill" style="margin-left:6px;background:var(--bg);">'+c.templateName+'</span>' : '';
        const imgCounts = c.images ? {
          before: c.images.before?.length || 0,
          during: c.images.during?.length || 0,
          after: c.images.after?.length || 0
        } : { before:0, during:0, after:0 };
        const totalImgs = imgCounts.before + imgCounts.during + imgCounts.after;
        return '<article class="card"><h3 style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;">'+c.roleName+tplBadge+'</h3><span class="pill">'+c.status+'</span><div class="meta">'+c.client+' · '+c.era+' · '+c.owner+'</div><div><b>破损</b> '+c.damage+'</div>'+(c.reinforcement?'<div><b>加固</b> '+c.reinforcement+'</div>':'')+(matChips?'<div><b>用料</b></div><div class="mat-chips">'+matChips+'</div>':'')+'<label>更新步骤</label><select data-step="'+c.id+'">'+cSteps.map(s => '<option>'+s+'</option>').join("")+'</select><input data-note="'+c.id+'" placeholder="步骤备注"><button data-save="'+c.id+'">保存步骤</button><button class="images-btn" data-images="'+c.id+'">📷 影像档案 ('+totalImgs+')</button><div class="meta">'+(c.records||[]).map(r => r.step+"："+r.note).join(" / ")+'</div></article>';
      }).join("");
      document.querySelectorAll("[data-step]").forEach(sel => sel.value = commissions.find(c => c.id === sel.dataset.step).status);
      document.querySelectorAll("[data-save]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.save;
        await api('/api/commissions/'+id+'/records', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+id+'"]').value, note: document.querySelector('[data-note="'+id+'"]').value || "步骤完成" }) });
        await loadAll();
      });
      document.querySelectorAll("[data-images]").forEach(btn => btn.onclick = () => {
        const id = btn.dataset.images;
        openImagesModal(id);
      });
    }

    function renderClientSelect() {
      const select = document.getElementById("clientSelect");
      const currentVal = select.value;
      select.innerHTML = '<option value="">— 选择已有客户 —</option>' + clients.map(c => '<option value="'+c.id+'">'+c.name+(c.contact?' ('+c.contact+')':'')+'</option>').join("");
      if (currentVal) select.value = currentVal;
      const nameInput = document.getElementById("newClientName");
      const newFields = document.getElementById("clientNewFields");
      select.onchange = () => {
        if (select.value) {
          nameInput.value = "";
          nameInput.removeAttribute("required");
          newFields.classList.remove("visible");
        } else {
          nameInput.setAttribute("required", "required");
        }
      };
      nameInput.oninput = () => {
        if (nameInput.value.trim()) {
          newFields.classList.add("visible");
        } else {
          newFields.classList.remove("visible");
        }
      };
    }

    function renderClients() {
      const list = document.getElementById("clientList");
      if (!clients.length) {
        list.innerHTML = '<div class="card meta">暂无客户档案</div>';
        return;
      }
      list.innerHTML = clients.map(c => {
        return '<div class="card" style="cursor:pointer;" data-client-id="'+c.id+'">' +
          '<h3 style="margin:0;font-size:16px;">'+c.name+'</h3>' +
          (c.contact ? '<div class="meta">联系人：'+c.contact+'</div>' : '') +
          (c.phone ? '<div class="meta">电话：'+c.phone+'</div>' : '') +
          '<div class="meta">历史委托：<strong>'+c.commissionCount+'</strong> 条</div>' +
          '</div>';
      }).join("");
      document.querySelectorAll("[data-client-id]").forEach(card => card.onclick = async () => {
        selectedClientId = card.dataset.clientId;
        await renderClientDetail(selectedClientId);
      });
    }

    async function renderClientDetail(id) {
      const detail = document.getElementById("clientDetail");
      try {
        const client = await api("/api/clients/" + id);
        detail.style.display = "block";
        detail.innerHTML = '<div class="client-detail">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<h3>'+client.name+'</h3>' +
          '<button class="small secondary" id="editClientBtn">编辑</button>' +
          '</div>' +
          '<div class="client-info-row"><span class="label">联系人</span><span>'+(client.contact||'—')+'</span></div>' +
          '<div class="client-info-row"><span class="label">电话</span><span>'+(client.phone||'—')+'</span></div>' +
          '<div class="client-info-row"><span class="label">地址</span><span>'+(client.address||'—')+'</span></div>' +
          '<div class="client-info-row"><span class="label">备注</span><span>'+(client.remark||'—')+'</span></div>' +
          '<div class="client-info-row"><span class="label">委托数</span><span><strong>'+client.commissionCount+'</strong> 条</span></div>' +
          '<div class="client-commission-list">' +
          '<h4 style="margin:12px 0 8px;">关联修复记录</h4>' +
          (client.commissions && client.commissions.length ? client.commissions.map(c =>
            '<div class="client-commission-item">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<strong>'+c.roleName+'</strong>' +
            '<span class="pill">'+c.status+'</span>' +
            '</div>' +
            '<div class="meta">'+c.era+' · 负责人：'+c.owner+' · 截止：'+c.dueDate+'</div>' +
            '<div class="meta">破损：'+c.damage+'</div>' +
            (c.records && c.records.length ? '<div class="meta" style="margin-top:4px;">'+c.records.map(r=>r.step+'：'+r.note).join(' → ')+'</div>' : '') +
            '</div>'
          ).join("") : '<div class="meta">暂无关联修复记录</div>') +
          '</div>' +
          '<div id="editClientForm" style="display:none;margin-top:16px;padding:16px;background:var(--bg);border-radius:6px;">' +
          '<h4>编辑客户信息</h4>' +
          '<label>名称</label><input id="editName" value="'+client.name+'">' +
          '<label>联系人</label><input id="editContact" value="'+(client.contact||'')+'">' +
          '<label>电话</label><input id="editPhone" value="'+(client.phone||'')+'">' +
          '<label>地址</label><input id="editAddress" value="'+(client.address||'')+'">' +
          '<label>备注</label><textarea id="editRemark">'+(client.remark||'')+'</textarea>' +
          '<div style="display:flex;gap:8px;margin-top:10px;">' +
          '<button id="saveClientBtn">保存修改</button>' +
          '<button class="secondary" id="cancelEditBtn">取消</button>' +
          '</div>' +
          '</div>' +
          '</div>';
        document.getElementById("editClientBtn").onclick = () => {
          document.getElementById("editClientForm").style.display = "block";
        };
        document.getElementById("cancelEditBtn").onclick = () => {
          document.getElementById("editClientForm").style.display = "none";
        };
        document.getElementById("saveClientBtn").onclick = async () => {
          await api("/api/clients/" + id, {
            method: "PUT",
            body: JSON.stringify({
              name: document.getElementById("editName").value,
              contact: document.getElementById("editContact").value,
              phone: document.getElementById("editPhone").value,
              address: document.getElementById("editAddress").value,
              remark: document.getElementById("editRemark").value
            })
          });
          await loadAll();
          await renderClientDetail(id);
        };
      } catch (e) {
        alert(e.message);
      }
    }

    function renderMaterialSelect() {
      const container = document.getElementById("materialSelect");
      if (!materials.length) {
        container.innerHTML = '<div class="meta">暂无材料，请先在材料台账中添加</div>';
        return;
      }
      container.innerHTML = materials.map(m => {
        const lowStock = m.stock <= 10;
        return '<div class="material-select-item">' +
          '<input type="checkbox" id="mat_'+m.id+'" value="'+m.id+'" data-unit="'+m.unit+'" data-name="'+m.name+'">' +
          '<label for="mat_'+m.id+'" style="margin:0;flex:1;">'+m.name+' <span class="meta">('+m.batch+')</span></label>' +
          '<input type="number" min="0" step="1" value="0" data-qty="'+m.id+'" style="width:70px;">' +
          '<span class="meta" style="font-size:12px;">'+m.unit+'</span>' +
          '<span class="meta" style="font-size:11px;'+(lowStock?'color:var(--orange);font-weight:700;':'')+'">库存 '+m.stock+'</span>' +
          '</div>';
      }).join("");
    }

    function renderMaterials() {
      const list = document.getElementById("materialList");
      if (!materials.length) {
        list.innerHTML = '<div class="card meta">暂无材料</div>';
        return;
      }
      list.innerHTML = materials.map(m => {
        const lowStock = m.stock <= 10;
        return '<div class="card material-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<h3 style="margin:0;font-size:16px;">'+m.name+'</h3>' +
          '<span class="pill">'+m.category+'</span>' +
          '</div>' +
          '<div class="meta">批次：'+m.batch+'</div>' +
          '<div class="meta">单位：'+m.unit+'</div>' +
          '<div>库存：<span '+(lowStock?'class="stock-low"':'')+'>'+m.stock+' '+m.unit+'</span></div>' +
          (m.remark ? '<div class="meta">备注：'+m.remark+'</div>' : '') +
          '<div class="stock-actions">' +
          '<input type="number" id="stock_'+m.id+'" placeholder="数量" value="1">' +
          '<button class="small" data-stock-add="'+m.id+'">入库</button>' +
          '<button class="small secondary" data-stock-sub="'+m.id+'">出库</button>' +
          '</div>' +
          '</div>';
      }).join("");
      document.querySelectorAll("[data-stock-add]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.stockAdd;
        const val = Number(document.getElementById("stock_"+id).value) || 0;
        if (val <= 0) return alert("请输入正数");
        await api("/api/materials/"+id+"/stock", { method:"POST", body: JSON.stringify({ change: val }) });
        await loadAll();
      });
      document.querySelectorAll("[data-stock-sub]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.stockSub;
        const val = Number(document.getElementById("stock_"+id).value) || 0;
        if (val <= 0) return alert("请输入正数");
        await api("/api/materials/"+id+"/stock", { method:"POST", body: JSON.stringify({ change: -val }) });
        await loadAll();
      });
    }

    function renderTemplateSelect() {
      const select = document.getElementById("templateSelect");
      if (!select) return;
      const currentVal = select.value;
      select.innerHTML = '<option value="">— 标准流程（默认）—</option>' + stepTemplates.map(t => '<option value="'+t.id+'">'+t.name+'</option>').join("");
      if (currentVal) select.value = currentVal;
    }

    function renderCommissionStepList() {
      const container = document.getElementById("commissionStepList");
      if (!container) return;
      container.innerHTML = currentCommissionSteps.map((s, i) => {
        return '<div style="display:flex;gap:6px;align-items:center;margin:4px 0;">' +
          '<span class="meta" style="width:20px;text-align:right;">'+(i+1)+'.</span>' +
          '<input data-cstep="'+i+'" value="'+s+'" style="flex:1;padding:6px;font-size:13px;">' +
          '<button type="button" data-cstep-up="'+i+'" class="small secondary" style="padding:4px 8px;">↑</button>' +
          '<button type="button" data-cstep-down="'+i+'" class="small secondary" style="padding:4px 8px;">↓</button>' +
          '<button type="button" data-cstep-del="'+i+'" class="small secondary" style="padding:4px 8px;">×</button>' +
          '</div>';
      }).join("");
      container.querySelectorAll("[data-cstep]").forEach(inp => inp.oninput = e => {
        const idx = Number(inp.dataset.cstep);
        currentCommissionSteps[idx] = e.target.value;
      });
      container.querySelectorAll("[data-cstep-up]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.cstepUp);
        if (idx > 0) {
          [currentCommissionSteps[idx-1], currentCommissionSteps[idx]] = [currentCommissionSteps[idx], currentCommissionSteps[idx-1]];
          renderCommissionStepList();
        }
      });
      container.querySelectorAll("[data-cstep-down]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.cstepDown);
        if (idx < currentCommissionSteps.length - 1) {
          [currentCommissionSteps[idx+1], currentCommissionSteps[idx]] = [currentCommissionSteps[idx], currentCommissionSteps[idx+1]];
          renderCommissionStepList();
        }
      });
      container.querySelectorAll("[data-cstep-del]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.cstepDel);
        if (currentCommissionSteps.length > 1) {
          currentCommissionSteps.splice(idx, 1);
          renderCommissionStepList();
        }
      });
    }

    function renderTemplateStepList() {
      const container = document.getElementById("templateStepList");
      if (!container) return;
      container.innerHTML = newTemplateSteps.map((s, i) => {
        return '<div style="display:flex;gap:6px;align-items:center;margin:4px 0;">' +
          '<span class="meta" style="width:20px;text-align:right;">'+(i+1)+'.</span>' +
          '<input data-nstep="'+i+'" value="'+s+'" style="flex:1;padding:6px;font-size:13px;">' +
          '<button type="button" data-nstep-up="'+i+'" class="small secondary" style="padding:4px 8px;">↑</button>' +
          '<button type="button" data-nstep-down="'+i+'" class="small secondary" style="padding:4px 8px;">↓</button>' +
          '<button type="button" data-nstep-del="'+i+'" class="small secondary" style="padding:4px 8px;">×</button>' +
          '</div>';
      }).join("");
      container.querySelectorAll("[data-nstep]").forEach(inp => inp.oninput = e => {
        const idx = Number(inp.dataset.nstep);
        newTemplateSteps[idx] = e.target.value;
      });
      container.querySelectorAll("[data-nstep-up]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.nstepUp);
        if (idx > 0) {
          [newTemplateSteps[idx-1], newTemplateSteps[idx]] = [newTemplateSteps[idx], newTemplateSteps[idx-1]];
          renderTemplateStepList();
        }
      });
      container.querySelectorAll("[data-nstep-down]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.nstepDown);
        if (idx < newTemplateSteps.length - 1) {
          [newTemplateSteps[idx+1], newTemplateSteps[idx]] = [newTemplateSteps[idx], newTemplateSteps[idx+1]];
          renderTemplateStepList();
        }
      });
      container.querySelectorAll("[data-nstep-del]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.nstepDel);
        if (newTemplateSteps.length > 1) {
          newTemplateSteps.splice(idx, 1);
          renderTemplateStepList();
        }
      });
    }

    function renderTemplates() {
      const list = document.getElementById("templateList");
      if (!list) return;
      if (!stepTemplates.length) {
        list.innerHTML = '<div class="card meta">暂无模板</div>';
        return;
      }
      list.innerHTML = stepTemplates.map(t => {
        const isDefault = t.id === "TPL-DEFAULT";
        return '<div class="card" data-tpl-id="'+t.id+'" style="cursor:pointer;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<h3 style="margin:0;font-size:16px;">'+t.name+'</h3>' +
          (isDefault ? '<span class="pill" style="background:var(--green);color:#fff;">默认</span>' : '') +
          '</div>' +
          (t.description ? '<div class="meta">'+t.description+'</div>' : '') +
          '<div class="meta">共 '+t.steps.length+' 个步骤</div>' +
          '<div class="meta" style="font-size:12px;">'+t.steps.join(' → ')+'</div>' +
          '</div>';
      }).join("");
      list.querySelectorAll("[data-tpl-id]").forEach(card => card.onclick = () => {
        openTemplateEditor(card.dataset.tplId);
      });
    }

    function openTemplateEditor(id) {
      const tpl = stepTemplates.find(t => t.id === id);
      if (!tpl) return;
      editingTemplateId = id;
      editingTemplateSteps = [...tpl.steps];
      document.getElementById("templateEditor").style.display = "block";
      document.getElementById("editTplTitle").textContent = "编辑模板：" + tpl.name;
      document.getElementById("editTplName").value = tpl.name;
      document.getElementById("editTplDesc").value = tpl.description || "";
      renderEditTplSteps();
      const delBtn = document.getElementById("deleteTplBtn");
      if (id === "TPL-DEFAULT") {
        delBtn.style.display = "none";
      } else {
        delBtn.style.display = "inline-block";
      }
    }

    function renderEditTplSteps() {
      const container = document.getElementById("editTplSteps");
      if (!container) return;
      container.innerHTML = editingTemplateSteps.map((s, i) => {
        return '<div style="display:flex;gap:6px;align-items:center;margin:4px 0;">' +
          '<span class="meta" style="width:20px;text-align:right;">'+(i+1)+'.</span>' +
          '<input data-etpl-step="'+i+'" value="'+s+'" style="flex:1;padding:6px;font-size:13px;">' +
          '<button type="button" data-etpl-up="'+i+'" class="small secondary" style="padding:4px 8px;">↑</button>' +
          '<button type="button" data-etpl-down="'+i+'" class="small secondary" style="padding:4px 8px;">↓</button>' +
          '<button type="button" data-etpl-del="'+i+'" class="small secondary" style="padding:4px 8px;">'+(editingTemplateId === "TPL-DEFAULT" && editingTemplateSteps.length <= 2 ? '' : '×')+'</button>' +
          '</div>';
      }).join("");
      container.querySelectorAll("[data-etpl-step]").forEach(inp => inp.oninput = e => {
        const idx = Number(inp.dataset.etplStep);
        editingTemplateSteps[idx] = e.target.value;
      });
      container.querySelectorAll("[data-etpl-up]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.etplUp);
        if (idx > 0) {
          [editingTemplateSteps[idx-1], editingTemplateSteps[idx]] = [editingTemplateSteps[idx], editingTemplateSteps[idx-1]];
          renderEditTplSteps();
        }
      });
      container.querySelectorAll("[data-etpl-down]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.etplDown);
        if (idx < editingTemplateSteps.length - 1) {
          [editingTemplateSteps[idx+1], editingTemplateSteps[idx]] = [editingTemplateSteps[idx], editingTemplateSteps[idx+1]];
          renderEditTplSteps();
        }
      });
      container.querySelectorAll("[data-etpl-del]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.etplDel);
        if (editingTemplateSteps.length > 1) {
          editingTemplateSteps.splice(idx, 1);
          renderEditTplSteps();
        }
      });
    }

    function getDaysUntilDue(dueDateStr) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const due = new Date(dueDateStr);
      due.setHours(0, 0, 0, 0);
      const diffTime = due - today;
      return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }

    function getStatusBadgeText(category) {
      switch(category) {
        case "overdue": return "逾期";
        case "dueSoon": return "即将到期";
        case "onTrack": return "正常推进";
        default: return "正常";
      }
    }

    function renderStepsProgress(steps, currentStatus) {
      const currentIdx = steps.indexOf(currentStatus);
      return '<div class="steps-progress">' + steps.map((s, i) => {
        let cls = "step-dot";
        if (i < currentIdx) cls += " done";
        else if (i === currentIdx) cls += " current";
        return '<div class="' + cls + '" title="' + s + '"></div>';
      }).join("") + '</div>';
    }

    function renderKanbanCard(item) {
      const days = getDaysUntilDue(item.dueDate);
      const daysText = days < 0 ? "逾期 " + Math.abs(days) + " 天" : days === 0 ? "今天到期" : "还剩 " + days + " 天";
      const isExpanded = expandedScheduleCards.includes(item.id);
      
      return '<div class="kanban-card ' + (isExpanded ? 'expanded' : '') + '" data-schedule-id="' + item.id + '">' +
        '<div class="kanban-card-header">' +
          '<h4 class="kanban-card-title">' + item.roleName + '</h4>' +
          '<span class="kanban-card-badge ' + item.statusCategory + '">' + getStatusBadgeText(item.statusCategory) + '</span>' +
        '</div>' +
        '<div class="kanban-card-meta">' + item.client + ' · ' + item.era + '</div>' +
        '<div class="kanban-card-meta">负责人：' + item.owner + '</div>' +
        '<div class="kanban-card-meta">截止：' + item.dueDate + ' (' + daysText + ')</div>' +
        '<span class="kanban-card-status">当前：' + item.status + '</span>' +
        renderStepsProgress(item.steps, item.status) +
        (item.latestNote ? '<div class="kanban-card-meta" style="margin-top:6px;">备注：' + item.latestNote + '</div>' : '') +
        '<div class="kanban-card-details">' +
          '<label>更新步骤</label>' +
          '<select data-schedule-step="' + item.id + '">' + 
            item.steps.map(s => '<option value="' + s + '"' + (s === item.status ? ' selected' : '') + '>' + s + '</option>').join("") + 
          '</select>' +
          '<label>更新备注</label>' +
          '<textarea data-schedule-note="' + item.id + '" placeholder="输入当前步骤的工作备注...">' + (item.latestNote || "") + '</textarea>' +
          '<label>调整负责人</label>' +
          '<input type="text" data-schedule-owner="' + item.id + '" value="' + item.owner + '">' +
          '<label>调整截止日期</label>' +
          '<input type="date" data-schedule-duedate="' + item.id + '" value="' + item.dueDate + '">' +
          '<div class="kanban-card-actions">' +
            '<button type="button" data-schedule-save="' + item.id + '">保存更新</button>' +
            '<button type="button" class="secondary" data-schedule-cancel="' + item.id + '">取消</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function renderScheduleByStatus(data, ownerFilter) {
      let overdue = data.overdue;
      let dueSoon = data.dueSoon;
      let onTrack = data.onTrack;

      if (ownerFilter) {
        overdue = overdue.filter(i => i.owner === ownerFilter);
        dueSoon = dueSoon.filter(i => i.owner === ownerFilter);
        onTrack = onTrack.filter(i => i.owner === ownerFilter);
      }

      return '<div class="kanban">' +
        '<div class="kanban-column overdue">' +
          '<div class="kanban-column-header">' +
            '<h3>⚠️ 逾期</h3>' +
            '<span class="kanban-count">' + overdue.length + '</span>' +
          '</div>' +
          (overdue.length ? overdue.map(renderKanbanCard).join("") : '<div class="kanban-empty">暂无逾期任务</div>') +
        '</div>' +
        '<div class="kanban-column due-soon">' +
          '<div class="kanban-column-header">' +
            '<h3>⏰ 三天内到期</h3>' +
            '<span class="kanban-count">' + dueSoon.length + '</span>' +
          '</div>' +
          (dueSoon.length ? dueSoon.map(renderKanbanCard).join("") : '<div class="kanban-empty">暂无即将到期任务</div>') +
        '</div>' +
        '<div class="kanban-column on-track">' +
          '<div class="kanban-column-header">' +
            '<h3>✅ 正常推进</h3>' +
            '<span class="kanban-count">' + onTrack.length + '</span>' +
          '</div>' +
          (onTrack.length ? onTrack.map(renderKanbanCard).join("") : '<div class="kanban-empty">暂无正常推进任务</div>') +
        '</div>' +
      '</div>';
    }

    function renderScheduleByOwner(data, ownerFilter) {
      let owners = Object.keys(data.byOwner);
      if (ownerFilter) {
        owners = owners.filter(o => o === ownerFilter);
      }
      owners.sort();

      if (!owners.length) {
        return '<div class="kanban-empty" style="padding:60px 20px;">暂无排期数据</div>';
      }

      return owners.map(owner => {
        const ownerData = data.byOwner[owner];
        const stats = data.stats.byOwner[owner];
        return '<div class="owner-section">' +
          '<div class="owner-header">' +
            '<h4>👤 ' + owner + '</h4>' +
            '<div class="owner-stats">' +
              '<span>共 <strong>' + stats.total + '</strong> 项</span>' +
              '<span class="overdue">逾期 ' + stats.overdue + '</span>' +
              '<span class="due-soon">即将到期 ' + stats.dueSoon + '</span>' +
              '<span class="on-track">正常 ' + stats.onTrack + '</span>' +
            '</div>' +
          '</div>' +
          renderScheduleByStatus({
            overdue: ownerData.overdue,
            dueSoon: ownerData.dueSoon,
            onTrack: ownerData.onTrack
          }, null) +
        '</div>';
      }).join("");
    }

    function renderScheduleStats(data) {
      const stats = data.stats;
      return '<div class="stat"><span>进行中委托</span><strong>' + stats.total + '</strong></div>' +
        '<div class="stat overdue"><span>逾期</span><strong>' + stats.overdue + '</strong></div>' +
        '<div class="stat due-soon"><span>三天内到期</span><strong>' + stats.dueSoon + '</strong></div>' +
        '<div class="stat on-track"><span>正常推进</span><strong>' + stats.onTrack + '</strong></div>';
    }

    function renderOwnerFilter(data) {
      const select = document.getElementById("ownerFilter");
      if (!select) return;
      const owners = Object.keys(data.byOwner).sort();
      select.innerHTML = '<option value="">全部负责人</option>' + 
        owners.map(o => '<option value="' + o + '"' + (o === scheduleOwnerFilter ? ' selected' : '') + '>' + o + '</option>').join("");
    }

    function renderSchedule() {
      if (!scheduleData) return;

      const statsEl = document.getElementById("scheduleStats");
      const viewEl = document.getElementById("scheduleView");
      
      if (statsEl) statsEl.innerHTML = renderScheduleStats(scheduleData);
      
      renderOwnerFilter(scheduleData);

      if (viewEl) {
        if (scheduleView === "status") {
          viewEl.innerHTML = renderScheduleByStatus(scheduleData, scheduleOwnerFilter);
        } else {
          viewEl.innerHTML = renderScheduleByOwner(scheduleData, scheduleOwnerFilter);
        }
      }

      document.querySelectorAll("[data-schedule-view]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.scheduleView === scheduleView);
      });

      bindScheduleEvents();
    }

    async function loadSchedule() {
      try {
        scheduleData = await api("/api/schedule");
        renderSchedule();
      } catch (e) {
        console.error("加载排期数据失败:", e);
      }
    }

    function bindScheduleEvents() {
      document.querySelectorAll("[data-schedule-id]").forEach(card => {
        card.onclick = (e) => {
          if (e.target.closest(".kanban-card-details") || e.target.tagName === "BUTTON" || e.target.tagName === "SELECT" || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
            return;
          }
          const id = card.dataset.scheduleId;
          if (expandedScheduleCards.includes(id)) {
            expandedScheduleCards = expandedScheduleCards.filter(i => i !== id);
          } else {
            expandedScheduleCards.push(id);
          }
          localStorage.setItem("expandedScheduleCards", JSON.stringify(expandedScheduleCards));
          card.classList.toggle("expanded");
        };
      });

      document.querySelectorAll("[data-schedule-save]").forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const id = btn.dataset.scheduleSave;
          const step = document.querySelector('[data-schedule-step="' + id + '"]').value;
          const note = document.querySelector('[data-schedule-note="' + id + '"]').value.trim();
          const owner = document.querySelector('[data-schedule-owner="' + id + '"]').value.trim();
          const dueDate = document.querySelector('[data-schedule-duedate="' + id + '"]').value;

          if (!owner) return alert("负责人不能为空");
          if (!dueDate) return alert("截止日期不能为空");

          try {
            await api('/api/commissions/' + id + '/schedule', { 
              method:'PUT', 
              body: JSON.stringify({ status: step, note: note || "步骤更新", owner, dueDate }) 
            });
            await Promise.all([loadSchedule(), loadAll()]);
          } catch (e) {
            alert(e.message);
          }
        };
      });

      document.querySelectorAll("[data-schedule-cancel]").forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const id = btn.dataset.scheduleCancel;
          expandedScheduleCards = expandedScheduleCards.filter(i => i !== id);
          localStorage.setItem("expandedScheduleCards", JSON.stringify(expandedScheduleCards));
          const card = document.querySelector('[data-schedule-id="' + id + '"]');
          if (card) card.classList.remove("expanded");
        };
      });
    }

    function render() {
      renderCommissions();
      renderClientSelect();
      renderClients();
      renderMaterialSelect();
      renderMaterials();
      renderTemplateSelect();
      renderCommissionStepList();
      renderTemplates();
      renderTemplateStepList();
      if (scheduleData) renderSchedule();
    }

    async function loadAll() {
      const [c, cl, m, t] = await Promise.all([api("/api/commissions"), api("/api/clients"), api("/api/materials"), api("/api/step-templates")]);
      commissions = c;
      clients = cl;
      materials = m;
      stepTemplates = t;
      if (currentTab === "schedule") {
        await loadSchedule();
      }
      render();
    }

    document.querySelector("#form").onsubmit = async event => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const data = Object.fromEntries(formData.entries());
      const clientSelect = document.getElementById("clientSelect");
      const newClientName = document.getElementById("newClientName");
      if (clientSelect.value) {
        data.clientId = clientSelect.value;
        delete data.client;
      } else if (newClientName.value.trim()) {
        data.client = newClientName.value.trim();
      } else {
        return alert("请选择已有客户或输入新客户名称");
      }
      const selectedMats = [];
      document.querySelectorAll('.material-select-item input[type="checkbox"]:checked').forEach(cb => {
        const qtyInput = document.querySelector('[data-qty="'+cb.value+'"]');
        const qty = Number(qtyInput?.value) || 0;
        if (qty > 0) {
          selectedMats.push({ id: cb.value, quantity: qty });
        }
      });
      data.materials = selectedMats;
      data.steps = currentCommissionSteps.filter(s => s.trim());
      if (!data.steps.length) return alert("至少需要一个步骤");
      try {
        await api("/api/commissions", { method:"POST", body: JSON.stringify(data) });
        event.target.reset();
        document.getElementById("clientNewFields").classList.remove("visible");
        currentCommissionSteps = [...defaultSteps];
        renderCommissionStepList();
        await loadAll();
      } catch (e) {
        alert(e.message);
      }
    };

    const templateSelect = document.getElementById("templateSelect");
    if (templateSelect) {
      templateSelect.onchange = () => {
        const tplId = templateSelect.value;
        if (tplId) {
          const tpl = stepTemplates.find(t => t.id === tplId);
          if (tpl) {
            currentCommissionSteps = [...tpl.steps];
            renderCommissionStepList();
          }
        } else {
          currentCommissionSteps = [...defaultSteps];
          renderCommissionStepList();
        }
      };
    }

    const resetStepsBtn = document.getElementById("resetStepsBtn");
    if (resetStepsBtn) {
      resetStepsBtn.onclick = () => {
        const tplId = document.getElementById("templateSelect")?.value;
        if (tplId) {
          const tpl = stepTemplates.find(t => t.id === tplId);
          if (tpl) {
            currentCommissionSteps = [...tpl.steps];
            renderCommissionStepList();
          }
        } else {
          currentCommissionSteps = [...defaultSteps];
          renderCommissionStepList();
        }
      };
    }

    const commissionAddStepBtn = document.getElementById("commissionAddStepBtn");
    if (commissionAddStepBtn) {
      commissionAddStepBtn.onclick = () => {
        const inp = document.getElementById("commissionNewStepInput");
        const val = inp?.value.trim();
        if (val) {
          currentCommissionSteps.push(val);
          inp.value = "";
          renderCommissionStepList();
        }
      };
    }

    const commissionNewStepInput = document.getElementById("commissionNewStepInput");
    if (commissionNewStepInput) {
      commissionNewStepInput.addEventListener("keypress", e => {
        if (e.key === "Enter") {
          e.preventDefault();
          document.getElementById("commissionAddStepBtn").click();
        }
      });
    }

    document.querySelector("#clientForm").onsubmit = async event => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const data = Object.fromEntries(formData.entries());
      try {
        await api("/api/clients", { method:"POST", body: JSON.stringify(data) });
        event.target.reset();
        await loadAll();
      } catch (e) {
        alert(e.message);
      }
    };

    document.querySelector("#materialForm").onsubmit = async event => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const data = Object.fromEntries(formData.entries());
      try {
        await api("/api/materials", { method:"POST", body: JSON.stringify(data) });
        event.target.reset();
        event.target.elements.stock.value = 0;
        event.target.elements.unit.value = "个";
        await loadAll();
      } catch (e) {
        alert(e.message);
      }
    };

    document.querySelector("#templateForm").addEventListener("submit", async event => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const data = Object.fromEntries(formData.entries());
      data.steps = newTemplateSteps.filter(s => s.trim());
      if (!data.steps.length) return alert("至少需要一个步骤");
      try {
        await api("/api/step-templates", { method: "POST", body: JSON.stringify(data) });
        event.target.reset();
        newTemplateSteps = ["接收", "清洁", "补片", "补色", "交付"];
        renderTemplateStepList();
        await loadAll();
      } catch (e) {
        alert(e.message);
      }
    });

    const addStepBtn = document.getElementById("addStepBtn");
    if (addStepBtn) {
      addStepBtn.onclick = () => {
        const inp = document.getElementById("newStepInput");
        const val = inp?.value.trim();
        if (val) {
          newTemplateSteps.push(val);
          inp.value = "";
          renderTemplateStepList();
        }
      };
    }

    const newStepInput = document.getElementById("newStepInput");
    if (newStepInput) {
      newStepInput.addEventListener("keypress", e => {
        if (e.key === "Enter") {
          e.preventDefault();
          document.getElementById("addStepBtn").click();
        }
      });
    }

    const cancelEditTplBtn = document.getElementById("cancelEditTplBtn");
    if (cancelEditTplBtn) {
      cancelEditTplBtn.onclick = () => {
        document.getElementById("templateEditor").style.display = "none";
        editingTemplateId = null;
        editingTemplateSteps = [];
      };
    }

    const saveTplBtn = document.getElementById("saveTplBtn");
    if (saveTplBtn) {
      saveTplBtn.onclick = async () => {
        if (!editingTemplateId) return;
        const name = document.getElementById("editTplName").value.trim();
        const description = document.getElementById("editTplDesc").value.trim();
        const steps = editingTemplateSteps.filter(s => s.trim());
        if (!name) return alert("模板名称不能为空");
        if (!steps.length) return alert("至少需要一个步骤");
        try {
          await api("/api/step-templates/" + editingTemplateId, {
            method: "PUT",
            body: JSON.stringify({ name, description, steps })
          });
          await loadAll();
          alert("保存成功");
        } catch (e) {
          alert(e.message);
        }
      };
    }

    const deleteTplBtn = document.getElementById("deleteTplBtn");
    if (deleteTplBtn) {
      deleteTplBtn.onclick = async () => {
        if (!editingTemplateId) return;
        if (editingTemplateId === "TPL-DEFAULT") return alert("默认模板不能删除");
        if (!confirm("确定要删除这个模板吗？")) return;
        try {
          await api("/api/step-templates/" + editingTemplateId, { method: "DELETE" });
          document.getElementById("templateEditor").style.display = "none";
          editingTemplateId = null;
          editingTemplateSteps = [];
          await loadAll();
        } catch (e) {
          alert(e.message);
        }
      };
    }

    const editAddStepBtn = document.getElementById("editAddStepBtn");
    if (editAddStepBtn) {
      editAddStepBtn.onclick = () => {
        const inp = document.getElementById("editNewStepInput");
        const val = inp?.value.trim();
        if (val) {
          editingTemplateSteps.push(val);
          inp.value = "";
          renderEditTplSteps();
        }
      };
    }

    const editNewStepInput = document.getElementById("editNewStepInput");
    if (editNewStepInput) {
      editNewStepInput.addEventListener("keypress", e => {
        if (e.key === "Enter") {
          e.preventDefault();
          document.getElementById("editAddStepBtn").click();
        }
      });
    }

    let scheduleData = null;
    let scheduleView = localStorage.getItem("scheduleView") || "status";
    let scheduleOwnerFilter = localStorage.getItem("scheduleOwnerFilter") || "";
    let expandedScheduleCards = JSON.parse(localStorage.getItem("expandedScheduleCards") || "[]");
    let currentImageCommissionId = null;
    let currentImageStage = "before";
    let currentImages = { before: [], during: [], after: [] };
    let captionSaveTimers = {};
    const allowedImageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];

    function formatDate(isoStr) {
      const d = new Date(isoStr);
      return d.toLocaleDateString("zh-CN", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
    }

    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function openImagesModal(commissionId) {
      const commission = commissions.find(c => c.id === commissionId);
      if (!commission) return;
      currentImageCommissionId = commissionId;
      currentImageStage = "before";
      document.getElementById("modalTitle").textContent = "影像档案 - " + commission.roleName;
      document.getElementById("imagesModal").classList.add("active");
      loadImages(commissionId);
    }

    function closeImagesModal() {
      document.getElementById("imagesModal").classList.remove("active");
      currentImageCommissionId = null;
      currentImages = { before: [], during: [], after: [] };
    }

    async function loadImages(commissionId) {
      try {
        const data = await api("/api/commissions/" + commissionId + "/images");
        currentImages = data || { before: [], during: [], after: [] };
        updateStageCounts();
        renderStage(currentImageStage);
      } catch (e) {
        alert("加载影像失败：" + e.message);
      }
    }

    function updateStageCounts() {
      document.getElementById("count-before").textContent = currentImages.before?.length || 0;
      document.getElementById("count-during").textContent = currentImages.during?.length || 0;
      document.getElementById("count-after").textContent = currentImages.after?.length || 0;
    }

    function renderStage(stage) {
      const grid = document.getElementById("grid-" + stage);
      const images = currentImages[stage] || [];
      if (!images.length) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="icon">🖼️</div><div>暂无'+ (stage==="before"?"修复前":stage==="during"?"修复中":"修复后") +'图片</div><div class="meta" style="margin-top:8px;">点击上方区域上传图片</div></div>';
        return;
      }
      grid.innerHTML = images.map(img => '\
        <div class="image-card" data-image-id="' + img.id + '">\
          <div class="image-actions">\
            <button title="查看大图" data-view="' + img.id + '">🔍</button>\
            <button title="删除图片" data-del="' + img.id + '">🗑️</button>\
          </div>\
          <div class="image-thumb">\
            <img src="' + img.filename + '" alt="' + img.originalName + '" loading="lazy">\
          </div>\
          <div class="image-card-body">\
            <div class="filename" title="' + img.originalName + '">' + img.originalName + '</div>\
            <textarea placeholder="添加图片说明..." data-caption="' + img.id + '">' + (img.caption || "") + '</textarea>\
            <div class="date">' + formatDate(img.uploadedAt) + ' · ' + formatFileSize(img.size || 0) + '</div>\
          </div>\
        </div>\
      ').join("");

      grid.querySelectorAll("[data-caption]").forEach(ta => {
        ta.oninput = () => {
          const imgId = ta.dataset.caption;
          if (captionSaveTimers[imgId]) clearTimeout(captionSaveTimers[imgId]);
          captionSaveTimers[imgId] = setTimeout(() => {
            saveCaption(imgId, ta.value.trim());
          }, 800);
        };
      });

      grid.querySelectorAll("[data-del]").forEach(btn => {
        btn.onclick = async () => {
          const imgId = btn.dataset.del;
          if (!confirm("确定要删除这张图片吗？此操作不可恢复。")) return;
          try {
            await api("/api/commissions/" + currentImageCommissionId + "/images/" + imgId, { method: "DELETE" });
            await loadImages(currentImageCommissionId);
            await loadAll();
          } catch (e) {
            alert("删除失败：" + e.message);
          }
        };
      });

      grid.querySelectorAll("[data-view]").forEach(btn => {
        btn.onclick = () => {
          const imgId = btn.dataset.view;
          let img = null;
          for (const s of ["before", "during", "after"]) {
            img = currentImages[s]?.find(i => i.id === imgId);
            if (img) break;
          }
          if (img) window.open(img.filename, "_blank");
        };
      });
    }

    async function saveCaption(imageId, caption) {
      try {
        await api("/api/commissions/" + currentImageCommissionId + "/images/" + imageId, {
          method: "PUT",
          body: JSON.stringify({ caption })
        });
      } catch (e) {
        console.error("保存说明失败:", e);
      }
    }

    async function uploadFiles(stage, files) {
      const validFiles = [];
      for (const file of files) {
        if (!allowedImageTypes.includes(file.type)) {
          alert('文件 "' + file.name + '" 格式不支持，仅支持 JPG、PNG、GIF、WebP');
          continue;
        }
        if (file.size > 10 * 1024 * 1024) {
          alert('文件 "' + file.name + '" 超过 10MB 限制');
          continue;
        }
        validFiles.push(file);
      }

      if (!validFiles.length) return;

      for (const file of validFiles) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("stage", stage);

        try {
          const res = await fetch("/api/commissions/" + currentImageCommissionId + "/images", {
            method: "POST",
            body: formData
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "上传失败");
          if (data.warning) {
            alert("提示：" + data.warning);
          }
        } catch (e) {
          alert('上传 "' + file.name + '" 失败：' + e.message);
        }
      }

      await loadImages(currentImageCommissionId);
      await loadAll();
    }

    document.getElementById("modalClose").onclick = closeImagesModal;
    document.getElementById("imagesModal").onclick = (e) => {
      if (e.target.id === "imagesModal") closeImagesModal();
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.getElementById("imagesModal").classList.contains("active")) {
        closeImagesModal();
      }
    });

    document.querySelectorAll(".stage-tab").forEach(tab => {
      tab.onclick = () => {
        const stage = tab.dataset.stage;
        currentImageStage = stage;
        document.querySelectorAll(".stage-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".stage-content").forEach(c => c.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById("stage-" + stage).classList.add("active");
        renderStage(stage);
      };
    });

    document.querySelectorAll("[data-upload]").forEach(area => {
      const stage = area.dataset.upload;
      const input = area.querySelector("input");

      area.onclick = () => input.click();
      input.onchange = () => {
        if (input.files?.length) uploadFiles(stage, input.files);
        input.value = "";
      };

      area.ondragover = (e) => {
        e.preventDefault();
        area.classList.add("dragover");
      };
      area.ondragleave = () => {
        area.classList.remove("dragover");
      };
      area.ondrop = (e) => {
        e.preventDefault();
        area.classList.remove("dragover");
        if (e.dataTransfer?.files?.length) {
          uploadFiles(stage, e.dataTransfer.files);
        }
      };
    });

    loadAll();
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
    if (req.method === "GET" && url.pathname === "/api/clients") {
      const clientsWithCount = db.clients.map(c => ({
        ...c,
        commissionCount: db.commissions.filter(com => com.clientId === c.id).length
      }));
      return sendJson(res, 200, clientsWithCount);
    }
    const clientMatch = url.pathname.match(/^\/api\/clients\/([^/]+)$/);
    if (clientMatch && req.method === "GET") {
      const client = db.clients.find(c => c.id === clientMatch[1]);
      if (!client) return sendJson(res, 404, { error: "client_not_found" });
      const relatedCommissions = db.commissions.filter(c => c.clientId === client.id);
      return sendJson(res, 200, { ...client, commissionCount: relatedCommissions.length, commissions: relatedCommissions });
    }
    if (req.method === "POST" && url.pathname === "/api/clients") {
      const input = await body(req);
      const client = { id: `CL-${Date.now()}`, name: input.name, contact: input.contact || "", phone: input.phone || "", address: input.address || "", remark: input.remark || "" };
      db.clients.unshift(client);
      await saveDb(db);
      return sendJson(res, 201, client);
    }
    if (clientMatch && req.method === "PUT") {
      const client = db.clients.find(c => c.id === clientMatch[1]);
      if (!client) return sendJson(res, 404, { error: "client_not_found" });
      const input = await body(req);
      if (input.name) client.name = input.name;
      if (input.contact !== undefined) client.contact = input.contact;
      if (input.phone !== undefined) client.phone = input.phone;
      if (input.address !== undefined) client.address = input.address;
      if (input.remark !== undefined) client.remark = input.remark;
      await saveDb(db);
      return sendJson(res, 200, client);
    }
    if (req.method === "GET" && url.pathname === "/api/commissions") return sendJson(res, 200, db.commissions);
    if (req.method === "POST" && url.pathname === "/api/commissions") {
      const input = await body(req);
      let clientId = input.clientId || "";
      let clientName = input.client || "";
      if (clientId) {
        const existingClient = db.clients.find(c => c.id === clientId);
        if (existingClient) clientName = existingClient.name;
      } else if (clientName) {
        const existingClient = db.clients.find(c => c.name === clientName);
        if (existingClient) {
          clientId = existingClient.id;
          clientName = existingClient.name;
        } else {
          const newClient = { id: `CL-${Date.now()}`, name: clientName, contact: input.clientContact || "", phone: input.clientPhone || "", address: input.clientAddress || "", remark: "" };
          db.clients.unshift(newClient);
          clientId = newClient.id;
        }
      }
      let commissionSteps = [...defaultSteps];
      if (input.templateId) {
        const tpl = db.stepTemplates.find(t => t.id === input.templateId);
        if (tpl) {
          commissionSteps = [...tpl.steps];
        }
      }
      if (input.steps && Array.isArray(input.steps) && input.steps.length) {
        commissionSteps = input.steps;
      }
      const firstStep = commissionSteps[0];
      const selectedMaterials = [];
      if (Array.isArray(input.materials)) {
        for (const m of input.materials) {
          const mat = db.materials.find(item => item.id === m.id);
          if (mat && m.quantity > 0) {
            if (mat.stock < m.quantity) {
              return sendJson(res, 400, { error: `材料 ${mat.name} 库存不足，当前库存 ${mat.stock}${mat.unit}` });
            }
            selectedMaterials.push({ materialId: mat.id, name: mat.name, batch: mat.batch, quantity: m.quantity });
          }
        }
      }
      const commission = { id: `SP-${Date.now()}`, clientId, client: clientName, roleName: input.roleName, era: input.era, damage: input.damage, missingParts: input.missingParts || "", colorNotes: input.colorNotes || "", reinforcement: input.reinforcement || "", materials: selectedMaterials, owner: input.owner, dueDate: input.dueDate, status: firstStep, steps: commissionSteps, templateId: input.templateId || "", templateName: input.templateId ? (db.stepTemplates.find(t => t.id === input.templateId)?.name || "") : "", records: [{ at: new Date().toISOString(), step: firstStep, note: "登记委托" }], images: { before: [], during: [], after: [] } };
      for (const m of selectedMaterials) {
        const mat = db.materials.find(item => item.id === m.materialId);
        if (mat) mat.stock -= m.quantity;
      }
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
    if (req.method === "GET" && url.pathname === "/api/step-templates") return sendJson(res, 200, db.stepTemplates);
    if (req.method === "POST" && url.pathname === "/api/step-templates") {
      const input = await body(req);
      if (!input.name || !input.steps || !Array.isArray(input.steps) || !input.steps.length) {
        return sendJson(res, 400, { error: "模板名称和步骤列表不能为空" });
      }
      const tpl = { id: `TPL-${Date.now()}`, name: input.name, description: input.description || "", steps: input.steps };
      db.stepTemplates.unshift(tpl);
      await saveDb(db);
      return sendJson(res, 201, tpl);
    }
    const tplMatch = url.pathname.match(/^\/api\/step-templates\/([^/]+)$/);
    if (tplMatch && req.method === "PUT") {
      const tpl = db.stepTemplates.find(t => t.id === tplMatch[1]);
      if (!tpl) return sendJson(res, 404, { error: "template_not_found" });
      const input = await body(req);
      if (input.name !== undefined) tpl.name = input.name;
      if (input.description !== undefined) tpl.description = input.description;
      if (input.steps !== undefined && Array.isArray(input.steps) && input.steps.length) tpl.steps = input.steps;
      await saveDb(db);
      return sendJson(res, 200, tpl);
    }
    if (tplMatch && req.method === "DELETE") {
      const idx = db.stepTemplates.findIndex(t => t.id === tplMatch[1]);
      if (idx === -1) return sendJson(res, 404, { error: "template_not_found" });
      if (db.stepTemplates[idx].id === "TPL-DEFAULT") {
        return sendJson(res, 400, { error: "默认模板不能删除" });
      }
      db.stepTemplates.splice(idx, 1);
      await saveDb(db);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/materials") return sendJson(res, 200, db.materials);
    if (req.method === "POST" && url.pathname === "/api/materials") {
      const input = await body(req);
      const material = { id: `MAT-${Date.now()}`, name: input.name, category: input.category || "其他", batch: input.batch || "", stock: Number(input.stock) || 0, unit: input.unit || "个", remark: input.remark || "" };
      db.materials.unshift(material);
      await saveDb(db);
      return sendJson(res, 201, material);
    }
    const stockMatch = url.pathname.match(/^\/api\/materials\/([^/]+)\/stock$/);
    if (stockMatch && req.method === "POST") {
      const material = db.materials.find(m => m.id === stockMatch[1]);
      if (!material) return sendJson(res, 404, { error: "material_not_found" });
      const input = await body(req);
      const change = Number(input.change) || 0;
      material.stock = Math.max(0, material.stock + change);
      await saveDb(db);
      return sendJson(res, 200, material);
    }
    
    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
      const filePath = join(__dirname, url.pathname);
      if (!filePath.startsWith(uploadsDir)) return sendJson(res, 403, { error: "forbidden" });
      try {
        const stats = await stat(filePath);
        if (!stats.isFile()) return sendJson(res, 404, { error: "not_found" });
        const ext = extname(filePath).toLowerCase();
        const contentType = {
          ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
          ".gif": "image/gif", ".webp": "image/webp"
        }[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" });
        createReadStream(filePath).pipe(res);
        return;
      } catch {
        return sendJson(res, 404, { error: "not_found" });
      }
    }
    
    const imagesListMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/images$/);
    if (imagesListMatch && req.method === "GET") {
      const commission = db.commissions.find(c => c.id === imagesListMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      return sendJson(res, 200, commission.images);
    }
    
    if (imagesListMatch && req.method === "POST") {
      const commission = db.commissions.find(c => c.id === imagesListMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      
      const contentType = req.headers["content-type"] || "";
      if (!contentType.startsWith("multipart/form-data")) {
        return sendJson(res, 400, { error: "需要 multipart/form-data 格式" });
      }
      const boundaryMatch = contentType.match(/boundary=([^;]+)/);
      if (!boundaryMatch) return sendJson(res, 400, { error: "缺少 boundary" });
      
      const chunks = [];
      let totalSize = 0;
      for await (const chunk of req) {
        totalSize += chunk.length;
        if (totalSize > maxFileSize * 2) return sendJson(res, 413, { error: "请求体过大" });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const parts = parseMultipart(body, boundaryMatch[1]);
      
      const filePart = parts.find(p => p.name === "file");
      const stagePart = parts.find(p => p.name === "stage");
      const captionPart = parts.find(p => p.name === "caption");
      
      if (!filePart || !filePart.filename) return sendJson(res, 400, { error: "缺少文件" });
      if (!stagePart) return sendJson(res, 400, { error: "缺少阶段参数" });
      
      const stage = stagePart.content.toString("utf8").trim();
      if (!["before", "during", "after"].includes(stage)) {
        return sendJson(res, 400, { error: "阶段必须是 before、during 或 after" });
      }
      
      if (!allowedImageTypes.includes(filePart.contentType)) {
        return sendJson(res, 400, { error: "不支持的文件类型，仅支持 JPG、PNG、GIF、WebP" });
      }
      
      if (filePart.content.length > maxFileSize) {
        return sendJson(res, 413, { error: "文件大小不能超过 10MB" });
      }
      
      const fileHash = randomUUID();
      const ext = extname(filePart.filename).toLowerCase();
      const sanitizedName = sanitizeFilename(filePart.filename);
      const filename = `${fileHash}${ext}`;
      const commissionDir = join(uploadsDir, commission.id);
      const stageDir = join(commissionDir, stage);
      await mkdir(stageDir, { recursive: true });
      
      const filePath = join(stageDir, filename);
      await writeFile(filePath, filePart.content);
      
      const existingSameName = commission.images[stage].find(img => 
        img.originalName === sanitizedName && img.filename !== filename
      );
      
      const image = {
        id: `IMG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: `/uploads/${commission.id}/${stage}/${filename}`,
        originalName: sanitizedName,
        caption: captionPart ? captionPart.content.toString("utf8").trim() : "",
        uploadedAt: new Date().toISOString(),
        size: filePart.content.length
      };
      
      commission.images[stage].push(image);
      await saveDb(db);
      
      return sendJson(res, 201, {
        image,
        warning: existingSameName ? "已存在同名文件，已作为新文件保存" : null
      });
    }
    
    const imageMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/images\/([^/]+)$/);
    if (imageMatch && req.method === "PUT") {
      const commission = db.commissions.find(c => c.id === imageMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      
      const input = await body(req);
      const imageId = imageMatch[2];
      
      for (const stage of ["before", "during", "after"]) {
        const img = commission.images[stage].find(i => i.id === imageId);
        if (img) {
          if (input.caption !== undefined) img.caption = input.caption;
          await saveDb(db);
          return sendJson(res, 200, img);
        }
      }
      return sendJson(res, 404, { error: "image_not_found" });
    }
    
    if (imageMatch && req.method === "DELETE") {
      const commission = db.commissions.find(c => c.id === imageMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      
      const imageId = imageMatch[2];
      
      for (const stage of ["before", "during", "after"]) {
        const idx = commission.images[stage].findIndex(i => i.id === imageId);
        if (idx !== -1) {
          const img = commission.images[stage][idx];
          const filePath = join(__dirname, img.filename);
          try {
            if (existsSync(filePath)) await unlink(filePath);
          } catch (e) {
            console.error("删除文件失败:", e);
          }
          commission.images[stage].splice(idx, 1);
          await saveDb(db);
          return sendJson(res, 200, { ok: true });
        }
      }
      return sendJson(res, 404, { error: "image_not_found" });
    }
    
    if (req.method === "GET" && url.pathname === "/api/schedule") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const threeDaysLater = new Date(today);
      threeDaysLater.setDate(today.getDate() + 3);

      const grouped = {
        overdue: [],
        dueSoon: [],
        onTrack: [],
        byOwner: {}
      };

      for (const c of db.commissions) {
        if (!c.dueDate || c.status === "交付") continue;
        
        const dueDate = new Date(c.dueDate);
        dueDate.setHours(0, 0, 0, 0);
        
        let statusCategory = "onTrack";
        if (dueDate < today) {
          statusCategory = "overdue";
        } else if (dueDate <= threeDaysLater) {
          statusCategory = "dueSoon";
        }

        const item = {
          id: c.id,
          roleName: c.roleName,
          client: c.client,
          owner: c.owner,
          dueDate: c.dueDate,
          status: c.status,
          statusCategory,
          era: c.era,
          damage: c.damage,
          steps: c.steps || defaultSteps,
          records: c.records || [],
          latestNote: c.records && c.records.length ? c.records[c.records.length - 1].note : ""
        };

        grouped[statusCategory].push(item);

        if (!grouped.byOwner[c.owner]) {
          grouped.byOwner[c.owner] = { overdue: [], dueSoon: [], onTrack: [] };
        }
        grouped.byOwner[c.owner][statusCategory].push(item);
      }

      Object.values(grouped.byOwner).forEach(ownerGroup => {
        ownerGroup.overdue.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
        ownerGroup.dueSoon.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
        ownerGroup.onTrack.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
      });

      grouped.overdue.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
      grouped.dueSoon.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
      grouped.onTrack.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

      grouped.stats = {
        total: grouped.overdue.length + grouped.dueSoon.length + grouped.onTrack.length,
        overdue: grouped.overdue.length,
        dueSoon: grouped.dueSoon.length,
        onTrack: grouped.onTrack.length,
        byOwner: {}
      };

      for (const owner of Object.keys(grouped.byOwner)) {
        grouped.stats.byOwner[owner] = {
          total: grouped.byOwner[owner].overdue.length + grouped.byOwner[owner].dueSoon.length + grouped.byOwner[owner].onTrack.length,
          overdue: grouped.byOwner[owner].overdue.length,
          dueSoon: grouped.byOwner[owner].dueSoon.length,
          onTrack: grouped.byOwner[owner].onTrack.length
        };
      }

      return sendJson(res, 200, grouped);
    }

    const scheduleUpdateMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/schedule$/);
    if (scheduleUpdateMatch && req.method === "PUT") {
      const commission = db.commissions.find(item => item.id === scheduleUpdateMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const input = await body(req);
      if (input.status !== undefined) {
        commission.status = input.status;
        commission.records.push({ 
          at: new Date().toISOString(), 
          step: input.status, 
          note: input.note || "步骤更新" 
        });
      }
      if (input.owner !== undefined) {
        commission.owner = input.owner;
      }
      if (input.dueDate !== undefined) {
        commission.dueDate = input.dueDate;
      }
      if (input.remark !== undefined) {
        commission.remark = input.remark;
      }
      await saveDb(db);
      return sendJson(res, 200, commission);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

async function startServer() {
  await ensureUploadsDir();
  server.listen(port, () => console.log(`Shadow puppet restoration app listening on http://localhost:${port}`));
}
startServer();
