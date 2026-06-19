import {
  requiredCommissionFields,
  defaultSteps
} from "./constants.js";

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

export { validateCommission };
