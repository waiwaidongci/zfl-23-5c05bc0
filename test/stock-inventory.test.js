import { test, beforeEach, after, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFile, unlink, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getMaterialAvailable,
  reserveCommissionMaterials,
  releaseCommissionMaterials,
  consumeCommissionMaterialsAtStep,
  undoCommissionMaterialsConsume,
  STOCK_LEDGER_TYPES,
  DEFAULT_CONSUME_STEP_NAME,
  defaultSteps,
  server,
  loadDb
} from "../server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_FILE = "shadow-puppet.test.json";
const TEST_DB_PATH = join(__dirname, "..", "data", TEST_DB_FILE);
const TEST_UPLOADS_DIR = join(__dirname, "..", "test-uploads-tmp");

async function createTestDbFile() {
  const testDb = {
    materials: [
      {
        id: "MAT-1",
        name: "薄驴皮补片",
        batch: "LP-2026-A01",
        unit: "张",
        stock: 10,
        reserved: 0,
        minStock: 2,
        category: "修复材料",
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "MAT-2",
        name: "天然朱砂颜料",
        batch: "ZS-2026-B02",
        unit: "克",
        stock: 50,
        reserved: 5,
        minStock: 10,
        category: "颜料",
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "MAT-3",
        name: "特种修复胶",
        batch: "JJ-2026-C03",
        unit: "毫升",
        stock: 3,
        reserved: 0,
        minStock: 5,
        category: "粘合剂",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    commissions: [],
    stockLedger: [],
    members: [
      { id: "OP-1", name: "张修复师", role: "主修复师", phone: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    operators: [
      { id: "OP-1", name: "张修复师", role: "主修复师", phone: "", createdAt: "2026-01-01T00:00:00.000Z" }
    ],
    clients: [],
    stepTemplates: [],
    quotes: [],
    settings: {
      defaultSteps: defaultSteps,
      defaultConsumeStep: DEFAULT_CONSUME_STEP_NAME,
      stockWarningDays: 7
    }
  };
  await mkdir(join(__dirname, "..", "data"), { recursive: true });
  await writeFile(TEST_DB_PATH, JSON.stringify(testDb, null, 2));
  process.env.DB_FILE = TEST_DB_FILE;
  process.env.UPLOADS_DIR = TEST_UPLOADS_DIR;
  await mkdir(TEST_UPLOADS_DIR, { recursive: true });
}

async function cleanupTestDbFile() {
  try {
    await unlink(TEST_DB_PATH);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    await rm(TEST_UPLOADS_DIR, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  delete process.env.DB_FILE;
  delete process.env.UPLOADS_DIR;
}

function createTestDb() {
  return {
    materials: [
      {
        id: "MAT-1",
        name: "薄驴皮补片",
        batch: "LP-2026-A01",
        unit: "张",
        stock: 10,
        reserved: 0,
        minStock: 2,
        category: "修复材料"
      },
      {
        id: "MAT-2",
        name: "天然朱砂颜料",
        batch: "ZS-2026-B02",
        unit: "克",
        stock: 50,
        reserved: 5,
        minStock: 10,
        category: "颜料"
      },
      {
        id: "MAT-3",
        name: "特种修复胶",
        batch: "JJ-2026-C03",
        unit: "毫升",
        stock: 3,
        reserved: 0,
        minStock: 5,
        category: "粘合剂"
      }
    ],
    commissions: [],
    stockLedger: [],
    members: [
      { id: "OP-1", name: "张修复师", role: "主修复师" }
    ],
    operators: [
      { id: "OP-1", name: "张修复师", role: "主修复师" }
    ],
    clients: [],
    stepTemplates: [],
    settings: {}
  };
}

function createTestCommission(materials, status = "接收", steps = defaultSteps) {
  return {
    id: "SP-TEST-001",
    roleName: "测试皮影",
    era: "民国",
    damage: "测试破损",
    owner: "测试客户",
    dueDate: "2026-12-31",
    status,
    steps,
    consumeStepName: DEFAULT_CONSUME_STEP_NAME,
    materials: materials.map(m => ({
      materialId: m.id,
      name: m.name,
      batch: m.batch || "",
      quantity: m.quantity,
      reservedQty: 0,
      consumedQty: 0,
      consumedAt: "",
      consumedBy: "",
      consumedStep: ""
    })),
    records: [],
    fieldSnapshots: [],
    operationLogs: []
  };
}

function jsonRequest(url, method, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: {
        "Content-Type": "application/json"
      }
    };
    const req = http.request(url, options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

describe("库存核心函数 - 单元测试", () => {
  let db;
  const operator = "张修复师";
  const operatorId = "OP-1";

  beforeEach(() => {
    db = createTestDb();
  });

  test("getMaterialAvailable - 正确计算可用量（库存-占用）", () => {
    const mat1 = db.materials[0];
    assert.equal(getMaterialAvailable(mat1), 10, "无占用时可用量=库存");

    const mat2 = db.materials[1];
    assert.equal(getMaterialAvailable(mat2), 45, "有占用时可用量=库存-占用");
  });

  test("getMaterialAvailable - 空材料返回0", () => {
    assert.equal(getMaterialAvailable(null), 0);
    assert.equal(getMaterialAvailable(undefined), 0);
  });

  test("reserveCommissionMaterials - 创建委托时正确占用材料", () => {
    const commission = createTestCommission([
      { id: "MAT-1", name: "薄驴皮补片", quantity: 2 },
      { id: "MAT-2", name: "天然朱砂颜料", quantity: 10 }
    ]);

    reserveCommissionMaterials(db, commission, operator, operatorId);

    const mat1 = db.materials.find(m => m.id === "MAT-1");
    assert.equal(mat1.reserved, 2, "MAT-1 占用量应增加2");
    assert.equal(mat1.stock, 10, "MAT-1 库存不应变化（未到消耗节点）");

    const mat2 = db.materials.find(m => m.id === "MAT-2");
    assert.equal(mat2.reserved, 15, "MAT-2 占用量应从5增加到15");

    const m1 = commission.materials[0];
    assert.equal(m1.reservedQty, 2, "委托材料1记录占用量");
    assert.equal(m1.consumedQty, 0, "委托材料1未消耗");

    const reserveEntries = db.stockLedger.filter(e => e.type === STOCK_LEDGER_TYPES.RESERVE);
    assert.equal(reserveEntries.length, 2, "应生成2条占用流水记录");
    const mat1Entry = reserveEntries.find(e => e.materialId === "MAT-1");
    assert.ok(mat1Entry, "应包含MAT-1的占用记录");
    assert.equal(mat1Entry.quantity, 2);
  });

  test("reserveCommissionMaterials - 库存不足时抛出错误", () => {
    const commission = createTestCommission([
      { id: "MAT-1", name: "薄驴皮补片", quantity: 100 }
    ]);

    assert.throws(
      () => reserveCommissionMaterials(db, commission, operator, operatorId),
      /可用量不足/,
      "可用量不足时应抛出错误"
    );
  });

  test("reserveCommissionMaterials - 创建时已超过消耗节点直接消耗", () => {
    const commission = createTestCommission(
      [{ id: "MAT-1", name: "薄驴皮补片", quantity: 3 }],
      "补片"
    );

    reserveCommissionMaterials(db, commission, operator, operatorId);

    const mat1 = db.materials.find(m => m.id === "MAT-1");
    assert.equal(mat1.stock, 7, "已过消耗节点，库存应直接减少");
    assert.equal(mat1.reserved, 0, "已过消耗节点，不产生占用");

    const m1 = commission.materials[0];
    assert.equal(m1.consumedQty, 3, "委托材料记录消耗量");
    assert.equal(m1.reservedQty, 0, "委托材料无占用量");
  });

  test("consumeCommissionMaterialsAtStep - 推进到补片步骤时占用转实际消耗", () => {
    const commission = createTestCommission([
      { id: "MAT-1", name: "薄驴皮补片", quantity: 2 },
      { id: "MAT-2", name: "天然朱砂颜料", quantity: 5 }
    ]);

    reserveCommissionMaterials(db, commission, operator, operatorId);

    const mat1Before = db.materials.find(m => m.id === "MAT-1");
    assert.equal(mat1Before.reserved, 2, "占用验证：reserve=2");
    assert.equal(mat1Before.stock, 10, "占用验证：stock=10");

    consumeCommissionMaterialsAtStep(db, commission, "清洁", "补片", operator, operatorId);

    const mat1After = db.materials.find(m => m.id === "MAT-1");
    assert.equal(mat1After.stock, 8, "消耗后库存=10-2=8");
    assert.equal(mat1After.reserved, 0, "消耗后占用归零");

    const m1 = commission.materials[0];
    assert.equal(m1.consumedQty, 2, "委托材料记录已消耗");
    assert.equal(m1.reservedQty, 0, "委托材料占用量归零");
    assert.equal(m1.consumedStep, "补片", "记录消耗步骤");

    const consumeEntry = db.stockLedger.find(e => e.type === STOCK_LEDGER_TYPES.CONSUME);
    assert.ok(consumeEntry, "应生成消耗流水记录");
    assert.equal(consumeEntry.note, "步骤推进至【补片】，实际出库消耗");
  });

  test("consumeCommissionMaterialsAtStep - 消耗时库存不足抛出错误", () => {
    const commission = createTestCommission([
      { id: "MAT-1", name: "薄驴皮补片", quantity: 2 }
    ]);

    reserveCommissionMaterials(db, commission, operator, operatorId);

    const mat1 = db.materials.find(m => m.id === "MAT-1");
    mat1.stock = 1;

    assert.throws(
      () => consumeCommissionMaterialsAtStep(db, commission, "清洁", "补片", operator, operatorId),
      /库存不足，无法消耗/,
      "消耗时库存不足应抛出错误"
    );
  });

  test("undoCommissionMaterialsConsume - 从补片回退到清洁时恢复占用", () => {
    const commission = createTestCommission([
      { id: "MAT-1", name: "薄驴皮补片", quantity: 2 }
    ]);

    reserveCommissionMaterials(db, commission, operator, operatorId);
    consumeCommissionMaterialsAtStep(db, commission, "清洁", "补片", operator, operatorId);

    const mat1AfterConsume = db.materials.find(m => m.id === "MAT-1");
    assert.equal(mat1AfterConsume.stock, 8, "消耗后库存=8");
    assert.equal(mat1AfterConsume.reserved, 0, "消耗后占用=0");

    undoCommissionMaterialsConsume(db, commission, operator, operatorId, "步骤回退：补片 → 清洁");

    const mat1AfterUndo = db.materials.find(m => m.id === "MAT-1");
    assert.equal(mat1AfterUndo.stock, 10, "撤销消耗后库存恢复为10");
    assert.equal(mat1AfterUndo.reserved, 2, "撤销消耗后占用恢复为2");

    const m1 = commission.materials[0];
    assert.equal(m1.consumedQty, 0, "委托材料消耗量归零");
    assert.equal(m1.reservedQty, 2, "委托材料占用量恢复");

    const undoEntry = db.stockLedger.find(e => e.type === STOCK_LEDGER_TYPES.UNDO_CONSUME);
    assert.ok(undoEntry, "应生成撤销消耗流水记录");
    assert.equal(undoEntry.quantity, 2);
  });

  test("releaseCommissionMaterials - 删除委托时释放占用和消耗", () => {
    const commission = createTestCommission([
      { id: "MAT-1", name: "薄驴皮补片", quantity: 2 }
    ]);

    reserveCommissionMaterials(db, commission, operator, operatorId);
    consumeCommissionMaterialsAtStep(db, commission, "清洁", "补片", operator, operatorId);

    releaseCommissionMaterials(db, commission, operator, operatorId, "删除委托");

    const mat1 = db.materials.find(m => m.id === "MAT-1");
    assert.equal(mat1.stock, 10, "释放后库存恢复");
    assert.equal(mat1.reserved, 0, "释放后占用归零");

    const m1 = commission.materials[0];
    assert.equal(m1.consumedQty, 0);
    assert.equal(m1.reservedQty, 0);
  });

  test("完整流程：创建→占用→推进→消耗→回退→恢复占用→删除→释放", () => {
    const commission = createTestCommission([
      { id: "MAT-1", name: "薄驴皮补片", quantity: 3 }
    ]);
    const mat1 = () => db.materials.find(m => m.id === "MAT-1");

    reserveCommissionMaterials(db, commission, operator, operatorId);
    assert.equal(mat1().stock, 10);
    assert.equal(mat1().reserved, 3);
    assert.equal(getMaterialAvailable(mat1()), 7);

    consumeCommissionMaterialsAtStep(db, commission, "清洁", "补片", operator, operatorId);
    assert.equal(mat1().stock, 7);
    assert.equal(mat1().reserved, 0);

    undoCommissionMaterialsConsume(db, commission, operator, operatorId, "回退");
    assert.equal(mat1().stock, 10);
    assert.equal(mat1().reserved, 3);

    releaseCommissionMaterials(db, commission, operator, operatorId, "删除");
    assert.equal(mat1().stock, 10);
    assert.equal(mat1().reserved, 0);
    assert.equal(getMaterialAvailable(mat1()), 10);
  });
});

describe("库存与委托API - 集成测试", () => {
  let testServer;
  let testPort;
  const baseUrl = () => `http://localhost:${testPort}`;

  beforeEach(async () => {
    await createTestDbFile();
    testPort = 3023 + Math.floor(Math.random() * 1000);
    process.env.PORT = testPort;
    testServer = http.createServer(server.listeners("request")[0]);
    await new Promise((resolve) => testServer.listen(testPort, resolve));
  });

  afterEach(async () => {
    if (testServer) {
      await new Promise((resolve) => testServer.close(resolve));
      testServer = null;
    }
    await cleanupTestDbFile();
  });

  test("POST /api/commissions - 创建委托时库存不足返回400错误", async () => {
    const res = await jsonRequest(`${baseUrl()}/api/commissions`, "POST", {
      roleName: "测试皮影",
      era: "现代",
      damage: "测试",
      owner: "测试客户",
      dueDate: "2026-12-31",
      materials: [
        { id: "MAT-3", quantity: 100 }
      ],
      operator: "张修复师",
      operatorId: "OP-1"
    });

    assert.equal(res.status, 400, "库存不足应返回400");
    assert.ok(
      (res.body.error && res.body.error.includes("可用量不足")) ||
      (typeof res.body === "string" && res.body.includes("可用量不足")),
      "错误信息应包含可用量不足"
    );
  });

  test("POST /api/commissions - 创建委托成功并正确占用材料", async () => {
    const res = await jsonRequest(`${baseUrl()}/api/commissions`, "POST", {
      roleName: "集成测试皮影",
      era: "民国",
      damage: "边角破损",
      owner: "集成测试客户",
      dueDate: "2026-12-31",
      materials: [
        { id: "MAT-1", quantity: 2 }
      ],
      operator: "张修复师",
      operatorId: "OP-1"
    });

    assert.equal(res.status, 201, `创建成功应返回201，实际：${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(res.body.id, "应返回委托ID");

    const materialsRes = await jsonRequest(`${baseUrl()}/api/materials`, "GET");
    const mat1 = materialsRes.body.find(m => m.id === "MAT-1");
    assert.equal(mat1.reserved, 2, "材料占用量应更新为2");
  });

  test("POST /api/commissions/:id/records - 推进到补片步骤时正确消耗材料", async () => {
    const createRes = await jsonRequest(`${baseUrl()}/api/commissions`, "POST", {
      roleName: "步骤流转测试",
      era: "现代",
      damage: "测试",
      owner: "测试",
      dueDate: "2026-12-31",
      materials: [
        { id: "MAT-1", quantity: 2 }
      ],
      operator: "张修复师",
      operatorId: "OP-1"
    });
    assert.equal(createRes.status, 201, "创建委托失败");
    const commissionId = createRes.body.id;

    const stepRes = await jsonRequest(`${baseUrl()}/api/commissions/${commissionId}/records`, "POST", {
      step: "补片",
      note: "推进到补片",
      operator: "张修复师",
      operatorId: "OP-1"
    });

    assert.equal(stepRes.status, 200, `步骤推进失败：${stepRes.status} ${JSON.stringify(stepRes.body)}`);

    const materialsRes = await jsonRequest(`${baseUrl()}/api/materials`, "GET");
    const mat1 = materialsRes.body.find(m => m.id === "MAT-1");
    assert.equal(mat1.stock, 8, "库存应从10减少到8");
    assert.equal(mat1.reserved, 0, "占用应归零");

    const mat = stepRes.body.materials.find(m => m.materialId === "MAT-1");
    assert.equal(mat.consumedQty, 2, "委托材料已消耗");
  });

  test("POST /api/commissions/:id/records - 从补片回退到清洁时恢复占用", async () => {
    const createRes = await jsonRequest(`${baseUrl()}/api/commissions`, "POST", {
      roleName: "回退测试",
      era: "现代",
      damage: "测试",
      owner: "测试",
      dueDate: "2026-12-31",
      materials: [
        { id: "MAT-1", quantity: 3 }
      ],
      operator: "张修复师",
      operatorId: "OP-1"
    });
    assert.equal(createRes.status, 201, "创建委托失败");
    const commissionId = createRes.body.id;

    const forwardRes = await jsonRequest(`${baseUrl()}/api/commissions/${commissionId}/records`, "POST", {
      step: "补片",
      note: "推进到补片",
      operator: "张修复师",
      operatorId: "OP-1"
    });
    assert.equal(forwardRes.status, 200, "推进到补片失败");

    const stepRes = await jsonRequest(`${baseUrl()}/api/commissions/${commissionId}/records`, "POST", {
      step: "清洁",
      note: "回退到清洁",
      operator: "张修复师",
      operatorId: "OP-1"
    });

    assert.equal(stepRes.status, 200, `回退失败：${stepRes.status} ${JSON.stringify(stepRes.body)}`);

    const materialsRes = await jsonRequest(`${baseUrl()}/api/materials`, "GET");
    const mat1 = materialsRes.body.find(m => m.id === "MAT-1");
    assert.equal(mat1.stock, 10, "库存应恢复为10");
    assert.equal(mat1.reserved, 3, "占用应恢复为3");
  });
});
