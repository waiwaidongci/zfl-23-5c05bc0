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

const PERMISSIONS = {
  COMMISSION_EDIT: "commission_edit",
  QUOTE_CONFIRM: "quote_confirm",
  ACCEPTANCE_REVOKE: "acceptance_revoke",
  TEMPLATE_DELETE: "template_delete",
  IMPORT_OVERWRITE: "import_overwrite",
  MATERIAL_OUTBOUND: "material_outbound"
};

const PERMISSION_LABELS = {
  commission_edit: "委托编辑",
  quote_confirm: "报价确认",
  acceptance_revoke: "验收撤销",
  template_delete: "模板删除",
  import_overwrite: "导入覆盖",
  material_outbound: "材料出库"
};

const ROLE_PERMISSIONS = {
  "主修复师": [
    PERMISSIONS.COMMISSION_EDIT,
    PERMISSIONS.QUOTE_CONFIRM,
    PERMISSIONS.ACCEPTANCE_REVOKE,
    PERMISSIONS.TEMPLATE_DELETE,
    PERMISSIONS.IMPORT_OVERWRITE,
    PERMISSIONS.MATERIAL_OUTBOUND
  ],
  "修复师": [
    PERMISSIONS.COMMISSION_EDIT,
    PERMISSIONS.QUOTE_CONFIRM,
    PERMISSIONS.MATERIAL_OUTBOUND
  ],
  "补色师": [
    PERMISSIONS.COMMISSION_EDIT
  ],
  "学徒": []
};

const ROLE_HIERARCHY = {
  "主修复师": 4,
  "修复师": 3,
  "补色师": 2,
  "学徒": 1
};

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
      },
      coverImage: null
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

function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

export {
  defaultSteps,
  allowedImageTypes,
  maxFileSize,
  EXPORT_VERSION,
  DEFAULT_CONSUME_STEP_NAME,
  requiredCommissionFields,
  snapshotTrackedFields,
  STOCK_LEDGER_TYPES,
  STOCK_LEDGER_LABELS,
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLE_PERMISSIONS,
  ROLE_HIERARCHY,
  seedTemplates,
  seed,
  toLocalDateStr
};
