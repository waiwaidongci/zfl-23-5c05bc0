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

export {
  analyzeImportClients,
  analyzeImportMaterials,
  analyzeImportMembers,
  analyzeImportTemplates
};
