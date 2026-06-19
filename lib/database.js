import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSteps,
  DEFAULT_CONSUME_STEP_NAME,
  seedTemplates,
  seed,
  snapshotTrackedFields
} from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");

function getDbPath() {
  const dbFileName = process.env.DB_FILE || "shadow-puppet.json";
  return join(dataDir, dbFileName);
}

function _ensureStockLedgerForDb(db) {
  if (!db || typeof db !== "object") return;
  if (!Array.isArray(db.stockLedger)) {
    db.stockLedger = [];
  }
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

async function saveDb(db) {
  const dbPath = getDbPath();
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function saveDbAtomic(db) {
  const dbPath = getDbPath();
  const tempPath = dbPath + ".tmp";
  await writeFile(tempPath, JSON.stringify(db, null, 2));
  await rename(tempPath, dbPath);
}

async function loadDb() {
  const dbPath = getDbPath();
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
  _ensureStockLedgerForDb(db);
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
    if (!c.coverImage) {
      c.coverImage = null;
      migrated = true;
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
    if (!Array.isArray(c.archives)) {
      c.archives = [];
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
      const snapshotFields = {};
      for (const field of snapshotTrackedFields) {
        snapshotFields[field] = c[field] !== undefined ? c[field] : "";
      }
      snapshotFields.materials = Array.isArray(c.materials) ? JSON.parse(JSON.stringify(c.materials)) : [];
      c.fieldSnapshots = [{
        id: `SNAP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        fields: snapshotFields,
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

export {
  getDbPath,
  dataDir,
  loadDb,
  saveDb,
  saveDbAtomic,
  deepClone
};
