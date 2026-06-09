// â"€â"€ State
let chartBarInst, chartDoughnutInst;
let parsedData = null;

// â"€â"€ Tab switching
function switchTab(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + tab).classList.add('active');
  document.querySelectorAll('.topbar-tab').forEach(t => {
    const pages = (t.dataset.pages || t.dataset.page || '').split(' ');
    const isActive = pages.includes(tab);
    t.classList.toggle('active', isActive);
    if (isActive) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
}

// â"€â"€ Drag & drop
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

// â"€â"€ Handle file selection
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

// â"€â"€ Parse workbook â€" handles the T&C Garantia specific format
// Structure: header row contains SEGURADORAS / CAPACIDADE TOTAL / MODALIDADE / LIMITE / TAXA / OBSERVAÃ‡ÃƒO
// Status is in OBSERVAÃ‡ÃƒO column. Sub-rows (no seguradora name) = additional modalidades for previous insurer.
// Tomador is in row with label "TOMADOR"
function parseWorkbook(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];

  // Read as array of arrays to handle merged cells and irregular layout
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  if (!raw.length) return null;

  // â"€â"€ Extract tomador / CNPJ from early rows
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

  // â"€â"€ Find header row (contains "SEGURADORAS" or "SEGURADORA")
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

  // â"€â"€ Parse data rows
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

  // â"€â"€ Build final list: consolidate modalidades under each seguradora
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
  // If contains comma, it's BR format: "1.234,56" â†' strip dots, replace comma with dot
  if (cleaned.includes(',')) {
    cleaned = cleaned.replace(/\./g,'').replace(',','.');
  }
  // Else: could be "1234.56" (US/raw) or "1.500" (BR thousand). Heuristic:
  // if exactly one dot followed by 1-2 digits at the end â†' decimal; else thousands
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

// â"€â"€ Generate dashboard
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
      // Concorrente / Declinado â€" single row, no modalidade data
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

  // â"€â"€ Build modalidades index for search (from approved rows only)
  buildModalIndex(aprovadas);

  // Switch to dashboard tab
  const topDownload = document.getElementById('btnDownloadTop');
  if (topDownload) topDownload.hidden = false;
  generateButton.classList.remove('is-loading');
  generateButton.disabled = false;
  switchTab('dashboard');
}

// Captura o #page-dashboard e cria página com altura exata do conteúdo
async function gerarPdf(filename) {
  const el = document.getElementById('page-dashboard');

  const canvas = await html2canvas(el, {
    scale: 2,
    useCORS: true,
    allowTaint: false,
    logging: false,
    scrollX: 0,
    scrollY: 0
  });

  const imgData = canvas.toDataURL('image/jpeg', 0.98);
  const { jsPDF } = window.jspdf;

  // Largura fixa = 297mm (A4 landscape); altura proporcional ao conteúdo
  const pW = 297;
  const pH = parseFloat(((canvas.height / canvas.width) * pW).toFixed(2));

  const pdf = new jsPDF({ unit: 'mm', format: [pW, pH] });
  pdf.addImage(imgData, 'JPEG', 0, 0, pW, pH);
  pdf.save(filename);
}

// Download full dashboard (tabela + comparativo se ativo) — 1 página
async function downloadComparativo() {
  const btn = document.getElementById('btnDownloadTop');
  const saved = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Gerando PDF…'; }

  document.body.classList.add('pdf-generating');
  await new Promise(r => setTimeout(r, 150));

  try {
    await gerarPdf('relatorio-lavoro.pdf');
  } finally {
    document.body.classList.remove('pdf-generating');
    if (btn) { btn.disabled = false; btn.innerHTML = saved; }
  }
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

    // Use ONLY the consolidated modalidades array â€" these have the per-modality values from LIMITE column.
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
    // No taxa data â€" show placeholder
    const ctx = document.getElementById('chartModalTaxa').getContext('2d');
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.font = '12px Inter, sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    ctx.fillText('Taxas não informadas para esta modalidade', ctx.canvas.width/2, ctx.canvas.height/2);
  }
}

// â"€â"€ Helpers
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

// ── Seguro Garantia & Fiança Locatícia State
let garantiaFiles = [];
let fiancaFiles = [];
let sgChatHistory = [];
let sgFirstAnalysis = true;
const MAX_CONTRATO_FILES = 10;
const CONTRATO_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'xlsx', 'xls', 'csv'];

const FL_DADOS_CONFIG = [
  { key: 'imovel',          label: 'Imóvel' },
  { key: 'locatario',       label: 'Locatário' },
  { key: 'locador',         label: 'Locador' },
  { key: 'finalidade',      label: 'Finalidade' },
  { key: 'valor_aluguel',   label: 'Valor do Aluguel',    format: 'brl' },
  { key: 'encargos_mensais',label: 'Encargos Mensais' },
  { key: 'valor_garantia',  label: 'Valor da Garantia',   format: 'brl' },
  { key: 'vigencia_inicio', label: 'Início da Vigência' },
  { key: 'vigencia_fim',    label: 'Fim da Vigência' },
  { key: 'indice_reajuste', label: 'Índice de Reajuste' },
  { key: 'multa_rescisao',  label: 'Multa por Rescisão' },
  { key: 'sub_rogacao',     label: 'Sub-rogação' },
  { key: 'foro',            label: 'Foro de Eleição' },
];

// ── File handlers shared util
function handleContratoFiles(files, fileArray, maxFiles, extensions, listId, btnId, errShowFn, errHideFn) {
  errHideFn();
  for (const file of files) {
    if (fileArray.length >= maxFiles) {
      errShowFn('Limite de ' + maxFiles + ' arquivos atingido.');
      break;
    }
    const ext = file.name.split('.').pop().toLowerCase();
    if (!extensions.includes(ext)) {
      errShowFn('Formato não suportado: .' + ext);
      continue;
    }
    if (fileArray.some(f => f.name === file.name && f.size === file.size)) continue;
    fileArray.push(file);
  }
  renderContratoFileList(fileArray, listId, fileArray === garantiaFiles ? 'garantia' : 'fianca');
  document.getElementById(btnId).disabled = fileArray.length === 0;
}

function renderContratoFileList(fileArray, listId, tipo) {
  const list = document.getElementById(listId);
  if (!list) return;
  if (fileArray.length === 0) { list.innerHTML = ''; return; }
  list.innerHTML = fileArray.map((file, i) => `
    <div class="financial-file-item">
      <div class="financial-file-icon ${getFileIconClass(file)}">${getFileIconLabel(file)}</div>
      <div class="financial-file-info">
        <p class="financial-file-name" title="${esc(file.name)}">${esc(file.name)}</p>
        <p class="financial-file-meta">${(file.size / 1024).toFixed(1)} KB</p>
      </div>
      <button type="button" class="financial-file-remove" onclick="removeContratoFile('${tipo}',${i})" aria-label="Remover ${esc(file.name)}">
        <svg viewBox="0 0 16 16" fill="none"><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>`).join('');
}

function removeContratoFile(tipo, index) {
  if (tipo === 'garantia') {
    garantiaFiles.splice(index, 1);
    renderContratoFileList(garantiaFiles, 'garantiaFileList', 'garantia');
    document.getElementById('btnAnalyzeGarantia').disabled = garantiaFiles.length === 0;
    hideGarantiaError();
  } else {
    fiancaFiles.splice(index, 1);
    renderContratoFileList(fiancaFiles, 'fiancaFileList', 'fianca');
    document.getElementById('btnAnalyzeFianca').disabled = fiancaFiles.length === 0;
    hideFiancaError();
  }
}

// Garantia drop zone
const dzGarantia = document.getElementById('dropZoneGarantia');
const fileInputGarantia = document.getElementById('fileInputGarantia');
if (fileInputGarantia) {
  fileInputGarantia.addEventListener('change', function() {
    handleContratoFiles(Array.from(this.files), garantiaFiles, MAX_CONTRATO_FILES, CONTRATO_EXTENSIONS, 'garantiaFileList', 'btnAnalyzeGarantia', showGarantiaError, hideGarantiaError);
    this.value = '';
  });
}
if (dzGarantia) {
  dzGarantia.addEventListener('dragover', e => { e.preventDefault(); dzGarantia.classList.add('drop-zone--over'); });
  dzGarantia.addEventListener('dragleave', () => dzGarantia.classList.remove('drop-zone--over'));
  dzGarantia.addEventListener('drop', e => {
    e.preventDefault(); dzGarantia.classList.remove('drop-zone--over');
    handleContratoFiles(Array.from(e.dataTransfer.files), garantiaFiles, MAX_CONTRATO_FILES, CONTRATO_EXTENSIONS, 'garantiaFileList', 'btnAnalyzeGarantia', showGarantiaError, hideGarantiaError);
  });
}

// Fianca drop zone
const dzFianca = document.getElementById('dropZoneFianca');
const fileInputFianca = document.getElementById('fileInputFianca');
if (fileInputFianca) {
  fileInputFianca.addEventListener('change', function() {
    handleContratoFiles(Array.from(this.files), fiancaFiles, MAX_CONTRATO_FILES, CONTRATO_EXTENSIONS, 'fiancaFileList', 'btnAnalyzeFianca', showFiancaError, hideFiancaError);
    this.value = '';
  });
}
if (dzFianca) {
  dzFianca.addEventListener('dragover', e => { e.preventDefault(); dzFianca.classList.add('drop-zone--over'); });
  dzFianca.addEventListener('dragleave', () => dzFianca.classList.remove('drop-zone--over'));
  dzFianca.addEventListener('drop', e => {
    e.preventDefault(); dzFianca.classList.remove('drop-zone--over');
    handleContratoFiles(Array.from(e.dataTransfer.files), fiancaFiles, MAX_CONTRATO_FILES, CONTRATO_EXTENSIONS, 'fiancaFileList', 'btnAnalyzeFianca', showFiancaError, hideFiancaError);
  });
}

function showGarantiaError(msg) {
  const el = document.getElementById('errorMsgGarantia');
  const tx = document.getElementById('errorTextGarantia');
  if (el && tx) { tx.textContent = msg; el.classList.add('show'); }
}
function hideGarantiaError() {
  const el = document.getElementById('errorMsgGarantia');
  if (el) el.classList.remove('show');
}
function showFiancaError(msg) {
  const el = document.getElementById('errorMsgFianca');
  const tx = document.getElementById('errorTextFianca');
  if (el && tx) { tx.textContent = msg; el.classList.add('show'); }
}
function hideFiancaError() {
  const el = document.getElementById('errorMsgFianca');
  if (el) el.classList.remove('show');
}

// ── Process functions
async function processarSeguroGarantia() {
  if (garantiaFiles.length === 0) return;
  const btn = document.getElementById('btnAnalyzeGarantia');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = 'Analisando…';
  hideGarantiaError();

  document.getElementById('sgUploadSection').hidden = true;
  document.getElementById('sgLoading').hidden = false;
  document.getElementById('sgChatArea').hidden = true;
  sgFirstAnalysis = true;
  const _sgExportBtn = document.getElementById('sgExportBtn');
  if (_sgExportBtn) _sgExportBtn.hidden = true;
  document.getElementById('sgChatMessages').innerHTML = '';

  try {
    const respText = await analisarSeguroGarantia(garantiaFiles);
    sgChatHistory = criarHistoricoSeguroGarantia(garantiaFiles, respText);

    const title = garantiaFiles.length === 1 ? garantiaFiles[0].name : garantiaFiles.length + ' documentos analisados';
    const files = garantiaFiles.map(f => f.name).join(' · ');
    document.getElementById('sgChatTitle').textContent = title;
    document.getElementById('sgChatFiles').textContent = files;

    document.getElementById('sgLoading').hidden = true;
    document.getElementById('sgChatArea').hidden = false;
    appendSgChatMessage('assistant', respText);
  } catch (err) {
    document.getElementById('sgLoading').hidden = true;
    document.getElementById('sgUploadSection').hidden = false;
    showGarantiaError('Erro ao analisar: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = 'Analisar com IA';
  }
}

function resetSeguroGarantia() {
  garantiaFiles = [];
  sgChatHistory = [];
  sgFirstAnalysis = true;
  renderContratoFileList(garantiaFiles, 'garantiaFileList', 'garantia');
  document.getElementById('btnAnalyzeGarantia').disabled = true;
  document.getElementById('sgChatArea').hidden = true;
  document.getElementById('sgUploadSection').hidden = false;
  document.getElementById('sgChatMessages').innerHTML = '';
  const exportBtn = document.getElementById('sgExportBtn');
  if (exportBtn) exportBtn.hidden = true;
  hideGarantiaError();
}

async function sendSgChatMessage() {
  const input = document.getElementById('sgChatInput');
  const text = input.value.trim();
  if (!text || sgChatHistory.length === 0) return;

  input.value = '';
  appendSgChatMessage('user', text);
  sgChatHistory.push({ role: 'user', content: text });

  const sendBtn = document.getElementById('sgChatSend');
  sendBtn.disabled = true;
  input.disabled = true;

  const messagesEl = document.getElementById('sgChatMessages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'sg-chat-msg sg-chat-msg--ai sg-chat-typing';
  typingDiv.innerHTML = '<div class="sg-chat-dots"><span></span><span></span><span></span></div>';
  messagesEl.appendChild(typingDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const respText = await chatSeguroGarantia(sgChatHistory);
    sgChatHistory.push({ role: 'assistant', content: respText });
    typingDiv.remove();
    appendSgChatMessage('assistant', respText);
  } catch (err) {
    typingDiv.remove();
    appendSgChatMessage('assistant', 'Erro ao processar resposta: ' + esc(err.message));
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

function appendSgChatMessage(role, text) {
  const messagesEl = document.getElementById('sgChatMessages');

  if (role === 'user' && !sgFirstAnalysis && !messagesEl.querySelector('.sg-chat-divider')) {
    const divider = document.createElement('div');
    divider.className = 'sg-chat-divider';
    divider.textContent = 'Perguntas sobre a análise';
    messagesEl.appendChild(divider);
  }

  const div = document.createElement('div');
  if (role === 'assistant' && sgFirstAnalysis) {
    div.className = 'sg-report-wrapper';
    div.innerHTML = renderSeguroGarantiaReport(text);
    sgFirstAnalysis = false;
    const exportBtn = document.getElementById('sgExportBtn');
    if (exportBtn) exportBtn.hidden = false;
  } else {
    div.className = 'sg-chat-msg ' + (role === 'user' ? 'sg-chat-msg--user' : 'sg-chat-msg--ai');
    div.innerHTML = role === 'assistant' ? renderMarkdown(text) : '<p>' + esc(text) + '</p>';
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMarkdown(text) {
  const lines = esc(text).split('\n');
  let html = '';
  let inPara = false;

  const inline = s =>
    s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
     .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  for (const rawLine of lines) {
    const line = inline(rawLine);
    const trimmed = line.trim();

    if (!trimmed) {
      if (inPara) { html += '</p>'; inPara = false; }
      continue;
    }
    if (trimmed.startsWith('### ')) {
      if (inPara) { html += '</p>'; inPara = false; }
      html += '<h4 class="sg-md-h4">' + trimmed.slice(4) + '</h4>';
    } else if (trimmed.startsWith('## ')) {
      if (inPara) { html += '</p>'; inPara = false; }
      html += '<h3 class="sg-md-h3">' + trimmed.slice(3) + '</h3>';
    } else if (trimmed.startsWith('# ')) {
      if (inPara) { html += '</p>'; inPara = false; }
      html += '<h3 class="sg-md-h3">' + trimmed.slice(2) + '</h3>';
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (inPara) { html += '</p>'; inPara = false; }
      html += '<div class="sg-md-li">' + trimmed.slice(2) + '</div>';
    } else if (/^\d+\. /.test(trimmed)) {
      if (inPara) { html += '</p>'; inPara = false; }
      html += '<div class="sg-md-li">' + trimmed.replace(/^\d+\. /, '') + '</div>';
    } else {
      if (!inPara) { html += '<p class="sg-md-p">'; inPara = true; }
      else html += '<br>';
      html += line;
    }
  }

  if (inPara) html += '</p>';
  return html || '<p></p>';
}

// ── Seguro Garantia Report Renderer ──────────────────────────────────────

function renderSeguroGarantiaReport(text) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  const docTitle = document.getElementById('sgChatTitle').textContent || 'Análise de Contrato';
  const filesText = document.getElementById('sgChatFiles').textContent || '';

  const sections = parseReportSections(text);
  const parecerSec = sections.find(s => s.title && /parecer/i.test(s.title));
  const verdict = parecerSec ? detectVerdictFromText(parecerSec.content) : null;

  const verdictHtml = verdict ? `
    <div class="sg-report-verdict-badge sg-report-verdict-badge--${verdict.cls}">
      <span class="sg-report-verdict-icon">${verdict.icon}</span>
      <span>${esc(verdict.label)}</span>
    </div>` : '';

  return `
    <div class="sg-report" id="sgReportContent">
      <div class="sg-report-masthead">
        <div class="sg-report-masthead-left">
          <p class="sg-report-eyebrow">Análise Técnica · Seguro Garantia IA</p>
          <h2 class="sg-report-doc-title">${esc(docTitle)}</h2>
          ${filesText && filesText !== docTitle ? `<p class="sg-report-files-label">${esc(filesText)}</p>` : ''}
        </div>
        <div class="sg-report-masthead-right">
          ${verdictHtml}
          <p class="sg-report-gen-date">Gerado em ${dateStr}</p>
        </div>
      </div>
      <div class="sg-report-sections">
        ${sections.map(renderReportSection).join('')}
      </div>
    </div>`;
}

function parseReportSections(text) {
  const sections = [];
  let current = null;

  for (const line of (text || '').split('\n')) {
    if (/^##\s+/.test(line)) {
      if (current !== null) sections.push({ ...current, content: current.lines.join('\n').trim() });
      current = { title: line.replace(/^##\s+/, '').trim(), lines: [] };
    } else if (/^#\s+/.test(line)) {
      // skip root-level title
    } else {
      if (current === null) current = { title: null, lines: [] };
      current.lines.push(line);
    }
  }
  if (current !== null) sections.push({ ...current, content: current.lines.join('\n').trim() });
  return sections.filter(s => s.title || (s.content && s.content.trim()));
}

function getSectionMeta(title) {
  if (!title) return { type: 'default' };
  const t = title.toLowerCase();
  if (t.includes('partes') || t.includes('dados gerais') || t.includes('dados g')) return { type: 'dados' };
  if (t.includes('modalidades') || t.includes('modalidade')) return { type: 'modalidades' };
  if (t.includes('clausulas') || t.includes('cláusulas') || t.includes('criticas') || t.includes('críticas')) return { type: 'clausulas' };
  if (t.includes('riscos') || t.includes('risco')) return { type: 'riscos' };
  if (t.includes('parecer')) return { type: 'parecer' };
  if (t.includes('resumo')) return { type: 'resumo' };
  return { type: 'default' };
}

function getSectionSvgIcon(type) {
  const icons = {
    dados:       '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 3L2 8v9h5v-5h6v5h5V8L10 3z" stroke-linejoin="round"/></svg>',
    modalidades: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 2L3 6v5c0 4.4 3.1 7.6 7 8 3.9-.4 7-3.6 7-8V6L10 2z" stroke-linejoin="round"/></svg>',
    clausulas:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="2" width="12" height="16" rx="1.5"/><path d="M7 7h6M7 10.5h6M7 14h3" stroke-linecap="round"/></svg>',
    riscos:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 3L2 17h16L10 3z" stroke-linejoin="round"/><path d="M10 10v3M10 15h.01" stroke-linecap="round"/></svg>',
    parecer:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="7"/><path d="M7 10l2.5 2.5L14 8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    resumo:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="2" width="12" height="16" rx="1.5"/><path d="M7 7h6M7 10.5h6M7 14h4" stroke-linecap="round"/></svg>',
    default:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="2" width="12" height="16" rx="1.5"/><path d="M7 8h6M7 12h4" stroke-linecap="round"/></svg>',
  };
  return icons[type] || icons.default;
}

function detectVerdictFromText(text) {
  const l = (text || '').toLowerCase();
  if (l.includes('declinar')) return { cls: 'declinar', label: 'Declinar', icon: '✕' };
  if (l.includes('ressalvas')) return { cls: 'ressalvas', label: 'Emitir com Ressalvas', icon: '!' };
  if (l.includes('emitir')) return { cls: 'emitir', label: 'Emitir', icon: '✓' };
  return null;
}

function renderReportSection(section) {
  if (!section.title && !section.content.trim()) return '';
  const meta = getSectionMeta(section.title);
  const bodyHtml = renderReportMarkdown(section.content);
  return `
    <div class="sg-report-section sg-report-section--${meta.type}">
      ${section.title ? `
      <div class="sg-report-section-head">
        <div class="sg-report-section-icon sg-report-icon--${meta.type}">${getSectionSvgIcon(meta.type)}</div>
        <h3 class="sg-report-section-title">${esc(section.title)}</h3>
      </div>` : ''}
      <div class="sg-report-section-body">${bodyHtml}</div>
    </div>`;
}

function renderReportMarkdown(text) {
  if (!text) return '';
  const lines = text.split('\n');
  let html = '';
  let inPara = false;
  let tableLines = [];

  const inlineFormat = s => {
    let r = esc(s);
    r = r.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    r = r.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return r;
  };

  const flushTable = () => {
    if (!tableLines.length) return;
    const parseRow = row => row.split('|').map(c => c.trim()).filter((c, i, a) =>
      !(i === 0 && !c) && !(i === a.length - 1 && !c)
    );
    const isSep = r => /^[\s|:\-]+$/.test(r);
    const headerCells = parseRow(tableLines[0]);
    const dataRows = tableLines.slice(2).filter(l => !isSep(l)).map(parseRow).filter(r => r.length);
    if (!headerCells.length) { tableLines = []; return; }
    html += '<div class="sg-md-table-wrap"><table class="sg-md-table">';
    html += '<thead><tr>' + headerCells.map(h => '<th>' + inlineFormat(h) + '</th>').join('') + '</tr></thead>';
    if (dataRows.length) {
      html += '<tbody>' + dataRows.map(r => '<tr>' + r.map(c => '<td>' + inlineFormat(c) + '</td>').join('') + '</tr>').join('') + '</tbody>';
    }
    html += '</table></div>';
    tableLines = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('|')) {
      if (inPara) { html += '</p>'; inPara = false; }
      tableLines.push(trimmed);
      continue;
    }
    if (tableLines.length) flushTable();

    if (!trimmed) {
      if (inPara) { html += '</p>'; inPara = false; }
      continue;
    }
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      if (inPara) { html += '</p>'; inPara = false; }
      html += '<hr class="sg-md-hr">';
      continue;
    }

    const inl = inlineFormat(rawLine);
    const trim2 = inl.trim();

    if (trim2.startsWith('### ')) {
      if (inPara) { html += '</p>'; inPara = false; }
      html += '<h4 class="sg-md-h4">' + trim2.slice(4) + '</h4>';
    } else if (trim2.startsWith('## ')) {
      if (inPara) { html += '</p>'; inPara = false; }
      html += '<h3 class="sg-md-h3">' + trim2.slice(3) + '</h3>';
    } else if (trim2.startsWith('- ') || trim2.startsWith('* ')) {
      if (inPara) { html += '</p>'; inPara = false; }
      html += '<div class="sg-md-li">' + trim2.slice(2) + '</div>';
    } else if (/^\d+\.\s/.test(trim2)) {
      if (inPara) { html += '</p>'; inPara = false; }
      html += '<div class="sg-md-li">' + trim2.replace(/^\d+\.\s/, '') + '</div>';
    } else {
      if (!inPara) { html += '<p class="sg-md-p">'; inPara = true; }
      else html += '<br>';
      html += inl;
    }
  }

  if (tableLines.length) flushTable();
  if (inPara) html += '</p>';
  return html;
}

async function downloadSgReport() {
  const btn = document.getElementById('sgExportBtn');
  const btnOrigHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Gerando PDF…'; }

  const el = document.getElementById('sgReportContent');
  if (!el) { if (btn) { btn.disabled = false; btn.innerHTML = btnOrigHTML; } return; }

  const messagesEl = document.getElementById('sgChatMessages');
  const prevOverflow = messagesEl ? messagesEl.style.overflow : '';
  if (messagesEl) messagesEl.style.overflow = 'visible';

  try {
    const canvas = await html2canvas(el, {
      scale: 1.5,
      useCORS: true,
      allowTaint: false,
      logging: false,
      backgroundColor: '#ffffff',
    });

    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = window.jspdf;
    const pageW = 210;
    const pageH = 297;
    const imgH = (canvas.height * pageW) / canvas.width;

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    let posY = 0;
    let remaining = imgH;

    pdf.addImage(imgData, 'JPEG', 0, posY, pageW, imgH);
    remaining -= pageH;

    while (remaining > 0) {
      posY -= pageH;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, posY, pageW, imgH);
      remaining -= pageH;
    }

    const rawTitle = document.getElementById('sgChatTitle').textContent || 'relatorio-seguro-garantia';
    const safeTitle = rawTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim() || 'relatorio-seguro-garantia';
    pdf.save(safeTitle + '.pdf');
  } catch (err) {
    console.error('Erro ao gerar PDF do Seguro Garantia:', err);
  } finally {
    if (messagesEl) messagesEl.style.overflow = prevOverflow;
    if (btn) { btn.disabled = false; btn.innerHTML = btnOrigHTML; }
  }
}

let flChatHistory = [];
let flFirstAnalysis = true;
let flAnaliseData = null;

async function processarFiancaLocaticia() {
  if (fiancaFiles.length === 0) return;
  const btn = document.getElementById('btnAnalyzeFianca');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = 'Analisando…';
  hideFiancaError();

  document.getElementById('flUploadSection').hidden = true;
  document.getElementById('flLoading').hidden = false;
  document.getElementById('flChatArea').hidden = true;
  flFirstAnalysis = true;
  flChatHistory = [];
  document.getElementById('flChatMessages').innerHTML = '';
  const flExportBtn = document.getElementById('flExportBtn');
  if (flExportBtn) flExportBtn.hidden = true;

  try {
    const resultado = await analisarFiancaLocaticia(fiancaFiles);
    flAnaliseData = resultado;
    renderFiancaLocaticia(resultado);
  } catch (err) {
    document.getElementById('flLoading').hidden = true;
    document.getElementById('flUploadSection').hidden = false;
    showFiancaError('Erro ao analisar: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = 'Analisar com IA';
  }
}

function resetFiancaLocaticia() {
  fiancaFiles = [];
  flChatHistory = [];
  flFirstAnalysis = true;
  flAnaliseData = null;
  renderContratoFileList(fiancaFiles, 'fiancaFileList', 'fianca');
  document.getElementById('btnAnalyzeFianca').disabled = true;
  document.getElementById('flChatArea').hidden = true;
  document.getElementById('flUploadSection').hidden = false;
  document.getElementById('flChatMessages').innerHTML = '';
  const exportBtn = document.getElementById('flExportBtn');
  if (exportBtn) exportBtn.hidden = true;
  hideFiancaError();
}

// ── Render functions
function renderFiancaLocaticia(data) {
  document.getElementById('flLoading').hidden = true;
  document.getElementById('flChatArea').hidden = false;

  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  const dados = data.dados_gerais || {};
  const locatario = (dados.locatario && dados.locatario.valor && dados.locatario.valor !== 'null') ? dados.locatario.valor : 'Análise Fiança Locatícia';
  const imovel = (dados.imovel && dados.imovel.valor && dados.imovel.valor !== 'null') ? dados.imovel.valor : '';
  const filesText = fiancaFiles.map(f => f.name).join(' · ');

  document.getElementById('flChatTitle').textContent = locatario || 'Análise de Locação';
  document.getElementById('flChatFiles').textContent = filesText;

  // Build chat history context
  flChatHistory = criarHistoricoFiancaLocaticia(fiancaFiles, JSON.stringify(data));

  // Render as first chat message
  const reportHtml = buildFlReportHtml(data, locatario, imovel, dateStr);
  appendFlChatMessage('report', reportHtml);

  const exportBtn = document.getElementById('flExportBtn');
  if (exportBtn) exportBtn.hidden = false;
}

// ── Shared builder for both contractual analysis types
function buildAnaliseContratualHTML(data, dadosConfig) {
  const dados = data.dados_gerais || {};
  const clausulas = data.clausulas_criticas || [];
  const riscos = data.riscos || [];
  const parecer = data.parecer || {};
  const docs = data.documentos_analisados || [];

  const dadosItens = dadosConfig
    .map(cfg => buildDadoItem(cfg.label, dados[cfg.key], cfg.format))
    .filter(h => h)
    .join('');

  const clausulasHtml = clausulas.length > 0
    ? clausulas.map(buildClausulaItem).join('')
    : '<p class="af-no-data">Nenhuma cláusula crítica identificada.</p>';

  const riscosHtml = riscos.length > 0
    ? riscos.map(buildRiscoItem).join('')
    : '<p class="af-no-data">Nenhum risco identificado.</p>';

  const docsHtml = docs.length > 0
    ? docs.map(d => `<span class="sg-doc-badge">${esc(d)}</span>`).join('')
    : '';

  return `
    ${buildParecerHTML(parecer)}

    ${docsHtml ? `<div class="sg-docs-analisados">${docsHtml}</div>` : ''}

    <section class="dashboard-section">
      <h2 class="sec section-title">Dados do Contrato</h2>
      <div class="card sg-dados-card">
        ${dadosItens || '<p class="af-no-data">Dados não extraídos.</p>'}
      </div>
    </section>

    <section class="dashboard-section">
      <h2 class="sec section-title">Cláusulas Críticas</h2>
      <div class="sg-clausulas-list">${clausulasHtml}</div>
    </section>

    <section class="dashboard-section">
      <h2 class="sec section-title">Riscos Identificados</h2>
      <div class="sg-riscos-list">${riscosHtml}</div>
    </section>

    ${data.resumo ? `
    <section class="dashboard-section">
      <h2 class="sec section-title">Resumo Executivo</h2>
      <div class="card sg-resumo-card">
        <p class="sg-resumo-text">${esc(data.resumo)}</p>
      </div>
    </section>` : ''}
  `;
}

function buildDadoItem(label, item, format) {
  if (!item || item.valor === null || item.valor === undefined || item.valor === 'null' || String(item.valor).trim() === '') return '';
  let display = item.valor;
  if (format === 'brl' && typeof item.valor === 'number') display = fmtBRL(item.valor);
  return `
    <div class="sg-dado-item">
      <span class="sg-dado-label">${esc(label)}</span>
      <div class="sg-dado-right">
        <span class="sg-dado-valor">${esc(String(display))}</span>
        ${item.fonte ? `<span class="sg-dado-fonte"><span class="sg-fonte-arrow" aria-hidden="true">↳</span>${esc(item.fonte)}</span>` : ''}
      </div>
    </div>`;
}

function buildClausulaItem(item) {
  const impacto = item.impacto || '';
  const impClass = impacto === 'Alto' ? 'sg-impact--alto' : impacto === 'Médio' ? 'sg-impact--medio' : 'sg-impact--baixo';
  return `
    <div class="sg-clausula-item card">
      <div class="sg-clausula-top">
        <span class="sg-impact-badge ${impClass}">${esc(impacto)}</span>
        <strong class="sg-clausula-titulo">${esc(item.titulo || '')}</strong>
      </div>
      <p class="sg-clausula-desc">${esc(item.descricao || '')}</p>
      ${item.fonte ? `<span class="sg-item-fonte"><span class="sg-fonte-arrow" aria-hidden="true">↳</span>${esc(item.fonte)}</span>` : ''}
    </div>`;
}

function buildRiscoItem(item) {
  const nivel = item.nivel || '';
  const nivClass = nivel === 'Alto' ? 'sg-impact--alto' : nivel === 'Médio' ? 'sg-impact--medio' : 'sg-impact--baixo';
  return `
    <div class="sg-risco-item card">
      <div class="sg-risco-top">
        <span class="sg-impact-badge ${nivClass}">${esc(nivel)}</span>
        <p class="sg-risco-desc">${esc(item.descricao || '')}</p>
      </div>
      ${item.fonte ? `<span class="sg-item-fonte"><span class="sg-fonte-arrow" aria-hidden="true">↳</span>${esc(item.fonte)}</span>` : ''}
    </div>`;
}

function buildParecerHTML(parecer) {
  if (!parecer || !parecer.recomendacao) return '';
  const rec = parecer.recomendacao;
  const recLow = rec.toLowerCase();
  let parecerClass = 'sg-parecer--ressalvas';
  let parecerIcon = '!';
  if (recLow.includes('emitir') && !recLow.includes('ressalvas')) { parecerClass = 'sg-parecer--emitir'; parecerIcon = '✓'; }
  if (recLow.includes('declinar')) { parecerClass = 'sg-parecer--declinar'; parecerIcon = '✗'; }

  const condicoesHtml = (parecer.condicoes || []).filter(c => c).length > 0 ? `
    <div class="sg-parecer-condicoes">
      <p class="sg-parecer-cond-label">Condições para Emissão</p>
      <ul class="sg-parecer-cond-list">
        ${(parecer.condicoes || []).map(c => `<li>${esc(c)}</li>`).join('')}
      </ul>
    </div>` : '';

  return `
    <section class="dashboard-section">
      <div class="sg-parecer-card ${parecerClass}">
        <div class="sg-parecer-hdr">
          <div>
            <p class="sg-parecer-eyebrow">Parecer de Emissão</p>
            <p class="sg-parecer-rec">${esc(rec)}</p>
          </div>
          <span class="sg-parecer-icon" aria-hidden="true">${parecerIcon}</span>
        </div>
        <p class="sg-parecer-just">${esc(parecer.justificativa || '')}</p>
        ${condicoesHtml}
      </div>
    </section>`;
}

// ── Fiança Locatícia: report HTML builder ──────────────────────────────────
function buildFlReportHtml(data, locatario, imovel, dateStr) {
  const dados = data.dados_gerais || {};
  const clausulas = data.clausulas_criticas || [];
  const riscos = data.riscos || [];
  const docs = data.documentos_analisados || [];

  const dadosItens = FL_DADOS_CONFIG
    .map(cfg => buildDadoItem(cfg.label, dados[cfg.key], cfg.format))
    .filter(h => h).join('');

  const clausulasHtml = clausulas.length > 0
    ? clausulas.map(buildClausulaItem).join('')
    : '<p class="af-no-data">Nenhuma cláusula crítica identificada.</p>';

  const riscosHtml = riscos.length > 0
    ? riscos.map(buildRiscoItem).join('')
    : '<p class="af-no-data">Nenhum risco identificado.</p>';

  const docsHtml = docs.length > 0
    ? docs.map(d => `<span class="sg-doc-badge">${esc(d)}</span>`).join('')
    : '';

  return `
    <div class="fl-report" id="flReportContent">
        <div class="fl-report-masthead">
          <div>
            <p class="fl-report-eyebrow">Fiança Locatícia IA · Análise Técnica</p>
            <h2 class="fl-report-title">${esc(locatario)}</h2>
            ${imovel ? `<p class="fl-report-subtitle">${esc(imovel)}</p>` : ''}
          </div>
          <div>
            <p class="fl-report-gen-date">Gerado em ${dateStr}</p>
          </div>
        </div>
        <div class="fl-report-body">
          ${docsHtml ? `<div class="sg-docs-analisados">${docsHtml}</div>` : ''}
          <section class="dashboard-section">
            <h2 class="sec section-title">Dados do Contrato</h2>
            <div class="card sg-dados-card">
              ${dadosItens || '<p class="af-no-data">Dados não extraídos.</p>'}
            </div>
          </section>
          <section class="dashboard-section">
            <h2 class="sec section-title">Cláusulas Críticas</h2>
            <div class="sg-clausulas-list">${clausulasHtml}</div>
          </section>
          <section class="dashboard-section">
            <h2 class="sec section-title">Riscos Identificados</h2>
            <div class="sg-riscos-list">${riscosHtml}</div>
          </section>
          ${data.resumo ? `
          <section class="dashboard-section">
            <h2 class="sec section-title">Resumo Executivo</h2>
            <div class="card sg-resumo-card">
              <p class="sg-resumo-text">${esc(data.resumo)}</p>
            </div>
          </section>` : ''}
        </div>
      </div>`;
}

function appendFlChatMessage(role, content) {
  const messagesEl = document.getElementById('flChatMessages');

  if (role === 'user' && !flFirstAnalysis) {
    const existing = messagesEl.querySelector('.sg-chat-divider');
    if (!existing) {
      const divider = document.createElement('div');
      divider.className = 'sg-chat-divider';
      divider.textContent = 'Perguntas sobre a análise';
      messagesEl.appendChild(divider);
    }
  }

  const div = document.createElement('div');
  if (role === 'report') {
    div.className = 'fl-report-wrapper';
    div.innerHTML = content;
    flFirstAnalysis = false;
  } else {
    div.className = 'sg-chat-msg ' + (role === 'user' ? 'sg-chat-msg--user' : 'sg-chat-msg--ai');
    div.innerHTML = role === 'assistant' ? renderMarkdown(content) : '<p>' + esc(content) + '</p>';
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendFlChatMessage() {
  const input = document.getElementById('flChatInput');
  const text = input.value.trim();
  if (!text || flChatHistory.length === 0) return;

  input.value = '';
  appendFlChatMessage('user', text);
  flChatHistory.push({ role: 'user', content: text });

  const sendBtn = document.getElementById('flChatSend');
  sendBtn.disabled = true;
  input.disabled = true;

  const messagesEl = document.getElementById('flChatMessages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'sg-chat-msg sg-chat-msg--ai sg-chat-typing';
  typingDiv.innerHTML = '<div class="sg-chat-dots"><span></span><span></span><span></span></div>';
  messagesEl.appendChild(typingDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const respText = await chatFiancaLocaticia(flChatHistory);
    flChatHistory.push({ role: 'assistant', content: respText });
    typingDiv.remove();
    appendFlChatMessage('assistant', respText);
  } catch (err) {
    typingDiv.remove();
    appendFlChatMessage('assistant', 'Erro ao processar resposta: ' + esc(err.message));
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

async function downloadFlReport() {
  const btn = document.getElementById('flExportBtn');
  const btnOrigHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Gerando PDF…'; }

  const el = document.getElementById('flReportContent');
  if (!el) { if (btn) { btn.disabled = false; btn.innerHTML = btnOrigHTML; } return; }

  const messagesEl = document.getElementById('flChatMessages');
  const prevOverflow = messagesEl ? messagesEl.style.overflow : '';
  if (messagesEl) messagesEl.style.overflow = 'visible';

  try {
    const canvas = await html2canvas(el, {
      scale: 1.5, useCORS: true, allowTaint: false, logging: false, backgroundColor: '#ffffff',
    });
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = window.jspdf;
    const pageW = 210;
    const pageH = 297;
    const imgH = (canvas.height * pageW) / canvas.width;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    let posY = 0;
    let remaining = imgH;
    pdf.addImage(imgData, 'JPEG', 0, posY, pageW, imgH);
    remaining -= pageH;
    while (remaining > 0) {
      posY -= pageH;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, posY, pageW, imgH);
      remaining -= pageH;
    }
    const title = document.getElementById('flChatTitle').textContent || 'relatorio-fianca-locaticia';
    const safeTitle = title.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim() || 'relatorio-fianca-locaticia';
    pdf.save(safeTitle + '.pdf');
  } catch (err) {
    console.error('Erro ao gerar PDF Fiança Locatícia:', err);
  } finally {
    if (messagesEl) messagesEl.style.overflow = prevOverflow;
    if (btn) { btn.disabled = false; btn.innerHTML = btnOrigHTML; }
  }
}

// -- Chart defaults
Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = '#4b5563';

// -- Financial Analysis State
let financialFiles = [];
const MAX_FINANCIAL_FILES = 6;
const FINANCIAL_EXTENSIONS = ['xlsx', 'xls', 'csv', 'pdf', 'png', 'jpg', 'jpeg'];

// Drop zone for financial files
const dzFin = document.getElementById('dropZoneFinancial');
const fileInputFin = document.getElementById('fileInputFinancial');

if (fileInputFin) {
  fileInputFin.addEventListener('change', function() {
    handleFinancialFiles(Array.from(this.files));
    this.value = '';
  });
}

if (dzFin) {
  dzFin.addEventListener('dragover', e => { e.preventDefault(); dzFin.classList.add('drop-zone--over'); });
  dzFin.addEventListener('dragleave', () => dzFin.classList.remove('drop-zone--over'));
  dzFin.addEventListener('drop', e => {
    e.preventDefault();
    dzFin.classList.remove('drop-zone--over');
    handleFinancialFiles(Array.from(e.dataTransfer.files));
  });
}

function handleFinancialInputChange(fileList) {
  handleFinancialFiles(Array.from(fileList));
}

function handleFinancialFiles(files) {
  hideFinancialError();
  let adicionados = 0;

  for (const file of files) {
    if (financialFiles.length >= MAX_FINANCIAL_FILES) {
      showFinancialError(`Limite de ${MAX_FINANCIAL_FILES} arquivos atingido. Remova um arquivo para adicionar outro.`);
      break;
    }
    const ext = file.name.split('.').pop().toLowerCase();
    if (!FINANCIAL_EXTENSIONS.includes(ext)) {
      showFinancialError(`Formato não suportado: .${ext}. Use .xlsx, .xls, .csv, .pdf, .png, .jpg ou .jpeg.`);
      continue;
    }
    const duplicado = financialFiles.some(f => f.name === file.name && f.size === file.size);
    if (duplicado) continue;

    financialFiles.push(file);
    adicionados++;
  }

  renderFinancialFileList();
  document.getElementById('btnAnalyze').disabled = financialFiles.length === 0;
}

function removeFinancialFile(index) {
  financialFiles.splice(index, 1);
  renderFinancialFileList();
  document.getElementById('btnAnalyze').disabled = financialFiles.length === 0;
  hideFinancialError();
}

function getFileIconClass(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (['xlsx', 'xls'].includes(ext)) return 'financial-file-icon--xlsx';
  if (ext === 'pdf') return 'financial-file-icon--pdf';
  if (ext === 'csv') return 'financial-file-icon--csv';
  return 'financial-file-icon--img';
}

function getFileIconLabel(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (['xlsx', 'xls'].includes(ext)) return 'XLS';
  if (ext === 'pdf') return 'PDF';
  if (ext === 'csv') return 'CSV';
  return 'IMG';
}

function renderFinancialFileList() {
  const list = document.getElementById('financialFileList');
  if (!list) return;

  if (financialFiles.length === 0) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = financialFiles.map((file, i) => `
    <div class="financial-file-item">
      <div class="financial-file-icon ${getFileIconClass(file)}">${getFileIconLabel(file)}</div>
      <div class="financial-file-info">
        <p class="financial-file-name" title="${esc(file.name)}">${esc(file.name)}</p>
        <p class="financial-file-meta">${(file.size / 1024).toFixed(1)} KB</p>
      </div>
      <button type="button" class="financial-file-remove" onclick="removeFinancialFile(${i})" aria-label="Remover ${esc(file.name)}">
        <svg viewBox="0 0 16 16" fill="none"><path d="M2 2l12 12M14 2L2 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
  `).join('');
}

function showFinancialError(msg) {
  const el = document.getElementById('errorMsgFinancial');
  const txt = document.getElementById('errorTextFinancial');
  if (el && txt) { txt.textContent = msg; el.classList.add('show'); }
}

function hideFinancialError() {
  const el = document.getElementById('errorMsgFinancial');
  if (el) el.classList.remove('show');
}

let afChatHistory = [];
let afAnaliseData = null;

// -- Process financial analysis
async function processarAnaliseFinanceira() {
  if (financialFiles.length === 0) return;

  const btn = document.getElementById('btnAnalyze');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = 'Analisando…';
  hideFinancialError();

  document.getElementById('afUploadSection').hidden = true;
  document.getElementById('afLoading').hidden = false;
  document.getElementById('afHero').hidden = true;
  document.getElementById('afContent').hidden = true;
  document.getElementById('afFooter').hidden = true;

  try {
    const analise = await analisarDocumentosFinanceiros(financialFiles);
    afAnaliseData = analise;
    renderAnaliseFinanceira(analise);
  } catch (err) {
    document.getElementById('afLoading').hidden = true;
    document.getElementById('afUploadSection').hidden = false;
    showFinancialError('Erro ao analisar: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = 'Analisar com IA';
  }
}

function resetAnaliseFinanceira() {
  financialFiles = [];
  afChatHistory = [];
  afAnaliseData = null;
  renderFinancialFileList();
  document.getElementById('btnAnalyze').disabled = true;
  document.getElementById('afHero').hidden = true;
  document.getElementById('afContent').hidden = true;
  document.getElementById('afFooter').hidden = true;
  document.getElementById('afUploadSection').hidden = false;
  document.getElementById('afQaMessages').innerHTML = '';
  hideFinancialError();
  const btnDownload = document.getElementById('btnDownloadTop');
  if (btnDownload) btnDownload.hidden = true;
}

// -- Render financial analysis result (multi-company structure)
function renderAnaliseFinanceira(data) {
  document.getElementById('afLoading').hidden = true;
  document.getElementById('afHero').hidden = false;
  document.getElementById('afContent').hidden = false;
  document.getElementById('afFooter').hidden = false;

  const empresas = data.empresas || [];
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

  const heroTitle = empresas.length === 1
    ? (empresas[0].empresa || 'Empresa não identificada')
    : empresas.length + ' empresa' + (empresas.length > 1 ? 's' : '') + ' analisada' + (empresas.length > 1 ? 's' : '');
  const totalDocs = empresas.reduce((s, e) => s + (e.documentos || []).length, 0);
  document.getElementById('afEmpresa').textContent = heroTitle;
  document.getElementById('afPeriodo').textContent = totalDocs + ' documento' + (totalDocs !== 1 ? 's' : '') + ' processado' + (totalDocs !== 1 ? 's' : '');
  document.getElementById('afDataGeracao').textContent = 'Gerado em ' + dateStr;
  document.getElementById('afFooterDate').textContent = dateStr;

  const container = document.getElementById('afEmpresasContainer');
  container.innerHTML = empresas.map((emp, idx) => buildEmpresaCard(emp, idx)).join('');

  const btnDownload = document.getElementById('btnDownloadTop');
  if (btnDownload) btnDownload.hidden = false;

  // Init Q&A chat history with JSON context
  afChatHistory = criarHistoricoAnaliseFinanceira(financialFiles, JSON.stringify(data));
  document.getElementById('afQaMessages').innerHTML = '';
}

// ── AF Q&A chat ──────────────────────────────────────────────────────────────
async function sendAfChatMessage() {
  const input = document.getElementById('afChatInput');
  const text = input.value.trim();
  if (!text || afChatHistory.length === 0) return;

  input.value = '';
  appendAfQaMessage('user', text);
  afChatHistory.push({ role: 'user', content: text });

  const sendBtn = document.getElementById('afChatSend');
  sendBtn.disabled = true;
  input.disabled = true;

  const messagesEl = document.getElementById('afQaMessages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'af-qa-msg af-qa-msg--ai sg-chat-typing';
  typingDiv.innerHTML = '<div class="sg-chat-dots"><span></span><span></span><span></span></div>';
  messagesEl.appendChild(typingDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const respText = await chatAnaliseFinanceira(afChatHistory);
    afChatHistory.push({ role: 'assistant', content: respText });
    typingDiv.remove();
    appendAfQaMessage('assistant', respText);
  } catch (err) {
    typingDiv.remove();
    appendAfQaMessage('assistant', 'Erro ao processar resposta: ' + esc(err.message));
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

function appendAfQaMessage(role, text) {
  const messagesEl = document.getElementById('afQaMessages');
  const div = document.createElement('div');
  div.className = 'af-qa-msg ' + (role === 'user' ? 'af-qa-msg--user' : 'af-qa-msg--ai');
  div.innerHTML = role === 'assistant' ? renderMarkdown(text) : '<p>' + esc(text) + '</p>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

const AF_KPIS_CONFIG = [
  { label: 'Receita Bruta',        key: 'receita_bruta',        format: 'brl', priority: true },
  { label: 'Receita Líquida',      key: 'receita_liquida',      format: 'brl', priority: true },
  { label: 'Lucro Líquido',        key: 'lucro_liquido',        format: 'brl', priority: true },
  { label: 'EBITDA',               key: 'ebitda',               format: 'brl', priority: true },
  { label: 'Margem EBITDA',        key: 'margem_ebitda',        format: 'pct', priority: true },
  { label: 'Margem Líquida',       key: 'margem_liquida',       format: 'pct', priority: true },
  { label: 'Patrimônio Líquido',   key: 'patrimonio_liquido',   format: 'brl', priority: true },
  { label: 'Ativo Total',          key: 'ativo_total',          format: 'brl', priority: false },
  { label: 'Ativo Circulante',     key: 'ativo_circulante',     format: 'brl', priority: false },
  { label: 'Passivo Total',        key: 'passivo_total',        format: 'brl', priority: false },
  { label: 'Passivo Circulante',   key: 'passivo_circulante',   format: 'brl', priority: false },
  { label: 'Dívida Líquida',       key: 'divida_liquida',       format: 'brl', priority: false },
  { label: 'Capital de Giro Líq.', key: 'capital_giro_liquido', format: 'brl', priority: false },
  { label: 'Liquidez Corrente',    key: 'liquidez_corrente',    format: 'dec', priority: true },
  { label: 'Liquidez Geral',       key: 'liquidez_geral',       format: 'dec', priority: false },
  { label: 'Endividamento Geral',  key: 'endividamento_geral',  format: 'pct', priority: true },
  { label: 'Dívida / EBITDA',      key: 'divida_ebitda',        format: 'dec', priority: false },
  { label: 'Cobertura de Juros',   key: 'cobertura_juros',      format: 'dec', priority: false },
  { label: 'Rentabilidade PL',     key: 'rentabilidade_pl',     format: 'pct', priority: false },
  { label: 'Lucro Bruto',          key: 'lucro_bruto',          format: 'brl', priority: false },
];

function fmtIndicador(val, format) {
  if (val === null || val === undefined) return null;
  if (format === 'brl') return fmtBRL(val);
  if (format === 'pct') return Number(val).toFixed(2).replace('.', ',') + '%';
  return Number(val).toFixed(2).replace('.', ',');
}

function riscoClass(risco) {
  const r = (risco || '').toLowerCase();
  if (r.includes('baixo'))    return 'af-risco-badge--baixo';
  if (r.includes('moderado')) return 'af-risco-badge--moderado';
  if (r.includes('cr'))       return 'af-risco-badge--critico';
  if (r.includes('alto'))     return 'af-risco-badge--alto';
  return '';
}

function capacidadeClass(cap) {
  const c = (cap || '').toLowerCase();
  if (c.includes('alta'))     return 'af-cap--alta';
  if (c.includes('moderada')) return 'af-cap--moderada';
  if (c.includes('baixa'))    return 'af-cap--baixa';
  if (c.includes('inapta'))   return 'af-cap--inapta';
  return '';
}

function buildDocumentoCard(doc) {
  const ind = doc.indicadores || {};
  const kpis = AF_KPIS_CONFIG.filter(k => ind[k.key] !== null && ind[k.key] !== undefined);

  const kpisHtml = kpis.length > 0
    ? kpis.map(cfg => {
        const val = ind[cfg.key];
        const display = fmtIndicador(val, cfg.format);
        const isNeg = typeof val === 'number' && val < 0;
        const isKey = cfg.priority ? 'af-kpi--priority' : '';
        return `
          <div class="af-kpi-item ${isKey} ${isNeg ? 'af-kpi--neg' : ''}">
            <span class="af-kpi-label">${esc(cfg.label)}</span>
            <span class="af-kpi-value mono">${display}</span>
          </div>`;
      }).join('')
    : '<p class="af-no-data">Indicadores não extraídos deste documento.</p>';

  return `
    <div class="af-doc-card card">
      <div class="af-doc-header">
        <span class="af-doc-tipo">${esc(doc.tipo || '—')}</span>
        <span class="af-doc-periodo">${esc(doc.periodo || '—')}</span>
      </div>
      <div class="af-kpis-list">${kpisHtml}</div>
      ${doc.observacoes ? `<p class="af-doc-obs">${esc(doc.observacoes)}</p>` : ''}
    </div>`;
}

function buildEmpresaCard(emp, idx) {
  const ac = emp.analise_credito || {};
  const risco = ac.classificacao_risco || '—';
  const docs = emp.documentos || [];

  const docsHtml = docs.length > 0
    ? `<div class="af-docs-grid">${docs.map(buildDocumentoCard).join('')}</div>`
    : '<p class="af-no-data">Nenhum documento identificado.</p>';

  const capGarantia  = ac.capacidade_seguro_garantia  || '—';
  const capFianca    = ac.capacidade_fianca_locaticia  || '—';

  return `
    <section class="af-empresa-section dashboard-section" aria-label="${esc(emp.empresa || 'Empresa')}">
      <div class="af-empresa-header">
        <div class="af-empresa-identity">
          <h2 class="af-empresa-nome">${esc(emp.empresa || 'Empresa não identificada')}</h2>
          ${emp.cnpj ? `<span class="af-empresa-cnpj">CNPJ ${esc(emp.cnpj)}</span>` : ''}
        </div>
        <span class="af-risco-badge ${riscoClass(risco)}">Risco ${esc(risco)}</span>
      </div>

      <h3 class="af-subsection-title">Documentos Analisados</h3>
      ${docsHtml}

      <h3 class="af-subsection-title">Análise de Crédito</h3>
      <div class="af-credito-card card">

        <div class="af-capacidades-row">
          <div class="af-cap-item ${capacidadeClass(capGarantia)}">
            <span class="af-cap-label">Seguro Garantia</span>
            <span class="af-cap-valor">${esc(capGarantia)}</span>
            ${ac.justificativa_garantia ? `<span class="af-cap-just">${esc(ac.justificativa_garantia)}</span>` : ''}
          </div>
          <div class="af-cap-item ${capacidadeClass(capFianca)}">
            <span class="af-cap-label">Fiança Locatícia</span>
            <span class="af-cap-valor">${esc(capFianca)}</span>
            ${ac.justificativa_fianca ? `<span class="af-cap-just">${esc(ac.justificativa_fianca)}</span>` : ''}
          </div>
        </div>

        ${ac.resumo_executivo ? `
        <div class="af-resumo-block">
          <p class="af-card-label">Resumo Executivo</p>
          <p class="af-resumo-text">${esc(ac.resumo_executivo)}</p>
        </div>` : ''}

        <div class="af-pontos-grid">
          <div class="af-pontos-card af-pontos-card--pos">
            <p class="af-card-label">Pontos Positivos</p>
            <ul class="af-pontos-list">
              ${(ac.pontos_positivos || []).map(p => `<li>${esc(p)}</li>`).join('') || '<li>Não identificados.</li>'}
            </ul>
          </div>
          <div class="af-pontos-card af-pontos-card--atencao">
            <p class="af-card-label">Pontos de Atenção</p>
            <ul class="af-pontos-list">
              ${(ac.pontos_atencao || []).map(p => `<li>${esc(p)}</li>`).join('') || '<li>Não identificados.</li>'}
            </ul>
          </div>
        </div>

        ${ac.recomendacao_seguradora ? `
        <div class="af-recomendacao-block">
          <p class="af-card-label">Recomendação para a Seguradora</p>
          <p class="af-recomendacao-text">${esc(ac.recomendacao_seguradora)}</p>
        </div>` : ''}
      </div>
    </section>`;
}

