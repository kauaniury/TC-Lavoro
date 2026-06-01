// â”€â”€ State
let chartBarInst, chartDoughnutInst;
let parsedData = null;

// â”€â”€ Tab switching
function switchTab(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + tab).classList.add('active');
  document.querySelectorAll('.topbar-tab').forEach(t => {
    const isActive = t.dataset.page === tab;
    t.classList.toggle('active', isActive);
    if (isActive) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
}

// â”€â”€ Drag & drop
const dz = document.getElementById('dropZone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over', 'drop-zone--over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over', 'drop-zone--over'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('drag-over', 'drop-zone--over');
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
dz.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    document.getElementById('fileInput').click();
  }
});

// â”€â”€ Handle file selection
function handleFile(file) {
  if (!file) return;
  const allowed = ['.xlsx', '.xls'];
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!allowed.includes(ext)) { showError('Formato inválido. Use arquivos .xlsx ou .xls.'); return; }

  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = (file.size / 1024).toFixed(1) + ' KB';
  document.getElementById('fileSelected').classList.add('show');
  document.getElementById('dropZone').classList.add('drop-zone--file-selected');
  hideError();

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      parsedData = parseWorkbook(wb);
      if (!parsedData || parsedData.rows.length === 0) {
        showError('Nenhum dado válido encontrado. Verifique se a planilha possui colunas "Seguradora" e "Status".');
        document.getElementById('btnGenerate').disabled = true;
      } else {
        document.getElementById('btnGenerate').disabled = false;
      }
    } catch(err) {
      showError('Erro ao ler o arquivo: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

// â”€â”€ Parse workbook â€” handles the T&C Garantia specific format
// Structure: header row contains SEGURADORAS / CAPACIDADE TOTAL / MODALIDADE / LIMITE / TAXA / OBSERVAÃ‡ÃƒO
// Status is in OBSERVAÃ‡ÃƒO column. Sub-rows (no seguradora name) = additional modalidades for previous insurer.
// Tomador is in row with label "TOMADOR"
function parseWorkbook(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];

  // Read as array of arrays to handle merged cells and irregular layout
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  if (!raw.length) return null;

  // â”€â”€ Extract tomador / CNPJ from early rows
  let tomador = null;
  let cnpj = null;
  for (let i = 0; i < Math.min(raw.length, 10); i++) {
    const row = raw[i];
    for (let j = 0; j < row.length; j++) {
      const rawCell = String(row[j] || '').trim();
      const cell = rawCell.toUpperCase();
      if (cell === 'TOMADOR' && row[j+1]) tomador = String(row[j+1]).trim();
      if (!cnpj && cell.includes('CNPJ') && row[j+1]) cnpj = String(row[j+1]).trim();
      if (!cnpj) {
        const match = rawCell.match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/);
        if (match) cnpj = match[0];
      }
    }
    if (tomador && cnpj) break;
  }

  // â”€â”€ Find header row (contains "SEGURADORAS" or "SEGURADORA")
  let headerRowIdx = -1;
  let colIdxSeg = -1, colIdxCapTotal = -1, colIdxModal = -1, colIdxLimite = -1;
  let colIdxTaxa = -1, colIdxObs = -1, colIdxVenc = -1;

  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    const rowStr = row.map(c => String(c || '').trim().toUpperCase());
    // Look for the header marker
    const segIdx = rowStr.findIndex(c => c === 'SEGURADORAS' || c === 'SEGURADORA');
    if (segIdx !== -1) {
      headerRowIdx = i;
      colIdxSeg      = segIdx;
      colIdxCapTotal = rowStr.findIndex(c => c.includes('CAPACIDADE') || c.includes('CAP'));
      colIdxModal    = rowStr.findIndex(c => c.includes('MODAL'));
      colIdxLimite   = rowStr.findIndex(c => c === 'LIMITE' || c === 'LIMITE TOTAL');
      colIdxTaxa     = rowStr.findIndex(c => c === 'TAXA');
      colIdxObs      = rowStr.findIndex(c => c.includes('OBSERV') || c.includes('OBS'));
      colIdxVenc     = rowStr.findIndex(c => c.includes('VENCIMENTO') || c.includes('VALIDADE') || c.includes('VIGÊNCIA') || c.includes('VIGENCIA'));
      break;
    }
  }

  // Fallback: try flexible column detection via sheet_to_json
  if (headerRowIdx === -1) {
    const jsonRows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!jsonRows.length) return null;
    const keys = Object.keys(jsonRows[0]);
    const findKey = (...terms) => keys.find(k => terms.some(t => k.toLowerCase().includes(t.toLowerCase()))) || null;
    const colSeg    = findKey('seguradora','seguradoras','seguro','companhia');
    const colStatus = findKey('status','observ','obs','situac');
    const colLimite = findKey('capacidade total','limite total','total','limite');
    const colModal  = findKey('modalidade','modal');
    const colValMod = findKey('limite','valor');
    if (!colSeg || !colStatus) return null;
    const rows = jsonRows
      .filter(r => r[colSeg] && String(r[colSeg]).trim())
      .map(r => ({
        seguradora: String(r[colSeg]).trim(),
        status: normalizeStatus(String(r[colStatus] || '')),
        limite: parseNum(colLimite ? r[colLimite] : 0),
        modalidade: colModal ? String(r[colModal]||'').trim() : '',
        valorModal: colValMod ? parseNum(r[colValMod]) : 0,
      }))
      .filter(r => r.seguradora && r.status !== 'vazio');
    return { rows, tomador, cnpj };
  }

  // â”€â”€ Parse data rows
  const rows = [];
  let currentSeg = null;
  let currentStatus = 'vazio';
  let currentLimite = 0;

  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row.every(c => c === null || c === '')) continue;

    const cellSeg = colIdxSeg >= 0 ? String(row[colIdxSeg] || '').trim() : '';
    const cellCap = colIdxCapTotal >= 0 ? row[colIdxCapTotal] : null;
    const cellModal = colIdxModal >= 0 ? String(row[colIdxModal] || '').trim() : '';
    const cellLimite = colIdxLimite >= 0 ? row[colIdxLimite] : null;
    const cellObs  = colIdxObs >= 0 ? String(row[colIdxObs] || '').trim() : '';
    const cellTaxa = colIdxTaxa >= 0 ? (row[colIdxTaxa] !== null && String(row[colIdxTaxa]).trim() !== '' ? row[colIdxTaxa] : null) : null; // preserve original type
    const cellVenc = colIdxVenc >= 0 ? (row[colIdxVenc] !== null && String(row[colIdxVenc]).trim() !== '' ? String(row[colIdxVenc]).trim() : null) : null;

    // Skip total/sum rows
    if (cellSeg.toUpperCase() === 'TOTAL') continue;

    if (cellSeg) {
      // New seguradora row
      currentSeg = cellSeg;
      currentLimite = parseNum(cellCap);
      currentStatus = normalizeStatus(cellObs);

      // Only add if has a status (skip empty-status rows like ALLIANZ with no data)
      if (currentStatus !== 'vazio') {
        rows.push({
          seguradora: currentSeg,
          status: currentStatus,
          limite: currentLimite,
          modalidade: cellModal,
          valorModal: parseNum(cellLimite),
          taxa: cellTaxa,
          venc: cellVenc,
        });
      }
    } else if (currentSeg && cellModal && currentStatus === 'aprovado') {
      rows.push({
        seguradora: currentSeg,
        status: '_modalidade',
        limite: 0,
        modalidade: cellModal,
        valorModal: parseNum(cellLimite),
        taxa: cellTaxa,
        venc: null,
      });
    }
  }

  // â”€â”€ Build final list: consolidate modalidades under each seguradora
  const consolidated = [];
  const seen = {};

  rows.forEach(r => {
    if (r.status === '_modalidade') {
      // Sub-row: attach to parent's modalidades array
      const parent = consolidated.find(c => c.seguradora === r.seguradora);
      if (parent && r.modalidade && r.valorModal > 0) {
        if (!parent.modalidades) parent.modalidades = [];
        // Avoid pushing if same label already exists (defensive dedup)
        const exists = parent.modalidades.some(m => m.label.toUpperCase().trim() === r.modalidade.toUpperCase().trim());
        if (!exists) {
          parent.modalidades.push({ label: r.modalidade, value: r.valorModal, taxa: r.taxa });
        }
      }
      return;
    }
    if (seen[r.seguradora]) return;
    seen[r.seguradora] = true;

    const entry = { ...r, modalidades: [] };
    // Push the main-row modalidade as the first entry of modalidades array
    if (r.modalidade && r.valorModal > 0) {
      entry.modalidades.push({ label: r.modalidade, value: r.valorModal, taxa: r.taxa });
    }
    entry.venc = r.venc || null;
    consolidated.push(entry);
  });

  if (!consolidated.length) return null;
  return { rows: consolidated, tomador, cnpj };
}

function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'vazio';
  if (s.includes('aprov')) return 'aprovado';
  if (s.includes('declin')) return 'declinado';
  if (s.includes('bloque')) return 'bloqueado';
  if (s.includes('concorr') || s.includes('nomeado') || s.includes('nomeada') || s.includes('nomeac')) return 'concorrente';
  if (s.includes('cobrei') || s.includes('aguard') || s.includes('solicit') || s.includes('enviado') || s.includes('demanda') || s.includes('erro')) return 'vazio';
  return 'vazio';
}

function parseNum(val) {
  if (val === null || val === undefined || val === '') return 0;
  // Already a number (Excel numeric cell): return as-is, don't reformat
  if (typeof val === 'number') return val;
  // String: parse Brazilian format "R$ 1.234,56" or "1.234,56"
  const s = String(val).trim();
  if (!s) return 0;
  let cleaned = s.replace(/[R$\s]/g,'');
  // If contains comma, it's BR format: "1.234,56" â†’ strip dots, replace comma with dot
  if (cleaned.includes(',')) {
    cleaned = cleaned.replace(/\./g,'').replace(',','.');
  }
  // Else: could be "1234.56" (US/raw) or "1.500" (BR thousand). Heuristic:
  // if exactly one dot followed by 1-2 digits at the end â†’ decimal; else thousands
  else if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    if (parts.length === 2 && parts[1].length <= 2) {
      // decimal point: keep as-is
    } else {
      cleaned = cleaned.replace(/\./g,'');
    }
  }
  return parseFloat(cleaned) || 0;
}

// â”€â”€ Generate dashboard
function generateDashboard() {
  if (!parsedData) return;
  const generateButton = document.getElementById('btnGenerate');
  generateButton.classList.add('is-loading');
  generateButton.disabled = true;
  const { rows, tomador, cnpj } = parsedData;

  // Sort: approved > concorrente > declined > other
  const order = { aprovado: 0, concorrente: 1, bloqueado: 2, declinado: 3, outro: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.limite - a.limite);

  const aprovadas  = rows.filter(r => r.status === 'aprovado');
  const declinadas = rows.filter(r => r.status === 'declinado');
  const concorr    = rows.filter(r => r.status === 'concorrente');
  const bloqueadas = rows.filter(r => r.status === 'bloqueado');

  const totalAprov = aprovadas.reduce((s, r) => s + r.limite, 0);
  const maxLimite  = aprovadas.length ? Math.max(...aprovadas.map(r => r.limite)) : 0;
  const maxSeg     = aprovadas.filter(r => r.limite === maxLimite).map(r => r.seguradora).join(' · ');

  // Date
  const now = new Date();
  const opts = { day:'2-digit', month:'long', year:'numeric' };
  const dateStr = now.toLocaleDateString('pt-BR', opts);
  document.getElementById('dDate').textContent = 'Gerado em ' + dateStr;
  document.getElementById('dFooterDate').textContent = dateStr;
  if (tomador) document.getElementById('dTomador').textContent = tomador;
  document.getElementById('dCnpj').textContent = cnpj ? 'CNPJ ' + cnpj : 'CNPJ -';

  // KPIs
  document.getElementById('kAprov').textContent = aprovadas.length;
  document.getElementById('kDecl').textContent = declinadas.length;
  document.getElementById('kDecl').parentElement.querySelector('.kpi-sub').textContent = 
    bloqueadas.length > 0 ? `sem disponibilidade · ${bloqueadas.length} bloqueada${bloqueadas.length > 1 ? 's' : ''}` : 'sem disponibilidade';
  document.getElementById('kConc').textContent = concorr.length;
  document.getElementById('kSum').textContent = totalAprov >= 1e6 ? 'R$ ' + (totalAprov/1e6).toFixed(0) + 'MM' : fmtBRL(totalAprov);
  document.getElementById('kSumFull').textContent = fmtBRL(totalAprov);
  document.getElementById('kMax').textContent = maxLimite >= 1e6 ? 'R$ ' + (maxLimite/1e6).toFixed(0) + 'MM' : fmtBRL(maxLimite);
  document.getElementById('kMaxSub').textContent = maxSeg || '—';

  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';
  const tableEmpty = document.getElementById('tableEmpty');
  const tableCount = document.getElementById('tableCount');
  if (tableCount) tableCount.textContent = `${rows.length} seguradora${rows.length === 1 ? '' : 's'}`;
  if (tableEmpty) tableEmpty.hidden = rows.length > 0;
  if (!rows.length) {
    tbody.innerHTML = '';
  }
  let lastStatus = null;
  rows.forEach(r => {
    if (lastStatus && lastStatus !== r.status) {
      const sep = document.createElement('tr');
      sep.className = 'group-divider';
      sep.setAttribute('aria-hidden', 'true');
      sep.innerHTML = `<td colspan="5"><span class="group-divider-label">${statusLabel(r.status)}</span></td>`;
      tbody.appendChild(sep);
    }
    lastStatus = r.status;

    const badge = badgeHTML(r.status);

    if (r.status === 'aprovado') {
      // modalidades array already contains the main-row modalidade as first item
      const modLines = r.modalidades && r.modalidades.length > 0
        ? r.modalidades.slice()
        : [{ label: '—', value: r.limite, taxa: r.taxa }];

      modLines.forEach((m, i) => {
        const tr = document.createElement('tr');
        if (i === modLines.length - 1) tr.classList.add('row-last-in-group');
        const segCell = i === 0
          ? `<td class="cell-seguradora" rowspan="${modLines.length}">${esc(r.seguradora)}</td><td class="cell-status" rowspan="${modLines.length}">${badge}</td>`
          : '';
        const limiteStr = m.value > 0 ? fmtBRL(m.value) : '—';
        const taxaStr = (m.taxa !== null && m.taxa !== undefined && m.taxa !== '' && m.taxa !== 0 && m.taxa !== '0' && m.taxa !== '0%')
          ? formatTaxaDisplay(m.taxa)
          : '—';
        tr.innerHTML = `${segCell}<td class="cell-modalidade">${esc(m.label)}</td><td class="cell-limite ${limiteStr === '—' ? 'cell-empty' : ''}">${limiteStr}</td><td class="cell-taxa ${taxaStr === '—' ? 'cell-taxa--empty' : ''}">${taxaStr}</td>`;
        tbody.appendChild(tr);
      });

    } else {
      // Concorrente / Declinado â€” single row, no modalidade data
      const tr = document.createElement('tr');
      tr.classList.add('row-last-in-group');
      tr.innerHTML = `<td class="cell-seguradora">${esc(r.seguradora)}</td><td class="cell-status">${badge}</td><td class="cell-modalidade cell-empty">—</td><td class="cell-limite cell-empty">—</td><td class="cell-taxa cell-taxa--empty">—</td>`;
      tbody.appendChild(tr);
    }
  });

  // Bar chart
  if (chartBarInst) chartBarInst.destroy();
  const barLabels = aprovadas.sort((a,b)=>b.limite-a.limite).map(r=>r.seguradora);
  const barData   = aprovadas.map(r=>r.limite);
  const brandBars = ['#192b24','#243d33','#2e5045','#5d756a','#8fa195','#cdad7d','#b8944f','#16a34a'];
  
  // Dynamic height: minimum 120px, 32px per bar
  const barChartEl = document.getElementById('chartBar');
  barChartEl.parentElement.style.height = Math.max(120, barLabels.length * 32) + 'px';
  
  chartBarInst = new Chart(barChartEl.getContext('2d'), {
    type: 'bar',
    data: {
      labels: barLabels.length ? barLabels : ['—'],
      datasets: [{ label: 'Limite Total (R$)', data: barData.length ? barData : [0], backgroundColor: barLabels.map((_,i)=>brandBars[i%brandBars.length]), borderWidth: 0, borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + fmtBRL(ctx.raw) } } },
      scales: {
        x: { border:{display:false}, grid:{color:'#e5e7eb'}, ticks: { callback: v => v >= 1e6 ? 'R$ '+(v/1e6).toFixed(0)+'MM' : fmtBRL(v), color:'#4b5563', font:{size:10} } },
        y: { border:{display:false}, grid:{display:false}, ticks:{font:{weight:'700',size:11},color:'#1a2533'} }
      }
    }
  });

  // Doughnut
  if (chartDoughnutInst) chartDoughnutInst.destroy();
  const dGroups = [aprovadas, concorr, bloqueadas, declinadas];
  const dAllLabels = ['Aprovado','Nomeada por outro corretor','Bloqueado','Declinado'];
  const dAllColors = ['#16a34a','#b45309','#6b7280','#dc2626'];
  const dData = dGroups.map(g=>g.length).filter((_,i)=>dGroups[i].length>0);
  const dLabels = dAllLabels.filter((_,i)=>dGroups[i].length>0);
  const dColors = dAllColors.filter((_,i)=>dGroups[i].length>0);
  chartDoughnutInst = new Chart(document.getElementById('chartDoughnut').getContext('2d'), {
    type: 'doughnut',
    data: { labels: dLabels, datasets: [{ data: dData, backgroundColor: dColors, borderWidth: 2, borderColor: '#ffffff', hoverOffset: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { position:'bottom', labels:{ padding:14, boxWidth:10, boxHeight:10, font:{size:11}, color:'#4b5563' } },
        tooltip: { callbacks: { label: ctx => ' '+ctx.label+': '+ctx.raw+' seguradoras' } }
      }
    }
  });

  // â”€â”€ Build modalidades index for search (from approved rows only)
  buildModalIndex(aprovadas);

  // Switch to dashboard tab
  const tabDash = document.getElementById('tab-dashboard'); const tabDash2 = document.querySelectorAll('.topbar-tab')[1];
  tabDash.disabled = false;
  tabDash.setAttribute('aria-disabled', 'false');
  tabDash.removeAttribute('title');
  const topDownload = document.getElementById('btnDownloadTop');
  if (topDownload) topDownload.hidden = false;
  if(tabDash2){
    tabDash2.disabled = false;
    tabDash2.setAttribute('aria-disabled', 'false');
  }
  generateButton.classList.remove('is-loading');
  generateButton.disabled = false;
  switchTab('dashboard');
}

// Download full dashboard (table + comparison if active) — max 2 pages
function downloadComparativo() {
  document.body.classList.add('pdf-report');
  const cleanup = () => {
    document.body.classList.remove('pdf-report');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

// Download comparison-only (header + winner cards + charts) — 1 page
function downloadComparativoOnly() {
  document.body.classList.add('pdf-comparison-only');
  const cleanup = () => {
    document.body.classList.remove('pdf-comparison-only');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

let chartModalLimiteInst = null, chartModalTaxaInst = null;
let searchSuggActive = -1;

function buildModalIndex(aprovadas) {
  allModalidades = [];
  const seen = new Set();

  aprovadas.forEach(seg => {
    const addEntry = (label, value, taxa) => {
      if (!label || !value || value <= 0) return; // skip empty/invalid
      const key = seg.seguradora + '|' + label.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      allModalidades.push({ label: label.toUpperCase().trim(), seguradora: seg.seguradora, value, taxa });
    };

    // Use ONLY the consolidated modalidades array â€” these have the per-modality values from LIMITE column.
    // Do NOT use seg.limite (CAPACIDADE TOTAL) as it represents the sum, not a single modality value.
    if (seg.modalidades && seg.modalidades.length > 0) {
      seg.modalidades.forEach(m => addEntry(m.label, m.value, m.taxa));
    } else if (seg.modalidade && seg.valorModal > 0) {
      // Fallback: only main row had a modalidade
      addEntry(seg.modalidade, seg.valorModal, seg.taxa);
    }
    // If approved but no modalidade detail at all, skip from search index
    // (it would be misleading to show CAPACIDADE TOTAL as if it were a modalidade limit)
  });
  // Clear search UI
  document.getElementById('modalSearchInput').value = '';
  document.getElementById('modalSearchInput').setAttribute('aria-expanded', 'false');
  document.getElementById('modalSearchResults').style.display = 'none';
  document.getElementById('modalSearchEmpty').style.display = 'block';
  document.getElementById('searchSuggestions').classList.remove('show');
  document.body.classList.remove('has-comparison');
}

function handleModalSearch(query) {
  const q = query.trim().toUpperCase();
  const sugg = document.getElementById('searchSuggestions');
  searchSuggActive = -1;

  if (!q) {
    sugg.classList.remove('show');
    document.getElementById('modalSearchInput').setAttribute('aria-expanded', 'false');
    document.getElementById('modalSearchResults').style.display = 'none';
    document.getElementById('modalSearchEmpty').style.display = 'block';
    return;
  }

  // Find unique matching modal labels
  const labels = [...new Set(allModalidades.map(m => m.label))].filter(l => l.includes(q)).sort();

  if (labels.length === 0) {
    sugg.innerHTML = '<div class="suggestion-item suggestion-item--empty" role="option" aria-selected="false">Nenhuma modalidade encontrada</div>';
    sugg.classList.add('show');
    document.getElementById('modalSearchInput').setAttribute('aria-expanded', 'true');
    return;
  }

  sugg.innerHTML = labels.map((l,i) => `<div class="suggestion-item" id="suggestion-${i}" role="option" aria-selected="false" data-idx="${i}" data-label="${l}" onmousedown="selectModal('${l}')">${l.charAt(0)+l.slice(1).toLowerCase()}</div>`).join('');
  sugg.classList.add('show');
  document.getElementById('modalSearchInput').setAttribute('aria-expanded', 'true');

  // Auto-render if exact match
  if (labels.length === 1 || labels.some(l => l === q)) {
    const exact = labels.find(l => l === q) || labels[0];
    renderModalComparison(exact);
  }
}

// Keyboard nav for suggestions
document.addEventListener('keydown', e => {
  const sugg = document.getElementById('searchSuggestions');
  if (!sugg.classList.contains('show')) return;
  const items = sugg.querySelectorAll('.suggestion-item[data-label]');
  if (e.key === 'ArrowDown') { searchSuggActive = Math.min(searchSuggActive+1, items.length-1); highlightSugg(items); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { searchSuggActive = Math.max(searchSuggActive-1, 0); highlightSugg(items); e.preventDefault(); }
  else if (e.key === 'Enter' && searchSuggActive >= 0) { selectModal(items[searchSuggActive].dataset.label); e.preventDefault(); }
  else if (e.key === 'Escape') {
    sugg.classList.remove('show');
    document.getElementById('modalSearchInput').setAttribute('aria-expanded', 'false');
    document.getElementById('modalSearchInput').removeAttribute('aria-activedescendant');
  }
});

function highlightSugg(items) {
  const input = document.getElementById('modalSearchInput');
  items.forEach((el, i) => {
    const isActive = i === searchSuggActive;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-selected', String(isActive));
    if (isActive) input.setAttribute('aria-activedescendant', el.id);
  });
}

function selectModal(label) {
  document.getElementById('modalSearchInput').value = label.charAt(0) + label.slice(1).toLowerCase();
  document.getElementById('searchSuggestions').classList.remove('show');
  document.getElementById('modalSearchInput').setAttribute('aria-expanded', 'false');
  document.getElementById('modalSearchInput').removeAttribute('aria-activedescendant');
  renderModalComparison(label);
}

function parseTaxa(t) {
  if (t === null || t === undefined || t === '') return null;
  const s = String(t).trim();
  if (!s || s === '***' || s === '-' || s === '0' || s === '0%' || s === ' ') return null;
  if (typeof t === 'number') {
    if (t === 0) return null;
    return t < 1 ? t * 100 : t;
  }
  if (s.includes('%')) {
    const n = parseFloat(s.replace('%','').replace(',','.').trim());
    return isNaN(n) || n === 0 ? null : n;
  }
  const n = parseFloat(s.replace(',','.'));
  if (isNaN(n) || n === 0) return null;
  return n < 1 ? n * 100 : n;
}

function formatTaxaDisplay(t) {
  if (t === null || t === undefined || t === '' || t === 0 || t === '0' || t === '0%' || t === '***' || t === ' ') return '—';
  if (typeof t === 'number') {
    const pct = t < 1 ? t * 100 : t;
    return pct.toFixed(2).replace('.',',') + '%';
  }
  const s = String(t).trim();
  if (s === '***' || s === '-' || !s) return '—';
  if (s.includes('%')) return s;
  const n = parseFloat(s.replace(',','.'));
  if (isNaN(n)) return s;
  const pct = n < 1 && n > 0 ? n * 100 : n;
  return pct.toFixed(2).replace('.',',') + '%';
}

function renderModalComparison(label) {
  const matches = allModalidades.filter(m => m.label === label);
  if (!matches.length) return;

  document.getElementById('modalSearchResults').style.display = 'block';
  document.getElementById('modalSearchEmpty').style.display = 'none';
  document.body.classList.add('has-comparison');

  const displayLabel = label.charAt(0) + label.slice(1).toLowerCase();
  document.getElementById('searchResultLabel').innerHTML = `Comparativo para modalidade: <span>${displayLabel}</span>`;
  document.getElementById('chartModalLimiteTitle').textContent = `Maior Limite — ${displayLabel}`;
  document.getElementById('chartModalTaxaTitle').textContent = `Menor Taxa — ${displayLabel}`;

  // Sort by limit desc
  const byLimite = [...matches].sort((a,b) => b.value - a.value);
  // Sort by taxa asc (only those with valid taxa)
  const withTaxa = matches.filter(m => parseTaxa(m.taxa) !== null).sort((a,b) => parseTaxa(a.taxa) - parseTaxa(b.taxa));

  // Dynamic heights based on item count (min 130px, 32px per bar)
  const limiteChartWrap = document.getElementById('chartModalLimite').parentElement;
  const taxaChartWrap   = document.getElementById('chartModalTaxa').parentElement;
  limiteChartWrap.style.height = Math.max(130, byLimite.length * 32) + 'px';
  taxaChartWrap.style.height   = Math.max(130, withTaxa.length * 32) + 'px';

  // Winner cards
  const wCards = document.getElementById('winnerCards');
  const winLimite = byLimite[0];
  const winTaxa = withTaxa[0] || null;

  wCards.innerHTML = `
    <div class="winner-card wc-limite">
      <div class="winner-card-eyebrow">Maior Limite Disponível</div>
      <div class="winner-card-seg">${esc(winLimite.seguradora)}</div>
      <div class="winner-card-value">${fmtBRL(winLimite.value)}</div>
      <div><span class="winner-card-badge wc-b-limite">${displayLabel}</span></div>
    </div>
    <div class="winner-card wc-taxa">
      <div class="winner-card-eyebrow">Menor Taxa</div>
      <div class="winner-card-seg">${winTaxa ? esc(winTaxa.seguradora) : '—'}</div>
      <div class="winner-card-value">${winTaxa ? formatTaxaDisplay(winTaxa.taxa) : 'Taxa não informada'}</div>
      <div><span class="winner-card-badge wc-b-taxa">${displayLabel}</span></div>
    </div>
  `;

  const brandBars = ['#192b24','#243d33','#2e5045','#5d756a','#8fa195','#cdad7d','#b8944f','#16a34a'];

  // Chart: Limite
  if (chartModalLimiteInst) chartModalLimiteInst.destroy();
  chartModalLimiteInst = new Chart(document.getElementById('chartModalLimite').getContext('2d'), {
    type: 'bar',
    data: {
      labels: byLimite.map(m => m.seguradora),
      datasets: [{
        label: 'Limite (R$)',
        data: byLimite.map(m => m.value),
        backgroundColor: byLimite.map((m,i) => i === 0 ? '#192b24' : brandBars[(i) % brandBars.length]),
        borderWidth: 0, borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend:{display:false}, tooltip:{ callbacks:{ label: ctx => ' ' + fmtBRL(ctx.raw) } } },
      scales: {
        x: { border:{display:false}, grid:{color:'#e5e7eb'}, ticks:{ callback: v => v>=1e6 ? 'R$ '+(v/1e6).toFixed(0)+'MM' : fmtBRL(v), color:'#4b5563', font:{size:10} } },
        y: { border:{display:false}, grid:{display:false}, ticks:{font:{weight:'700',size:11},color:'#1a2533'} }
      }
    }
  });

  // Chart: Taxa
  if (chartModalTaxaInst) chartModalTaxaInst.destroy();
  if (withTaxa.length > 0) {
    chartModalTaxaInst = new Chart(document.getElementById('chartModalTaxa').getContext('2d'), {
      type: 'bar',
      data: {
        labels: withTaxa.map(m => m.seguradora),
        datasets: [{
          label: 'Taxa (%)',
          data: withTaxa.map(m => parseTaxa(m.taxa)),
          backgroundColor: withTaxa.map((m,i) => i === 0 ? '#16a34a' : '#86efac'),
          borderWidth: 0, borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: { legend:{display:false}, tooltip:{ callbacks:{ label: ctx => ' ' + ctx.raw.toFixed(2).replace('.',',') + '%' } } },
        scales: {
          x: { border:{display:false}, grid:{color:'#e5e7eb'}, ticks:{ callback: v => v.toFixed(2).replace('.',',')+'%', color:'#4b5563', font:{size:10} } },
          y: { border:{display:false}, grid:{display:false}, ticks:{font:{weight:'700',size:11},color:'#1a2533'} }
        }
      }
    });
  } else {
    // No taxa data â€” show placeholder
    const ctx = document.getElementById('chartModalTaxa').getContext('2d');
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.font = '12px Inter, sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    ctx.fillText('Taxas não informadas para esta modalidade', ctx.canvas.width/2, ctx.canvas.height/2);
  }
}

// â”€â”€ Helpers
function fmtBRL(v) {
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function statusLabel(status) {
  if (status === 'aprovado') return 'Aprovado';
  if (status === 'declinado') return 'Declinado';
  if (status === 'concorrente') return 'Nomeada por outro corretor';
  if (status === 'bloqueado') return 'Bloqueado';
  return status || 'Outros';
}
function badgeHTML(status) {
  if (status === 'aprovado')    return '<span class="badge badge-aprovado">Aprovado</span>';
  if (status === 'declinado')   return '<span class="badge badge-declinado">Declinado</span>';
  if (status === 'concorrente') return '<span class="badge badge-concorrente">Nomeada por outro corretor</span>';
  if (status === 'bloqueado')   return '<span class="badge badge-bloqueado">Bloqueado</span>';
  return '<span class="badge badge-bloqueado">'+esc(status)+'</span>';
}
function showError(msg) {
  document.getElementById('errorText').textContent = msg;
  document.getElementById('errorMsg').classList.add('show');
  document.getElementById('dropZone').classList.remove('drop-zone--file-selected');
}
function hideError() { document.getElementById('errorMsg').classList.remove('show'); }

// â”€â”€ Chart defaults
Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = '#4b5563';

