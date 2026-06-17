import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "shadow-puppet.json");
const port = Number(process.env.PORT || 3023);
const steps = ["接收", "清洁", "补片", "补色", "交付"];

const seed = {
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
      ]
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
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
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
    @media (max-width:900px){ .two-col{grid-template-columns:1fr;} header{padding:18px 16px;} .tabs{padding:12px 16px 0;} .tab-content{padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header>
    <h1>皮影修复小作坊</h1>
    <div class="meta">委托、修复步骤、材料台账</div>
  </header>
  <div class="tabs">
    <div class="tab active" data-tab="commissions">修复委托</div>
    <div class="tab" data-tab="clients">客户档案</div>
    <div class="tab" data-tab="materials">材料台账</div>
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

  <script>
    const steps = ${JSON.stringify(steps)};
    let commissions = [];
    let materials = [];
    let clients = [];
    let currentTab = "commissions";
    let selectedClientId = null;

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }

    document.querySelectorAll(".tab").forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
        currentTab = tab.dataset.tab;
      };
    });

    function renderCommissions() {
      const stats = document.querySelector("#stats");
      const list = document.querySelector("#list");
      stats.innerHTML = steps.map(step => '<div class="stat"><span>'+step+'</span><strong>'+commissions.filter(c => c.status === step).length+'</strong></div>').join("");
      list.innerHTML = commissions.map(c => {
        const matChips = (c.materials && c.materials.length) ? c.materials.map(m => '<span class="mat-chip">'+m.name+' ×'+m.quantity+(m.batch?' ('+m.batch+')':'')+'</span>').join("") : '';
        return '<article class="card"><h3>'+c.roleName+'</h3><span class="pill">'+c.status+'</span><div class="meta">'+c.client+' · '+c.era+' · '+c.owner+'</div><div><b>破损</b> '+c.damage+'</div>'+(c.reinforcement?'<div><b>加固</b> '+c.reinforcement+'</div>':'')+(matChips?'<div><b>用料</b></div><div class="mat-chips">'+matChips+'</div>':'')+'<label>更新步骤</label><select data-step="'+c.id+'">'+steps.map(s => '<option>'+s+'</option>').join("")+'</select><input data-note="'+c.id+'" placeholder="步骤备注"><button data-save="'+c.id+'">保存步骤</button><div class="meta">'+(c.records||[]).map(r => r.step+"："+r.note).join(" / ")+'</div></article>';
      }).join("");
      document.querySelectorAll("[data-step]").forEach(sel => sel.value = commissions.find(c => c.id === sel.dataset.step).status);
      document.querySelectorAll("[data-save]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.save;
        await api('/api/commissions/'+id+'/records', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+id+'"]').value, note: document.querySelector('[data-note="'+id+'"]').value || "步骤完成" }) });
        await loadAll();
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

    function render() {
      renderCommissions();
      renderClientSelect();
      renderClients();
      renderMaterialSelect();
      renderMaterials();
    }

    async function loadAll() {
      const [c, cl, m] = await Promise.all([api("/api/commissions"), api("/api/clients"), api("/api/materials")]);
      commissions = c;
      clients = cl;
      materials = m;
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
      try {
        await api("/api/commissions", { method:"POST", body: JSON.stringify(data) });
        event.target.reset();
        document.getElementById("clientNewFields").classList.remove("visible");
        await loadAll();
      } catch (e) {
        alert(e.message);
      }
    };

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
      const commission = { id: `SP-${Date.now()}`, clientId, client: clientName, roleName: input.roleName, era: input.era, damage: input.damage, missingParts: input.missingParts || "", colorNotes: input.colorNotes || "", reinforcement: input.reinforcement || "", materials: selectedMaterials, owner: input.owner, dueDate: input.dueDate, status: "接收", records: [{ at: new Date().toISOString(), step: "接收", note: "登记委托" }] };
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
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Shadow puppet restoration app listening on http://localhost:${port}`));
