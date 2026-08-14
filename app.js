// â"€â"€ State
let chartBarInst, chartDoughnutInst;
let parsedData = null;
// 'upload' | 'manual' — qual método gerou o parsedData atual; usado ao salvar
// no histórico (D1) e para destacar o sub-item certo na sidebar.
let _tcOrigemAtual = 'upload';
let _tcCounter = 0;
let _tcModalCounters = {};
const TC_SEGURADORAS = [
  'AKAD','ALLIANZ','AUSTRAL','AVLA','AXA','BERKLEY','BTG','CESCE','CHUBB',
  'DAYCOVAL','ESSOR','EZZE','FAIRFAX','FATOR','HDI','JNS','JUNTO','KOVR',
  'LIBERTY','MITISUI','NEWE','POTTENCIAL','SOMBRERO','SOMPO',
  'SWISS RE','THINKSEG','TOKIO','ZURICH',
];
let _tcTabs = [];
let _tcActiveTabId = null;
let _tcTabCounter = 0;

// â"€â"€ Sidebar mobile (drawer off-canvas — hover/focus-within não existe em touch)
function openMobileSidebar() {
  document.body.classList.add('mobile-sidebar-open');
  const fab = document.getElementById('sidebarToggleFab');
  if (fab) fab.setAttribute('aria-expanded', 'true');
}

function closeMobileSidebar() {
  document.body.classList.remove('mobile-sidebar-open');
  const fab = document.getElementById('sidebarToggleFab');
  if (fab) fab.setAttribute('aria-expanded', 'false');
}

function toggleMobileSidebar() {
  if (document.body.classList.contains('mobile-sidebar-open')) closeMobileSidebar();
  else openMobileSidebar();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeMobileSidebar();
});

// â"€â"€ Tab switching
// Botão flutuante "Exportar relatório": é compartilhado por dois fluxos (T&C
// Dashboard e Análise Financeira) e vive fora das páginas, em position:fixed.
// Sem dono declarado ele continuava visível ao navegar para outra aba e cobria a
// topbar dos fluxos de IA. Agora só aparece na página que o gerou.
let _downloadTopOwner = null;

function setDownloadTopOwner(pagina) {
  _downloadTopOwner = pagina;
  syncDownloadTopVisibility();
}

function syncDownloadTopVisibility() {
  const btn = document.getElementById('btnDownloadTop');
  if (!btn) return;
  const paginaAtiva = document.querySelector('.page.active');
  const idAtivo = paginaAtiva ? paginaAtiva.id.replace(/^page-/, '') : null;
  btn.hidden = !_downloadTopOwner || _downloadTopOwner !== idAtivo;
}

function switchTab(tab) {
  closeMobileSidebar();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + tab).classList.add('active');
  syncDownloadTopVisibility();
  document.querySelectorAll('.sidebar-item').forEach(t => {
    const pages = (t.dataset.pages || t.dataset.page || '').split(' ');
    const isActive = pages.includes(tab);
    t.classList.toggle('active', isActive);
    if (isActive) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  if (tab === 'consulta-limites') renderLimitesPlaceholders();
  requestAnimationFrame(syncAiChatStickyOffset);
}

function syncAiChatStickyOffset() {
  const activePage = document.querySelector('.page.active');
  if (!activePage) return;

  const chatTopbar = activePage.querySelector('.sg-chat-wrapper:not([hidden]) .sg-chat-topbar');
  if (!chatTopbar) return;

  // A navegação agora é uma sidebar lateral (não ocupa altura no topo).
  const appTopbarHeight = 0;
  const chatTopbarStyle = window.getComputedStyle(chatTopbar);
  const chatTopbarMarginBottom = parseFloat(chatTopbarStyle.marginBottom) || 0;
  const stickyTop = Math.ceil(appTopbarHeight + chatTopbar.getBoundingClientRect().height + chatTopbarMarginBottom);

  activePage.style.setProperty('--ai-sidebar-sticky-top', stickyTop + 'px');
}

window.addEventListener('resize', syncAiChatStickyOffset);

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
      _tcOrigemAtual = 'upload';
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
  const brandBars = ['#0b3b54','#114e6e','#1b6d95','#3f89ad','#7db6d2','#00b8f0','#0093c4','#16a34a'];
  
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
        x: { border:{display:false}, grid:{color:'#dfe7ee'}, ticks: { callback: v => v >= 1e6 ? 'R$ '+(v/1e6).toFixed(0)+'MM' : fmtBRL(v), color:'#46586b', font:{size:10} } },
        y: { border:{display:false}, grid:{display:false}, ticks:{font:{weight:'700',size:11},color:'#12212e'} }
      }
    }
  });

  // Doughnut
  if (chartDoughnutInst) chartDoughnutInst.destroy();
  const dGroups = [aprovadas, concorr, bloqueadas, declinadas];
  const dAllLabels = ['Aprovado','Nomeada por outro corretor','Bloqueado','Declinado'];
  const dAllColors = ['#16a34a','#b45309','#6a7d90','#dc2626'];
  const dData = dGroups.map(g=>g.length).filter((_,i)=>dGroups[i].length>0);
  const dLabels = dAllLabels.filter((_,i)=>dGroups[i].length>0);
  const dColors = dAllColors.filter((_,i)=>dGroups[i].length>0);
  chartDoughnutInst = new Chart(document.getElementById('chartDoughnut').getContext('2d'), {
    type: 'doughnut',
    data: { labels: dLabels, datasets: [{ data: dData, backgroundColor: dColors, borderWidth: 2, borderColor: '#ffffff', hoverOffset: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { position:'bottom', labels:{ padding:14, boxWidth:10, boxHeight:10, font:{size:11}, color:'#46586b' } },
        tooltip: { callbacks: { label: ctx => ' '+ctx.label+': '+ctx.raw+' seguradoras' } }
      }
    }
  });

  // â"€â"€ Build modalidades index for search (from approved rows only)
  buildModalIndex(aprovadas);

  // Switch to dashboard tab
  setDownloadTopOwner('dashboard');
  generateButton.classList.remove('is-loading');
  generateButton.disabled = false;
  switchTab('dashboard');
  abrirTcSidebarGroup();
  updateTcSubNav(_tcOrigemAtual);
  resetTcSaveStatus();
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

  const brandBars = ['#0b3b54','#114e6e','#1b6d95','#3f89ad','#7db6d2','#00b8f0','#0093c4','#16a34a'];

  // Chart: Limite
  if (chartModalLimiteInst) chartModalLimiteInst.destroy();
  chartModalLimiteInst = new Chart(document.getElementById('chartModalLimite').getContext('2d'), {
    type: 'bar',
    data: {
      labels: byLimite.map(m => m.seguradora),
      datasets: [{
        label: 'Limite (R$)',
        data: byLimite.map(m => m.value),
        backgroundColor: byLimite.map((m,i) => i === 0 ? '#0b3b54' : brandBars[(i) % brandBars.length]),
        borderWidth: 0, borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend:{display:false}, tooltip:{ callbacks:{ label: ctx => ' ' + fmtBRL(ctx.raw) } } },
      scales: {
        x: { border:{display:false}, grid:{color:'#dfe7ee'}, ticks:{ callback: v => v>=1e6 ? 'R$ '+(v/1e6).toFixed(0)+'MM' : fmtBRL(v), color:'#46586b', font:{size:10} } },
        y: { border:{display:false}, grid:{display:false}, ticks:{font:{weight:'700',size:11},color:'#12212e'} }
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
          x: { border:{display:false}, grid:{color:'#dfe7ee'}, ticks:{ callback: v => v.toFixed(2).replace('.',',')+'%', color:'#46586b', font:{size:10} } },
          y: { border:{display:false}, grid:{display:false}, ticks:{font:{weight:'700',size:11},color:'#12212e'} }
        }
      }
    });
  } else {
    // No taxa data â€" show placeholder
    const ctx = document.getElementById('chartModalTaxa').getContext('2d');
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.font = '12px Inter, sans-serif';
    ctx.fillStyle = '#6a7d90';
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
let apoliceFiles = [];
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

const APOLICE_DADOS_CONFIG = [
  { key: 'seguradora', label: 'Seguradora Emissora' },
  { key: 'numero_apolice', label: 'Nº da Apólice' },
  { key: 'ramo', label: 'Ramo / Modalidade' },
  { key: 'tomador', label: 'Tomador / Locatário' },
  { key: 'tomador_documento', label: 'CNPJ/CPF do Tomador' },
  { key: 'segurado', label: 'Segurado / Locador' },
  { key: 'segurado_documento', label: 'CNPJ/CPF do Segurado' },
  { key: 'importancia_segurada', label: 'Importância Segurada (IS)', format: 'brl' },
  { key: 'premio', label: 'Prêmio', format: 'brl' },
  { key: 'vigencia', label: 'Vigência' },
  { key: 'objeto_apolice', label: 'Objeto da Apólice' },
];

// ── File handlers shared util
function handleContratoFiles(files, fileArray, maxFiles, extensions, listId, btnId, errShowFn, errHideFn, tipo) {
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
  renderContratoFileList(fileArray, listId, tipo);
  atualizarBotaoAnalise(tipo, fileArray, btnId);
}

// Seguro Garantia e Fiança dependem também da modalidade selecionada; os demais
// fluxos continuam habilitando o botão apenas pela presença de arquivos.
function atualizarBotaoAnalise(tipo, fileArray, btnId) {
  if (tipo === 'garantia') return refreshDemandaState('sg');
  if (tipo === 'fianca') return refreshDemandaState('fl');
  const btn = document.getElementById(btnId);
  if (btn) btn.disabled = fileArray.length === 0;
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
    refreshDemandaState('sg');
    hideGarantiaError();
  } else if (tipo === 'fianca') {
    fiancaFiles.splice(index, 1);
    renderContratoFileList(fiancaFiles, 'fiancaFileList', 'fianca');
    refreshDemandaState('fl');
    hideFiancaError();
  } else if (tipo === 'apolice') {
    apoliceFiles.splice(index, 1);
    renderContratoFileList(apoliceFiles, 'apoliceFileList', 'apolice');
    document.getElementById('btnAnalyzeApolice').disabled = apoliceFiles.length === 0;
    hideApoliceError();
  }
}

// ── Contexto da demanda: modalidade + considerações (Seguro Garantia / Fiança) ──
//
// Catálogo centralizado da UI. Os ids são os mesmos validados pelo Worker
// (workers/deepseek-memory-worker.js → SG_MODALIDADES / FL_MODALIDADES) e usados
// pelas orientações especializadas de deepseek.js. Alterar um id aqui exige
// alterar os três arquivos.

const DEMANDA_CONSIDERACOES_MAX = 2000;
const DEMANDA_MODALIDADE_LABEL_MAX = 160;

const SG_MODALIDADES_CATALOGO = [
  { id: 'licitante-proposta', label: 'Garantia do Licitante / Garantia de Proposta' },
  { id: 'execucao-fiel-cumprimento', label: 'Garantia de Execução / Fiel Cumprimento' },
  { id: 'adiantamento-pagamento', label: 'Garantia de Adiantamento de Pagamento' },
  { id: 'retencao-pagamento', label: 'Garantia de Retenção de Pagamento' },
  { id: 'manutencao-corretiva', label: 'Garantia de Manutenção Corretiva / Perfeito Funcionamento' },
  { id: 'trabalhista-previdenciaria', label: 'Garantia Trabalhista e Previdenciária' },
  { id: 'aduaneira', label: 'Garantia Aduaneira' },
  { id: 'judicial', label: 'Garantia Judicial' },
  { id: 'judicial-execucao-fiscal', label: 'Garantia Judicial para Execução Fiscal' },
  { id: 'recursal', label: 'Garantia Recursal' },
  { id: 'administrativa-creditos-tributarios', label: 'Garantia Administrativa de Créditos Tributários' },
  { id: 'parcelamento-administrativo-fiscal', label: 'Garantia de Parcelamento Administrativo Fiscal' },
  { id: 'imobiliaria', label: 'Garantia Imobiliária' },
  { id: 'concessoes', label: 'Garantia para Concessões' },
  { id: 'energia', label: 'Garantia para o Setor de Energia' },
  { id: 'completion', label: 'Garantia de Completion / Conclusão de Projeto' },
  { id: 'outra', label: 'Outra modalidade' },
];

const FL_MODALIDADES_CATALOGO = [
  { id: 'residencial', label: 'Locação Residencial' },
  { id: 'comercial', label: 'Locação Comercial' },
  { id: 'nao-residencial', label: 'Locação Não Residencial' },
  { id: 'pessoa-juridica', label: 'Locação por Pessoa Jurídica' },
  { id: 'construcao-built-to-suit', label: 'Imóvel em Construção / Built to Suit' },
  { id: 'outra', label: 'Outra modalidade' },
];

const DEMANDA_CONFIG = {
  sg: {
    catalogo: SG_MODALIDADES_CATALOGO,
    selectId: 'sgModalidade',
    outraWrapId: 'sgModalidadeOutraWrap',
    outraInputId: 'sgModalidadeOutra',
    consideracoesId: 'sgConsideracoes',
    counterId: 'sgConsideracoesCounter',
    errorId: 'sgDemandaError',
    btnId: 'btnAnalyzeGarantia',
    nomeCampo: 'modalidade do seguro garantia',
    arquivos: () => garantiaFiles,
  },
  fl: {
    catalogo: FL_MODALIDADES_CATALOGO,
    selectId: 'flModalidade',
    outraWrapId: 'flModalidadeOutraWrap',
    outraInputId: 'flModalidadeOutra',
    consideracoesId: 'flConsideracoes',
    counterId: 'flConsideracoesCounter',
    errorId: 'flDemandaError',
    btnId: 'btnAnalyzeFianca',
    nomeCampo: 'modalidade da fiança locatícia',
    arquivos: () => fiancaFiles,
  },
};

// Contexto validado no momento em que cada análise começou — o relatório renderiza
// a partir daqui, nunca do que a IA repetiu de volta.
let sgContextoDemanda = null;
let flContextoDemanda = null;

// Percorre por code point para não depender de escapes \uXXXX no regex.
function stripCaracteresDeControle(texto) {
  let out = '';
  for (const ch of texto) {
    const code = ch.codePointAt(0);
    const controle = (code < 32 && ch !== '\n') || (code >= 127 && code <= 159);
    out += controle ? ' ' : ch;
  }
  return out;
}

// Texto do usuário: sem HTML, sem caracteres de controle, espaços normalizados e
// truncado. Só espaços vira string vazia. O Worker repete a sanitização no servidor.
function sanitizeDemandaTexto(value, maxLength) {
  if (typeof value !== 'string') return '';
  return stripCaracteresDeControle(value.replace(/\r\n?/g, '\n'))
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map(linha => linha.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength)
    .trim();
}

function initDemandaFields() {
  Object.keys(DEMANDA_CONFIG).forEach(flow => {
    const cfg = DEMANDA_CONFIG[flow];
    const select = document.getElementById(cfg.selectId);
    if (!select) return;
    cfg.catalogo.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.label;
      select.appendChild(opt);
    });
    updateConsideracoesCounter(flow);
    refreshDemandaState(flow);
  });
}

function onDemandaModalidadeChange(flow) {
  const cfg = DEMANDA_CONFIG[flow];
  const select = document.getElementById(cfg.selectId);
  const wrap = document.getElementById(cfg.outraWrapId);
  const outra = document.getElementById(cfg.outraInputId);
  const isOutra = !!select && select.value === 'outra';
  if (wrap) wrap.hidden = !isOutra;
  if (outra) {
    if (isOutra) outra.focus();
    else outra.value = '';
  }
  refreshDemandaState(flow);
}

function onDemandaFieldInput(flow) {
  updateConsideracoesCounter(flow);
  refreshDemandaState(flow);
}

function updateConsideracoesCounter(flow) {
  const cfg = DEMANDA_CONFIG[flow];
  const campo = document.getElementById(cfg.consideracoesId);
  const counter = document.getElementById(cfg.counterId);
  if (!campo || !counter) return;
  const total = campo.value.length;
  counter.textContent = total + ' / ' + DEMANDA_CONSIDERACOES_MAX + ' caracteres';
  counter.classList.toggle('demanda-counter--limite', total >= DEMANDA_CONSIDERACOES_MAX);
}

// Retorna { ok, contexto } ou { ok: false, erro, foco } — nunca lança.
function lerContextoDemanda(flow) {
  const cfg = DEMANDA_CONFIG[flow];
  const select = document.getElementById(cfg.selectId);
  const id = select ? select.value : '';
  if (!id) return { ok: false, erro: 'Selecione a ' + cfg.nomeCampo + ' antes de iniciar a análise.', foco: cfg.selectId };

  const item = cfg.catalogo.find(mod => mod.id === id);
  if (!item) return { ok: false, erro: 'Modalidade inválida. Escolha uma opção da lista.', foco: cfg.selectId };

  let label = item.label;
  if (id === 'outra') {
    const outra = document.getElementById(cfg.outraInputId);
    label = sanitizeDemandaTexto(outra ? outra.value : '', DEMANDA_MODALIDADE_LABEL_MAX);
    if (!label) return { ok: false, erro: 'Informe o nome da modalidade em "Outra modalidade".', foco: cfg.outraInputId };
  }

  const campo = document.getElementById(cfg.consideracoesId);
  const consideracoes = sanitizeDemandaTexto(campo ? campo.value : '', DEMANDA_CONSIDERACOES_MAX);
  return { ok: true, contexto: { modalidade: { id, label }, consideracoes } };
}

function showDemandaErro(flow, msg, foco) {
  const cfg = DEMANDA_CONFIG[flow];
  const el = document.getElementById(cfg.errorId);
  if (el) { el.textContent = msg; el.hidden = false; }
  const alvo = foco && document.getElementById(foco);
  if (alvo) alvo.focus();
}

function hideDemandaErro(flow) {
  const el = document.getElementById(DEMANDA_CONFIG[flow].errorId);
  if (el) { el.textContent = ''; el.hidden = true; }
}

// Botão de análise exige arquivos E modalidade válida; a mensagem só aparece
// depois que há arquivos, para não cobrar o campo antes da hora.
function refreshDemandaState(flow) {
  const cfg = DEMANDA_CONFIG[flow];
  const leitura = lerContextoDemanda(flow);
  const temArquivos = cfg.arquivos().length > 0;

  const btn = document.getElementById(cfg.btnId);
  if (btn) btn.disabled = !temArquivos || !leitura.ok;

  if (temArquivos && !leitura.ok) {
    const el = document.getElementById(cfg.errorId);
    if (el) { el.textContent = leitura.erro; el.hidden = false; }
  } else {
    hideDemandaErro(flow);
  }
}

function resetDemandaFields(flow) {
  const cfg = DEMANDA_CONFIG[flow];
  const select = document.getElementById(cfg.selectId);
  if (select) select.selectedIndex = 0;
  const wrap = document.getElementById(cfg.outraWrapId);
  if (wrap) wrap.hidden = true;
  const outra = document.getElementById(cfg.outraInputId);
  if (outra) outra.value = '';
  const campo = document.getElementById(cfg.consideracoesId);
  if (campo) campo.value = '';
  updateConsideracoesCounter(flow);
  hideDemandaErro(flow);
  refreshDemandaState(flow);
}

// ── Escopo da análise: só a modalidade solicitada aparece como card ───────────
//
// A instrução de escopo fechado vive no prompt (Worker e fallback), mas o modelo
// pode escorregar e devolver modalidades extras — o filtro abaixo é a rede de
// segurança do front-end para o usuário nunca ver um card fora da demanda.

const SG_MODALIDADE_PALAVRAS = {
  'licitante-proposta': ['proposta', 'licitante', 'licitacao', 'bid bond', 'manutencao da proposta'],
  'execucao-fiel-cumprimento': ['execucao', 'fiel cumprimento', 'performance', 'garantia contratual', 'contratual'],
  'adiantamento-pagamento': ['adiantamento', 'antecipacao', 'advance payment'],
  'retencao-pagamento': ['retencao', 'caucao de medicao', 'retention'],
  'manutencao-corretiva': ['manutencao', 'perfeito funcionamento', 'garantia tecnica', 'vicios ocultos'],
  'trabalhista-previdenciaria': ['trabalhista', 'previdenciaria', 'verbas trabalhistas', 'fgts'],
  'aduaneira': ['aduaneira', 'aduaneiro', 'drawback', 'admissao temporaria', 'entreposto'],
  'judicial': ['judicial', 'juizo', 'penhora', 'deposito judicial'],
  'judicial-execucao-fiscal': ['execucao fiscal', 'divida ativa', 'cda', 'judicial'],
  'recursal': ['recursal', 'deposito recursal', 'preparo', 'recurso'],
  'administrativa-creditos-tributarios': ['credito tributario', 'auto de infracao', 'administrativa fiscal', 'processo administrativo'],
  'parcelamento-administrativo-fiscal': ['parcelamento', 'saldo devedor', 'refis'],
  'imobiliaria': ['imobiliaria', 'incorporacao', 'habite-se', 'adquirentes'],
  'concessoes': ['concessao', 'concessoes', 'ppp', 'poder concedente', 'permissao'],
  'energia': ['energia', 'ccee', 'aneel', 'ccear', 'leilao de energia'],
  'completion': ['completion', 'conclusao de projeto', 'epc', 'project finance'],
};

const ACENTOS_MAP = {
  'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a',
  'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
  'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
  'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
  'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
  'ç': 'c', 'ñ': 'n',
};

function normalizarTextoBusca(valor) {
  return String(valor || '')
    .toLowerCase()
    .replace(/[áàâãäéèêëíìîïóòôõöúùûüçñ]/g, ch => ACENTOS_MAP[ch] || ch);
}

function modalidadeCombina(nome, id) {
  const palavras = SG_MODALIDADE_PALAVRAS[id];
  if (!palavras) return false;
  const alvo = normalizarTextoBusca(nome);
  return palavras.some(p => alvo.includes(p));
}

// Item ambíguo (não bate com nenhuma modalidade conhecida) fica no escopo —
// preferimos mostrar a mais do que esconder informação do subscritor.
function separarModalidadesPorEscopo(modalidades, contexto) {
  const lista = Array.isArray(modalidades) ? modalidades : [];
  const id = contexto && contexto.modalidade && contexto.modalidade.id;
  if (!id || id === 'outra' || !SG_MODALIDADE_PALAVRAS[id]) {
    return { noEscopo: lista, foraEscopo: [] };
  }

  const noEscopo = [];
  const foraEscopo = [];
  lista.forEach(mod => {
    const nome = mod && mod.nome;
    if (modalidadeCombina(nome, id)) { noEscopo.push(mod); return; }
    const outraConhecida = Object.keys(SG_MODALIDADE_PALAVRAS)
      .some(outroId => outroId !== id && modalidadeCombina(nome, outroId));
    (outraConhecida ? foraEscopo : noEscopo).push(mod);
  });

  return { noEscopo, foraEscopo };
}

function buildSgForaEscopoHtml(foraEscopo, contexto) {
  if (!foraEscopo.length) return '';
  const label = (contexto && contexto.modalidade && contexto.modalidade.label) || 'a modalidade solicitada';
  const itens = foraEscopo.map(mod => {
    const base = mod.base_calculo && mod.base_calculo.valor;
    const detalhe = base && String(base) !== 'null' ? ` <span class="sg-fora-escopo-detalhe">${esc(String(base))}</span>` : '';
    return `<li>${esc(mod.nome || 'Modalidade sem nome')}${detalhe}</li>`;
  }).join('');

  return `
    <div class="sg-fora-escopo-card">
      <p class="sg-fora-escopo-titulo">Outras modalidades citadas no documento</p>
      <p class="sg-fora-escopo-nota">Esta análise trata apenas de <strong>${esc(label)}</strong>. Os itens abaixo aparecem no documento, mas não foram analisados — rode uma nova análise selecionando a modalidade desejada.</p>
      <ul class="sg-fora-escopo-lista">${itens}</ul>
    </div>`;
}

function buildSgModalidadeAusenteHtml(contexto) {
  const label = (contexto && contexto.modalidade && contexto.modalidade.label) || 'A modalidade solicitada';
  return `
    <div class="sg-fora-escopo-card sg-fora-escopo-card--alerta">
      <p class="sg-fora-escopo-titulo">Modalidade solicitada não localizada</p>
      <p class="sg-fora-escopo-nota">Os documentos analisados não trazem exigência de <strong>${esc(label)}</strong>. Confirme a modalidade da demanda ou envie o documento que a exige.</p>
    </div>`;
}

// Cabeçalho do relatório: renderizado do estado validado do front-end, não da IA.
function buildDemandaContextoHtml(contexto) {
  if (!contexto || !contexto.modalidade || !contexto.modalidade.label) return '';
  const consideracoes = (contexto.consideracoes || '').trim();
  const consideracoesHtml = consideracoes
    ? `<div class="demanda-contexto-bloco">
        <p class="demanda-contexto-label">Considerações informadas</p>
        <p class="demanda-contexto-texto">${esc(consideracoes)}</p>
      </div>`
    : '';
  return `
    <div class="demanda-contexto-card">
      <div class="demanda-contexto-bloco">
        <p class="demanda-contexto-label">Modalidade solicitada</p>
        <p class="demanda-contexto-modalidade">${esc(contexto.modalidade.label)}</p>
        <p class="demanda-contexto-nota">Informada pelo usuário na abertura da análise — não representa a modalidade identificada nos documentos.</p>
      </div>
      ${consideracoesHtml}
    </div>`;
}

initDemandaFields();

// Garantia drop zone
const dzGarantia = document.getElementById('dropZoneGarantia');
const fileInputGarantia = document.getElementById('fileInputGarantia');
if (fileInputGarantia) {
  fileInputGarantia.addEventListener('change', function() {
    handleContratoFiles(Array.from(this.files), garantiaFiles, MAX_CONTRATO_FILES, CONTRATO_EXTENSIONS, 'garantiaFileList', 'btnAnalyzeGarantia', showGarantiaError, hideGarantiaError, 'garantia');
    this.value = '';
  });
}
if (dzGarantia) {
  dzGarantia.addEventListener('dragover', e => { e.preventDefault(); dzGarantia.classList.add('drop-zone--over'); });
  dzGarantia.addEventListener('dragleave', () => dzGarantia.classList.remove('drop-zone--over'));
  dzGarantia.addEventListener('drop', e => {
    e.preventDefault(); dzGarantia.classList.remove('drop-zone--over');
    handleContratoFiles(Array.from(e.dataTransfer.files), garantiaFiles, MAX_CONTRATO_FILES, CONTRATO_EXTENSIONS, 'garantiaFileList', 'btnAnalyzeGarantia', showGarantiaError, hideGarantiaError, 'garantia');
  });
}

// Fianca drop zone
const dzFianca = document.getElementById('dropZoneFianca');
const fileInputFianca = document.getElementById('fileInputFianca');
if (fileInputFianca) {
  fileInputFianca.addEventListener('change', function() {
    handleContratoFiles(Array.from(this.files), fiancaFiles, MAX_CONTRATO_FILES, CONTRATO_EXTENSIONS, 'fiancaFileList', 'btnAnalyzeFianca', showFiancaError, hideFiancaError, 'fianca');
    this.value = '';
  });
}
if (dzFianca) {
  dzFianca.addEventListener('dragover', e => { e.preventDefault(); dzFianca.classList.add('drop-zone--over'); });
  dzFianca.addEventListener('dragleave', () => dzFianca.classList.remove('drop-zone--over'));
  dzFianca.addEventListener('drop', e => {
    e.preventDefault(); dzFianca.classList.remove('drop-zone--over');
    handleContratoFiles(Array.from(e.dataTransfer.files), fiancaFiles, MAX_CONTRATO_FILES, CONTRATO_EXTENSIONS, 'fiancaFileList', 'btnAnalyzeFianca', showFiancaError, hideFiancaError, 'fianca');
  });
}

// Apolice drop zone
const dzApolice = document.getElementById('dropZoneApolice');
const fileInputApolice = document.getElementById('fileInputApolice');
if (fileInputApolice) {
  fileInputApolice.addEventListener('change', function() {
    handleContratoFiles(Array.from(this.files), apoliceFiles, MAX_CONTRATO_FILES, CONTRATO_EXTENSIONS, 'apoliceFileList', 'btnAnalyzeApolice', showApoliceError, hideApoliceError, 'apolice');
    this.value = '';
  });
}
if (dzApolice) {
  dzApolice.addEventListener('dragover', e => { e.preventDefault(); dzApolice.classList.add('drop-zone--over'); });
  dzApolice.addEventListener('dragleave', () => dzApolice.classList.remove('drop-zone--over'));
  dzApolice.addEventListener('drop', e => {
    e.preventDefault(); dzApolice.classList.remove('drop-zone--over');
    handleContratoFiles(Array.from(e.dataTransfer.files), apoliceFiles, MAX_CONTRATO_FILES, CONTRATO_EXTENSIONS, 'apoliceFileList', 'btnAnalyzeApolice', showApoliceError, hideApoliceError, 'apolice');
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
function showApoliceError(msg) {
  const el = document.getElementById('errorMsgApolice');
  const tx = document.getElementById('errorTextApolice');
  if (el && tx) { tx.textContent = msg; el.classList.add('show'); }
}
function hideApoliceError() {
  const el = document.getElementById('errorMsgApolice');
  if (el) el.classList.remove('show');
}

// ── Progresso da análise em lotes
// `deepseek.js` emite `analise-progresso` a cada arquivo lido e a cada passo do
// job (trecho analisado, consolidação de notas, síntese). Documentos grandes hoje
// levam dezenas de passos — sem isso o usuário fica no spinner sem retorno.
const AI_LOADING_BY_FLOW = {
  'analise-financeira': 'afLoading',
  'seguro-garantia': 'sgLoading',
  'fianca-locaticia': 'flLoading',
  'analise-apolice': 'apLoading',
};

document.addEventListener('analise-progresso', e => {
  const detalhe = e.detail || {};
  const loadingId = AI_LOADING_BY_FLOW[detalhe.flow];
  if (!loadingId || !detalhe.mensagem) return;
  const box = document.getElementById(loadingId);
  if (!box || box.hidden) return;
  const sub = box.querySelector('.af-loading-sub');
  if (sub) sub.textContent = detalhe.mensagem;
});

// ── Process functions
async function processarSeguroGarantia() {
  if (garantiaFiles.length === 0) {
    showGarantiaError('Anexe ao menos um documento antes de analisar.');
    return;
  }

  // Revalida a modalidade no envio — nunca confia só no estado do botão.
  const leitura = lerContextoDemanda('sg');
  if (!leitura.ok) {
    showDemandaErro('sg', leitura.erro, leitura.foco);
    return;
  }
  sgContextoDemanda = leitura.contexto;
  hideDemandaErro('sg');

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
    const respData = await analisarSeguroGarantia(garantiaFiles, sgContextoDemanda);
    sgChatHistory = criarHistoricoSeguroGarantia(garantiaFiles, respData, sgContextoDemanda);

    const title = garantiaFiles.length === 1 ? garantiaFiles[0].name : garantiaFiles.length + ' documentos analisados';
    const files = garantiaFiles.map(f => f.name).join(' · ');
    document.getElementById('sgChatTitle').textContent = title;
    document.getElementById('sgChatFiles').textContent = files;

    document.getElementById('sgLoading').hidden = true;
    document.getElementById('sgChatArea').hidden = false;
    appendSgChatMessage('assistant', respData);
    _addChatHint('sgSidebarMessages', [
      'Qual é a importância segurada exata e como foi calculada?',
      'Quais cláusulas devem constar na apólice?',
      'Qual a vigência e o prazo da garantia?',
      'Há algum risco ou pendência de subscrição?',
    ], 'sg');
  } catch (err) {
    document.getElementById('sgLoading').hidden = true;
    document.getElementById('sgUploadSection').hidden = false;
    showGarantiaError('Erro ao analisar: ' + err.message);
  } finally {
    btn.querySelector('.btn-label').textContent = 'Analisar com IA';
    refreshDemandaState('sg');
  }
}

function resetSeguroGarantia() {
  garantiaFiles = [];
  sgChatHistory = [];
  sgFirstAnalysis = true;
  sgContextoDemanda = null;
  renderContratoFileList(garantiaFiles, 'garantiaFileList', 'garantia');
  resetDemandaFields('sg');
  document.getElementById('sgChatArea').hidden = true;
  document.getElementById('sgUploadSection').hidden = false;
  document.getElementById('sgChatMessages').innerHTML = '';
  document.getElementById('sgSidebarMessages').innerHTML = '';
  _clearChatFiles('sg');
  const exportBtn = document.getElementById('sgExportBtn');
  if (exportBtn) exportBtn.hidden = true;
  hideGarantiaError();
}

// ── Chat file attachments ─────────────────────────────────────────────────────

const _chatFiles = { sg: [], fl: [], af: [], ap: [] };

function handleChatFileSelect(event, flow) {
  const files = Array.from(event.target.files || []);
  files.forEach(f => _chatFiles[flow].push(f));
  event.target.value = '';
  _renderChatChips(flow);
}

function handleChatDragOver(event, flow) {
  event.preventDefault();
  event.stopPropagation();
  const area = document.getElementById(flow + 'InputArea');
  if (area) area.classList.add('chat-drag-over');
}

function handleChatDragLeave(event, flow) {
  event.stopPropagation();
  const area = document.getElementById(flow + 'InputArea');
  if (area) area.classList.remove('chat-drag-over');
}

function handleChatDrop(event, flow) {
  event.preventDefault();
  event.stopPropagation();
  const area = document.getElementById(flow + 'InputArea');
  if (area) area.classList.remove('chat-drag-over');
  const files = Array.from(event.dataTransfer.files || []);
  files.forEach(f => _chatFiles[flow].push(f));
  _renderChatChips(flow);
}

function _removeChatFile(flow, idx) {
  _chatFiles[flow].splice(idx, 1);
  _renderChatChips(flow);
}

function _renderChatChips(flow) {
  const el = document.getElementById(flow + 'FileChips');
  if (!el) return;
  const files = _chatFiles[flow];
  el.hidden = files.length === 0;
  el.innerHTML = files.map((f, i) =>
    '<span class="ai-chat-file-chip">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11" aria-hidden="true"><rect x="2" y="1" width="9" height="12" rx="1"/><path d="M8 1v4h4" stroke-linecap="square"/></svg>' +
    '<span class="ai-chat-file-chip-name">' + esc(f.name) + '</span>' +
    '<button type="button" class="ai-chat-file-chip-remove" onclick="_removeChatFile(\'' + flow + '\',' + i + ')" aria-label="Remover arquivo">\xd7</button>' +
    '</span>'
  ).join('');
}

async function _buildChatMessage(flow, text) {
  const files = _chatFiles[flow];
  if (!files.length) return { role: 'user', content: text };

  const extraidos = await Promise.all(
    files.map(async f => ({ nome: f.name, ...await extrairConteudoArquivo(f) }))
  );

  const imagens = extraidos.filter(a => a.tipo === 'imagem');
  const textuais = extraidos.filter(a => a.tipo !== 'imagem');

  let msgText = text;
  if (textuais.length) {
    const bloco = textuais
      .map(a => '[Arquivo: ' + a.nome + ']\n' + String(a.conteudo || '').slice(0, 12000))
      .join('\n\n---\n\n');
    msgText = (text ? text + '\n\n' : '') + bloco;
  }

  if (imagens.length) {
    return {
      role: 'user',
      content: [
        { type: 'text', text: msgText },
        ...imagens.map(img => ({ type: 'image_url', image_url: { url: img.conteudo } }))
      ]
    };
  }

  return { role: 'user', content: msgText };
}

function _clearChatFiles(flow) {
  _chatFiles[flow] = [];
  _renderChatChips(flow);
}

// ── Seguro Garantia chat ───────────────────────────────────────────────────────

async function sendSgChatMessage() {
  const input = document.getElementById('sgChatInput');
  const text = input.value.trim();
  if ((!text && !_chatFiles.sg.length) || sgChatHistory.length === 0) return;

  input.value = '';
  const displayText = text || _chatFiles.sg.map(f => f.name).join(', ');
  appendSgChatMessage('user', displayText);

  const msgObj = await _buildChatMessage('sg', text);
  _clearChatFiles('sg');
  sgChatHistory.push(msgObj);

  const sendBtn = document.getElementById('sgChatSend');
  sendBtn.disabled = true;
  input.disabled = true;

  const sidebarEl = document.getElementById('sgSidebarMessages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'sg-chat-msg sg-chat-msg--ai sg-chat-typing';
  typingDiv.innerHTML = '<div class="sg-chat-dots"><span></span><span></span><span></span></div>';
  sidebarEl.appendChild(typingDiv);
  sidebarEl.scrollTop = sidebarEl.scrollHeight;

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
  const mainEl = document.getElementById('sgChatMessages');
  const sidebarEl = document.getElementById('sgSidebarMessages');

  const div = document.createElement('div');
  if (role === 'assistant' && sgFirstAnalysis) {
    div.className = 'sg-report-wrapper';
    const isJsonData = text && typeof text === 'object' && text.tipo === 'Seguro Garantia';
    div.innerHTML = isJsonData ? renderSeguroGarantiaCard(text) : renderSeguroGarantiaReport(String(text));
    sgFirstAnalysis = false;
    const exportBtn = document.getElementById('sgExportBtn');
    if (exportBtn) exportBtn.hidden = false;
    mainEl.appendChild(div);
    mainEl.scrollTop = mainEl.scrollHeight;
    requestAnimationFrame(syncAiChatStickyOffset);
  } else {
    div.className = 'sg-chat-msg ' + (role === 'user' ? 'sg-chat-msg--user' : 'sg-chat-msg--ai');
    div.innerHTML = role === 'assistant' ? renderMarkdown(text) : '<p>' + esc(text) + '</p>';
    sidebarEl.appendChild(div);
    sidebarEl.scrollTop = sidebarEl.scrollHeight;
  }
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
  // Busca veredicto em toda a resposta (pode estar na conclusao, resumo final ou parecer)
  const verdict = detectVerdictFromText(text);

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
        ${buildDemandaContextoHtml(sgContextoDemanda)}
        ${sections.map(renderReportSection).join('')}
      </div>
    </div>`;
}

// ── Seguro Garantia — Emission Card (renderer completo) ──────────────

function renderSeguroGarantiaCard(data) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  const docTitle = document.getElementById('sgChatTitle').textContent || 'Análise de Contrato';
  const filesText = document.getElementById('sgChatFiles').textContent || '';

  const parecer = data.parecer || {};
  const conclusao = data.conclusao_operacional || {};
  const rec = (parecer.recomendacao || '').toLowerCase();
  const verdictCls = rec.includes('declinar') ? 'declinar' : rec.includes('ressalvas') ? 'ressalvas' : parecer.recomendacao ? 'emitir' : '';
  const verdictLabel = parecer.recomendacao || '';
  const verdictIcon = rec.includes('declinar') ? '✕' : rec.includes('ressalvas') ? '!' : '✓';

  const docs = data.documentos_analisados || [];
  // Só a modalidade da demanda vira card; o resto vira nota de "fora do escopo".
  const { noEscopo: modalidades, foraEscopo } = separarModalidadesPorEscopo(data.modalidades, sgContextoDemanda);
  const temContexto = !!(sgContextoDemanda && sgContextoDemanda.modalidade);
  const modalidadeAusenteHtml = temContexto && modalidades.length === 0 && (data.modalidades || []).length > 0
    ? buildSgModalidadeAusenteHtml(sgContextoDemanda)
    : '';

  const tomadorHtml = buildEmissaoPartBox('Tomador', data.tomador);
  const seguradoHtml = buildEmissaoPartBox('Segurado / Beneficiário', data.segurado);
  const temPartes = tomadorHtml || seguradoHtml;

  const resumoHtml = data.resumo_executivo ? `
    <div class="sg-resumo-executivo">
      <p class="sg-resumo-label">Resumo Executivo</p>
      <p class="sg-resumo-texto">${esc(data.resumo_executivo)}</p>
    </div>` : '';

  const dadosLicitacao = data.dados_licitacao_contrato || {};
  const dadosLicitacaoHtml = buildSgDadosLicitacao(dadosLicitacao, data.tipo_documento_analisado);

  const parecerPendHtml = (parecer.pendencias || []).filter(p => p).length > 0
    ? `<ul class="sg-emission-pendencias">${(parecer.pendencias || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul>`
    : '';

  const parecerHtml = verdictLabel ? `
    <div class="sg-emission-parecer sg-emission-parecer--${verdictCls}">
      <div class="sg-emission-parecer-hdr">
        <span class="sg-emission-parecer-icon" aria-hidden="true">${verdictIcon}</span>
        <div>
          <p class="sg-emission-parecer-label">Parecer de Emissão</p>
          <p class="sg-emission-parecer-rec">${esc(verdictLabel)}</p>
        </div>
      </div>
      ${parecer.justificativa ? `<p class="sg-emission-parecer-just">${esc(parecer.justificativa)}</p>` : ''}
      ${parecerPendHtml}
    </div>` : '';

  const coberturas = data.coberturas_clausulas_exigidas || {};
  const coberturasHtml = buildSgCoberturasHtml(coberturas);

  const apresentacaoHtml = buildSgApresentacaoHtml(data.prazo_e_forma_de_apresentacao || {});

  const alertasHtml = buildSgListaHtml(
    (data.alertas_de_risco || []).concat(data.pendencias_para_emissao || []),
    'sg-alerta-lista', 'sg-alerta-item', 'Alertas e Pendências'
  );

  const perguntasHtml = buildSgListaHtml(
    data.perguntas_para_cliente_ou_comercial || [],
    'sg-perguntas-lista', 'sg-pergunta-item', 'Perguntas ao Cliente / Comercial'
  );

  const conclusaoHtml = buildSgConclusaoHtml(conclusao);

  const trechosHtml = buildSgTrechosHtml(data.trechos_relevantes || []);

  return `
    <div class="sg-report" id="sgReportContent">
      <div class="sg-report-masthead">
        <div class="sg-report-masthead-left">
          <p class="sg-report-eyebrow">Análise Técnica · Seguro Garantia IA</p>
          <h2 class="sg-report-doc-title">${esc(docTitle)}</h2>
          ${filesText && filesText !== docTitle ? `<p class="sg-report-files-label">${esc(filesText)}</p>` : ''}
        </div>
        <div class="sg-report-masthead-right">
          ${verdictLabel ? `<div class="sg-report-verdict-badge sg-report-verdict-badge--${verdictCls}">
            <span class="sg-report-verdict-icon">${verdictIcon}</span>
            <span>${esc(verdictLabel)}</span>
          </div>` : ''}
          <p class="sg-report-gen-date">Gerado em ${dateStr}</p>
        </div>
      </div>

      <div class="sg-emission-body">
        ${docs.length > 0 ? `<div class="sg-docs-analisados">${docs.map(d => `<span class="sg-doc-badge">${esc(d)}</span>`).join('')}</div>` : ''}

        ${buildDemandaContextoHtml(sgContextoDemanda)}

        ${resumoHtml}

        ${dadosLicitacaoHtml}

        ${temPartes ? `<div class="sg-emission-partes-grid">${tomadorHtml}${seguradoHtml}</div>` : ''}

        ${modalidadeAusenteHtml}

        ${modalidades.map(buildSgModalidadeCard).join('')}

        ${buildSgForaEscopoHtml(foraEscopo, sgContextoDemanda)}

        ${coberturasHtml}

        ${apresentacaoHtml}

        ${trechosHtml}

        ${alertasHtml}

        ${perguntasHtml}

        ${conclusaoHtml}

        ${parecerHtml}
      </div>
    </div>`;
}

function buildSgModalidadeCard(modalidade) {
  const clausulas = modalidade.clausulas_necessarias || [];

  const clausulasHtml = clausulas.length > 0
    ? clausulas.map(c => `
      <div class="sg-clausula-nec">
        <p class="sg-clausula-nec-desc">${esc(c.descricao || '')}</p>
        ${c.fonte ? `<span class="sg-dado-fonte"><span class="sg-fonte-arrow" aria-hidden="true">↳</span>${esc(c.fonte)}</span>` : ''}
      </div>`).join('')
    : '';

  const vigenciaHtml = buildVigenciaSgHtml(modalidade);

  const acrescimoBadge = modalidade.exige_acrescimo_90_dias
    ? `<span class="sg-badge sg-badge--info">+90 dias na apólice</span>`
    : '';

  return `
    <div class="sg-modalidade-emission-card">
      <div class="sg-modalidade-emission-head">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" width="16" height="16" aria-hidden="true"><path d="M10 2L3 6v5c0 4.4 3.1 7.6 7 8 3.9-.4 7-3.6 7-8V6L10 2z" stroke-linejoin="round"/></svg>
        <h3 class="sg-modalidade-emission-nome">${esc(modalidade.nome || 'Modalidade')}</h3>
        ${acrescimoBadge}
      </div>
      <div class="sg-modalidade-emission-body">
        ${buildEmissaoFieldRow('IS (Importância Segurada)', modalidade.importancia_segurada, 'brl')}
        ${buildEmissaoFieldRow('Base de Cálculo', modalidade.base_calculo)}
        ${vigenciaHtml}
        ${buildEmissaoFieldRow('Objeto da Apólice', modalidade.objeto_apolice)}
        ${clausulas.length > 0 ? `
          <div class="sg-clausulas-nec-wrap">
            <p class="sg-clausulas-nec-label">Cláusulas Necessárias na Apólice</p>
            ${clausulasHtml}
          </div>` : ''}
      </div>
    </div>`;
}

function buildVigenciaSgHtml(modalidade) {
  const ini = modalidade.vigencia_inicio && modalidade.vigencia_inicio.valor;
  const fim = modalidade.vigencia_fim && modalidade.vigencia_fim.valor;
  const obs = modalidade.vigencia_obs && modalidade.vigencia_obs.valor;
  if (!ini && !fim && !obs) return '';

  let vigVal, vigFonte;
  if (ini && fim) {
    vigVal = `${ini} a ${fim}`;
    vigFonte = (modalidade.vigencia_inicio.fonte || modalidade.vigencia_fim.fonte || '');
  } else if (obs) {
    vigVal = obs;
    vigFonte = (modalidade.vigencia_obs && modalidade.vigencia_obs.fonte) || '';
  } else {
    vigVal = ini || fim || '';
    vigFonte = (ini ? modalidade.vigencia_inicio : modalidade.vigencia_fim).fonte || '';
  }
  return `
    <div class="sg-dado-item">
      <span class="sg-dado-label">Vigência</span>
      <div class="sg-dado-right">
        <span class="sg-dado-valor">${esc(vigVal)}</span>
        ${vigFonte ? `<span class="sg-dado-fonte"><span class="sg-fonte-arrow" aria-hidden="true">↳</span>${esc(vigFonte)}</span>` : ''}
      </div>
    </div>`;
}

function buildEmissaoPartBox(label, item) {
  if (!item || item.valor === null || item.valor === undefined || String(item.valor) === 'null' || String(item.valor).trim() === '') return '';
  const cnpjHtml = item.cnpj && String(item.cnpj) !== 'null' && String(item.cnpj).trim()
    ? `<p class="sg-emission-parte-cnpj">${esc(String(item.cnpj))}</p>`
    : '';
  const enderecoHtml = item.endereco && String(item.endereco) !== 'null' && String(item.endereco).trim()
    ? `<p class="sg-emission-parte-endereco">${esc(String(item.endereco))}</p>`
    : '';
  return `
    <div class="sg-emission-parte-box">
      <p class="sg-emission-parte-label">${esc(label)}</p>
      <p class="sg-emission-parte-valor">${esc(String(item.valor))}</p>
      ${cnpjHtml}
      ${enderecoHtml}
      ${item.fonte ? `<p class="sg-emission-parte-fonte"><span class="sg-fonte-arrow" aria-hidden="true">↳</span>${esc(item.fonte)}</p>` : ''}
    </div>`;
}

function buildEmissaoFieldRow(label, item, format) {
  if (!item || item.valor === null || item.valor === undefined || String(item.valor) === 'null' || String(item.valor).trim() === '') return '';
  let display = item.valor;
  const isMonetario = format === 'brl' && typeof item.valor === 'number';
  if (isMonetario) display = fmtBRL(item.valor);
  return `
    <div class="sg-dado-item${isMonetario ? ' sg-dado-item--destaque' : ''}">
      <span class="sg-dado-label">${esc(label)}</span>
      <div class="sg-dado-right">
        <span class="sg-dado-valor">${esc(String(display))}</span>
        ${item.fonte ? `<span class="sg-dado-fonte"><span class="sg-fonte-arrow" aria-hidden="true">↳</span>${esc(item.fonte)}</span>` : ''}
      </div>
    </div>`;
}

function buildSgDadosLicitacao(d, tipoDocumento) {
  const fields = [
    { label: 'Tipo de Documento', val: tipoDocumento },
    { label: 'Nº do Edital', val: d.numero_edital },
    { label: 'Nº do Processo', val: d.numero_processo },
    { label: 'Modalidade de Licitação', val: d.modalidade_licitacao },
    { label: 'Nº do Contrato', val: d.numero_contrato },
    { label: 'Nº da Ata', val: d.numero_ata },
  ].filter(f => f.val && String(f.val) !== 'null' && String(f.val).trim());

  const objetoHtml = d.objeto && String(d.objeto) !== 'null' && String(d.objeto).trim()
    ? `<div class="sg-licitacao-objeto"><span class="sg-licitacao-objeto-label">Objeto:</span> ${esc(String(d.objeto))}</div>`
    : '';

  if (!fields.length && !objetoHtml) return '';

  return `
    <div class="sg-licitacao-card">
      <p class="sg-section-mini-title">Dados da Licitação / Contrato</p>
      ${fields.length > 0 ? `<div class="sg-licitacao-grid">${fields.map(f => `
        <div class="sg-licitacao-field">
          <span class="sg-licitacao-label">${esc(f.label)}</span>
          <span class="sg-licitacao-valor">${esc(String(f.val))}</span>
        </div>`).join('')}</div>` : ''}
      ${objetoHtml}
    </div>`;
}

function buildSgCoberturasHtml(cob) {
  const mapa = [
    { key: 'multas', label: 'Cobertura de Multas' },
    { key: 'trabalhista_previdenciaria', label: 'Trabalhista / Previdenciária' },
    { key: 'fiscal', label: 'Obrigações Fiscais' },
    { key: 'clausula_retomada', label: 'Cláusula de Retomada' },
    { key: 'adiantamento_pagamento', label: 'Adiantamento de Pagamento' },
    { key: 'retencao_pagamento', label: 'Retenção de Pagamento' },
    { key: 'manutencao_corretiva', label: 'Manutenção Corretiva' },
  ];
  const ativas = mapa.filter(m => cob[m.key] === true);
  const outras = Array.isArray(cob.outras) ? cob.outras.filter(o => o) : [];

  if (!ativas.length && !outras.length) return '';

  return `
    <div class="sg-coberturas-card">
      <p class="sg-section-mini-title">Coberturas / Cláusulas Exigidas</p>
      <div class="sg-coberturas-grid">
        ${ativas.map(m => `<span class="sg-cobertura-badge">${esc(m.label)}</span>`).join('')}
        ${outras.map(o => `<span class="sg-cobertura-badge sg-cobertura-badge--outra">${esc(o)}</span>`).join('')}
      </div>
    </div>`;
}

function buildSgApresentacaoHtml(ap) {
  const campos = [
    { label: 'Prazo', val: ap.prazo },
    { label: 'Momento', val: ap.momento },
    { label: 'Forma de Envio', val: ap.forma_envio },
  ].filter(c => c.val && String(c.val) !== 'null' && String(c.val).trim());

  const pdfBadge = ap.arquivo_unico_pdf
    ? `<span class="sg-badge sg-badge--warn">Arquivo único PDF obrigatório</span>`
    : '';

  if (!campos.length && !pdfBadge) return '';

  return `
    <div class="sg-apresentacao-card">
      <p class="sg-section-mini-title">Prazo e Forma de Apresentação</p>
      <div class="sg-apresentacao-grid">
        ${campos.map(c => `
          <div class="sg-apresentacao-field">
            <span class="sg-licitacao-label">${esc(c.label)}</span>
            <span class="sg-licitacao-valor">${esc(String(c.val))}</span>
          </div>`).join('')}
      </div>
      ${pdfBadge}
    </div>`;
}

function buildSgListaHtml(itens, listaClass, itemClass, titulo) {
  const validos = (itens || []).filter(i => i && String(i).trim());
  if (!validos.length) return '';
  return `
    <div class="sg-lista-card">
      <p class="sg-section-mini-title">${esc(titulo)}</p>
      <ul class="${listaClass}">
        ${validos.map(i => `<li class="${itemClass}">${esc(i)}</li>`).join('')}
      </ul>
    </div>`;
}

function buildSgConclusaoHtml(c) {
  if (!c || (c.pode_cotar === undefined && c.pode_emitir === undefined)) return '';
  const nivel = String(c.nivel_confianca || '').toUpperCase();
  const nivelCls = nivel === 'ALTA' ? 'alta' : nivel === 'MEDIA' ? 'media' : 'baixa';
  return `
    <div class="sg-conclusao-card">
      <p class="sg-section-mini-title">Conclusão Operacional</p>
      <div class="sg-conclusao-grid">
        <div class="sg-conclusao-item">
          <span class="sg-conclusao-icone ${c.pode_cotar ? 'sg-conclusao-sim' : 'sg-conclusao-nao'}" aria-hidden="true">${c.pode_cotar ? '✓' : '✕'}</span>
          <span class="sg-conclusao-label">Pode Cotar</span>
        </div>
        <div class="sg-conclusao-item">
          <span class="sg-conclusao-icone ${c.pode_emitir ? 'sg-conclusao-sim' : 'sg-conclusao-nao'}" aria-hidden="true">${c.pode_emitir ? '✓' : '✕'}</span>
          <span class="sg-conclusao-label">Pode Emitir</span>
        </div>
        <div class="sg-conclusao-item">
          <span class="sg-badge sg-badge--confianca sg-badge--confianca-${nivelCls}">Confiança ${esc(nivel || 'N/D')}</span>
        </div>
      </div>
      ${c.motivo ? `<p class="sg-conclusao-motivo">${esc(c.motivo)}</p>` : ''}
    </div>`;
}

function buildSgTrechosHtml(trechos) {
  const validos = (trechos || []).filter(t => t && (t.tema || t.trecho));
  if (!validos.length) return '';
  return `
    <div class="sg-trechos-card">
      <p class="sg-section-mini-title">Trechos Relevantes do Documento</p>
      ${validos.map(t => `
        <div class="sg-trecho-item">
          ${t.tema ? `<p class="sg-trecho-tema">${esc(t.tema)}</p>` : ''}
          ${t.trecho ? `<blockquote class="sg-trecho-texto">${esc(t.trecho)}</blockquote>` : ''}
          ${t.pagina_ou_localizacao ? `<span class="sg-dado-fonte"><span class="sg-fonte-arrow" aria-hidden="true">↳</span>${esc(t.pagina_ou_localizacao)}</span>` : ''}
        </div>`).join('')}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────

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
  // Remove prefixo numérico "1. " ou "12. "
  const t = title.replace(/^\d+\.\s*/, '').toLowerCase();
  if (t.includes('classifica')) return { type: 'classificacao' };
  if (t.includes('modalidade')) return { type: 'modalidades' };
  if (t.includes('partes ident')) return { type: 'partes' };
  if (t.includes('dados principais') || t.includes('dados para emiss') || t.includes('emissao') || t.includes('emissão')) return { type: 'dados-emissao' };
  if (t.includes('dados gerais') || t.includes('partes') || t.includes('dados g')) return { type: 'dados' };
  if (t.includes('calculo') || t.includes('cálculo') || t.includes('importancia') || t.includes('importância')) return { type: 'calculo' };
  if (t.includes('vigencia') || t.includes('vigência')) return { type: 'vigencia' };
  if (t.includes('objeto')) return { type: 'objeto' };
  if (t.includes('clausulas') || t.includes('cláusulas') || t.includes('coberturas')) return { type: 'clausulas' };
  if (t.includes('pontos de') || t.includes('atencao') || t.includes('atenção') || t.includes('riscos') || t.includes('risco')) return { type: 'riscos' };
  if (t.includes('documentos') || t.includes('pendentes') || t.includes('pendencias') || t.includes('pendências')) return { type: 'pendencias' };
  if (t.includes('conclusao') || t.includes('conclusão') || t.includes('operacional')) return { type: 'conclusao' };
  if (t.includes('resumo final') || t.includes('cadastro')) return { type: 'resumo-final' };
  if (t.includes('parecer')) return { type: 'parecer' };
  if (t.includes('resumo')) return { type: 'resumo' };
  return { type: 'default' };
}

function getSectionSvgIcon(type) {
  const icons = {
    classificacao:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h12M4 10h8M4 14h5" stroke-linecap="round"/><rect x="2" y="2" width="16" height="16" rx="2"/></svg>',
    partes:         '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="7" r="3"/><circle cx="14" cy="7" r="2.5"/><path d="M2 17c0-3 2.7-5 6-5s6 2 6 5" stroke-linecap="round"/><path d="M15 12c1.7.5 3 2 3 4" stroke-linecap="round"/></svg>',
    dados:          '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 3L2 8v9h5v-5h6v5h5V8L10 3z" stroke-linejoin="round"/></svg>',
    'dados-emissao':'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M7 7h6M7 10h6M7 13h3" stroke-linecap="round"/></svg>',
    modalidades:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 2L3 6v5c0 4.4 3.1 7.6 7 8 3.9-.4 7-3.6 7-8V6L10 2z" stroke-linejoin="round"/></svg>',
    calculo:        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M7 10h6M10 7v6" stroke-linecap="round"/></svg>',
    vigencia:       '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    objeto:         '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h12v2H4zM4 9h12M4 13h8" stroke-linecap="round"/><rect x="3" y="3" width="14" height="14" rx="1.5"/></svg>',
    clausulas:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="2" width="12" height="16" rx="1.5"/><path d="M7 7h6M7 10.5h6M7 14h3" stroke-linecap="round"/></svg>',
    riscos:         '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 3L2 17h16L10 3z" stroke-linejoin="round"/><path d="M10 10v3M10 15h.01" stroke-linecap="round"/></svg>',
    pendencias:     '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="7"/><path d="M10 6v4M10 14h.01" stroke-linecap="round"/></svg>',
    conclusao:      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="7"/><path d="M7 10l2.5 2.5L14 8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    'resumo-final': '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M7 7h6M7 10h6M7 13h6" stroke-linecap="round"/></svg>',
    parecer:        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="7"/><path d="M7 10l2.5 2.5L14 8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    resumo:         '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="2" width="12" height="16" rx="1.5"/><path d="M7 7h6M7 10.5h6M7 14h4" stroke-linecap="round"/></svg>',
    default:        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="2" width="12" height="16" rx="1.5"/><path d="M7 8h6M7 12h4" stroke-linecap="round"/></svg>',
  };
  return icons[type] || icons.default;
}

function detectVerdictFromText(text) {
  const l = (text || '').toLowerCase();
  if (l.includes('declinar')) return { cls: 'declinar', label: 'Declinar', icon: '✕' };
  if (l.includes('com ressalvas') || l.includes('ressalvas')) return { cls: 'ressalvas', label: 'Emitir com Ressalvas', icon: '!' };
  if (l.includes('emitir')) return { cls: 'emitir', label: 'Emitir', icon: '✓' };
  return null;
}

function renderReportSection(section) {
  if (!section.title && !section.content.trim()) return '';
  const meta = getSectionMeta(section.title);

  if (meta.type === 'resumo-final') {
    return renderResumoFinalSection(section);
  }

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

function renderResumoFinalSection(section) {
  const lines = (section.content || '').split('\n').filter(l => l.trim());
  const fields = lines.map(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) return null;
    const label = line.slice(0, colonIdx).trim().replace(/^\*+|\*+$/g, '');
    const value = line.slice(colonIdx + 1).trim();
    return label ? { label, value } : null;
  }).filter(Boolean);

  const fieldsHtml = fields.length > 0
    ? fields.map(f => `
      <div class="sg-resumo-field">
        <span class="sg-resumo-field-label">${esc(f.label)}</span>
        <span class="sg-resumo-field-value">${f.value ? esc(f.value) : '<em>Não localizado</em>'}</span>
      </div>`).join('')
    : renderReportMarkdown(section.content);

  return `
    <div class="sg-report-section sg-report-section--resumo-final">
      <div class="sg-report-section-head">
        <div class="sg-report-section-icon sg-report-icon--resumo-final">${getSectionSvgIcon('resumo-final')}</div>
        <h3 class="sg-report-section-title">${esc(section.title || 'Resumo Final para Cadastro')}</h3>
        <span class="sg-resumo-final-tag">Pronto para emissão</span>
      </div>
      <div class="sg-report-section-body sg-resumo-final-body">
        <div class="sg-resumo-final-grid">${fieldsHtml}</div>
      </div>
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
  if (fiancaFiles.length === 0) {
    showFiancaError('Anexe ao menos um documento antes de analisar.');
    return;
  }

  // Revalida a modalidade no envio — nunca confia só no estado do botão.
  const leitura = lerContextoDemanda('fl');
  if (!leitura.ok) {
    showDemandaErro('fl', leitura.erro, leitura.foco);
    return;
  }
  flContextoDemanda = leitura.contexto;
  hideDemandaErro('fl');

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
    const resultado = await analisarFiancaLocaticia(fiancaFiles, flContextoDemanda);
    flAnaliseData = resultado;
    renderFiancaLocaticia(resultado);
  } catch (err) {
    document.getElementById('flLoading').hidden = true;
    document.getElementById('flUploadSection').hidden = false;
    showFiancaError('Erro ao analisar: ' + err.message);
  } finally {
    btn.querySelector('.btn-label').textContent = 'Analisar com IA';
    refreshDemandaState('fl');
  }
}

function resetFiancaLocaticia() {
  fiancaFiles = [];
  flChatHistory = [];
  flFirstAnalysis = true;
  flAnaliseData = null;
  flContextoDemanda = null;
  renderContratoFileList(fiancaFiles, 'fiancaFileList', 'fianca');
  resetDemandaFields('fl');
  document.getElementById('flChatArea').hidden = true;
  document.getElementById('flUploadSection').hidden = false;
  document.getElementById('flChatMessages').innerHTML = '';
  document.getElementById('flSidebarMessages').innerHTML = '';
  _clearChatFiles('fl');
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
  flChatHistory = criarHistoricoFiancaLocaticia(fiancaFiles, JSON.stringify(data), flContextoDemanda);

  // Render as first chat message
  const reportHtml = buildFlReportHtml(data, locatario, imovel, dateStr);
  appendFlChatMessage('report', reportHtml);

  const exportBtn = document.getElementById('flExportBtn');
  if (exportBtn) exportBtn.hidden = false;

  _addChatHint('flSidebarMessages', [
    'Há cláusula de sub-rogação neste contrato?',
    'O valor da garantia cobre 3 meses de aluguel?',
    'Qual é o índice de reajuste e quando se aplica?',
    'Quais riscos foram identificados para a seguradora?',
  ], 'fl');
  requestAnimationFrame(syncAiChatStickyOffset);
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
  const isMonetario = format === 'brl' && typeof item.valor === 'number';
  if (isMonetario) display = fmtBRL(item.valor);
  return `
    <div class="sg-dado-item${isMonetario ? ' sg-dado-item--destaque' : ''}">
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
  const clausulasNec = data.clausulas_necessarias || [];
  const docs = data.documentos_analisados || [];
  const parecer = data.parecer || {};

  // Veredicto
  const rec = (parecer.recomendacao || '').toLowerCase();
  const verdictCls = rec.includes('declinar') ? 'declinar' : rec.includes('ressalvas') ? 'ressalvas' : parecer.recomendacao ? 'emitir' : '';
  const verdictLabel = parecer.recomendacao || '';
  const verdictIcon = rec.includes('declinar') ? '✕' : rec.includes('ressalvas') ? '!' : '✓';

  // Partes: Locatário (Tomador) + Locador (Segurado) em grid
  const locatarioHtml = buildEmissaoPartBox('Tomador (Locatário)', dados.locatario);
  const locadorHtml = buildEmissaoPartBox('Segurado / Beneficiário (Locador)', dados.locador);
  const temPartes = locatarioHtml || locadorHtml;

  // Dados essenciais de emissão
  const emissaoCfg = [
    { key: 'valor_garantia',  label: 'IS (Valor da Garantia)',  format: 'brl' },
    { key: 'vigencia_inicio', label: 'Início da Vigência' },
    { key: 'vigencia_fim',    label: 'Fim da Vigência' },
    { key: 'indice_reajuste', label: 'Índice de Reajuste' },
    { key: 'valor_aluguel',   label: 'Valor do Aluguel',        format: 'brl' },
  ];
  const emissaoHtml = emissaoCfg
    .map(cfg => buildDadoItem(cfg.label, dados[cfg.key], cfg.format))
    .filter(Boolean).join('');

  // Objeto da apólice
  const objetoHtml = data.objeto_apolice && data.objeto_apolice.valor && String(data.objeto_apolice.valor) !== 'null'
    ? `<div class="sg-dado-item">
        <span class="sg-dado-label">Objeto da Apólice</span>
        <div class="sg-dado-right">
          <span class="sg-dado-valor">${esc(String(data.objeto_apolice.valor))}</span>
          ${data.objeto_apolice.fonte ? `<span class="sg-dado-fonte"><span class="sg-fonte-arrow" aria-hidden="true">↳</span>${esc(data.objeto_apolice.fonte)}</span>` : ''}
        </div>
      </div>`
    : '';

  // Cláusulas necessárias na apólice
  const clausulasNecHtml = clausulasNec.length > 0
    ? clausulasNec.map(c => `
      <div class="sg-clausula-nec">
        <p class="sg-clausula-nec-desc">${esc(c.descricao || '')}</p>
        ${c.fonte ? `<span class="sg-dado-fonte"><span class="sg-fonte-arrow" aria-hidden="true">↳</span>${esc(c.fonte)}</span>` : ''}
      </div>`).join('')
    : '';

  // Dados complementares do contrato
  const complementarCfg = [
    { key: 'imovel',           label: 'Imóvel' },
    { key: 'finalidade',       label: 'Finalidade' },
    { key: 'encargos_mensais', label: 'Encargos Mensais' },
    { key: 'multa_rescisao',   label: 'Multa por Rescisão' },
    { key: 'sub_rogacao',      label: 'Sub-rogação' },
    { key: 'foro',             label: 'Foro de Eleição' },
  ];
  const complementarHtml = complementarCfg
    .map(cfg => buildDadoItem(cfg.label, dados[cfg.key]))
    .filter(Boolean).join('');

  // Cláusulas críticas do contrato
  const clausulasHtml = clausulas.length > 0
    ? clausulas.map((c, i) => {
        const imp = (c.impacto || '').toLowerCase().replace('é', 'e');
        return `<details class="fl-clausula-item"${i < 2 ? ' open' : ''}>
          <summary class="fl-clausula-summary">
            <span class="fl-nivel-badge fl-nivel--${imp}">${esc(c.impacto || '—')}</span>
            <span class="fl-clausula-titulo">${esc(c.titulo || 'Cláusula sem título')}</span>
            <span class="fl-clausula-chevron">▾</span>
          </summary>
          <div class="fl-clausula-body">
            ${c.descricao ? `<p>${esc(c.descricao)}</p>` : ''}
            ${c.fonte ? `<p class="fl-fonte-cite"><strong>Fonte:</strong> <em>${esc(c.fonte)}</em></p>` : ''}
          </div>
        </details>`;
      }).join('')
    : '<p class="af-no-data">Nenhuma cláusula crítica identificada.</p>';

  return `
    <div class="fl-report" id="flReportContent">
      <div class="fl-report-masthead">
        <div class="fl-masthead-left">
          <p class="fl-report-eyebrow">Fiança Locatícia IA · Análise Técnica</p>
          <h2 class="fl-report-title">${esc(locatario)}</h2>
          ${imovel ? `<p class="fl-report-subtitle">${esc(imovel)}</p>` : ''}
        </div>
        <div class="fl-masthead-right">
          ${verdictLabel ? `<div class="sg-report-verdict-badge sg-report-verdict-badge--${verdictCls}">
            <span class="sg-report-verdict-icon">${verdictIcon}</span>
            <span>${esc(verdictLabel)}</span>
          </div>` : ''}
          <p class="fl-report-gen-date">Gerado em ${dateStr}</p>
        </div>
      </div>

      <div class="fl-report-body">
        ${docs.length > 0 ? `<div class="sg-docs-analisados">${docs.map(d => `<span class="sg-doc-badge">${esc(d)}</span>`).join('')}</div>` : ''}

        ${buildDemandaContextoHtml(flContextoDemanda)}

        ${temPartes ? `<div class="sg-emission-partes-grid">${locatarioHtml}${locadorHtml}</div>` : ''}

        <div class="fl-report-section">
          <div class="fl-section-head">
            <svg class="fl-section-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M7 7h6M7 10h6M7 13h3" stroke-linecap="round"/></svg>
            <h2 class="fl-section-title">Dados de Emissão</h2>
          </div>
          <div class="sg-dados-card">
            ${emissaoHtml || '<p class="af-no-data" style="padding:16px 20px">Dados não extraídos.</p>'}
            ${objetoHtml}
          </div>
        </div>

        ${clausulasNecHtml ? `
        <div class="fl-report-section">
          <div class="fl-section-head">
            <svg class="fl-section-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="2" width="12" height="16" rx="1.5"/><path d="M7 7h6M7 10.5h6M7 14h3" stroke-linecap="round"/></svg>
            <h2 class="fl-section-title">Cláusulas Necessárias na Apólice</h2>
          </div>
          <div class="sg-clausulas-nec-wrap">${clausulasNecHtml}</div>
        </div>` : ''}

        ${complementarHtml ? `
        <div class="fl-report-section">
          <div class="fl-section-head">
            <svg class="fl-section-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="2" width="12" height="16" rx="1.5"/><path d="M7 7h6M7 10.5h6M7 14h4" stroke-linecap="round"/></svg>
            <h2 class="fl-section-title">Dados Complementares</h2>
          </div>
          <div class="sg-dados-card">${complementarHtml}</div>
        </div>` : ''}

        <div class="fl-report-section">
          <div class="fl-section-head">
            <svg class="fl-section-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="2" width="12" height="16" rx="1.5"/><path d="M7 7h6M7 10.5h6M7 14h3" stroke-linecap="round"/></svg>
            <h2 class="fl-section-title">Cláusulas do Contrato</h2>
          </div>
          <div class="fl-clausulas-list">${clausulasHtml}</div>
        </div>

        ${(parecer.justificativa || data.resumo) ? `
        <div class="fl-report-section fl-report-section--parecer">
          <div class="fl-section-head">
            <svg class="fl-section-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10" cy="10" r="7"/><path d="M7 10l2.5 2.5L14 8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <h2 class="fl-section-title">Parecer</h2>
          </div>
          <div class="fl-parecer-body">
            ${parecer.justificativa ? `<p class="fl-parecer-justificativa">${esc(parecer.justificativa)}</p>` : ''}
            ${parecer.condicoes && parecer.condicoes.length > 0 ? `<div class="fl-condicoes"><p class="fl-condicoes-label">Condições para emissão:</p><ul>${parecer.condicoes.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
          </div>
        </div>` : ''}
      </div>
    </div>`;
}

function appendFlChatMessage(role, content) {
  const mainEl = document.getElementById('flChatMessages');
  const sidebarEl = document.getElementById('flSidebarMessages');

  const div = document.createElement('div');
  if (role === 'report') {
    div.className = 'fl-report-wrapper';
    div.innerHTML = content;
    flFirstAnalysis = false;
    mainEl.appendChild(div);
    mainEl.scrollTop = mainEl.scrollHeight;
  } else {
    div.className = 'sg-chat-msg ' + (role === 'user' ? 'sg-chat-msg--user' : 'sg-chat-msg--ai');
    div.innerHTML = role === 'assistant' ? renderMarkdown(content) : '<p>' + esc(content) + '</p>';
    sidebarEl.appendChild(div);
    sidebarEl.scrollTop = sidebarEl.scrollHeight;
  }
}

async function sendFlChatMessage() {
  const input = document.getElementById('flChatInput');
  const text = input.value.trim();
  if ((!text && !_chatFiles.fl.length) || flChatHistory.length === 0) return;

  input.value = '';
  const displayText = text || _chatFiles.fl.map(f => f.name).join(', ');
  appendFlChatMessage('user', displayText);

  const msgObj = await _buildChatMessage('fl', text);
  _clearChatFiles('fl');
  flChatHistory.push(msgObj);

  const sendBtn = document.getElementById('flChatSend');
  sendBtn.disabled = true;
  input.disabled = true;

  const flSidebarEl = document.getElementById('flSidebarMessages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'sg-chat-msg sg-chat-msg--ai sg-chat-typing';
  typingDiv.innerHTML = '<div class="sg-chat-dots"><span></span><span></span><span></span></div>';
  flSidebarEl.appendChild(typingDiv);
  flSidebarEl.scrollTop = flSidebarEl.scrollHeight;

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

let apoliceAnaliseData = null;

async function processarAnaliseApolice() {
  if (apoliceFiles.length === 0) return;
  const btn = document.getElementById('btnAnalyzeApolice');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = 'Analisando…';
  hideApoliceError();

  document.getElementById('apUploadSection').hidden = true;
  document.getElementById('apLoading').hidden = false;
  document.getElementById('apResultArea').hidden = true;
  const exportBtn = document.getElementById('apExportBtn');
  if (exportBtn) exportBtn.hidden = true;

  try {
    const resultado = await analisarApolice(apoliceFiles);
    apoliceAnaliseData = resultado;
    renderAnaliseApolice(resultado);
  } catch (err) {
    document.getElementById('apLoading').hidden = true;
    document.getElementById('apUploadSection').hidden = false;
    showApoliceError('Erro ao analisar: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = 'Analisar com IA';
  }
}

function resetAnaliseApolice() {
  apoliceFiles = [];
  apoliceAnaliseData = null;
  apChatHistory = [];
  _chatFiles.ap = [];
  renderContratoFileList(apoliceFiles, 'apoliceFileList', 'apolice');
  document.getElementById('btnAnalyzeApolice').disabled = true;
  document.getElementById('apResultArea').hidden = true;
  document.getElementById('apUploadSection').hidden = false;
  document.getElementById('apReportContainer').innerHTML = '';
  document.getElementById('apSidebarMessages').innerHTML = '';
  const exportBtn = document.getElementById('apExportBtn');
  if (exportBtn) exportBtn.hidden = true;
  hideApoliceError();
}

function renderAnaliseApolice(data) {
  document.getElementById('apLoading').hidden = true;
  document.getElementById('apResultArea').hidden = false;

  const dados = data.dados_gerais || {};
  const title = getApoliceValor(dados.tomador) || getApoliceValor(dados.segurado) || 'Dados da Apólice';
  const filesText = apoliceFiles.map(f => f.name).join(' · ');

  document.getElementById('apChatTitle').textContent = title;
  document.getElementById('apChatFiles').textContent = filesText;
  document.getElementById('apReportContainer').innerHTML = buildApoliceReportHtml(data, title);

  const exportBtn = document.getElementById('apExportBtn');
  if (exportBtn) exportBtn.hidden = false;

  apChatHistory = criarHistoricoApolice(apoliceFiles, JSON.stringify(data));
  document.getElementById('apSidebarMessages').innerHTML = '';
  _addChatHint('apSidebarMessages', [
    'Quais coberturas estão ativas nesta apólice?',
    'O que está excluído da cobertura?',
    'Qual é a importância segurada?',
    'Qual é a vigência da apólice?',
  ], 'ap');
  requestAnimationFrame(syncAiChatStickyOffset);
}

function getApoliceValor(item) {
  if (!item || item.valor === null || item.valor === undefined || item.valor === 'null') return '';
  return String(item.valor).trim();
}

function buildApoliceReportHtml(data, title) {
  const dados = data.dados_gerais || {};
  const docs = data.documentos_analisados || [];
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

  const dadosRows = APOLICE_DADOS_CONFIG.map(cfg => buildApoliceDadoRow(cfg, dados[cfg.key])).join('');
  const coberturasHtml = buildApoliceList(data.coberturas, 'Nenhuma cobertura localizada.');
  const clausulasHtml = buildApoliceList(data.clausulas, 'Nenhuma cláusula localizada.');
  const excluidosHtml = buildApoliceList(data.riscos_excluidos, 'Nenhum risco excluído localizado.');

  return `
    <div class="ap-report" id="apReportContent">
      <div class="fl-report-masthead ap-report-masthead">
        <div class="fl-masthead-left">
          <p class="fl-report-eyebrow">Análise de Apólice IA</p>
          <h2 class="fl-report-title">${esc(title)}</h2>
          <p class="fl-report-subtitle">Dados essenciais extraídos da apólice</p>
        </div>
        <div class="fl-masthead-right">
          <p class="fl-report-gen-date">Gerado em ${dateStr}</p>
        </div>
      </div>

      <div class="fl-report-body">
        ${docs.length > 0 ? `<div class="sg-docs-analisados">${docs.map(d => `<span class="sg-doc-badge">${esc(d)}</span>`).join('')}</div>` : ''}

        <div class="fl-report-section">
          <div class="fl-section-head">
            <svg class="fl-section-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M7 7h6M7 10h6M7 13h3" stroke-linecap="round"/></svg>
            <h2 class="fl-section-title">Dados da Apólice</h2>
          </div>
          <table class="fl-dados-table ap-dados-table">
            <thead><tr><th>Campo</th><th>Valor</th><th>Fonte no Documento</th></tr></thead>
            <tbody>${dadosRows}</tbody>
          </table>
        </div>

        <div class="fl-report-section">
          <div class="fl-section-head">
            <svg class="fl-section-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 2L3 6v5c0 4.4 3.1 7.6 7 8 3.9-.4 7-3.6 7-8V6L10 2z" stroke-linejoin="round"/></svg>
            <h2 class="fl-section-title">Coberturas da Apólice</h2>
          </div>
          <div class="ap-list">${coberturasHtml}</div>
        </div>

        <div class="fl-report-section">
          <div class="fl-section-head">
            <svg class="fl-section-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="2.5" width="12" height="15" rx="1.5"/><path d="M7 6h6M7 9h6M7 12h4" stroke-linecap="round"/></svg>
            <h2 class="fl-section-title">Cláusulas e Condições</h2>
          </div>
          <div class="ap-list">${clausulasHtml}</div>
        </div>

        <div class="fl-report-section">
          <div class="fl-section-head">
            <svg class="fl-section-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 3L2 17h16L10 3z" stroke-linejoin="round"/><path d="M10 10v3M10 15h.01" stroke-linecap="round"/></svg>
            <h2 class="fl-section-title">Riscos Excluídos</h2>
          </div>
          <div class="ap-list">${excluidosHtml}</div>
        </div>
      </div>
    </div>`;
}

function buildApoliceDadoRow(cfg, item) {
  const rawVal = item && typeof item === 'object' ? item.valor : item;
  const fonte = item && typeof item === 'object' ? item.fonte : '';
  let display = 'Não localizado';
  if (rawVal !== null && rawVal !== undefined && rawVal !== 'null' && String(rawVal).trim() !== '') {
    display = cfg.format === 'brl' && typeof rawVal === 'number' ? fmtBRL(rawVal) : String(rawVal);
  }
  return `<tr>
    <td class="fl-dados-label">${esc(cfg.label)}</td>
    <td class="fl-dados-value">${esc(display)}</td>
    <td class="fl-dados-fonte"><em>${fonte ? esc(fonte) : '—'}</em></td>
  </tr>`;
}

function buildApoliceList(items, emptyText) {
  if (!Array.isArray(items) || items.length === 0) return `<p class="af-no-data">${esc(emptyText)}</p>`;
  return items.map(item => {
    const isObj = item && typeof item === 'object';
    const titulo = isObj ? (item.titulo || item.nome || '') : '';
    const descricao = typeof item === 'string' ? item : (item.descricao || item.valor || item.nome || '');
    const fonte = isObj ? item.fonte : '';
    const limiteRaw = isObj ? (item.limite ?? item.lmi ?? item.importancia_segurada) : null;
    let limite = '';
    if (limiteRaw !== null && limiteRaw !== undefined && limiteRaw !== 'null' && String(limiteRaw).trim() !== '') {
      limite = typeof limiteRaw === 'number' ? fmtBRL(limiteRaw) : String(limiteRaw);
    }
    return `<div class="ap-list-item card">
      ${titulo ? `<p class="ap-list-title">${esc(titulo)}</p>` : ''}
      <p class="ap-list-desc">${esc(descricao || 'Não localizado')}</p>
      ${limite ? `<p class="ap-list-limite"><strong>Limite / IS:</strong> ${esc(limite)}</p>` : ''}
      ${fonte ? `<p class="fl-fonte-cite"><em>${esc(fonte)}</em></p>` : ''}
    </div>`;
  }).join('');
}

async function downloadApoliceReport() {
  const btn = document.getElementById('apExportBtn');
  const btnOrigHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Gerando PDF…'; }

  const el = document.getElementById('apReportContent');
  if (!el) { if (btn) { btn.disabled = false; btn.innerHTML = btnOrigHTML; } return; }

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
    const title = document.getElementById('apChatTitle').textContent || 'relatorio-analise-apolice';
    const safeTitle = title.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim() || 'relatorio-analise-apolice';
    pdf.save(safeTitle + '.pdf');
  } catch (err) {
    console.error('Erro ao gerar PDF da análise de apólice:', err);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btnOrigHTML; }
  }
}

// ── Apólice Q&A chat ─────────────────────────────────────────────────────────
let apChatHistory = [];

function appendApSidebarMessage(role, text) {
  const el = document.getElementById('apSidebarMessages');
  const div = document.createElement('div');
  div.className = 'sg-chat-msg ' + (role === 'user' ? 'sg-chat-msg--user' : 'sg-chat-msg--ai');
  div.innerHTML = role === 'assistant' ? renderMarkdown(text) : '<p>' + esc(text) + '</p>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

async function sendApoliceChatMessage() {
  const input = document.getElementById('apChatInput');
  const text = input.value.trim();
  if ((!text && !_chatFiles.ap.length) || apChatHistory.length === 0) return;

  input.value = '';
  const displayText = text || _chatFiles.ap.map(f => f.name).join(', ');
  appendApSidebarMessage('user', displayText);

  const msgObj = await _buildChatMessage('ap', text);
  _clearChatFiles('ap');
  apChatHistory.push(msgObj);

  const sendBtn = document.getElementById('apChatSend');
  sendBtn.disabled = true;
  input.disabled = true;

  const sidebarEl = document.getElementById('apSidebarMessages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'sg-chat-msg sg-chat-msg--ai sg-chat-typing';
  typingDiv.innerHTML = '<div class="sg-chat-dots"><span></span><span></span><span></span></div>';
  sidebarEl.appendChild(typingDiv);
  sidebarEl.scrollTop = sidebarEl.scrollHeight;

  try {
    const respText = await chatApolice(apChatHistory);
    apChatHistory.push({ role: 'assistant', content: respText });
    typingDiv.remove();
    appendApSidebarMessage('assistant', respText);
  } catch (err) {
    typingDiv.remove();
    appendApSidebarMessage('assistant', 'Erro ao processar resposta: ' + esc(err.message));
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

// ── Chat hint helper ──────────────────────────────────────────────────────────
// Cada fluxo de chat: onde escrever a pergunta e quem envia.
const CHAT_FLOW_CONFIG = {
  sg: { inputId: 'sgChatInput', enviar: () => sendSgChatMessage() },
  fl: { inputId: 'flChatInput', enviar: () => sendFlChatMessage() },
  af: { inputId: 'afChatInput', enviar: () => sendAfChatMessage() },
  ap: { inputId: 'apChatInput', enviar: () => sendApoliceChatMessage() },
};

// Sugestões são botões de verdade: clicar (ou Enter/Espaço) já manda a pergunta
// para a IA. O texto vai por textContent — nada de string dinâmica em innerHTML.
function _addChatHint(messagesId, questions, flow) {
  const el = document.getElementById(messagesId);
  if (!el) return;

  const div = document.createElement('div');
  div.className = 'ai-chat-hint';

  const titulo = document.createElement('p');
  titulo.className = 'ai-chat-hint-title';
  titulo.textContent = 'Sugestões de perguntas:';
  div.appendChild(titulo);

  const lista = document.createElement('ul');
  lista.className = 'ai-chat-hint-list';
  const cfg = CHAT_FLOW_CONFIG[flow];

  questions.forEach(pergunta => {
    const li = document.createElement('li');
    if (cfg) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-chat-hint-btn';
      btn.textContent = pergunta;
      btn.addEventListener('click', () => enviarSugestaoChat(flow, pergunta));
      li.appendChild(btn);
    } else {
      li.textContent = pergunta;
    }
    lista.appendChild(li);
  });

  div.appendChild(lista);
  el.appendChild(div);
}

function enviarSugestaoChat(flow, pergunta) {
  const cfg = CHAT_FLOW_CONFIG[flow];
  if (!cfg) return;
  const input = document.getElementById(cfg.inputId);
  if (!input || input.disabled) return;
  input.value = pergunta;
  cfg.enviar();
}

// -- Chart defaults
Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = '#46586b';

// -- Financial Analysis State
let financialFiles = [];
const MAX_FINANCIAL_FILES = 6;

// T&C Formulario Manual
// A alternância visual (tcBtnUpload/tcBtnManual) saiu do index.html — quem
// chama switchTcMode() agora são os sub-itens da sidebar (abrirTcModo()), que
// já cuidam do próprio estado ativo via updateTcSubNav().
function switchTcMode(mode) {
  const uploadCard = document.getElementById('tcUploadCard');
  const manualCard = document.getElementById('tcManualCard');

  if (mode === 'upload') {
    uploadCard.hidden = false;
    manualCard.hidden = true;
  } else {
    uploadCard.hidden = true;
    manualCard.hidden = false;
    if (_tcTabs.length === 0) initTcTabs();
  }
  updateTcSubNav(mode);
}

// â"€â"€ T&C â€" sidebar em "pasta" (Importar planilha / Preencher manualmente / TCs salvos)

function toggleTcSidebarGroup() {
  const group = document.getElementById('tcSidebarGroup');
  const toggle = document.getElementById('tab-relatorio-tc');
  const collapsed = group.classList.toggle('sidebar-group--collapsed');
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function abrirTcSidebarGroup() {
  document.getElementById('tcSidebarGroup').classList.remove('sidebar-group--collapsed');
  document.getElementById('tab-relatorio-tc').setAttribute('aria-expanded', 'true');
}

function updateTcSubNav(activeKey) {
  const map = { upload: 'tab-tc-planilha', manual: 'tab-tc-manual', salvos: 'tab-tc-salvos' };
  Object.values(map).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('sidebar-subitem--active');
  });
  const activeEl = document.getElementById(map[activeKey]);
  if (activeEl) activeEl.classList.add('sidebar-subitem--active');
}

function abrirTcModo(mode) {
  switchTab('upload');
  switchTcMode(mode);
  abrirTcSidebarGroup();
}

function abrirTcSalvosPage() {
  switchTab('tc-salvos');
  abrirTcSidebarGroup();
  updateTcSubNav('salvos');
}

// â"€â"€ T&C â€" salvar tomador atual no histórico (D1)

function resetTcSaveStatus() {
  const statusEl = document.getElementById('tcSaveStatus');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'tc-save-status'; }
}

async function salvarTomadorAtual() {
  const statusEl = document.getElementById('tcSaveStatus');
  const btn = document.getElementById('btnSalvarTomador');
  if (!parsedData || !statusEl || !btn) return;

  const cnpjDigits = onlyDigits(parsedData.cnpj || '');
  if (cnpjDigits.length !== 14) {
    statusEl.textContent = 'Informe um CNPJ válido (planilha ou formulário) antes de salvar.';
    statusEl.className = 'tc-save-status tc-save-status--err';
    return;
  }

  btn.disabled = true;
  statusEl.textContent = 'Salvando…';
  statusEl.className = 'tc-save-status';

  try {
    const resp = await salvarTcAnalise({
      cnpj: cnpjDigits,
      tomador: parsedData.tomador || null,
      origem: _tcOrigemAtual === 'manual' ? 'manual' : 'upload',
      rows: parsedData.rows,
    });
    statusEl.textContent = 'Salvo com sucesso (#' + resp.id + ').';
    statusEl.className = 'tc-save-status tc-save-status--ok';
  } catch (err) {
    statusEl.textContent = 'Erro ao salvar: ' + err.message;
    statusEl.className = 'tc-save-status tc-save-status--err';
  } finally {
    btn.disabled = false;
  }
}

// â"€â"€ T&C â€" página "TCs salvos" (buscar / abrir / remover histórico por CNPJ)

function tcSalvosShowError(msg) {
  const el = document.getElementById('tcSalvosErrorMsg');
  const txt = document.getElementById('tcSalvosErrorText');
  if (el && txt) { txt.textContent = msg; el.classList.add('show'); }
}

function tcSalvosHideError() {
  const el = document.getElementById('tcSalvosErrorMsg');
  if (el) el.classList.remove('show');
}

async function buscarTcSalvos() {
  tcSalvosHideError();
  const raw = document.getElementById('tcSalvosQueryInput').value.trim();
  const cnpjDigits = onlyDigits(raw);
  // Se o texto digitado tem 14 dígitos, trata como CNPJ (busca exata); senão,
  // trata o texto como nome do tomador (busca parcial, sem diferenciar maiúsculas).
  const isCnpj = cnpjDigits.length === 14;

  if (!raw) {
    tcSalvosShowError('Informe um CNPJ ou o nome do tomador.');
    return;
  }

  const loading = document.getElementById('tcSalvosLoading');
  const empty = document.getElementById('tcSalvosEmpty');
  const results = document.getElementById('tcSalvosResults');
  const btn = document.getElementById('tcSalvosBtnBuscar');

  loading.hidden = false;
  empty.hidden = true;
  results.innerHTML = '';
  btn.disabled = true;

  try {
    const data = isCnpj
      ? await listarTcAnalises({ cnpj: cnpjDigits })
      : await listarTcAnalises({ nome: raw });
    renderTcSalvosResultados(data.analises || []);
  } catch (err) {
    tcSalvosShowError('Erro ao buscar histórico: ' + err.message);
    empty.hidden = false;
  } finally {
    loading.hidden = true;
    btn.disabled = false;
  }
}

function renderTcSalvosResultados(lista) {
  const empty = document.getElementById('tcSalvosEmpty');
  const results = document.getElementById('tcSalvosResults');

  if (!lista.length) {
    empty.hidden = false;
    const title = empty.querySelector('.empty-state-title');
    const text = empty.querySelector('.empty-state-text');
    if (title) title.textContent = 'Nenhuma análise salva';
    if (text) text.textContent = 'Nenhum T&C encontrado para essa busca.';
    results.innerHTML = '';
    return;
  }

  empty.hidden = true;
  results.innerHTML = lista.map(item => {
    const parsed = new Date(String(item.criadoEm || '').replace(' ', 'T') + 'Z');
    const dataStr = isNaN(parsed)
      ? (item.criadoEm || '-')
      : parsed.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const isManual = item.origem === 'manual';
    // CNPJ sempre visível: uma busca por nome pode trazer tomadores diferentes
    // (nomes parecidos, CNPJs distintos), então o CNPJ é o que desambigua.
    return '<article class="tc-salvo-card">' +
      '<div class="tc-salvo-card-top">' +
        '<p class="tc-salvo-nome">' + esc(item.tomador || 'Tomador sem nome') + '</p>' +
        '<span class="tc-salvo-origem ' + (isManual ? 'tc-salvo-origem--manual' : 'tc-salvo-origem--upload') + '">' + (isManual ? 'Manual' : 'Planilha') + '</span>' +
      '</div>' +
      '<p class="tc-salvo-cnpj">' + esc(formatTcCnpj(item.cnpj || '')) + '</p>' +
      '<p class="tc-salvo-data">Salvo em ' + esc(dataStr) + '</p>' +
      '<div class="tc-salvo-actions">' +
        '<button type="button" class="tc-salvo-btn-abrir" onclick="abrirTcSalvo(' + Number(item.id) + ')">Abrir</button>' +
        '<button type="button" class="tc-salvo-btn-remover" onclick="removerTcSalvo(' + Number(item.id) + ')" aria-label="Remover análise salva">Remover</button>' +
      '</div>' +
    '</article>';
  }).join('');
}

async function abrirTcSalvo(id) {
  tcSalvosHideError();
  try {
    const data = await buscarTcAnalise(id);
    parsedData = { rows: data.rows, tomador: data.tomador, cnpj: data.cnpj };
    _tcOrigemAtual = data.origem === 'manual' ? 'manual' : 'upload';
    generateDashboard();
  } catch (err) {
    tcSalvosShowError('Erro ao abrir análise: ' + err.message);
  }
}

async function removerTcSalvo(id) {
  if (!confirm('Remover esta análise salva? Essa ação não pode ser desfeita.')) return;
  tcSalvosHideError();
  try {
    await apagarTcAnalise(id);
    buscarTcSalvos();
  } catch (err) {
    tcSalvosShowError('Erro ao remover: ' + err.message);
  }
}

function initTcTabs() {
  _tcTabs = [];
  _tcTabCounter = 0;
  const tabId = ++_tcTabCounter;
  _tcTabs.push({
    id: tabId,
    label: 'Tomador 1',
    tomador: '',
    cnpj: '',
    insurers: TC_SEGURADORAS.map(seg => ({ seguradora: seg, status: '', capTotal: '', venc: '', statusCcg: '', modalidades: [] })),
  });
  _tcActiveTabId = tabId;
  renderTcTabBar();
  rebuildTcForm(tabId);
}

function renderTcTabBar() {
  const bar = document.getElementById('tcTabBar');
  if (!bar) return;
  bar.innerHTML = _tcTabs.map(tab =>
    '<button type="button" class="tc-tab-btn' + (tab.id === _tcActiveTabId ? ' tc-tab-btn--active' : '') +
    '" id="tcTabBtn-' + tab.id + '" onclick="switchTcTab(' + tab.id + ')">' +
    '<span class="tc-tab-label">' + esc(tab.label) + '</span>' +
    (_tcTabs.length > 1 ? '<span class="tc-tab-close" onclick="removeTcTab(event,' + tab.id + ')" title="Fechar aba" aria-label="Fechar aba">&times;</span>' : '') +
    '</button>'
  ).join('') +
  '<button type="button" class="tc-tab-add" onclick="addTcTab()" title="Nova aba" aria-label="Nova aba">+</button>';
}

function saveTcTabState(tabId) {
  const tab = _tcTabs.find(t => t.id === tabId);
  if (!tab) return;
  tab.tomador = (document.getElementById('tcTomador') || {}).value || '';
  tab.cnpj = (document.getElementById('tcCnpj') || {}).value || '';
  const idx = _tcTabs.indexOf(tab);
  tab.label = tab.tomador || ('Tomador ' + (idx + 1));
  tab.insurers = [];
  document.querySelectorAll('#tcInsurerList .tc-insurer-block').forEach(block => {
    const id = block.id.replace('tcInsurer-', '');
    const segEl   = document.getElementById('tcSeg-' + id);
    const statusEl = document.getElementById('tcStatus-' + id);
    const capEl   = document.getElementById('tcCapTotal-' + id);
    const vencEl  = document.getElementById('tcVenc-' + id);
    const ccgEl   = document.getElementById('tcStatusCcg-' + id);
    const modalidades = [];
    const modalList = document.getElementById('tcModalList-' + id);
    if (modalList) {
      modalList.querySelectorAll('.tc-modal-row').forEach(row => {
        const inputs = row.querySelectorAll('.tc-input');
        modalidades.push({
          label:  inputs[0] ? inputs[0].value : '',
          limite: inputs[1] ? inputs[1].value : '',
          taxa:   inputs[2] ? inputs[2].value : '',
        });
      });
    }
    tab.insurers.push({
      seguradora: segEl   ? segEl.value   : '',
      status:     statusEl ? statusEl.value : '',
      capTotal:   capEl   ? capEl.value   : '',
      venc:       vencEl  ? vencEl.value  : '',
      statusCcg:  ccgEl   ? ccgEl.value   : '',
      modalidades,
    });
  });
}

function rebuildTcForm(tabId) {
  const tab = _tcTabs.find(t => t.id === tabId);
  if (!tab) return;
  const tomadorEl = document.getElementById('tcTomador');
  const cnpjEl   = document.getElementById('tcCnpj');
  if (tomadorEl) tomadorEl.value = tab.tomador || '';
  if (cnpjEl)   cnpjEl.value   = tab.cnpj   || '';
  const list = document.getElementById('tcInsurerList');
  if (!list) return;
  list.innerHTML = '';
  _tcCounter = 0;
  _tcModalCounters = {};
  if (tab.insurers.length === 0) { addTcInsurer(); return; }
  tab.insurers.forEach(ins => addTcInsurerWithData(ins));
  updateTcInsurerNums();
}

function addTcInsurerWithData(data) {
  const id = ++_tcCounter;
  _tcModalCounters[id] = 0;
  const list = document.getElementById('tcInsurerList');
  const n = list.children.length + 1;
  const isAprovado = data.status === 'aprovado';
  const div = document.createElement('div');
  div.className = 'tc-insurer-block' + (isAprovado ? ' tc-insurer--approved' : '');
  div.id = 'tcInsurer-' + id;
  div.innerHTML =
    '<div class="tc-insurer-head">' +
      '<div class="tc-insurer-num">' + n + '</div>' +
      '<div class="tc-head-seg">' +
        '<input type="text" class="tc-input" id="tcSeg-' + id + '" list="tcSegList" placeholder="Seguradora" autocomplete="off" value="' + esc(data.seguradora || '') + '">' +
      '</div>' +
      '<div class="tc-head-status">' +
        '<select class="tc-select" id="tcStatus-' + id + '" onchange="onTcStatusChange(this,' + id + ')">' +
          '<option value="">Status</option>' +
          '<option value="aprovado"'   + (data.status === 'aprovado'   ? ' selected' : '') + '>Aprovado</option>' +
          '<option value="declinado"'  + (data.status === 'declinado'  ? ' selected' : '') + '>Declinado</option>' +
          '<option value="concorrente"' + (data.status === 'concorrente' ? ' selected' : '') + '>Concorrente</option>' +
          '<option value="bloqueado"'  + (data.status === 'bloqueado'  ? ' selected' : '') + '>Bloqueado</option>' +
        '</select>' +
      '</div>' +
      '<button type="button" class="tc-btn-icon" onclick="removeTcInsurer(' + id + ')" title="Remover seguradora" aria-label="Remover seguradora">' +
        '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
      '</button>' +
    '</div>' +
    '<div class="tc-insurer-body" id="tcBody-' + id + '"' + (isAprovado ? '' : ' hidden') + '>' +
      '<div class="tc-body-meta">' +
        '<div class="tc-form-group">' +
          '<label class="tc-label" for="tcCapTotal-' + id + '">Capacidade Total</label>' +
          '<input type="text" class="tc-input" id="tcCapTotal-' + id + '" placeholder="R$ 0,00" onfocus="this.select()" onblur="fmtTcMoney(this)" value="' + esc(data.capTotal || '') + '">' +
        '</div>' +
        '<div class="tc-form-group">' +
          '<label class="tc-label" for="tcVenc-' + id + '">Vencimento (opcional)</label>' +
          '<input type="text" class="tc-input" id="tcVenc-' + id + '" placeholder="DD/MM/AAAA" inputmode="numeric" maxlength="10" oninput="fmtTcDate(this)" value="' + esc(data.venc || '') + '">' +
        '</div>' +
        '<div class="tc-form-group">' +
          '<label class="tc-label" for="tcStatusCcg-' + id + '">Status CCG</label>' +
          '<input type="text" class="tc-input" id="tcStatusCcg-' + id + '" placeholder="Status CCG" autocomplete="off" value="' + esc(data.statusCcg || '') + '">' +
        '</div>' +
      '</div>' +
      '<div class="tc-modalidades-section">' +
        '<div class="tc-modalidades-header">' +
          '<span class="tc-modalidades-title">Modalidades</span>' +
        '</div>' +
        '<div class="tc-modal-col-header">' +
          '<span class="tc-col-label">Modalidade</span>' +
          '<span class="tc-col-label">Limite</span>' +
          '<span class="tc-col-label">Taxa</span>' +
          '<span></span>' +
        '</div>' +
        '<div class="tc-modal-list" id="tcModalList-' + id + '"></div>' +
        '<button type="button" class="tc-btn-add-modal" onclick="addTcModalidade(' + id + ')">+ Adicionar modalidade</button>' +
      '</div>' +
    '</div>';
  list.appendChild(div);
  if (data.modalidades && data.modalidades.length > 0) {
    data.modalidades.forEach(m => addTcModalidadeWithData(id, m));
  } else if (isAprovado) {
    addTcModalidade(id);
  }
}

function addTcModalidadeWithData(insurerId, data) {
  if (_tcModalCounters[insurerId] === undefined) _tcModalCounters[insurerId] = 0;
  const mid  = ++_tcModalCounters[insurerId];
  const list = document.getElementById('tcModalList-' + insurerId);
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'tc-modal-row';
  row.id = 'tcModal-' + insurerId + '-' + mid;
  row.innerHTML =
    '<input type="text" class="tc-input tc-input--modal" placeholder="Ex: Judicial Trabalhista" autocomplete="off" value="' + esc(data.label || '') + '">' +
    '<input type="text" class="tc-input tc-input--limite" placeholder="R$ 0,00" onfocus="this.select()" onblur="fmtTcMoney(this)" value="' + esc(data.limite || '') + '">' +
    '<input type="text" class="tc-input tc-input--taxa" placeholder="0,00%" onfocus="this.select()" onblur="fmtTcTaxa(this)" value="' + esc(data.taxa || '') + '">' +
    '<button type="button" class="tc-btn-icon" onclick="removeTcModalidade(\'' + insurerId + '-' + mid + '\')" title="Remover modalidade" aria-label="Remover modalidade">' +
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
    '</button>';
  list.appendChild(row);
}

function switchTcTab(tabId) {
  if (tabId === _tcActiveTabId) return;
  saveTcTabState(_tcActiveTabId);
  _tcActiveTabId = tabId;
  renderTcTabBar();
  rebuildTcForm(tabId);
}

function addTcTab() {
  saveTcTabState(_tcActiveTabId);
  const tabId = ++_tcTabCounter;
  const n = _tcTabs.length + 1;
  _tcTabs.push({
    id: tabId,
    label: 'Tomador ' + n,
    tomador: '',
    cnpj: '',
    insurers: TC_SEGURADORAS.map(seg => ({ seguradora: seg, status: '', capTotal: '', venc: '', statusCcg: '', modalidades: [] })),
  });
  _tcActiveTabId = tabId;
  renderTcTabBar();
  rebuildTcForm(tabId);
}

function removeTcTab(event, tabId) {
  event.stopPropagation();
  if (_tcTabs.length <= 1) return;
  const idx = _tcTabs.findIndex(t => t.id === tabId);
  _tcTabs.splice(idx, 1);
  if (_tcActiveTabId === tabId) {
    _tcActiveTabId = _tcTabs[Math.max(0, idx - 1)].id;
    renderTcTabBar();
    rebuildTcForm(_tcActiveTabId);
  } else {
    renderTcTabBar();
  }
}

function updateTcActiveTabLabel() {
  if (!_tcActiveTabId) return;
  const tab = _tcTabs.find(t => t.id === _tcActiveTabId);
  if (!tab) return;
  const tomadorVal = (document.getElementById('tcTomador') || {}).value || '';
  const idx = _tcTabs.indexOf(tab);
  tab.label = tomadorVal || ('Tomador ' + (idx + 1));
  const labelEl = document.querySelector('#tcTabBtn-' + _tcActiveTabId + ' .tc-tab-label');
  if (labelEl) labelEl.textContent = tab.label;
}

function addTcInsurer() {
  const id   = ++_tcCounter;
  _tcModalCounters[id] = 0;
  const list = document.getElementById('tcInsurerList');
  const n    = list.children.length + 1;

  const div = document.createElement('div');
  div.className = 'tc-insurer-block';
  div.id = 'tcInsurer-' + id;
  div.innerHTML =
    '<div class="tc-insurer-head">' +
      '<div class="tc-insurer-num">' + n + '</div>' +
      '<div class="tc-head-seg">' +
        '<input type="text" class="tc-input" id="tcSeg-' + id + '" list="tcSegList" placeholder="Seguradora" autocomplete="off">' +
      '</div>' +
      '<div class="tc-head-status">' +
        '<select class="tc-select" id="tcStatus-' + id + '" onchange="onTcStatusChange(this,' + id + ')">' +
          '<option value="">Status</option>' +
          '<option value="aprovado">Aprovado</option>' +
          '<option value="declinado">Declinado</option>' +
          '<option value="concorrente">Concorrente</option>' +
          '<option value="bloqueado">Bloqueado</option>' +
        '</select>' +
      '</div>' +
      '<button type="button" class="tc-btn-icon" onclick="removeTcInsurer(' + id + ')" title="Remover seguradora" aria-label="Remover seguradora">' +
        '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
      '</button>' +
    '</div>' +
    '<div class="tc-insurer-body" id="tcBody-' + id + '" hidden>' +
      '<div class="tc-body-meta">' +
        '<div class="tc-form-group">' +
          '<label class="tc-label" for="tcCapTotal-' + id + '">Capacidade Total</label>' +
          '<input type="text" class="tc-input" id="tcCapTotal-' + id + '" placeholder="R$ 0,00" onfocus="this.select()" onblur="fmtTcMoney(this)">' +
        '</div>' +
        '<div class="tc-form-group">' +
          '<label class="tc-label" for="tcVenc-' + id + '">Vencimento (opcional)</label>' +
          '<input type="text" class="tc-input" id="tcVenc-' + id + '" placeholder="DD/MM/AAAA" inputmode="numeric" maxlength="10" oninput="fmtTcDate(this)">' +
        '</div>' +
        '<div class="tc-form-group">' +
          '<label class="tc-label" for="tcStatusCcg-' + id + '">Status CCG</label>' +
          '<input type="text" class="tc-input" id="tcStatusCcg-' + id + '" placeholder="Status CCG" autocomplete="off">' +
        '</div>' +
      '</div>' +
      '<div class="tc-modalidades-section">' +
        '<div class="tc-modalidades-header">' +
          '<span class="tc-modalidades-title">Modalidades</span>' +
        '</div>' +
        '<div class="tc-modal-col-header">' +
          '<span class="tc-col-label">Modalidade</span>' +
          '<span class="tc-col-label">Limite</span>' +
          '<span class="tc-col-label">Taxa</span>' +
          '<span></span>' +
        '</div>' +
        '<div class="tc-modal-list" id="tcModalList-' + id + '"></div>' +
        '<button type="button" class="tc-btn-add-modal" onclick="addTcModalidade(' + id + ')">' +
          '+ Adicionar modalidade' +
        '</button>' +
      '</div>' +
    '</div>';

  list.appendChild(div);
  addTcModalidade(id);
  updateTcInsurerNums();
}

function removeTcInsurer(id) {
  const el = document.getElementById('tcInsurer-' + id);
  if (el) el.remove();
  delete _tcModalCounters[id];
  updateTcInsurerNums();
}

function updateTcInsurerNums() {
  document.querySelectorAll('#tcInsurerList .tc-insurer-num').forEach((el, i) => {
    el.textContent = i + 1;
  });
}

function onTcStatusChange(select, id) {
  const body  = document.getElementById('tcBody-' + id);
  const block = document.getElementById('tcInsurer-' + id);
  const isAprovado = select.value === 'aprovado';
  body.hidden = !isAprovado;
  block.classList.toggle('tc-insurer--approved', isAprovado);
  const ccg = document.getElementById('tcStatusCcg-' + id);
  if (!isAprovado && ccg) ccg.value = '';
}

function addTcModalidade(insurerId) {
  if (_tcModalCounters[insurerId] === undefined) _tcModalCounters[insurerId] = 0;
  const mid  = ++_tcModalCounters[insurerId];
  const list = document.getElementById('tcModalList-' + insurerId);
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'tc-modal-row';
  row.id = 'tcModal-' + insurerId + '-' + mid;
  row.innerHTML =
    '<input type="text" class="tc-input tc-input--modal" placeholder="Ex: Judicial Trabalhista" autocomplete="off">' +
    '<input type="text" class="tc-input tc-input--limite" placeholder="R$ 0,00" onfocus="this.select()" onblur="fmtTcMoney(this)">' +
    '<input type="text" class="tc-input tc-input--taxa" placeholder="0,00%" onfocus="this.select()" onblur="fmtTcTaxa(this)">' +
    '<button type="button" class="tc-btn-icon" onclick="removeTcModalidade(\'' + insurerId + '-' + mid + '\')" title="Remover modalidade" aria-label="Remover modalidade">' +
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
    '</button>';
  list.appendChild(row);
}

function removeTcModalidade(key) {
  const el = document.getElementById('tcModal-' + key);
  if (el) el.remove();
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatTcCnpj(value) {
  const digits = onlyDigits(value).slice(0, 14);
  return digits
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2');
}

function fmtTcCnpj(el) {
  el.value = formatTcCnpj(el.value);
}

function fmtTcDate(el) {
  const digits = onlyDigits(el.value).slice(0, 8);
  el.value = digits
    .replace(/^(\d{2})(\d)/, '$1/$2')
    .replace(/^(\d{2})\/(\d{2})(\d)/, '$1/$2/$3');
}

function fmtTcMoney(el) {
  const n = parseNum(el.value);
  el.value = n > 0 ? fmtBRL(n) : '';
}

function parseTcTaxaPercentValue(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;

  const cleaned = s.replace('%', '').replace(/\s/g, '').replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function formatTcTaxaPercent(val) {
  const taxa = parseTcTaxaPercentValue(val);
  if (taxa === null) return '';
  return taxa.toFixed(2).replace('.', ',') + '%';
}

function fmtTcTaxa(el) {
  const formatted = formatTcTaxaPercent(el.value);
  el.value = formatted || '';
}

function showManualError(msg) {
  const el  = document.getElementById('errorMsgManual');
  const txt = document.getElementById('errorTextManual');
  if (txt) txt.textContent = msg;
  if (el)  el.classList.add('show');
}

function hideManualError() {
  const el = document.getElementById('errorMsgManual');
  if (el) el.classList.remove('show');
}

function buildManualParsedData() {
  const tomador = document.getElementById('tcTomador').value.trim() || null;
  const cnpjRaw = document.getElementById('tcCnpj').value.trim();
  const cnpj    = cnpjRaw ? formatTcCnpj(cnpjRaw) : null;
  const rows    = [];

  document.querySelectorAll('#tcInsurerList .tc-insurer-block').forEach(block => {
    const id       = block.id.replace('tcInsurer-', '');
    const segInput = document.getElementById('tcSeg-' + id);
    const statusEl = document.getElementById('tcStatus-' + id);
    const ccgEl    = document.getElementById('tcStatusCcg-' + id);
    const capEl    = document.getElementById('tcCapTotal-' + id);
    const vencEl   = document.getElementById('tcVenc-' + id);

    const seguradora = segInput ? segInput.value.trim() : '';
    const status     = statusEl ? statusEl.value : '';
    if (!seguradora || !status) return;

    const isAprovado = status === 'aprovado';
    const limite     = (isAprovado && capEl) ? parseNum(capEl.value) : 0;
    const venc       = (isAprovado && vencEl && vencEl.value.trim()) ? vencEl.value.trim() : null;
    const statusCcg  = isAprovado && ccgEl && ccgEl.value.trim() ? ccgEl.value.trim() : null;

    const modalidades = [];
    if (isAprovado) {
      const modalList = document.getElementById('tcModalList-' + id);
      if (modalList) {
        modalList.querySelectorAll('.tc-modal-row').forEach(row => {
          const inputs = row.querySelectorAll('.tc-input');
          const label  = inputs[0] ? inputs[0].value.trim() : '';
          const val    = inputs[1] ? parseNum(inputs[1].value) : 0;
          const taxa   = inputs[2] ? formatTcTaxaPercent(inputs[2].value) : null;
          if (label) modalidades.push({ label, value: val, taxa: taxa || null });
        });
      }
    }

    rows.push({
      seguradora,
      status,
      statusCcg,
      limite,
      modalidade: modalidades.length > 0 ? modalidades[0].label : '',
      valorModal: modalidades.length > 0 ? modalidades[0].value : 0,
      taxa: modalidades.length > 0 ? modalidades[0].taxa : null,
      venc,
      modalidades,
    });
  });

  if (!rows.length) return null;
  return { rows, tomador, cnpj };
}

function generateDashboardFromForm() {
  hideManualError();
  const data = buildManualParsedData();
  if (!data) {
    showManualError('Adicione ao menos uma seguradora com nome e status preenchidos.');
    return;
  }
  parsedData = data;
  _tcOrigemAtual = 'manual';
  generateDashboard();
}

function tcStatusText(status) {
  const labels = { aprovado: 'Aprovado', declinado: 'Declinado', concorrente: 'Concorrente', bloqueado: 'Bloqueado' };
  return labels[status] || status || '-';
}

function tcEmpty(value) {
  return value === null || value === undefined || value === '' ? '-' : value;
}

function buildTcEmailTableHtml(data) {
  const rows = [...(data.rows || [])].sort((a, b) => (a.seguradora || '').localeCompare(b.seguradora || '', 'pt-BR'));

  const aprovadas   = rows.filter(r => r.status === 'aprovado');
  const declinadas  = rows.filter(r => r.status === 'declinado');
  const concorr     = rows.filter(r => r.status === 'concorrente');
  const bloqueadas  = rows.filter(r => r.status === 'bloqueado');
  const totalAprov  = aprovadas.reduce((s, r) => s + (r.limite || 0), 0);
  const maxLimite   = aprovadas.length ? Math.max(...aprovadas.map(r => r.limite || 0)) : 0;
  const maxSeg      = aprovadas.filter(r => (r.limite || 0) === maxLimite).map(r => r.seguradora).join(' · ');
  const totalCapStr = totalAprov >= 1e6 ? 'R$ ' + (totalAprov / 1e6).toFixed(0) + 'MM' : fmtBRL(totalAprov);
  const maxCapStr   = maxLimite  >= 1e6 ? 'R$ ' + (maxLimite  / 1e6).toFixed(0) + 'MM' : fmtBRL(maxLimite);
  const declSub     = bloqueadas.length > 0
    ? 'sem disponibilidade · ' + bloqueadas.length + ' bloqueada' + (bloqueadas.length > 1 ? 's' : '')
    : 'sem disponibilidade';

  const tableRows = [];

  rows.forEach(r => {
    const mods = (r.modalidades && r.modalidades.length > 0) ? r.modalidades : [null];
    const span = mods.length;
    const rs = span > 1 ? ' rowspan="' + span + '"' : '';
    const vmid = ' style="vertical-align:middle"';
    mods.forEach((m, idx) => {
      const first = idx === 0;
      const last = idx === span - 1;
      const rowClass = last ? ' class="tc-email-row-last"' : '';
      tableRows.push(
        '<tr' + rowClass + '>' +
          (first ? '<td class="tc-email-seg"' + rs + vmid + '>' + esc(r.seguradora) + '</td>' : '') +
          (first ? '<td class="tc-email-money"' + rs + vmid + '>' + (r.limite > 0 ? fmtBRL(r.limite) : '-') + '</td>' : '') +
          '<td class="tc-email-text">' + esc(m ? tcEmpty(m.label) : '-') + '</td>' +
          '<td class="tc-email-money">' + (m && m.value > 0 ? fmtBRL(m.value) : '-') + '</td>' +
          '<td class="tc-email-rate">' + esc(m && m.taxa ? m.taxa : '-') + '</td>' +
          (first ? '<td class="tc-email-text tc-email-status-ccg-cell"' + rs + vmid + '>' + esc(tcEmpty(r.statusCcg)) + '</td>' : '') +
          (first ? '<td class="tc-email-date"' + rs + vmid + '>' + esc(tcEmpty(r.venc)) + '</td>' : '') +
          (first ? '<td' + rs + vmid + '><span class="tc-email-status tc-email-status--' + esc(r.status) + '">' + esc(tcStatusText(r.status)) + '</span></td>' : '') +
        '</tr>'
      );
    });
    tableRows.push('<tr class="tc-email-group-div"><td colspan="8"></td></tr>');
  });

  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

  const headerHtml =
    '<div class="tc-email-header">' +
      '<div class="tc-email-header-content">' +
        '<p class="tc-email-header-tomador">' + esc(tcEmpty(data.tomador)) + '</p>' +
        '<p class="tc-email-header-cnpj">CNPJ ' + esc(tcEmpty(data.cnpj)) + '</p>' +
      '</div>' +
      '<div class="tc-email-header-logo-wrap">' +
        '<img src="assets/img/Lavoro-logo_branca.png" alt="Lavoro Seguros" class="tc-email-logo">' +
        '<p class="tc-email-header-date">Gerado em ' + esc(dateStr) + '</p>' +
      '</div>' +
    '</div>';

  const kpisHtml =
    '<div class="tc-email-kpis">' +
      _tcKpi('COM LIMITE APROVADO',          aprovadas.length,  'com apetite ativo', 'aprovado') +
      _tcKpi('SEM LIMITE DECLINADO',         declinadas.length, declSub,             'declinado') +
      _tcKpi('NOMEADAS POR OUTRO CORRETOR',  concorr.length,    'outro corretor',    'concorrente') +
      _tcKpi('CAPACIDADE TOTAL APROVADA',    totalCapStr,       fmtBRL(totalAprov),  'capacidade') +
      _tcKpi('MAIOR LIMITE INDIVIDUAL',      maxCapStr,         maxSeg || '—',  'maior') +
    '</div>';

  return '<div class="tc-email-sheet" id="tcEmailTableCapture">' +
    headerHtml +
    kpisHtml +
    '<table class="tc-email-table">' +
      '<thead><tr>' +
        '<th>Seguradora</th>' +
        '<th>Capacidade Total</th>' +
        '<th>Modalidades</th>' +
        '<th>Limites por Modalidade</th>' +
        '<th>Taxa por Modalidade</th>' +
        '<th class="tc-email-status-ccg-head">Status CCG</th>' +
        '<th>Vencimentos</th>' +
        '<th>Status</th>' +
      '</tr></thead>' +
      '<tbody>' + tableRows.join('') + '</tbody>' +
    '</table>' +
  '</div>';
}

function _tcKpi(label, value, sub, type) {
  return '<div class="tc-email-kpi tc-email-kpi--' + type + '">' +
    '<div class="tc-email-kpi-bar"></div>' +
    '<p class="tc-email-kpi-label">' + esc(label) + '</p>' +
    '<p class="tc-email-kpi-value">' + esc(String(value)) + '</p>' +
    '<p class="tc-email-kpi-sub">' + esc(String(sub)) + '</p>' +
  '</div>';
}

async function renderTcEmailTable() {
  hideManualError();
  const data = buildManualParsedData();
  if (!data) {
    showManualError('Preencha ao menos uma seguradora antes de gerar a tabela.');
    return;
  }

  const mount = document.getElementById('tcEmailTableMount');
  if (!mount) return;

  mount.innerHTML = buildTcEmailTableHtml(data);
  await new Promise(resolve => requestAnimationFrame(resolve));
  await downloadTcEmailTableImage();
}

async function downloadTcEmailTableImage() {
  const target = document.getElementById('tcEmailTableCapture');
  if (!target) {
    renderTcEmailTable();
    return;
  }
  if (typeof html2canvas !== 'function') {
    showManualError('Nao foi possivel gerar a imagem. Biblioteca html2canvas indisponivel.');
    return;
  }

  const canvas = await html2canvas(target, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
  const link = document.createElement('a');
  link.download = 'tabela-tc-email.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function exportTcEmailTableXlsx() {
  hideManualError();
  const data = buildManualParsedData();
  if (!data) { showManualError('Preencha ao menos uma seguradora antes de exportar.'); return; }
  if (typeof XLSX === 'undefined') { showManualError('Biblioteca XLSX indisponível.'); return; }

  const rows = [...(data.rows || [])].sort((a, b) =>
    (a.seguradora || '').localeCompare(b.seguradora || '', 'pt-BR')
  );

  const CL = {
    headerBg:   'F3F2EC',
    cellBg:     'FFFFFF',
    darkText:   '1F2937',
    mutedText:  '6B7280',
    thin:       'E5E7EB',
    med:        'D1D5DB',
    aprovado:   { bg: 'DCFCE7', fg: '16A34A' },
    declinado:  { bg: 'FEE2E2', fg: 'DC2626' },
    concorrente:{ bg: 'FEF3C7', fg: 'B45309' },
    bloqueado:  { bg: 'EEEAD6', fg: '6B7280' },
  };
  function sc(status) { return CL[status] || { bg: 'F3F4F6', fg: CL.darkText }; }

  const wb = XLSX.utils.book_new();
  const ws = {};
  const merges = [];
  let R = 0;

  function setCell(r, c, v, s) {
    ws[XLSX.utils.encode_cell({ r, c })] = { v: v == null ? '' : v, t: 's', s: s || {} };
  }
  function mg(r1, c1, r2, c2) { merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } }); }

  const hdrFill  = { patternType: 'solid', fgColor: { rgb: CL.headerBg } };
  const whtFill  = { patternType: 'solid', fgColor: { rgb: CL.cellBg } };
  const rgtBdr   = { style: 'thin', color: { rgb: CL.thin } };
  const thinBdr  = { style: 'thin', color: { rgb: CL.thin } };
  const medBdr   = { style: 'medium', color: { rgb: CL.med } };

  // ── Título (linhas 0-1) ──────────────────────────────────────────────────
  const blankHdr = { fill: hdrFill };

  setCell(R, 0, 'T&C', { font: { bold: true, sz: 14, color: { rgb: CL.darkText } }, fill: hdrFill, alignment: { horizontal: 'left', vertical: 'center' } });
  for (let c = 1; c <= 3; c++) setCell(R, c, '', blankHdr);
  mg(R, 0, R, 3);
  setCell(R, 4, 'Tomador: ' + (data.tomador || '-'), { font: { bold: true, sz: 9, color: { rgb: CL.darkText } }, fill: hdrFill, alignment: { horizontal: 'right', vertical: 'center' } });
  for (let c = 5; c <= 7; c++) setCell(R, c, '', blankHdr);
  mg(R, 4, R, 7);
  R++;

  setCell(R, 0, rows.length + ' seguradora' + (rows.length === 1 ? '' : 's'), { font: { sz: 9, color: { rgb: CL.mutedText } }, fill: hdrFill, alignment: { horizontal: 'left', vertical: 'center' } });
  for (let c = 1; c <= 3; c++) setCell(R, c, '', blankHdr);
  mg(R, 0, R, 3);
  setCell(R, 4, 'CNPJ: ' + (data.cnpj || '-'), { font: { sz: 9, color: { rgb: CL.mutedText } }, fill: hdrFill, alignment: { horizontal: 'right', vertical: 'center' } });
  for (let c = 5; c <= 7; c++) setCell(R, c, '', blankHdr);
  mg(R, 4, R, 7);
  R++;

  // ── Cabeçalho da tabela (linha 2) ────────────────────────────────────────
  const HDRS   = ['SEGURADORA', 'CAPACIDADE TOTAL', 'MODALIDADES', 'LIMITES POR MODALIDADE', 'TAXA POR MODALIDADE', 'STATUS CCG', 'VENCIMENTOS', 'STATUS'];
  const HALIGN = ['left', 'right', 'left', 'right', 'right', 'left', 'left', 'center'];
  HDRS.forEach((h, c) => {
    setCell(R, c, h, {
      font: { bold: true, sz: 8, color: { rgb: CL.darkText } },
      fill: hdrFill,
      alignment: { horizontal: HALIGN[c], vertical: 'center' },
      border: { bottom: medBdr, right: c < 7 ? rgtBdr : undefined },
    });
  });
  R++;

  // ── Dados ────────────────────────────────────────────────────────────────
  rows.forEach(r => {
    const mods = (r.modalidades && r.modalidades.length > 0) ? r.modalidades : [null];
    const span = mods.length;
    const r0   = R;

    mods.forEach((m, idx) => {
      const isLast = idx === span - 1;
      const rowBtm = isLast ? medBdr : thinBdr;

      // colunas de grupo: borda inferior sempre médida (a merge cobre até o fim do grupo)
      const grpBtm = medBdr;

      // col 0 – Seguradora
      setCell(R, 0, idx === 0 ? (r.seguradora || '') : '', {
        font: { bold: true, sz: 9, color: { rgb: CL.darkText } }, fill: whtFill,
        alignment: { horizontal: 'left', vertical: 'top' },
        border: { bottom: grpBtm, right: rgtBdr },
      });

      // col 1 – Capacidade Total
      setCell(R, 1, idx === 0 ? (r.limite > 0 ? fmtBRL(r.limite) : '-') : '', {
        font: { sz: 9, color: { rgb: CL.darkText } }, fill: whtFill,
        alignment: { horizontal: 'right', vertical: 'top' },
        border: { bottom: grpBtm, right: rgtBdr },
      });

      // col 2 – Modalidade
      setCell(R, 2, m ? (m.label || '-') : '-', {
        font: { sz: 9, color: { rgb: CL.mutedText } }, fill: whtFill,
        alignment: { horizontal: 'left', vertical: 'center' },
        border: { bottom: rowBtm, right: rgtBdr },
      });

      // col 3 – Limite por Modalidade
      setCell(R, 3, (m && m.value > 0) ? fmtBRL(m.value) : '-', {
        font: { sz: 9, color: { rgb: CL.darkText } }, fill: whtFill,
        alignment: { horizontal: 'right', vertical: 'center' },
        border: { bottom: rowBtm, right: rgtBdr },
      });

      // col 4 – Taxa
      setCell(R, 4, (m && m.taxa) ? m.taxa : '-', {
        font: { sz: 9, color: { rgb: CL.darkText } }, fill: whtFill,
        alignment: { horizontal: 'right', vertical: 'center' },
        border: { bottom: rowBtm, right: rgtBdr },
      });

      // col 5 – Status CCG
      setCell(R, 5, idx === 0 ? (r.statusCcg || '-') : '', {
        font: { sz: 9, color: { rgb: CL.mutedText } }, fill: whtFill,
        alignment: { horizontal: 'left', vertical: 'top' },
        border: { bottom: grpBtm, right: rgtBdr },
      });

      // col 6 – Vencimentos
      setCell(R, 6, idx === 0 ? (r.venc || '-') : '', {
        font: { sz: 9, color: { rgb: CL.darkText } }, fill: whtFill,
        alignment: { horizontal: 'left', vertical: 'top' },
        border: { bottom: grpBtm, right: rgtBdr },
      });

      // col 7 – Status (com cor de fundo do badge)
      const color = sc(r.status);
      setCell(R, 7, idx === 0 ? tcStatusText(r.status) : '', {
        font: { bold: true, sz: 9, color: { rgb: color.fg } },
        fill: { patternType: 'solid', fgColor: { rgb: color.bg } },
        alignment: { horizontal: 'center', vertical: 'top' },
        border: { bottom: grpBtm },
      });

      R++;
    });

    // Mescla colunas de grupo quando há mais de 1 modalidade
    if (span > 1) {
      [0, 1, 5, 6, 7].forEach(col => mg(r0, col, r0 + span - 1, col));
    }
  });

  ws['!ref']    = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: R - 1, c: 7 } });
  ws['!merges'] = merges;
  ws['!rows']   = [{ hpt: 26 }, { hpt: 14 }, { hpt: 20 }];
  ws['!cols']   = [
    { wch: 22 }, { wch: 18 }, { wch: 24 }, { wch: 22 },
    { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 14 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'T&C');
  XLSX.writeFile(wb, 'tabela-tc.xlsx', { cellStyles: true, bookType: 'xlsx' });
}

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
  _clearChatFiles('af');
  hideFinancialError();
  setDownloadTopOwner(null);
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

  setDownloadTopOwner('analise-financeira');

  // Init Q&A chat history with JSON context
  afChatHistory = criarHistoricoAnaliseFinanceira(financialFiles, JSON.stringify(data));
  document.getElementById('afQaMessages').innerHTML = '';
  _addChatHint('afQaMessages', [
    'Qual o índice de liquidez corrente e o que significa?',
    'Qual o limite máximo sugerido para seguro garantia?',
    'A empresa tem patrimônio líquido suficiente?',
    'Houve crescimento ou queda de receita no período?',
  ], 'af');
}

// ── AF Q&A chat ──────────────────────────────────────────────────────────────
async function sendAfChatMessage() {
  const input = document.getElementById('afChatInput');
  const text = input.value.trim();
  if ((!text && !_chatFiles.af.length) || afChatHistory.length === 0) return;

  input.value = '';
  const displayText = text || _chatFiles.af.map(f => f.name).join(', ');
  appendAfQaMessage('user', displayText);

  const msgObj = await _buildChatMessage('af', text);
  _clearChatFiles('af');
  afChatHistory.push(msgObj);

  const sendBtn = document.getElementById('afChatSend');
  sendBtn.disabled = true;
  input.disabled = true;

  const afSidebarEl = document.getElementById('afQaMessages');
  const typingDiv = document.createElement('div');
  typingDiv.className = 'sg-chat-msg sg-chat-msg--ai sg-chat-typing';
  typingDiv.innerHTML = '<div class="sg-chat-dots"><span></span><span></span><span></span></div>';
  afSidebarEl.appendChild(typingDiv);
  afSidebarEl.scrollTop = afSidebarEl.scrollHeight;

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
  div.className = 'sg-chat-msg ' + (role === 'user' ? 'sg-chat-msg--user' : 'sg-chat-msg--ai');
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
  if (!hasIndicadorValue(val)) return null;
  if (format === 'brl') return typeof val === 'number' ? fmtBRL(val) : String(val);
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val);
  if (format === 'pct') return num.toFixed(2).replace('.', ',') + '%';
  return num.toFixed(2).replace('.', ',');
}

function hasIndicadorValue(val) {
  if (val === null || val === undefined) return false;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    return normalized !== '' && normalized !== 'null' && normalized !== 'n/a' && normalized !== 'não informado' && normalized !== 'nao informado';
  }
  return true;
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
  const indicadoresDisponiveis = AF_KPIS_CONFIG
    .map(cfg => ({ ...cfg, value: ind[cfg.key] }))
    .filter(cfg => hasIndicadorValue(cfg.value));

  const prioritarios = indicadoresDisponiveis.filter(cfg => cfg.priority);
  const demais = indicadoresDisponiveis.filter(cfg => !cfg.priority);

  function buildRows(lista) {
    return lista.map(cfg => {
      const val = cfg.value;
      const display = fmtIndicador(val, cfg.format);
      const isNeg = typeof val === 'number' && val < 0;
      return `<tr class="${isNeg ? 'af-kpi-row--neg' : ''}">
        <td class="af-kpi-label">${esc(cfg.label)}</td>
        <td class="af-kpi-value mono">${esc(String(display))}</td>
      </tr>`;
    }).join('');
  }

  let kpisHtml;
  if (indicadoresDisponiveis.length === 0) {
    kpisHtml = '<p class="af-no-data">Indicadores não extraídos deste documento.</p>';
  } else {
    kpisHtml = `<table class="af-kpis-table"><tbody>${buildRows(prioritarios)}</tbody></table>`;
    if (demais.length > 0) {
      kpisHtml += `<div class="af-kpis-divider">Outros indicadores</div><table class="af-kpis-table af-kpis-table--demais"><tbody>${buildRows(demais)}</tbody></table>`;
    }
  }

  return `
    <div class="af-doc-card">
      <div class="af-doc-header">
        <span class="af-doc-tipo-badge">${esc(doc.tipo || '—')}</span>
        <span class="af-doc-periodo">${esc(doc.periodo || '—')}</span>
      </div>
      ${kpisHtml}
      ${doc.observacoes ? `<div class="af-doc-obs"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 5.5h.01" stroke-linecap="round"/></svg>${esc(doc.observacoes)}</div>` : ''}
    </div>`;
}

function buildEmpresaCard(emp, idx) {
  const ac = emp.analise_credito || {};
  const cf = emp.classificacao_financeira || {};
  const vsg = emp.visao_para_seguro_garantia || {};
  const conc = emp.conclusao_final || {};
  const risco = ac.classificacao_risco || cf.nivel_risco || '—';
  const docs = emp.documentos || [];

  const docsHtml = docs.length > 0
    ? `<div class="af-docs-grid">${docs.map(buildDocumentoCard).join('')}</div>`
    : '<p class="af-no-data">Nenhum documento identificado.</p>';

  const capGarantia = ac.capacidade_seguro_garantia || '—';
  const capFianca   = ac.capacidade_fianca_locaticia || '—';

  const classifHtml = buildAfClassificacaoHtml(cf);
  const principaisHtml = buildAfPrincipaisNumerosHtml(emp.principais_numeros || {});
  const indicadoresHtml = buildAfIndicadoresCalcHtml(emp.indicadores_calculados || {});
  const qualitativaHtml = buildAfQualitativaHtml(emp.analise_qualitativa || {});
  const sinaisHtml = buildAfSinaisHtml(emp.sinais_positivos || [], emp.sinais_negativos || [], ac.pontos_positivos || [], ac.pontos_atencao || []);
  const alertasHtml = buildAfListaCard(emp.alertas_de_risco || [], 'af-alertas-list', 'af-alerta-item--risk', 'Alertas de Risco');
  const inconsistHtml = buildAfListaCard(emp.inconsistencias_ou_limitacoes || [], 'af-incons-list', 'af-incons-item', 'Inconsistências / Limitações');
  const docsAdicionaisHtml = buildAfListaCard(emp.documentos_adicionais_recomendados || [], 'af-docs-adicionais-list', 'af-docs-adicionais-item', 'Documentos Adicionais Recomendados');
  const visaoSgHtml = buildAfVisaoSgHtml(vsg);
  const conclusaoHtml = buildAfConclusaoHtml(conc);

  const headerMeta = [
    emp.periodo_analisado ? `Período: ${emp.periodo_analisado}` : '',
    emp.moeda ? `Moeda: ${emp.moeda}` : '',
    emp.observacao_escala && !emp.observacao_escala.toLowerCase().includes('reais') ? emp.observacao_escala : '',
  ].filter(Boolean).join(' · ');

  return `
    <section class="af-empresa-section dashboard-section" aria-label="${esc(emp.empresa || 'Empresa')}">
      <div class="af-empresa-header">
        <div class="af-empresa-identity">
          <h2 class="af-empresa-nome">${esc(emp.empresa || 'Empresa não identificada')}</h2>
          ${emp.cnpj ? `<span class="af-empresa-cnpj">CNPJ ${esc(emp.cnpj)}</span>` : ''}
          ${headerMeta ? `<span class="af-empresa-meta">${esc(headerMeta)}</span>` : ''}
        </div>
        <span class="af-risco-badge ${riscoClass(risco)}">Risco ${esc(risco)}</span>
      </div>

      ${classifHtml}

      <div class="af-credito-card card">
        <div class="af-capacidades-row">
          <div class="af-cap-item ${capacidadeClass(capGarantia)}">
            <div class="af-cap-header">
              <span class="af-cap-label">Seguro Garantia</span>
              <span class="af-cap-chip ${capacidadeClass(capGarantia)}">${esc(capGarantia)}</span>
            </div>
            ${ac.justificativa_garantia ? `<span class="af-cap-just">${esc(ac.justificativa_garantia)}</span>` : ''}
          </div>
          <div class="af-cap-item ${capacidadeClass(capFianca)}">
            <div class="af-cap-header">
              <span class="af-cap-label">Fiança Locatícia</span>
              <span class="af-cap-chip ${capacidadeClass(capFianca)}">${esc(capFianca)}</span>
            </div>
            ${ac.justificativa_fianca ? `<span class="af-cap-just">${esc(ac.justificativa_fianca)}</span>` : ''}
          </div>
        </div>

        ${ac.resumo_executivo ? `
        <div class="af-resumo-block">
          <p class="af-card-label">Resumo Executivo</p>
          <p class="af-resumo-text">${esc(ac.resumo_executivo)}</p>
        </div>` : ''}

        ${ac.recomendacao_seguradora ? `
        <div class="af-recomendacao-block">
          <p class="af-card-label">Recomendação para Emissão</p>
          <p class="af-recomendacao-text">${esc(ac.recomendacao_seguradora)}</p>
        </div>` : ''}
      </div>

      ${principaisHtml}

      ${indicadoresHtml}

      <h3 class="af-subsection-title">Documentos Analisados por Período</h3>
      ${docsHtml}

      ${qualitativaHtml}

      ${sinaisHtml}

      ${alertasHtml}

      ${inconsistHtml}

      ${visaoSgHtml}

      ${docsAdicionaisHtml}

      ${conclusaoHtml}
    </section>`;
}

// ── Consulta de Limites por Seguradora ──

const LIM_LOGO_MAP = {
  jns: 'assets/jns-logo.png',
  junto: 'assets/junto-logo.png',
  essor: 'assets/essor-logo.png',
  sombrero: 'assets/Sombrero-logo.png',
  newe: 'assets/Newe-logo.png',
  mitsui: 'assets/Mitisui-logo.png',
  axa: 'assets/axa-logo.png',
  now: 'assets/now-logo.png',
  fator: 'assets/fator.png',
};

// Todas as seguradoras integradas são consultadas por padrão — sem seleção manual.
const LIM_ALL_SEGURADORAS = ['jns', 'junto', 'essor', 'sombrero', 'newe', 'mitsui', 'axa', 'now', 'fator'];
const LIM_LABELS = {
  jns: 'JNS Seguros',
  junto: 'Junto Seguros',
  essor: 'Essor Seguros',
  sombrero: 'Sombrero Seguros',
  newe: 'NEWE Seguros',
  mitsui: 'Mitsui Sumitomo',
  axa: 'AXA Seguros',
  now: 'Now Seguros',
  fator: 'Fator Seguradora',
};

function limLogoHtml(seguradora) {
  const src = LIM_LOGO_MAP[seguradora];
  if (!src) return '';
  return `<img src="${esc(src)}" alt="${esc(LIM_LABELS[seguradora] || seguradora)}" class="lim-card-logo" onerror="this.style.display='none'">`;
}

function showLimError(msg) {
  document.getElementById('limErrorText').textContent = msg;
  document.getElementById('limErrorMsg').classList.add('show');
}
function hideLimError() {
  document.getElementById('limErrorMsg').classList.remove('show');
}

// Renderiza os cards de todas as seguradoras em estado "Aguardando" antes da primeira
// consulta — não sobrescreve resultados já carregados ao trocar de aba.
function renderLimitesPlaceholders() {
  const results = document.getElementById('limResults');
  if (!results || results.dataset.hasResults === '1') return;
  results.innerHTML = `<div class="lim-cards-grid">${LIM_ALL_SEGURADORAS.map(buildLimWaitingCardHtml).join('')}</div>`;
}

function buildLimWaitingCardHtml(key) {
  return `
    <div class="lim-card lim-card--waiting">
      <div class="lim-card-top">
        <p class="lim-card-eyebrow">Seguradora</p>
        <span class="lim-badge2 lim-badge--aguardando">Aguardando</span>
      </div>
      <div class="lim-card-brand">
        ${limLogoHtml(key)}
      </div>
      <p class="lim-card-desc">Informe o CNPJ e clique em <strong>Consultar limites</strong> para ver os limites deste tomador.</p>
    </div>`;
}

async function consultarLimitesUI() {
  hideLimError();
  const cnpjRaw = document.getElementById('limCnpjInput').value;
  const cnpj = String(cnpjRaw || '').replace(/\D/g, '');
  if (cnpj.length !== 14) {
    showLimError('Informe um CNPJ válido com 14 dígitos.');
    return;
  }

  const btn = document.getElementById('limBtnConsultar');
  const loading = document.getElementById('limLoading');
  const results = document.getElementById('limResults');
  btn.disabled = true;
  loading.hidden = false;

  try {
    const data = await consultarLimitesSeguradoras(cnpj, LIM_ALL_SEGURADORAS);
    renderLimitesResults(data);
  } catch (err) {
    showLimError('Erro ao consultar limites: ' + err.message);
  } finally {
    btn.disabled = false;
    loading.hidden = true;
  }
}

const LIM_STATUS_CONFIG = {
  aprovado:     { label: 'Aprovado',     cls: 'lim-badge--aprovado' },
  bloqueado:    { label: 'Bloqueado',    cls: 'lim-badge--bloqueado' },
  nomeado:      { label: 'Nomeado',      cls: 'lim-badge--nomeado' },
  sem_limite:   { label: 'Sem limite',   cls: 'lim-badge--semlimite' },
  sem_resposta: { label: 'Sem resposta', cls: 'lim-badge--nomeado' },
  instavel:     { label: 'Instável',     cls: 'lim-badge--nomeado' },
  erro:         { label: 'Erro',         cls: 'lim-badge--erro' },
  aguardando:   { label: 'Aguardando',   cls: 'lim-badge--aguardando' },
};

let _ultimoLimitesData = null;

// Um limite explicitamente zerado não deve aparecer na UI — mas valor ausente
// (null/undefined, ex.: Junto sem cotação de taxa) ainda é informativo e permanece.
function isZeroLimite(valor) {
  return valor !== null && valor !== undefined && Number(valor) === 0;
}

// Mensagem padrão exibida no card quando a seguradora não libera nenhum limite ao
// tomador — substitui jargão bruto de seguradora (ex.: "tomador deve estar Aprovado e
// dentro da Data de Validade") por um texto único e direto para o usuário final.
const LIM_SEM_LIMITE_MSG = 'Sem limite liberado ao tomador.';

// Mensagens de erro/negócio das seguradoras chegam em texto livre — classifica por
// palavra-chave antes de decidir o badge. Ordem de prioridade importa (seção 6.5 do guia
// de integração): "nomeado com outro corretor" > timeout > instabilidade > bloqueado > erro.
function classifyErrorMessage(message) {
  const t = String(message || '').toLowerCase();
  // Precisa das duas partes juntas ("nomeado" + "corretor"/"broker") — uma mensagem de
  // bloqueio que apenas cita "corretora" (ex.: "bloqueado para esta corretora") não é
  // o mesmo aviso de negócio de tomador nomeado com outro corretor.
  if (t.includes('nomead') && (t.includes('corretor') || t.includes('broker'))) return 'nomeado';
  // Junto: "Corretor não possui permissão para visualizar o Tomador." — mesma família
  // de "nomeado com outro corretor" (o tomador já pertence a outro corretor de registro
  // na seguradora), só que sem a palavra "nomeado" nessa formulação específica.
  if (t.includes('corretor') && t.includes('permiss')) return 'nomeado';
  if (t.includes('tempo limite') || t.includes('timeout') || t.includes('respond')) return 'sem_resposta';
  if (['motor de crédito', 'motor de credito', 'problema ao rodar', 'instável', 'instavel', 'indisponív', 'indisponiv']
    .some(kw => t.includes(kw))) return 'instavel';
  // "Risco negado por questões técnicas" (JNS): é decisão de negócio (risco negado),
  // não instabilidade passageira do motor — o "por questões técnicas" aqui é o jargão
  // da própria JNS para negativa de crédito, não um convite a tentar de novo. Badge
  // neutro "Sem limite", não âmbar "Instável" nem vermelho "Erro".
  if (t.includes('negado') && (t.includes('técnic') || t.includes('tecnic'))) return 'sem_limite';
  if (t.includes('bloquead')) return 'bloqueado';
  return 'erro';
}

// Cada seguradora tem um formato de resposta proprio — normaliza para { statusKey, modalidades[], mensagem, nomeTomador, cnpjTomador }
function normalizeLimiteResultado(r) {
  if (r.status !== 'ok') {
    const mensagem = r.erro || 'Falha na consulta.';
    return { statusKey: classifyErrorMessage(mensagem), modalidades: [], mensagem };
  }
  const key = r.seguradora;
  if (key === 'jns') return normalizeLimiteJns(r.dados);
  if (key === 'junto') return normalizeLimiteJunto(r.dados);
  if (key === 'fator') return normalizeLimiteFator(r.dados);
  if (['essor', 'sombrero', 'newe', 'mitsui', 'axa', 'now'].includes(key)) return normalizeLimiteOnpoint(r.dados);
  return { statusKey: 'erro', modalidades: [], mensagem: 'Seguradora desconhecida.' };
}

function normalizeLimiteJns(d) {
  const nomeTomador = d && (d.name || d.issuerName);
  const cnpjTomador = d && d.document;
  const produtos = ((d && d.product_limits) || [])
    .map(p => ({
      label: String(p.product_name || '').trim(),
      segurado: String(p.product_branch || '').replace(/^SEGURADO:\s*/i, ''),
      valor: p.limit_available ?? p.approvedLimit,
      taxa: p.tax ?? p.feePercent,
    }))
    .filter(m => !isZeroLimite(m.valor));

  if (!produtos.length) {
    const msg = d && d.message;
    const cls = msg ? classifyErrorMessage(msg) : 'sem_limite';
    return {
      statusKey: cls === 'instavel' ? 'instavel' : 'sem_limite',
      modalidades: [],
      mensagem: msg || 'Nenhum limite disponível.',
      nomeTomador, cnpjTomador,
    };
  }
  return { statusKey: 'aprovado', modalidades: produtos, nomeTomador, cnpjTomador };
}

function normalizeLimiteJunto(d) {
  const lista = Array.isArray(d) ? d : [];
  const modalidades = [];
  lista.forEach(mod => {
    (mod.submodalities || []).forEach(sub => {
      const valor = sub.limitAvailable ?? null;
      if (isZeroLimite(valor)) return;
      modalidades.push({
        label: [mod.description, String(sub.description || '').replace(/^_/, '')].filter(Boolean).join(' — '),
        segurado: mod.isJudicial ? 'Judicial' : null,
        valor,
        taxa: sub.rate ?? null,
      });
    });
  });
  if (!modalidades.length) {
    return { statusKey: 'sem_limite', modalidades: [], mensagem: 'Nenhuma modalidade habilitada para este tomador.' };
  }
  const semValor = modalidades.every(m => m.valor === null || m.valor === undefined);
  return {
    statusKey: 'aprovado',
    modalidades,
    mensagem: semValor ? 'Tomador habilitado. Não foi possível obter o valor de limite por modalidade nesta consulta.' : undefined,
  };
}

function normalizeLimiteOnpoint(d) {
  const payload = Array.isArray(d) && d.length === 1 ? d[0] : d;
  const item = payload && Array.isArray(payload.Response) ? payload.Response[0] : null;

  if (item) {
    const nomeTomador = item.PolicyHolderName || null;
    const cnpjTomador = item.PolicyHolderCnpj || null;

    if (item.CanSetupAProposal && Array.isArray(item.LimitsAndRates)) {
      const modalidades = item.LimitsAndRates.filter(Boolean)
        .map(m => ({
          label: [m.ModalityGroupName, m.ModalityName].filter(Boolean).join(' — '),
          segurado: m.BranchName || null,
          valor: m.AvailableLimit,
          taxa: m.Tax,
        }))
        .filter(m => !isZeroLimite(m.valor));
      if (modalidades.length) return { statusKey: 'aprovado', modalidades, nomeTomador, cnpjTomador };
    }

    const motivo = (item.Reasons || []).join(' ');
    const cls = classifyErrorMessage(motivo);
    return {
      statusKey: cls === 'erro' ? 'sem_limite' : cls,
      modalidades: [],
      mensagem: motivo || 'Tomador não aprovado nas regras de crédito da seguradora.',
      nomeTomador,
      cnpjTomador,
    };
  }

  // Algumas respostas de negócio chegam sem "Response", apenas { Errors: [...] }
  const errors = payload && Array.isArray(payload.Errors) ? payload.Errors : [];
  if (errors.length) {
    const motivo = errors.join(' ');
    const cls = classifyErrorMessage(motivo);
    return { statusKey: cls === 'erro' ? 'sem_limite' : cls, modalidades: [], mensagem: motivo };
  }

  return { statusKey: 'erro', modalidades: [], mensagem: 'Resposta inesperada da seguradora.' };
}

function normalizeLimiteFator(d) {
  if (!d) return { statusKey: 'erro', modalidades: [], mensagem: 'Resposta inesperada da seguradora.' };

  // cd_retorno !== 0 é sempre resposta de negócio (sem limite, nomeado etc.), nunca erro técnico.
  // O texto bruto da Fator (ex.: "tomador deve estar Aprovado e dentro da Data de Validade")
  // é jargão interno da seguradora — só é exibido ao usuário quando acionável (nomeado com
  // outro corretor); nos demais casos de negócio, mostramos a mensagem padrão "sem limite".
  const codigo = Number(d.cd_retorno);
  if (codigo !== 0) {
    const msg = d.nm_retorno || 'Corretor não associado ao tomador nesta seguradora.';
    const cls = classifyErrorMessage(msg);
    return cls === 'nomeado'
      ? { statusKey: 'nomeado', modalidades: [], mensagem: msg }
      : { statusKey: 'sem_limite', modalidades: [], mensagem: LIM_SEM_LIMITE_MSG };
  }

  const linhas = Array.isArray(d.DadosTomador) ? d.DadosTomador : [];
  const modalidades = linhas
    .map(l => ({
      label: String(l.NomeGrupoSubLimite || '').trim(),
      valor: l.ValorLimiteDisponivel ?? l.ValorLimiteTotalSemCCG ?? l.ValorLimiteTotal,
      taxa: l.ValorTaxa,
    }))
    .filter(m => !isZeroLimite(m.valor));

  const nomeTomador = linhas[0] && linhas[0].NomePessoa;
  if (!modalidades.length) {
    return { statusKey: 'sem_limite', modalidades: [], mensagem: LIM_SEM_LIMITE_MSG, nomeTomador };
  }
  return { statusKey: 'aprovado', modalidades, nomeTomador };
}

function fmtLimiteTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR') + ', ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function fmtCnpjDisplay(cnpj) {
  const c = String(cnpj || '').replace(/\D/g, '');
  if (c.length !== 14) return cnpj || '';
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12, 14)}`;
}

function buildLimResultCardHtml(r, index, consultadoEm) {
  const cfg = LIM_STATUS_CONFIG[r._norm.statusKey] || LIM_STATUS_CONFIG.erro;
  const temModalidades = r._norm.modalidades && r._norm.modalidades.length > 0;
  const footer = temModalidades
    ? `<button type="button" class="lim-card-btn" onclick="openLimiteModal(${index})">
        Ver limites do tomador
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>`
    : `<p class="lim-card-desc lim-card-desc--muted">${esc(r._norm.mensagem || 'Nenhum limite disponível nesta consulta.')}</p>`;

  return `
    <div class="lim-card">
      <div class="lim-card-top">
        <p class="lim-card-eyebrow">Seguradora</p>
        <span class="lim-badge2 ${cfg.cls}">${esc(cfg.label)}</span>
      </div>
      <div class="lim-card-brand">
        ${limLogoHtml(r.seguradora)}
        <p class="lim-card-nome">${esc(r.label || LIM_LABELS[r.seguradora] || r.seguradora)}</p>
      </div>
      ${footer}
      <p class="lim-card-updated">Atualizado: ${esc(fmtLimiteTimestamp(consultadoEm))}</p>
    </div>`;
}

function renderLimitesResults(data) {
  const results = document.getElementById('limResults');
  const resultados = (data && data.resultados) || [];
  _ultimoLimitesData = data;
  results.dataset.hasResults = '1';

  if (resultados.length === 0) {
    results.innerHTML = '<p class="lim-empty">Nenhum resultado retornado.</p>';
    return;
  }

  const normalizados = resultados.map(r => ({ ...r, _norm: normalizeLimiteResultado(r) }));
  const comNome = normalizados.find(r => r._norm.nomeTomador);
  const tomadorNome = comNome ? comNome._norm.nomeTomador : null;
  const tomadorCnpj = (comNome && comNome._norm.cnpjTomador) || data.cnpj;

  const headerHtml = `
    <div class="lim-tomador-header">
      <div>
        <p class="lim-tomador-eyebrow">Tomador consultado</p>
        <p class="lim-tomador-nome">${esc(tomadorNome || 'Não identificado')}${tomadorCnpj ? ' - ' + esc(fmtCnpjDisplay(tomadorCnpj)) : ''}</p>
      </div>
    </div>`;

  const cardsHtml = normalizados.map((r, i) => buildLimResultCardHtml(r, i, data.consultadoEm)).join('');

  results.innerHTML = `${headerHtml}<div class="lim-cards-grid">${cardsHtml}</div><div class="lim-modal-overlay" id="limModalOverlay" hidden onclick="if(event.target===this) closeLimiteModal()"></div>`;
}

function openLimiteModal(index) {
  const resultados = (_ultimoLimitesData && _ultimoLimitesData.resultados) || [];
  const r = resultados[index];
  if (!r) return;
  const n = normalizeLimiteResultado(r);
  const cfg = LIM_STATUS_CONFIG[n.statusKey] || LIM_STATUS_CONFIG.erro;

  const noteHtml = (n.modalidades.length && n.mensagem)
    ? `<p class="lim-modal-note">${esc(n.mensagem)}</p>`
    : '';

  const itemsHtml = n.modalidades.length
    ? n.modalidades.map(m => `
        <div class="lim-modal-item">
          <p class="lim-modal-item-label">${esc(m.label)}</p>
          ${m.valor !== null && m.valor !== undefined ? `<p class="lim-modal-item-valor">${fmtBRL(m.valor)}</p>` : ''}
          ${m.taxa !== null && m.taxa !== undefined ? `<p class="lim-modal-item-taxa">Taxa: ${esc(String(m.taxa).replace('.', ','))}%</p>` : ''}
          ${m.segurado ? `<p class="lim-modal-item-segurado">Segurado: ${esc(m.segurado)}</p>` : ''}
        </div>`).join('')
    : `<p class="lim-modal-empty">${esc(n.mensagem || 'Nenhum limite disponível.')}</p>`;

  const overlay = document.getElementById('limModalOverlay');
  overlay.innerHTML = `
    <div class="lim-modal" role="dialog" aria-modal="true">
      <div class="lim-modal-header">
        ${limLogoHtml(r.seguradora)}
        <div>
          <p class="lim-card-eyebrow">Seguradora</p>
          <p class="lim-modal-nome">${esc(r.label || r.seguradora)}</p>
        </div>
        <span class="lim-badge2 ${cfg.cls}">${esc(cfg.label)}</span>
        <button type="button" class="lim-modal-close" onclick="closeLimiteModal()" aria-label="Fechar">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="lim-modal-body">${noteHtml}${itemsHtml}</div>
      <p class="lim-modal-updated">Atualizado: ${esc(fmtLimiteTimestamp(_ultimoLimitesData && _ultimoLimitesData.consultadoEm))}</p>
    </div>`;
  overlay.hidden = false;
}

function closeLimiteModal() {
  const overlay = document.getElementById('limModalOverlay');
  if (overlay) { overlay.hidden = true; overlay.innerHTML = ''; }
}

function classificacaoFinanceiraClass(sit) {
  const s = (sit || '').toLowerCase();
  if (s === 'boa' || s.startsWith('boa'))          return 'af-classif--boa';
  if (s.includes('regular'))                        return 'af-classif--regular';
  if (s.includes('fraca'))                          return 'af-classif--fraca';
  if (s.includes('cr') || s.includes('criti'))     return 'af-classif--critica';
  return 'af-classif--inconclusiva';
}

function buildAfClassificacaoHtml(cf) {
  if (!cf || !cf.situacao) return '';
  const cls = classificacaoFinanceiraClass(cf.situacao);
  const riskLabel = cf.nivel_risco ? ` · Risco ${cf.nivel_risco}` : '';
  return `
    <div class="af-classif-banner ${cls}">
      <span class="af-classif-situacao">${esc(cf.situacao)}${esc(riskLabel)}</span>
      ${cf.justificativa ? `<span class="af-classif-just">${esc(cf.justificativa)}</span>` : ''}
    </div>`;
}

function buildAfPrincipaisNumerosHtml(pn) {
  const campos = [
    { label: 'Ativo Total',             key: 'ativo_total' },
    { label: 'Ativo Circulante',        key: 'ativo_circulante' },
    { label: 'Passivo Total',           key: 'passivo_total' },
    { label: 'Passivo Circulante',      key: 'passivo_circulante' },
    { label: 'Patrimônio Líquido',      key: 'patrimonio_liquido' },
    { label: 'Receita Bruta',           key: 'receita_bruta' },
    { label: 'Receita Líquida',         key: 'receita_liquida' },
    { label: 'Lucro Líquido',           key: 'lucro_liquido' },
    { label: 'Caixa / Equivalentes',    key: 'caixa_e_equivalentes' },
    { label: 'Clientes a Receber',      key: 'clientes_a_receber' },
    { label: 'Estoques',                key: 'estoques' },
    { label: 'Fornecedores',            key: 'fornecedores' },
    { label: 'Empréstimos / Financ.',   key: 'emprestimos_e_financiamentos' },
    { label: 'Obrigações Fiscais',      key: 'obrigacoes_fiscais' },
    { label: 'Obrigações Trabalhistas', key: 'obrigacoes_trabalhistas' },
  ].filter(c => hasIndicadorValue(pn[c.key]));

  if (!campos.length) return '';
  return `
    <div class="af-principais-card">
      <p class="af-subsection-title af-subsection-title--sm">Principais Números (período mais recente)</p>
      <div class="af-principais-grid">
        ${campos.map(c => {
          const val = pn[c.key];
          const isNeg = typeof val === 'number' && val < 0;
          const display = typeof val === 'number' ? fmtBRL(val) : String(val);
          return `<div class="af-principal-item${isNeg ? ' af-principal-item--neg' : ''}">
            <span class="af-principal-label">${esc(c.label)}</span>
            <span class="af-principal-valor">${esc(display)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

function buildAfIndicadoresCalcHtml(ic) {
  const config = [
    { key: 'liquidez_corrente',        label: 'Liquidez Corrente',       format: 'dec' },
    { key: 'liquidez_seca',            label: 'Liquidez Seca',           format: 'dec' },
    { key: 'capital_de_giro_liquido',  label: 'Capital de Giro Líq.',    format: 'brl' },
    { key: 'endividamento_geral',      label: 'Endividamento Geral',     format: 'pct' },
    { key: 'divida_sobre_pl',          label: 'Dívida / PL',             format: 'dec' },
    { key: 'composicao_endividamento', label: 'Composição Endiv. CP',    format: 'pct' },
    { key: 'margem_bruta',             label: 'Margem Bruta',            format: 'pct' },
    { key: 'margem_operacional',       label: 'Margem Operacional',      format: 'pct' },
    { key: 'margem_liquida',           label: 'Margem Líquida',          format: 'pct' },
    { key: 'roe',                      label: 'ROE',                     format: 'pct' },
    { key: 'roa',                      label: 'ROA',                     format: 'pct' },
  ].filter(c => ic[c.key] && hasIndicadorValue(ic[c.key].valor));

  if (!config.length) return '';

  return `
    <div class="af-indicadores-calc-card">
      <p class="af-subsection-title af-subsection-title--sm">Indicadores Calculados</p>
      <div class="af-ind-calc-grid">
        ${config.map(c => {
          const item = ic[c.key];
          const val = item.valor;
          const isNeg = typeof val === 'number' && val < 0;
          let display;
          if (typeof val === 'number') {
            if (c.format === 'pct')      display = (val * (Math.abs(val) <= 1.5 ? 100 : 1)).toFixed(1).replace('.', ',') + '%';
            else if (c.format === 'brl') display = fmtBRL(val);
            else                         display = val.toFixed(2).replace('.', ',');
          } else display = String(val);
          return `
            <div class="af-ind-calc-item${isNeg ? ' af-ind-calc-item--neg' : ''}">
              <span class="af-ind-calc-label">${esc(c.label)}</span>
              <span class="af-ind-calc-valor">${esc(display)}</span>
              ${item.interpretacao ? `<span class="af-ind-calc-interp">${esc(item.interpretacao)}</span>` : ''}
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function buildAfQualitativaHtml(aq) {
  const campos = [
    { key: 'liquidez',              label: 'Liquidez' },
    { key: 'endividamento',         label: 'Endividamento' },
    { key: 'rentabilidade',         label: 'Rentabilidade' },
    { key: 'patrimonio_liquido',    label: 'Patrimônio Líquido' },
    { key: 'resultado',             label: 'Resultado / Evolução' },
    { key: 'capital_de_giro',       label: 'Capital de Giro' },
    { key: 'capacidade_financeira', label: 'Capacidade Financeira' },
    { key: 'consistencia_contabil', label: 'Consistência Contábil' },
  ].filter(c => aq[c.key] && String(aq[c.key]).trim());

  if (!campos.length) return '';
  return `
    <div class="af-qualitativa-card">
      <p class="af-subsection-title af-subsection-title--sm">Análise Qualitativa</p>
      <div class="af-qualitativa-grid">
        ${campos.map(c => `
          <div class="af-qual-item">
            <span class="af-qual-label">${esc(c.label)}</span>
            <span class="af-qual-texto">${esc(aq[c.key])}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function buildAfSinaisHtml(sinaisPos, sinaisNeg, pontosPos, pontosAtencao) {
  const positivos = [...sinaisPos, ...pontosPos].filter((p, i, a) => p && a.indexOf(p) === i);
  const negativos = [...sinaisNeg, ...pontosAtencao].filter((p, i, a) => p && a.indexOf(p) === i);
  if (!positivos.length && !negativos.length) return '';

  const posHtml = positivos.length
    ? `<div class="af-pontos-card af-pontos-card--pos">
        <p class="af-card-label">Sinais Positivos</p>
        <ul class="af-pontos-list">${positivos.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>`
    : '';
  const negHtml = negativos.length
    ? `<div class="af-pontos-card af-pontos-card--atencao">
        <p class="af-card-label">Sinais Negativos / Pontos de Atenção</p>
        <ul class="af-pontos-list">${negativos.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>`
    : '';

  return `<div class="af-pontos-grid">${posHtml}${negHtml}</div>`;
}

function buildAfListaCard(itens, listClass, itemClass, titulo) {
  const validos = (itens || []).filter(i => i && String(i).trim());
  if (!validos.length) return '';
  return `
    <div class="af-lista-generica-card">
      <p class="af-subsection-title af-subsection-title--sm">${esc(titulo)}</p>
      <ul class="${listClass}">
        ${validos.map(i => `<li class="${itemClass}">${esc(i)}</li>`).join('')}
      </ul>
    </div>`;
}

function buildAfVisaoSgHtml(vsg) {
  if (!vsg || (!vsg.capacidade_para_assumir_contratos && !vsg.recomendacao_operacional)) return '';
  const c = (vsg.capacidade_para_assumir_contratos || '').toLowerCase();
  const capCls = c.includes('boa') || c.includes('alta') ? 'af-vsg--boa'
    : c.includes('moderada') ? 'af-vsg--moderada'
    : c.includes('limitada') || c.includes('baixa') ? 'af-vsg--limitada'
    : 'af-vsg--risco';

  return `
    <div class="af-visao-sg-card ${capCls}">
      <p class="af-card-label">Visão para Seguro Garantia</p>
      ${vsg.capacidade_para_assumir_contratos ? `<p class="af-vsg-capacidade">${esc(vsg.capacidade_para_assumir_contratos)}</p>` : ''}
      ${(vsg.pontos_de_atencao_para_subscricao || []).filter(Boolean).length > 0 ? `
        <ul class="af-vsg-pontos">
          ${vsg.pontos_de_atencao_para_subscricao.filter(Boolean).map(p => `<li>${esc(p)}</li>`).join('')}
        </ul>` : ''}
      ${vsg.recomendacao_operacional ? `<p class="af-vsg-recomendacao">${esc(vsg.recomendacao_operacional)}</p>` : ''}
    </div>`;
}

function buildAfConclusaoHtml(conc) {
  if (!conc || !conc.resumo_da_conclusao) return '';
  const nivel = String(conc.nivel_confianca_da_analise || '').toUpperCase();
  const nivelCls = nivel === 'ALTO' ? 'af-conc--alto' : nivel === 'MEDIO' ? 'af-conc--medio' : 'af-conc--baixo';
  return `
    <div class="af-conclusao-final-card">
      <p class="af-card-label">Conclusão Operacional</p>
      <div class="af-conc-body">
        ${conc.empresa_tem_bons_numeros !== null && conc.empresa_tem_bons_numeros !== undefined ? `
          <div class="af-conc-flags">
            <span class="af-conc-flag ${conc.empresa_tem_bons_numeros ? 'af-conc-flag--sim' : 'af-conc-flag--nao'}">${conc.empresa_tem_bons_numeros ? '✓ Bons números' : '✕ Bons números'}</span>
            ${conc.empresa_tem_numeros_ruins !== null && conc.empresa_tem_numeros_ruins !== undefined ? `<span class="af-conc-flag ${conc.empresa_tem_numeros_ruins ? 'af-conc-flag--nao' : 'af-conc-flag--sim'}">${conc.empresa_tem_numeros_ruins ? '✕ Números ruins' : '✓ Sem números ruins críticos'}</span>` : ''}
          </div>` : ''}
        <p class="af-conc-texto">${esc(conc.resumo_da_conclusao)}</p>
        ${nivel ? `<span class="af-conc-nivel ${nivelCls}">Confiança: ${esc(nivel)}</span>` : ''}
      </div>
    </div>`;
}

