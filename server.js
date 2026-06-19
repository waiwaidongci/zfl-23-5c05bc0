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
const DEFAULT_CONSUME_STEP_NAME = "补片";

const requiredCommissionFields = ["roleName", "era", "damage", "owner", "dueDate"];
const snapshotTrackedFields = ["roleName", "era", "damage", "missingParts", "colorNotes", "reinforcement", "owner", "dueDate", "status", "client"];

const STOCK_LEDGER_TYPES = {
  RESERVE: "reserve",
  RELEASE_RESERVE: "release_reserve",
  ADJUST_RESERVE: "adjust_reserve",
  CONSUME: "consume",
  RESTORE: "restore",
  MANUAL_IN: "manual_in",
  MANUAL_OUT: "manual_out",
  INIT: "init",
  IMPORT_RESERVE: "import_reserve",
  IMPORT_CONSUME: "import_consume",
  UNDO_CONSUME: "undo_consume"
};

const STOCK_LEDGER_LABELS = {
  reserve: "占用",
  release_reserve: "释放占用",
  adjust_reserve: "调整占用",
  consume: "实际消耗/出库",
  restore: "退回/恢复",
  manual_in: "入库",
  manual_out: "出库",
  init: "初始库存",
  import_reserve: "导入-占用",
  import_consume: "导入-已消耗",
  undo_consume: "撤销消耗"
};

function createFieldSnapshot(commission, operator, operatorId, reason) {
  const snapshot = {};
  for (const field of snapshotTrackedFields) {
    snapshot[field] = commission[field] !== undefined ? commission[field] : "";
  }
  snapshot.materials = Array.isArray(commission.materials) ? JSON.parse(JSON.stringify(commission.materials)) : [];
  return {
    id: `SNAP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fields: snapshot,
    operator: operator || "未知",
    operatorId: operatorId || "",
    reason: reason || "",
    at: new Date().toISOString()
  };
}

function createStockLedgerEntry({ materialId, materialName, batch, type, quantity, stockBefore, stockAfter, reservedBefore, reservedAfter, commissionId, commissionName, step, operator, operatorId, note }) {
  return {
    id: `LEDGER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    materialId: materialId || "",
    materialName: materialName || "",
    batch: batch || "",
    type: type || "",
    quantity: Number(quantity) || 0,
    stockBefore: Number(stockBefore) || 0,
    stockAfter: Number(stockAfter) || 0,
    reservedBefore: Number(reservedBefore) || 0,
    reservedAfter: Number(reservedAfter) || 0,
    commissionId: commissionId || "",
    commissionName: commissionName || "",
    step: step || "",
    operator: operator || "未知",
    operatorId: operatorId || "",
    note: note || "",
    at: new Date().toISOString()
  };
}

function ensureStockLedger(db) {
  if (!db || typeof db !== "object") return;
  if (!Array.isArray(db.stockLedger)) {
    db.stockLedger = [];
  }
}

function addStockLedger(db, entry) {
  ensureStockLedger(db);
  db.stockLedger.unshift(entry);
}

function getMaterialAvailable(material) {
  if (!material) return 0;
  const stock = Number(material.stock) || 0;
  const reserved = Number(material.reserved) || 0;
  return Math.max(0, stock - reserved);
}

function reserveCommissionMaterials(db, commission, operator, operatorId) {
  if (!commission || !Array.isArray(commission.materials)) return;
  const commissionSteps = commission.steps && commission.steps.length ? commission.steps : defaultSteps;
  const currentIdx = commissionSteps.indexOf(commission.status);
  const consumeStepName = commission.consumeStepName || DEFAULT_CONSUME_STEP_NAME;
  const consumeIdx = commissionSteps.indexOf(consumeStepName);
  const alreadyPassedConsume = consumeIdx !== -1 && currentIdx >= consumeIdx;

  for (const m of commission.materials) {
    const mat = db.materials.find(item => item.id === m.materialId);
    if (!mat) continue;
    const qty = Number(m.quantity) || 0;
    if (qty <= 0) continue;

    const stockBefore = Number(mat.stock) || 0;
    const reservedBefore = Number(mat.reserved) || 0;

    if (alreadyPassedConsume || (commission.acceptance && commission.acceptance.result)) {
      if (mat.stock < qty) throw new Error(`材料 ${mat.name} 库存不足，当前库存 ${stockBefore}${mat.unit}`);
      mat.stock = stockBefore - qty;
      m.consumedQty = qty;
      m.reservedQty = 0;
      m.consumedAt = new Date().toISOString();
      m.consumedBy = operator || "系统";
      m.consumedStep = consumeStepName;
      addStockLedger(db, createStockLedgerEntry({
        materialId: mat.id, materialName: mat.name, batch: mat.batch,
        type: STOCK_LEDGER_TYPES.CONSUME, quantity: qty,
        stockBefore, stockAfter: mat.stock,
        reservedBefore, reservedAfter: reservedBefore,
        commissionId: commission.id, commissionName: commission.roleName,
        step: commission.status, operator, operatorId,
        note: `委托创建时已超过消耗节点，直接出库消耗`
      }));
    } else {
      const available = stockBefore - reservedBefore;
      if (available < qty) throw new Error(`材料 ${mat.name} 可用量不足，可用 ${available}${mat.unit}（总库存 ${stockBefore}${mat.unit}，已占用 ${reservedBefore}${mat.unit}）`);
      mat.reserved = reservedBefore + qty;
      m.reservedQty = qty;
      m.consumedQty = 0;
      addStockLedger(db, createStockLedgerEntry({
        materialId: mat.id, materialName: mat.name, batch: mat.batch,
        type: STOCK_LEDGER_TYPES.RESERVE, quantity: qty,
        stockBefore, stockAfter: stockBefore,
        reservedBefore, reservedAfter: mat.reserved,
        commissionId: commission.id, commissionName: commission.roleName,
        step: commission.status, operator, operatorId,
        note: `委托创建占用`
      }));
    }
  }
}

function releaseCommissionMaterials(db, commission, operator, operatorId, reason) {
  if (!commission || !Array.isArray(commission.materials)) return;
  for (const m of commission.materials) {
    const mat = db.materials.find(item => item.id === m.materialId);
    if (!mat) continue;
    const reservedQty = Number(m.reservedQty) || 0;
    const consumedQty = Number(m.consumedQty) || 0;
    const stockBefore = Number(mat.stock) || 0;
    const reservedBefore = Number(mat.reserved) || 0;

    if (consumedQty > 0) {
      mat.stock = stockBefore + consumedQty;
      m.consumedQty = 0;
      m.consumedAt = "";
      m.consumedBy = "";
      m.consumedStep = "";
      addStockLedger(db, createStockLedgerEntry({
        materialId: mat.id, materialName: mat.name, batch: mat.batch,
        type: STOCK_LEDGER_TYPES.RESTORE, quantity: consumedQty,
        stockBefore, stockAfter: mat.stock,
        reservedBefore, reservedAfter: reservedBefore,
        commissionId: commission.id, commissionName: commission.roleName,
        step: commission.status, operator, operatorId,
        note: (reason || "释放委托") + "，退回已消耗库存"
      }));
    }

    const currentStock = Number(mat.stock) || 0;
    if (reservedQty > 0) {
      const releaseQty = Math.min(reservedQty, reservedBefore);
      mat.reserved = Math.max(0, reservedBefore - releaseQty);
      m.reservedQty = 0;
      addStockLedger(db, createStockLedgerEntry({
        materialId: mat.id, materialName: mat.name, batch: mat.batch,
        type: STOCK_LEDGER_TYPES.RELEASE_RESERVE, quantity: releaseQty,
        stockBefore: currentStock, stockAfter: currentStock,
        reservedBefore, reservedAfter: mat.reserved,
        commissionId: commission.id, commissionName: commission.roleName,
        step: commission.status, operator, operatorId,
        note: reason || `释放占用`
      }));
    }
  }
}

function adjustCommissionMaterials(db, commission, oldMaterials, operator, operatorId) {
  if (!commission) return;
  const newMaterials = Array.isArray(commission.materials) ? commission.materials : [];
  const oldMatList = Array.isArray(oldMaterials) ? oldMaterials : [];
  const steps = commission.steps && commission.steps.length ? commission.steps : defaultSteps;
  const currentIdx = steps.indexOf(commission.status);
  const consumeStepName = commission.consumeStepName || DEFAULT_CONSUME_STEP_NAME;
  const consumeIdx = steps.indexOf(consumeStepName);
  const alreadyConsumed = consumeIdx !== -1 && currentIdx >= consumeIdx;

  const oldById = {};
  for (const om of oldMatList) oldById[om.materialId] = om;
  const newById = {};
  for (const nm of newMaterials) newById[nm.materialId] = nm;

  const allIds = new Set([...Object.keys(oldById), ...Object.keys(newById)]);

  for (const mid of allIds) {
    const mat = db.materials.find(item => item.id === mid);
    if (!mat) continue;
    const oldM = oldById[mid];
    const newM = newById[mid];
    const oldQty = oldM ? (Number(oldM.quantity) || 0) : 0;
    const newQty = newM ? (Number(newM.quantity) || 0) : 0;
    const oldReserved = oldM ? (Number(oldM.reservedQty) || 0) : 0;
    const oldConsumed = oldM ? (Number(oldM.consumedQty) || 0) : 0;
    const diff = newQty - oldQty;

    const stockBefore = Number(mat.stock) || 0;
    const reservedBefore = Number(mat.reserved) || 0;

    if (alreadyConsumed) {
      if (diff > 0) {
        if (stockBefore < diff) throw new Error(`材料 ${mat.name} 库存不足，当前库存 ${stockBefore}${mat.unit}`);
        mat.stock = stockBefore - diff;
        if (newM) {
          newM.consumedQty = (oldConsumed || 0) + diff;
          newM.reservedQty = 0;
          newM.consumedAt = new Date().toISOString();
          newM.consumedBy = operator || "系统";
          newM.consumedStep = consumeStepName;
        }
        addStockLedger(db, createStockLedgerEntry({
          materialId: mat.id, materialName: mat.name, batch: mat.batch,
          type: STOCK_LEDGER_TYPES.CONSUME, quantity: diff,
          stockBefore, stockAfter: mat.stock,
          reservedBefore, reservedAfter: reservedBefore,
          commissionId: commission.id, commissionName: commission.roleName,
          step: commission.status, operator, operatorId,
          note: `调整材料数量-追加消耗（已过消耗节点）`
        }));
      } else if (diff < 0) {
        const returnQty = Math.abs(diff);
        const canReturn = Math.min(returnQty, oldConsumed || 0);
        if (canReturn > 0) {
          mat.stock = stockBefore + canReturn;
          if (newM) newM.consumedQty = (oldConsumed || 0) - canReturn;
          addStockLedger(db, createStockLedgerEntry({
            materialId: mat.id, materialName: mat.name, batch: mat.batch,
            type: STOCK_LEDGER_TYPES.RESTORE, quantity: canReturn,
            stockBefore, stockAfter: mat.stock,
            reservedBefore, reservedAfter: reservedBefore,
            commissionId: commission.id, commissionName: commission.roleName,
            step: commission.status, operator, operatorId,
            note: `调整材料数量-退回库存`
          }));
        }
        if (newM) {
          newM.reservedQty = 0;
        }
      }
    } else {
      if (diff > 0) {
        const available = stockBefore - reservedBefore;
        if (available < diff) throw new Error(`材料 ${mat.name} 可用量不足，可用 ${available}${mat.unit}（总库存 ${stockBefore}${mat.unit}，已占用 ${reservedBefore}${mat.unit}）`);
        mat.reserved = reservedBefore + diff;
        if (newM) newM.reservedQty = (oldReserved || 0) + diff;
        addStockLedger(db, createStockLedgerEntry({
          materialId: mat.id, materialName: mat.name, batch: mat.batch,
          type: STOCK_LEDGER_TYPES.ADJUST_RESERVE, quantity: diff,
          stockBefore, stockAfter: stockBefore,
          reservedBefore, reservedAfter: mat.reserved,
          commissionId: commission.id, commissionName: commission.roleName,
          step: commission.status, operator, operatorId,
          note: `调整材料数量-增加占用`
        }));
      } else if (diff < 0) {
        const releaseQty = Math.min(Math.abs(diff), reservedBefore, oldReserved || 0);
        if (releaseQty > 0) {
          mat.reserved = reservedBefore - releaseQty;
          if (newM) newM.reservedQty = Math.max(0, (oldReserved || 0) - releaseQty);
          addStockLedger(db, createStockLedgerEntry({
            materialId: mat.id, materialName: mat.name, batch: mat.batch,
            type: STOCK_LEDGER_TYPES.ADJUST_RESERVE, quantity: -releaseQty,
            stockBefore, stockAfter: stockBefore,
            reservedBefore, reservedAfter: mat.reserved,
            commissionId: commission.id, commissionName: commission.roleName,
            step: commission.status, operator, operatorId,
            note: `调整材料数量-减少占用`
          }));
        }
      }
    }
  }
}

function consumeCommissionMaterialsAtStep(db, commission, oldStatus, newStatus, operator, operatorId) {
  if (!commission || !Array.isArray(commission.materials) || commission.materials.length === 0) return;
  const steps = commission.steps && commission.steps.length ? commission.steps : defaultSteps;
  const oldIdx = steps.indexOf(oldStatus);
  const newIdx = steps.indexOf(newStatus);
  if (oldIdx === -1 || newIdx === -1) return;
  const consumeStepName = commission.consumeStepName || DEFAULT_CONSUME_STEP_NAME;
  const consumeIdx = steps.indexOf(consumeStepName);
  if (consumeIdx === -1) return;
  if (oldIdx < consumeIdx && newIdx >= consumeIdx) {
    for (const m of commission.materials) {
      const mat = db.materials.find(item => item.id === m.materialId);
      if (!mat) continue;
      const reservedQty = Number(m.reservedQty) || 0;
      const qty = Number(m.quantity) || 0;
      const toConsume = reservedQty > 0 ? reservedQty : qty;
      if (toConsume <= 0) continue;

      const stockBefore = Number(mat.stock) || 0;
      const reservedBefore = Number(mat.reserved) || 0;

      if (stockBefore < toConsume) {
        throw new Error(`材料 ${mat.name} 库存不足，无法消耗。需要 ${toConsume}${mat.unit}，当前库存 ${stockBefore}${mat.unit}`);
      }
      mat.stock = stockBefore - toConsume;
      const reduceReserve = Math.min(reservedQty, reservedBefore);
      mat.reserved = Math.max(0, reservedBefore - reduceReserve);
      m.consumedQty = toConsume;
      m.reservedQty = Math.max(0, (Number(m.reservedQty) || 0) - reduceReserve);
      m.consumedAt = new Date().toISOString();
      m.consumedBy = operator || "系统";
      m.consumedStep = consumeStepName;

      addStockLedger(db, createStockLedgerEntry({
        materialId: mat.id, materialName: mat.name, batch: mat.batch,
        type: STOCK_LEDGER_TYPES.CONSUME, quantity: toConsume,
        stockBefore, stockAfter: mat.stock,
        reservedBefore, reservedAfter: mat.reserved,
        commissionId: commission.id, commissionName: commission.roleName,
        step: newStatus, operator, operatorId,
        note: `步骤推进至【${consumeStepName}】，实际出库消耗`
      }));
    }
  }
}

function undoCommissionMaterialsConsume(db, commission, operator, operatorId, reason) {
  if (!commission || !Array.isArray(commission.materials)) return;
  for (const m of commission.materials) {
    const mat = db.materials.find(item => item.id === m.materialId);
    if (!mat) continue;
    const consumedQty = Number(m.consumedQty) || 0;
    if (consumedQty <= 0) continue;
    const stockBefore = Number(mat.stock) || 0;
    const reservedBefore = Number(mat.reserved) || 0;
    mat.stock = stockBefore + consumedQty;
    mat.reserved = reservedBefore + consumedQty;
    m.consumedQty = 0;
    m.reservedQty = consumedQty;
    m.consumedAt = "";
    m.consumedBy = "";
    m.consumedStep = "";
    addStockLedger(db, createStockLedgerEntry({
      materialId: mat.id, materialName: mat.name, batch: mat.batch,
      type: STOCK_LEDGER_TYPES.UNDO_CONSUME, quantity: consumedQty,
      stockBefore, stockAfter: mat.stock,
      reservedBefore, reservedAfter: mat.reserved,
      commissionId: commission.id, commissionName: commission.roleName,
      step: commission.status, operator, operatorId,
      note: reason || `撤销消耗，恢复占用`
    }));
  }
}

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
      remark: "长期合作客户，主要修复民国时期皮影",
      followUps: []
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
      reserved: 0,
      unit: "张",
      minStock: 20,
      remark: "陕西洛川产，厚度0.8mm"
    },
    {
      id: "MAT-2",
      name: "朱砂矿物颜料",
      category: "颜料",
      batch: "ZS-2026-B03",
      stock: 200,
      reserved: 0,
      unit: "克",
      minStock: 50,
      remark: "特级纯天然朱砂粉"
    },
    {
      id: "MAT-3",
      name: "石黄矿物颜料",
      category: "颜料",
      batch: "SH-2026-B01",
      stock: 150,
      reserved: 0,
      unit: "克",
      minStock: 30,
      remark: "老矿坑料，色泽沉稳"
    },
    {
      id: "MAT-4",
      name: "鱼鳔胶",
      category: "胶料",
      batch: "YJ-2026-C02",
      stock: 80,
      reserved: 0,
      unit: "克",
      minStock: 20,
      remark: "传统手工熬制"
    },
    {
      id: "MAT-5",
      name: "骨胶",
      category: "胶料",
      batch: "GJ-2026-C01",
      stock: 120,
      reserved: 0,
      unit: "克",
      minStock: 30,
      remark: "高纯度牛骨胶粒"
    }
  ],
  stockLedger: [],
  members: [
    { id: "MB-001", name: "许岚", role: "修复师", phone: "", remark: "主修复师" },
    { id: "MB-002", name: "张师傅", role: "补色师", phone: "", remark: "" },
    { id: "MB-003", name: "李学徒", role: "学徒", phone: "", remark: "" }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return JSON.parse(JSON.stringify(seed));
  }
  let raw;
  try {
    raw = await readFile(dbPath, "utf8");
  } catch (e) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return JSON.parse(JSON.stringify(seed));
  }
  let db;
  try {
    db = JSON.parse(raw);
  } catch (e) {
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return JSON.parse(JSON.stringify(seed));
  }
  if (!db || typeof db !== "object" || Array.isArray(db)) {
    db = {};
  }
  let migrated = false;
  if (!db.stepTemplates || !Array.isArray(db.stepTemplates) || !db.stepTemplates.length) {
    db.stepTemplates = JSON.parse(JSON.stringify(seedTemplates));
    migrated = true;
  }
  if (!db.members || !Array.isArray(db.members)) {
    db.members = JSON.parse(JSON.stringify(seed.members));
    migrated = true;
  }
  if (!db.clients || !Array.isArray(db.clients)) {
    db.clients = [];
    migrated = true;
  } else {
    for (const c of db.clients) {
      if (!c || typeof c !== "object") continue;
      if (!Array.isArray(c.followUps)) {
        c.followUps = [];
        migrated = true;
      }
    }
  }
  ensureStockLedger(db);
  if (!Array.isArray(db.stockLedger)) {
    db.stockLedger = [];
    migrated = true;
  }
  if (!db.materials || !Array.isArray(db.materials)) {
    db.materials = [];
    migrated = true;
  } else {
    for (const m of db.materials) {
      if (m.minStock === undefined) { m.minStock = 0; migrated = true; }
      if (m.reserved === undefined) { m.reserved = 0; migrated = true; }
    }
  }
  if (!db.commissions || !Array.isArray(db.commissions)) {
    db.commissions = [];
    migrated = true;
  }
  for (const c of db.commissions) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    if (!c.id) {
      c.id = "SP-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      migrated = true;
    }
    if (!c.roleName) { c.roleName = ""; migrated = true; }
    if (!c.era) { c.era = ""; migrated = true; }
    if (!c.damage) { c.damage = ""; migrated = true; }
    if (!c.steps || !Array.isArray(c.steps) || !c.steps.length) {
      c.steps = [...defaultSteps];
      migrated = true;
    }
    if (!c.images || typeof c.images !== "object" || Array.isArray(c.images)) {
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
    for (const q of c.quotes) {
      if (!q || typeof q !== "object") continue;
      if (q.version === undefined) { q.version = 1; migrated = true; }
      if (!q.status) { q.status = "draft"; migrated = true; }
      if (!Array.isArray(q.items)) { q.items = []; migrated = true; }
      if (q.totalAmount === undefined) { q.totalAmount = 0; migrated = true; }
      if (q.laborCost === undefined) { q.laborCost = 0; migrated = true; }
      if (q.materialCost === undefined) { q.materialCost = 0; migrated = true; }
      if (!q.createdAt) { q.createdAt = new Date().toISOString(); migrated = true; }
    }
    if (c.currentQuoteId === undefined) {
      c.currentQuoteId = "";
      migrated = true;
    }
    if (c.acceptance === undefined || c.acceptance === "" || c.acceptance === false) {
      c.acceptance = null;
      migrated = true;
    } else if (typeof c.acceptance === "object" && c.acceptance !== null && !c.acceptance.result) {
      c.acceptance = null;
      migrated = true;
    }
    if (!Array.isArray(c.operationLogs)) {
      c.operationLogs = [];
      migrated = true;
    }
    if (!Array.isArray(c.fieldSnapshots)) {
      c.fieldSnapshots = [];
      migrated = true;
    }
    if (!Array.isArray(c.materials)) {
      c.materials = [];
      migrated = true;
    } else {
      for (const m of c.materials) {
        if (!m || typeof m !== "object") continue;
        if (m.reservedQty === undefined) { m.reservedQty = 0; migrated = true; }
        if (m.consumedQty === undefined) { m.consumedQty = 0; migrated = true; }
        if (m.consumedAt === undefined) { m.consumedAt = ""; migrated = true; }
        if (m.consumedBy === undefined) { m.consumedBy = ""; migrated = true; }
        if (m.consumedStep === undefined) { m.consumedStep = ""; migrated = true; }
      }
    }
    if (c.consumeStepName === undefined) { c.consumeStepName = DEFAULT_CONSUME_STEP_NAME; migrated = true; }
    if (!Array.isArray(c.records)) {
      c.records = [];
      migrated = true;
    }
    if (c.missingParts === undefined) {
      c.missingParts = "";
      migrated = true;
    }
    if (c.colorNotes === undefined) {
      c.colorNotes = "";
      migrated = true;
    }
    if (c.reinforcement === undefined) {
      c.reinforcement = "";
      migrated = true;
    }
    if (c.clientId === undefined) {
      c.clientId = "";
      migrated = true;
    }
    if (c.client === undefined) {
      c.client = "";
      migrated = true;
    }
    if (c.templateId === undefined) {
      c.templateId = "";
      migrated = true;
    }
    if (c.templateName === undefined) {
      c.templateName = "";
      migrated = true;
    }
    if (c.status === undefined) {
      c.status = c.steps[0] || defaultSteps[0];
      migrated = true;
    }
    if (c.owner === undefined) {
      c.owner = "";
      migrated = true;
    }
    if (c.dueDate === undefined) {
      c.dueDate = "";
      migrated = true;
    }
    if (!c.fieldSnapshots || !Array.isArray(c.fieldSnapshots) || c.fieldSnapshots.length === 0) {
      const earliestRecord = c.records && c.records.length ? c.records[0] : null;
      const snapshotAt = earliestRecord && earliestRecord.at ? earliestRecord.at : new Date().toISOString();
      c.fieldSnapshots = [{
        id: `SNAP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        fields: {
          roleName: c.roleName || "",
          era: c.era || "",
          damage: c.damage || "",
          missingParts: c.missingParts || "",
          colorNotes: c.colorNotes || "",
          reinforcement: c.reinforcement || "",
          owner: c.owner || "",
          dueDate: c.dueDate || "",
          status: c.status || "",
          client: c.client || "",
          materials: Array.isArray(c.materials) ? JSON.parse(JSON.stringify(c.materials)) : []
        },
        operator: "系统",
        operatorId: "",
        reason: "初始数据快照",
        at: snapshotAt
      }];
      migrated = true;
    }
  }
  if (!db._stockMigratedV2) {
    let fixed = false;
    for (const c of db.commissions) {
      if (!c || !Array.isArray(c.materials) || c.materials.length === 0) continue;
      const steps = c.steps && c.steps.length ? c.steps : defaultSteps;
      const currentIdx = steps.indexOf(c.status);
      const consumeStepName = c.consumeStepName || DEFAULT_CONSUME_STEP_NAME;
      const consumeIdx = steps.indexOf(consumeStepName);
      const alreadyPassedConsume = (consumeIdx !== -1 && currentIdx >= consumeIdx) || (c.acceptance && c.acceptance.result);
      for (const m of c.materials) {
        const mat = db.materials.find(item => item.id === m.materialId);
        if (!mat) continue;
        const qty = Number(m.quantity) || 0;
        if (qty <= 0) continue;
        const reservedQty = Number(m.reservedQty) || 0;
        const consumedQty = Number(m.consumedQty) || 0;
        if (reservedQty === 0 && consumedQty === 0) {
          if (alreadyPassedConsume) {
            m.consumedQty = qty;
            m.reservedQty = 0;
            m.consumedStep = consumeStepName;
            m.consumedBy = "系统迁移";
            m.consumedAt = new Date().toISOString();
          } else {
            mat.stock = (Number(mat.stock) || 0) + qty;
            mat.reserved = (Number(mat.reserved) || 0) + qty;
            m.reservedQty = qty;
            m.consumedQty = 0;
          }
          fixed = true;
        }
      }
    }
    db._stockMigratedV2 = new Date().toISOString();
    migrated = true;
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
    :root { --bg:#f4efe7; --panel:#fff; --ink:#29231e; --muted:#76695f; --line:#ddcfc0; --accent:#7d3f2e; --green:#47705b; --green-soft:#e7f1ea; --orange:#c4702c; --orange-soft:#f7e4d6; --red:#b4372f; --red-soft:#f8dddd; }
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
    .stock-warning { color:var(--red); font-weight:700; }
    .material-card.stock-warning-card { border-left:4px solid var(--red); }
    .material-card.stock-low-card { border-left:4px solid var(--orange); }
    .stock-badge { display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:700; }
    .stock-badge.normal { background:var(--green-soft); color:var(--green); }
    .stock-badge.warning { background:var(--orange-soft); color:var(--orange); }
    .stock-badge.danger { background:var(--red-soft); color:var(--red); }
    .material-card-actions { display:flex; gap:6px; margin-top:8px; }
    .material-card-actions button { flex:1; }
    .material-edit-form { display:grid; gap:10px; }
    .material-select-item.stock-warning-item { background:var(--red-soft); border-radius:6px; }
    .material-select-item.stock-low-item { background:var(--orange-soft); border-radius:6px; }
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
    .client-followup-summary { background:var(--accent-soft); border-left:3px solid var(--accent); padding:8px 12px; border-radius:4px; margin-top:8px; font-size:13px; }
    .client-followup-summary .date { color:var(--muted); font-size:12px; }
    .client-followup-summary .content { margin-top:4px; line-height:1.4; }
    .client-followup-list { margin-top:16px; }
    .client-followup-item { background:var(--bg); border-radius:6px; padding:12px 14px; margin:8px 0; }
    .client-followup-item .followup-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
    .client-followup-item .followup-date { font-weight:600; color:var(--accent); }
    .client-followup-item .followup-operator { color:var(--muted); font-size:13px; }
    .client-followup-item .followup-content { line-height:1.5; font-size:14px; }
    .client-followup-item .followup-next { margin-top:8px; padding-top:8px; border-top:1px dashed var(--line); color:var(--orange); font-size:13px; }
    .followup-form { margin-top:16px; padding:16px; background:var(--bg); border-radius:8px; }
    .followup-form h4 { margin:0 0 12px; }
    .followup-form .form-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .followup-form label { display:block; margin:8px 0 4px; font-size:14px; }
    .followup-form textarea { min-height:80px; resize:vertical; }
    .client-last-followup-tip { background:var(--accent-soft); border:1px solid var(--accent); border-radius:6px; padding:8px 12px; margin-top:8px; font-size:13px; line-height:1.4; }
    .client-last-followup-tip strong { color:var(--accent); }
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
    .schedule-filter input[type="date"] { width:auto; padding:6px 8px; }
    .schedule-filter .filter-label { color:var(--muted); font-size:13px; margin-right:4px; }
    .commission-filters { display:flex; gap:10px; margin-bottom:14px; padding:12px; background:var(--bg); border-radius:8px; flex-wrap:wrap; align-items:center; }
    .commission-filters .filter-group { display:flex; align-items:center; gap:6px; }
    .commission-filters .filter-label { color:var(--muted); font-size:13px; white-space:nowrap; }
    .commission-filters select { width:auto; min-width:130px; padding:6px 8px; }
    .commission-filters input[type="date"] { width:auto; padding:6px 8px; }
    .commission-filters .date-range { display:flex; align-items:center; gap:4px; }
    .commission-filters button.reset-filter { padding:6px 12px; font-size:12px; background:#fff; border:1px solid var(--line); border-radius:6px; cursor:pointer; }
    .commission-filters button.reset-filter:hover { background:var(--accent); color:#fff; border-color:var(--accent); }
    .filter-active-indicator { display:inline-block; margin-left:6px; padding:1px 7px; background:var(--orange); color:#fff; border-radius:999px; font-size:11px; font-weight:700; }
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

    .wizard-steps { display:flex; gap:2px; margin-bottom:20px; border-bottom:1px solid var(--line); padding-bottom:12px; }
    .wizard-step { flex:1; padding:10px 14px; background:var(--bg); border:1px solid var(--line); border-radius:6px; cursor:pointer; font-size:13px; text-align:center; position:relative; }
    .wizard-step.active { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:700; }
    .wizard-step.done { background:var(--green-soft); color:var(--green); border-color:var(--green); }
    .wizard-step:disabled { opacity:0.5; cursor:not-allowed; }
    .wizard-step .step-num { display:inline-block; width:22px; height:22px; border-radius:50%; background:rgba(0,0,0,0.1); color:inherit; font-weight:700; margin-right:6px; line-height:22px; text-align:center; }
    .wizard-step.active .step-num { background:rgba(255,255,255,0.25); }

    .entity-tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin-bottom:16px; flex-wrap:wrap; }
    .entity-tab { padding:10px 16px; background:var(--bg); border:1px solid var(--line); border-bottom:none; border-radius:8px 8px 0 0; cursor:pointer; font-size:13px; position:relative; }
    .entity-tab.active { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:700; }
    .entity-tab .ent-count { display:inline-block; margin-left:6px; padding:1px 8px; background:rgba(0,0,0,0.1); border-radius:999px; font-size:11px; }
    .entity-tab.active .ent-count { background:rgba(255,255,255,0.25); }

    .entity-content { display:none; }
    .entity-content.active { display:block; }

    .entity-filter-tabs { display:flex; gap:4px; margin-bottom:12px; flex-wrap:wrap; }
    .entity-filter-tab { padding:6px 12px; background:var(--bg); border:1px solid var(--line); border-radius:6px; cursor:pointer; font-size:12px; }
    .entity-filter-tab.active { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:600; }
    .entity-filter-tab .ef-count { margin-left:4px; padding:1px 6px; background:rgba(0,0,0,0.08); border-radius:999px; font-size:11px; }
    .entity-filter-tab.active .ef-count { background:rgba(255,255,255,0.2); }

    .entity-list { max-height:350px; overflow-y:auto; }
    .entity-item { background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:10px; }
    .entity-item-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; }
    .entity-item-title { font-weight:700; font-size:14px; margin:0; }
    .entity-item-badges { display:flex; gap:5px; flex-wrap:wrap; }
    .entity-badge { padding:3px 8px; border-radius:999px; font-size:11px; font-weight:600; }
    .entity-badge.new { background:var(--green-soft); color:var(--green); }
    .entity-badge.matched { background:#d4e6f7; color:#1f5e9c; }
    .entity-badge.conflict { background:var(--orange-soft); color:var(--orange); }
    .entity-badge.unmatched { background:var(--red-soft); color:var(--red); }

    .entity-item-meta { color:var(--muted); font-size:12px; margin-bottom:8px; }
    .entity-item-detail { background:var(--bg); border-radius:6px; padding:8px 10px; font-size:12px; margin-bottom:8px; }
    .entity-item-detail .detail-row { margin:3px 0; display:grid; grid-template-columns:70px 1fr; gap:6px; }
    .entity-item-detail .detail-label { color:var(--muted); }

    .match-select-area { margin-top:8px; padding:10px; background:var(--bg); border-radius:6px; }
    .match-select-area label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
    .match-select-area select { width:100%; padding:7px; font-size:13px; border:1px solid var(--line); border-radius:6px; background:#fff; }
    .match-candidates { margin-top:8px; }
    .match-candidate { padding:8px 10px; background:#fff; border:1px solid var(--line); border-radius:6px; margin-bottom:6px; cursor:pointer; transition:all 0.15s; }
    .match-candidate:hover { border-color:var(--accent); }
    .match-candidate.selected { border-color:var(--accent); background:var(--accent-soft); border-width:2px; }
    .match-candidate .mc-title { font-weight:600; font-size:13px; }
    .match-candidate .mc-meta { font-size:11px; color:var(--muted); margin-top:2px; }
    .match-create-new { padding:8px 10px; background:#fff; border:1px dashed var(--muted); border-radius:6px; text-align:center; color:var(--muted); font-size:12px; cursor:pointer; }
    .match-create-new:hover { border-color:var(--green); color:var(--green); }
    .match-create-new.selected { border-style:solid; border-color:var(--green); background:var(--green-soft); color:var(--green); font-weight:600; }

    .import-summary { padding:4px; }
    .summary-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:20px; }
    .summary-card { background:var(--bg); border-radius:8px; padding:14px; text-align:center; }
    .summary-card .sc-label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
    .summary-card .sc-value { display:block; font-size:22px; font-weight:700; }
    .summary-card .sc-created { color:var(--green); }
    .summary-card .sc-updated { color:var(--accent); }
    .summary-card .sc-reused { color:#1f5e9c; }
    .summary-card .sc-skipped { color:var(--muted); }

    .summary-section { margin-bottom:18px; }
    .summary-section h4 { margin:0 0 10px; font-size:14px; display:flex; align-items:center; justify-content:space-between; }
    .summary-section h4 .count { font-size:12px; color:var(--muted); font-weight:400; }
    .summary-item-list { background:var(--bg); border-radius:6px; padding:8px 10px; max-height:180px; overflow-y:auto; }
    .summary-item-row { padding:6px 0; border-bottom:1px dashed var(--line); font-size:13px; display:flex; justify-content:space-between; align-items:center; }
    .summary-item-row:last-child { border-bottom:none; }
    .summary-item-row .si-action { padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; }
    .summary-item-row .si-action.created { background:var(--green-soft); color:var(--green); }
    .summary-item-row .si-action.updated { background:var(--orange-soft); color:var(--orange); }
    .summary-item-row .si-action.reused { background:#d4e6f7; color:#1f5e9c; }
    .summary-item-row .si-action.skipped { background:#eee; color:var(--muted); }

    .import-wizard-footer { padding:16px 24px; border-top:1px solid var(--line); display:flex; justify-content:space-between; gap:10px; background:#faf8f5; align-items:center; }
    .import-wizard-footer .footer-left { flex:1; font-size:13px; color:var(--muted); }
    .import-wizard-footer .footer-right { display:flex; gap:8px; }
    .import-badge.matched { background:#d4e6f7; color:#1f5e9c; }
    .import-badge.unmatched { background:var(--red-soft); color:#c0392b; }
    .import-badge.conflict { background:var(--orange-soft); color:var(--orange); }

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

    .acceptance-btn { margin-top: 8px; background: var(--green); color: #fff; border: 0; border-radius: 6px; padding: 8px 12px; font-size: 13px; cursor: pointer; }
    .acceptance-btn:hover { opacity: 0.9; }
    .acceptance-btn:disabled { opacity: 0.5; cursor: not-allowed; background: var(--muted); }

    .card.completed { border: 2px solid var(--green); position: relative; }
    .card.completed::before { content: "✓ 已完成"; position: absolute; top: -10px; right: 12px; background: var(--green); color: #fff; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; }

    .acceptance-modal { max-width: 600px; }
    .acceptance-info { background: var(--bg); border-radius: 8px; padding: 14px; margin-bottom: 18px; }
    .acceptance-info-row { display: grid; grid-template-columns: 100px 1fr; gap: 8px; margin-bottom: 8px; font-size: 14px; }
    .acceptance-info-row:last-child { margin-bottom: 0; }
    .acceptance-info-row .label { color: var(--muted); }
    .acceptance-section { margin-bottom: 16px; }
    .acceptance-section h4 { margin: 0 0 10px; font-size: 15px; }
    .acceptance-result { display: flex; gap: 12px; margin-bottom: 12px; }
    .acceptance-result label { display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer; }
    .acceptance-result input[type=radio] { width: auto; }

    .stage-filter-tabs { display: flex; gap: 4px; margin-bottom: 14px; flex-wrap: wrap; }
    .stage-filter-tab { padding: 8px 16px; background: #fff; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; font-size: 13px; }
    .stage-filter-tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .stage-filter-tab .count { margin-left: 6px; padding: 1px 7px; background: rgba(0,0,0,0.1); border-radius: 999px; font-size: 11px; }
    .stage-filter-tab.active .count { background: rgba(255,255,255,0.25); }

    .acceptance-detail { background: var(--bg); border-radius: 6px; padding: 10px; margin-top: 8px; font-size: 12px; }
    .acceptance-detail .row { display: flex; gap: 4px; margin: 3px 0; }
    .acceptance-detail .row .label { color: var(--muted); min-width: 60px; }
    .header-bar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; }
    .operator-area { display:flex; align-items:center; gap:8px; }
    .operator-area label { color:var(--muted); font-size:13px; margin:0; white-space:nowrap; }
    .operator-area select { width:auto; min-width:120px; padding:6px 10px; font-size:13px; }
    .member-list { display:grid; gap:10px; }
    .member-card { display:grid; gap:6px; }
    .member-card .pill { justify-self:start; }
    .oplog-section { margin-top:10px; border-top:1px dashed var(--line); padding-top:10px; }
    .oplog-title { font-size:13px; color:var(--muted); margin:0 0 6px; cursor:pointer; display:flex; align-items:center; gap:4px; }
    .oplog-title:hover { color:var(--accent); }
    .oplog-list { display:none; }
    .oplog-list.visible { display:block; }
    .oplog-item { display:grid; grid-template-columns:110px 70px 1fr; gap:4px 8px; padding:4px 0; font-size:12px; border-bottom:1px solid var(--line); }
    .oplog-item:last-child { border-bottom:none; }
    .oplog-time { color:var(--muted); }
    .oplog-operator { color:var(--accent); font-weight:600; }
    .oplog-detail { color:var(--ink); }

    .detail-modal { max-width: 1100px; }
    .detail-nav { display:flex; gap:2px; padding:0 24px; border-bottom:1px solid var(--line); overflow-x:auto; }
    .detail-nav-btn { padding:10px 16px; background:var(--bg); border:1px solid var(--line); border-bottom:none; border-radius:8px 8px 0 0; cursor:pointer; font-size:13px; white-space:nowrap; }
    .detail-nav-btn.active { background:var(--accent); color:#fff; border-color:var(--accent); }
    .detail-section { display:none; }
    .detail-section.active { display:block; }
    .detail-info-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .detail-info-item { background:var(--bg); border-radius:6px; padding:10px 12px; }
    .detail-info-item .label { display:block; font-size:12px; color:var(--muted); margin-bottom:4px; }
    .detail-info-item .value { font-size:14px; word-break:break-all; }
    .detail-info-item.full { grid-column:1/-1; }
    .detail-edit-btn { display:inline-block; margin-left:8px; font-size:11px; color:var(--accent); cursor:pointer; border:0; background:none; padding:2px 6px; border-radius:3px; }
    .detail-edit-btn:hover { background:var(--bg); text-decoration:underline; }

    .detail-timeline { position:relative; padding-left:28px; }
    .detail-timeline::before { content:''; position:absolute; left:10px; top:0; bottom:0; width:2px; background:var(--line); }
    .timeline-item { position:relative; margin-bottom:18px; }
    .timeline-item::before { content:''; position:absolute; left:-22px; top:6px; width:12px; height:12px; border-radius:50%; border:2px solid var(--line); background:#fff; }
    .timeline-item.done::before { background:var(--green); border-color:var(--green); }
    .timeline-item.current::before { background:var(--accent); border-color:var(--accent); }
    .timeline-item .tl-step { font-weight:700; font-size:14px; }
    .timeline-item .tl-time { font-size:12px; color:var(--muted); margin-left:8px; }
    .timeline-item .tl-note { font-size:13px; color:var(--ink); margin-top:4px; }
    .timeline-item .tl-future { color:var(--muted); font-style:italic; }

    .detail-img-section { margin-top:12px; }
    .detail-img-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:10px; }
    .detail-img-card { background:var(--bg); border:1px solid var(--line); border-radius:6px; overflow:hidden; cursor:pointer; transition:all 0.2s; }
    .detail-img-card:hover { box-shadow:0 2px 8px rgba(0,0,0,0.1); transform:translateY(-2px); }
    .detail-img-card img { width:100%; height:100px; object-fit:cover; }
    .detail-img-card .caption { padding:6px; font-size:11px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .detail-img-stage-label { font-size:13px; font-weight:700; color:var(--muted); margin:12px 0 6px; }

    .detail-quote-summary { background:var(--bg); border-radius:8px; padding:14px; margin-bottom:12px; }
    .detail-quote-row { display:flex; justify-content:space-between; padding:4px 0; font-size:13px; }
    .detail-quote-row.total { border-top:2px solid var(--line); margin-top:8px; padding-top:8px; font-weight:700; font-size:15px; }
    .detail-quote-row.total strong { color:var(--accent); font-size:18px; }

    .detail-acceptance-box { background:var(--bg); border-radius:8px; padding:14px; }
    .detail-acceptance-row { display:grid; grid-template-columns:90px 1fr; gap:4px; margin:4px 0; font-size:13px; }
    .detail-acceptance-row .label { color:var(--muted); }

    .detail-oplog-table { width:100%; border-collapse:collapse; }
    .detail-oplog-table th, .detail-oplog-table td { padding:8px 10px; border-bottom:1px solid var(--line); font-size:13px; text-align:left; }
    .detail-oplog-table th { color:var(--muted); font-weight:400; }
    .detail-oplog-table td.oplog-time-col { white-space:nowrap; color:var(--muted); width:130px; }
    .detail-oplog-table td.oplog-op-col { color:var(--accent); font-weight:600; width:70px; }

    .version-list { display:flex; flex-direction:column; gap:8px; }
    .version-item { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 14px; cursor:pointer; transition:all 0.2s; }
    .version-item:hover { border-color:var(--accent); }
    .version-item.active { border-color:var(--accent); background:#fff; }
    .version-item-header { display:flex; justify-content:space-between; align-items:center; }
    .version-item-reason { font-weight:700; font-size:13px; }
    .version-item-time { font-size:11px; color:var(--muted); }
    .version-item-operator { font-size:11px; color:var(--accent); }
    .version-diff { margin-top:8px; padding:8px; background:#fff; border-radius:4px; font-size:12px; display:none; }
    .version-item.active .version-diff { display:block; }
    .version-diff-row { display:grid; grid-template-columns:80px 1fr 1fr; gap:8px; margin:3px 0; }
    .version-diff-row .field-name { color:var(--muted); }
    .version-diff-row .old-val { color:#c0392b; text-decoration:line-through; }
    .version-diff-row .new-val { color:var(--green); }
    .version-diff-row .unchanged { color:var(--muted); }

    .detail-section-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
    .detail-section-header h4 { margin:0; font-size:16px; }

    .quote-diff-section { margin-top:20px; padding-top:20px; border-top:2px dashed var(--line); }
    .quote-diff-section .quote-section-header { margin-bottom:14px; }
    .quote-diff-container { background:var(--bg); border-radius:10px; padding:16px; }

    .quote-diff-amount-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:16px; }
    .quote-diff-amount-card { background:#fff; border-radius:8px; padding:12px; border:1px solid var(--line); }
    .quote-diff-amount-card.highlight { border:2px solid var(--accent); background:#fff9f5; }
    .quote-diff-label { font-size:12px; color:var(--muted); margin-bottom:8px; }
    .quote-diff-values { font-size:13px; line-height:1.6; }
    .quote-diff-values.total { font-size:14px; font-weight:600; }
    .quote-diff-old { color:var(--muted); text-decoration:line-through; font-size:12px; }
    .quote-diff-new { font-weight:600; }
    .quote-diff-delta { font-size:12px; margin-top:2px; display:inline-block; padding:1px 6px; border-radius:4px; font-weight:600; }
    .quote-diff-delta.up { background:var(--red-soft); color:var(--red); }
    .quote-diff-delta.down { background:var(--green-soft); color:var(--green); }
    .quote-diff-delta.zero { background:#eee; color:var(--muted); }
    .quote-diff-delta::before { content:"Δ "; font-weight:400; }

    .quote-diff-subtitle { font-size:13px; font-weight:700; color:var(--ink); margin:14px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line); }
    .quote-diff-subtitle:first-child { margin-top:0; }

    .quote-diff-item-group { margin-bottom:12px; }
    .quote-diff-group-title { font-size:12px; font-weight:700; padding:6px 10px; border-radius:6px 6px 0 0; display:flex; align-items:center; gap:6px; }
    .quote-diff-group-title.added { background:var(--green-soft); color:var(--green); }
    .quote-diff-group-title.removed { background:var(--red-soft); color:var(--red); }
    .quote-diff-group-title.modified { background:var(--orange-soft); color:var(--orange); }
    .count-badge { font-size:11px; padding:1px 8px; border-radius:999px; background:rgba(255,255,255,0.7); font-weight:700; }

    .quote-diff-item-row { display:grid; grid-template-columns:1fr 60px 80px 80px; gap:6px; padding:8px 10px; font-size:12px; align-items:center; border-left:3px solid transparent; background:#fff; border-bottom:1px solid var(--line); }
    .quote-diff-item-row.added { border-left-color:var(--green); background:#f3faf6; }
    .quote-diff-item-row.removed { border-left-color:var(--red); background:#fcf2f2; }
    .quote-diff-item-row.modified { border-left-color:var(--orange); background:#fef8f2; }
    .quote-diff-item-row:last-child { border-bottom:none; border-radius:0 0 6px 6px; }
    .quote-diff-item-row .diff-col-desc { grid-column:1; }
    .quote-diff-item-row .diff-col-qty { grid-column:2; text-align:center; }
    .quote-diff-item-row .diff-col-price { grid-column:3; text-align:right; }
    .quote-diff-item-row .diff-col-amount { grid-column:4; text-align:right; font-weight:600; }
    .quote-diff-item-row .diff-old-val { color:var(--red); text-decoration:line-through; font-size:11px; }
    .quote-diff-item-row .diff-new-val { color:var(--green); font-weight:600; }
    .quote-diff-item-row .diff-arrow { display:inline-block; margin:0 4px; color:var(--muted); }

    .quote-diff-modified-detail { font-size:11px; color:var(--muted); margin-top:3px; grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:10px; }
    .quote-diff-modified-detail span { display:inline-flex; align-items:center; gap:3px; }

    .quote-diff-remark-block { margin-top:12px; }
    .quote-diff-remark-compare { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .quote-diff-remark-old, .quote-diff-remark-new { background:#fff; border-radius:6px; padding:10px; border:1px solid var(--line); }
    .quote-diff-remark-old { border-left:3px solid var(--muted); }
    .quote-diff-remark-new { border-left:3px solid var(--accent); }
    .quote-diff-remark-label { font-size:11px; color:var(--muted); margin-bottom:4px; font-weight:600; }
    .quote-diff-remark-old div:last-child { color:var(--muted); font-size:12px; line-height:1.5; }
    .quote-diff-remark-new div:last-child { color:var(--ink); font-size:12px; line-height:1.5; font-weight:500; }

    .quote-diff-empty { text-align:center; padding:20px; color:var(--muted); font-size:13px; background:#fff; border-radius:8px; }

    @media (max-width:900px){ .two-col{grid-template-columns:1fr;} header{padding:18px 16px;} .tabs{padding:12px 16px 0;} .tab-content{padding:16px;} .stats{grid-template-columns:1fr 1fr;} .image-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));} .kanban{grid-template-columns:1fr;} .schedule-stats{grid-template-columns:1fr 1fr;} .io-actions{padding:12px 16px 0;} .import-stats{grid-template-columns:1fr 1fr;} .damage-info{grid-template-columns:1fr;} .quote-items-header, .quote-item-row{grid-template-columns:1fr 60px 80px 80px 30px; font-size:12px;} .quote-history-meta{flex-direction:column; gap:2px;} .quote-diff-amount-grid{grid-template-columns:1fr 1fr;} .quote-diff-remark-compare{grid-template-columns:1fr;} .quote-diff-item-row{grid-template-columns:1fr 50px 70px 70px;} }
  </style>
</head>
<body>
  <header>
    <div class="header-bar">
      <div>
        <h1>皮影修复小作坊</h1>
        <div class="meta">委托、修复步骤、材料台账</div>
      </div>
      <div class="operator-area">
        <label>👤 当前操作者：</label>
        <select id="operatorSelect"><option value="">— 请选择 —</option></select>
      </div>
    </div>
  </header>
  <div class="tabs">
    <div class="tab active" data-tab="commissions">修复委托</div>
    <div class="tab" data-tab="schedule">修复排期</div>
    <div class="tab" data-tab="members">作坊成员</div>
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
          <div id="clientFollowupTip" style="display:none;"></div>
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
        <label>材料消耗节点 <span class="meta" style="font-size:11px;">（推进到该步骤时，被占用的材料会转为实际消耗）</span></label>
        <select id="consumeStepSelect" name="consumeStepName">
          <option value="补片">补片（默认）</option>
        </select>
        <label>负责人</label>
        <select id="ownerSelect" name="owner" required>
          <option value="">— 选择负责人 —</option>
        </select>
        <label>预计完成日期</label><input name="dueDate" type="date" required>
        <button type="submit">保存委托</button>
      </form>
      <section>
        <div class="stats" id="stats"></div>
        <div class="commission-filters" id="commissionFilters">
          <div class="filter-group">
            <span class="filter-label">负责人：</span>
            <select id="filterOwner">
              <option value="">全部负责人</option>
            </select>
          </div>
          <div class="filter-group">
            <span class="filter-label">客户：</span>
            <select id="filterClient">
              <option value="">全部客户</option>
            </select>
          </div>
          <div class="filter-group">
            <span class="filter-label">当前步骤：</span>
            <select id="filterStatus">
              <option value="">全部步骤</option>
            </select>
          </div>
          <div class="filter-group">
            <span class="filter-label">预计完成：</span>
            <div class="date-range">
              <input type="date" id="filterDueFrom" title="开始日期">
              <span class="filter-label">至</span>
              <input type="date" id="filterDueTo" title="结束日期">
            </div>
          </div>
          <button type="button" class="reset-filter" id="resetCommissionFilters">重置筛选</button>
        </div>
        <div class="stage-filter-tabs" id="stageFilterTabs">
          <button type="button" class="stage-filter-tab active" data-stage-filter="active">进行中 <span class="count" id="countActive">0</span></button>
          <button type="button" class="stage-filter-tab" data-stage-filter="delivered">已交付 <span class="count" id="countDelivered">0</span></button>
        </div>
        <div class="grid" id="list"></div>
      </section>
    </div>
  </div>

  <div class="tab-content" id="tab-members">
    <div class="two-col">
      <form id="memberForm">
        <h2>新增作坊成员</h2>
        <label>姓名</label><input name="name" required>
        <label>角色</label>
        <select name="role">
          <option value="修复师">修复师</option>
          <option value="补色师">补色师</option>
          <option value="装裱师">装裱师</option>
          <option value="学徒">学徒</option>
          <option value="管理员">管理员</option>
          <option value="其他">其他</option>
        </select>
        <label>电话</label><input name="phone" placeholder="联系电话">
        <label>备注</label><textarea name="remark"></textarea>
        <button type="submit">添加成员</button>
      </form>
      <section>
        <h2 style="margin-bottom:12px;">成员列表</h2>
        <div class="grid" id="memberList"></div>
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
      <span class="filter-label" style="margin-left:10px;">负责人：</span>
      <select id="ownerFilter">
        <option value="">全部负责人</option>
      </select>
      <span class="filter-label">客户：</span>
      <select id="scheduleClientFilter">
        <option value="">全部客户</option>
      </select>
      <span class="filter-label">当前步骤：</span>
      <select id="scheduleStatusFilter">
        <option value="">全部步骤</option>
      </select>
      <span class="filter-label">截止日期：</span>
      <input type="date" id="scheduleDueFrom" title="开始日期">
      <span class="filter-label">至</span>
      <input type="date" id="scheduleDueTo" title="结束日期">
      <button type="button" class="small secondary" id="resetScheduleFilters">重置</button>
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
        <label>最低库存预警线</label><input name="minStock" type="number" min="0" value="0" placeholder="低于此数量时预警">
        <label>备注</label><textarea name="remark"></textarea>
        <button type="submit">添加材料</button>
      </form>
      <section>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h2 style="margin:0;">材料库存</h2>
          <button type="button" class="small secondary" id="showAllLedgerBtn">📊 查看全部流水</button>
        </div>
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
      <div class="wizard-steps" id="wizardSteps">
        <button type="button" class="wizard-step active" data-wiz-step="1"><span class="step-num">1</span>上传文件</button>
        <button type="button" class="wizard-step" data-wiz-step="2" disabled><span class="step-num">2</span>预览与匹配</button>
        <button type="button" class="wizard-step" data-wiz-step="3" disabled><span class="step-num">3</span>导入摘要</button>
      </div>
      <div class="modal-body">
        <div id="wizStep1" class="wiz-step-content">
          <div id="importEmpty" class="empty-state">
            <div class="icon">📁</div>
            <div>请选择JSON文件进行导入</div>
            <div class="meta" style="margin-top:8px;">支持导出的JSON格式文件</div>
            <div style="margin-top:18px;">
              <label class="io-btn io-btn-import" style="display:inline-flex;">
                📂 选择文件
                <input type="file" id="importFileInputWiz" accept=".json" style="display:none;">
              </label>
            </div>
            <div class="meta" id="importFileName" style="margin-top:12px;"></div>
          </div>
        </div>
        <div id="wizStep2" class="wiz-step-content" style="display:none;">
          <div class="entity-tabs" id="entityTabs">
            <button type="button" class="entity-tab active" data-entity="commissions">委托 <span class="ent-count" id="ent-count-commissions">0</span></button>
            <button type="button" class="entity-tab" data-entity="clients">客户 <span class="ent-count" id="ent-count-clients">0</span></button>
            <button type="button" class="entity-tab" data-entity="materials">材料 <span class="ent-count" id="ent-count-materials">0</span></button>
            <button type="button" class="entity-tab" data-entity="members">成员 <span class="ent-count" id="ent-count-members">0</span></button>
            <button type="button" class="entity-tab" data-entity="templates">步骤模板 <span class="ent-count" id="ent-count-templates">0</span></button>
          </div>
          <div id="entity-commissions" class="entity-content active">
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
          <div id="entity-clients" class="entity-content">
            <div id="clientsContent"></div>
          </div>
          <div id="entity-materials" class="entity-content">
            <div id="materialsContent"></div>
          </div>
          <div id="entity-members" class="entity-content">
            <div id="membersContent"></div>
          </div>
          <div id="entity-templates" class="entity-content">
            <div id="templatesContent"></div>
          </div>
        </div>
        <div id="wizStep3" class="wiz-step-content" style="display:none;">
          <div id="importSummary"></div>
        </div>
      </div>
      <div class="import-wizard-footer">
        <div class="footer-left" id="wizardFooterLeft"></div>
        <div class="footer-right">
          <button type="button" class="secondary" id="cancelImportBtn">取消</button>
          <button type="button" class="secondary" id="wizPrevBtn" style="display:none;">上一步</button>
          <button type="button" id="wizNextBtn">下一步</button>
          <button type="button" id="confirmImportBtn" style="display:none;">确认导入</button>
        </div>
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

        <div class="quote-diff-section" id="quoteDiffSection" style="display:none;">
          <div class="quote-section-header">
            <h4>与上一版对比 <span class="meta" id="quoteDiffVersions"></span></h4>
            <button type="button" class="small secondary" id="quoteDiffToggleBtn">隐藏对比</button>
          </div>
          <div class="quote-diff-container">
            <div class="quote-diff-amount-grid">
              <div class="quote-diff-amount-card">
                <div class="quote-diff-label">项目小计</div>
                <div class="quote-diff-values" id="diffItemsTotal"></div>
              </div>
              <div class="quote-diff-amount-card">
                <div class="quote-diff-label">人工费</div>
                <div class="quote-diff-values" id="diffLaborCost"></div>
              </div>
              <div class="quote-diff-amount-card">
                <div class="quote-diff-label">材料费</div>
                <div class="quote-diff-values" id="diffMaterialCost"></div>
              </div>
              <div class="quote-diff-amount-card highlight">
                <div class="quote-diff-label">总金额</div>
                <div class="quote-diff-values total" id="diffTotalAmount"></div>
              </div>
              <div class="quote-diff-amount-card">
                <div class="quote-diff-label">预计工期</div>
                <div class="quote-diff-values" id="diffEstimatedDays"></div>
              </div>
            </div>

            <div class="quote-diff-items-block" id="diffItemsBlock" style="display:none;">
              <div class="quote-diff-subtitle">项目明细变化</div>

              <div class="quote-diff-item-group" id="diffAddedGroup" style="display:none;">
                <div class="quote-diff-group-title added">新增项目 <span class="count-badge" id="diffAddedCount"></span></div>
                <div id="diffAddedList"></div>
              </div>

              <div class="quote-diff-item-group" id="diffRemovedGroup" style="display:none;">
                <div class="quote-diff-group-title removed">删除项目 <span class="count-badge" id="diffRemovedCount"></span></div>
                <div id="diffRemovedList"></div>
              </div>

              <div class="quote-diff-item-group" id="diffModifiedGroup" style="display:none;">
                <div class="quote-diff-group-title modified">调整项目 <span class="count-badge" id="diffModifiedCount"></span></div>
                <div id="diffModifiedList"></div>
              </div>
            </div>

            <div class="quote-diff-remark-block" id="diffRemarkBlock" style="display:none;">
              <div class="quote-diff-subtitle">备注变化</div>
              <div class="quote-diff-remark-compare">
                <div class="quote-diff-remark-old">
                  <div class="quote-diff-remark-label">上一版</div>
                  <div id="diffRemarkOld"></div>
                </div>
                <div class="quote-diff-remark-new">
                  <div class="quote-diff-remark-label">当前版</div>
                  <div id="diffRemarkNew"></div>
                </div>
              </div>
            </div>

            <div class="quote-diff-empty" id="diffEmpty" style="display:none;">
              两版内容完全一致，没有差异
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

  <div class="modal-overlay" id="acceptanceModal">
    <div class="modal acceptance-modal">
      <div class="modal-header">
        <h3 id="acceptanceModalTitle">交付验收</h3>
        <button class="modal-close" id="acceptanceModalClose">&times;</button>
      </div>
      <div class="modal-body">
        <div class="acceptance-info">
          <div class="acceptance-info-row">
            <span class="label">委托项目：</span>
            <strong id="acceptanceCommissionName">-</strong>
          </div>
          <div class="acceptance-info-row">
            <span class="label">客户：</span>
            <span id="acceptanceClientName">-</span>
          </div>
          <div class="acceptance-info-row">
            <span class="label">当前步骤：</span>
            <span id="acceptanceCurrentStep" class="pill">-</span>
          </div>
        </div>

        <div class="acceptance-section">
          <h4>验收结果</h4>
          <div class="acceptance-result">
            <label><input type="radio" name="acceptanceResult" value="验收通过"> 验收通过</label>
            <label><input type="radio" name="acceptanceResult" value="有条件通过"> 有条件通过</label>
            <label><input type="radio" name="acceptanceResult" value="需返修"> 需返修</label>
          </div>
        </div>

        <div class="acceptance-section">
          <h4>交付信息</h4>
          <label>交付日期</label>
          <input type="date" id="acceptanceDeliveryDate">
          <label>领取人</label>
          <input type="text" id="acceptanceReceiver" placeholder="请输入领取人姓名">
        </div>

        <div class="acceptance-section">
          <h4>遗留问题</h4>
          <textarea id="acceptanceRemainingIssues" rows="3" placeholder="如有遗留问题请在此说明"></textarea>
        </div>

        <div class="acceptance-section">
          <h4>后续保养建议</h4>
          <textarea id="acceptanceMaintenanceAdvice" rows="3" placeholder="请输入保养建议"></textarea>
        </div>

        <div id="acceptanceDetailView" style="display:none;">
          <div class="acceptance-section">
            <h4>验收详情</h4>
            <div class="acceptance-detail">
              <div class="row"><span class="label">验收结果：</span><span id="detailResult">-</span></div>
              <div class="row"><span class="label">交付日期：</span><span id="detailDeliveryDate">-</span></div>
              <div class="row"><span class="label">领取人：</span><span id="detailReceiver">-</span></div>
              <div class="row"><span class="label">遗留问题：</span><span id="detailRemainingIssues">-</span></div>
              <div class="row"><span class="label">保养建议：</span><span id="detailMaintenanceAdvice">-</span></div>
              <div class="row"><span class="label">验收时间：</span><span id="detailAcceptedAt">-</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer quote-footer">
        <button type="button" class="secondary" id="acceptanceCloseBtn">关闭</button>
        <div id="acceptanceEditActions">
          <button type="button" id="acceptanceSaveBtn">确认验收</button>
        </div>
        <div id="acceptanceViewActions" style="display:none;">
          <button type="button" class="secondary" id="acceptanceDeleteBtn">撤销验收</button>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="detailModal">
    <div class="modal detail-modal">
      <div class="modal-header">
        <h3 id="detailTitle">委托详情</h3>
        <button class="modal-close" id="detailModalClose">&times;</button>
      </div>
      <div class="detail-nav" id="detailNav">
        <div class="detail-nav-btn active" data-detail-section="info">📋 基础信息</div>
        <div class="detail-nav-btn" data-detail-section="timeline">🔄 步骤时间线</div>
        <div class="detail-nav-btn" data-detail-section="images">📷 影像档案</div>
        <div class="detail-nav-btn" data-detail-section="quotes">💰 报价</div>
        <div class="detail-nav-btn" data-detail-section="acceptance">✅ 交付验收</div>
        <div class="detail-nav-btn" data-detail-section="oplogs">📜 操作历史</div>
        <div class="detail-nav-btn" data-detail-section="versions">🕐 版本追溯</div>
      </div>
      <div class="modal-body">
        <div class="detail-section active" id="detail-info"></div>
        <div class="detail-section" id="detail-timeline"></div>
        <div class="detail-section" id="detail-images"></div>
        <div class="detail-section" id="detail-quotes"></div>
        <div class="detail-section" id="detail-acceptance"></div>
        <div class="detail-section" id="detail-oplogs"></div>
        <div class="detail-section" id="detail-versions"></div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="materialModal">
    <div class="modal" style="max-width:480px;">
      <div class="modal-header">
        <h3 id="materialModalTitle">编辑材料</h3>
        <button class="modal-close" id="materialModalClose">&times;</button>
      </div>
      <div class="modal-body">
        <form id="materialEditForm" class="material-edit-form">
          <input type="hidden" name="id">
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
          <label>库存数量</label><input name="stock" type="number" min="0">
          <label>单位</label><input name="unit" placeholder="如：张、克、个">
          <label>最低库存预警线</label><input name="minStock" type="number" min="0" placeholder="低于此数量时预警">
          <label>备注</label><textarea name="remark"></textarea>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button type="submit">保存修改</button>
            <button type="button" class="secondary" id="cancelMaterialEdit">取消</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="stockLedgerModal">
    <div class="modal" style="max-width:960px;">
      <div class="modal-header">
        <h3 id="stockLedgerTitle">材料库存流水</h3>
        <button class="modal-close" id="stockLedgerModalClose">&times;</button>
      </div>
      <div class="modal-body">
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
          <input id="ledgerFilterMaterial" placeholder="按材料名称搜索" style="flex:1;min-width:180px;">
          <select id="ledgerFilterType" style="min-width:140px;">
            <option value="">全部变动类型</option>
          </select>
          <button class="small secondary" id="ledgerRefreshBtn">刷新</button>
        </div>
        <div id="stockLedgerInfo" class="meta" style="margin-bottom:8px;"></div>
        <div class="ledger-table-wrap" style="overflow:auto;max-height:60vh;">
          <table class="ledger-table" style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:var(--bg);position:sticky;top:0;z-index:1;">
                <th style="padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;">时间</th>
                <th style="padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;">类型</th>
                <th style="padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;">材料</th>
                <th style="padding:8px 6px;border-bottom:1px solid var(--line);text-align:right;">变动</th>
                <th style="padding:8px 6px;border-bottom:1px solid var(--line);text-align:right;">库存(前/后)</th>
                <th style="padding:8px 6px;border-bottom:1px solid var(--line);text-align:right;">占用(前/后)</th>
                <th style="padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;">委托</th>
                <th style="padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;">操作人</th>
                <th style="padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;">备注</th>
              </tr>
            </thead>
            <tbody id="stockLedgerBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <style>
    .mat-chip{position:relative;padding-right:8px;}
    .mat-chip-status{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;font-size:10px;}
    .mat-chip-reserved{background:rgba(255,152,0,.12);color:#c77700;border:1px solid rgba(255,152,0,.3);}
    .mat-chip-reserved .mat-chip-status{background:#fff3e0;color:#e65100;}
    .mat-chip-consumed{background:rgba(76,175,80,.12);color:#2e7d32;border:1px solid rgba(76,175,80,.3);}
    .mat-chip-consumed .mat-chip-status{background:#e8f5e9;color:#2e7d32;}
    .mat-chip-pending{background:rgba(158,158,158,.1);color:#616161;}
    .mat-chip-pending .mat-chip-status{background:#f5f5f5;color:#757575;}
    .ledger-type-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;}
    .ledger-type-reserve{background:#fff3e0;color:#ef6c00;}
    .ledger-type-release_reserve{background:#f1f8e9;color:#558b2f;}
    .ledger-type-adjust_reserve{background:#fff8e1;color:#f57f17;}
    .ledger-type-consume{background:#e8f5e9;color:#2e7d32;}
    .ledger-type-undo_consume{background:#e0f7fa;color:#00838f;}
    .ledger-type-restore{background:#e3f2fd;color:#1565c0;}
    .ledger-type-manual_in{background:#e8eaf6;color:#283593;}
    .ledger-type-manual_out{background:#fce4ec;color:#ad1457;}
    .ledger-type-init{background:#eceff1;color:#455a64;}
    .ledger-type-import_reserve,.ledger-type-import_consume{background:#f3e5f5;color:#6a1b9a;}
    .ledger-qty-pos{color:#2e7d32;font-weight:700;}
    .ledger-qty-neg{color:#c62828;font-weight:700;}
    .ledger-link{color:var(--accent);cursor:pointer;text-decoration:underline;}
    .io-actions{display:flex;gap:10px;align-items:center;padding:16px 28px 0;flex-wrap:wrap;}
    .io-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:600;border:1px solid var(--line);background:var(--surface);color:var(--text);cursor:pointer;}
    .io-btn:hover{background:var(--bg);}
    .io-btn-export{border-color:rgba(33,150,243,.3);color:#1976d2;}
    .io-btn-import{border-color:rgba(76,175,80,.3);color:#2e7d32;}
  </style>

  <script>
    const defaultSteps = ${JSON.stringify(defaultSteps)};
    const snapshotTrackedFields = ${JSON.stringify(snapshotTrackedFields)};
    let commissions = [];
    let materials = [];
    let clients = [];
    let stepTemplates = [];
    let members = [];
    let currentTab = "commissions";
    let selectedClientId = null;
    let currentCommissionSteps = [...defaultSteps];
    let editingTemplateId = null;
    let editingTemplateSteps = [];
    let newTemplateSteps = ["接收", "清洁", "补片", "补色", "交付"];
    let currentStageFilter = "active";
    let commissionFilter = {
      owner: "",
      client: "",
      status: "",
      dueFrom: "",
      dueTo: ""
    };
    let scheduleFilter = {
      owner: "",
      client: "",
      status: "",
      dueFrom: "",
      dueTo: ""
    };

    function getOperator() {
      const sel = document.getElementById("operatorSelect");
      if (!sel) return { operator: "", operatorId: "" };
      const opt = sel.options[sel.selectedIndex];
      return { operator: opt?.text || "", operatorId: sel.value || "" };
    }

    function renderOperatorSelect() {
      const sel = document.getElementById("operatorSelect");
      if (!sel) return;
      const curVal = sel.value;
      sel.innerHTML = '<option value="">— 请选择 —</option>' + members.map(m => '<option value="'+m.id+'">'+m.name+'</option>').join("");
      if (curVal) sel.value = curVal;
      const savedOp = localStorage.getItem("currentOperatorId");
      if (savedOp && !sel.value && members.some(m => m.id === savedOp)) sel.value = savedOp;
    }

    document.getElementById("operatorSelect").onchange = function() {
      localStorage.setItem("currentOperatorId", this.value);
    };

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }

    function escapeHtml(str) {
      const div = document.createElement("div");
      div.textContent = String(str || "");
      return div.innerHTML;
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

    const refreshScheduleBtn = document.getElementById("refreshScheduleBtn");
    if (refreshScheduleBtn) {
      refreshScheduleBtn.onclick = async () => {
        await loadSchedule();
        await loadAll();
      };
    }

    function applyCommissionFilters(list, filter) {
      return list.filter(c => {
        if (filter.owner && c.owner !== filter.owner) return false;
        if (filter.client && c.client !== filter.client) return false;
        if (filter.status && c.status !== filter.status) return false;
        if (filter.dueFrom && c.dueDate) {
          if (c.dueDate < filter.dueFrom) return false;
        }
        if (filter.dueTo && c.dueDate) {
          if (c.dueDate > filter.dueTo) return false;
        }
        return true;
      });
    }

    function isCommissionFilterActive(filter) {
      return filter.owner || filter.client || filter.status || filter.dueFrom || filter.dueTo;
    }

    function saveCommissionFilter() {
      localStorage.setItem("commissionFilter", JSON.stringify(commissionFilter));
    }

    function saveScheduleFilter() {
      localStorage.setItem("scheduleFilter", JSON.stringify(scheduleFilter));
      localStorage.setItem("scheduleOwnerFilter", scheduleFilter.owner || "");
    }

    function renderCommissionFilterSelects() {
      const ownerSel = document.getElementById("filterOwner");
      const clientSel = document.getElementById("filterClient");
      const statusSel = document.getElementById("filterStatus");
      const dueFromInp = document.getElementById("filterDueFrom");
      const dueToInp = document.getElementById("filterDueTo");

      if (ownerSel) {
        const owners = [...new Set(commissions.map(c => c.owner).filter(Boolean))].sort();
        ownerSel.innerHTML = '<option value="">全部负责人</option>' +
          owners.map(o => '<option value="' + o + '"' + (o === commissionFilter.owner ? ' selected' : '') + '>' + o + '</option>').join("");
      }
      if (clientSel) {
        const clientList = [...new Set(commissions.map(c => c.client).filter(Boolean))].sort();
        clientSel.innerHTML = '<option value="">全部客户</option>' +
          clientList.map(cl => '<option value="' + cl + '"' + (cl === commissionFilter.client ? ' selected' : '') + '>' + cl + '</option>').join("");
      }
      if (statusSel) {
        const statuses = [...new Set(commissions.map(c => c.status).filter(Boolean))].sort();
        statusSel.innerHTML = '<option value="">全部步骤</option>' +
          statuses.map(s => '<option value="' + s + '"' + (s === commissionFilter.status ? ' selected' : '') + '>' + s + '</option>').join("");
      }
      if (dueFromInp) dueFromInp.value = commissionFilter.dueFrom || "";
      if (dueToInp) dueToInp.value = commissionFilter.dueTo || "";

      const filterContainer = document.getElementById("commissionFilters");
      if (filterContainer) {
        const indicator = filterContainer.querySelector(".filter-active-indicator");
        if (isCommissionFilterActive(commissionFilter)) {
          if (!indicator) {
            const btn = document.getElementById("resetCommissionFilters");
            if (btn) {
              const span = document.createElement("span");
              span.className = "filter-active-indicator";
              span.textContent = "已筛选";
              btn.parentNode.insertBefore(span, btn.nextSibling);
            }
          }
        } else {
          if (indicator) indicator.remove();
        }
      }
    }

    function renderScheduleFilterSelects() {
      const ownerSel = document.getElementById("ownerFilter");
      const clientSel = document.getElementById("scheduleClientFilter");
      const statusSel = document.getElementById("scheduleStatusFilter");
      const dueFromInp = document.getElementById("scheduleDueFrom");
      const dueToInp = document.getElementById("scheduleDueTo");

      if (ownerSel) {
        const owners = [...new Set(commissions.filter(c => c.acceptance === null).map(c => c.owner).filter(Boolean))].sort();
        ownerSel.innerHTML = '<option value="">全部负责人</option>' +
          owners.map(o => '<option value="' + o + '"' + (o === scheduleFilter.owner ? ' selected' : '') + '>' + o + '</option>').join("");
      }
      if (clientSel) {
        const clientList = [...new Set(commissions.filter(c => c.acceptance === null).map(c => c.client).filter(Boolean))].sort();
        clientSel.innerHTML = '<option value="">全部客户</option>' +
          clientList.map(cl => '<option value="' + cl + '"' + (cl === scheduleFilter.client ? ' selected' : '') + '>' + cl + '</option>').join("");
      }
      if (statusSel) {
        const statuses = [...new Set(commissions.filter(c => c.acceptance === null).map(c => c.status).filter(Boolean))].sort();
        statusSel.innerHTML = '<option value="">全部步骤</option>' +
          statuses.map(s => '<option value="' + s + '"' + (s === scheduleFilter.status ? ' selected' : '') + '>' + s + '</option>').join("");
      }
      if (dueFromInp) dueFromInp.value = scheduleFilter.dueFrom || "";
      if (dueToInp) dueToInp.value = scheduleFilter.dueTo || "";
    }

    function bindCommissionFilterEvents() {
      const ownerSel = document.getElementById("filterOwner");
      const clientSel = document.getElementById("filterClient");
      const statusSel = document.getElementById("filterStatus");
      const dueFromInp = document.getElementById("filterDueFrom");
      const dueToInp = document.getElementById("filterDueTo");
      const resetBtn = document.getElementById("resetCommissionFilters");

      if (ownerSel) ownerSel.onchange = () => { commissionFilter.owner = ownerSel.value; saveCommissionFilter(); renderCommissions(); };
      if (clientSel) clientSel.onchange = () => { commissionFilter.client = clientSel.value; saveCommissionFilter(); renderCommissions(); };
      if (statusSel) statusSel.onchange = () => { commissionFilter.status = statusSel.value; saveCommissionFilter(); renderCommissions(); };
      if (dueFromInp) dueFromInp.onchange = () => { commissionFilter.dueFrom = dueFromInp.value; saveCommissionFilter(); renderCommissions(); };
      if (dueToInp) dueToInp.onchange = () => { commissionFilter.dueTo = dueToInp.value; saveCommissionFilter(); renderCommissions(); };
      if (resetBtn) resetBtn.onclick = () => {
        commissionFilter = { owner: "", client: "", status: "", dueFrom: "", dueTo: "" };
        saveCommissionFilter();
        renderCommissionFilterSelects();
        renderCommissions();
      };
    }
    bindCommissionFilterEvents();

    function bindScheduleFilterEvents() {
      const ownerSel = document.getElementById("ownerFilter");
      const clientSel = document.getElementById("scheduleClientFilter");
      const statusSel = document.getElementById("scheduleStatusFilter");
      const dueFromInp = document.getElementById("scheduleDueFrom");
      const dueToInp = document.getElementById("scheduleDueTo");
      const resetBtn = document.getElementById("resetScheduleFilters");

      if (ownerSel) ownerSel.onchange = () => { scheduleFilter.owner = ownerSel.value; scheduleOwnerFilter = ownerSel.value; saveScheduleFilter(); renderSchedule(); };
      if (clientSel) clientSel.onchange = () => { scheduleFilter.client = clientSel.value; saveScheduleFilter(); renderSchedule(); };
      if (statusSel) statusSel.onchange = () => { scheduleFilter.status = statusSel.value; saveScheduleFilter(); renderSchedule(); };
      if (dueFromInp) dueFromInp.onchange = () => { scheduleFilter.dueFrom = dueFromInp.value; saveScheduleFilter(); renderSchedule(); };
      if (dueToInp) dueToInp.onchange = () => { scheduleFilter.dueTo = dueToInp.value; saveScheduleFilter(); renderSchedule(); };
      if (resetBtn) resetBtn.onclick = () => {
        scheduleFilter = { owner: "", client: "", status: "", dueFrom: "", dueTo: "" };
        scheduleOwnerFilter = "";
        saveScheduleFilter();
        renderScheduleFilterSelects();
        renderSchedule();
      };
    }
    bindScheduleFilterEvents();

    function renderCommissions() {
      renderCommissionFilterSelects();
      const stats = document.querySelector("#stats");
      const list = document.querySelector("#list");
      const stepCounts = {};

      const deliveredCommissions = commissions.filter(c => c.acceptance !== null);
      const activeCommissions = commissions.filter(c => c.acceptance === null);
      const countActiveEl = document.getElementById("countActive");
      const countDeliveredEl = document.getElementById("countDelivered");

      const stageFilteredCommissions = currentStageFilter === "delivered" ? deliveredCommissions : activeCommissions;
      const filteredCommissions = applyCommissionFilters(stageFilteredCommissions, commissionFilter);

      const activeFiltered = applyCommissionFilters(activeCommissions, commissionFilter).length;
      const deliveredFiltered = applyCommissionFilters(deliveredCommissions, commissionFilter).length;
      const filterActive = isCommissionFilterActive(commissionFilter);

      if (countActiveEl) countActiveEl.textContent = filterActive ? (activeFiltered + "/" + activeCommissions.length) : activeCommissions.length;
      if (countDeliveredEl) countDeliveredEl.textContent = filterActive ? (deliveredFiltered + "/" + deliveredCommissions.length) : deliveredCommissions.length;

      for (const c of filteredCommissions) {
        (c.steps || defaultSteps).forEach(s => { if (!stepCounts[s]) stepCounts[s] = 0; });
        if (!stepCounts[c.status]) stepCounts[c.status] = 0;
      }
      const allSteps = Object.keys(stepCounts);
      stats.innerHTML = allSteps.map(step => '<div class="stat"><span>'+step+'</span><strong>'+filteredCommissions.filter(c => c.status === step).length+'</strong></div>').join("");

      if (filteredCommissions.length === 0) {
        let emptyMsg = currentStageFilter === "delivered" ? "暂无已交付的委托" : "暂无进行中的委托";
        if (filterActive) emptyMsg = "没有符合筛选条件的委托";
        list.innerHTML = '<div class="empty-state"><div class="icon">' + (currentStageFilter === "delivered" ? "📦" : "📋") + '</div><div>' + emptyMsg + '</div></div>';
        return;
      }

      list.innerHTML = filteredCommissions.map(c => {
        const cSteps = c.steps || defaultSteps;
        const lastStep = cSteps[cSteps.length - 1];
        const hasAcceptance = c.acceptance !== null;
        const cardClass = hasAcceptance ? "card completed" : "card";
        const matChips = (c.materials && c.materials.length) ? c.materials.map(m => '<span class="mat-chip">'+m.name+' ×'+m.quantity+'</span>').join("") : '';
        const tplBadge = c.templateName ? '<span class="pill" style="margin-left:6px;background:var(--bg);">'+c.templateName+'</span>' : '';
        const imgCounts = c.images ? {
          before: c.images.before?.length || 0,
          during: c.images.during?.length || 0,
          after: c.images.after?.length || 0
        } : { before:0, during:0, after:0 };
        const totalImgs = imgCounts.before + imgCounts.during + imgCounts.after;
        const currentQuote = c.currentQuoteId ? (c.quotes || []).find(q => q.id === c.currentQuoteId) : null;
        let quoteBadge = '';
        if (currentQuote) {
          quoteBadge = '<span class="pill ' + currentQuote.status + '" style="margin-left:6px;">¥' + Number(currentQuote.totalAmount).toFixed(2) + '</span>';
        } else {
          quoteBadge = '<span class="pill" style="margin-left:6px;background:var(--bg);">未报价</span>';
        }
        let acceptanceLine = '';
        if (hasAcceptance && c.acceptance) {
          acceptanceLine = '<div style="margin-top:4px;font-size:12px;color:var(--green);font-weight:600;">✅ ' + c.acceptance.result + '</div>';
        }
        const daysLeft = c.dueDate ? getDaysUntilDue(c.dueDate) : null;
        let dueBadge = '';
        if (daysLeft !== null && !hasAcceptance) {
          if (daysLeft < 0) dueBadge = '<span style="color:#c0392b;font-weight:700;font-size:12px;margin-left:6px;">逾期'+Math.abs(daysLeft)+'天</span>';
          else if (daysLeft <= 3) dueBadge = '<span style="color:#e67e22;font-weight:700;font-size:12px;margin-left:6px;">还剩'+daysLeft+'天</span>';
        }

        const isAtDeliveryStep = c.status === lastStep;
        const canAcceptance = isAtDeliveryStep || hasAcceptance;
        let quickButtons = '<div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap;margin-top:8px;">';
        quickButtons += '<button class="small" data-quick-images="'+c.id+'" style="white-space:nowrap;background:var(--green);">📷 影像</button>';
        quickButtons += '<button class="small" data-quick-quote="'+c.id+'" style="white-space:nowrap;background:var(--orange);">💰 报价</button>';
        if (canAcceptance) {
          quickButtons += '<button class="small" data-quick-acceptance="'+c.id+'" style="white-space:nowrap;">✅ 验收</button>';
        }
        quickButtons += '<button class="small" data-detail="'+c.id+'" style="white-space:nowrap;">📄 详情</button>';
        quickButtons += '</div>';

        return '<article class="'+cardClass+'" style="cursor:pointer;" data-detail="'+c.id+'"><div style="display:flex;justify-content:space-between;align-items:flex-start;"><h3 style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin:0;color:var(--accent);">'+c.roleName+tplBadge+'</h3><span class="pill">'+c.status+'</span></div><div class="meta" style="margin-top:4px;">'+(c.client||'')+' · '+(c.era||'')+' · '+(c.owner||'')+'</div><div style="font-size:13px;margin-top:4px;">'+(c.damage||'—')+'</div>'+(matChips?'<div class="mat-chips" style="margin-top:4px;">'+matChips+'</div>':'')+'<div style="display:flex;gap:8px;align-items:center;margin-top:6px;font-size:12px;color:var(--muted);"><span>📷 '+totalImgs+'</span>'+quoteBadge+'<span>📅 '+(c.dueDate||'—')+dueBadge+'</span></div>'+acceptanceLine+quickButtons+'</article>';
      }).join("");
      document.querySelectorAll("[data-detail]").forEach(btn => btn.onclick = (e) => {
        e.stopPropagation();
        openDetailModal(btn.dataset.detail);
      });
      document.querySelectorAll("[data-quick-images]").forEach(btn => btn.onclick = (e) => {
        e.stopPropagation();
        openImagesModal(btn.dataset.quickImages);
      });
      document.querySelectorAll("[data-quick-quote]").forEach(btn => btn.onclick = (e) => {
        e.stopPropagation();
        openQuoteModal(btn.dataset.quickQuote);
      });
      document.querySelectorAll("[data-quick-acceptance]").forEach(btn => btn.onclick = (e) => {
        e.stopPropagation();
        openAcceptanceModal(btn.dataset.quickAcceptance);
      });
    }

    function renderClientSelect() {
      const select = document.getElementById("clientSelect");
      const currentVal = select.value;
      select.innerHTML = '<option value="">— 选择已有客户 —</option>' + clients.map(c => '<option value="'+c.id+'">'+c.name+(c.contact?' ('+c.contact+')':'')+'</option>').join("");
      if (currentVal) select.value = currentVal;
      const nameInput = document.getElementById("newClientName");
      const newFields = document.getElementById("clientNewFields");
      const tipDiv = document.getElementById("clientFollowupTip");
      const updateFollowupTip = () => {
        if (!tipDiv) return;
        if (!select.value) {
          tipDiv.style.display = "none";
          return;
        }
        const client = clients.find(c => c.id === select.value);
        if (client && client.lastFollowUp) {
          const summary = client.lastFollowUp.content.length > 80 ? client.lastFollowUp.content.substring(0, 80) + '...' : client.lastFollowUp.content;
          tipDiv.className = "client-last-followup-tip";
          tipDiv.style.display = "block";
          tipDiv.innerHTML = '<strong>📞 最近回访：</strong>' + client.lastFollowUp.date + (client.lastFollowUp.operator ? ' · ' + escapeHtml(client.lastFollowUp.operator) : '') + '<br>' +
            '<span style="margin-top:4px;display:block;">' + escapeHtml(summary) + '</span>' +
            (client.lastFollowUp.nextFollowDate ? '<br><span style="color:var(--orange);">📅 下次跟进：' + client.lastFollowUp.nextFollowDate + '</span>' : '');
        } else {
          tipDiv.style.display = "none";
        }
      };
      select.onchange = () => {
        if (select.value) {
          nameInput.value = "";
          nameInput.removeAttribute("required");
          newFields.classList.remove("visible");
        } else {
          nameInput.setAttribute("required", "required");
        }
        updateFollowupTip();
      };
      updateFollowupTip();
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
        let followupHtml = '';
        if (c.lastFollowUp) {
          const summary = c.lastFollowUp.content.length > 50 ? c.lastFollowUp.content.substring(0, 50) + '...' : c.lastFollowUp.content;
          followupHtml = '<div class="client-followup-summary">' +
            '<div class="date">📞 最近回访：' + c.lastFollowUp.date + (c.lastFollowUp.operator ? ' · ' + escapeHtml(c.lastFollowUp.operator) : '') + '</div>' +
            '<div class="content">' + escapeHtml(summary) + '</div>' +
            (c.lastFollowUp.nextFollowDate ? '<div class="date" style="margin-top:4px;color:var(--orange);">📅 下次跟进：' + c.lastFollowUp.nextFollowDate + '</div>' : '') +
            '</div>';
        }
        return '<div class="card" style="cursor:pointer;" data-client-id="'+c.id+'">' +
          '<h3 style="margin:0;font-size:16px;">'+c.name+'</h3>' +
          (c.contact ? '<div class="meta">联系人：'+c.contact+'</div>' : '') +
          (c.phone ? '<div class="meta">电话：'+c.phone+'</div>' : '') +
          '<div class="meta">历史委托：<strong>'+c.commissionCount+'</strong> 条</div>' +
          followupHtml +
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
        
        let followUpsHtml = '';
        if (client.followUps && client.followUps.length) {
          followUpsHtml = client.followUps.map(f => 
            '<div class="client-followup-item">' +
            '<div class="followup-header">' +
            '<span class="followup-date">📞 ' + f.date + '</span>' +
            (f.operator ? '<span class="followup-operator">回访人：' + escapeHtml(f.operator) + '</span>' : '') +
            '</div>' +
            '<div class="followup-content">' + escapeHtml(f.content).split(String.fromCharCode(10)).join('<br>') + '</div>' +
            (f.nextFollowDate ? '<div class="followup-next">📅 下次跟进日期：' + f.nextFollowDate + '</div>' : '') +
            '</div>'
          ).join("");
        } else {
          followUpsHtml = '<div class="meta">暂无回访记录</div>';
        }

        const today = new Date().toISOString().slice(0, 10);
        const currentOperator = members.find(m => m.id === localStorage.getItem("currentOperatorId"));
        
        detail.innerHTML = '<div class="client-detail">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<h3>'+escapeHtml(client.name)+'</h3>' +
          '<button class="small secondary" id="editClientBtn">编辑</button>' +
          '</div>' +
          '<div class="client-info-row"><span class="label">联系人</span><span>'+(client.contact?escapeHtml(client.contact):'—')+'</span></div>' +
          '<div class="client-info-row"><span class="label">电话</span><span>'+(client.phone?escapeHtml(client.phone):'—')+'</span></div>' +
          '<div class="client-info-row"><span class="label">地址</span><span>'+(client.address?escapeHtml(client.address):'—')+'</span></div>' +
          '<div class="client-info-row"><span class="label">备注</span><span>'+(client.remark?escapeHtml(client.remark):'—')+'</span></div>' +
          '<div class="client-info-row"><span class="label">委托数</span><span><strong>'+client.commissionCount+'</strong> 条</span></div>' +
          '<div class="client-followup-list">' +
          '<h4 style="margin:16px 0 8px;">回访记录</h4>' +
          followUpsHtml +
          '</div>' +
          '<div class="followup-form">' +
          '<h4>新增回访记录</h4>' +
          '<div class="form-row">' +
          '<div><label>回访时间 *</label><input type="date" id="followupDate" value="'+today+'"></div>' +
          '<div><label>回访人</label><input type="text" id="followupOperator" placeholder="回访人姓名" value="'+(currentOperator?escapeHtml(currentOperator.name):'')+'"></div>' +
          '</div>' +
          '<label>沟通内容 *</label><textarea id="followupContent" placeholder="请输入沟通内容..."></textarea>' +
          '<label>下次跟进日期</label><input type="date" id="followupNextDate">' +
          '<div style="margin-top:10px;"><button id="addFollowupBtn">保存回访记录</button></div>' +
          '</div>' +
          '<div class="client-commission-list">' +
          '<h4 style="margin:16px 0 8px;">关联修复记录</h4>' +
          (client.commissions && client.commissions.length ? client.commissions.map(c =>
            '<div class="client-commission-item">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<strong>'+(c.roleName?escapeHtml(c.roleName):'未命名')+'</strong>' +
            '<span class="pill">'+(c.status?escapeHtml(c.status):'')+'</span>' +
            '</div>' +
            '<div class="meta">'+(c.era?escapeHtml(c.era):'')+' · 负责人：'+(c.owner?escapeHtml(c.owner):'')+' · 截止：'+(c.dueDate?escapeHtml(c.dueDate):'')+'</div>' +
            '<div class="meta">破损：'+(c.damage?escapeHtml(c.damage):'—')+'</div>' +
            (c.records && c.records.length ? '<div class="meta" style="margin-top:4px;">'+c.records.map(r=>escapeHtml(r.step)+'：'+escapeHtml(r.note)).join(' → ')+'</div>' : '') +
            '</div>'
          ).join("") : '<div class="meta">暂无关联修复记录</div>') +
          '</div>' +
          '<div id="editClientForm" style="display:none;margin-top:16px;padding:16px;background:var(--bg);border-radius:6px;">' +
          '<h4>编辑客户信息</h4>' +
          '<label>名称</label><input id="editName" value="'+escapeHtml(client.name)+'">' +
          '<label>联系人</label><input id="editContact" value="'+(client.contact?escapeHtml(client.contact):'')+'">' +
          '<label>电话</label><input id="editPhone" value="'+(client.phone?escapeHtml(client.phone):'')+'">' +
          '<label>地址</label><input id="editAddress" value="'+(client.address?escapeHtml(client.address):'')+'">' +
          '<label>备注</label><textarea id="editRemark">'+(client.remark?escapeHtml(client.remark):'')+'</textarea>' +
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
        document.getElementById("addFollowupBtn").onclick = async () => {
          const date = document.getElementById("followupDate").value;
          const content = document.getElementById("followupContent").value.trim();
          const operator = document.getElementById("followupOperator").value.trim();
          const nextFollowDate = document.getElementById("followupNextDate").value;
          if (!date) return alert("请选择回访时间");
          if (!content) return alert("请输入沟通内容");
          try {
            await api("/api/clients/" + id + "/followups", {
              method: "POST",
              body: JSON.stringify({ date, operator, content, nextFollowDate })
            });
            await loadAll();
            await renderClientDetail(id);
          } catch (e) {
            alert(e.message);
          }
        };
      } catch (e) {
        alert(e.message);
      }
    }

    function renderOwnerSelect() {
      const sel = document.getElementById("ownerSelect");
      if (!sel) return;
      const curVal = sel.value;
      sel.innerHTML = '<option value="">— 选择负责人 —</option>' + members.map(m => '<option value="'+m.name+'">'+m.name+' ('+m.role+')'+'</option>').join("");
      if (curVal) sel.value = curVal;
    }

    function renderMembers() {
      const list = document.getElementById("memberList");
      if (!list) return;
      if (!members.length) {
        list.innerHTML = '<div class="card meta">暂无成员</div>';
        return;
      }
      list.innerHTML = members.map(m => {
        return '<div class="card member-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<h3 style="margin:0;font-size:16px;">'+m.name+'</h3>' +
          '<span class="pill">'+m.role+'</span>' +
          '</div>' +
          (m.phone ? '<div class="meta">电话：'+m.phone+'</div>' : '') +
          (m.remark ? '<div class="meta">备注：'+m.remark+'</div>' : '') +
          '<div class="meta">负责委托：<strong>'+commissions.filter(c => c.owner === m.name).length+'</strong> 条</div>' +
          '<div style="display:flex;gap:6px;margin-top:4px;">' +
          '<button class="small" data-edit-member="'+m.id+'">编辑</button>' +
          '<button class="small secondary" data-delete-member="'+m.id+'">删除</button>' +
          '</div>' +
          '</div>';
      }).join("");
      document.querySelectorAll("[data-edit-member]").forEach(btn => {
        btn.onclick = () => {
          const m = members.find(x => x.id === btn.dataset.editMember);
          if (!m) return;
          const newName = prompt("姓名：", m.name);
          if (newName === null) return;
          const newRole = prompt("角色：", m.role);
          const newPhone = prompt("电话：", m.phone);
          const newRemark = prompt("备注：", m.remark);
          if (newName && newName.trim()) {
            api("/api/members/" + m.id, {
              method: "PUT",
              body: JSON.stringify({ name: newName.trim(), role: newRole || "", phone: newPhone || "", remark: newRemark || "" })
            }).then(() => loadAll()).catch(e => alert(e.message));
          }
        };
      });
      document.querySelectorAll("[data-delete-member]").forEach(btn => {
        btn.onclick = async () => {
          const m = members.find(x => x.id === btn.dataset.deleteMember);
          if (!m) return;
          const assignedCount = commissions.filter(c => c.owner === m.name).length;
          if (assignedCount > 0 && !confirm(m.name + " 还有 " + assignedCount + " 条负责委托，确定删除吗？")) return;
          if (assignedCount === 0 && !confirm("确定删除 " + m.name + " 吗？")) return;
          try {
            await api("/api/members/" + m.id, { method: "DELETE" });
            await loadAll();
          } catch (e) {
            alert(e.message);
          }
        };
      });
    }

    document.querySelector("#memberForm").onsubmit = async event => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const data = Object.fromEntries(formData.entries());
      try {
        await api("/api/members", { method:"POST", body: JSON.stringify(data) });
        event.target.reset();
        await loadAll();
      } catch (e) {
        alert(e.message);
      }
    };

    function renderMaterialSelect() {
      const container = document.getElementById("materialSelect");
      if (!materials.length) {
        container.innerHTML = '<div class="meta">暂无材料，请先在材料台账中添加</div>';
        return;
      }
      container.innerHTML = materials.map(m => {
        const status = getStockStatus(m);
        const itemClass = status.level === "danger" ? "stock-warning-item" : (status.level === "warning" || status.level === "low" ? "stock-low-item" : "");
        return '<div class="material-select-item '+itemClass+'" style="padding:6px 8px;">' +
          '<input type="checkbox" id="mat_'+m.id+'" value="'+m.id+'" data-unit="'+m.unit+'" data-name="'+m.name+'">' +
          '<label for="mat_'+m.id+'" style="margin:0;flex:1;">'+m.name+' <span class="meta">('+m.batch+')</span></label>' +
          '<input type="number" min="0" step="1" value="0" data-qty="'+m.id+'" style="width:70px;">' +
          '<span class="meta" style="font-size:12px;">'+m.unit+'</span>' +
          '<span class="meta" style="font-size:11px;'+(status.level==='danger'?'color:var(--red);font-weight:700;':(status.level==='warning'||status.level==='low'?'color:var(--orange);font-weight:700;':''))+'">可用 '+m.available+' / 库存 '+m.stock+' / 占用 '+(m.reserved||0)+(m.minStock>0?' / 预警 '+m.minStock:'')+'</span>' +
          '</div>';
      }).join("");
    }

    function getStockStatus(m) {
      const available = typeof m.available === "number" ? m.available : ((Number(m.stock)||0) - (Number(m.reserved)||0));
      if (m.minStock > 0 && available <= 0) return { level: "danger", label: "已无可用", className: "danger" };
      if (m.minStock > 0 && available < m.minStock) return { level: "warning", label: "可用不足", className: "warning" };
      if (m.minStock > 0 && available < m.minStock * 1.5) return { level: "low", label: "可用偏低", className: "warning" };
      return { level: "normal", label: "库存正常", className: "normal" };
    }

    function renderMaterials() {
      const list = document.getElementById("materialList");
      if (!materials.length) {
        list.innerHTML = '<div class="card meta">暂无材料</div>';
        return;
      }
      list.innerHTML = materials.map(m => {
        const status = getStockStatus(m);
        const cardClass = status.level === "danger" ? "stock-warning-card" : (status.level === "warning" || status.level === "low" ? "stock-low-card" : "");
        return '<div class="card material-card '+cardClass+'" data-mat-id="'+m.id+'">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<h3 style="margin:0;font-size:16px;">'+m.name+'</h3>' +
          '<span class="stock-badge '+status.className+'">'+status.label+'</span>' +
          '</div>' +
          '<div class="meta">类别：'+m.category+'</div>' +
          '<div class="meta">批次：'+m.batch+'</div>' +
          '<div class="meta">单位：'+m.unit+'</div>' +
          '<div>可用量：<span class="'+(status.level==='danger'?'stock-warning':(status.level==='warning'||status.level==='low'?'stock-low':''))+'"><b>'+m.available+'</b> '+m.unit+'</span></div>' +
          '<div class="meta">库存：'+m.stock+' '+m.unit+'　占用：'+(m.reserved||0)+' '+m.unit+'</div>' +
          (m.minStock > 0 ? '<div class="meta">预警线：'+m.minStock+' '+m.unit+'</div>' : '') +
          (m.remark ? '<div class="meta">备注：'+m.remark+'</div>' : '') +
          '<div class="stock-actions">' +
          '<input type="number" id="stock_'+m.id+'" placeholder="数量" value="1" min="1">' +
          '<button class="small" data-stock-add="'+m.id+'">入库</button>' +
          '<button class="small secondary" data-stock-sub="'+m.id+'">出库</button>' +
          '<button class="small secondary" data-ledger-mat="'+m.id+'">查看流水</button>' +
          '</div>' +
          '<div class="material-card-actions">' +
          '<button class="small secondary" data-mat-edit="'+m.id+'">编辑</button>' +
          '<button class="small secondary" data-mat-delete="'+m.id+'" style="color:var(--red);">删除</button>' +
          '</div>' +
          '</div>';
      }).join("");
      document.querySelectorAll("[data-stock-add]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.stockAdd;
        const val = Number(document.getElementById("stock_"+id).value) || 0;
        if (val <= 0) return alert("请输入正数");
        await api("/api/materials/"+id+"/stock", { method:"POST", body: JSON.stringify({ change: val, operator: currentOperator, operatorId: currentOperatorId }) });
        await loadAll();
      });
      document.querySelectorAll("[data-stock-sub]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.stockSub;
        const val = Number(document.getElementById("stock_"+id).value) || 0;
        if (val <= 0) return alert("请输入正数");
        try {
          await api("/api/materials/"+id+"/stock", { method:"POST", body: JSON.stringify({ change: -val, operator: currentOperator, operatorId: currentOperatorId }) });
          await loadAll();
        } catch (e) { alert(e.message); }
      });
      document.querySelectorAll("[data-ledger-mat]").forEach(btn => btn.onclick = () => {
        const id = btn.dataset.ledgerMat;
        showStockLedger({ materialId: id });
      });
      document.querySelectorAll("[data-mat-edit]").forEach(btn => btn.onclick = () => {
        const id = btn.dataset.matEdit;
        openMaterialEditor(id);
      });
      document.querySelectorAll("[data-mat-delete]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.matDelete;
        const m = materials.find(item => item.id === id);
        if (!m) return;
        if (!confirm('确定要删除材料 "' + m.name + '" 吗？删除后不可恢复。')) return;
        try {
          await api("/api/materials/"+id, { method: "DELETE" });
          await loadAll();
        } catch (e) {
          alert(e.message);
        }
      });
    }

    function renderTemplateSelect() {
      const select = document.getElementById("templateSelect");
      if (!select) return;
      const currentVal = select.value;
      select.innerHTML = '<option value="">— 标准流程（默认）—</option>' + stepTemplates.map(t => '<option value="'+t.id+'">'+t.name+'</option>').join("");
      if (currentVal) select.value = currentVal;
    }

    function renderConsumeStepSelect() {
      const sel = document.getElementById("consumeStepSelect");
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = currentCommissionSteps.filter(s=>s.trim()).map((s,i) => {
        const isDefault = s === "补片";
        return '<option value="'+s+'">'+(i+1)+'. '+s+(isDefault?'（默认消耗点）':'')+'</option>';
      }).join("");
      if (currentCommissionSteps.includes(prev)) sel.value = prev;
      else if (currentCommissionSteps.includes("补片")) sel.value = "补片";
      else if (currentCommissionSteps.length) sel.value = currentCommissionSteps[Math.min(2, currentCommissionSteps.length-1)];
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
        renderConsumeStepSelect();
      });
      container.querySelectorAll("[data-cstep-up]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.cstepUp);
        if (idx > 0) {
          [currentCommissionSteps[idx-1], currentCommissionSteps[idx]] = [currentCommissionSteps[idx], currentCommissionSteps[idx-1]];
          renderCommissionStepList();
          renderConsumeStepSelect();
        }
      });
      container.querySelectorAll("[data-cstep-down]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.cstepDown);
        if (idx < currentCommissionSteps.length - 1) {
          [currentCommissionSteps[idx+1], currentCommissionSteps[idx]] = [currentCommissionSteps[idx], currentCommissionSteps[idx+1]];
          renderCommissionStepList();
          renderConsumeStepSelect();
        }
      });
      container.querySelectorAll("[data-cstep-del]").forEach(btn => btn.onclick = () => {
        const idx = Number(btn.dataset.cstepDel);
        if (currentCommissionSteps.length > 1) {
          currentCommissionSteps.splice(idx, 1);
          renderCommissionStepList();
          renderConsumeStepSelect();
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
          '<h4 class="kanban-card-title" style="cursor:pointer;color:var(--accent);" data-detail="' + item.id + '">' + item.roleName + '</h4>' +
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

    function applyScheduleFiltersToItem(item, filter) {
      if (filter.owner && item.owner !== filter.owner) return false;
      if (filter.client && item.client !== filter.client) return false;
      if (filter.status && item.status !== filter.status) return false;
      if (filter.dueFrom && item.dueDate) {
        if (item.dueDate < filter.dueFrom) return false;
      }
      if (filter.dueTo && item.dueDate) {
        if (item.dueDate > filter.dueTo) return false;
      }
      return true;
    }

    function applyScheduleFilters(data, filter) {
      const filtered = {
        overdue: data.overdue.filter(i => applyScheduleFiltersToItem(i, filter)),
        dueSoon: data.dueSoon.filter(i => applyScheduleFiltersToItem(i, filter)),
        onTrack: data.onTrack.filter(i => applyScheduleFiltersToItem(i, filter)),
        byOwner: {},
        stats: { total: 0, overdue: 0, dueSoon: 0, onTrack: 0, byOwner: {} }
      };

      const allFiltered = [...filtered.overdue, ...filtered.dueSoon, ...filtered.onTrack];
      for (const item of allFiltered) {
        if (!filtered.byOwner[item.owner]) {
          filtered.byOwner[item.owner] = { overdue: [], dueSoon: [], onTrack: [] };
          filtered.stats.byOwner[item.owner] = { total: 0, overdue: 0, dueSoon: 0, onTrack: 0 };
        }
        filtered.byOwner[item.owner][item.statusCategory].push(item);
        filtered.stats.byOwner[item.owner].total++;
        filtered.stats.byOwner[item.owner][item.statusCategory]++;
      }

      filtered.stats.total = filtered.overdue.length + filtered.dueSoon.length + filtered.onTrack.length;
      filtered.stats.overdue = filtered.overdue.length;
      filtered.stats.dueSoon = filtered.dueSoon.length;
      filtered.stats.onTrack = filtered.onTrack.length;

      Object.values(filtered.byOwner).forEach(ownerGroup => {
        ownerGroup.overdue.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
        ownerGroup.dueSoon.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
        ownerGroup.onTrack.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
      });

      filtered.overdue.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
      filtered.dueSoon.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
      filtered.onTrack.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

      return filtered;
    }

    function renderScheduleByStatus(data) {
      const overdue = data.overdue;
      const dueSoon = data.dueSoon;
      const onTrack = data.onTrack;

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

    function renderScheduleByOwner(data) {
      let owners = Object.keys(data.byOwner);
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
          }) +
        '</div>';
      }).join("");
    }

    function renderScheduleStats(data, originalData) {
      const stats = data.stats;
      const origStats = originalData ? originalData.stats : null;
      const filterActive = isCommissionFilterActive(scheduleFilter);

      const formatCount = (filtered, original) => {
        return filterActive && origStats ? (filtered + "/" + original) : filtered;
      };

      return '<div class="stat"><span>进行中委托</span><strong>' + formatCount(stats.total, origStats ? origStats.total : 0) + '</strong></div>' +
        '<div class="stat overdue"><span>逾期</span><strong>' + formatCount(stats.overdue, origStats ? origStats.overdue : 0) + '</strong></div>' +
        '<div class="stat due-soon"><span>三天内到期</span><strong>' + formatCount(stats.dueSoon, origStats ? origStats.dueSoon : 0) + '</strong></div>' +
        '<div class="stat on-track"><span>正常推进</span><strong>' + formatCount(stats.onTrack, origStats ? origStats.onTrack : 0) + '</strong></div>';
    }

    function renderSchedule() {
      if (!scheduleData) return;

      const statsEl = document.getElementById("scheduleStats");
      const viewEl = document.getElementById("scheduleView");

      renderScheduleFilterSelects();
      const filteredData = applyScheduleFilters(scheduleData, scheduleFilter);
      
      if (statsEl) statsEl.innerHTML = renderScheduleStats(filteredData, scheduleData);

      if (viewEl) {
        if (scheduleView === "status") {
          viewEl.innerHTML = renderScheduleByStatus(filteredData);
        } else {
          viewEl.innerHTML = renderScheduleByOwner(filteredData);
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
          if (e.target.closest("[data-detail]")) {
            openDetailModal(e.target.closest("[data-detail]").dataset.detail);
            return;
          }
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

          const op = getOperator();
          if (!op.operator) return alert("请先在页面顶部选择当前操作者");
          try {
            await api('/api/commissions/' + id + '/schedule', { 
              method:'PUT', 
              body: JSON.stringify({ status: step, note: note || "步骤更新", owner, dueDate, operator: op.operator, operatorId: op.operatorId }) 
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

    let stockLedgerLabels = {};
    let stockLedgerCurrentFilter = { materialId: "", commissionId: "" };
    async function showStockLedger(options = {}) {
      const modal = document.getElementById("stockLedgerModal");
      if (!modal) return;
      const titleEl = document.getElementById("stockLedgerTitle");
      if (titleEl) titleEl.textContent = options.title || "材料库存流水";
      stockLedgerCurrentFilter = {
        materialId: options.materialId || "",
        commissionId: options.commissionId || ""
      };
      modal.classList.add("active");
      await refreshStockLedger();
      document.getElementById("ledgerFilterMaterial").value = "";
      document.getElementById("ledgerFilterType").value = "";
    }
    function closeStockLedger() {
      document.getElementById("stockLedgerModal").classList.remove("active");
    }
    document.getElementById("stockLedgerModalClose").onclick = closeStockLedger;
    document.getElementById("stockLedgerModal").onclick = e => { if (e.target.id === "stockLedgerModal") closeStockLedger(); };
    document.getElementById("ledgerRefreshBtn").onclick = refreshStockLedger;
    document.getElementById("ledgerFilterMaterial").oninput = renderStockLedgerBody;
    document.getElementById("ledgerFilterType").onchange = renderStockLedgerBody;
    let currentLedgerData = [];
    async function refreshStockLedger() {
      try {
        const params = new URLSearchParams();
        if (stockLedgerCurrentFilter.materialId) params.set("materialId", stockLedgerCurrentFilter.materialId);
        if (stockLedgerCurrentFilter.commissionId) params.set("commissionId", stockLedgerCurrentFilter.commissionId);
        params.set("limit", "1000");
        const data = await api("/api/stock-ledger?" + params.toString());
        stockLedgerLabels = data.labels || {};
        currentLedgerData = data.items || [];
        const infoEl = document.getElementById("stockLedgerInfo");
        if (infoEl) infoEl.textContent = "共 " + (data.total || 0) + " 条流水，当前显示 " + currentLedgerData.length + " 条";
        const typeSel = document.getElementById("ledgerFilterType");
        if (typeSel) {
          const curVal = typeSel.value;
          typeSel.innerHTML = '<option value="">全部变动类型</option>' +
            Object.entries(stockLedgerLabels).map(([k, v]) => '<option value="' + k + '">' + v + '</option>').join("");
          if (curVal && stockLedgerLabels[curVal]) typeSel.value = curVal;
        }
        renderStockLedgerBody();
      } catch (e) {
        alert("加载流水失败：" + e.message);
      }
    }
    function renderStockLedgerBody() {
      const tbody = document.getElementById("stockLedgerBody");
      if (!tbody) return;
      const nameKw = document.getElementById("ledgerFilterMaterial")?.value.trim() || "";
      const typeKw = document.getElementById("ledgerFilterType")?.value || "";
      const list = currentLedgerData.filter(l => {
        if (nameKw && !(l.materialName || "").includes(nameKw)) return false;
        if (typeKw && l.type !== typeKw) return false;
        return true;
      });
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="padding:32px;text-align:center;color:var(--muted);">暂无流水记录</td></tr>';
        return;
      }
      tbody.innerHTML = list.map(l => {
        const typeLabel = stockLedgerLabels[l.type] || l.type;
        const qty = Number(l.quantity) || 0;
        const qtyClass = qty >= 0 ? "ledger-qty-pos" : "ledger-qty-neg";
        const qtyStr = (qty > 0 ? "+" : "") + qty;
        const commissionCell = l.commissionId
          ? '<span class="ledger-link" data-commission-ledger="' + l.commissionId + '">' + (l.commissionRoleName || l.commissionId) + '</span>'
          : '—';
        return '<tr style="border-bottom:1px solid var(--line);">' +
          '<td style="padding:6px;white-space:nowrap;font-size:12px;color:var(--muted);">' + (l.at ? formatDate(l.at) : '') + '</td>' +
          '<td style="padding:6px;"><span class="ledger-type-badge ledger-type-' + l.type + '">' + typeLabel + '</span></td>' +
          '<td style="padding:6px;">' +
            '<div style="font-weight:600;">' + (l.materialName || '—') + '</div>' +
            (l.batch ? '<div style="font-size:11px;color:var(--muted);">批次：' + l.batch + '</div>' : '') +
          '</td>' +
          '<td style="padding:6px;text-align:right;" class="' + qtyClass + '">' + qtyStr + '</td>' +
          '<td style="padding:6px;text-align:right;font-size:12px;">' +
            '<div>' + (l.stockBefore ?? 0) + ' → <b>' + (l.stockAfter ?? 0) + '</b></div>' +
          '</td>' +
          '<td style="padding:6px;text-align:right;font-size:12px;">' +
            '<div>' + (l.reservedBefore ?? 0) + ' → <b>' + (l.reservedAfter ?? 0) + '</b></div>' +
          '</td>' +
          '<td style="padding:6px;">' + commissionCell + '</td>' +
          '<td style="padding:6px;white-space:nowrap;">' + (l.operator || '—') + '</td>' +
          '<td style="padding:6px;font-size:12px;color:var(--muted);">' + (l.note || '—') + '</td>' +
          '</tr>';
      }).join("");
      tbody.querySelectorAll("[data-commission-ledger]").forEach(el => {
        el.onclick = () => {
          const id = el.dataset.commissionLedger;
          closeStockLedger();
          openDetailModal(id);
        };
      });
    }
    function openDetailModalByLedger(id) {
      closeStockLedger();
      openDetailModal(id);
    }
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        const m1 = document.getElementById("stockLedgerModal"); if (m1?.classList.contains("active")) closeStockLedger();
      }
    });

    function render() {
      renderCommissions();
      renderClientSelect();
      renderClients();
      renderMembers();
      renderOwnerSelect();
      renderOperatorSelect();
      renderMaterialSelect();
      renderMaterials();
      renderTemplateSelect();
      renderCommissionStepList();
      renderConsumeStepSelect();
      renderTemplates();
      renderTemplateStepList();
      if (scheduleData) renderSchedule();
    }

    async function loadAll() {
      try {
        commissions = await api("/api/commissions");
        clients = await api("/api/clients");
        materials = await api("/api/materials");
        stepTemplates = await api("/api/step-templates");
        members = await api("/api/members");
      } catch (e) {
        console.error("loadAll failed, retrying sequentially:", e.message);
        commissions = commissions || [];
        clients = clients || [];
        materials = materials || [];
        stepTemplates = stepTemplates || [];
        members = members || [];
      }
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
      const op = getOperator();
      if (!op.operator) return alert("请先在页面顶部选择当前操作者");
      try {
        Object.assign(data, { operator: op.operator, operatorId: op.operatorId });
        await api("/api/commissions", { method:"POST", body: JSON.stringify(data) });
        event.target.reset();
        document.getElementById("clientNewFields").classList.remove("visible");
        const tipDiv = document.getElementById("clientFollowupTip");
        if (tipDiv) tipDiv.style.display = "none";
        currentCommissionSteps = [...defaultSteps];
        renderCommissionStepList();
        renderConsumeStepSelect();
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
            renderConsumeStepSelect();
          }
        } else {
          currentCommissionSteps = [...defaultSteps];
          renderCommissionStepList();
          renderConsumeStepSelect();
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
            renderConsumeStepSelect();
          }
        } else {
          currentCommissionSteps = [...defaultSteps];
          renderCommissionStepList();
          renderConsumeStepSelect();
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
          renderConsumeStepSelect();
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

    const showAllLedgerBtn = document.getElementById("showAllLedgerBtn");
    if (showAllLedgerBtn) showAllLedgerBtn.onclick = () => showStockLedger({ title: "全部材料库存流水" });

    document.querySelector("#materialForm").onsubmit = async event => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const data = Object.fromEntries(formData.entries());
      const op = getOperator();
      Object.assign(data, { operator: op.operator, operatorId: op.operatorId });
      try {
        await api("/api/materials", { method:"POST", body: JSON.stringify(data) });
        event.target.reset();
        event.target.elements.stock.value = 0;
        event.target.elements.unit.value = "个";
        event.target.elements.minStock.value = 0;
        await loadAll();
      } catch (e) {
        alert(e.message);
      }
    };

    function openMaterialEditor(id) {
      const m = materials.find(item => item.id === id);
      if (!m) return;
      const form = document.getElementById("materialEditForm");
      form.elements.id.value = m.id;
      form.elements.name.value = m.name;
      form.elements.category.value = m.category || "其他";
      form.elements.batch.value = m.batch || "";
      form.elements.stock.value = m.stock || 0;
      form.elements.unit.value = m.unit || "个";
      form.elements.minStock.value = m.minStock || 0;
      form.elements.remark.value = m.remark || "";
      document.getElementById("materialModalTitle").textContent = "编辑材料：" + m.name;
      document.getElementById("materialModal").classList.add("active");
    }

    function closeMaterialEditor() {
      document.getElementById("materialModal").classList.remove("active");
    }

    document.getElementById("materialModalClose").onclick = closeMaterialEditor;
    document.getElementById("cancelMaterialEdit").onclick = closeMaterialEditor;
    document.getElementById("materialModal").onclick = e => {
      if (e.target.id === "materialModal") closeMaterialEditor();
    };

    document.querySelector("#materialEditForm").onsubmit = async event => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const data = Object.fromEntries(formData.entries());
      const id = data.id;
      delete data.id;
      const op = getOperator();
      Object.assign(data, { operator: op.operator, operatorId: op.operatorId });
      try {
        await api("/api/materials/"+id, { method: "PUT", body: JSON.stringify(data) });
        closeMaterialEditor();
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
    try {
      const savedCommissionFilter = localStorage.getItem("commissionFilter");
      if (savedCommissionFilter) {
        const parsed = JSON.parse(savedCommissionFilter);
        commissionFilter = { ...commissionFilter, ...parsed };
      }
      const savedScheduleFilter = localStorage.getItem("scheduleFilter");
      if (savedScheduleFilter) {
        const parsed = JSON.parse(savedScheduleFilter);
        scheduleFilter = { ...scheduleFilter, ...parsed };
        scheduleOwnerFilter = scheduleFilter.owner || "";
      } else if (scheduleOwnerFilter) {
        scheduleFilter.owner = scheduleOwnerFilter;
      }
    } catch (e) {
      console.warn("加载筛选条件失败:", e);
    }
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
    let currentWizardStep = 1;
    let currentEntityTab = "commissions";
    let currentEntityFilter = {};
    let importOverwriteMap = {};
    let clientMatches = {};
    let materialMatches = {};
    let memberMatches = {};
    let templateMatches = {};
    let importResultData = null;

    function openImportModal() {
      document.getElementById("importModal").classList.add("active");
      resetImportWizard();
    }

    function closeImportModal() {
      document.getElementById("importModal").classList.remove("active");
      importPreviewData = null;
      importResultData = null;
    }

    function resetImportWizard() {
      importPreviewData = null;
      importResultData = null;
      importOverwriteMap = {};
      clientMatches = {};
      materialMatches = {};
      memberMatches = {};
      templateMatches = {};
      currentEntityFilter = {};
      currentEntityTab = "commissions";
      currentWizardStep = 1;
      document.getElementById("importFileName").textContent = "";
      document.getElementById("wizStep1").style.display = "block";
      document.getElementById("wizStep2").style.display = "none";
      document.getElementById("wizStep3").style.display = "none";
      document.getElementById("wizPrevBtn").style.display = "none";
      document.getElementById("wizNextBtn").style.display = "inline-block";
      document.getElementById("wizNextBtn").disabled = true;
      document.getElementById("confirmImportBtn").style.display = "none";
      document.getElementById("wizardFooterLeft").textContent = "请选择要导入的JSON文件";
      updateWizardStepUi();
    }

    function updateWizardStepUi() {
      document.querySelectorAll(".wizard-step").forEach(btn => {
        const step = Number(btn.dataset.wizStep);
        btn.classList.toggle("active", step === currentWizardStep);
        btn.classList.toggle("done", step < currentWizardStep);
        btn.disabled = step > currentWizardStep;
      });
      if (currentWizardStep === 1) {
        document.getElementById("wizPrevBtn").style.display = "none";
        document.getElementById("wizNextBtn").style.display = "inline-block";
        document.getElementById("confirmImportBtn").style.display = "none";
      } else if (currentWizardStep === 2) {
        document.getElementById("wizPrevBtn").style.display = "inline-block";
        document.getElementById("wizNextBtn").style.display = "inline-block";
        document.getElementById("wizNextBtn").textContent = "生成摘要";
        document.getElementById("confirmImportBtn").style.display = "none";
      } else if (currentWizardStep === 3) {
        document.getElementById("wizPrevBtn").style.display = "inline-block";
        document.getElementById("wizNextBtn").style.display = "none";
        document.getElementById("confirmImportBtn").style.display = "inline-block";
      }
    }

    function goToStep(step) {
      currentWizardStep = step;
      document.getElementById("wizStep1").style.display = step === 1 ? "block" : "none";
      document.getElementById("wizStep2").style.display = step === 2 ? "block" : "none";
      document.getElementById("wizStep3").style.display = step === 3 ? "block" : "none";
      updateWizardStepUi();
      if (step === 2) {
        renderAllEntityTabs();
        document.getElementById("wizardFooterLeft").textContent = "检查并匹配关联数据，冲突项请选择匹配目标";
      }
      if (step === 3) {
        renderImportSummary();
        document.getElementById("wizardFooterLeft").textContent = "请确认以下导入摘要，无误后点击确认导入";
      }
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
        invalidSteps: "步骤不合法",
        matched: "复用",
        conflict: "冲突",
        unmatched: "无法匹配"
      };
      return labels[cat] || cat;
    }

    function getEntityBadge(cat) {
      const label = getCategoryLabel(cat);
      return '<span class="entity-badge ' + cat + '">' + label + '</span>';
    }

    function renderCommissionPreview() {
      if (!importPreviewData) return;
      const preview = importPreviewData.commissions;
      if (!preview) return;

      document.getElementById("stat-new").textContent = preview.categories.new.length;
      document.getElementById("stat-dup").textContent = preview.categories.duplicate.length;
      document.getElementById("stat-missing").textContent = preview.categories.missingFields.length;
      document.getElementById("stat-invalid").textContent = preview.categories.invalidSteps.length;

      document.getElementById("filter-count-all").textContent = preview.total;
      document.getElementById("filter-count-new").textContent = preview.categories.new.length;
      document.getElementById("filter-count-dup").textContent = preview.categories.duplicate.length;
      document.getElementById("filter-count-missing").textContent = preview.categories.missingFields.length;
      document.getElementById("filter-count-invalid").textContent = preview.categories.invalidSteps.length;

      const listEl = document.getElementById("importList");
      const commissionFilter = currentEntityFilter.commissions || "all";
      const filteredItems = preview.items.filter(item => {
        if (commissionFilter === "all") return true;
        return item.categories.includes(commissionFilter);
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

      document.querySelectorAll("#entity-commissions .import-filter-tab").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.importFilter === (currentEntityFilter.commissions || "all"));
      });
    }

    function renderEntityList(entityKey) {
      const container = document.getElementById(entityKey + "Content");
      if (!container || !importPreviewData) return;
      const entity = importPreviewData[entityKey];
      if (!entity) {
        container.innerHTML = '<div class="empty-state" style="padding:30px 20px;"><div class="icon">📭</div><div>暂无相关数据</div></div>';
        return;
      }
      const existing = importPreviewData.existing || {};
      const existingList = existing[entityKey] || [];
      const matchMap = getMatchMap(entityKey);

      const cats = {
        matched: entity.items.filter(i => i.category === "matched").length,
        new: entity.items.filter(i => i.category === "new").length,
        conflict: entity.items.filter(i => i.category === "conflict").length,
        unmatched: entity.items.filter(i => i.category === "unmatched").length
      };
      const filter = currentEntityFilter[entityKey] || "all";

      const filterHtml = '<div class="entity-filter-tabs">' +
        '<button type="button" class="entity-filter-tab ' + (filter === "all" ? "active" : "") + '" data-ef-entity="' + entityKey + '" data-ef-filter="all">全部 <span class="ef-count">' + entity.items.length + '</span></button>' +
        '<button type="button" class="entity-filter-tab ' + (filter === "new" ? "active" : "") + '" data-ef-entity="' + entityKey + '" data-ef-filter="new">新增 <span class="ef-count">' + cats.new + '</span></button>' +
        '<button type="button" class="entity-filter-tab ' + (filter === "matched" ? "active" : "") + '" data-ef-entity="' + entityKey + '" data-ef-filter="matched">复用 <span class="ef-count">' + cats.matched + '</span></button>' +
        '<button type="button" class="entity-filter-tab ' + (filter === "conflict" ? "active" : "") + '" data-ef-entity="' + entityKey + '" data-ef-filter="conflict">冲突 <span class="ef-count">' + cats.conflict + '</span></button>' +
        '<button type="button" class="entity-filter-tab ' + (filter === "unmatched" ? "active" : "") + '" data-ef-entity="' + entityKey + '" data-ef-filter="unmatched">无法匹配 <span class="ef-count">' + cats.unmatched + '</span></button>' +
      '</div>';

      const filteredItems = filter === "all" ? entity.items : entity.items.filter(i => i.category === filter);

      const itemsHtml = filteredItems.length === 0 
        ? '<div class="empty-state" style="padding:30px 20px;"><div class="icon">📭</div><div>暂无符合条件的数据</div></div>'
        : '<div class="entity-list">' + filteredItems.map(item => renderEntityItem(entityKey, item, existingList, matchMap)).join("") + '</div>';

      container.innerHTML = filterHtml + itemsHtml;

      container.querySelectorAll(".entity-filter-tab").forEach(btn => {
        btn.onclick = () => {
          currentEntityFilter[btn.dataset.efEntity] = btn.dataset.efFilter;
          renderEntityList(btn.dataset.efEntity);
        };
      });
    }

    function getMatchMap(entityKey) {
      if (entityKey === "clients") return clientMatches;
      if (entityKey === "materials") return materialMatches;
      if (entityKey === "members") return memberMatches;
      if (entityKey === "templates") return templateMatches;
      return {};
    }

    function setMatch(entityKey, matchKey, value) {
      if (entityKey === "clients") clientMatches[matchKey] = value;
      else if (entityKey === "materials") materialMatches[matchKey] = value;
      else if (entityKey === "members") memberMatches[matchKey] = value;
      else if (entityKey === "templates") templateMatches[matchKey] = value;
    }

    function renderEntityItem(entityKey, item, existingList, matchMap) {
      const currentMatch = matchMap[item.matchKey];
      const needsMatch = item.category === "conflict" || item.category === "unmatched" || (item.category === "new" && existingList.length > 0);

      const badgesHtml = getEntityBadge(item.category);

      let detailHtml = "";
      if (entityKey === "clients") {
        detailHtml = '<div class="entity-item-detail">' +
          '<div class="detail-row"><span class="detail-label">客户名</span><span>' + escapeHtml(item.imported.name || "-") + '</span></div>' +
          (item.imported.contact ? '<div class="detail-row"><span class="detail-label">联系人</span><span>' + escapeHtml(item.imported.contact) + '</span></div>' : "") +
          (item.imported.phone ? '<div class="detail-row"><span class="detail-label">电话</span><span>' + escapeHtml(item.imported.phone) + '</span></div>' : "") +
          (item.imported.address ? '<div class="detail-row"><span class="detail-label">地址</span><span>' + escapeHtml(item.imported.address) + '</span></div>' : "") +
        '</div>';
      } else if (entityKey === "materials") {
        detailHtml = '<div class="entity-item-detail">' +
          '<div class="detail-row"><span class="detail-label">材料名</span><span>' + escapeHtml(item.imported.name || "-") + '</span></div>' +
          (item.imported.category ? '<div class="detail-row"><span class="detail-label">分类</span><span>' + escapeHtml(item.imported.category) + '</span></div>' : "") +
          (item.imported.batch ? '<div class="detail-row"><span class="detail-label">批次</span><span>' + escapeHtml(item.imported.batch) + '</span></div>' : "") +
          (typeof item.imported.stock === "number" ? '<div class="detail-row"><span class="detail-label">库存</span><span>' + item.imported.stock + " " + escapeHtml(item.imported.unit || "") + '</span></div>' : "") +
        '</div>';
      } else if (entityKey === "members") {
        detailHtml = '<div class="entity-item-detail">' +
          '<div class="detail-row"><span class="detail-label">姓名</span><span>' + escapeHtml(item.imported.name || "-") + '</span></div>' +
          (item.imported.role ? '<div class="detail-row"><span class="detail-label">角色</span><span>' + escapeHtml(item.imported.role) + '</span></div>' : "") +
          (item.imported.phone ? '<div class="detail-row"><span class="detail-label">电话</span><span>' + escapeHtml(item.imported.phone) + '</span></div>' : "") +
        '</div>';
      } else if (entityKey === "templates") {
        const stepsText = (item.imported.steps || []).join(" → ");
        detailHtml = '<div class="entity-item-detail">' +
          '<div class="detail-row"><span class="detail-label">模板名</span><span>' + escapeHtml(item.imported.name || "-") + '</span></div>' +
          (stepsText ? '<div class="detail-row"><span class="detail-label">步骤</span><span>' + escapeHtml(stepsText) + '</span></div>' : "") +
        '</div>';
      }

      let diffHtml = "";
      if (item.category === "conflict" && item.matchedExisting) {
        const diffs = item.diff || [];
        if (diffs.length > 0) {
          diffHtml = '<div class="entity-item-meta" style="color:var(--orange);">⚠️ 数据差异：' + diffs.map(d => escapeHtml(d.field) + ("expected" in d ? " (导入值:" + escapeHtml(String(d.imported)) + ")" : "")).join("，") + '</div>';
        }
      }

      let matchHtml = "";
      if (needsMatch) {
        const candidates = (item.candidates || existingList).slice(0, 6);
        const candidateCards = candidates.map(cand => {
          let title = "", meta = "";
          if (entityKey === "clients") { title = cand.name || "-"; meta = [cand.contact, cand.phone].filter(Boolean).join(" · "); }
          else if (entityKey === "materials") { title = cand.name || "-"; meta = [cand.category, cand.batch].filter(Boolean).join(" · "); }
          else if (entityKey === "members") { title = cand.name || "-"; meta = [cand.role, cand.phone].filter(Boolean).join(" · "); }
          else if (entityKey === "templates") { title = cand.name || "-"; meta = (cand.steps || []).join(" → ").slice(0, 40); }
          const selected = currentMatch === cand.id;
          return '<div class="match-candidate ' + (selected ? "selected" : "") + '" data-entity="' + entityKey + '" data-matchkey="' + encodeURIComponent(item.matchKey) + '" data-matchid="' + cand.id + '">' +
            '<div class="mc-title">' + escapeHtml(title) + '</div>' +
            (meta ? '<div class="mc-meta">' + escapeHtml(meta) + '</div>' : "") +
          '</div>';
        }).join("");
        const createNewSelected = currentMatch === "__new__";
        matchHtml = '<div class="match-select-area">' +
          '<label>' + (item.category === "conflict" ? "选择匹配目标（或使用已匹配数据）：" : "选择匹配到现有数据，或作为新建：") + '</label>' +
          '<div class="match-candidates">' +
            candidateCards +
            '<div class="match-create-new ' + (createNewSelected ? "selected" : "") + '" data-entity="' + entityKey + '" data-matchkey="' + encodeURIComponent(item.matchKey) + '" data-matchid="__new__">✨ 作为新建数据导入</div>' +
          '</div>' +
        '</div>';
      } else if (item.category === "matched" && item.matchedExisting) {
        let matchInfo = "";
        if (entityKey === "clients") matchInfo = item.matchedExisting.name;
        else if (entityKey === "materials") matchInfo = item.matchedExisting.name + (item.matchedExisting.batch ? " (" + item.matchedExisting.batch + ")" : "");
        else if (entityKey === "members") matchInfo = item.matchedExisting.name;
        else if (entityKey === "templates") matchInfo = item.matchedExisting.name;
        matchHtml = '<div class="entity-item-meta">✅ 自动匹配到：' + escapeHtml(matchInfo) + '（可切换到其他匹配）</div>';
        const candidates = existingList.slice(0, 6);
        const candidateCards = candidates.map(cand => {
          let title = "", meta = "";
          if (entityKey === "clients") { title = cand.name || "-"; meta = [cand.contact, cand.phone].filter(Boolean).join(" · "); }
          else if (entityKey === "materials") { title = cand.name || "-"; meta = [cand.category, cand.batch].filter(Boolean).join(" · "); }
          else if (entityKey === "members") { title = cand.name || "-"; meta = [cand.role, cand.phone].filter(Boolean).join(" · "); }
          else if (entityKey === "templates") { title = cand.name || "-"; meta = (cand.steps || []).join(" → ").slice(0, 40); }
          const selected = (currentMatch || (item.matchedExisting ? item.matchedExisting.id : null)) === cand.id;
          return '<div class="match-candidate ' + (selected ? "selected" : "") + '" data-entity="' + entityKey + '" data-matchkey="' + encodeURIComponent(item.matchKey) + '" data-matchid="' + cand.id + '">' +
            '<div class="mc-title">' + escapeHtml(title) + '</div>' +
            (meta ? '<div class="mc-meta">' + escapeHtml(meta) + '</div>' : "") +
          '</div>';
        }).join("");
        matchHtml += '<div class="match-select-area">' +
          '<label>更改匹配：</label>' +
          '<div class="match-candidates">' + candidateCards +
          '<div class="match-create-new" data-entity="' + entityKey + '" data-matchkey="' + encodeURIComponent(item.matchKey) + '" data-matchid="__new__">✨ 改为新建数据导入</div>' +
          '</div>' +
        '</div>';
      }

      return '<div class="entity-item">' +
        '<div class="entity-item-header">' +
          '<h4 class="entity-item-title">' + escapeHtml(item.displayName) + '</h4>' +
          '<div class="entity-item-badges">' + badgesHtml + '</div>' +
        '</div>' +
        (item.category === "matched" && item.matchedExisting ? "" : (item.notes ? '<div class="entity-item-meta">' + escapeHtml(item.notes) + '</div>' : "")) +
        diffHtml +
        detailHtml +
        matchHtml +
      '</div>';
    }

    function escapeHtml(s) {
      if (s === null || s === undefined) return "";
      return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function renderAllEntityTabs() {
      if (!importPreviewData) return;
      document.getElementById("ent-count-commissions").textContent = importPreviewData.commissions ? importPreviewData.commissions.total : 0;
      document.getElementById("ent-count-clients").textContent = importPreviewData.clients ? importPreviewData.clients.items.length : 0;
      document.getElementById("ent-count-materials").textContent = importPreviewData.materials ? importPreviewData.materials.items.length : 0;
      document.getElementById("ent-count-members").textContent = importPreviewData.members ? importPreviewData.members.items.length : 0;
      document.getElementById("ent-count-templates").textContent = importPreviewData.templates ? importPreviewData.templates.items.length : 0;

      renderCommissionPreview();
      renderEntityList("clients");
      renderEntityList("materials");
      renderEntityList("members");
      renderEntityList("templates");
      switchEntityTab(currentEntityTab);
    }

    function switchEntityTab(tab) {
      currentEntityTab = tab;
      document.querySelectorAll(".entity-tab").forEach(b => b.classList.toggle("active", b.dataset.entity === tab));
      document.querySelectorAll(".entity-content").forEach(c => c.classList.toggle("active", c.id === "entity-" + tab));
    }

    async function handleImportFile(file) {
      if (!file) return;
      if (!file.name.endsWith(".json")) {
        alert("请选择JSON文件");
        return;
      }

      document.getElementById("importFileName").textContent = "已选择：" + file.name + "（正在分析...）";

      try {
        const text = await file.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          alert("JSON解析失败，请检查文件格式");
          document.getElementById("importFileName").textContent = "⚠️ JSON解析失败";
          return;
        }

        const preview = await api("/api/commissions/import/preview", {
          method: "POST",
          body: JSON.stringify(data)
        });

        importPreviewData = preview;
        importOverwriteMap = {};
        clientMatches = {};
        materialMatches = {};
        memberMatches = {};
        templateMatches = {};
        currentEntityFilter = {};

        document.getElementById("importFileName").textContent = "已选择：" + file.name + " ✅";
        document.getElementById("wizNextBtn").disabled = false;
        goToStep(2);
      } catch (e) {
        alert("导入预览失败：" + e.message);
        document.getElementById("importFileName").textContent = "⚠️ 分析失败：" + e.message;
      }
    }

    function renderImportSummary() {
      const container = document.getElementById("importSummary");
      if (!importPreviewData) {
        container.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><div>暂无数据</div></div>';
        return;
      }

      const commissions = importPreviewData.commissions || { items: [], categories: { new: [], duplicate: [] } };
      const totalCommissionsValid = commissions.categories.new.length + 
        commissions.categories.duplicate.filter((_, i) => {
          const origItem = commissions.items.find(it => it.index === commissions.categories.duplicate.indexOf(commissions.categories.duplicate[i]));
          return importOverwriteMap[i] || false;
        }).length;

      const commissionItemsToImport = commissions.items.filter(item => {
        const hasBlocking = item.categories.includes("missingFields") || item.categories.includes("invalidSteps");
        if (hasBlocking) return false;
        if (item.categories.includes("duplicate") && !importOverwriteMap[item.index]) return false;
        return true;
      });

      const clients = importPreviewData.clients || { items: [] };
      const materials = importPreviewData.materials || { items: [] };
      const members = importPreviewData.members || { items: [] };
      const templates = importPreviewData.templates || { items: [] };

      const summarize = (items, matches) => {
        let created = 0, reused = 0;
        items.forEach(it => {
          const userSel = matches[it.matchKey];
          if (it.category === "matched" || (userSel && userSel !== "__new__")) reused++;
          else created++;
        });
        return { created, reused };
      };

      const sClients = summarize(clients.items, clientMatches);
      const sMaterials = summarize(materials.items, materialMatches);
      const sMembers = summarize(members.items, memberMatches);
      const sTemplates = summarize(templates.items, templateMatches);

      const totalEntities = sClients.created + sMaterials.created + sMembers.created + sTemplates.created;

      container.innerHTML = 
        '<div class="import-summary">' +
          '<div class="summary-grid">' +
            '<div class="summary-card"><span class="sc-label">委托导入</span><span class="sc-value sc-created">' + commissionItemsToImport.length + '</span></div>' +
            '<div class="summary-card"><span class="sc-label">新建实体</span><span class="sc-value sc-created">' + (sClients.created + sMaterials.created + sMembers.created + sTemplates.created) + '</span></div>' +
            '<div class="summary-card"><span class="sc-label">复用实体</span><span class="sc-value sc-reused">' + (sClients.reused + sMaterials.reused + sMembers.reused + sTemplates.reused) + '</span></div>' +
            '<div class="summary-card"><span class="sc-label">跳过委托</span><span class="sc-value sc-skipped">' + (commissions.total - commissionItemsToImport.length) + '</span></div>' +
            '<div class="summary-card"><span class="sc-label">总涉及项</span><span class="sc-value sc-updated">' + (commissionItemsToImport.length + clients.items.length + materials.items.length + members.items.length + templates.items.length) + '</span></div>' +
          '</div>' +
          renderSummarySection("委托", commissionItemsToImport.map(it => ({
            id: it.data ? (it.data.id || it.index) : it.index,
            name: it.data ? (it.data.roleName || "未命名角色") : "无效条目",
            action: it.categories.includes("duplicate") ? "updated" : "created",
            reason: it.categories.includes("duplicate") ? "覆盖现有" : "新增"
          })), commissions.total) +
          renderSummarySection("客户", buildEntitySummary(clients.items, clientMatches, (it) => it.imported.name || "-"), clients.items.length) +
          renderSummarySection("材料", buildEntitySummary(materials.items, materialMatches, (it) => it.imported.name + (it.imported.batch ? " (" + it.imported.batch + ")" : "")), materials.items.length) +
          renderSummarySection("成员", buildEntitySummary(members.items, memberMatches, (it) => it.imported.name || "-"), members.items.length) +
          renderSummarySection("步骤模板", buildEntitySummary(templates.items, templateMatches, (it) => it.imported.name || (it.imported.steps || []).join("→")), templates.items.length) +
        '</div>';
    }

    function buildEntitySummary(items, matches, nameFn) {
      return items.map(it => {
        const userSel = matches[it.matchKey];
        let action = "created";
        let reason = "新增";
        if (it.category === "matched" || (userSel && userSel !== "__new__")) {
          action = "reused";
          reason = "复用现有";
        } else if (it.category === "unmatched") {
          if (userSel === "__new__") { action = "created"; reason = "无法匹配，作为新建"; }
          else { action = "skipped"; reason = "无法匹配，未指定"; }
        } else if (it.category === "conflict") {
          if (userSel && userSel !== "__new__") { action = "reused"; reason = "冲突，使用现有"; }
          else if (userSel === "__new__") { action = "created"; reason = "冲突，作为新建"; }
          else { action = "reused"; reason = "冲突，默认复用"; }
        }
        return { id: it.matchKey, name: nameFn(it), action, reason };
      });
    }

    function renderSummarySection(title, items, total) {
      if (items.length === 0) {
        return '<div class="summary-section"><h4>' + title + ' <span class="count">共 ' + total + ' 项 · 0 项导入</span></h4>' +
          '<div class="empty-state" style="padding:20px;"><div>无可用数据</div></div></div>';
      }
      const listHtml = items.slice(0, 50).map(it => 
        '<div class="summary-item-row">' +
          '<span>' + escapeHtml(it.name) + (it.reason ? ' <span style="color:var(--muted);font-size:11px;">· ' + escapeHtml(it.reason) + '</span>' : '') + '</span>' +
          '<span class="si-action ' + it.action + '">' + getCategoryLabel(it.action === "updated" ? "duplicate" : it.action === "created" ? "new" : it.action === "reused" ? "matched" : "unmatched") + '</span>' +
        '</div>'
      ).join("");
      const moreHtml = items.length > 50 ? '<div style="text-align:center;color:var(--muted);font-size:12px;padding:6px;">... 还有 ' + (items.length - 50) + ' 项</div>' : "";
      return '<div class="summary-section"><h4>' + title + ' <span class="count">共 ' + total + ' 项 · ' + items.length + ' 项涉及</span></h4>' +
        '<div class="summary-item-list">' + listHtml + moreHtml + '</div></div>';
    }

    async function confirmImport() {
      if (!importPreviewData) return;

      const commissions = importPreviewData.commissions || { items: [] };
      const itemsToImport = commissions.items.filter(item => {
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
        alert("没有可导入的委托数据，请检查数据问题");
        return;
      }

      if (!confirm("确认后将批量导入数据，操作不可撤销。是否继续？")) return;

      document.getElementById("confirmImportBtn").disabled = true;
      document.getElementById("wizPrevBtn").disabled = true;

      try {
        const result = await api("/api/commissions/import", {
          method: "POST",
          body: JSON.stringify({ 
            items: itemsToImport,
            clientMatches,
            materialMatches,
            memberMatches,
            templateMatches
          })
        });

        if (result.success) {
          importResultData = result;
          const msg = "导入成功！\\n\\n" +
            "委托：新增 " + (result.summary.commissions.created || 0) + "，更新 " + (result.summary.commissions.updated || 0) + "，跳过 " + (result.summary.commissions.skipped || 0) + "\\n" +
            "客户：新建 " + (result.summary.clients.created || 0) + "，复用 " + (result.summary.clients.reused || 0) + "\\n" +
            "材料：新建 " + (result.summary.materials.created || 0) + "，复用 " + (result.summary.materials.reused || 0) + "\\n" +
            "成员：新建 " + (result.summary.members.created || 0) + "，复用 " + (result.summary.members.reused || 0) + "\\n" +
            "步骤模板：新建 " + (result.summary.templates.created || 0) + "，复用 " + (result.summary.templates.reused || 0);
          alert(msg);
          closeImportModal();
          await loadAll();
        } else {
          alert("导入失败：" + (result.error || "未知错误"));
          document.getElementById("confirmImportBtn").disabled = false;
          document.getElementById("wizPrevBtn").disabled = false;
        }
      } catch (e) {
        alert("导入失败：" + e.message);
        document.getElementById("confirmImportBtn").disabled = false;
        document.getElementById("wizPrevBtn").disabled = false;
      }
    }

    document.getElementById("exportBtn").onclick = exportCommissions;
    document.getElementById("importFileInput").onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        openImportModal();
        handleImportFile(file);
      }
      e.target.value = "";
    };
    if (document.getElementById("importFileInputWiz")) {
      document.getElementById("importFileInputWiz").onchange = (e) => {
        const file = e.target.files[0];
        if (file) handleImportFile(file);
        e.target.value = "";
      };
    }

    document.getElementById("importModalClose").onclick = closeImportModal;
    document.getElementById("cancelImportBtn").onclick = closeImportModal;
    document.getElementById("importModal").onclick = (e) => {
      if (e.target.id === "importModal") closeImportModal();
    };

    document.getElementById("wizNextBtn").onclick = () => {
      if (currentWizardStep === 1 && !importPreviewData) {
        alert("请先选择要导入的文件");
        return;
      }
      if (currentWizardStep < 3) goToStep(currentWizardStep + 1);
    };

    document.getElementById("wizPrevBtn").onclick = () => {
      if (currentWizardStep > 1) goToStep(currentWizardStep - 1);
    };

    document.getElementById("confirmImportBtn").onclick = confirmImport;

    document.querySelectorAll("#entity-commissions .import-filter-tab").forEach(tab => {
      tab.onclick = () => {
        currentEntityFilter.commissions = tab.dataset.importFilter;
        renderCommissionPreview();
      };
    });

    document.querySelectorAll(".entity-tab").forEach(tab => {
      tab.onclick = () => switchEntityTab(tab.dataset.entity);
    });

    document.addEventListener("click", (e) => {
      const matchCandidate = e.target.closest(".match-candidate, .match-create-new");
      if (matchCandidate) {
        const entityKey = matchCandidate.dataset.entity;
        const matchKey = decodeURIComponent(matchCandidate.dataset.matchkey);
        const matchId = matchCandidate.dataset.matchid;
        setMatch(entityKey, matchKey, matchId);
        renderEntityList(entityKey);
      }
    });

    document.querySelectorAll(".wizard-step").forEach(btn => {
      btn.onclick = () => {
        const step = Number(btn.dataset.wizStep);
        if (step <= currentWizardStep) goToStep(step);
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
    let quoteDiffData = null;
    let quoteDiffVisible = false;
    let quoteDiffBase = null;
    let quoteDiffIsLive = false;

    function calculateLocalDiff(baseQuote, targetQuote) {
      if (!baseQuote || !targetQuote) return null;

      function itemKey(item) {
        return (item.description || "").trim();
      }

      const aKeys = new Map((baseQuote.items || []).map(i => [itemKey(i), i]));
      const bKeys = new Map((targetQuote.items || []).map(i => [itemKey(i), i]));
      const addedItems = [];
      const removedItems = [];
      const modifiedItems = [];

      for (const [key, bItem] of bKeys) {
        if (!aKeys.has(key)) {
          addedItems.push(bItem);
        } else {
          const aItem = aKeys.get(key);
          if ((aItem.quantity || 0) !== (bItem.quantity || 0) ||
              (aItem.unitPrice || 0) !== (bItem.unitPrice || 0) ||
              (aItem.amount || 0) !== (bItem.amount || 0)) {
            modifiedItems.push({ oldItem: aItem, newItem: bItem });
          }
        }
      }
      for (const [key, aItem] of aKeys) {
        if (!bKeys.has(key)) {
          removedItems.push(aItem);
        }
      }

      const aItemsTotal = (baseQuote.items || []).reduce((s, i) => s + (i.amount || 0), 0);
      const bItemsTotal = (targetQuote.items || []).reduce((s, i) => s + (i.amount || 0), 0);
      const aLabor = baseQuote.laborCost || 0;
      const bLabor = targetQuote.laborCost || 0;
      const aMaterial = baseQuote.materialCost || 0;
      const bMaterial = targetQuote.materialCost || 0;
      const aTotal = baseQuote.totalAmount || 0;
      const bTotal = targetQuote.totalAmount || 0;
      const aDays = baseQuote.estimatedDays || 0;
      const bDays = targetQuote.estimatedDays || 0;

      return {
        baseVersion: baseQuote.version || '?',
        targetVersion: targetQuote.version ? (targetQuote.version + (quoteDiffIsLive ? ' (草稿)' : '')) : '草稿',
        baseQuoteId: baseQuote.id || '',
        targetQuoteId: targetQuote.id || '',
        amount: {
          itemsTotal: { oldValue: aItemsTotal, newValue: bItemsTotal, difference: bItemsTotal - aItemsTotal },
          laborCost: { oldValue: aLabor, newValue: bLabor, difference: bLabor - aLabor },
          materialCost: { oldValue: aMaterial, newValue: bMaterial, difference: bMaterial - aMaterial },
          totalAmount: { oldValue: aTotal, newValue: bTotal, difference: bTotal - aTotal },
          estimatedDays: { oldValue: aDays, newValue: bDays, difference: bDays - aDays }
        },
        items: { added: addedItems, removed: removedItems, modified: modifiedItems },
        remark: {
          oldValue: baseQuote.remark || '',
          newValue: targetQuote.remark || '',
          changed: (baseQuote.remark || '') !== (targetQuote.remark || '')
        }
      };
    }

    function refreshLiveDiff() {
      if (!quoteDiffBase || !isQuoteEditing) return;

      const laborInput = document.getElementById("quoteLaborCost");
      const materialInput = document.getElementById("quoteMaterialCost");
      const daysInput = document.getElementById("quoteEstimatedDays");
      const remarkInput = document.getElementById("quoteRemark");

      const itemsTotal = currentQuoteItems.reduce((s, i) => s + (i.amount || 0), 0);
      const labor = Number(laborInput?.value) || 0;
      const material = Number(materialInput?.value) || 0;
      const days = Number(daysInput?.value) || 0;
      const remark = remarkInput?.value || '';
      const total = itemsTotal + labor + material;

      const tempQuote = {
        version: quoteDiffBase.version ? (quoteDiffBase.version + 1) : 1,
        items: currentQuoteItems,
        laborCost: labor,
        materialCost: material,
        totalAmount: total,
        estimatedDays: days,
        remark: remark
      };

      quoteDiffData = calculateLocalDiff(quoteDiffBase, tempQuote);
      quoteDiffIsLive = true;
      renderQuoteDiff();
    }

    function formatDelta(value, isDays) {
      const num = Number(value) || 0;
      if (num === 0) return '<span class="quote-diff-delta zero">' + (isDays ? '0天' : '¥0.00') + '</span>';
      const sign = num > 0 ? '+' : '';
      const cls = num > 0 ? 'up' : 'down';
      const text = isDays ? (sign + num + '天') : (sign + '¥' + Math.abs(num).toFixed(2));
      return '<span class="quote-diff-delta ' + cls + '">' + text + '</span>';
    }

    function renderAmountDiff(containerId, data, isDays) {
      const el = document.getElementById(containerId);
      if (!el || !data) return;
      const oldVal = isDays ? (data.oldValue + '天') : formatMoney(data.oldValue);
      const newVal = isDays ? (data.newValue + '天') : formatMoney(data.newValue);
      el.innerHTML = '<div class="quote-diff-old">' + oldVal + '</div>' +
        '<div class="quote-diff-new">' + newVal + '</div>' +
        formatDelta(data.difference, isDays);
    }

    function renderQuoteDiff() {
      const diffSection = document.getElementById("quoteDiffSection");
      if (!diffSection) return;

      if (!quoteDiffData || !quoteDiffVisible) {
        diffSection.style.display = "none";
        return;
      }

      diffSection.style.display = "block";
      document.getElementById("quoteDiffVersions").textContent =
        '(V' + quoteDiffData.baseVersion + ' → V' + quoteDiffData.targetVersion + ')';
      const toggleBtn = document.getElementById("quoteDiffToggleBtn");
      if (toggleBtn) toggleBtn.textContent = quoteDiffVisible ? "隐藏对比" : "显示对比";

      renderAmountDiff("diffItemsTotal", quoteDiffData.amount.itemsTotal, false);
      renderAmountDiff("diffLaborCost", quoteDiffData.amount.laborCost, false);
      renderAmountDiff("diffMaterialCost", quoteDiffData.amount.materialCost, false);
      renderAmountDiff("diffTotalAmount", quoteDiffData.amount.totalAmount, false);
      renderAmountDiff("diffEstimatedDays", quoteDiffData.amount.estimatedDays, true);

      const added = quoteDiffData.items.added || [];
      const removed = quoteDiffData.items.removed || [];
      const modified = quoteDiffData.items.modified || [];
      const hasItemChanges = added.length || removed.length || modified.length;

      const itemsBlock = document.getElementById("diffItemsBlock");
      itemsBlock.style.display = hasItemChanges ? "block" : "none";

      const addedGroup = document.getElementById("diffAddedGroup");
      if (added.length) {
        addedGroup.style.display = "block";
        document.getElementById("diffAddedCount").textContent = added.length;
        document.getElementById("diffAddedList").innerHTML = added.map(item =>
          '<div class="quote-diff-item-row added">' +
          '<div class="diff-col-desc">➕ ' + escapeHtml(item.description || '') + '</div>' +
          '<div class="diff-col-qty">' + (item.quantity || 0) + '</div>' +
          '<div class="diff-col-price">' + formatMoney(item.unitPrice || 0) + '</div>' +
          '<div class="diff-col-amount">' + formatMoney(item.amount || 0) + '</div>' +
          '</div>'
        ).join("");
      } else {
        addedGroup.style.display = "none";
      }

      const removedGroup = document.getElementById("diffRemovedGroup");
      if (removed.length) {
        removedGroup.style.display = "block";
        document.getElementById("diffRemovedCount").textContent = removed.length;
        document.getElementById("diffRemovedList").innerHTML = removed.map(item =>
          '<div class="quote-diff-item-row removed">' +
          '<div class="diff-col-desc">➖ ' + escapeHtml(item.description || '') + '</div>' +
          '<div class="diff-col-qty">' + (item.quantity || 0) + '</div>' +
          '<div class="diff-col-price">' + formatMoney(item.unitPrice || 0) + '</div>' +
          '<div class="diff-col-amount">' + formatMoney(item.amount || 0) + '</div>' +
          '</div>'
        ).join("");
      } else {
        removedGroup.style.display = "none";
      }

      const modifiedGroup = document.getElementById("diffModifiedGroup");
      if (modified.length) {
        modifiedGroup.style.display = "block";
        document.getElementById("diffModifiedCount").textContent = modified.length;
        document.getElementById("diffModifiedList").innerHTML = modified.map(m => {
          const oldItem = m.oldItem || {};
          const newItem = m.newItem || {};
          const qtyChanged = (oldItem.quantity || 0) !== (newItem.quantity || 0);
          const priceChanged = (oldItem.unitPrice || 0) !== (newItem.unitPrice || 0);
          const amountChanged = (oldItem.amount || 0) !== (newItem.amount || 0);
          const details = [];
          if (qtyChanged) details.push('<span>数量: <span class="diff-old-val">' + (oldItem.quantity || 0) + '</span><span class="diff-arrow">→</span><span class="diff-new-val">' + (newItem.quantity || 0) + '</span></span>');
          if (priceChanged) details.push('<span>单价: <span class="diff-old-val">' + formatMoney(oldItem.unitPrice || 0) + '</span><span class="diff-arrow">→</span><span class="diff-new-val">' + formatMoney(newItem.unitPrice || 0) + '</span></span>');
          return '<div class="quote-diff-item-row modified">' +
            '<div class="diff-col-desc">✏️ ' + escapeHtml(newItem.description || oldItem.description || '') +
            (details.length ? '<div class="quote-diff-modified-detail">' + details.join('') + '</div>' : '') +
            '</div>' +
            '<div class="diff-col-qty">' + (newItem.quantity || 0) + '</div>' +
            '<div class="diff-col-price">' + formatMoney(newItem.unitPrice || 0) + '</div>' +
            '<div class="diff-col-amount">' +
              (amountChanged ? '<div><span class="diff-old-val">' + formatMoney(oldItem.amount || 0) + '</span><span class="diff-arrow">→</span><span class="diff-new-val">' + formatMoney(newItem.amount || 0) + '</span></div>' : formatMoney(newItem.amount || 0)) +
            '</div>' +
            '</div>';
        }).join("");
      } else {
        modifiedGroup.style.display = "none";
      }

      const remarkBlock = document.getElementById("diffRemarkBlock");
      if (quoteDiffData.remark && quoteDiffData.remark.changed) {
        remarkBlock.style.display = "block";
        document.getElementById("diffRemarkOld").textContent = quoteDiffData.remark.oldValue || "(空)";
        document.getElementById("diffRemarkNew").textContent = quoteDiffData.remark.newValue || "(空)";
      } else {
        remarkBlock.style.display = "none";
      }

      const emptyEl = document.getElementById("diffEmpty");
      if (!hasItemChanges && !(quoteDiffData.remark && quoteDiffData.remark.changed) &&
          quoteDiffData.amount.totalAmount.difference === 0 &&
          quoteDiffData.amount.itemsTotal.difference === 0 &&
          quoteDiffData.amount.laborCost.difference === 0 &&
          quoteDiffData.amount.materialCost.difference === 0 &&
          quoteDiffData.amount.estimatedDays.difference === 0) {
        emptyEl.style.display = "block";
      } else {
        emptyEl.style.display = "none";
      }
    }

    async function loadQuoteDiff(baseQuoteId, targetQuoteId) {
      if (!baseQuoteId || !targetQuoteId || baseQuoteId === targetQuoteId) {
        quoteDiffData = null;
        quoteDiffVisible = false;
        renderQuoteDiff();
        return;
      }
      try {
        const diff = await api("/api/commissions/" + currentQuoteCommissionId +
          "/quotes/" + baseQuoteId + "/diff/" + targetQuoteId);
        quoteDiffData = diff;
        quoteDiffVisible = true;
        renderQuoteDiff();
      } catch (e) {
        quoteDiffData = null;
        quoteDiffVisible = false;
        renderQuoteDiff();
      }
    }

    function toggleQuoteDiff() {
      quoteDiffVisible = !quoteDiffVisible;
      renderQuoteDiff();
    }

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
            refreshLiveDiff();
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
            refreshLiveDiff();
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
            refreshLiveDiff();
          };
        });
        listEl.querySelectorAll("[data-item-del]").forEach(btn => {
          btn.onclick = () => {
            const idx = Number(btn.dataset.itemDel);
            currentQuoteItems.splice(idx, 1);
            renderQuoteItems();
            calculateQuoteTotals();
            refreshLiveDiff();
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
        item.onclick = async () => {
          const quoteId = item.dataset.historyId;
          const quote = quoteHistory.find(q => q.id === quoteId);
          if (quote) {
            currentQuoteData = quote;
            currentQuoteItems = JSON.parse(JSON.stringify(quote.items || []));
            isQuoteEditing = false;
            quoteDiffData = null;
            quoteDiffVisible = false;
            renderQuoteDetail();
            if (quote.previousVersionId) {
              await loadQuoteDiff(quote.previousVersionId, quote.id);
            }
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

      renderQuoteDiff();
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
        quoteDiffData = null;
        quoteDiffVisible = false;
        quoteDiffIsLive = false;
        quoteDiffBase = null;
        renderQuoteDetail();
        if (currentQuoteData && currentQuoteData.previousVersionId) {
          quoteDiffBase = quoteHistory.find(q => q.id === currentQuoteData.previousVersionId) || null;
          await loadQuoteDiff(currentQuoteData.previousVersionId, currentQuoteData.id);
        }
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
      quoteDiffData = null;
      quoteDiffVisible = false;
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

    function joinRepairLabel(text, label, keywords) {
      for (const keyword of keywords) {
        if (text.endsWith(keyword) && label.startsWith(keyword)) {
          return text + label.slice(keyword.length);
        }
      }
      return text + label;
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
            description: joinRepairLabel(text, matched.label, matched.keywords),
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

    function getQuoteHistory(commission) {
      const quotes = Array.isArray(commission.quotes) ? commission.quotes : [];
      return quotes
        .filter(q => q && Array.isArray(q.items))
        .slice()
        .sort((a, b) => {
          const versionDiff = (Number(b.version) || 0) - (Number(a.version) || 0);
          if (versionDiff) return versionDiff;
          return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
        });
    }

    function applyHistoricalQuotePricing(items, historyQuote) {
      if (!historyQuote || !Array.isArray(historyQuote.items)) return items;
      const historyItemMap = new Map();
      historyQuote.items.forEach(item => {
        const key = (item.description || "").trim();
        if (key && !historyItemMap.has(key)) historyItemMap.set(key, item);
      });
      return items.map(item => {
        const historyItem = historyItemMap.get((item.description || "").trim());
        if (!historyItem) return item;
        const unitPrice = Number(historyItem.unitPrice);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) return item;
        const quantity = Number(item.quantity) || 0;
        return {
          ...item,
          unitPrice,
          amount: quantity * unitPrice
        };
      });
    }

    function estimateCostFromHistory(defaultCost, historyCost, defaultItemsTotal, finalItemsTotal) {
      const oldCost = Number(historyCost);
      if (!Number.isFinite(oldCost) || oldCost <= 0) return defaultCost;
      const oldItems = Number(defaultItemsTotal) || 0;
      if (oldItems <= 0) return oldCost;
      const ratio = (Number(finalItemsTotal) || 0) / oldItems;
      return Math.max(0, Math.round(oldCost * ratio));
    }

    function generateSmartQuote(commission) {
      const allItems = [];
      let totalMaterialCost = 0;
      let totalBaseDays = 0;
      const quoteHistory = getQuoteHistory(commission);
      const historyQuote = quoteHistory[0] || null;

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

      let itemIdCounter = 0;
      const generatedItems = allItems.map(it => ({
        id: "QI-auto-" + Date.now() + "-" + (itemIdCounter++),
        description: it.description,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        amount: it.amount
      }));
      const finalItems = applyHistoricalQuotePricing(generatedItems, historyQuote);
      const defaultItemsSum = allItems.reduce((s, it) => s + it.amount, 0);
      const itemsSum = finalItems.reduce((s, it) => s + it.amount, 0);
      const projectLaborCost = Math.round(itemsSum * 0.5);

      const dailyLaborRate = 120;
      const estimatedDaysBase = Math.max(3, Math.min(30, totalBaseDays + (commission.dueDate ? 0 : 2)));
      const estimatedDays = historyQuote && Number(historyQuote.estimatedDays) > 0
        ? Math.max(1, Math.round(((Number(historyQuote.estimatedDays) || estimatedDaysBase) + estimatedDaysBase) / 2))
        : estimatedDaysBase;
      const durationLaborCost = estimatedDays * dailyLaborRate;

      const defaultLaborCost = projectLaborCost + durationLaborCost;
      const baseItemMaterialCost = Math.round(itemsSum * 0.2);
      const defaultMaterialCost = baseItemMaterialCost + totalMaterialCost;
      const laborCost = historyQuote
        ? estimateCostFromHistory(defaultLaborCost, historyQuote.laborCost, defaultItemsSum, itemsSum)
        : defaultLaborCost;
      const materialCost = historyQuote
        ? estimateCostFromHistory(defaultMaterialCost, historyQuote.materialCost, defaultItemsSum, itemsSum)
        : defaultMaterialCost;

      const remarkLines = [];
      if (commission.damage && commission.damage !== "-") remarkLines.push("破损修复");
      if (commission.missingParts && commission.missingParts !== "-") remarkLines.push("缺失零件配补");
      if (commission.colorNotes && commission.colorNotes !== "-") remarkLines.push("补色重绘");
      if (commission.reinforcement && commission.reinforcement !== "-") remarkLines.push("加固处理");
      remarkLines.push("含人工及材料");
      if (historyQuote) remarkLines.push("参考历史报价V" + historyQuote.version);

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

      const op = getOperator();
      if (!op.operator) return alert("请先在页面顶部选择当前操作者");
      try {
        quoteData.operator = op.operator;
        quoteData.operatorId = op.operatorId;
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

      const op = getOperator();
      if (!op.operator) return alert("请先在页面顶部选择当前操作者");
      try {
        const updated = await api("/api/commissions/" + currentQuoteCommissionId + "/quotes/" + currentQuoteData.id, {
          method: "PUT",
          body: JSON.stringify({
            items: currentQuoteItems,
            laborCost: totals.laborCost,
            materialCost: totals.materialCost,
            totalAmount: totals.total,
            estimatedDays: Number(document.getElementById("quoteEstimatedDays").value) || 0,
            remark: document.getElementById("quoteRemark").value || "",
            operator: op.operator,
            operatorId: op.operatorId
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

      const op = getOperator();
      if (!op.operator) return alert("请先在页面顶部选择当前操作者");
      try {
        const confirmed = await api("/api/commissions/" + currentQuoteCommissionId + "/quotes/" + currentQuoteData.id + "/confirm", {
          method: "POST",
          body: JSON.stringify({ operator: op.operator, operatorId: op.operatorId })
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

      const mode = prompt(
        [
          "请选择重新报价方式：",
          "",
          "1 - 复制当前报价（保留原有项目和价格）",
          "2 - 基于修复信息重新生成（智能生成新草稿）",
          "",
          "请输入数字 1 或 2："
        ].join("\\n"),
        "1"
      );
      if (mode === null) return;

      const op = getOperator();
      if (!op.operator) return alert("请先在页面顶部选择当前操作者");

      try {
        let requestBody = { operator: op.operator, operatorId: op.operatorId };

        if (mode.trim() === "2") {
          const commission = commissions.find(c => c.id === currentQuoteCommissionId);
          if (!commission) return alert("未找到委托信息");
          const smart = generateSmartQuote(commission);
          requestBody.items = smart.items;
          requestBody.laborCost = smart.laborCost;
          requestBody.materialCost = smart.materialCost;
          requestBody.estimatedDays = smart.estimatedDays;
          requestBody.remark = smart.remark;
        }

        const newQuote = await api("/api/commissions/" + currentQuoteCommissionId + "/quotes/" + currentQuoteData.id + "/revise", {
          method: "POST",
          body: JSON.stringify(requestBody)
        });
        currentQuoteData = newQuote;
        currentQuoteItems = JSON.parse(JSON.stringify(newQuote.items || []));
        isQuoteEditing = true;
        quoteDiffIsLive = true;
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
      refreshLiveDiff();
    }

    function startEditQuote() {
      isQuoteEditing = true;
      quoteDiffIsLive = true;
      renderQuoteDetail();
      if (quoteDiffBase && quoteDiffVisible) {
        refreshLiveDiff();
      }
    }

    function cancelEditQuote() {
      if (currentQuoteData) {
        currentQuoteItems = JSON.parse(JSON.stringify(currentQuoteData.items || []));
      }
      isQuoteEditing = false;
      quoteDiffIsLive = false;
      renderQuoteDetail();
      if (quoteDiffBase && currentQuoteData && currentQuoteData.previousVersionId) {
        loadQuoteDiff(currentQuoteData.previousVersionId, currentQuoteData.id);
      }
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

    ["quoteLaborCost", "quoteMaterialCost", "quoteEstimatedDays", "quoteRemark"].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.oninput = () => {
          calculateQuoteTotals();
          refreshLiveDiff();
        };
      }
    });

    const quoteDiffToggleBtn = document.getElementById("quoteDiffToggleBtn");
    if (quoteDiffToggleBtn) quoteDiffToggleBtn.onclick = toggleQuoteDiff;

    let currentAcceptanceCommissionId = null;

    function openAcceptanceModal(commissionId) {
      const commission = commissions.find(c => c.id === commissionId);
      if (!commission) return;

      const cSteps = commission.steps || defaultSteps;
      const lastStep = cSteps[cSteps.length - 1];
      const isAtDeliveryStep = commission.status === lastStep;
      const hasAcceptance = commission.acceptance !== null;

      if (!isAtDeliveryStep && !hasAcceptance) {
        alert("只有进入交付步骤的委托才能填写验收");
        return;
      }

      currentAcceptanceCommissionId = commissionId;
      document.getElementById("acceptanceModal").classList.add("active");

      document.getElementById("acceptanceCommissionName").textContent = commission.roleName;
      document.getElementById("acceptanceClientName").textContent = commission.client;
      document.getElementById("acceptanceCurrentStep").textContent = commission.status;

      const detailView = document.getElementById("acceptanceDetailView");
      const editActions = document.getElementById("acceptanceEditActions");
      const viewActions = document.getElementById("acceptanceViewActions");
      const resultRadios = document.querySelectorAll('input[name="acceptanceResult"]');
      const deliveryDateInput = document.getElementById("acceptanceDeliveryDate");
      const receiverInput = document.getElementById("acceptanceReceiver");
      const remainingIssuesInput = document.getElementById("acceptanceRemainingIssues");
      const maintenanceAdviceInput = document.getElementById("acceptanceMaintenanceAdvice");

      resultRadios.forEach(r => { r.disabled = false; r.checked = false; });
      deliveryDateInput.disabled = false;
      deliveryDateInput.value = new Date().toISOString().slice(0, 10);
      receiverInput.disabled = false;
      receiverInput.value = "";
      remainingIssuesInput.disabled = false;
      remainingIssuesInput.value = "";
      maintenanceAdviceInput.disabled = false;
      maintenanceAdviceInput.value = "";

      if (hasAcceptance && commission.acceptance) {
        const acc = commission.acceptance;
        detailView.style.display = "block";
        editActions.style.display = "none";
        viewActions.style.display = "flex";

        document.getElementById("detailResult").textContent = acc.result || "-";
        document.getElementById("detailDeliveryDate").textContent = acc.deliveryDate || "-";
        document.getElementById("detailReceiver").textContent = acc.receiver || "-";
        document.getElementById("detailRemainingIssues").textContent = acc.remainingIssues || "-";
        document.getElementById("detailMaintenanceAdvice").textContent = acc.maintenanceAdvice || "-";
        document.getElementById("detailAcceptedAt").textContent = acc.acceptedAt ? formatDate(acc.acceptedAt) : "-";

        resultRadios.forEach(r => {
          r.disabled = true;
          r.checked = r.value === acc.result;
        });
        deliveryDateInput.disabled = true;
        deliveryDateInput.value = acc.deliveryDate || "";
        receiverInput.disabled = true;
        receiverInput.value = acc.receiver || "";
        remainingIssuesInput.disabled = true;
        remainingIssuesInput.value = acc.remainingIssues || "";
        maintenanceAdviceInput.disabled = true;
        maintenanceAdviceInput.value = acc.maintenanceAdvice || "";
      } else {
        detailView.style.display = "none";
        editActions.style.display = "flex";
        viewActions.style.display = "none";
      }
    }

    function closeAcceptanceModal() {
      document.getElementById("acceptanceModal").classList.remove("active");
      currentAcceptanceCommissionId = null;
    }

    async function saveAcceptance() {
      if (!currentAcceptanceCommissionId) return;

      const result = document.querySelector('input[name="acceptanceResult"]:checked')?.value;
      const deliveryDate = document.getElementById("acceptanceDeliveryDate").value;
      const receiver = document.getElementById("acceptanceReceiver").value.trim();
      const remainingIssues = document.getElementById("acceptanceRemainingIssues").value.trim();
      const maintenanceAdvice = document.getElementById("acceptanceMaintenanceAdvice").value.trim();

      if (!result) return alert("请选择验收结果");
      if (!deliveryDate) return alert("请选择交付日期");
      if (!receiver) return alert("请填写领取人");

      const op = getOperator();
      if (!op.operator) return alert("请先在页面顶部选择当前操作者");
      try {
        await api("/api/commissions/" + currentAcceptanceCommissionId + "/acceptance", {
          method: "POST",
          body: JSON.stringify({
            result,
            deliveryDate,
            receiver,
            remainingIssues,
            maintenanceAdvice,
            operator: op.operator,
            operatorId: op.operatorId
          })
        });
        await loadAll();
        closeAcceptanceModal();
        alert("交付验收已保存");
      } catch (e) {
        alert("保存验收失败：" + e.message);
      }
    }

    async function deleteAcceptance() {
      if (!currentAcceptanceCommissionId) return;
      if (!confirm("确定要撤销验收记录吗？")) return;

      const op = getOperator();
      if (!op.operator) return alert("请先在页面顶部选择当前操作者");
      try {
        await api("/api/commissions/" + currentAcceptanceCommissionId + "/acceptance", {
          method: "DELETE",
          body: JSON.stringify({ operator: op.operator, operatorId: op.operatorId })
        });
        await loadAll();
        closeAcceptanceModal();
        alert("验收记录已撤销");
      } catch (e) {
        alert("撤销验收失败：" + e.message);
      }
    }

    document.getElementById("acceptanceModalClose").onclick = closeAcceptanceModal;
    document.getElementById("acceptanceCloseBtn").onclick = closeAcceptanceModal;
    document.getElementById("acceptanceModal").onclick = (e) => {
      if (e.target.id === "acceptanceModal") closeAcceptanceModal();
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.getElementById("acceptanceModal").classList.contains("active")) {
        closeAcceptanceModal();
      }
    });

    document.getElementById("acceptanceSaveBtn").onclick = saveAcceptance;
    document.getElementById("acceptanceDeleteBtn").onclick = deleteAcceptance;

    document.querySelectorAll(".stage-filter-tab").forEach(tab => {
      tab.onclick = () => {
        currentStageFilter = tab.dataset.stageFilter;
        document.querySelectorAll(".stage-filter-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        localStorage.setItem("stageFilter", currentStageFilter);
        renderCommissions();
      };
    });

    const savedStageFilter = localStorage.getItem("stageFilter");
    if (savedStageFilter) {
      currentStageFilter = savedStageFilter;
      document.querySelectorAll(".stage-filter-tab").forEach(t => {
        t.classList.toggle("active", t.dataset.stageFilter === currentStageFilter);
      });
    }

    loadAll();

    let currentDetailCommissionId = null;
    let currentDetailSection = "info";

    const detailFieldLabels = {
      roleName: "角色名称", era: "年代", damage: "破损部位", missingParts: "缺失零件",
      colorNotes: "补色记录", reinforcement: "加固材料", owner: "负责人", dueDate: "截止日期",
      status: "当前步骤", client: "客户", materials: "选用材料"
    };

    function openDetailModal(commissionId) {
      currentDetailCommissionId = commissionId;
      currentDetailSection = "info";
      const commission = commissions.find(c => c.id === commissionId);
      if (!commission) return;
      document.getElementById("detailTitle").textContent = "委托详情 - " + commission.roleName;
      document.getElementById("detailModal").classList.add("active");
      renderDetailAll(commission);
    }

    function closeDetailModal() {
      document.getElementById("detailModal").classList.remove("active");
      currentDetailCommissionId = null;
    }

    function switchDetailSection(section) {
      currentDetailSection = section;
      document.querySelectorAll(".detail-nav-btn").forEach(b => b.classList.toggle("active", b.dataset.detailSection === section));
      document.querySelectorAll(".detail-section").forEach(s => s.classList.toggle("active", s.id === "detail-" + section));
    }

    function renderDetailAll(c) {
      renderDetailInfo(c);
      renderDetailTimeline(c);
      renderDetailImages(c);
      renderDetailQuotes(c);
      renderDetailAcceptance(c);
      renderDetailOpLogs(c);
      renderDetailVersions(c);
    }

    function renderDetailInfo(c) {
      const el = document.getElementById("detail-info");
      if (!el) return;
      const steps = c.steps || defaultSteps;
      const currentIdx = steps.indexOf(c.status);
      const consumeStepName = c.consumeStepName || "补片";
      const consumeIdx = steps.indexOf(consumeStepName);
      const isConsumed = consumeIdx !== -1 && currentIdx >= consumeIdx;
      const matChips = (c.materials && c.materials.length) ? c.materials.map(m => {
        const reserved = Number(m.reservedQty) || 0;
        const consumed = Number(m.consumedQty) || 0;
        let statusText = '';
        let statusClass = '';
        if (consumed > 0) {
          statusText = '已消耗 ' + consumed + (m.unit || '');
          statusClass = 'mat-chip-consumed';
        } else if (reserved > 0) {
          statusText = '已占用 ' + reserved + (m.unit || '');
          statusClass = 'mat-chip-reserved';
        } else {
          statusText = '未占用';
          statusClass = 'mat-chip-pending';
        }
        const extraInfo = consumed ? '（需 ' + m.quantity + (m.unit || '') + '）' : '';
        return '<span class="mat-chip ' + statusClass + '" title="' + statusText + extraInfo + (m.consumedAt ? '，消耗时间：' + formatDate(m.consumedAt) : '') + (m.consumedBy ? '，操作人：' + m.consumedBy : '') + '">' + m.name + ' ×' + m.quantity + (m.batch ? ' (' + m.batch + ')' : '') + '<span class="mat-chip-status">' + statusText + '</span></span>';
      }).join("") : '<span style="color:var(--muted);">无</span>';
      const consumeBadge = '<span class="pill" style="margin-left:6px;background:' + (isConsumed ? 'var(--green)' : 'var(--line)') + ';color:' + (isConsumed ? '#fff' : 'var(--muted)') + ';">消耗点：' + consumeStepName + (isConsumed ? ' ✓' : '') + '</span>';
      const tplBadge = c.templateName ? '<span class="pill" style="margin-left:6px;background:var(--bg);">' + c.templateName + '</span>' : '';
      const statusBadge = '<span class="pill">' + (c.status || '—') + '</span>';
      const completedBadge = c.acceptance ? '<span class="pill confirmed" style="margin-left:6px;">已完成</span>' : '';
      const progressHtml = '<div class="steps-progress" style="margin-bottom:12px;">' + steps.map((s, i) => {
        let cls = "step-dot";
        if (i < currentIdx) cls += " done";
        else if (i === currentIdx) cls += " current";
        return '<div class="' + cls + '" title="' + s + '"></div>';
      }).join("") + '</div>';
      const stepsBar = '<div style="display:flex;gap:4px;align-items:center;margin-bottom:12px;">' + steps.map((s, i) => {
        let bg = "var(--line)";
        let col = "var(--muted)";
        if (i < currentIdx) { bg = "var(--green)"; col = "#fff"; }
        else if (i === currentIdx) { bg = "var(--accent)"; col = "#fff"; }
        return '<span style="background:'+bg+';color:'+col+';padding:2px 8px;border-radius:999px;font-size:11px;white-space:nowrap;">'+s+'</span>';
      }).join('<span style="color:var(--muted);font-size:10px;">→</span>') + '</div>';

      el.innerHTML = '<div class="detail-section-header"><h4>基础信息</h4><button class="small" id="detailEditInfoBtn">✏️ 编辑</button></div>' +
        stepsBar +
        '<div class="detail-info-grid">' +
        '<div class="detail-info-item"><span class="label">角色名称</span><span class="value">' + (c.roleName || '—') + tplBadge + '</span></div>' +
        '<div class="detail-info-item"><span class="label">年代估计</span><span class="value">' + (c.era || '—') + '</span></div>' +
        '<div class="detail-info-item"><span class="label">客户</span><span class="value">' + (c.client || '—') + '</span></div>' +
        '<div class="detail-info-item"><span class="label">当前步骤</span><span class="value">' + statusBadge + completedBadge + consumeBadge + '</span></div>' +
        '<div class="detail-info-item full"><span class="label">破损部位</span><span class="value">' + (c.damage || '—') + '</span></div>' +
        '<div class="detail-info-item"><span class="label">缺失零件</span><span class="value">' + (c.missingParts || '—') + '</span></div>' +
        '<div class="detail-info-item"><span class="label">补色记录</span><span class="value">' + (c.colorNotes || '—') + '</span></div>' +
        '<div class="detail-info-item"><span class="label">加固材料</span><span class="value">' + (c.reinforcement || '—') + '</span></div>' +
        '<div class="detail-info-item"><span class="label">负责人</span><span class="value">' + (c.owner || '—') + '</span></div>' +
        '<div class="detail-info-item"><span class="label">截止日期</span><span class="value">' + (c.dueDate || '—') + '</span></div>' +
        '<div class="detail-info-item full"><span class="label">选用材料 <button type="button" class="small secondary" id="showCommissionLedgerBtn" style="margin-left:8px;">查看材料流水</button></span><span class="value"><div class="mat-chips">' + matChips + '</div></span></div>' +
        '</div>' +
        '<div id="detailEditForm" style="display:none;margin-top:16px;padding:16px;background:var(--bg);border-radius:8px;">' +
        '<h4 style="margin:0 0 12px;">编辑基础信息</h4>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
        '<div><label style="margin:0;font-size:12px;color:var(--muted);">角色名称</label><input id="editRoleName" value="' + (c.roleName || '') + '"></div>' +
        '<div><label style="margin:0;font-size:12px;color:var(--muted);">年代</label><input id="editEra" value="' + (c.era || '') + '"></div>' +
        '<div><label style="margin:0;font-size:12px;color:var(--muted);">客户</label><input id="editClient" value="' + (c.client || '') + '"></div>' +
        '<div><label style="margin:0;font-size:12px;color:var(--muted);">负责人</label><input id="editOwner" value="' + (c.owner || '') + '"></div>' +
        '<div><label style="margin:0;font-size:12px;color:var(--muted);">截止日期</label><input type="date" id="editDueDate" value="' + (c.dueDate || '') + '"></div>' +
        '<div><label style="margin:0;font-size:12px;color:var(--muted);">缺失零件</label><input id="editMissingParts" value="' + (c.missingParts || '') + '"></div>' +
        '</div>' +
        '<label style="margin:10px 0 3px;font-size:12px;color:var(--muted);">破损部位</label><textarea id="editDamage" rows="2">' + (c.damage || '') + '</textarea>' +
        '<label style="margin:10px 0 3px;font-size:12px;color:var(--muted);">补色记录</label><textarea id="editColorNotes" rows="2">' + (c.colorNotes || '') + '</textarea>' +
        '<label style="margin:10px 0 3px;font-size:12px;color:var(--muted);">加固材料</label><input id="editReinforcement" value="' + (c.reinforcement || '') + '">' +
        '<div style="display:flex;gap:8px;margin-top:12px;"><button id="saveDetailInfoBtn">保存修改</button><button class="secondary" id="cancelDetailEditBtn">取消</button></div>' +
        '</div>';

      document.getElementById("detailEditInfoBtn").onclick = () => {
        document.getElementById("detailEditForm").style.display = "block";
      };
      document.getElementById("cancelDetailEditBtn").onclick = () => {
        document.getElementById("detailEditForm").style.display = "none";
      };
      document.getElementById("saveDetailInfoBtn").onclick = async () => {
        const op = getOperator();
        if (!op.operator) return alert("请先在页面顶部选择当前操作者");
        try {
          await api("/api/commissions/" + c.id, {
            method: "PUT",
            body: JSON.stringify({
              roleName: document.getElementById("editRoleName").value,
              era: document.getElementById("editEra").value,
              client: document.getElementById("editClient").value,
              owner: document.getElementById("editOwner").value,
              dueDate: document.getElementById("editDueDate").value,
              missingParts: document.getElementById("editMissingParts").value,
              damage: document.getElementById("editDamage").value,
              colorNotes: document.getElementById("editColorNotes").value,
              reinforcement: document.getElementById("editReinforcement").value,
              operator: op.operator,
              operatorId: op.operatorId
            })
          });
          await loadAll();
          const updated = commissions.find(x => x.id === c.id);
          if (updated) renderDetailAll(updated);
          document.getElementById("detailTitle").textContent = "委托详情 - " + document.getElementById("editRoleName").value;
        } catch (e) {
          alert("保存失败：" + e.message);
        }
      };
      const ledgerBtn = document.getElementById("showCommissionLedgerBtn");
      if (ledgerBtn) ledgerBtn.onclick = () => showStockLedger({ commissionId: c.id, title: c.roleName + " - 材料流水" });
    }

    function renderDetailTimeline(c) {
      const el = document.getElementById("detail-timeline");
      if (!el) return;
      const steps = c.steps || defaultSteps;
      const currentIdx = steps.indexOf(c.status);
      const recordsByStep = {};
      for (const r of (c.records || [])) {
        if (!recordsByStep[r.step]) recordsByStep[r.step] = [];
        recordsByStep[r.step].push(r);
      }

      let html = '<div class="detail-section-header"><h4>步骤时间线</h4></div><div class="detail-timeline">';
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const isDone = i < currentIdx;
        const isCurrent = i === currentIdx;
        const isFuture = i > currentIdx;
        const cls = isDone ? "done" : isCurrent ? "current" : "";
        const records = recordsByStep[step] || [];
        html += '<div class="timeline-item ' + cls + '">' +
          '<span class="tl-step' + (isFuture ? ' tl-future' : '') + '">' + (i + 1) + '. ' + step + '</span>';
        if (records.length) {
          html += records.map(r =>
            '<div style="margin-top:4px;"><span class="tl-time">' + formatDate(r.at) + '</span>' +
            (r.note ? '<div class="tl-note">' + r.note + '</div>' : '') + '</div>'
          ).join("");
        } else if (isFuture) {
          html += '<div class="tl-note tl-future">待完成</div>';
        }
        html += '</div>';
      }
      html += '</div>';

      html += '<div style="margin-top:20px;padding:14px;background:var(--bg);border-radius:8px;">' +
        '<h4 style="margin:0 0 10px;font-size:14px;">更新步骤</h4>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
        '<select id="detailStepSelect" style="flex:1;">' + steps.map(s => '<option value="'+s+'"'+(s===c.status?' selected':'')+'>'+s+'</option>').join("") + '</select>' +
        '<input id="detailStepNote" placeholder="步骤备注" style="flex:1;">' +
        '<button id="detailStepSave">保存步骤</button>' +
        '</div></div>';

      el.innerHTML = html;

      document.getElementById("detailStepSave").onclick = async () => {
        const op = getOperator();
        if (!op.operator) return alert("请先在页面顶部选择当前操作者");
        const step = document.getElementById("detailStepSelect").value;
        const note = document.getElementById("detailStepNote").value || "步骤完成";
        try {
          await api("/api/commissions/" + currentDetailCommissionId + "/records", {
            method: "POST",
            body: JSON.stringify({ step, note, operator: op.operator, operatorId: op.operatorId })
          });
          await loadAll();
          const updated = commissions.find(x => x.id === currentDetailCommissionId);
          if (updated) renderDetailAll(updated);
        } catch (e) {
          alert("保存步骤失败：" + e.message);
        }
      };
    }

    function renderDetailImages(c) {
      const el = document.getElementById("detail-images");
      if (!el) return;
      const images = c.images || { before: [], during: [], after: [] };
      const stages = [
        { key: "before", label: "修复前" },
        { key: "during", label: "修复中" },
        { key: "after", label: "修复后" }
      ];
      let html = '<div class="detail-section-header"><h4>影像档案</h4><button class="small" data-detail-open-images="' + c.id + '">打开影像管理</button></div>';
      let totalImgs = 0;
      for (const stage of stages) {
        const imgs = images[stage.key] || [];
        totalImgs += imgs.length;
        html += '<div class="detail-img-stage-label">' + stage.label + '（' + imgs.length + '张）</div>';
        html += '<div style="position:relative;border:2px dashed var(--line);border-radius:6px;padding:12px;text-align:center;margin-bottom:8px;cursor:pointer;transition:all 0.2s;" data-detail-upload-stage="' + stage.key + '">';
        html += '<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple style="display:none;" data-detail-upload-input="' + stage.key + '">';
        html += '<span style="font-size:13px;color:var(--muted);">📷 点击上传' + stage.label + '图片</span></div>';
        if (imgs.length) {
          html += '<div class="detail-img-grid">';
          for (const img of imgs) {
            html += '<div class="detail-img-card" data-detail-view-img="' + img.filename + '">' +
              '<img src="' + img.filename + '" alt="' + img.originalName + '" loading="lazy">' +
              '<div class="caption">' + (img.caption || img.originalName) + '</div></div>';
          }
          html += '</div>';
        }
      }
      if (totalImgs === 0) {
        html = '<div class="detail-section-header"><h4>影像档案</h4><button class="small" data-detail-open-images="' + c.id + '">打开影像管理</button></div>' +
          '<div class="empty-state"><div class="icon">🖼️</div><div>暂无影像档案</div><div class="meta" style="margin-top:8px;">点击上方区域上传图片，或"打开影像管理"进行管理</div></div>';
      }
      el.innerHTML = html;
      el.querySelector("[data-detail-open-images]")?.addEventListener("click", function () {
        openImagesModal(this.dataset.detailOpenImages);
      });
      el.querySelectorAll("[data-detail-view-img]").forEach(card => {
        card.onclick = () => window.open(card.dataset.detailViewImg, "_blank");
      });
      el.querySelectorAll("[data-detail-upload-stage]").forEach(area => {
        const stage = area.dataset.detailUploadStage;
        const input = el.querySelector('[data-detail-upload-input="' + stage + '"]');
        area.onclick = () => input.click();
        area.ondragover = (e) => { e.preventDefault(); area.style.borderColor = "var(--accent)"; area.style.background = "var(--bg)"; };
        area.ondragleave = () => { area.style.borderColor = "var(--line)"; area.style.background = ""; };
        area.ondrop = (e) => {
          e.preventDefault();
          area.style.borderColor = "var(--line)"; area.style.background = "";
          if (e.dataTransfer?.files?.length) uploadDetailFiles(c.id, stage, e.dataTransfer.files);
        };
        if (input) {
          input.onchange = () => {
            if (input.files?.length) uploadDetailFiles(c.id, stage, input.files);
            input.value = "";
          };
        }
      });
    }

    async function uploadDetailFiles(commissionId, stage, files) {
      const validFiles = [];
      for (const file of files) {
        if (!allowedImageTypes.includes(file.type)) { alert('文件 "' + file.name + '" 格式不支持'); continue; }
        if (file.size > 10 * 1024 * 1024) { alert('文件 "' + file.name + '" 超过10MB'); continue; }
        validFiles.push(file);
      }
      if (!validFiles.length) return;
      for (const file of validFiles) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("stage", stage);
        try {
          const res = await fetch("/api/commissions/" + commissionId + "/images", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "上传失败");
        } catch (e) {
          alert('上传 "' + file.name + '" 失败：' + e.message);
        }
      }
      await loadAll();
      const updated = commissions.find(x => x.id === commissionId);
      if (updated) renderDetailAll(updated);
    }

    function renderDetailQuotes(c) {
      const el = document.getElementById("detail-quotes");
      if (!el) return;
      const quotes = c.quotes || [];
      const currentQuote = c.currentQuoteId ? quotes.find(q => q.id === c.currentQuoteId) : null;
      let html = '<div class="detail-section-header"><h4>报价</h4><button class="small" data-detail-open-quote="' + c.id + '">打开报价管理</button></div>';
      if (!currentQuote) {
        html += '<div class="empty-state"><div class="icon">💰</div><div>暂无报价</div><div class="meta" style="margin-top:8px;">点击"打开报价管理"创建报价</div></div>';
      } else {
        html += '<div class="detail-quote-summary">' +
          '<div class="detail-quote-row"><span>报价版本</span><span>第 ' + currentQuote.version + ' 版</span></div>' +
          '<div class="detail-quote-row"><span>状态</span><span class="pill ' + currentQuote.status + '">' + getStatusText(currentQuote.status) + '</span></div>';
        if (currentQuote.items && currentQuote.items.length) {
          html += '<div style="margin:8px 0;font-size:12px;color:var(--muted);">项目明细</div>';
          for (const item of currentQuote.items) {
            html += '<div class="detail-quote-row"><span>' + (item.description || '-') + ' ×' + (item.quantity || 0) + '</span><span>' + formatMoney(item.amount) + '</span></div>';
          }
        }
        html += '<div class="detail-quote-row"><span>项目小计</span><span>' + formatMoney(currentQuote.items ? currentQuote.items.reduce((s, i) => s + (i.amount || 0), 0) : 0) + '</span></div>' +
          '<div class="detail-quote-row"><span>人工费</span><span>' + formatMoney(currentQuote.laborCost || 0) + '</span></div>' +
          '<div class="detail-quote-row"><span>材料费</span><span>' + formatMoney(currentQuote.materialCost || 0) + '</span></div>' +
          '<div class="detail-quote-row total"><span>总计</span><strong>' + formatMoney(currentQuote.totalAmount || 0) + '</strong></div>';
        if (currentQuote.remark) {
          html += '<div style="margin-top:8px;font-size:12px;color:var(--muted);">备注：' + currentQuote.remark + '</div>';
        }
        html += '</div>';
        if (quotes.length > 1) {
          html += '<div style="margin-top:12px;"><div style="font-size:13px;font-weight:700;margin-bottom:8px;">历史版本</div>';
          const sorted = [...quotes].sort((a, b) => b.version - a.version);
          for (const q of sorted) {
            html += '<div style="display:flex;gap:8px;align-items:center;padding:6px 10px;background:var(--bg);border-radius:6px;margin-bottom:4px;font-size:12px;">' +
              '<span style="font-weight:600;">V' + q.version + '</span>' +
              '<span class="pill ' + q.status + '" style="font-size:11px;">' + getStatusText(q.status) + '</span>' +
              '<span style="color:var(--accent);font-weight:700;">' + formatMoney(q.totalAmount) + '</span>' +
              '<span style="color:var(--muted);">' + formatDate(q.createdAt) + '</span>' +
              '</div>';
          }
          html += '</div>';
        }
      }
      el.innerHTML = html;
      el.querySelector("[data-detail-open-quote]")?.addEventListener("click", function () {
        openQuoteModal(this.dataset.detailOpenQuote);
      });
    }

    function renderDetailAcceptance(c) {
      const el = document.getElementById("detail-acceptance");
      if (!el) return;
      const cSteps = c.steps || defaultSteps;
      const lastStep = cSteps[cSteps.length - 1];
      const isAtDeliveryStep = c.status === lastStep;
      let html = '<div class="detail-section-header"><h4>交付验收</h4>';
      if (isAtDeliveryStep || c.acceptance) {
        html += '<button class="small" data-detail-open-acceptance="' + c.id + '">打开验收管理</button>';
      }
      html += '</div>';
      if (c.acceptance) {
        const acc = c.acceptance;
        html += '<div class="detail-acceptance-box">' +
          '<div class="detail-acceptance-row"><span class="label">验收结果</span><span><strong>' + acc.result + '</strong></span></div>' +
          '<div class="detail-acceptance-row"><span class="label">交付日期</span><span>' + (acc.deliveryDate || '—') + '</span></div>' +
          '<div class="detail-acceptance-row"><span class="label">领取人</span><span>' + (acc.receiver || '—') + '</span></div>' +
          '<div class="detail-acceptance-row"><span class="label">遗留问题</span><span>' + (acc.remainingIssues || '—') + '</span></div>' +
          '<div class="detail-acceptance-row"><span class="label">保养建议</span><span>' + (acc.maintenanceAdvice || '—') + '</span></div>' +
          '<div class="detail-acceptance-row"><span class="label">验收时间</span><span>' + (acc.acceptedAt ? formatDate(acc.acceptedAt) : '—') + '</span></div>' +
          '</div>';
      } else if (isAtDeliveryStep) {
        html += '<div style="padding:14px;background:var(--bg);border-radius:8px;text-align:center;">' +
          '<div style="font-size:14px;margin-bottom:8px;">当前步骤已进入交付阶段，可进行验收</div>' +
          '<button class="small" data-detail-open-acceptance="' + c.id + '">✅ 前往验收</button></div>';
      } else {
        html += '<div class="empty-state"><div class="icon">✅</div><div>暂未验收</div><div class="meta" style="margin-top:8px;">进入交付步骤后可进行验收</div></div>';
      }
      el.innerHTML = html;
      el.querySelector("[data-detail-open-acceptance]")?.addEventListener("click", function () {
        openAcceptanceModal(this.dataset.detailOpenAcceptance);
      });
    }

    function renderDetailOpLogs(c) {
      const el = document.getElementById("detail-oplogs");
      if (!el) return;
      const logs = c.operationLogs || [];
      let html = '<div class="detail-section-header"><h4>操作历史</h4></div>';
      if (!logs.length) {
        html += '<div class="empty-state"><div class="icon">📜</div><div>暂无操作记录</div></div>';
      } else {
        html += '<table class="detail-oplog-table"><thead><tr><th>时间</th><th>操作者</th><th>操作</th></tr></thead><tbody>';
        const sortedLogs = [...logs].sort((a, b) => new Date(b.at) - new Date(a.at));
        for (const log of sortedLogs) {
          html += '<tr><td class="oplog-time-col">' + formatDate(log.at) + '</td><td class="oplog-op-col">' + (log.operator || '系统') + '</td><td>' + log.detail + '</td></tr>';
        }
        html += '</tbody></table>';
      }
      el.innerHTML = html;
    }

    function renderDetailVersions(c) {
      const el = document.getElementById("detail-versions");
      if (!el) return;
      const snapshots = c.fieldSnapshots || [];
      let html = '<div class="detail-section-header"><h4>版本追溯</h4><span class="meta">共 ' + snapshots.length + ' 个历史快照</span></div>';
      if (!snapshots.length) {
        html += '<div class="empty-state"><div class="icon">🕐</div><div>暂无版本记录</div><div class="meta" style="margin-top:8px;">编辑委托信息后将自动记录版本</div></div>';
      } else {
        html += '<div style="margin-bottom:14px;"><label style="display:block;margin:0 0 6px;font-size:12px;color:var(--muted);">按字段查看变更历史</label>' +
          '<select id="versionFieldSelect" style="padding:6px;border:1px solid var(--line);border-radius:6px;font-size:13px;">' +
          '<option value="">— 选择字段 —</option>';
        for (const key of snapshotTrackedFields) {
          html += '<option value="' + key + '">' + (detailFieldLabels[key] || key) + '</option>';
        }
        html += '<option value="materials">选用材料</option></select></div>';
        html += '<div id="versionFieldHistory" style="display:none;margin-bottom:14px;padding:12px;background:var(--bg);border-radius:8px;"></div>';
        html += '<div class="version-list">';
        const sorted = [...snapshots].sort((a, b) => new Date(b.at) - new Date(a.at));
        for (let si = 0; si < sorted.length; si++) {
          const snap = sorted[si];
          const prevSnap = si < sorted.length - 1 ? sorted[si + 1] : null;
          const isOldest = si === sorted.length - 1;
          html += '<div class="version-item' + (si === 0 ? ' active' : '') + '" data-version-idx="' + si + '">' +
            '<div class="version-item-header">' +
            '<span class="version-item-reason">' + (snap.reason || '数据快照') + '</span>' +
            '<span class="version-item-time">' + formatDate(snap.at) + '</span>' +
            '</div>' +
            '<span class="version-item-operator">' + (snap.operator || '系统') + '</span>' +
            '<div class="version-diff">';

          const fields = snap.fields || {};
          if (prevSnap) {
            const prevFields = prevSnap.fields || {};
            let hasChanges = false;
            for (const key of snapshotTrackedFields) {
              const label = detailFieldLabels[key] || key;
              const oldVal = prevFields[key] !== undefined ? String(prevFields[key]) : '';
              const newVal = fields[key] !== undefined ? String(fields[key]) : '';
              if (oldVal !== newVal) {
                hasChanges = true;
                html += '<div class="version-diff-row"><span class="field-name">' + label + '</span><span class="old-val">' + (oldVal || '—') + '</span><span class="new-val">' + (newVal || '—') + '</span></div>';
              }
            }
            if (fields.materials || prevFields.materials) {
              const oldMat = JSON.stringify(prevFields.materials || []);
              const newMat = JSON.stringify(fields.materials || []);
              if (oldMat !== newMat) {
                hasChanges = true;
                const oldMatDisplay = (prevFields.materials || []).map(m => m.name + '×' + m.quantity).join(', ') || '—';
                const newMatDisplay = (fields.materials || []).map(m => m.name + '×' + m.quantity).join(', ') || '—';
                html += '<div class="version-diff-row"><span class="field-name">材料</span><span class="old-val">' + oldMatDisplay + '</span><span class="new-val">' + newMatDisplay + '</span></div>';
              }
            }
            if (!hasChanges) {
              html += '<div style="color:var(--muted);font-size:12px;padding:4px 0;">无字段变更</div>';
            }
          } else {
            for (const key of snapshotTrackedFields) {
              const label = detailFieldLabels[key] || key;
              const val = fields[key] !== undefined ? String(fields[key]) : '—';
              html += '<div class="version-diff-row"><span class="field-name">' + label + '</span><span class="unchanged"></span><span class="new-val">' + val + '</span></div>';
            }
            if (fields.materials && fields.materials.length > 0) {
              const matDisplay = fields.materials.map(m => m.name + '×' + m.quantity).join(', ');
              html += '<div class="version-diff-row"><span class="field-name">材料</span><span class="unchanged"></span><span class="new-val">' + matDisplay + '</span></div>';
            }
          }
          html += '</div>';
          if (!isOldest) {
            html += '<div style="margin-top:8px;"><button class="small" data-restore-snapshot="' + snap.id + '" style="background:var(--orange);">🔄 恢复到此版本</button></div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      el.innerHTML = html;
      el.querySelectorAll(".version-item").forEach(item => {
        item.onclick = (e) => {
          if (e.target.closest("[data-restore-snapshot]")) return;
          el.querySelectorAll(".version-item").forEach(i => i.classList.remove("active"));
          item.classList.add("active");
        };
      });
      el.querySelectorAll("[data-restore-snapshot]").forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const snapId = btn.dataset.restoreSnapshot;
          if (!confirm("确定要恢复到此版本吗？当前字段值将被覆盖，恢复操作本身也会被记录。")) return;
          const op = getOperator();
          if (!op.operator) return alert("请先在页面顶部选择当前操作者");
          try {
            await api("/api/commissions/" + currentDetailCommissionId + "/field-snapshots/" + snapId + "/restore", {
              method: "POST",
              body: JSON.stringify({ operator: op.operator, operatorId: op.operatorId })
            });
            await loadAll();
            const updated = commissions.find(x => x.id === currentDetailCommissionId);
            if (updated) renderDetailAll(updated);
            alert("版本已恢复");
          } catch (e) {
            alert("恢复失败：" + e.message);
          }
        };
      });
      const fieldSelect = document.getElementById("versionFieldSelect");
      if (fieldSelect) {
        fieldSelect.onchange = () => {
          const fieldKey = fieldSelect.value;
          const histEl = document.getElementById("versionFieldHistory");
          if (!fieldKey || !histEl) { if (histEl) histEl.style.display = "none"; return; }
          const sorted = [...(c.fieldSnapshots || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
          if (!sorted.length) { histEl.style.display = "none"; return; }
          histEl.style.display = "block";
          let fieldHtml = '<div style="font-size:13px;font-weight:700;margin-bottom:8px;">' + (detailFieldLabels[fieldKey] || fieldKey) + ' 变更历史</div>';
          let prevVal = null;
          const changes = [];
          for (const snap of sorted) {
            const val = fieldKey === "materials"
              ? JSON.stringify((snap.fields?.materials || []))
              : (snap.fields?.[fieldKey] !== undefined ? String(snap.fields[fieldKey]) : "");
            if (prevVal !== null && prevVal !== val) {
              changes.push({ at: snap.at, operator: snap.operator || "系统", reason: snap.reason || "", oldVal: prevVal, newVal: val });
            }
            prevVal = val;
          }
          if (!changes.length) {
            fieldHtml += '<div style="color:var(--muted);font-size:12px;">该字段无历史变更</div>';
          } else {
            for (const ch of changes.reverse()) {
              const displayOld = fieldKey === "materials"
                ? JSON.parse(ch.oldVal || "[]").map(m => m.name + "×" + m.quantity).join(", ") || "无"
                : (ch.oldVal || "—");
              const displayNew = fieldKey === "materials"
                ? JSON.parse(ch.newVal || "[]").map(m => m.name + "×" + m.quantity).join(", ") || "无"
                : (ch.newVal || "—");
              fieldHtml += '<div style="padding:8px 0;border-bottom:1px solid var(--line);">' +
                '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);"><span>' + formatDate(ch.at) + '</span><span>' + ch.operator + '</span></div>' +
                '<div style="margin-top:4px;font-size:12px;">' +
                '<span style="color:#c0392b;text-decoration:line-through;">' + displayOld + '</span>' +
                ' → <span style="color:var(--green);">' + displayNew + '</span></div>' +
                (ch.reason ? '<div style="font-size:11px;color:var(--muted);margin-top:2px;">' + ch.reason + '</div>' : '') +
                '</div>';
            }
          }
          histEl.innerHTML = fieldHtml;
        };
      }
    }

    document.getElementById("detailModalClose").onclick = closeDetailModal;
    document.getElementById("detailModal").onclick = (e) => {
      if (e.target.id === "detailModal") closeDetailModal();
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.getElementById("detailModal").classList.contains("active")) {
        closeDetailModal();
      }
    });
    document.querySelectorAll(".detail-nav-btn").forEach(btn => {
      btn.onclick = () => switchDetailSection(btn.dataset.detailSection);
    });
  </script>
</body>
</html>`;

function requireOperator(input) {
  if (!input || !input.operator || !input.operator.trim()) {
    return { error: true, message: "操作者(operator)不能为空，请先选择当前操作者" };
  }
  return { error: false };
}

function addOperationLog(commission, type, operator, operatorId, detail) {
  if (!commission.operationLogs) commission.operationLogs = [];
  commission.operationLogs.push({
    id: `LOG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    operator: operator || "未知",
    operatorId: operatorId || "",
    detail: detail || "",
    at: new Date().toISOString()
  });
}

function analyzeImportClients(commissions, existingClients) {
  const clientMap = new Map();
  for (const c of commissions) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const key = (c.clientId || "").trim() || (c.client || "").trim();
    if (!key) continue;
    if (!clientMap.has(key)) {
      clientMap.set(key, {
        matchKey: key,
        id: c.clientId || "",
        name: c.client || "",
        contact: c.clientContact || "",
        phone: c.clientPhone || "",
        address: c.clientAddress || "",
        references: 0
      });
    }
    clientMap.get(key).references++;
  }

  const result = {
    total: clientMap.size,
    categories: { new: [], matched: [], conflict: [], unmatched: [] },
    items: []
  };

  let idx = 0;
  for (const [key, info] of clientMap) {
    const categories = [];
    const matchCandidates = [];

    if (info.id) {
      const byId = existingClients.find(cl => cl.id === info.id);
      if (byId) matchCandidates.push(byId);
    }
    if (info.name) {
      const byName = existingClients.find(cl => cl.name === info.name);
      if (byName && !matchCandidates.find(m => m.id === byName.id)) {
        matchCandidates.push(byName);
      }
    }

    let matchedExisting = null;
    let diff = [];

    if (matchCandidates.length === 0) {
      if (info.name) {
        categories.push("new");
        result.categories.new.push(idx);
      } else {
        categories.push("unmatched");
        result.categories.unmatched.push(idx);
      }
    } else if (matchCandidates.length === 1) {
      const m = matchCandidates[0];
      const hasConflict = (info.name && info.name !== m.name) ||
        (info.contact && info.contact !== m.contact) ||
        (info.phone && info.phone !== m.phone) ||
        (info.address && info.address !== m.address);
      if (hasConflict) {
        categories.push("conflict");
        result.categories.conflict.push(idx);
        diff = [];
        if (info.name && info.name !== m.name) diff.push({ field: "name", imported: info.name, expected: m.name });
        if (info.contact && info.contact !== m.contact) diff.push({ field: "contact", imported: info.contact, expected: m.contact });
        if (info.phone && info.phone !== m.phone) diff.push({ field: "phone", imported: info.phone, expected: m.phone });
        if (info.address && info.address !== m.address) diff.push({ field: "address", imported: info.address, expected: m.address });
        matchedExisting = { id: m.id, name: m.name, contact: m.contact, phone: m.phone, address: m.address };
      } else {
        categories.push("matched");
        result.categories.matched.push(idx);
        matchedExisting = { id: m.id, name: m.name, contact: m.contact, phone: m.phone, address: m.address };
      }
    } else {
      categories.push("conflict");
      result.categories.conflict.push(idx);
      matchedExisting = { id: matchCandidates[0].id, name: matchCandidates[0].name, contact: matchCandidates[0].contact, phone: matchCandidates[0].phone, address: matchCandidates[0].address };
    }

    const displayName = info.name || "未命名客户";
    result.items.push({
      matchKey: key,
      displayName,
      index: idx,
      imported: info,
      data: info,
      category: categories[0],
      categories,
      candidates: matchCandidates.map(m => ({ id: m.id, name: m.name, contact: m.contact, phone: m.phone, address: m.address })),
      matchCandidates: matchCandidates.map(m => ({ id: m.id, name: m.name, contact: m.contact, phone: m.phone, address: m.address })),
      matchedExisting,
      diff,
      selectedMatchId: matchCandidates.length === 1 ? matchCandidates[0].id : "",
      notes: info.references > 1 ? "被 " + info.references + " 个委托引用" : ""
    });
    idx++;
  }

  return result;
}

function analyzeImportMaterials(commissions, existingMaterials) {
  const materialMap = new Map();
  for (const c of commissions) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    if (!Array.isArray(c.materials)) continue;
    for (const m of c.materials) {
      if (!m || typeof m !== "object") continue;
      const key = (m.materialId || "").trim() || `${(m.name || "").trim()}||${(m.batch || "").trim()}`;
      if (!key || key === "||") continue;
      if (!materialMap.has(key)) {
        materialMap.set(key, {
          matchKey: key,
          materialId: m.materialId || "",
          name: m.name || "",
          batch: m.batch || "",
          category: m.category || "",
          unit: m.unit || "",
          stock: Number(m.quantity) || 0,
          quantity: 0,
          references: 0
        });
      }
      const entry = materialMap.get(key);
      entry.quantity += Number(m.quantity) || 0;
      entry.references++;
      if (!entry.category && m.category) entry.category = m.category;
      if (!entry.unit && m.unit) entry.unit = m.unit;
    }
  }

  const result = {
    total: materialMap.size,
    categories: { new: [], matched: [], conflict: [], unmatched: [] },
    items: []
  };

  let idx = 0;
  for (const [key, info] of materialMap) {
    const categories = [];
    const matchCandidates = [];

    if (info.materialId) {
      const byId = existingMaterials.find(m => m.id === info.materialId);
      if (byId) matchCandidates.push(byId);
    }
    if (info.name) {
      const byNameBatch = existingMaterials.find(m => m.name === info.name && m.batch === info.batch);
      if (byNameBatch && !matchCandidates.find(mm => mm.id === byNameBatch.id)) {
        matchCandidates.push(byNameBatch);
      }
      const byName = existingMaterials.filter(m => m.name === info.name);
      for (const bn of byName) {
        if (!matchCandidates.find(mm => mm.id === bn.id)) {
          matchCandidates.push(bn);
        }
      }
    }

    let matchedExisting = null;
    let diff = [];

    if (matchCandidates.length === 0) {
      if (info.name) {
        categories.push("new");
        result.categories.new.push(idx);
      } else {
        categories.push("unmatched");
        result.categories.unmatched.push(idx);
      }
    } else if (matchCandidates.length === 1) {
      const m = matchCandidates[0];
      const hasConflict = (info.name && info.name !== m.name) ||
        (info.batch && info.batch !== m.batch) ||
        (info.category && info.category !== m.category);
      if (hasConflict) {
        categories.push("conflict");
        result.categories.conflict.push(idx);
        diff = [];
        if (info.name && info.name !== m.name) diff.push({ field: "name", imported: info.name, expected: m.name });
        if (info.batch && info.batch !== m.batch) diff.push({ field: "batch", imported: info.batch, expected: m.batch });
        if (info.category && info.category !== m.category) diff.push({ field: "category", imported: info.category, expected: m.category });
        matchedExisting = { id: m.id, name: m.name, batch: m.batch, category: m.category, stock: m.stock, unit: m.unit };
      } else {
        categories.push("matched");
        result.categories.matched.push(idx);
        matchedExisting = { id: m.id, name: m.name, batch: m.batch, category: m.category, stock: m.stock, unit: m.unit };
      }
    } else {
      categories.push("conflict");
      result.categories.conflict.push(idx);
      matchedExisting = { id: matchCandidates[0].id, name: matchCandidates[0].name, batch: matchCandidates[0].batch, category: matchCandidates[0].category, stock: matchCandidates[0].stock, unit: matchCandidates[0].unit };
    }

    const displayName = info.name ? (info.name + (info.batch ? " (" + info.batch + ")" : "")) : "未命名材料";
    result.items.push({
      matchKey: key,
      displayName,
      index: idx,
      imported: info,
      data: info,
      category: categories[0],
      categories,
      candidates: matchCandidates.map(m => ({ id: m.id, name: m.name, batch: m.batch, category: m.category, stock: m.stock, unit: m.unit })),
      matchCandidates: matchCandidates.map(m => ({ id: m.id, name: m.name, batch: m.batch, category: m.category, stock: m.stock, unit: m.unit })),
      matchedExisting,
      diff,
      selectedMatchId: matchCandidates.length === 1 ? matchCandidates[0].id : "",
      notes: info.references > 1 ? "被 " + info.references + " 个委托引用" : ""
    });
    idx++;
  }

  return result;
}

function analyzeImportMembers(commissions, existingMembers) {
  const memberMap = new Map();
  for (const c of commissions) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const owner = (c.owner || "").trim();
    if (!owner) continue;
    if (!memberMap.has(owner)) {
      memberMap.set(owner, { matchKey: owner, name: owner, role: "", references: 0 });
    }
    memberMap.get(owner).references++;
  }

  const result = {
    total: memberMap.size,
    categories: { new: [], matched: [], conflict: [], unmatched: [] },
    items: []
  };

  let idx = 0;
  for (const [key, info] of memberMap) {
    const categories = [];
    const matchCandidates = existingMembers.filter(m => m.name === info.name);
    let matchedExisting = null;
    let diff = [];

    if (matchCandidates.length === 0) {
      categories.push("new");
      result.categories.new.push(idx);
    } else if (matchCandidates.length === 1) {
      categories.push("matched");
      result.categories.matched.push(idx);
      matchedExisting = { id: matchCandidates[0].id, name: matchCandidates[0].name, role: matchCandidates[0].role, phone: matchCandidates[0].phone };
    } else {
      categories.push("conflict");
      result.categories.conflict.push(idx);
      matchedExisting = { id: matchCandidates[0].id, name: matchCandidates[0].name, role: matchCandidates[0].role, phone: matchCandidates[0].phone };
    }

    const displayName = info.name || "未命名成员";
    result.items.push({
      matchKey: key,
      displayName,
      index: idx,
      imported: info,
      data: info,
      category: categories[0],
      categories,
      candidates: matchCandidates.map(m => ({ id: m.id, name: m.name, role: m.role, phone: m.phone })),
      matchCandidates: matchCandidates.map(m => ({ id: m.id, name: m.name, role: m.role, phone: m.phone })),
      matchedExisting,
      diff,
      selectedMatchId: matchCandidates.length === 1 ? matchCandidates[0].id : "",
      notes: info.references > 1 ? "被 " + info.references + " 个委托引用" : ""
    });
    idx++;
  }

  return result;
}

function analyzeImportTemplates(commissions, existingTemplates) {
  const templateMap = new Map();
  for (const c of commissions) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const tplId = (c.templateId || "").trim();
    const tplName = (c.templateName || "").trim();
    const steps = Array.isArray(c.steps) ? c.steps : [];
    const key = tplId || tplName || (steps.length ? steps.join("|") : "");
    if (!key) continue;
    if (!templateMap.has(key)) {
      templateMap.set(key, {
        matchKey: key,
        templateId: tplId,
        name: tplName,
        steps: [...steps],
        references: 0
      });
    }
    templateMap.get(key).references++;
  }

  const result = {
    total: templateMap.size,
    categories: { new: [], matched: [], conflict: [], unmatched: [] },
    items: []
  };

  let idx = 0;
  for (const [key, info] of templateMap) {
    const categories = [];
    const matchCandidates = [];

    if (info.templateId) {
      const byId = existingTemplates.find(t => t.id === info.templateId);
      if (byId) matchCandidates.push(byId);
    }
    if (info.name) {
      const byName = existingTemplates.find(t => t.name === info.name);
      if (byName && !matchCandidates.find(m => m.id === byName.id)) {
        matchCandidates.push(byName);
      }
    }
    if (info.steps.length > 0) {
      for (const t of existingTemplates) {
        if (matchCandidates.find(m => m.id === t.id)) continue;
        if (t.steps.length === info.steps.length && t.steps.every((s, i) => s === info.steps[i])) {
          matchCandidates.push(t);
        }
      }
    }

    let matchedExisting = null;
    let diff = [];

    if (matchCandidates.length === 0) {
      if (info.name || info.steps.length > 0) {
        categories.push("new");
        result.categories.new.push(idx);
      } else {
        categories.push("unmatched");
        result.categories.unmatched.push(idx);
      }
    } else if (matchCandidates.length === 1) {
      const t = matchCandidates[0];
      const hasConflict = (info.name && info.name !== t.name) ||
        (info.steps.length > 0 && (t.steps.length !== info.steps.length || !t.steps.every((s, i) => s === info.steps[i])));
      if (hasConflict) {
        categories.push("conflict");
        result.categories.conflict.push(idx);
        diff = [];
        if (info.name && info.name !== t.name) diff.push({ field: "name", imported: info.name, expected: t.name });
        if (info.steps.length > 0 && (t.steps.length !== info.steps.length || !t.steps.every((s, i) => s === info.steps[i]))) {
          diff.push({ field: "steps", imported: info.steps.join("→"), expected: t.steps.join("→") });
        }
        matchedExisting = { id: t.id, name: t.name, description: t.description, steps: t.steps };
      } else {
        categories.push("matched");
        result.categories.matched.push(idx);
        matchedExisting = { id: t.id, name: t.name, description: t.description, steps: t.steps };
      }
    } else {
      categories.push("conflict");
      result.categories.conflict.push(idx);
      matchedExisting = { id: matchCandidates[0].id, name: matchCandidates[0].name, description: matchCandidates[0].description, steps: matchCandidates[0].steps };
    }

    const displayName = info.name || (info.steps.length ? "步骤：" + info.steps.join("→") : "未命名模板");
    result.items.push({
      matchKey: key,
      displayName,
      index: idx,
      imported: info,
      data: info,
      category: categories[0],
      categories,
      candidates: matchCandidates.map(t => ({ id: t.id, name: t.name, description: t.description, steps: t.steps })),
      matchCandidates: matchCandidates.map(t => ({ id: t.id, name: t.name, description: t.description, steps: t.steps })),
      matchedExisting,
      diff,
      selectedMatchId: matchCandidates.length === 1 ? matchCandidates[0].id : "",
      notes: info.references > 1 ? "被 " + info.references + " 个委托引用" : ""
    });
    idx++;
  }

  return result;
}

const detailFieldLabels = {
  roleName: "角色名称", era: "年代", damage: "破损部位", missingParts: "缺失零件",
  colorNotes: "补色记录", reinforcement: "加固材料", owner: "负责人", dueDate: "截止日期",
  status: "当前步骤", client: "客户"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/clients") {
      const clientsWithCount = db.clients.map(c => {
        const sortedFollowUps = [...(c.followUps || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
        const lastFollowUp = sortedFollowUps.length > 0 ? sortedFollowUps[0] : null;
        return {
          ...c,
          commissionCount: db.commissions.filter(com => com.clientId === c.id).length,
          lastFollowUp: lastFollowUp ? {
            date: lastFollowUp.date,
            operator: lastFollowUp.operator,
            content: lastFollowUp.content,
            nextFollowDate: lastFollowUp.nextFollowDate || ""
          } : null
        };
      });
      return sendJson(res, 200, clientsWithCount);
    }
    const clientMatch = url.pathname.match(/^\/api\/clients\/([^/]+)$/);
    if (clientMatch && req.method === "GET") {
      const client = db.clients.find(c => c.id === clientMatch[1]);
      if (!client) return sendJson(res, 404, { error: "client_not_found" });
      const relatedCommissions = db.commissions.filter(c => c.clientId === client.id);
      const sortedFollowUps = [...(client.followUps || [])].sort((a, b) => new Date(b.date) - new Date(a.date));
      const lastFollowUp = sortedFollowUps.length > 0 ? sortedFollowUps[0] : null;
      return sendJson(res, 200, { 
        ...client, 
        commissionCount: relatedCommissions.length, 
        commissions: relatedCommissions,
        followUps: sortedFollowUps,
        lastFollowUp: lastFollowUp ? {
          date: lastFollowUp.date,
          operator: lastFollowUp.operator,
          content: lastFollowUp.content,
          nextFollowDate: lastFollowUp.nextFollowDate || ""
        } : null
      });
    }
    const followUpMatch = url.pathname.match(/^\/api\/clients\/([^/]+)\/followups$/);
    if (followUpMatch && req.method === "POST") {
      const client = db.clients.find(c => c.id === followUpMatch[1]);
      if (!client) return sendJson(res, 404, { error: "client_not_found" });
      const input = await body(req);
      if (!input.date || !input.content) {
        return sendJson(res, 400, { error: "missing_fields", message: "回访时间和沟通内容为必填项" });
      }
      const followUp = {
        id: `FU-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        date: input.date,
        operator: input.operator || "",
        content: input.content,
        nextFollowDate: input.nextFollowDate || "",
        createdAt: new Date().toISOString()
      };
      if (!Array.isArray(client.followUps)) {
        client.followUps = [];
      }
      client.followUps.unshift(followUp);
      await saveDb(db);
      return sendJson(res, 201, followUp);
    }
    if (req.method === "POST" && url.pathname === "/api/clients") {
      const input = await body(req);
      const client = { id: `CL-${Date.now()}`, name: input.name, contact: input.contact || "", phone: input.phone || "", address: input.address || "", remark: input.remark || "", followUps: [] };
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

    const commissionDetailMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)$/);
    if (commissionDetailMatch && req.method === "GET") {
      const commission = db.commissions.find(c => c.id === commissionDetailMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const client = db.clients.find(cl => cl.id === commission.clientId);
      return sendJson(res, 200, { ...commission, clientInfo: client || null });
    }

    if (commissionDetailMatch && req.method === "PUT") {
      const commission = db.commissions.find(c => c.id === commissionDetailMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const input = await body(req);
      const opCheck = requireOperator(input);
      if (opCheck.error) return sendJson(res, 400, { error: "operator_required", message: opCheck.message });

      if (!commission.fieldSnapshots) commission.fieldSnapshots = [];
      const before = {};
      for (const field of snapshotTrackedFields) {
        before[field] = commission[field] !== undefined ? commission[field] : "";
      }
      before.materials = Array.isArray(commission.materials) ? JSON.parse(JSON.stringify(commission.materials)) : [];

      const changedFields = [];
      if (input.roleName !== undefined && input.roleName !== commission.roleName) { commission.roleName = input.roleName; changedFields.push("角色名称"); }
      if (input.era !== undefined && input.era !== commission.era) { commission.era = input.era; changedFields.push("年代"); }
      if (input.damage !== undefined && input.damage !== commission.damage) { commission.damage = input.damage; changedFields.push("破损部位"); }
      if (input.missingParts !== undefined && input.missingParts !== commission.missingParts) { commission.missingParts = input.missingParts; changedFields.push("缺失零件"); }
      if (input.colorNotes !== undefined && input.colorNotes !== commission.colorNotes) { commission.colorNotes = input.colorNotes; changedFields.push("补色记录"); }
      if (input.reinforcement !== undefined && input.reinforcement !== commission.reinforcement) { commission.reinforcement = input.reinforcement; changedFields.push("加固材料"); }
      if (input.owner !== undefined && input.owner !== commission.owner) { commission.owner = input.owner; changedFields.push("负责人"); }
      if (input.dueDate !== undefined && input.dueDate !== commission.dueDate) { commission.dueDate = input.dueDate; changedFields.push("截止日期"); }
      if (input.client !== undefined && input.client !== commission.client) { commission.client = input.client; changedFields.push("客户"); }
      let materialsChanged = false;
      if (Array.isArray(input.materials)) {
        const normalizedMats = input.materials.map(m => ({
          materialId: m.materialId || m.id || "",
          name: m.name || "",
          batch: m.batch || "",
          quantity: Number(m.quantity) || 0,
          reservedQty: Number(m.reservedQty) || 0,
          consumedQty: Number(m.consumedQty) || 0,
          consumedAt: m.consumedAt || "",
          consumedBy: m.consumedBy || "",
          consumedStep: m.consumedStep || ""
        }));
        const oldJson = JSON.stringify(before.materials);
        const newJson = JSON.stringify(normalizedMats);
        if (oldJson !== newJson) {
          commission.materials = normalizedMats;
          materialsChanged = true;
          changedFields.push("材料");
        }
      }

      if (materialsChanged) {
        try {
          adjustCommissionMaterials(db, commission, before.materials, input.operator, input.operatorId);
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
      }

      if (changedFields.length > 0) {
        const snapshot = createFieldSnapshot(commission, input.operator, input.operatorId, "编辑：" + changedFields.join("、"));
        commission.fieldSnapshots.push(snapshot);
        addOperationLog(commission, "field_update", input.operator, input.operatorId, "更新字段：" + changedFields.join("、"));
      }

      await saveDb(db);
      return sendJson(res, 200, commission);
    }

    const snapshotsMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/field-snapshots$/);
    if (snapshotsMatch && req.method === "GET") {
      const commission = db.commissions.find(c => c.id === snapshotsMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      return sendJson(res, 200, commission.fieldSnapshots || []);
    }

    const snapshotRestoreMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/field-snapshots\/([^/]+)\/restore$/);
    if (snapshotRestoreMatch && req.method === "POST") {
      const commission = db.commissions.find(c => c.id === snapshotRestoreMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const snapshot = (commission.fieldSnapshots || []).find(s => s.id === snapshotRestoreMatch[2]);
      if (!snapshot) return sendJson(res, 404, { error: "snapshot_not_found" });
      const input = await body(req);
      const opCheck = requireOperator(input);
      if (opCheck.error) return sendJson(res, 400, { error: "operator_required", message: opCheck.message });

      const before = {};
      for (const field of snapshotTrackedFields) {
        before[field] = commission[field] !== undefined ? commission[field] : "";
      }
      before.materials = Array.isArray(commission.materials) ? JSON.parse(JSON.stringify(commission.materials)) : [];

      const fields = snapshot.fields || {};
      const restoredFields = [];
      let materialsChanged = false;
      let restoredMaterials = null;
      for (const field of snapshotTrackedFields) {
        if (fields[field] !== undefined && commission[field] !== fields[field]) {
          commission[field] = fields[field];
          restoredFields.push(detailFieldLabels[field] || field);
        }
      }
      if (Array.isArray(fields.materials)) {
        restoredMaterials = JSON.parse(JSON.stringify(fields.materials));
        const oldJson = JSON.stringify(before.materials);
        const newJson = JSON.stringify(restoredMaterials);
        if (oldJson !== newJson) {
          materialsChanged = true;
          restoredFields.push("材料");
        }
      }

      if (materialsChanged && restoredMaterials) {
        commission.materials = restoredMaterials;
        try {
          adjustCommissionMaterials(db, commission, before.materials, input.operator, input.operatorId);
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
      }

      if (restoredFields.length > 0) {
        const newSnapshot = createFieldSnapshot(commission, input.operator, input.operatorId, "恢复版本：" + (snapshot.reason || "历史快照"));
        commission.fieldSnapshots.push(newSnapshot);
        addOperationLog(commission, "version_restore", input.operator, input.operatorId, "恢复版本（" + (snapshot.reason || "历史快照") + "），恢复字段：" + restoredFields.join("、"));
      }

      await saveDb(db);
      return sendJson(res, 200, commission);
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

      const commissions = {
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
          commissions.categories.invalidSteps.push(i);
        } else if (!hasBlockingIssues) {
          const hasDuplicate = issues.some(issue => issue.type === "duplicate");
          if (hasDuplicate) {
            categories.push("duplicate");
            commissions.categories.duplicate.push(i);
          } else {
            categories.push("new");
            commissions.categories.new.push(i);
          }
        } else {
          for (const issue of issues) {
            if (issue.type === "duplicate") {
              if (!categories.includes("duplicate")) {
                categories.push("duplicate");
                commissions.categories.duplicate.push(i);
              }
            }
            if (issue.type === "missingFields") {
              if (!categories.includes("missingFields")) {
                categories.push("missingFields");
                commissions.categories.missingFields.push(i);
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
                commissions.categories.invalidSteps.push(i);
              }
            }
          }
        }

        if (categories.length === 0) {
          categories.push("valid");
          commissions.categories.valid.push(i);
        }

        const safeData = hasNotAnObject ? { _raw: String(item) } : item;
        commissions.items.push({
          index: i,
          data: safeData,
          categories,
          issues
        });
      }

      commissions.categories.new = [...new Set(commissions.categories.new)];
      commissions.categories.duplicate = [...new Set(commissions.categories.duplicate)];
      commissions.categories.missingFields = [...new Set(commissions.categories.missingFields)];
      commissions.categories.invalidSteps = [...new Set(commissions.categories.invalidSteps)];

      const preview = {
        commissions,
        clients: analyzeImportClients(importedData, db.clients),
        materials: analyzeImportMaterials(importedData, db.materials),
        members: analyzeImportMembers(importedData, db.members),
        templates: analyzeImportTemplates(importedData, db.stepTemplates),
        existing: {
          clients: db.clients.map(c => ({ id: c.id, name: c.name, contact: c.contact, phone: c.phone, address: c.address })),
          materials: db.materials.map(m => ({ id: m.id, name: m.name, batch: m.batch, category: m.category, stock: m.stock, unit: m.unit })),
          members: db.members.map(m => ({ id: m.id, name: m.name, role: m.role })),
          templates: db.stepTemplates.map(t => ({ id: t.id, name: t.name, description: t.description, steps: t.steps }))
        }
      };

      return sendJson(res, 200, preview);
    }

    if (req.method === "POST" && url.pathname === "/api/commissions/import") {
      const input = await body(req);
      const itemsToImport = Array.isArray(input) ? input : (input.items || []);
      const clientMatches = input.clientMatches || {};
      const materialMatches = input.materialMatches || {};
      const memberMatches = input.memberMatches || {};
      const templateMatches = input.templateMatches || {};
      
      if (!Array.isArray(itemsToImport) || itemsToImport.length === 0) {
        return sendJson(res, 400, { error: "没有可导入的数据" });
      }

      const allSteps = new Set();
      db.stepTemplates.forEach(t => t.steps.forEach(s => allSteps.add(s)));
      defaultSteps.forEach(s => allSteps.add(s));

      const dbCopy = deepClone(db);
      const summary = {
        commissions: { created: 0, updated: 0, skipped: 0, items: [] },
        clients: { created: 0, reused: 0, items: [] },
        materials: { created: 0, reused: 0, items: [] },
        members: { created: 0, reused: 0, items: [] },
        templates: { created: 0, reused: 0, items: [] }
      };
      const newClientIdMap = {};
      const newMaterialIdMap = {};
      const newMemberIdMap = {};
      const newTemplateIdMap = {};
      const processedIds = new Set();
      const createdClientKeys = new Set();
      const createdMaterialKeys = new Set();
      const createdMemberKeys = new Set();
      const createdTemplateKeys = new Set();

      function resolveClient(c) {
        const rawId = c.clientId || "";
        const rawName = c.client || "";
        const matchKey = rawId || rawName;
        if (!matchKey) return { id: "", name: "" };

        if (newClientIdMap[matchKey]) {
          const nc = dbCopy.clients.find(cl => cl.id === newClientIdMap[matchKey]);
          return { id: nc.id, name: nc.name };
        }

        const matchedId = clientMatches[matchKey];
        if (matchedId && matchedId !== "__new__") {
          const existing = dbCopy.clients.find(cl => cl.id === matchedId);
          if (existing) return { id: existing.id, name: existing.name };
        }

        if (rawId) {
          const byId = dbCopy.clients.find(cl => cl.id === rawId);
          if (byId) {
            summary.clients.reused++;
            summary.clients.items.push({ id: byId.id, name: byId.name, action: "reused" });
            return { id: byId.id, name: byId.name };
          }
        }
        if (rawName) {
          const byName = dbCopy.clients.find(cl => cl.name === rawName);
          if (byName) {
            summary.clients.reused++;
            summary.clients.items.push({ id: byName.id, name: byName.name, action: "reused" });
            return { id: byName.id, name: byName.name };
          }
        }

        if (!createdClientKeys.has(matchKey)) {
          const newClient = {
            id: `CL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: rawName,
            contact: c.clientContact || "",
            phone: c.clientPhone || "",
            address: c.clientAddress || "",
            remark: "",
            followUps: []
          };
          dbCopy.clients.unshift(newClient);
          newClientIdMap[matchKey] = newClient.id;
          createdClientKeys.add(matchKey);
          summary.clients.created++;
          summary.clients.items.push({ id: newClient.id, name: newClient.name, action: "created" });
        }
        const nc = dbCopy.clients.find(cl => cl.id === newClientIdMap[matchKey]);
        return { id: nc.id, name: nc.name };
      }

      function resolveMember(ownerName) {
        if (!ownerName || !ownerName.trim()) return "";
        const name = ownerName.trim();

        if (newMemberIdMap[name]) return newMemberIdMap[name];

        const matchedId = memberMatches[name];
        if (matchedId && matchedId !== "__new__") {
          const existing = dbCopy.members.find(m => m.id === matchedId);
          if (existing) {
            summary.members.reused++;
            summary.members.items.push({ id: existing.id, name: existing.name, action: "reused" });
            return existing.id;
          }
        }

        const byName = dbCopy.members.find(m => m.name === name);
        if (byName) {
          summary.members.reused++;
          summary.members.items.push({ id: byName.id, name: byName.name, action: "reused" });
          newMemberIdMap[name] = byName.id;
          return byName.id;
        }

        if (!createdMemberKeys.has(name)) {
          const newMember = {
            id: `MB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: name,
            role: "修复师",
            phone: "",
            remark: "导入时自动创建"
          };
          dbCopy.members.unshift(newMember);
          newMemberIdMap[name] = newMember.id;
          createdMemberKeys.add(name);
          summary.members.created++;
          summary.members.items.push({ id: newMember.id, name: newMember.name, action: "created" });
        }
        return newMemberIdMap[name];
      }

      function resolveTemplate(c) {
        const tplId = c.templateId || "";
        const tplName = c.templateName || "";
        const steps = Array.isArray(c.steps) ? c.steps : [];
        const matchKey = tplId || tplName || (steps.length ? steps.join("|") : "");
        if (!matchKey) return { id: "", name: "" };

        if (newTemplateIdMap[matchKey]) {
          const nt = dbCopy.stepTemplates.find(t => t.id === newTemplateIdMap[matchKey]);
          return { id: nt.id, name: nt.name };
        }

        const matchedId = templateMatches[matchKey];
        if (matchedId && matchedId !== "__new__") {
          const existing = dbCopy.stepTemplates.find(t => t.id === matchedId);
          if (existing) {
            summary.templates.reused++;
            summary.templates.items.push({ id: existing.id, name: existing.name, action: "reused" });
            return { id: existing.id, name: existing.name };
          }
        }

        if (tplId) {
          const byId = dbCopy.stepTemplates.find(t => t.id === tplId);
          if (byId) {
            summary.templates.reused++;
            summary.templates.items.push({ id: byId.id, name: byId.name, action: "reused" });
            return { id: byId.id, name: byId.name };
          }
        }
        if (tplName) {
          const byName = dbCopy.stepTemplates.find(t => t.name === tplName);
          if (byName) {
            summary.templates.reused++;
            summary.templates.items.push({ id: byName.id, name: byName.name, action: "reused" });
            return { id: byName.id, name: byName.name };
          }
        }
        if (steps.length > 0) {
          const bySteps = dbCopy.stepTemplates.find(t =>
            t.steps.length === steps.length && t.steps.every((s, i) => s === steps[i]));
          if (bySteps) {
            summary.templates.reused++;
            summary.templates.items.push({ id: bySteps.id, name: bySteps.name, action: "reused" });
            return { id: bySteps.id, name: bySteps.name };
          }
        }

        if (!createdTemplateKeys.has(matchKey) && (tplName || steps.length > 0)) {
          const newTpl = {
            id: `TPL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: tplName || "导入模板-" + (steps[0] || "自定义"),
            description: "导入时自动创建",
            steps: steps.length > 0 ? [...steps] : [...defaultSteps]
          };
          dbCopy.stepTemplates.unshift(newTpl);
          newTemplateIdMap[matchKey] = newTpl.id;
          createdTemplateKeys.add(matchKey);
          summary.templates.created++;
          summary.templates.items.push({ id: newTpl.id, name: newTpl.name, action: "created" });
        }
        if (newTemplateIdMap[matchKey]) {
          const nt = dbCopy.stepTemplates.find(t => t.id === newTemplateIdMap[matchKey]);
          return { id: nt.id, name: nt.name };
        }
        return { id: "", name: "" };
      }

      function resolveMaterial(m) {
        const rawId = m.materialId || "";
        const rawName = m.name || "";
        const rawBatch = m.batch || "";
        const matchKey = rawId || `${rawName}||${rawBatch}`;
        if (!matchKey || matchKey === "||") return null;

        if (newMaterialIdMap[matchKey]) {
          const nm = dbCopy.materials.find(mat => mat.id === newMaterialIdMap[matchKey]);
          return nm;
        }

        const matchedId = materialMatches[matchKey];
        if (matchedId && matchedId !== "__new__") {
          const existing = dbCopy.materials.find(mat => mat.id === matchedId);
          if (existing) {
            summary.materials.reused++;
            summary.materials.items.push({ id: existing.id, name: existing.name, batch: existing.batch, action: "reused" });
            return existing;
          }
        }

        if (rawId) {
          const byId = dbCopy.materials.find(mat => mat.id === rawId);
          if (byId) {
            summary.materials.reused++;
            summary.materials.items.push({ id: byId.id, name: byId.name, batch: byId.batch, action: "reused" });
            return byId;
          }
        }
        if (rawName && rawBatch) {
          const byNameBatch = dbCopy.materials.find(mat => mat.name === rawName && mat.batch === rawBatch);
          if (byNameBatch) {
            summary.materials.reused++;
            summary.materials.items.push({ id: byNameBatch.id, name: byNameBatch.name, batch: byNameBatch.batch, action: "reused" });
            return byNameBatch;
          }
        }
        if (rawName) {
          const byName = dbCopy.materials.find(mat => mat.name === rawName);
          if (byName) {
            summary.materials.reused++;
            summary.materials.items.push({ id: byName.id, name: byName.name, batch: byName.batch, action: "reused" });
            return byName;
          }
        }

        if (!createdMaterialKeys.has(matchKey) && rawName) {
          const newMat = {
            id: `MAT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: rawName,
            category: m.category || "其他",
            batch: rawBatch || `BATCH-${Date.now()}`,
            stock: 0,
            unit: m.unit || "个",
            remark: "导入时自动创建",
            minStock: 0,
            reserved: 0
          };
          dbCopy.materials.unshift(newMat);
          newMaterialIdMap[matchKey] = newMat.id;
          createdMaterialKeys.add(matchKey);
          summary.materials.created++;
          summary.materials.items.push({ id: newMat.id, name: newMat.name, batch: newMat.batch, action: "created" });
        }
        if (newMaterialIdMap[matchKey]) {
          return dbCopy.materials.find(mat => mat.id === newMaterialIdMap[matchKey]);
        }
        return null;
      }

      try {
        for (const item of itemsToImport) {
          if (!item.data) {
            summary.commissions.skipped++;
            continue;
          }

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
            summary.commissions.skipped++;
            summary.commissions.items.push({ name: item.data.roleName || "未命名", action: "skipped", reason: "数据验证失败" });
            continue;
          }

          const isDuplicate = issues.some(issue => issue.type === "duplicate");
          if (isDuplicate && !item.forceOverwrite) {
            summary.commissions.skipped++;
            summary.commissions.items.push({ name: item.data.roleName || "未命名", action: "skipped", reason: "重复且未选择覆盖" });
            continue;
          }

          const c = item.data;
          const { id: clientId, name: clientName } = resolveClient(c);
          const ownerId = resolveMember(c.owner);
          const tpl = resolveTemplate(c);
          let templateId = tpl.id;
          let templateName = tpl.name;

          let commissionSteps = c.steps && Array.isArray(c.steps) && c.steps.length ? [...c.steps] : [...defaultSteps];
          if (!templateId && commissionSteps.length > 0) {
            const autoTpl = resolveTemplate({ steps: commissionSteps });
            templateId = autoTpl.id;
            templateName = autoTpl.name;
          }
          const firstStep = commissionSteps[0];
          const currentStatus = c.status && commissionSteps.includes(c.status) ? c.status : firstStep;
          const consumeStepName = c.consumeStepName || DEFAULT_CONSUME_STEP_NAME;

          const selectedMaterials = [];
          if (Array.isArray(c.materials)) {
            for (const m of c.materials) {
              const resolved = resolveMaterial(m);
              const qty = Number(m.quantity) || 0;
              if (qty <= 0) continue;
              const entry = {
                materialId: resolved ? resolved.id : (m.materialId || ""),
                name: resolved ? resolved.name : (m.name || ""),
                batch: resolved ? resolved.batch : (m.batch || ""),
                quantity: qty,
                reservedQty: Number(m.reservedQty) || 0,
                consumedQty: Number(m.consumedQty) || 0,
                consumedAt: m.consumedAt || "",
                consumedBy: m.consumedBy || "",
                consumedStep: m.consumedStep || ""
              };
              selectedMaterials.push(entry);
            }
          }

          let newId;
          const importOp = item.operator || "导入系统";
          const importOpId = item.operatorId || "";

          if (isDuplicate && item.forceOverwrite) {
            const dupIssue = issues.find(issue => issue.type === "duplicate");
            newId = dupIssue.existingId;
            const existingIdx = dbCopy.commissions.findIndex(com => com.id === newId);
            if (existingIdx !== -1) {
              processedIds.add(newId);
              const existing = dbCopy.commissions[existingIdx];
              const oldMaterials = Array.isArray(existing.materials) ? JSON.parse(JSON.stringify(existing.materials)) : [];
              releaseCommissionMaterials(dbCopy, existing, importOp, importOpId, "导入覆盖-释放原占用");
              const finalMaterials = selectedMaterials.length > 0 ? selectedMaterials : oldMaterials;
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
                materials: finalMaterials,
                consumeStepName: consumeStepName || existing.consumeStepName || DEFAULT_CONSUME_STEP_NAME,
                owner: c.owner || existing.owner,
                dueDate: c.dueDate || existing.dueDate,
                status: currentStatus,
                steps: commissionSteps,
                templateId: templateId || existing.templateId,
                templateName: templateName || existing.templateName,
                records: c.records && Array.isArray(c.records) ? c.records : existing.records,
                images: c.images || existing.images
              };
              try {
                reserveCommissionMaterials(dbCopy, commission, importOp, importOpId);
              } catch (e) {
                throw new Error(`委托【${commission.roleName}】导入失败：${e.message}`);
              }
              dbCopy.commissions[existingIdx] = commission;
              summary.commissions.updated++;
              summary.commissions.items.push({ id: commission.id, name: commission.roleName, action: "updated" });
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
            consumeStepName,
            owner: c.owner,
            dueDate: c.dueDate,
            status: currentStatus,
            steps: commissionSteps,
            templateId: templateId || "",
            templateName: templateName || "",
            records,
            images: c.images || { before: [], during: [], after: [] },
            quotes: [],
            currentQuoteId: "",
            acceptance: null,
            operationLogs: [],
            fieldSnapshots: []
          };

          try {
            reserveCommissionMaterials(dbCopy, commission, importOp, importOpId);
          } catch (e) {
            throw new Error(`委托【${commission.roleName}】导入失败：${e.message}`);
          }

          commission.fieldSnapshots.push(createFieldSnapshot(commission, importOp, importOpId, "导入委托"));
          addOperationLog(commission, "import", importOp, importOpId, "批量导入创建委托");
          dbCopy.commissions.unshift(commission);
          summary.commissions.created++;
          summary.commissions.items.push({ id: commission.id, name: commission.roleName, action: "created" });
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
          summary,
          totalImported: summary.commissions.created + summary.commissions.updated,
          totalProcessed: itemsToImport.length
        });
      } catch (error) {
        return sendJson(res, 500, { error: "导入失败，所有数据未被修改：" + error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/commissions") {
      const input = await body(req);
      const opCheck = requireOperator(input);
      if (opCheck.error) return sendJson(res, 400, { error: "operator_required", message: opCheck.message });
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
      const consumeStepName = input.consumeStepName || DEFAULT_CONSUME_STEP_NAME;
      const selectedMaterials = [];
      if (Array.isArray(input.materials)) {
        for (const m of input.materials) {
          const mat = db.materials.find(item => item.id === m.id);
          if (mat && m.quantity > 0) {
            const available = getMaterialAvailable(mat);
            if (available < m.quantity) {
              const reserved = Number(mat.reserved) || 0;
              return sendJson(res, 400, { error: `材料 ${mat.name} 可用量不足，可用 ${available}${mat.unit}（总库存 ${mat.stock}${mat.unit}，已占用 ${reserved}${mat.unit}）` });
            }
            selectedMaterials.push({ materialId: mat.id, name: mat.name, batch: mat.batch, quantity: m.quantity, reservedQty: 0, consumedQty: 0, consumedAt: "", consumedBy: "", consumedStep: "" });
          }
        }
      }
      const commission = { id: `SP-${Date.now()}`, clientId, client: clientName, roleName: input.roleName, era: input.era, damage: input.damage, missingParts: input.missingParts || "", colorNotes: input.colorNotes || "", reinforcement: input.reinforcement || "", materials: selectedMaterials, consumeStepName, owner: input.owner, dueDate: input.dueDate, status: firstStep, steps: commissionSteps, templateId: input.templateId || "", templateName: input.templateId ? (db.stepTemplates.find(t => t.id === input.templateId)?.name || "") : "", records: [{ at: new Date().toISOString(), step: firstStep, note: "登记委托" }], images: { before: [], during: [], after: [] }, quotes: [], currentQuoteId: "", fieldSnapshots: [], operationLogs: [] };
      try {
        reserveCommissionMaterials(db, commission, input.operator, input.operatorId);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      commission.fieldSnapshots.push(createFieldSnapshot(commission, input.operator, input.operatorId, "创建委托"));
      addOperationLog(commission, "create", input.operator, input.operatorId, "创建委托");
      db.commissions.unshift(commission);
      await saveDb(db);
      return sendJson(res, 201, commission);
    }
    const match = url.pathname.match(/^\/api\/commissions\/([^/]+)\/records$/);
    if (match && req.method === "POST") {
      const commission = db.commissions.find(item => item.id === match[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const input = await body(req);
      const opCheck = requireOperator(input);
      if (opCheck.error) return sendJson(res, 400, { error: "operator_required", message: opCheck.message });
      if (!commission.fieldSnapshots) commission.fieldSnapshots = [];
      const oldStatus = commission.status;
      const newStatus = input.step;
      const steps = commission.steps && commission.steps.length ? commission.steps : defaultSteps;
      const oldIdx = steps.indexOf(oldStatus);
      const newIdx = steps.indexOf(newStatus);
      const consumeStepName = commission.consumeStepName || DEFAULT_CONSUME_STEP_NAME;
      const consumeIdx = steps.indexOf(consumeStepName);
      try {
        if (oldStatus !== newStatus && consumeIdx !== -1) {
          if (oldIdx < consumeIdx && newIdx >= consumeIdx) {
            consumeCommissionMaterialsAtStep(db, commission, oldStatus, newStatus, input.operator, input.operatorId);
          } else if (oldIdx >= consumeIdx && newIdx < consumeIdx) {
            undoCommissionMaterialsConsume(db, commission, input.operator, input.operatorId, `步骤回退：${oldStatus} → ${newStatus}，撤销消耗`);
          }
        }
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      commission.status = newStatus;
      commission.records.push({ at: new Date().toISOString(), step: newStatus, note: input.note || "" });
      if (oldStatus !== newStatus) {
        commission.fieldSnapshots.push(createFieldSnapshot(commission, input.operator, input.operatorId, "步骤更新：" + oldStatus + " → " + newStatus));
      }
      addOperationLog(commission, "step_update", input.operator, input.operatorId, "步骤更新：" + newStatus + (input.note ? " - " + input.note : ""));
      await saveDb(db);
      return sendJson(res, 200, commission);
    }
    const acceptanceMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/acceptance$/);
    if (acceptanceMatch && req.method === "POST") {
      const commission = db.commissions.find(item => item.id === acceptanceMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const steps = commission.steps && commission.steps.length ? commission.steps : defaultSteps;
      const lastStep = steps[steps.length - 1];
      if (commission.status !== lastStep) {
        return sendJson(res, 400, { error: "status_not_deliverable", message: "只有进入交付步骤的委托才能填写验收" });
      }
      const input = await body(req);
      const opCheck = requireOperator(input);
      if (opCheck.error) return sendJson(res, 400, { error: "operator_required", message: opCheck.message });
      const acceptance = {
        result: input.result || "",
        deliveryDate: input.deliveryDate || "",
        receiver: input.receiver || "",
        remainingIssues: input.remainingIssues || "",
        maintenanceAdvice: input.maintenanceAdvice || "",
        acceptedAt: new Date().toISOString()
      };
      commission.acceptance = acceptance;
      commission.records.push({ at: new Date().toISOString(), step: lastStep, note: "交付验收完成" });
      addOperationLog(commission, "acceptance", input.operator, input.operatorId, "交付验收：" + input.result);
      await saveDb(db);
      return sendJson(res, 200, commission);
    }
    if (acceptanceMatch && req.method === "DELETE") {
      const commission = db.commissions.find(item => item.id === acceptanceMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      if (!commission.acceptance) {
        return sendJson(res, 400, { error: "no_acceptance", message: "该委托暂无验收记录" });
      }
      commission.acceptance = null;
      const revokeInput = await body(req);
      const revokeOpCheck = requireOperator(revokeInput);
      if (revokeOpCheck.error) return sendJson(res, 400, { error: "operator_required", message: revokeOpCheck.message });
      addOperationLog(commission, "acceptance_revoke", revokeInput.operator || "", revokeInput.operatorId || "", "撤销验收");
      await saveDb(db);
      return sendJson(res, 200, { ok: true });
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
    if (req.method === "GET" && url.pathname === "/api/materials") {
      const result = db.materials.map(m => ({
        ...m,
        reserved: Number(m.reserved) || 0,
        available: getMaterialAvailable(m)
      }));
      return sendJson(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/api/stock-ledger") {
      ensureStockLedger(db);
      const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
      const materialId = params.get("materialId") || "";
      const commissionId = params.get("commissionId") || "";
      let list = db.stockLedger;
      if (materialId) list = list.filter(l => l.materialId === materialId);
      if (commissionId) list = list.filter(l => l.commissionId === commissionId);
      const limit = Math.min(Number(params.get("limit")) || 500, 2000);
      list = list.slice(0, limit);
      return sendJson(res, 200, { total: db.stockLedger.length, items: list, labels: STOCK_LEDGER_LABELS });
    }
    if (req.method === "POST" && url.pathname === "/api/materials") {
      const input = await body(req);
      const initStock = Number(input.stock) || 0;
      const material = { id: `MAT-${Date.now()}`, name: input.name, category: input.category || "其他", batch: input.batch || "", stock: initStock, reserved: 0, unit: input.unit || "个", minStock: Number(input.minStock) || 0, remark: input.remark || "" };
      db.materials.unshift(material);
      const op = input.operator || "系统";
      const opId = input.operatorId || "";
      if (initStock > 0) {
        addStockLedger(db, createStockLedgerEntry({
          materialId: material.id, materialName: material.name, batch: material.batch,
          type: STOCK_LEDGER_TYPES.INIT, quantity: initStock,
          stockBefore: 0, stockAfter: initStock,
          reservedBefore: 0, reservedAfter: 0,
          operator: op, operatorId: opId,
          note: `新增材料，初始库存 ${initStock}${material.unit}`
        }));
      }
      await saveDb(db);
      return sendJson(res, 201, { ...material, available: getMaterialAvailable(material) });
    }
    const materialMatch = url.pathname.match(/^\/api\/materials\/([^/]+)$/);
    if (materialMatch && req.method === "PUT") {
      const material = db.materials.find(m => m.id === materialMatch[1]);
      if (!material) return sendJson(res, 404, { error: "material_not_found" });
      const input = await body(req);
      const stockBefore = Number(material.stock) || 0;
      if (input.name !== undefined) material.name = input.name;
      if (input.category !== undefined) material.category = input.category || "其他";
      if (input.batch !== undefined) material.batch = input.batch || "";
      if (input.stock !== undefined) {
        const newStock = Math.max(0, Number(input.stock) || 0);
        const diff = newStock - stockBefore;
        material.stock = newStock;
        const op = input.operator || "系统";
        const opId = input.operatorId || "";
        if (diff !== 0) {
          addStockLedger(db, createStockLedgerEntry({
            materialId: material.id, materialName: material.name, batch: material.batch,
            type: diff > 0 ? STOCK_LEDGER_TYPES.MANUAL_IN : STOCK_LEDGER_TYPES.MANUAL_OUT,
            quantity: diff,
            stockBefore, stockAfter: newStock,
            reservedBefore: Number(material.reserved) || 0, reservedAfter: Number(material.reserved) || 0,
            operator: op, operatorId: opId,
            note: `编辑材料调整库存：${stockBefore} → ${newStock}（${diff > 0 ? "+" : ""}${diff}）`
          }));
        }
      }
      if (input.unit !== undefined) material.unit = input.unit || "个";
      if (input.minStock !== undefined) material.minStock = Math.max(0, Number(input.minStock) || 0);
      if (input.remark !== undefined) material.remark = input.remark || "";
      await saveDb(db);
      return sendJson(res, 200, { ...material, available: getMaterialAvailable(material) });
    }
    if (materialMatch && req.method === "DELETE") {
      const idx = db.materials.findIndex(m => m.id === materialMatch[1]);
      if (idx === -1) return sendJson(res, 404, { error: "material_not_found" });
      const deleted = db.materials[idx];
      const reserved = Number(deleted.reserved) || 0;
      if (reserved > 0) {
        return sendJson(res, 400, { error: `该材料存在 ${reserved}${deleted.unit} 的库存占用，请先取消相关委托的占用后再删除` });
      }
      db.materials.splice(idx, 1);
      await saveDb(db);
      return sendJson(res, 200, { ok: true });
    }
    const stockMatch = url.pathname.match(/^\/api\/materials\/([^/]+)\/stock$/);
    if (stockMatch && req.method === "POST") {
      const material = db.materials.find(m => m.id === stockMatch[1]);
      if (!material) return sendJson(res, 404, { error: "material_not_found" });
      const input = await body(req);
      const change = Number(input.change) || 0;
      const stockBefore = Number(material.stock) || 0;
      const reservedBefore = Number(material.reserved) || 0;
      if (change < 0) {
        const available = stockBefore - reservedBefore;
        if (available + change < 0) {
          return sendJson(res, 400, { error: `可用量不足，当前可用 ${available}${material.unit}（总库存 ${stockBefore}${material.unit}，已占用 ${reservedBefore}${material.unit}）` });
        }
      }
      material.stock = Math.max(0, stockBefore + change);
      const op = input.operator || "系统";
      const opId = input.operatorId || "";
      addStockLedger(db, createStockLedgerEntry({
        materialId: material.id, materialName: material.name, batch: material.batch,
        type: change > 0 ? STOCK_LEDGER_TYPES.MANUAL_IN : STOCK_LEDGER_TYPES.MANUAL_OUT,
        quantity: change,
        stockBefore, stockAfter: material.stock,
        reservedBefore, reservedAfter: reservedBefore,
        operator: op, operatorId: opId,
        note: input.note || (change > 0 ? "手动入库" : "手动出库") + `：${change > 0 ? "+" : ""}${change}${material.unit}`
      }));
      await saveDb(db);
      return sendJson(res, 200, { ...material, available: getMaterialAvailable(material) });
    }

    if (req.method === "GET" && url.pathname === "/api/members") return sendJson(res, 200, db.members);

    if (req.method === "POST" && url.pathname === "/api/members") {
      const input = await body(req);
      if (!input.name || !input.name.trim()) return sendJson(res, 400, { error: "成员名称不能为空" });
      const member = { id: `MB-${Date.now()}`, name: input.name.trim(), role: input.role || "", phone: input.phone || "", remark: input.remark || "" };
      db.members.unshift(member);
      await saveDb(db);
      return sendJson(res, 201, member);
    }

    const memberMatch = url.pathname.match(/^\/api\/members\/([^/]+)$/);
    if (memberMatch && req.method === "PUT") {
      const member = db.members.find(m => m.id === memberMatch[1]);
      if (!member) return sendJson(res, 404, { error: "member_not_found" });
      const input = await body(req);
      if (input.name !== undefined) member.name = input.name;
      if (input.role !== undefined) member.role = input.role;
      if (input.phone !== undefined) member.phone = input.phone;
      if (input.remark !== undefined) member.remark = input.remark;
      await saveDb(db);
      return sendJson(res, 200, member);
    }

    if (memberMatch && req.method === "DELETE") {
      const idx = db.members.findIndex(m => m.id === memberMatch[1]);
      if (idx === -1) return sendJson(res, 404, { error: "member_not_found" });
      db.members.splice(idx, 1);
      await saveDb(db);
      return sendJson(res, 200, { ok: true });
    }

    const logsMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/logs$/);
    if (logsMatch && req.method === "GET") {
      const commission = db.commissions.find(c => c.id === logsMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      return sendJson(res, 200, commission.operationLogs || []);
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
        if (!c.dueDate || c.acceptance !== null) continue;
        
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
      const opCheck = requireOperator(input);
      if (opCheck.error) return sendJson(res, 400, { error: "operator_required", message: opCheck.message });
      if (!commission.fieldSnapshots) commission.fieldSnapshots = [];
      const changedFields = [];
      if (input.status !== undefined && input.status !== commission.status) {
        const oldStatus = commission.status;
        const newStatus = input.status;
        const steps = commission.steps && commission.steps.length ? commission.steps : defaultSteps;
        const oldIdx = steps.indexOf(oldStatus);
        const newIdx = steps.indexOf(newStatus);
        const consumeStepName = commission.consumeStepName || DEFAULT_CONSUME_STEP_NAME;
        const consumeIdx = steps.indexOf(consumeStepName);
        try {
          if (consumeIdx !== -1) {
            if (oldIdx < consumeIdx && newIdx >= consumeIdx) {
              consumeCommissionMaterialsAtStep(db, commission, oldStatus, newStatus, input.operator, input.operatorId);
            } else if (oldIdx >= consumeIdx && newIdx < consumeIdx) {
              undoCommissionMaterialsConsume(db, commission, input.operator, input.operatorId, `排期步骤回退：${oldStatus} → ${newStatus}，撤销消耗`);
            }
          }
        } catch (e) {
          return sendJson(res, 400, { error: e.message });
        }
        commission.status = newStatus;
        changedFields.push("步骤");
        commission.records.push({ 
          at: new Date().toISOString(), 
          step: newStatus, 
          note: input.note || "步骤更新" 
        });
      }
      if (input.owner !== undefined && input.owner !== commission.owner) {
        commission.owner = input.owner;
        changedFields.push("负责人");
      }
      if (input.dueDate !== undefined && input.dueDate !== commission.dueDate) {
        commission.dueDate = input.dueDate;
        changedFields.push("截止日期");
      }
      if (input.remark !== undefined) {
        commission.remark = input.remark;
      }
      if (changedFields.length > 0) {
        commission.fieldSnapshots.push(createFieldSnapshot(commission, input.operator, input.operatorId, "排期更新：" + changedFields.join("、")));
      }
      const logDetails = [];
      if (input.status !== undefined) logDetails.push("步骤→" + input.status);
      if (input.owner !== undefined) logDetails.push("负责人→" + input.owner);
      if (input.dueDate !== undefined) logDetails.push("截止日期→" + input.dueDate);
      if (logDetails.length) addOperationLog(commission, "schedule_update", input.operator, input.operatorId, logDetails.join("，"));
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
      const opCheck = requireOperator(input);
      if (opCheck.error) return sendJson(res, 400, { error: "operator_required", message: opCheck.message });

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

      addOperationLog(commission, "quote_create", input.operator, input.operatorId, "创建报价 V" + quote.version);
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
      const opCheck = requireOperator(input);
      if (opCheck.error) return sendJson(res, 400, { error: "operator_required", message: opCheck.message });

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

      addOperationLog(commission, "quote_edit", input.operator, input.operatorId, "修改报价 V" + quote.version);
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

      const confirmInput = await body(req);
      const confirmOpCheck = requireOperator(confirmInput);
      if (confirmOpCheck.error) return sendJson(res, 400, { error: "operator_required", message: confirmOpCheck.message });
      addOperationLog(commission, "quote_confirm", confirmInput.operator || "", confirmInput.operatorId || "", "确认报价 V" + quote.version);
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

      const reviseInput = await body(req);
      const reviseOpCheck = requireOperator(reviseInput);
      if (reviseOpCheck.error) return sendJson(res, 400, { error: "operator_required", message: reviseOpCheck.message });

      let newItems, newLabor, newMaterial, newTotal, newDays, newRemark;
      if (reviseInput.items && Array.isArray(reviseInput.items)) {
        newItems = reviseInput.items.map((item, idx) => ({
          id: `QI-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 4)}`,
          description: item.description || "",
          quantity: Number(item.quantity) || 0,
          unitPrice: Number(item.unitPrice) || 0,
          amount: Number(item.amount) || 0
        }));
        newLabor = Number(reviseInput.laborCost) || 0;
        newMaterial = Number(reviseInput.materialCost) || 0;
        newDays = Number(reviseInput.estimatedDays) || 0;
        newRemark = reviseInput.remark || "";
        const itemsSum = newItems.reduce((s, i) => s + i.amount, 0);
        newTotal = itemsSum + newLabor + newMaterial;
      } else {
        newItems = oldQuote.items.map(item => ({ ...item, id: `QI-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }));
        newLabor = oldQuote.laborCost;
        newMaterial = oldQuote.materialCost;
        newTotal = oldQuote.totalAmount;
        newDays = oldQuote.estimatedDays;
        newRemark = oldQuote.remark;
      }

      const newQuote = {
        id: `Q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        version: (commission.quotes?.length || 0) + 1,
        status: "draft",
        items: newItems,
        laborCost: newLabor,
        materialCost: newMaterial,
        totalAmount: newTotal,
        estimatedDays: newDays,
        remark: newRemark,
        createdAt: new Date().toISOString(),
        confirmedAt: null,
        createdBy: "",
        previousVersionId: oldQuote.id
      };

      commission.quotes.push(newQuote);
      commission.currentQuoteId = newQuote.id;

      addOperationLog(commission, "quote_revise", reviseInput.operator || "", reviseInput.operatorId || "", "重新报价 V" + newQuote.version);
      await saveDb(db);
      return sendJson(res, 201, newQuote);
    }

    const quoteDiffMatch = url.pathname.match(/^\/api\/commissions\/([^/]+)\/quotes\/([^/]+)\/diff\/([^/]+)$/);
    if (quoteDiffMatch && req.method === "GET") {
      const commission = db.commissions.find(c => c.id === quoteDiffMatch[1]);
      if (!commission) return sendJson(res, 404, { error: "commission_not_found" });
      const quoteA = commission.quotes?.find(q => q.id === quoteDiffMatch[2]);
      const quoteB = commission.quotes?.find(q => q.id === quoteDiffMatch[3]);
      if (!quoteA || !quoteB) return sendJson(res, 404, { error: "quote_not_found" });

      function itemKey(item) {
        return (item.description || "").trim();
      }

      const aKeys = new Map(quoteA.items.map(i => [itemKey(i), i]));
      const bKeys = new Map(quoteB.items.map(i => [itemKey(i), i]));
      const addedItems = [];
      const removedItems = [];
      const modifiedItems = [];

      for (const [key, bItem] of bKeys) {
        if (!aKeys.has(key)) {
          addedItems.push(bItem);
        } else {
          const aItem = aKeys.get(key);
          if ((aItem.quantity || 0) !== (bItem.quantity || 0) ||
              (aItem.unitPrice || 0) !== (bItem.unitPrice || 0) ||
              (aItem.amount || 0) !== (bItem.amount || 0)) {
            modifiedItems.push({ oldItem: aItem, newItem: bItem });
          }
        }
      }
      for (const [key, aItem] of aKeys) {
        if (!bKeys.has(key)) {
          removedItems.push(aItem);
        }
      }

      const aItemsTotal = quoteA.items.reduce((s, i) => s + (i.amount || 0), 0);
      const bItemsTotal = quoteB.items.reduce((s, i) => s + (i.amount || 0), 0);

      const diff = {
        baseVersion: quoteA.version,
        targetVersion: quoteB.version,
        baseQuoteId: quoteA.id,
        targetQuoteId: quoteB.id,
        amount: {
          itemsTotal: {
            oldValue: aItemsTotal,
            newValue: bItemsTotal,
            difference: bItemsTotal - aItemsTotal
          },
          laborCost: {
            oldValue: quoteA.laborCost || 0,
            newValue: quoteB.laborCost || 0,
            difference: (quoteB.laborCost || 0) - (quoteA.laborCost || 0)
          },
          materialCost: {
            oldValue: quoteA.materialCost || 0,
            newValue: quoteB.materialCost || 0,
            difference: (quoteB.materialCost || 0) - (quoteA.materialCost || 0)
          },
          totalAmount: {
            oldValue: quoteA.totalAmount || 0,
            newValue: quoteB.totalAmount || 0,
            difference: (quoteB.totalAmount || 0) - (quoteA.totalAmount || 0)
          },
          estimatedDays: {
            oldValue: quoteA.estimatedDays || 0,
            newValue: quoteB.estimatedDays || 0,
            difference: (quoteB.estimatedDays || 0) - (quoteA.estimatedDays || 0)
          }
        },
        items: {
          added: addedItems,
          removed: removedItems,
          modified: modifiedItems
        },
        remark: {
          oldValue: quoteA.remark || "",
          newValue: quoteB.remark || "",
          changed: (quoteA.remark || "") !== (quoteB.remark || "")
        }
      };

      return sendJson(res, 200, diff);
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
