import { PERMISSION_LABELS, ROLE_PERMISSIONS } from "./constants.js";

function requireOperator(input) {
  if (!input || !input.operator || !input.operator.trim()) {
    return { error: true, message: "操作者(operator)不能为空，请先选择当前操作者" };
  }
  return { error: false };
}

function getMemberById(db, memberId) {
  if (!memberId || !db.members) return null;
  return db.members.find(m => m.id === memberId);
}

function getMemberRole(db, memberId) {
  const member = getMemberById(db, memberId);
  return member ? member.role : "";
}

function hasPermission(db, memberId, permission) {
  const member = getMemberById(db, memberId);
  if (!member) return false;
  
  const role = member.role || "";
  const allowedPermissions = ROLE_PERMISSIONS[role] || [];
  return allowedPermissions.includes(permission);
}

function checkPermission(db, memberId, permission) {
  const member = getMemberById(db, memberId);
  if (!member) {
    return {
      allowed: false,
      reason: "操作者不存在或已被删除，请重新选择当前操作者"
    };
  }
  
  const role = member.role || "";
  const allowed = hasPermission(db, memberId, permission);
  
  if (!allowed) {
    return {
      allowed: false,
      reason: `角色「${role}」没有「${PERMISSION_LABELS[permission]}」权限，如需操作请联系主修复师`
    };
  }
  
  return { allowed: true };
}

function addDeniedOperationLog(db, { operatorId, operator, permission, operation, reason, targetType, targetId }) {
  if (!db.deniedOperations) db.deniedOperations = [];
  
  const entry = {
    id: `DENY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    operatorId: operatorId || "",
    operator: operator || "未知",
    permission: permission || "",
    permissionLabel: PERMISSION_LABELS[permission] || permission || "",
    operation: operation || "",
    reason: reason || "",
    targetType: targetType || "",
    targetId: targetId || "",
    at: new Date().toISOString()
  };
  
  db.deniedOperations.unshift(entry);
  return entry;
}

function getOperatorSnapshot(db, operatorId, operatorName) {
  const member = getMemberById(db, operatorId);
  return {
    id: operatorId || "",
    name: operatorName || (member ? member.name : ""),
    role: member ? member.role : "",
    snapshotAt: new Date().toISOString()
  };
}

function addOperationLog(commission, type, operator, operatorId, detail, db) {
  if (!commission.operationLogs) commission.operationLogs = [];
  commission.operationLogs.push({
    id: `LOG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    operator: operator || "未知",
    operatorId: operatorId || "",
    operatorSnapshot: db ? getOperatorSnapshot(db, operatorId, operator) : { id: operatorId || "", name: operator || "未知", role: "", snapshotAt: new Date().toISOString() },
    detail: detail || "",
    at: new Date().toISOString()
  });
}

export {
  requireOperator,
  getMemberById,
  getMemberRole,
  hasPermission,
  checkPermission,
  addDeniedOperationLog,
  getOperatorSnapshot,
  addOperationLog
};
