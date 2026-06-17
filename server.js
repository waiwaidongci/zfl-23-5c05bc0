import http from "node:http";
import { mkdir, readFile, writeFile, unlink, readdir, stat, rename } from "node:fs/promises";
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
const EXPORT_VERSION = "1.0";

const requiredCommissionFields = ["roleName", "era", "damage", "owner", "dueDate"];

function validateCommission(commission, existingCommissions, allSteps) {
  const issues = [];

  if (!commission || typeof commission !== "object" || Array.isArray(commission)) {
    issues.push({ type: "notAnObject", value: String(commission) });
    return issues;
  }

  const missingFields = [];

  for (const field of requiredCommissionFields) {
    if (!commission[field] || String(commission[field]).trim() === "") {
      missingFields.push(field);
    }
  }

  const hasClient = (commission.clientId && String(commission.clientId).trim() !== "") || 
                    (commission.client && String(commission.client).trim() !== "");
  if (!hasClient) {
    missingFields.push("client");
  }

  if (missingFields.length > 0) {
    issues.push({ type: "missingFields", fields: missingFields });
  }

  if (commission.dueDate) {
    const dueDate = new Date(commission.dueDate);
    if (isNaN(dueDate.getTime())) {
      issues.push({ type: "invalidDateFormat", field: "dueDate", value: commission.dueDate });
    }
  }

  if (commission.steps && Array.isArray(commission.steps)) {
    if (commission.steps.length === 0) {
      issues.push({ type: "emptySteps" });
    }
  }

  if (commission.status && commission.steps && Array.isArray(commission.steps) && commission.steps.length > 0) {
    if (!commission.steps.includes(commission.status)) {
      issues.push({ type: "invalidStep", currentStatus: commission.status, validSteps: commission.steps });
    }
  }

  if (commission.records && Array.isArray(commission.records)) {
    const steps = commission.steps && Array.isArray(commission.steps) && commission.steps.length ? commission.steps : defaultSteps;
    for (const record of commission.records) {
      if (record.step && !steps.includes(record.step)) {
        issues.push({ type: "invalidRecordStep", recordStep: record.step, validSteps: steps });
        break;
      }
      if (record.at) {
        const recordDate = new Date(record.at);
        if (isNaN(recordDate.getTime())) {
          issues.push({ type: "invalidRecordDate", recordStep: record.step, value: record.at });
          break;
        }
      }
    }
  }

  if (commission.materials && Array.isArray(commission.materials)) {
    for (const m of commission.materials) {
      if (m.quantity !== undefined && (typeof m.quantity !== "number" || m.quantity < 0)) {
        issues.push({ type: "invalidMaterialQuantity", material: m.name || m.materialId });
        break;
      }
    }
  }

  const duplicate = existingCommissions.find(c => {
    if (commission.id && c.id === commission.id) return true;
    if (commission.roleName && c.roleName === commission.roleName && 
        commission.client && c.client === commission.client &&
        commission.era && c.era === commission.era) {
      return true;
    }
    return false;
  });

  if (duplicate) {
    issues.push({ type: "duplicate", existingId: duplicate.id });
  }

  return issues;
}

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
      if (!Array.isArray(c.quotes)) {
        c.quotes = [];
        migrated = true;
      }
      if (c.currentQuoteId === undefined) {
        c.currentQuoteId = "";
        migrated = true;
      }
    }
  }
  if (migrated) await saveDb(db);
  return db;
}

async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }

async function saveDbAtomic(db) {
  const tempPath = dbPath + ".tmp";
  await writeFile(tempPath, JSON.stringify(db, null, 2));
  await rename(tempPath, dbPath);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
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
    .io-actions { display:flex; gap:10px; padding:14px 28px 0; background:#fff; border-bottom:1px solid var(--line); }
    .io-btn { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 16px; font-weight:700; cursor:pointer; font-size:14px; display:inline-flex; align-items:center; gap:6px; }
    .io-btn:hover { opacity:0.9; }
    .io-btn-export { background:var(--green); }
    .io-btn-import { background:var(--accent); }
    .io-btn:disabled { opacity:0.5; cursor:not-allowed; }
    .import-modal { max-width:1000px; }
    .import-modal .modal-footer { padding:16px 24px; border-top:1px solid var(--line); display:flex; justify-content:flex-end; gap:10px; background:#faf8f5; }
    .import-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
    .import-stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; text-align:center; }
    .import-stat-label { display:block; font-size:13px; color:var(--muted); margin-bottom:6px; }
    .import-stat-count { display:block; font-size:28px; font-weight:700; }
    .import-stat-new .import-stat-count { color:var(--green); }
    .import-stat-dup .import-stat-count { color:var(--orange); }
    .import-stat-missing .import-stat-count { color:#c0392b; }
    .import-stat-invalid .import-stat-count { color:#8e44ad; }
    .import-filter-tabs { display:flex; gap:4px; margin-bottom:12px; flex-wrap:wrap; }
    .import-filter-tab { padding:8px 14px; background:var(--bg); border:1px solid var(--line); border-radius:6px; cursor:pointer; font-size:13px; }
    .import-filter-tab.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .import-filter-tab span { margin-left:4px; padding:1px 7px; background:rgba(0,0,0,0.1); border-radius:999px; font-size:11px; }
    .import-filter-tab.active span { background:rgba(255,255,255,0.25); }
    .import-list { max-height:400px; overflow-y:auto; }
    .import-item { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; margin-bottom:10px; }
    .import-item-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; }
    .import-item-title { font-weight:700; font-size:15px; margin:0; }
    .import-item-badges { display:flex; gap:6px; flex-wrap:wrap; }
    .import-badge { padding:3px 8px; border-radius:999px; font-size:11px; font-weight:600; }
    .import-badge.new { background:#d5f5e3; color:#1e8449; }
    .import-badge.duplicate { background:#fdebd0; color:#a0522d; }
    .import-badge.missingFields { background:#fadbd8; color:#922b21; }
    .import-badge.invalidSteps { background:#e8daef; color:#6c3483; }
    .import-item-meta { color:var(--muted); font-size:13px; margin-bottom:8px; }
    .import-item-issues { background:var(--bg); border-radius:6px; padding:10px; font-size:13px; }
    .import-item-issues .issue { margin:4px 0; }
    .import-item-actions { margin-top:10px; display:flex; gap:8px; align-items:center; }
    .import-item-actions label { display:flex; align-items:center; gap:6px; margin:0; font-size:13px; color:var(--muted); }
    .import-item-actions input[type=checkbox] { width:auto; }
    .field-tag { display:inline-block; padding:1px 6px; background:#fff; border:1px solid var(--line); border-radius:4px; font-size:11px; margin:0 2px; }

    .quote-modal { max-width: 800px; }
    .quote-info { background: var(--bg); border-radius: 8px; padding: 14px; margin-bottom: 18px; }
    .quote-info-row { display: flex; justify-content: space-between; margin-bottom: 8px; }
    .quote-info-row:last-child { margin-bottom: 0; }
    .quote-info .meta { margin-right: 6px; }

    .quote-section { margin-bottom: 20px; }
    .quote-section h4 { margin: 0 0 12px; font-size: 15px; color: var(--ink); }
    .quote-section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .quote-section-header h4 { margin: 0; }

    .damage-info { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .damage-item { background: var(--bg); border-radius: 6px; padding: 10px; }
    .damage-item .meta { font-size: 12px; display: block; margin-bottom: 4px; }

    .quote-items-header { display: grid; grid-template-columns: 1fr 70px 90px 90px 40px; gap: 8px; padding: 8px 10px; background: var(--bg); border-radius: 6px 6px 0 0; font-size: 12px; color: var(--muted); font-weight: 700; }
    .quote-item-col-desc { grid-column: 1; }
    .quote-item-col-qty { grid-column: 2; text-align: center; }
    .quote-item-col-price { grid-column: 3; text-align: right; }
    .quote-item-col-amount { grid-column: 4; text-align: right; }
    .quote-item-col-action { grid-column: 5; text-align: center; }

    .quote-item-row { display: grid; grid-template-columns: 1fr 70px 90px 90px 40px; gap: 8px; padding: 10px; border-bottom: 1px solid var(--line); align-items: center; }
    .quote-item-row:last-child { border-bottom: none; }
    .quote-item-row input { width: 100%; padding: 6px 8px; font-size: 13px; }
    .quote-item-row .item-desc { font-size: 14px; }
    .quote-item-row .item-qty { text-align: center; font-size: 14px; }
    .quote-item-row .item-price { text-align: right; font-size: 14px; }
    .quote-item-row .item-amount { text-align: right; font-weight: 700; font-size: 14px; }
    .quote-item-row .item-action { text-align: center; }
    .quote-item-row .item-action button { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; padding: 0 6px; }
    .quote-item-row .item-action button:hover { color: #c0392b; }
    .quote-item-row .item-action button:disabled { opacity: 0.3; cursor: not-allowed; }

    .quote-summary { background: var(--bg); border-radius: 8px; padding: 14px; }
    .quote-summary-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; font-size: 14px; }
    .quote-summary-row.editable .editable-input { display: flex; align-items: center; gap: 4px; }
    .quote-summary-row.editable .editable-input input { width: 100px; padding: 6px 8px; text-align: right; font-size: 14px; }
    .quote-summary-row.total { border-top: 2px solid var(--line); margin-top: 8px; padding-top: 12px; font-size: 16px; }
    .quote-summary-row.total strong { font-size: 20px; color: var(--accent); }

    .quote-other { display: grid; gap: 12px; }
    .quote-other-row { display: grid; grid-template-columns: 100px 1fr; gap: 10px; align-items: flex-start; }
    .quote-other-row label { color: var(--muted); font-size: 13px; margin: 0; padding-top: 8px; }
    .quote-other-row input, .quote-other-row textarea { width: 100%; padding: 8px; font-size: 14px; }

    .quote-history-section { margin-top: 20px; padding-top: 20px; border-top: 2px solid var(--line); }
    .quote-history-list { display: flex; flex-direction: column; gap: 10px; }
    .quote-history-item { background: var(--bg); border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.2s; border: 1px solid transparent; }
    .quote-history-item:hover { border-color: var(--accent); }
    .quote-history-item.active { border-color: var(--accent); background: #fff; }
    .quote-history-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .quote-history-title { font-weight: 700; font-size: 14px; }
    .quote-history-status { font-size: 11px; }
    .quote-history-meta { font-size: 12px; color: var(--muted); display: flex; gap: 12px; }
    .quote-history-amount { font-weight: 700; color: var(--accent); }

    .quote-footer { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; border-top: 1px solid var(--line); background: #faf8f5; }
    .quote-footer > div { display: flex; gap: 8px; }

    .pill.draft { background: #fdebd0; color: #a0522d; border-color: #e67e22; }
    .pill.confirmed { background: #d5f5e3; color: #1e8449; border-color: var(--green); }
    .pill.superseded { background: #e8daef; color: #6c3483; border-color: #8e44ad; }

    .quote-empty { text-align: center; padding: 30px 20px; color: var(--muted); background: var(--bg); border-radius: 8px; }
    .quote-empty .icon { font-size: 36px; margin-bottom: 10px; opacity: 0.5; }
    .quote-empty button { margin-top: 12px; }

    .quote-btn { margin-top: 8px; background: var(--orange); color: #fff; border: 0; border-radius: 6px; padding: 8px 12px; font-size: 13px; cursor: pointer; }
    .quote-btn:hover { opacity: 0.9; }

    @media (max-width:900px){ .two-col{grid-template-columns:1fr;} header{padding:18px 16px;} .tabs{padding:12px 16px 0;} .tab-content{padding:16px;} .stats{grid-template-columns:1fr 1fr;} .image-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));} .kanban{grid-template-columns:1fr;} .schedule-stats{grid-template-columns:1fr 1fr;} .io-actions{padding:12px 16px 0;} .import-stats{grid-template-columns:1fr 1fr;} .damage-info{grid-template-columns:1fr;} .quote-items-header, .quote-item-row{grid-template-columns:1fr 60px 80px 80px 30px; font-size:12px;} .quote-history-meta{flex-direction:column; gap:2px;} }
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
    <div class="io-actions">
      <button type="button" id="exportBtn" class="io-btn io-btn-export">📤 导出委托数据</button>
      <label class="io-btn io-btn-import">
        📥 导入委托数据
        <input type="file" id="importFileInput" accept=".json" style="display:none;">
      </label>
    </div>
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

  <div class="modal-overlay" id="importModal">
    <div class="modal import-modal">
      <div class="modal-header">
        <h3 id="importModalTitle">导入委托数据</h3>
        <button class="modal-close" id="importModalClose">&times;</button>
      </div>
      <div class="modal-body">
        <div id="importPreview" style="display:none;">
          <div class="import-stats">
            <div class="import-stat import-stat-new">
              <span class="import-stat-label">新增</span>
              <span class="import-stat-count" id="stat-new">0</span>
            </div>
            <div class="import-stat import-stat-dup">
              <span class="import-stat-label">可能重复</span>
              <span class="import-stat-count" id="stat-dup">0</span>
            </div>
            <div class="import-stat import-stat-missing">
              <span class="import-stat-label">字段缺失</span>
              <span class="import-stat-count" id="stat-missing">0</span>
            </div>
            <div class="import-stat import-stat-invalid">
              <span class="import-stat-label">步骤不合法</span>
              <span class="import-stat-count" id="stat-invalid">0</span>
            </div>
          </div>
          <div class="import-filter">
            <div class="import-filter-tabs">
              <button type="button" class="import-filter-tab active" data-import-filter="all">全部 <span id="filter-count-all">0</span></button>
              <button type="button" class="import-filter-tab" data-import-filter="new">新增 <span id="filter-count-new">0</span></button>
              <button type="button" class="import-filter-tab" data-import-filter="duplicate">可能重复 <span id="filter-count-dup">0</span></button>
              <button type="button" class="import-filter-tab" data-import-filter="missingFields">字段缺失 <span id="filter-count-missing">0</span></button>
              <button type="button" class="import-filter-tab" data-import-filter="invalidSteps">步骤不合法 <span id="filter-count-invalid">0</span></button>
            </div>
            <div id="importList" class="import-list"></div>
          </div>
        </div>
        <div id="importEmpty" class="empty-state">
          <div class="icon">📁</div>
          <div>请选择JSON文件进行导入</div>
          <div class="meta" style="margin-top:8px;">支持导出的JSON格式文件</div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="secondary" id="cancelImportBtn">取消</button>
        <button type="button" id="confirmImportBtn" disabled>确认导入</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="quoteModal">
    <div class="modal quote-modal">
      <div class="modal-header">
        <h3 id="quoteModalTitle">报价单</h3>
        <button class="modal-close" id="quoteModalClose">&times;</button>
      </div>
      <div class="modal-body">
        <div class="quote-info">
          <div class="quote-info-row">
            <div>
              <span class="meta">委托项目：</span>
              <strong id="quoteCommissionName">-</strong>
            </div>
            <div>
              <span class="meta">客户：</span>
              <span id="quoteClientName">-</span>
            </div>
          </div>
          <div class="quote-info-row">
            <div>
              <span class="meta">报价版本：</span>
              <span id="quoteVersion">-</span>
            </div>
            <div>
              <span class="meta">报价状态：</span>
              <span id="quoteStatus" class="pill">-</span>
            </div>
          </div>
        </div>

        <div class="quote-section">
          <h4>破损与修复信息</h4>
          <div class="damage-info">
            <div class="damage-item">
              <span class="meta">破损描述</span>
              <div id="quoteDamage">-</div>
            </div>
            <div class="damage-item">
              <span class="meta">缺失零件</span>
              <div id="quoteMissingParts">-</div>
            </div>
            <div class="damage-item">
              <span class="meta">补色记录</span>
              <div id="quoteColorNotes">-</div>
            </div>
            <div class="damage-item">
              <span class="meta">加固材料</span>
              <div id="quoteReinforcement">-</div>
            </div>
          </div>
        </div>

        <div class="quote-section">
          <div class="quote-section-header">
            <h4>项目明细</h4>
            <button type="button" class="small" id="addQuoteItemBtn" style="display:none;">+ 添加项目</button>
          </div>
          <div class="quote-items-header">
            <div class="quote-item-col-desc">项目描述</div>
            <div class="quote-item-col-qty">数量</div>
            <div class="quote-item-col-price">单价(元)</div>
            <div class="quote-item-col-amount">金额(元)</div>
            <div class="quote-item-col-action"></div>
          </div>
          <div id="quoteItemsList"></div>
        </div>

        <div class="quote-section">
          <h4>费用汇总</h4>
          <div class="quote-summary">
            <div class="quote-summary-row">
              <span>项目小计</span>
              <span id="quoteItemsTotal">¥0.00</span>
            </div>
            <div class="quote-summary-row editable">
              <span>人工费</span>
              <div class="editable-input">
                <span>¥</span>
                <input type="number" id="quoteLaborCost" min="0" step="0.01" value="0" disabled>
              </div>
            </div>
            <div class="quote-summary-row editable">
              <span>材料费</span>
              <div class="editable-input">
                <span>¥</span>
                <input type="number" id="quoteMaterialCost" min="0" step="0.01" value="0" disabled>
              </div>
            </div>
            <div class="quote-summary-row total">
              <span>总计</span>
              <strong id="quoteTotalAmount">¥0.00</strong>
            </div>
          </div>
        </div>

        <div class="quote-section">
          <h4>其他信息</h4>
          <div class="quote-other">
            <div class="quote-other-row">
              <label>预计工期(天)</label>
              <input type="number" id="quoteEstimatedDays" min="0" value="0" disabled>
            </div>
            <div class="quote-other-row">
              <label>备注</label>
              <textarea id="quoteRemark" rows="3" disabled></textarea>
            </div>
          </div>
        </div>

        <div class="quote-history-section" id="quoteHistorySection" style="display:none;">
          <div class="quote-section-header">
            <h4>历史版本</h4>
            <span class="meta" id="quoteHistoryCount">共 0 个版本</span>
          </div>
          <div id="quoteHistoryList"></div>
        </div>
      </div>
      <div class="modal-footer quote-footer">
        <button type="button" class="secondary" id="quoteCloseBtn">关闭</button>
        <button type="button" id="createQuoteBtn" style="display:none;">创建报价</button>
        <div id="quoteEditActions" style="display:none;">
          <button type="button" class="secondary" id="quoteCancelEditBtn">取消</button>
          <button type="button" id="quoteSaveBtn">保存草稿</button>
        </div>
        <div id="quoteDraftActions" style="display:none;">
          <button type="button" id="quoteEditBtn">编辑报价</button>
          <button type="button" class="secondary" id="quoteConfirmBtn">确认报价</button>
        </div>
        <div id="quoteConfirmedActions" style="display:none;">
          <button type="button" id="quoteReviseBtn">重新报价</button>
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

        const currentQuote = c.currentQuoteId ? (c.quotes || []).find(q => q.id === c.currentQuoteId) : null;
        const quoteCount = (c.quotes || []).length;
        let quoteBadge = '';
        if (currentQuote) {
          const statusText = currentQuote.status === 'draft' ? '草稿' : currentQuote.status === 'confirmed' ? '已确认' : '已作废';
          const statusClass = currentQuote.status;
          quoteBadge = '<span class="pill ' + statusClass + '" style="margin-left:6px;">报价：¥' + Number(currentQuote.totalAmount).toFixed(2) + '</span>';
        } else {
          quoteBadge = '<span class="pill" style="margin-left:6px;background:var(--bg);">未报价</span>';
        }

        return '<article class="card"><h3 style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;">'+c.roleName+tplBadge+quoteBadge+'</h3><span class="pill">'+c.status+'</span><div class="meta">'+c.client+' · '+c.era+' · '+c.owner+'</div><div><b>破损</b> '+c.damage+'</div>'+(c.reinforcement?'<div><b>加固</b> '+c.reinforcement+'</div>':'')+(matChips?'<div><b>用料</b></div><div class="mat-chips">'+matChips+'</div>':'')+'<label>更新步骤</label><select data-step="'+c.id+'">'+cSteps.map(s => '<option>'+s+'</option>').join("")+'</select><input data-note="'+c.id+'" placeholder="步骤备注"><button data-save="'+c.id+'">保存步骤</button><button class="images-btn" data-images="'+c.id+'">📷 影像档案 ('+totalImgs+')</button><button class="quote-btn" data-quote="'+c.id+'">💰 报价管理' + (quoteCount > 0 ? ' (' + quoteCount + '版)' : '') + '</button><div class="meta">'+(c.records||[]).map(r => r.step+"："+r.note).join(" / ")+'</div></article>';
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
      document.querySelectorAll("[data-quote]").forEach(btn => btn.onclick = () => {
        const id = btn.dataset.quote;
        openQuoteModal(id);
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

    let importPreviewData = null;
    let currentImportFilter = "all";
    let importOverwriteMap = {};

    function openImportModal() {
      document.getElementById("importModal").classList.add("active");
      document.getElementById("importEmpty").style.display = "block";
      document.getElementById("importPreview").style.display = "none";
      importPreviewData = null;
      importOverwriteMap = {};
      currentImportFilter = "all";
      document.getElementById("confirmImportBtn").disabled = true;
      document.getElementById("importFileInput").value = "";
    }

    function closeImportModal() {
      document.getElementById("importModal").classList.remove("active");
      importPreviewData = null;
      importOverwriteMap = {};
    }

    async function exportCommissions() {
      try {
        const res = await fetch("/api/commissions/export");
        if (!res.ok) throw new Error("导出失败");
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const disposition = res.headers.get("Content-Disposition");
        let filename = null;
        if (disposition) {
          const idx1 = disposition.indexOf('filename="');
          if (idx1 >= 0) {
            const idx2 = disposition.indexOf('"', idx1 + 10);
            if (idx2 >= 0) filename = disposition.substring(idx1 + 10, idx2);
          } else {
            const idx3 = disposition.indexOf("filename=");
            if (idx3 >= 0) filename = disposition.substring(idx3 + 9).trim();
          }
        }
        a.download = filename || "shadow-puppet-commissions-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      } catch (e) {
        alert("导出失败：" + e.message);
      }
    }

    const fieldNames = {
      roleName: "角色名称",
      era: "年代",
      damage: "破损部位",
      owner: "负责人",
      dueDate: "截止日期",
      client: "客户"
    };

    function getCategoryLabel(cat) {
      const labels = {
        new: "新增",
        duplicate: "可能重复",
        missingFields: "字段缺失",
        invalidSteps: "步骤不合法"
      };
      return labels[cat] || cat;
    }

    function renderImportPreview() {
      if (!importPreviewData) return;

      const preview = importPreviewData;
      document.getElementById("importEmpty").style.display = "none";
      document.getElementById("importPreview").style.display = "block";

      document.getElementById("stat-new").textContent = preview.categories.new.length;
      document.getElementById("stat-dup").textContent = preview.categories.duplicate.length;
      document.getElementById("stat-missing").textContent = preview.categories.missingFields.length;
      document.getElementById("stat-invalid").textContent = preview.categories.invalidSteps.length;

      document.getElementById("filter-count-all").textContent = preview.total;
      document.getElementById("filter-count-new").textContent = preview.categories.new.length;
      document.getElementById("filter-count-dup").textContent = preview.categories.duplicate.length;
      document.getElementById("filter-count-missing").textContent = preview.categories.missingFields.length;
      document.getElementById("filter-count-invalid").textContent = preview.categories.invalidSteps.length;

      const hasValidItems = preview.categories.new.length > 0 || preview.categories.duplicate.length > 0;
      document.getElementById("confirmImportBtn").disabled = !hasValidItems;

      const listEl = document.getElementById("importList");
      const filteredItems = preview.items.filter(item => {
        if (currentImportFilter === "all") return true;
        return item.categories.includes(currentImportFilter);
      });

      if (filteredItems.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:40px 20px;"><div class="icon">📭</div><div>暂无符合条件的数据</div></div>';
        return;
      }

      listEl.innerHTML = filteredItems.map(function(item) {
        var badges = item.categories.map(function(cat) {
          return '<span class="import-badge ' + cat + '">' + getCategoryLabel(cat) + '</span>';
        }).join("");

        var issuesHtml = item.issues.map(function(issue) {
          if (issue.type === "notAnObject") {
            var displayVal = issue.value.length > 50 ? issue.value.substring(0, 50) + "..." : issue.value;
            return '<div class="issue">⚠️ 数据格式错误：不是有效的委托对象（原始值：' + displayVal + '）</div>';
          }
          if (issue.type === "missingFields") {
            var fields = issue.fields.map(function(f) {
              return '<span class="field-tag">' + (fieldNames[f] || f) + '</span>';
            }).join("");
            return '<div class="issue">⚠️ 缺少必填字段：' + fields + '</div>';
          }
          if (issue.type === "invalidStep") {
            return '<div class="issue">⚠️ 当前状态 "' + issue.currentStatus + '" 不在步骤列表中，有效步骤：' + issue.validSteps.join(" → ") + '</div>';
          }
          if (issue.type === "invalidRecordStep") {
            return '<div class="issue">⚠️ 修复记录中包含非法步骤 "' + issue.recordStep + '"，有效步骤：' + issue.validSteps.join(" → ") + '</div>';
          }
          if (issue.type === "invalidDateFormat") {
            return '<div class="issue">⚠️ 日期格式无效：' + issue.value + '</div>';
          }
          if (issue.type === "emptySteps") {
            return '<div class="issue">⚠️ 修复步骤不能为空</div>';
          }
          if (issue.type === "invalidRecordDate") {
            return '<div class="issue">⚠️ 修复记录日期格式无效："' + issue.recordStep + '" 步骤的日期 "' + issue.value + '" 格式不正确</div>';
          }
          if (issue.type === "invalidMaterialQuantity") {
            return '<div class="issue">⚠️ 材料 "' + (issue.material || "未知") + '" 数量无效</div>';
          }
          if (issue.type === "duplicate") {
            return '<div class="issue">⚠️ 与现有委托 ' + issue.existingId + ' 可能重复（ID或角色+客户+年代相同）</div>';
          }
          return "";
        }).join("");

        var c = item.data;
        var isNotAnObject = item.issues.some(function(issue) { return issue.type === "notAnObject"; });
        var title, metaText, damageText, dueDateText;
        
        if (isNotAnObject) {
          title = "无效数据条目";
          metaText = "第 " + (item.index + 1) + " 条数据格式错误";
          damageText = "";
          dueDateText = "";
        } else {
          title = c.roleName || "未命名角色";
          metaText = (c.client || "未指定客户") + " · " + (c.era || "未知年代") + " · " + (c.owner || "未指定负责人");
          damageText = c.damage ? '<div><b>破损：</b>' + c.damage + '</div>' : "";
          dueDateText = c.dueDate ? '<div class="import-item-meta" style="margin-top:4px;">截止日期：' + c.dueDate + '</div>' : "";
        }

        var canOverwrite = !isNotAnObject && item.categories.includes("duplicate") && 
          !item.categories.includes("missingFields") && 
          !item.categories.includes("invalidSteps");

        var overwriteChecked = importOverwriteMap[item.index] ? "checked" : "";

        var html = '<div class="import-item">' +
          '<div class="import-item-header">' +
            '<h4 class="import-item-title">' + title + '</h4>' +
            '<div class="import-item-badges">' + badges + '</div>' +
          '</div>' +
          '<div class="import-item-meta">' + metaText + '</div>' +
          damageText +
          dueDateText +
          (issuesHtml ? '<div class="import-item-issues">' + issuesHtml + '</div>' : "") +
          (canOverwrite ? 
            '<div class="import-item-actions">' +
              '<label>' +
                '<input type="checkbox" data-import-overwrite="' + item.index + '" ' + overwriteChecked + '>' +
                ' 覆盖现有委托' +
              '</label>' +
            '</div>'
          : "") +
        '</div>';
        return html;
      }).join("");

      document.querySelectorAll("[data-import-overwrite]").forEach(cb => {
        cb.onchange = () => {
          const idx = Number(cb.dataset.importOverwrite);
          importOverwriteMap[idx] = cb.checked;
        };
      });

      document.querySelectorAll(".import-filter-tab").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.importFilter === currentImportFilter);
      });
    }

    async function handleImportFile(file) {
      if (!file) return;
      if (!file.name.endsWith(".json")) {
        alert("请选择JSON文件");
        return;
      }

      try {
        const text = await file.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          alert("JSON解析失败，请检查文件格式");
          return;
        }

        const preview = await api("/api/commissions/import/preview", {
          method: "POST",
          body: JSON.stringify(data)
        });

        importPreviewData = preview;
        importOverwriteMap = {};
        currentImportFilter = "all";
        renderImportPreview();
      } catch (e) {
        alert("导入预览失败：" + e.message);
      }
    }

    async function confirmImport() {
      if (!importPreviewData) return;

      const itemsToImport = importPreviewData.items.filter(item => {
        const hasBlockingIssues = item.categories.includes("missingFields") || item.categories.includes("invalidSteps");
        if (hasBlockingIssues) return false;
        const isDuplicate = item.categories.includes("duplicate");
        if (isDuplicate && !importOverwriteMap[item.index]) return false;
        return true;
      }).map(item => ({
        data: item.data,
        forceOverwrite: importOverwriteMap[item.index] || false
      }));

      if (itemsToImport.length === 0) {
        alert("没有可导入的数据，请检查数据问题");
        return;
      }

      if (!confirm("确定要导入 " + itemsToImport.length + " 条委托数据吗？")) return;

      try {
        const result = await api("/api/commissions/import", {
          method: "POST",
          body: JSON.stringify({ items: itemsToImport })
        });

        if (result.success) {
          alert("导入成功！共导入 " + result.imported + " 条数据");
          closeImportModal();
          await loadAll();
        } else {
          alert("导入失败：" + (result.error || "未知错误"));
        }
      } catch (e) {
        alert("导入失败：" + e.message);
      }
    }

    document.getElementById("exportBtn").onclick = exportCommissions;
    document.getElementById("importFileInput").onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        openImportModal();
        handleImportFile(file);
      }
    };

    document.getElementById("importModalClose").onclick = closeImportModal;
    document.getElementById("cancelImportBtn").onclick = closeImportModal;
    document.getElementById("importModal").onclick = (e) => {
      if (e.target.id === "importModal") closeImportModal();
    };
    document.getElementById("confirmImportBtn").onclick = confirmImport;

    document.querySelectorAll(".import-filter-tab").forEach(tab => {
      tab.onclick = () => {
        currentImportFilter = tab.dataset.importFilter;
        renderImportPreview();
      };
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.getElementById("importModal").classList.contains("active")) {
        closeImportModal();
      }
    });

    let currentQuoteCommissionId = null;
    let currentQuoteData = null;
    let currentQuoteItems = [];
    let isQuoteEditing = false;
    let quoteHistory = [];

    function getStatusText(status) {
      const statusMap = {
        draft: "草稿",
        confirmed: "已确认",
        superseded: "已作废"
      };
      return statusMap[status] || status;
    }

    function formatMoney(amount) {
      return "¥" + Number(amount).toFixed(2);
    }

    function calculateQuoteTotals() {
      const itemsTotal = currentQuoteItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
      const laborCost = Number(document.getElementById("quoteLaborCost")?.value) || 0;
      const materialCost = Number(document.getElementById("quoteMaterialCost")?.value) || 0;
      const total = itemsTotal + laborCost + materialCost;

      const itemsTotalEl = document.getElementById("quoteItemsTotal");
      const totalEl = document.getElementById("quoteTotalAmount");
      if (itemsTotalEl) itemsTotalEl.textContent = formatMoney(itemsTotal);
      if (totalEl) totalEl.textContent = formatMoney(total);

      return { itemsTotal, laborCost, materialCost, total };
    }

    function renderQuoteItems() {
      const listEl = document.getElementById("quoteItemsList");
      if (!listEl) return;

      if (!currentQuoteItems.length) {
        listEl.innerHTML = '<div class="quote-empty" style="border-radius:0 0 6px 6px;"><div class="icon">📋</div><div>暂无报价项目</div></div>';
        return;
      }

      listEl.innerHTML = currentQuoteItems.map((item, idx) => {
        if (isQuoteEditing) {
          return '<div class="quote-item-row">' +
            '<div><input type="text" data-item-desc="' + idx + '" value="' + (item.description || '') + '" placeholder="项目描述"></div>' +
            '<div><input type="number" data-item-qty="' + idx + '" value="' + (item.quantity || 0) + '" min="0" step="1"></div>' +
            '<div><input type="number" data-item-price="' + idx + '" value="' + (item.unitPrice || 0) + '" min="0" step="0.01"></div>' +
            '<div class="item-amount">' + formatMoney(item.amount || 0) + '</div>' +
            '<div class="item-action"><button data-item-del="' + idx + '" title="删除">×</button></div>' +
            '</div>';
        } else {
          return '<div class="quote-item-row">' +
            '<div class="item-desc">' + (item.description || '-') + '</div>' +
            '<div class="item-qty">' + (item.quantity || 0) + '</div>' +
            '<div class="item-price">' + formatMoney(item.unitPrice || 0) + '</div>' +
            '<div class="item-amount">' + formatMoney(item.amount || 0) + '</div>' +
            '<div class="item-action"></div>' +
            '</div>';
        }
      }).join("");

      if (isQuoteEditing) {
        listEl.querySelectorAll("[data-item-desc]").forEach(inp => {
          inp.oninput = () => {
            const idx = Number(inp.dataset.itemDesc);
            currentQuoteItems[idx].description = inp.value;
          };
        });
        listEl.querySelectorAll("[data-item-qty]").forEach(inp => {
          inp.oninput = () => {
            const idx = Number(inp.dataset.itemQty);
            const qty = Number(inp.value) || 0;
            currentQuoteItems[idx].quantity = qty;
            currentQuoteItems[idx].amount = qty * (currentQuoteItems[idx].unitPrice || 0);
            renderQuoteItems();
            calculateQuoteTotals();
          };
        });
        listEl.querySelectorAll("[data-item-price]").forEach(inp => {
          inp.oninput = () => {
            const idx = Number(inp.dataset.itemPrice);
            const price = Number(inp.value) || 0;
            currentQuoteItems[idx].unitPrice = price;
            currentQuoteItems[idx].amount = price * (currentQuoteItems[idx].quantity || 0);
            renderQuoteItems();
            calculateQuoteTotals();
          };
        });
        listEl.querySelectorAll("[data-item-del]").forEach(btn => {
          btn.onclick = () => {
            const idx = Number(btn.dataset.itemDel);
            currentQuoteItems.splice(idx, 1);
            renderQuoteItems();
            calculateQuoteTotals();
          };
        });
      }

      calculateQuoteTotals();
    }

    function renderQuoteHistory() {
      const historySection = document.getElementById("quoteHistorySection");
      const historyList = document.getElementById("quoteHistoryList");
      const historyCount = document.getElementById("quoteHistoryCount");
      if (!historySection || !historyList || !historyCount) return;

      if (!quoteHistory || quoteHistory.length <= 1) {
        historySection.style.display = "none";
        return;
      }

      historySection.style.display = "block";
      historyCount.textContent = "共 " + quoteHistory.length + " 个版本";

      const sortedHistory = [...quoteHistory].sort((a, b) => b.version - a.version);
      historyList.innerHTML = sortedHistory.map(q => {
        const isActive = currentQuoteData && q.id === currentQuoteData.id;
        return '<div class="quote-history-item' + (isActive ? ' active' : '') + '" data-history-id="' + q.id + '">' +
          '<div class="quote-history-header">' +
          '<span class="quote-history-title">第 ' + q.version + ' 版</span>' +
          '<span class="pill quote-history-status ' + q.status + '">' + getStatusText(q.status) + '</span>' +
          '</div>' +
          '<div class="quote-history-meta">' +
          '<span>创建：' + formatDate(q.createdAt) + '</span>' +
          (q.confirmedAt ? '<span>确认：' + formatDate(q.confirmedAt) + '</span>' : '') +
          '<span class="quote-history-amount">' + formatMoney(q.totalAmount) + '</span>' +
          '</div>' +
          '</div>';
      }).join("");

      historyList.querySelectorAll("[data-history-id]").forEach(item => {
        item.onclick = () => {
          const quoteId = item.dataset.historyId;
          const quote = quoteHistory.find(q => q.id === quoteId);
          if (quote) {
            currentQuoteData = quote;
            currentQuoteItems = JSON.parse(JSON.stringify(quote.items || []));
            isQuoteEditing = false;
            renderQuoteDetail();
          }
        };
      });
    }

    function renderQuoteDetail() {
      const commission = commissions.find(c => c.id === currentQuoteCommissionId);
      if (!commission) return;

      document.getElementById("quoteCommissionName").textContent = commission.roleName;
      document.getElementById("quoteClientName").textContent = commission.client;
      document.getElementById("quoteDamage").textContent = commission.damage || "-";
      document.getElementById("quoteMissingParts").textContent = commission.missingParts || "-";
      document.getElementById("quoteColorNotes").textContent = commission.colorNotes || "-";
      document.getElementById("quoteReinforcement").textContent = commission.reinforcement || "-";

      if (currentQuoteData) {
        document.getElementById("quoteVersion").textContent = "第 " + currentQuoteData.version + " 版";
        const statusEl = document.getElementById("quoteStatus");
        statusEl.textContent = getStatusText(currentQuoteData.status);
        statusEl.className = "pill " + currentQuoteData.status;

        document.getElementById("quoteLaborCost").value = currentQuoteData.laborCost || 0;
        document.getElementById("quoteMaterialCost").value = currentQuoteData.materialCost || 0;
        document.getElementById("quoteEstimatedDays").value = currentQuoteData.estimatedDays || 0;
        document.getElementById("quoteRemark").value = currentQuoteData.remark || "";
      } else {
        document.getElementById("quoteVersion").textContent = "暂无";
        const statusEl = document.getElementById("quoteStatus");
        statusEl.textContent = "未报价";
        statusEl.className = "pill";
      }

      const addItemBtn = document.getElementById("addQuoteItemBtn");
      if (addItemBtn) addItemBtn.style.display = isQuoteEditing ? "inline-block" : "none";

      const inputs = ["quoteLaborCost", "quoteMaterialCost", "quoteEstimatedDays", "quoteRemark"];
      inputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !isQuoteEditing;
      });

      renderQuoteItems();
      renderQuoteHistory();

      const editActions = document.getElementById("quoteEditActions");
      const draftActions = document.getElementById("quoteDraftActions");
      const confirmedActions = document.getElementById("quoteConfirmedActions");
      const createQuoteBtn = document.getElementById("createQuoteBtn");

      if (!currentQuoteData) {
        if (editActions) editActions.style.display = "none";
        if (draftActions) draftActions.style.display = "none";
        if (confirmedActions) confirmedActions.style.display = "none";
        if (createQuoteBtn) createQuoteBtn.style.display = "inline-block";
      } else if (isQuoteEditing) {
        if (editActions) editActions.style.display = "flex";
        if (draftActions) draftActions.style.display = "none";
        if (confirmedActions) confirmedActions.style.display = "none";
        if (createQuoteBtn) createQuoteBtn.style.display = "none";
      } else if (currentQuoteData.status === "draft") {
        if (editActions) editActions.style.display = "none";
        if (draftActions) draftActions.style.display = "flex";
        if (confirmedActions) confirmedActions.style.display = "none";
        if (createQuoteBtn) createQuoteBtn.style.display = "none";
      } else if (currentQuoteData.status === "confirmed" || currentQuoteData.status === "superseded") {
        if (editActions) editActions.style.display = "none";
        if (draftActions) draftActions.style.display = "none";
        if (confirmedActions) confirmedActions.style.display = "flex";
        if (createQuoteBtn) createQuoteBtn.style.display = "none";
      }
    }

    async function loadQuoteData() {
      try {
        const data = await api("/api/commissions/" + currentQuoteCommissionId + "/quotes");
        quoteHistory = data.quotes || [];
        if (data.currentQuoteId) {
          currentQuoteData = quoteHistory.find(q => q.id === data.currentQuoteId) || null;
        } else {
          currentQuoteData = null;
        }
        if (currentQuoteData) {
          currentQuoteItems = JSON.parse(JSON.stringify(currentQuoteData.items || []));
        } else {
          currentQuoteItems = [];
        }
        isQuoteEditing = false;
        renderQuoteDetail();
      } catch (e) {
        alert("加载报价失败：" + e.message);
      }
    }

    async function openQuoteModal(commissionId) {
      currentQuoteCommissionId = commissionId;
      document.getElementById("quoteModal").classList.add("active");
      await loadQuoteData();
    }

    function closeQuoteModal() {
      document.getElementById("quoteModal").classList.remove("active");
      currentQuoteCommissionId = null;
      currentQuoteData = null;
      currentQuoteItems = [];
      isQuoteEditing = false;
      quoteHistory = [];
    }

    const DAMAGE_RULES = [
      { keywords: ["污渍", "灰尘", "霉斑", "发霉", "脏", "污垢", "尘垢"], level: "simple", basePrice: 150, label: "清洁除污" },
      { keywords: ["褪色", "变色", "发暗", "掉色", "失去光泽"], level: "simple", basePrice: 180, label: "色泽恢复" },
      { keywords: ["小裂", "微裂", "细纹", "裂纹", "裂痕", "轻微开裂"], level: "medium", basePrice: 250, label: "裂纹粘合" },
      { keywords: ["开裂", "撕裂", "撕开", "裂缝"], level: "medium", basePrice: 350, label: "开裂修复" },
      { keywords: ["破损", "破洞", "穿孔", "残缺"], level: "medium", basePrice: 400, label: "破损补片" },
      { keywords: ["断裂", "折断", "断开", "断成"], level: "complex", basePrice: 500, label: "断裂修复" },
      { keywords: ["缺角", "缺口", "边角缺损", "角缺失"], level: "complex", basePrice: 450, label: "缺角补片" },
      { keywords: ["磨损", "磨蚀", "磨破", "摩擦损耗"], level: "medium", basePrice: 300, label: "磨损修复" },
      { keywords: ["虫蛀", "蛀洞", "虫蚀", "鼠咬"], level: "complex", basePrice: 450, label: "虫蛀修复" },
      { keywords: ["变形", "翘曲", "起翘", "卷曲", "不平"], level: "medium", basePrice: 280, label: "平整校正" },
      { keywords: ["脱胶", "开胶", "脱层", "分层"], level: "simple", basePrice: 200, label: "脱胶重粘" }
    ];

    const SMALL_PART_KEYWORDS = ["珠", "饰珠", "珍珠", "扣", "铆钉", "钉", "小饰", "流苏", "穗", "线", "绳"];
    const MEDIUM_PART_KEYWORDS = ["头饰", "发饰", "帽子", "冠", "簪", "钗", "环", "佩", "带", "腰带", "衣袖", "袖口", "领"];
    const LARGE_PART_KEYWORDS = ["靠旗", "旗杆", "兵器", "武器", "扇子", "折扇", "伞", "车", "马", "座椅", "大型装饰"];

    function parseChineseNumber(str) {
      const map = { "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "百": 100, "千": 1000 };
      let n = 0, temp = 0;
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (map[c] !== undefined) {
          if (map[c] >= 100) {
            temp = (temp || 1) * map[c];
            n += temp; temp = 0;
          } else if (map[c] >= 10) {
            temp = (temp || 1) * map[c];
          } else {
            temp = map[c];
          }
        }
      }
      return n + temp || 0;
    }

    function parseQuantity(text) {
      if (!text) return 1;
      const unitChars = ["个", "粒", "颗", "件", "片", "块", "只", "条", "根", "副", "套", "组"];
      const hasUnit = unitChars.some(u => text.includes(u));
      if (!hasUnit) return 1;
      const digits = "0123456789";
      let digitStr = "";
      for (const c of text) {
        if (digits.includes(c)) digitStr += c;
      }
      if (digitStr) return parseInt(digitStr);
      const vagueQtyWords = ["数", "若干", "多", "几个", "数个"];
      for (const w of vagueQtyWords) {
        if (text.includes(w)) return 3;
      }
      const cnNums = ["一", "二", "两", "三", "四", "五", "六", "七", "八", "九", "十"];
      let foundCn = "";
      for (const c of text) {
        if (cnNums.includes(c) || c === "百" || c === "千") {
          foundCn += c;
        }
      }
      if (foundCn) return parseChineseNumber(foundCn) || 1;
      return 1;
    }

    function classifyPartSize(desc) {
      if (!desc) return { size: "medium", price: 120 };
      for (const kw of LARGE_PART_KEYWORDS) {
        if (desc.includes(kw)) return { size: "large", price: 300 };
      }
      for (const kw of SMALL_PART_KEYWORDS) {
        if (desc.includes(kw)) return { size: "small", price: 50 };
      }
      for (const kw of MEDIUM_PART_KEYWORDS) {
        if (desc.includes(kw)) return { size: "medium", price: 150 };
      }
      return { size: "medium", price: 120 };
    }

    const COLOR_RULES = [
      { keywords: ["局部", "小面积", "点补", "小范围", "局部补"], level: "partial", basePrice: 80, perColor: 40 },
      { keywords: ["大面积", "较多", "范围大", "大块", "大片"], level: "large", basePrice: 200, perColor: 80 },
      { keywords: ["重绘", "全部", "整套", "整体重绘", "全面"], level: "full", basePrice: 400, perColor: 120 }
    ];
    const SPECIAL_PIGMENT_MARKUP = ["矿物", "石青", "石绿", "朱砂", "石黄", "雄黄", "靛蓝", "天然"];

    const REINFORCE_RULES = [
      { keywords: ["骨胶"], name: "骨胶加固", basePrice: 80 },
      { keywords: ["鱼鳔胶", "鱼胶"], name: "鱼鳔胶加固", basePrice: 120 },
      { keywords: ["托裱", "裱褙", "装裱"], name: "托裱加固", basePrice: 250 },
      { keywords: ["衬纸", "内衬", "纸衬"], name: "衬纸加固", basePrice: 150 },
      { keywords: ["绢", "绫", "锦绫"], name: "绢绫托裱", basePrice: 350 },
      { keywords: ["丝线", "线缝", "缝线", "缝制"], name: "缝线加固", basePrice: 100 }
    ];

    const MATERIAL_PRICE_MAP = {
      "薄驴皮补片": { unit: 180, type: "repair" },
      "朱砂矿物颜料": { unit: 80, type: "pigment" },
      "石黄矿物颜料": { unit: 60, type: "pigment" },
      "鱼鳔胶": { unit: 50, type: "adhesive" },
      "骨胶": { unit: 30, type: "adhesive" }
    };

    function splitTextSmart(text) {
      if (!text) return [];
      const SEP = "__SPLIT_MARK__";
      let normalized = text.split("\\r").join(SEP).split("\\n").join(SEP);
      const separators = [",", "，", "。", "、", ";", "；"];
      for (const s of separators) {
        normalized = normalized.split(s).join(SEP);
      }
      return normalized.split(SEP).filter(p => p.trim());
    }

    function analyzeDamage(damageText) {
      const items = [];
      let totalDays = 0;
      if (!damageText || damageText === "-") return { items, totalDays };

      const parts = splitTextSmart(damageText);
      for (const part of parts) {
        const text = part.trim();
        if (!text) continue;
        let matched = null;
        for (const rule of DAMAGE_RULES) {
          if (rule.keywords.some(kw => text.includes(kw))) {
            matched = rule;
            break;
          }
        }
        if (matched) {
          items.push({
            description: text + matched.label,
            quantity: 1,
            unitPrice: matched.basePrice,
            amount: matched.basePrice
          });
          totalDays += matched.level === "simple" ? 1 : matched.level === "medium" ? 2 : 3;
        } else {
          items.push({
            description: text + "修复",
            quantity: 1,
            unitPrice: 250,
            amount: 250
          });
          totalDays += 2;
        }
      }
      return { items, totalDays };
    }

    function analyzeMissingParts(missingText) {
      const items = [];
      let materialCost = 0;
      let totalDays = 0;
      if (!missingText || missingText === "-") return { items, materialCost, totalDays };

      const parts = splitTextSmart(missingText);
      for (const part of parts) {
        const text = part.trim();
        if (!text) continue;
        const qty = parseQuantity(text);
        const { size, price } = classifyPartSize(text);
        const unitPrice = price;
        const amount = qty * unitPrice;
        items.push({
          description: text + "配补",
          quantity: qty,
          unitPrice: unitPrice,
          amount: amount
        });
        materialCost += Math.round(amount * 0.35);
        totalDays += size === "small" ? 1 : size === "medium" ? 2 : 3;
      }
      return { items, materialCost, totalDays };
    }

    function analyzeColorNotes(colorText) {
      const items = [];
      let materialCost = 0;
      let totalDays = 0;
      if (!colorText || colorText === "-") return { items, materialCost, totalDays };

      const parts = splitTextSmart(colorText);
      for (const part of parts) {
        const text = part.trim();
        if (!text) continue;
        let matched = null;
        for (const rule of COLOR_RULES) {
          if (rule.keywords.some(kw => text.includes(kw))) {
            matched = rule;
            break;
          }
        }
        if (!matched) matched = COLOR_RULES[0];
        let price = matched.basePrice;
        const hasSpecial = SPECIAL_PIGMENT_MARKUP.some(kw => text.includes(kw));
        if (hasSpecial) price = Math.round(price * 1.4);
        const colorKeywords = ["石青", "石绿", "朱砂", "石黄", "雄黄", "靛蓝", "红", "绿", "蓝", "黄", "黑", "白", "紫", "粉", "金", "银"];
        const colorCount = colorKeywords.filter(kw => text.includes(kw)).length;
        if (colorCount > 1) price += (colorCount - 1) * matched.perColor;
        items.push({
          description: text + "补色",
          quantity: 1,
          unitPrice: price,
          amount: price
        });
        materialCost += Math.round(price * 0.4);
        totalDays += matched.level === "partial" ? 1 : matched.level === "large" ? 3 : 5;
      }
      return { items, materialCost, totalDays };
    }

    function analyzeReinforcement(reinforceText, materialsArr) {
      const items = [];
      let materialCost = 0;
      let totalDays = 0;
      if ((!reinforceText || reinforceText === "-") && (!materialsArr || materialsArr.length === 0)) {
        return { items, materialCost, totalDays };
      }
      if (reinforceText && reinforceText !== "-") {
        const parts = splitTextSmart(reinforceText);
        for (const part of parts) {
          const text = part.trim();
          if (!text) continue;
          let matched = null;
          for (const rule of REINFORCE_RULES) {
            if (rule.keywords.some(kw => text.includes(kw))) {
              matched = rule;
              break;
            }
          }
          if (matched) {
            items.push({
              description: matched.name,
              quantity: 1,
              unitPrice: matched.basePrice,
              amount: matched.basePrice
            });
            materialCost += Math.round(matched.basePrice * 0.45);
            totalDays += matched.basePrice >= 250 ? 2 : 1;
          } else {
            items.push({
              description: text + "加固",
              quantity: 1,
              unitPrice: 120,
              amount: 120
            });
            materialCost += 50;
            totalDays += 1;
          }
        }
      }
      if (materialsArr && materialsArr.length > 0) {
        for (const mat of materialsArr) {
          const info = MATERIAL_PRICE_MAP[mat.name] || { unit: 50 };
          const matCost = info.unit * (mat.quantity || 1);
          materialCost += matCost;
        }
      }
      return { items, materialCost, totalDays };
    }

    function generateSmartQuote(commission) {
      const allItems = [];
      let totalMaterialCost = 0;
      let totalBaseDays = 0;

      const damageResult = analyzeDamage(commission.damage);
      allItems.push(...damageResult.items);
      totalBaseDays += damageResult.totalDays;

      const missingResult = analyzeMissingParts(commission.missingParts);
      allItems.push(...missingResult.items);
      totalMaterialCost += missingResult.materialCost;
      totalBaseDays += missingResult.totalDays;

      const colorResult = analyzeColorNotes(commission.colorNotes);
      allItems.push(...colorResult.items);
      totalMaterialCost += colorResult.materialCost;
      totalBaseDays += colorResult.totalDays;

      const reinforceResult = analyzeReinforcement(commission.reinforcement, commission.materials);
      allItems.push(...reinforceResult.items);
      totalMaterialCost += reinforceResult.materialCost;
      totalBaseDays += reinforceResult.totalDays;

      const itemsSum = allItems.reduce((s, it) => s + it.amount, 0);
      const projectLaborCost = Math.round(itemsSum * 0.5);

      const dailyLaborRate = 120;
      const estimatedDays = Math.max(3, Math.min(30, totalBaseDays + (commission.dueDate ? 0 : 2)));
      const durationLaborCost = estimatedDays * dailyLaborRate;

      const laborCost = projectLaborCost + durationLaborCost;
      const baseItemMaterialCost = Math.round(itemsSum * 0.2);
      const materialCost = baseItemMaterialCost + totalMaterialCost;

      let itemIdCounter = 0;
      const finalItems = allItems.map(it => ({
        id: "QI-auto-" + Date.now() + "-" + (itemIdCounter++),
        description: it.description,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        amount: it.amount
      }));

      const remarkLines = [];
      if (commission.damage && commission.damage !== "-") remarkLines.push("破损修复");
      if (commission.missingParts && commission.missingParts !== "-") remarkLines.push("缺失零件配补");
      if (commission.colorNotes && commission.colorNotes !== "-") remarkLines.push("补色重绘");
      if (commission.reinforcement && commission.reinforcement !== "-") remarkLines.push("加固处理");
      remarkLines.push("含人工及材料");

      return {
        items: finalItems,
        laborCost: laborCost,
        materialCost: materialCost,
        estimatedDays: estimatedDays,
        remark: remarkLines.join("、") + "，工期约" + estimatedDays + "天"
      };
    }

    async function createFirstQuote() {
      const commission = commissions.find(c => c.id === currentQuoteCommissionId);
      if (!commission) return;

      const quoteData = generateSmartQuote(commission);

      try {
        const newQuote = await api("/api/commissions/" + currentQuoteCommissionId + "/quotes", {
          method: "POST",
          body: JSON.stringify(quoteData)
        });
        await loadQuoteData();
        isQuoteEditing = true;
        renderQuoteDetail();
        await loadAll();
      } catch (e) {
        alert("创建报价失败：" + e.message);
      }
    }

    async function saveQuote() {
      if (!currentQuoteData) return;

      const totals = calculateQuoteTotals();

      try {
        const updated = await api("/api/commissions/" + currentQuoteCommissionId + "/quotes/" + currentQuoteData.id, {
          method: "PUT",
          body: JSON.stringify({
            items: currentQuoteItems,
            laborCost: totals.laborCost,
            materialCost: totals.materialCost,
            totalAmount: totals.total,
            estimatedDays: Number(document.getElementById("quoteEstimatedDays").value) || 0,
            remark: document.getElementById("quoteRemark").value || ""
          })
        });
        currentQuoteData = updated;
        currentQuoteItems = JSON.parse(JSON.stringify(updated.items || []));
        isQuoteEditing = false;
        await loadQuoteData();
        alert("报价已保存");
      } catch (e) {
        alert("保存报价失败：" + e.message);
      }
    }

    async function confirmQuote() {
      if (!currentQuoteData) return;
      if (!confirm("确认报价后将无法直接编辑，需要重新报价才能修改。确定确认吗？")) return;

      try {
        const confirmed = await api("/api/commissions/" + currentQuoteCommissionId + "/quotes/" + currentQuoteData.id + "/confirm", {
          method: "POST"
        });
        currentQuoteData = confirmed;
        await loadQuoteData();
        alert("报价已确认");
        await loadAll();
      } catch (e) {
        alert("确认报价失败：" + e.message);
      }
    }

    async function reviseQuote() {
      if (!currentQuoteData) return;
      if (!confirm("将基于当前报价创建新版本，旧版本将保留。确定重新报价吗？")) return;

      try {
        const newQuote = await api("/api/commissions/" + currentQuoteCommissionId + "/quotes/" + currentQuoteData.id + "/revise", {
          method: "POST"
        });
        currentQuoteData = newQuote;
        currentQuoteItems = JSON.parse(JSON.stringify(newQuote.items || []));
        isQuoteEditing = true;
        await loadQuoteData();
        await loadAll();
      } catch (e) {
        alert("重新报价失败：" + e.message);
      }
    }

    function addQuoteItem() {
      currentQuoteItems.push({
        id: "QI-new-" + Date.now(),
        description: "",
        quantity: 1,
        unitPrice: 0,
        amount: 0
      });
      renderQuoteItems();
      calculateQuoteTotals();
    }

    function startEditQuote() {
      isQuoteEditing = true;
      renderQuoteDetail();
    }

    function cancelEditQuote() {
      if (currentQuoteData) {
        currentQuoteItems = JSON.parse(JSON.stringify(currentQuoteData.items || []));
      }
      isQuoteEditing = false;
      renderQuoteDetail();
    }

    document.getElementById("quoteModalClose").onclick = closeQuoteModal;
    document.getElementById("quoteCloseBtn").onclick = closeQuoteModal;
    document.getElementById("quoteModal").onclick = (e) => {
      if (e.target.id === "quoteModal") closeQuoteModal();
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.getElementById("quoteModal").classList.contains("active")) {
        closeQuoteModal();
      }
    });

    const addQuoteItemBtn = document.getElementById("addQuoteItemBtn");
    if (addQuoteItemBtn) addQuoteItemBtn.onclick = addQuoteItem;

    const quoteEditBtn = document.getElementById("quoteEditBtn");
    if (quoteEditBtn) quoteEditBtn.onclick = startEditQuote;

    const quoteSaveBtn = document.getElementById("quoteSaveBtn");
    if (quoteSaveBtn) quoteSaveBtn.onclick = saveQuote;

    const quoteCancelEditBtn = document.getElementById("quoteCancelEditBtn");
    if (quoteCancelEditBtn) quoteCancelEditBtn.onclick = cancelEditQuote;

    const quoteConfirmBtn = document.getElementById("quoteConfirmBtn");
    if (quoteConfirmBtn) quoteConfirmBtn.onclick = confirmQuote;

    const quoteReviseBtn = document.getElementById("quoteReviseBtn");
    if (quoteReviseBtn) quoteReviseBtn.onclick = reviseQuote;

    const createQuoteBtn = document.getElementById("createQuoteBtn");
    if (createQuoteBtn) createQuoteBtn.onclick = createFirstQuote;

    ["quoteLaborCost", "quoteMaterialCost"].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.oninput = calculateQuoteTotals;
      }
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

    if (req.method === "GET" && url.pathname === "/api/commissions/export") {
      const exportData = {
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        count: db.commissions.length,
        commissions: db.commissions
      };
      const filename = `shadow-puppet-commissions-${new Date().toISOString().slice(0, 10)}.json`;
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`
      });
      return res.end(JSON.stringify(exportData, null, 2));
    }

    if (req.method === "POST" && url.pathname === "/api/commissions/import/preview") {
      const input = await body(req);
      const importedData = Array.isArray(input) ? input : (input.commissions || []);
      
      if (!Array.isArray(importedData)) {
        return sendJson(res, 400, { error: "导入数据格式错误，需要是数组或包含commissions字段的对象" });
      }

      const allSteps = new Set();
      db.stepTemplates.forEach(t => t.steps.forEach(s => allSteps.add(s)));
      defaultSteps.forEach(s => allSteps.add(s));

      const preview = {
        total: importedData.length,
        categories: {
          new: [],
          duplicate: [],
          missingFields: [],
          invalidSteps: [],
          valid: []
        },
        items: []
      };

      for (let i = 0; i < importedData.length; i++) {
        const item = importedData[i];
        const issues = validateCommission(item, db.commissions, allSteps);
        
        const categories = [];
        const hasNotAnObject = issues.some(issue => issue.type === "notAnObject");
        const hasBlockingIssues = hasNotAnObject || issues.some(issue => 
          issue.type === "missingFields" || 
          issue.type === "invalidStep" || 
          issue.type === "invalidRecordStep" ||
          issue.type === "invalidDateFormat" ||
          issue.type === "emptySteps" ||
          issue.type === "invalidRecordDate" ||
          issue.type === "invalidMaterialQuantity"
        );

        if (hasNotAnObject) {
          categories.push("invalidSteps");
          preview.categories.invalidSteps.push(i);
        } else if (!hasBlockingIssues) {
          const hasDuplicate = issues.some(issue => issue.type === "duplicate");
          if (hasDuplicate) {
            categories.push("duplicate");
            preview.categories.duplicate.push(i);
          } else {
            categories.push("new");
            preview.categories.new.push(i);
          }
        } else {
          for (const issue of issues) {
            if (issue.type === "duplicate") {
              if (!categories.includes("duplicate")) {
                categories.push("duplicate");
                preview.categories.duplicate.push(i);
              }
            }
            if (issue.type === "missingFields") {
              if (!categories.includes("missingFields")) {
                categories.push("missingFields");
                preview.categories.missingFields.push(i);
              }
            }
            if (issue.type === "invalidStep" || 
                issue.type === "invalidRecordStep" ||
                issue.type === "invalidDateFormat" ||
                issue.type === "emptySteps" ||
                issue.type === "invalidRecordDate" ||
                issue.type === "invalidMaterialQuantity") {
              if (!categories.includes("invalidSteps")) {
                categories.push("invalidSteps");
                preview.categories.invalidSteps.push(i);
              }
            }
          }
        }

        if (categories.length === 0) {
          categories.push("valid");
          preview.categories.valid.push(i);
        }

        const safeData = hasNotAnObject ? { _raw: String(item) } : item;
        preview.items.push({
          index: i,
          data: safeData,
          categories,
          issues
        });
      }

      preview.categories.new = [...new Set(preview.categories.new)];
      preview.categories.duplicate = [...new Set(preview.categories.duplicate)];
      preview.categories.missingFields = [...new Set(preview.categories.missingFields)];
      preview.categories.invalidSteps = [...new Set(preview.categories.invalidSteps)];

      return sendJson(res, 200, preview);
    }

    if (req.method === "POST" && url.pathname === "/api/commissions/import") {
      const input = await body(req);
      const itemsToImport = Array.isArray(input) ? input : (input.items || []);
      
      if (!Array.isArray(itemsToImport) || itemsToImport.length === 0) {
        return sendJson(res, 400, { error: "没有可导入的数据" });
      }

      const allSteps = new Set();
      db.stepTemplates.forEach(t => t.steps.forEach(s => allSteps.add(s)));
      defaultSteps.forEach(s => allSteps.add(s));

      const dbCopy = deepClone(db);
      const newCommissions = [];
      const processedIds = new Set();
      let importError = null;

      try {
        for (const item of itemsToImport) {
          if (!item.data) continue;

          const issues = validateCommission(item.data, dbCopy.commissions, allSteps);
          const hasBlockingIssues = issues.some(issue => 
            issue.type === "notAnObject" ||
            issue.type === "missingFields" || 
            issue.type === "invalidStep" || 
            issue.type === "invalidRecordStep" ||
            issue.type === "invalidDateFormat" ||
            issue.type === "emptySteps" ||
            issue.type === "invalidRecordDate" ||
            issue.type === "invalidMaterialQuantity"
          );

          if (hasBlockingIssues) {
            continue;
          }

          const isDuplicate = issues.some(issue => issue.type === "duplicate");
          if (isDuplicate && !item.forceOverwrite) {
            continue;
          }

          const c = item.data;
          let clientId = c.clientId || "";
          let clientName = c.client || "";

          if (clientId) {
            const existingClient = dbCopy.clients.find(cl => cl.id === clientId);
            if (existingClient) clientName = existingClient.name;
          } else if (clientName) {
            const existingClient = dbCopy.clients.find(cl => cl.name === clientName);
            if (existingClient) {
              clientId = existingClient.id;
              clientName = existingClient.name;
            } else {
              const newClient = {
                id: `CL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                name: clientName,
                contact: c.clientContact || "",
                phone: c.clientPhone || "",
                address: c.clientAddress || "",
                remark: ""
              };
              dbCopy.clients.unshift(newClient);
              clientId = newClient.id;
            }
          }

          let commissionSteps = c.steps && Array.isArray(c.steps) && c.steps.length ? [...c.steps] : [...defaultSteps];
          const firstStep = commissionSteps[0];
          const currentStatus = c.status && commissionSteps.includes(c.status) ? c.status : firstStep;

          const selectedMaterials = [];
          if (Array.isArray(c.materials)) {
            for (const m of c.materials) {
              const mat = m.materialId ? dbCopy.materials.find(item => item.id === m.materialId) : null;
              if (mat && m.quantity > 0) {
                if (mat.stock >= m.quantity) {
                  selectedMaterials.push({
                    materialId: mat.id,
                    name: mat.name,
                    batch: mat.batch,
                    quantity: m.quantity
                  });
                }
              } else if (m.name && m.quantity > 0) {
                selectedMaterials.push({
                  materialId: m.materialId || "",
                  name: m.name,
                  batch: m.batch || "",
                  quantity: m.quantity
                });
              }
            }
          }

          let newId;
          if (isDuplicate && item.forceOverwrite) {
            const dupIssue = issues.find(issue => issue.type === "duplicate");
            newId = dupIssue.existingId;
            const existingIdx = dbCopy.commissions.findIndex(com => com.id === newId);
            if (existingIdx !== -1) {
              processedIds.add(newId);
              const existing = dbCopy.commissions[existingIdx];
              const commission = {
                ...existing,
                clientId,
                client: clientName,
                roleName: c.roleName || existing.roleName,
                era: c.era || existing.era,
                damage: c.damage || existing.damage,
                missingParts: c.missingParts !== undefined ? c.missingParts : existing.missingParts,
                colorNotes: c.colorNotes !== undefined ? c.colorNotes : existing.colorNotes,
                reinforcement: c.reinforcement !== undefined ? c.reinforcement : existing.reinforcement,
                materials: selectedMaterials.length > 0 ? selectedMaterials : existing.materials,
                owner: c.owner || existing.owner,
                dueDate: c.dueDate || existing.dueDate,
                status: currentStatus,
                steps: commissionSteps,
                templateId: c.templateId || existing.templateId,
                templateName: c.templateName || existing.templateName,
                records: c.records && Array.isArray(c.records) ? c.records : existing.records,
                images: c.images || existing.images
              };
              dbCopy.commissions[existingIdx] = commission;
              newCommissions.push(commission);
              continue;
            }
          }

          newId = `SP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          while (processedIds.has(newId) || dbCopy.commissions.some(com => com.id === newId)) {
            newId = `SP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          }
          processedIds.add(newId);

          const records = c.records && Array.isArray(c.records) && c.records.length > 0
            ? c.records
            : [{ at: new Date().toISOString(), step: firstStep, note: "导入委托" }];

          const commission = {
            id: newId,
            clientId,
            client: clientName,
            roleName: c.roleName,
            era: c.era,
            damage: c.damage,
            missingParts: c.missingParts || "",
            colorNotes: c.colorNotes || "",
            reinforcement: c.reinforcement || "",
            materials: selectedMaterials,
            owner: c.owner,
            dueDate: c.dueDate,
            status: currentStatus,
            steps: commissionSteps,
            templateId: c.templateId || "",
            templateName: c.templateName || "",
            records,
            images: c.images || { before: [], during: [], after: [] }
          };

          for (const m of selectedMaterials) {
            if (m.materialId) {
              const mat = dbCopy.materials.find(item => item.id === m.materialId);
              if (mat) mat.stock = Math.max(0, mat.stock - m.quantity);
            }
          }

          dbCopy.commissions.unshift(commission);
          newCommissions.push(commission);
        }

        await saveDbAtomic(dbCopy);

        for (const key of Object.keys(db)) {
          delete db[key];
        }
        for (const key of Object.keys(dbCopy)) {
          db[key] = dbCopy[key];
        }

        return sendJson(res, 200, {
          success: true,
          imported: newCommissions.length,
          total: itemsToImport.length,
          commissions: newCommissions
        });
      } catch (error) {
        importError = error;
        return sendJson(res, 500, { error: "导入失败，现有数据未被修改：" + error.message });
      }
    }
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
      const commission = { id: `SP-${Date.now()}`, clientId, client: clientName, roleName: input.roleName, era: input.era, damage: input.damage, missingParts: input.missingParts || "", colorNotes: input.colorNotes || "", reinforcement: input.reinforcement || "", materials: selectedMaterials, owner: input.owner, dueDate: input.dueDate, status: firstStep, steps: commissionSteps, templateId: input.templateId || "", templateName: input.templateId ? (db.stepTemplates.find(t => t.id === input.templateId)?.name || "") : "", records: [{ at: new Date().toISOString(), step: firstStep, note: "登记委托" }], images: { before: [], during: [], after: [] }, quotes: [], currentQuoteId: "" };
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

    const quotesListMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/quotes$/);
    if (quotesListMatch && req.method === "GET") {
      const commission = db.commissions.find(c => c.id === quotesListMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      return sendJson(res, 200, {
        quotes: commission.quotes || [],
        currentQuoteId: commission.currentQuoteId || ""
      });
    }

    if (quotesListMatch && req.method === "POST") {
      const commission = db.commissions.find(c => c.id === quotesListMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const input = await body(req);

      const items = Array.isArray(input.items) ? input.items.map((item, idx) => ({
        id: `QI-${Date.now()}-${idx}`,
        description: item.description || "",
        quantity: Number(item.quantity) || 0,
        unitPrice: Number(item.unitPrice) || 0,
        amount: Number(item.amount) || 0
      })) : [];

      const laborCost = Number(input.laborCost) || 0;
      const materialCost = Number(input.materialCost) || 0;
      const totalAmount = Number(input.totalAmount) || items.reduce((sum, item) => sum + item.amount, 0) + laborCost + materialCost;

      const quote = {
        id: `Q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        version: (commission.quotes?.length || 0) + 1,
        status: "draft",
        items,
        laborCost,
        materialCost,
        totalAmount,
        estimatedDays: Number(input.estimatedDays) || 0,
        remark: input.remark || "",
        createdAt: new Date().toISOString(),
        confirmedAt: null,
        createdBy: input.createdBy || "",
        previousVersionId: input.previousVersionId || ""
      };

      if (!commission.quotes) commission.quotes = [];
      commission.quotes.push(quote);
      commission.currentQuoteId = quote.id;

      await saveDb(db);
      return sendJson(res, 201, quote);
    }

    const quoteDetailMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/quotes\/([^/]+)$/);
    if (quoteDetailMatch && req.method === "GET") {
      const commission = db.commissions.find(c => c.id === quoteDetailMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const quote = commission.quotes?.find(q => q.id === quoteDetailMatch[2]);
      if (!quote) return sendJson(res, 404, { error: "quote_not_found" });
      return sendJson(res, 200, quote);
    }

    if (quoteDetailMatch && req.method === "PUT") {
      const commission = db.commissions.find(c => c.id === quoteDetailMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const quote = commission.quotes?.find(q => q.id === quoteDetailMatch[2]);
      if (!quote) return sendJson(res, 404, { error: "quote_not_found" });
      if (quote.status !== "draft") {
        return sendJson(res, 400, { error: "only_draft_can_be_edited", message: "只有草稿状态的报价才能编辑" });
      }

      const input = await body(req);

      if (Array.isArray(input.items)) {
        quote.items = input.items.map((item, idx) => ({
          id: item.id || `QI-${Date.now()}-${idx}`,
          description: item.description || "",
          quantity: Number(item.quantity) || 0,
          unitPrice: Number(item.unitPrice) || 0,
          amount: Number(item.amount) || 0
        }));
      }
      if (input.laborCost !== undefined) quote.laborCost = Number(input.laborCost) || 0;
      if (input.materialCost !== undefined) quote.materialCost = Number(input.materialCost) || 0;
      if (input.estimatedDays !== undefined) quote.estimatedDays = Number(input.estimatedDays) || 0;
      if (input.remark !== undefined) quote.remark = input.remark || "";

      if (input.totalAmount !== undefined) {
        quote.totalAmount = Number(input.totalAmount) || 0;
      } else {
        quote.totalAmount = quote.items.reduce((sum, item) => sum + item.amount, 0) + quote.laborCost + quote.materialCost;
      }

      await saveDb(db);
      return sendJson(res, 200, quote);
    }

    const quoteConfirmMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/quotes\/([^/]+)\/confirm$/);
    if (quoteConfirmMatch && req.method === "POST") {
      const commission = db.commissions.find(c => c.id === quoteConfirmMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const quote = commission.quotes?.find(q => q.id === quoteConfirmMatch[2]);
      if (!quote) return sendJson(res, 404, { error: "quote_not_found" });
      if (quote.status !== "draft") {
        return sendJson(res, 400, { error: "only_draft_can_be_confirmed", message: "只有草稿状态的报价才能确认" });
      }

      quote.status = "confirmed";
      quote.confirmedAt = new Date().toISOString();

      commission.currentQuoteId = quote.id;

      await saveDb(db);
      return sendJson(res, 200, quote);
    }

    const quoteReviseMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/quotes\/([^/]+)\/revise$/);
    if (quoteReviseMatch && req.method === "POST") {
      const commission = db.commissions.find(c => c.id === quoteReviseMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const oldQuote = commission.quotes?.find(q => q.id === quoteReviseMatch[2]);
      if (!oldQuote) return sendJson(res, 404, { error: "quote_not_found" });

      if (oldQuote.status === "confirmed") {
        oldQuote.status = "superseded";
      }

      const newQuote = {
        id: `Q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        version: (commission.quotes?.length || 0) + 1,
        status: "draft",
        items: oldQuote.items.map(item => ({ ...item, id: `QI-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` })),
        laborCost: oldQuote.laborCost,
        materialCost: oldQuote.materialCost,
        totalAmount: oldQuote.totalAmount,
        estimatedDays: oldQuote.estimatedDays,
        remark: oldQuote.remark,
        createdAt: new Date().toISOString(),
        confirmedAt: null,
        createdBy: "",
        previousVersionId: oldQuote.id
      };

      commission.quotes.push(newQuote);
      commission.currentQuoteId = newQuote.id;

      await saveDb(db);
      return sendJson(res, 201, newQuote);
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
