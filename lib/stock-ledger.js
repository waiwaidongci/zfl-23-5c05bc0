import {
  defaultSteps,
  DEFAULT_CONSUME_STEP_NAME,
  STOCK_LEDGER_TYPES,
  snapshotTrackedFields
} from "./constants.js";
import { getOperatorSnapshot } from "./permissions.js";

function createFieldSnapshot(commission, operator, operatorId, reason, db) {
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
    operatorSnapshot: db ? getOperatorSnapshot(db, operatorId, operator) : { id: operatorId || "", name: operator || "未知", role: "", snapshotAt: new Date().toISOString() },
    reason: reason || "",
    at: new Date().toISOString()
  };
}

function createStockLedgerEntry({ materialId, materialName, batch, type, quantity, stockBefore, stockAfter, reservedBefore, reservedAfter, commissionId, commissionName, step, operator, operatorId, note, db }) {
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
    operatorSnapshot: db ? getOperatorSnapshot(db, operatorId, operator) : { id: operatorId || "", name: operator || "未知", role: "", snapshotAt: new Date().toISOString() },
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
        note: `委托创建时已超过消耗节点，直接出库消耗`,
        db
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
        note: `委托创建占用`,
        db
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
        note: (reason || "释放委托") + "，退回已消耗库存",
        db
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
        note: reason || `释放占用`,
        db
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
          note: `调整材料数量-追加消耗（已过消耗节点）`,
          db
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
            note: `调整材料数量-退回库存`,
            db
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
          note: `调整材料数量-增加占用`,
          db
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
            note: `调整材料数量-减少占用`,
            db
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
        note: `步骤推进至【${consumeStepName}】，实际出库消耗`,
        db
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
      note: reason || `撤销消耗，恢复占用`,
      db
    }));
  }
}

export {
  createFieldSnapshot,
  createStockLedgerEntry,
  ensureStockLedger,
  addStockLedger,
  getMaterialAvailable,
  reserveCommissionMaterials,
  releaseCommissionMaterials,
  adjustCommissionMaterials,
  consumeCommissionMaterialsAtStep,
  undoCommissionMaterialsConsume
};
