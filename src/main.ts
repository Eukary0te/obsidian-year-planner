import {
  App,
  ItemView,
  Plugin,
  WorkspaceLeaf,
  Notice,
  normalizePath,
  TFile,
  Modal,
} from "obsidian";

/* =========================
   Constants & utils
   ========================= */
const VIEW_TYPE = "year-planner-view";
const DEFAULT_FIRST_DAY_MON = true;

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAY_NAMES_MON = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const WEEKDAY_NAMES_SUN = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const DEFAULT_PALETTE = [
  { color: "#FFB3BA", label: "" },
  { color: "#BFFCC6", label: "" },
  { color: "#B3E5FC", label: "" },
  { color: "#FFD180", label: "" },
];

function currentYear(): number { return new Date().getFullYear(); }
function isToday(y: number, m: number, d: number) {
  const t = new Date(); return t.getFullYear()===y && t.getMonth()===m && t.getDate()===d;
}
function ymdToISO(y: number, m0: number, d: number): string {
  const m=m0+1, mm=m<10?`0${m}`:String(m), dd=d<10?`0${d}`:String(d);
  return `${y}-${mm}-${dd}`;
}
function buildMonthMatrix(year: number, m0: number, monFirst: boolean) {
  const first = new Date(year, m0, 1);
  const start = first.getDay(); // 0=Sun..6=Sat
  const shift = monFirst ? (start===0?6:start-1) : start;
  const daysIn = new Date(year, m0+1, 0).getDate();
  const prevDays = new Date(year, m0, 0).getDate();
  const cells: {y:number;m:number;d:number;inMonth:boolean}[] = [];
  for (let i=0;i<42;i++){
    const day = i - shift + 1;
    if (day<1){
      const d = prevDays + day;
      const date = new Date(year, m0-1, d);
      cells.push({ y: date.getFullYear(), m: date.getMonth(), d: date.getDate(), inMonth:false });
    } else if (day>daysIn){
      const d = day - daysIn;
      const date = new Date(year, m0+1, d);
      cells.push({ y: date.getFullYear(), m: date.getMonth(), d: date.getDate(), inMonth:false });
    } else {
      cells.push({ y: year, m: m0, d: day, inMonth:true });
    }
  }
  return cells;
}
function debounce<T extends (...args:any[])=>void>(fn:T, ms:number){
  let t:number|undefined;
  return (...args:Parameters<T>)=>{
    if (t) window.clearTimeout(t);
    // @ts-ignore
    t = window.setTimeout(()=>fn(...args), ms);
  };
}
function pickTextColor(bg: string): string {
  if (!bg) return "#111";
  let r=0,g=0,b=0;
  if (bg.startsWith("#")){
    const hex = bg.slice(1);
    if (hex.length===3){
      r=parseInt(hex[0]+hex[0],16); g=parseInt(hex[1]+hex[1],16); b=parseInt(hex[2]+hex[2],16);
    } else if (hex.length>=6){
      r=parseInt(hex.slice(0,2),16); g=parseInt(hex.slice(2,4),16); b=parseInt(hex.slice(4,6),16);
    }
  } else if (bg.startsWith("rgb")){
    const nums = bg.replace(/rgba?\(|\)/g,"").split(",").map(x=>parseFloat(x.trim()));
    r = nums[0]??0; g = nums[1]??0; b = nums[2]??0;
  }
  const yiq = (r*299 + g*587 + b*114)/1000;
  return yiq >= 150 ? "#111" : "#fff";
}
function isHexColor(s:string){ return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim()); }

/* =========================
   Data types
   ========================= */
type DayData = { color?: string; note?: string; };
type YearData = {
  year: number;
  days: Record<string, DayData>;
  palettes?: { colors?: string[]; items?: { color: string; label?: string }[] };
  settings?: { firstDayOfWeek?: "mon"|"sun" };
};

/* =========================
   Plugin
   ========================= */
export default class YearPlannerPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf)=>new YearPlannerView(this, leaf));

    this.addCommand({ id:"open-year-planner", name:"Open Year Planner", callback:()=>this.activateView() });
    this.addCommand({ id:"toggle-brush", name:"Toggle Brush", callback:()=>this.withView(v=>v.toggleBrush()) });
    this.addCommand({ id:"year-prev", name:"Previous Year", callback:()=>this.withView(v=>v.setYear(v.year-1)) });
    this.addCommand({ id:"year-next", name:"Next Year", callback:()=>this.withView(v=>v.setYear(v.year+1)) });
    this.addCommand({ id:"year-goto", name:"Go to Year…", callback:()=>this.withView(v=>v.promptGotoYear()) });
    this.addCommand({ id:"edit-note-modal", name:"Edit note…", callback:()=>this.withView(v=>v.openEditNoteModal()) });
    // кнопку/команду Clear day специально НЕ регистрируем

    this.addRibbonIcon("calendar","Open Year Planner",()=>this.activateView());
  }

  onunload() {
  // никакого detach; можно при необходимости сохранить настройки
  // await this.saveData(this.settings) — если нужно
}

  private withView(fn:(v:YearPlannerView)=>void){
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length){ fn(leaves[0].view as YearPlannerView); }
    else new Notice("Year Planner: open the view (Open Year Planner)");
  }

  async activateView(){
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf){ leaf = workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW_TYPE, active:true }); }
    workspace.revealLeaf(leaf);
  }
}

/* =========================
   View
   ========================= */
class YearPlannerView extends ItemView {
  plugin: YearPlannerPlugin;
  year = currentYear();
  firstDayMonday = DEFAULT_FIRST_DAY_MON;

  data: YearData | null = null;

  styleEl: HTMLStyleElement | null = null;
  keydownHandler!: (e:KeyboardEvent)=>void;
  resizeHandler!: ()=>void;

  // three toolbar rows (global/local/hint)
  elGlobal!: HTMLElement;
  elLocal!: HTMLElement;
  elHint!: HTMLElement;

  elRefs!: {
    yearEl: HTMLElement;
    grid: HTMLElement;
    btnBrush: HTMLButtonElement;
    paletteWrap: HTMLElement;
    toolbar: HTMLElement;
  };

  brushEnabled = false;
  brushColor: string = DEFAULT_PALETTE[0].color;
  isDragging = false;
  lastPickedISO: string | null = null;

  saveDebounced = debounce(()=>this.saveData().catch(console.error), 400);

  constructor(plugin: YearPlannerPlugin, leaf: WorkspaceLeaf){ super(leaf); this.plugin = plugin; }
  getViewType(){ return VIEW_TYPE; }
  getDisplayText(){ return "Year Planner"; }
  getIcon(){ return "calendar"; }

  /* ---- paths ---- */
  private dataJsonPathFor(year:number){
    const cfg = this.app.vault.configDir;
    return normalizePath(`${cfg}/plugins/obsidian-year-planner/data-${year}.json`);
  }
  private dataMarkdownPathFor(year:number){
    return normalizePath(`Year Planner ${year}.md`);
  }
  private async ensurePluginDir(){
    const dir = normalizePath(`${this.app.vault.configDir}/plugins/obsidian-year-planner`);
    if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
  }

  /* ---- load/save ---- */
  private normalizePalette(y:YearData){
    if (y.palettes?.items?.length) return;
    const colors = y.palettes?.colors?.length ? y.palettes.colors : DEFAULT_PALETTE.map(p=>p.color);
    y.palettes = { items: colors.map(c=>({ color:c, label:"" })) };
  }
  private async loadData(year:number): Promise<YearData>{
    await this.ensurePluginDir();
    const p = this.dataJsonPathFor(year);
    if (await this.app.vault.adapter.exists(p)){
      try{
        const raw = await this.app.vault.adapter.read(p);
        const y = JSON.parse(raw) as YearData;
        if (!y.days) y.days = {};
        this.normalizePalette(y);
        return y;
      }catch{}
    }
    // fresh
    return {
      year,
      days: {},
      palettes: { items: DEFAULT_PALETTE.map(p=>({ ...p })) },
      settings: { firstDayOfWeek: this.firstDayMonday ? "mon":"sun" },
    };
  }
  private async saveData(){
    if (!this.data) return;
    await this.ensurePluginDir();
    const path = this.dataJsonPathFor(this.data.year);
    await this.app.vault.adapter.write(path, JSON.stringify(this.data, null, 2));
    await this.writeMarkdownMirror(this.data).catch(()=>{});
  }

  /* ---- markdown mirror ---- */
  private mdTemplate(y:YearData){
    const json = JSON.stringify(y, null, 2);
    return `# Year Planner ${y.year}

> Edit the JSON inside the code block below and run **Year Planner: Refresh from Markdown** (command).

\`\`\`json
${json}
\`\`\`
`;
  }
  private async writeMarkdownMirror(y:YearData){
    const mdPath = this.dataMarkdownPathFor(y.year);
    const file = this.app.vault.getAbstractFileByPath(mdPath);
    const content = this.mdTemplate(y);
    if (file instanceof TFile) await this.app.vault.modify(file, content);
    else await this.app.vault.create(mdPath, content);
  }
  private extractJsonFromMarkdown(md:string): YearData | null {
    const s = md.indexOf("```json"); if (s===-1) return null;
    const start = s + "```json".length;
    const e = md.indexOf("```", start); if (e===-1) return null;
    try{
      const y = JSON.parse(md.slice(start, e).trim()) as YearData;
      if (!y.days) y.days = {};
      this.normalizePalette(y);
      return y;
    }catch{ return null; }
  }
  async refreshFromMarkdown(){
    const mdPath = this.dataMarkdownPathFor(this.year);
    const file = this.app.vault.getAbstractFileByPath(mdPath);
    if (!(file instanceof TFile)){ new Notice(`Markdown not found: ${mdPath}`); return; }
    const md = await this.app.vault.read(file);
    const y = this.extractJsonFromMarkdown(md);
    if (!y){ new Notice("Invalid JSON inside markdown"); return; }
    if (y.year !== this.year){ await this.setYear(y.year); return; }
    this.data = y;
    this.firstDayMonday = (this.data.settings?.firstDayOfWeek ?? "mon")==="mon";
    this.renderPalette();
    this.render();
    new Notice("Data refreshed from Markdown");
  }

  /* ---- lifecycle ---- */
  async onOpen(){
    const container = this.containerEl.children[1];
    container.empty();

    this.styleEl = document.createElement("style");
    this.styleEl.textContent = `
      .yp-toolbar { display:flex; flex-direction:column; gap:6px; margin:8px 0 12px; }
      .yp-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .yp-year { font-size:18px; font-weight:600; padding:0 6px; }
      .yp-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; align-items:start; align-content:start; --yp-day-h:22px; }
      .yp-month { border:1px solid var(--background-modifier-border); border-radius:8px; padding:8px; height:fit-content; }
      .yp-month h3 { margin:2px 0 6px; font-size:13px; font-weight:700; opacity:.85; }
      .yp-cal { display:grid; grid-template-rows:auto repeat(6,auto); gap:2px; }
      .yp-weekdays { display:grid; grid-template-columns:repeat(7,1fr); gap:2px; font-size:11px; opacity:.8; }
      .yp-weekdays div { text-align:center; padding:2px 0; }
      .yp-weeks { display:grid; grid-template-rows:repeat(6,auto); gap:2px; position:relative; }
      .yp-week { position:relative; display:grid; grid-template-columns:repeat(7,1fr); gap:2px; }
      .yp-day {
        min-height: var(--yp-day-h);
        border-radius:6px; padding:4px; font-size:11px; line-height:1; text-align:right; position:relative;
        background: var(--background-primary); border:1px solid var(--background-modifier-border);
        user-select:none; overflow:hidden;
      }
      .yp-day.is-outside { visibility:hidden; pointer-events:none; user-select:none; }

      .yp-day.is-today {
        box-shadow: 0 0 0 2px var(--interactive-accent), inset 0 0 0 999px color-mix(in srgb, var(--interactive-accent) 12%, transparent);
      }
      .yp-day.is-selected { outline:2px solid var(--text-accent); outline-offset:-2px; }

      .yp-day.has-color { font-weight:600; }
      .note-dot { position:absolute; left:4px; bottom:3px; width:6px; height:6px; border-radius:50%; background: var(--interactive-accent); opacity:.9; }

      /* run pill — единый сегмент */
      .run-pill {
        position:absolute; height:var(--yp-day-h); border-radius:8px;
        display:flex; align-items:center; justify-content:center; font-weight:400; font-size:12px;
        pointer-events:none; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;
        box-shadow: 0 0 0 1px var(--background-modifier-border) inset;
        top:0; left:0;
      }
      .hide-number { color: transparent !important; text-shadow:none !important; }

      .yp-tooltip {
        background: var(--background-secondary); border:1px solid var(--background-modifier-border);
        padding:4px 6px; border-radius:6px; font-size:12px; max-width:240px; white-space:normal; pointer-events:none;
      }

      .yp-toolbar button { border:1px solid var(--background-modifier-border); background:var(--background-primary); padding:4px 8px; border-radius:6px; cursor:pointer; }
      .yp-toolbar button:hover { background: var(--background-modifier-hover); }

      /* ==== GROUPS chips ==== */
      .yp-palette { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .yp-chip { display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid var(--background-modifier-border); border-radius:10px; background: var(--background-secondary); }
      .yp-swatch { width:18px; height:18px; border-radius:4px; border:1px solid var(--background-modifier-border); cursor:pointer; }
      .yp-swatch.is-active { outline:2px solid var(--interactive-accent); }
      .yp-legend { font-size:12px; opacity:.9; user-select:none; pointer-events:none; } /* не кликабельно */

      .yp-btn-toggle.on { background: var(--interactive-accent); color: var(--text-on-accent); }
      .yp-hint { opacity:.7; font-size:12px; }

      .spacer { flex:1; }
      .muted { opacity:.7; }
      .inp { padding:4px 6px; border:1px solid var(--background-modifier-border); border-radius:6px; background:var(--background-primary); }
    `;
    document.head.appendChild(this.styleEl);

    // toolbar container (3 rows)
    const toolbar = container.createDiv({ cls:"yp-toolbar" });
    const rowGlobal = toolbar.createDiv({ cls:"yp-row" }); // 1: global
    const rowLocal  = toolbar.createDiv({ cls:"yp-row" }); // 2: local
    const rowHint   = toolbar.createDiv({ cls:"yp-row" }); // 3: hint

    // row: Global
    const btnPrev = rowGlobal.createEl("button", { text:"← Year" });
    const yearEl  = rowGlobal.createDiv({ cls:"yp-year", text:String(this.year) });
    const btnNext = rowGlobal.createEl("button", { text:"Year →" });
    rowGlobal.createDiv({ cls:"spacer" });
    const btnGroupSettings = rowGlobal.createEl("button", { text:"Group Settings" });

    btnPrev.onclick = ()=>this.setYear(this.year-1);
    btnNext.onclick = ()=>this.setYear(this.year+1);
    btnGroupSettings.onclick = ()=>this.openGroupSettingsModal();

    // row: Local
    const paletteWrap = rowLocal.createDiv({ cls:"yp-palette" });
    paletteWrap.createSpan({ text:"Groups:" });
    const btnBrush = rowLocal.createEl("button", { text:"Brush OFF" }); btnBrush.addClass("yp-btn-toggle");
    const btnNote  = rowLocal.createEl("button", { text:"Edit note" });

    btnBrush.onclick = ()=>this.toggleBrush();
    btnNote.onclick  = ()=>this.openEditNoteModal();

    // row: Hint
    rowHint.createSpan({ cls:"yp-hint", text:"Brush ON: paint • Brush OFF: click = edit note • Alt-click = clear" });

    const grid = container.createDiv({ cls:"yp-grid" });
    this.elGlobal = rowGlobal;
    this.elLocal  = rowLocal;
    this.elHint   = rowHint;
    this.elRefs = { yearEl, grid, btnBrush, paletteWrap, toolbar };

    // keyboard
    this.keydownHandler = (e:KeyboardEvent)=>{
      if (!this.containerEl.contains(document.activeElement)) return;
      if (e.key==="ArrowLeft"){ this.setYear(this.year-1); e.preventDefault(); }
      if (e.key==="ArrowRight"){ this.setYear(this.year+1); e.preventDefault(); }
      if (e.key.toLowerCase()==="b"){ this.toggleBrush(); e.preventDefault(); }
      if (e.key.toLowerCase()==="n"){ this.openEditNoteModal(); e.preventDefault(); }
      // Backspace для очистки убрали сознательно
    };
    window.addEventListener("keydown", this.keydownHandler, true);
    window.addEventListener("mouseup", ()=>{ this.isDragging=false; }, true);

    // load & render
    this.data = await this.loadData(this.year);
    this.firstDayMonday = (this.data.settings?.firstDayOfWeek ?? "mon")==="mon";
    await this.writeMarkdownMirror(this.data).catch(()=>{});
    this.renderPalette();
    this.render();

    // adaptive height
    this.resizeHandler = ()=>{ this.recomputeCellHeight(); this.renderAllRunPills(); };
    window.addEventListener("resize", this.resizeHandler, { passive:true });
    this.recomputeCellHeight();
    this.renderAllRunPills(); // на всякий повтор, сразу после первой отрисовки
  }
  async onClose(){
    window.removeEventListener("keydown", this.keydownHandler, true);
    window.removeEventListener("resize", this.resizeHandler);
    this.styleEl?.remove(); this.styleEl=null;
  }

  /* ---- helpers ---- */
  private clearHoverTips() {
    document.querySelectorAll<HTMLElement>(".yp-tooltip").forEach(n => n.remove());
  }

  /* ---- palette / groups ---- */
  private renderPalette(){
    const items = this.data?.palettes?.items?.length ? this.data!.palettes!.items! : DEFAULT_PALETTE;
    const wrap = this.elRefs.paletteWrap;
    while (wrap.children.length > 1) wrap.lastElementChild?.remove(); // оставить "Groups:"

    items.forEach((it)=>{
      const chip = wrap.createDiv({ cls:"yp-chip" });

      const sw = chip.createDiv({ cls:"yp-swatch" }) as HTMLElement;
      sw.style.background = it.color;
      if (this.brushColor===it.color) sw.addClass("is-active");

      const legend = chip.createSpan({ cls:"yp-legend", text: it.label ?? "" });
      // legend не кликабелен, только отображение

      sw.addEventListener("click", ()=>{
        this.brushColor = it.color;
        wrap.querySelectorAll(".yp-swatch").forEach(s=>s.removeClass("is-active"));
        sw.addClass("is-active");
      });

      chip.addEventListener("contextmenu", (e)=>{ e.preventDefault(); this.openGroupSettingsModal(); });
      chip.addEventListener("dblclick", ()=> this.openGroupSettingsModal());
    });
  }

  toggleBrush(){
    this.brushEnabled = !this.brushEnabled;
    this.elRefs.btnBrush.setText(this.brushEnabled ? "Brush ON" : "Brush OFF");
    this.elRefs.btnBrush.toggleClass("on", this.brushEnabled);
    new Notice(`Brush ${this.brushEnabled ? "enabled":"disabled"}`, 800);
  }

  /* ---- year / render ---- */
  async setYear(y:number){
    this.year = y; this.elRefs.yearEl.setText(String(this.year));
    this.data = await this.loadData(this.year);
    this.firstDayMonday = (this.data.settings?.firstDayOfWeek ?? "mon")==="mon";
    this.renderPalette(); this.render();
    this.renderAllRunPills();
  }
  promptGotoYear(){
    const y = window.prompt("Go to year:", String(this.year)); if (!y) return;
    const n = Number(y); if (Number.isFinite(n) && n>=1 && n<=9999) this.setYear(n); else new Notice("Bad year");
  }
  private pendingScrollToMonth: number | null = null;
  private jumpToMonthOf(year:number, m0:number){
    if (year !== this.year){ this.pendingScrollToMonth = m0; this.setYear(year); }
    else this.scrollToMonth(m0);
  }
  private scrollToMonth(m0:number){
    const el = this.containerEl.querySelector<HTMLElement>(`.yp-month[data-month="${m0}"]`);
    el?.scrollIntoView({ behavior:"smooth", block:"start" });
  }

  private render(){
    const grid = this.elRefs.grid; grid.empty();
    const weekdayNames = this.firstDayMonday ? WEEKDAY_NAMES_MON : WEEKDAY_NAMES_SUN;

    for (let mi=0; mi<12; mi++){
      const month = grid.createDiv({ cls:"yp-month" });
      month.dataset.month = String(mi);
      month.createEl("h3", { text: `${MONTH_NAMES[mi]} ${this.year}` });

      const cal = month.createDiv({ cls:"yp-cal" });
      const weekdaysRow = cal.createDiv({ cls:"yp-weekdays" });
      weekdayNames.forEach(n=>weekdaysRow.createDiv({ text:n }));

      const weeks = cal.createDiv({ cls:"yp-weeks" });
      const cells = buildMonthMatrix(this.year, mi, this.firstDayMonday);

      for (let row=0; row<6; row++){
        const w = weeks.createDiv({ cls:"yp-week" });
        const rowMeta: { iso:string; inMonth:boolean; color?:string; note?:string; el:HTMLElement }[] = [];

        for (let col=0; col<7; col++){
          const idx = row*7 + col;
          const c = cells[idx];
          const dEl = w.createDiv({ cls:"yp-day" }) as HTMLElement;
          if (!c.inMonth) dEl.addClass("is-outside");
          if (isToday(c.y, c.m, c.d)) dEl.addClass("is-today");
          dEl.setText(String(c.d));

          const iso = ymdToISO(c.y, c.m, c.d);
          dEl.dataset.iso = iso;

          this.paintCellFromData(dEl, iso, c.inMonth);

          if (c.inMonth){
            dEl.addEventListener("mousedown", (ev)=>{
              if (ev.button!==0) return;
              if (this.brushEnabled){ this.isDragging=true; this.pickAndPaint(iso); }
            });
            dEl.addEventListener("mouseenter", ()=>{
              if (this.isDragging && this.brushEnabled) this.pickAndPaint(iso);
            });
            dEl.addEventListener("mouseup", (ev)=>{
              if (ev.button!==0) return;
              this.isDragging=false; this.lastPickedISO = iso;
            });
            dEl.addEventListener("mouseover", ()=>{ this.lastPickedISO = iso; });
            dEl.addEventListener("click", (ev)=>{
              if (ev.button!==0) return;
              this.lastPickedISO = iso;
              if (ev.altKey){
                delete this.data!.days[iso];
                this.clearHoverTips();
                this.updateDayCell(iso);
                this.saveDebounced();
                return;
              }
              if (!this.brushEnabled) this.openEditNoteModal(iso);
            });
            dEl.addEventListener("contextmenu", (e)=>{
              e.preventDefault(); this.openEditNoteModal(iso);
            });
          } else {
            dEl.addEventListener("click", ()=>this.jumpToMonthOf(c.y, c.m));
          }

          const d = this.data?.days?.[iso];
          rowMeta.push({ iso, inMonth:c.inMonth, color:d?.color, note:d?.note, el:dEl });
        }

        // pills рисуем ПОСЛЕ того как клетки в DOM (опираемся на offsetWidth)
        this.renderRunPills(w, rowMeta);

        // Alt-click на строке — работает даже над «хвостами»
        w.addEventListener("click", (ev)=>{
          if (!ev.altKey) return;
          const x = ev.clientX;
          const cellsEls = Array.from(w.querySelectorAll<HTMLElement>(".yp-day"));
          let target: HTMLElement | null = null;
          for (const n of cellsEls){
            const r = n.getBoundingClientRect();
            if (x >= r.left && x <= r.right){ target = n; break; }
          }
          if (!target) return;
          const iso2 = target.dataset.iso!;
          this.lastPickedISO = iso2;
          if (target.classList.contains("is-outside")){
            const parts = iso2.split("-").map(Number);
            this.jumpToMonthOf(parts[0], parts[1]-1);
          } else {
            delete this.data!.days[iso2];
            this.clearHoverTips();
            this.updateDayCell(iso2);
            this.saveDebounced();
          }
          ev.stopPropagation();
        });
      }
    }

    if (this.pendingScrollToMonth!=null){ this.scrollToMonth(this.pendingScrollToMonth); this.pendingScrollToMonth=null; }
  }

  /* ---- run pills ---- */
  private renderRunPills(weekEl: HTMLElement, row: { iso:string; inMonth:boolean; color?:string; note?:string; el:HTMLElement }[]){
    weekEl.querySelectorAll(".run-pill").forEach(n=>n.remove());
    row.forEach(({el})=>el.classList.remove("hide-number"));

    let i=0;
    while (i<row.length){
      const start=i; const base=row[i];
      if (!base.inMonth || !base.color){ i++; continue; }
      let j=i+1;
      while (j<row.length && row[j].inMonth && row[j].color===base.color) j++;
      // run [start..j-1]
      let label = "";
      for (let k=start;k<j;k++){ const n=row[k].note?.trim(); if (n){ label=n; break; } }

      const firstEl = row[start].el as HTMLElement;
      const lastEl  = row[j-1].el as HTMLElement;
      const left = firstEl.offsetLeft;
      const width = (lastEl.offsetLeft + lastEl.offsetWidth) - firstEl.offsetLeft;

      const pill = document.createElement("div");
      pill.className = "run-pill";
      pill.style.left = `${left}px`;
      pill.style.width = `${width}px`;
      pill.style.background = row[start].color!;
      pill.style.color = pickTextColor(row[start].color!);
      pill.textContent = label || "";

      for (let k=start;k<j;k++) row[k].el.classList.add("hide-number");

      weekEl.appendChild(pill);
      i=j;
    }
  }
  /** Полная пересборка всех «колбасок» — полезно при ресайзе */
  private renderAllRunPills(){
    const weeks = Array.from(this.containerEl.querySelectorAll<HTMLElement>(".yp-week"));
    for (const week of weeks){
      const rowNodes = Array.from(week.querySelectorAll<HTMLElement>(".yp-day"));
      const row = rowNodes.map(n=>{
        const iso2 = n.dataset.iso!; const inMonth2 = !n.classList.contains("is-outside");
        const d = this.data?.days?.[iso2];
        return { iso:iso2, inMonth:inMonth2, color:d?.color, note:d?.note, el:n };
      });
      this.renderRunPills(week, row);
    }
  }

  /* ---- Group Settings modal ---- */
  openGroupSettingsModal(){
    const self = this;
    const items = (this.data?.palettes?.items ?? []).map(it=>({ ...it }));

    class GroupsModal extends Modal {
      table!: HTMLDivElement;
      onOpen(){
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h3", { text:"Group Settings" });

        this.table = contentEl.createDiv();
        this.renderTable();

        const actions = contentEl.createDiv({ cls:"yp-row" });
        const addBtn = actions.createEl("button", { text:"Add group" });
        const saveBtn = actions.createEl("button", { text:"Save" });
        const cancelBtn = actions.createEl("button", { text:"Cancel" });

        addBtn.onclick = ()=>{ items.push({ color:"#999999", label:"New group" }); this.renderTable(); };

        saveBtn.onclick = async ()=>{
          const oldItems = self.data!.palettes!.items!;
          const mapping: Record<string,string> = {};
          for (let i=0;i<Math.min(oldItems.length, items.length);i++){
            if (oldItems[i].color !== items[i].color) mapping[oldItems[i].color] = items[i].color;
          }
          self.data!.palettes!.items = items;

          if (Object.keys(mapping).length){
            const days = self.data!.days;
            for (const iso of Object.keys(days)){
              const c = days[iso].color;
              if (c && mapping[c]) days[iso].color = mapping[c];
            }
          }
          await self.saveData();
          self.renderPalette();
          self.renderAllRunPills();
          this.close();
        };

        cancelBtn.onclick = ()=>this.close();

        const style = document.createElement("style");
        style.textContent = `
          .gs-row { display:grid; grid-template-columns: 90px 1fr auto; gap:8px; align-items:center; margin:6px 0; }
          .gs-color { width:90px; }
          .gs-delete { margin-left:8px; }
          .gs-hint { font-size:12px; opacity:.7; margin-top:6px; }
        `;
        contentEl.appendChild(style);
        contentEl.createDiv({ cls:"gs-hint", text:"Changing a group color recolors all its days" });
      }
      renderTable(){
        this.table.empty();
        items.forEach((it, idx)=>{
          const row = this.table.createDiv({ cls:"gs-row" });
          const colorInput = row.createEl("input", { attr:{ type:"color" } });
          colorInput.addClass("gs-color");
          colorInput.value = isHexColor(it.color||"") && it.color!.length===7 ? it.color! : "#999999";
          colorInput.oninput = ()=>{ it.color = colorInput.value; };

          const labelInput = row.createEl("input", { attr:{ type:"text", placeholder:"Label" } });
          labelInput.value = it.label ?? "";
          labelInput.oninput = ()=>{ it.label = labelInput.value; };

          const del = row.createEl("button", { text:"Delete", cls:"gs-delete" });
          del.onclick = ()=>{ items.splice(idx,1); this.renderTable(); };
        });
      }
    }

    new GroupsModal(this.app).open();
  }

  /* ---- modal: edit day ---- */
  openEditNoteModal(initialISO?: string){
    const y = this.year;
    let iso = initialISO ?? this.lastPickedISO ?? (()=>{ const t=new Date(); return `${y}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`; })();
    if (!iso.startsWith(String(y))) iso = `${y}-${iso.slice(5)}`;

    const day = (this.data?.days?.[iso] ?? {}) as DayData;
    const currentNote = day.note ?? "";
    const currentColor = day.color ?? "";
    const items = this.data!.palettes!.items!;

    const self = this;
    class NoteModal extends Modal {
      inputISO!: HTMLInputElement;
      textarea!: HTMLTextAreaElement;
      colorWrap!: HTMLDivElement;
      selectedColor: string = currentColor;
      onOpen(){
        const { contentEl } = this;
        contentEl.empty(); contentEl.createEl("h3", { text:"Edit day" });

        const r1 = contentEl.createDiv();
        r1.createEl("label", { text:"Date (YYYY-MM-DD): " });
        this.inputISO = r1.createEl("input", { type:"date" });
        this.inputISO.value = iso;

        contentEl.createEl("h4", { text:"Group color" });
        this.colorWrap = contentEl.createDiv({ cls:"modal-color-chips" });
        this.renderChips();

        const r2 = contentEl.createDiv({ cls:"mt-2" });
        r2.createEl("label", { text:"Note:" });
        this.textarea = r2.createEl("textarea");
        this.textarea.style.width="100%"; this.textarea.style.height="96px";
        this.textarea.value = currentNote;

        const act = contentEl.createDiv({ cls:"modal-button-container" });
        const saveBtn = act.createEl("button", { text:"Save" });
        const clearNoteBtn = act.createEl("button", { text:"Clear note" });
        const clearColorBtn = act.createEl("button", { text:"Clear color" });
        const cancelBtn = act.createEl("button", { text:"Cancel" });

        saveBtn.onclick = ()=>{
          const valISO = this.inputISO.value.trim();
          const note = this.textarea.value.trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(valISO)){ new Notice("Bad date format"); return; }
          const d = self.data!.days[valISO] ?? {};
          if (note) d.note = note; else delete d.note;
          if (this.selectedColor) d.color = this.selectedColor; else delete d.color;
          if (!d.note && !d.color) delete self.data!.days[valISO]; else self.data!.days[valISO] = d;
          self.lastPickedISO = valISO; self.updateDayCell(valISO); self.saveDebounced();
          // после любых правок — пересобрать «колбаски» целиком
          self.renderAllRunPills();
          this.close();
        };
        clearNoteBtn.onclick = ()=>{
          const valISO = this.inputISO.value.trim();
          const d = self.data!.days[valISO] ?? {};
          delete d.note; if (!d.color) delete self.data!.days[valISO]; else self.data!.days[valISO] = d;
          self.lastPickedISO = valISO; self.updateDayCell(valISO); self.saveDebounced();
          self.renderAllRunPills();
          this.close();
        };
        clearColorBtn.onclick = ()=>{
          const valISO = this.inputISO.value.trim();
          const d = self.data!.days[valISO] ?? {};
          delete d.color; if (!d.note) delete self.data!.days[valISO]; else self.data!.days[valISO] = d;
          self.lastPickedISO = valISO; self.updateDayCell(valISO); self.saveDebounced();
          self.renderAllRunPills();
          this.close();
        };
        cancelBtn.onclick = ()=>this.close();

        const style = document.createElement("style");
        style.textContent = `
          .modal-color-chips { display:flex; gap:8px; flex-wrap:wrap; margin:6px 0 8px; }
          .chip { width:22px; height:22px; border-radius:6px; border:1px solid var(--background-modifier-border); cursor:pointer; display:inline-block; }
          .chip.active { outline:2px solid var(--interactive-accent); }
          .chip-label { font-size:12px; margin-left:4px; opacity:.8; }
          .chip-wrap { display:flex; align-items:center; gap:6px; }
        `;
        contentEl.appendChild(style);
      }
      renderChips(){
        this.colorWrap.empty();
        items.forEach(it=>{
          const wrap = this.colorWrap.createDiv({ cls:"chip-wrap" });
          const chip = wrap.createDiv({ cls:"chip" });
          (chip as HTMLElement).style.background = it.color;
          if (this.selectedColor===it.color) chip.addClass("active");
          chip.onclick = ()=>{ this.selectedColor = it.color; this.renderChips(); };
          wrap.createSpan({ cls:"chip-label", text: it.label ?? "" });
        });
      }
    }
    new NoteModal(this.app).open();
  }

  /* ---- paint/update ---- */
  private pickAndPaint(iso:string){
    this.lastPickedISO = iso;
    if (!this.brushEnabled || !this.data) return;
    const color = this.brushColor;
    const day = this.data.days[iso] ?? {};
    if (day.color !== color){
      day.color = color; this.data.days[iso] = day;
      this.updateDayCell(iso); this.saveDebounced();
      this.renderAllRunPills();
    }
  }
  private paintCellFromData(el:HTMLElement, iso:string, inMonth:boolean){
    if (!inMonth){
      el.classList.remove("has-color"); el.style.color="";
      el.querySelector(".note-dot")?.remove();
      el.querySelector(".note-inline")?.remove();
      return;
    }
    const d = this.data?.days?.[iso];
    const color = d?.color; const note = d?.note;

    if (color){
      el.style.background = color; el.style.borderColor="transparent";
      el.classList.add("has-color"); el.style.color = pickTextColor(color);
    } else {
      el.style.background="var(--background-primary)";
      el.style.borderColor="var(--background-modifier-border)";
      el.classList.remove("has-color"); el.style.color="";
    }
    if (note && note.trim()!==""){
      if (!el.querySelector(".note-dot")){
        const dot = document.createElement("div"); dot.className="note-dot"; el.appendChild(dot);
      }
      el.onmouseenter = ()=>{
        const tip = document.createElement("div"); tip.className="yp-tooltip"; tip.innerText=note.trim();
        document.body.appendChild(tip);
        const r = el.getBoundingClientRect();
        tip.style.position="fixed"; tip.style.left=r.left+"px"; tip.style.top=(r.bottom+4)+"px"; tip.style.zIndex="9999";
        el.onmouseleave = ()=>tip.remove();
      };
    } else {
      el.querySelector(".note-dot")?.remove();
      el.onmouseenter = null; el.onmouseleave = null;
    }
    el.querySelector(".note-inline")?.remove();
    el.classList.remove("hide-number");
  }
  private updateDayCell(iso:string){
    this.clearHoverTips();

    const nodes = this.containerEl.querySelectorAll<HTMLElement>(`.yp-day[data-iso="${iso}"]`);
    nodes.forEach((el)=>{
      const inMonth = !el.classList.contains("is-outside");
      this.paintCellFromData(el, iso, inMonth);
    });

    // highlight selected
    this.containerEl.querySelectorAll(".yp-day.is-selected").forEach(el=>el.classList.remove("is-selected"));
    const selected = this.containerEl.querySelector<HTMLElement>(`.yp-day[data-iso="${this.lastPickedISO ?? ""}"]`);
    selected?.classList.add("is-selected");

    // rerender pill for affected week(s)
    nodes.forEach((el)=>{
      const week = el.closest(".yp-week") as HTMLElement | null; if (!week) return;
      const rowNodes = Array.from(week.querySelectorAll<HTMLElement>(".yp-day"));
      const row = rowNodes.map(n=>{
        const iso2 = n.dataset.iso!; const inMonth2 = !n.classList.contains("is-outside");
        const d = this.data?.days?.[iso2];
        return { iso:iso2, inMonth:inMonth2, color:d?.color, note:d?.note, el:n };
      });
      this.renderRunPills(week, row);
    });
  }

  /* ---- adaptive cell height ---- */
  private recomputeCellHeight(){
    const toolbarH = (this.elGlobal.getBoundingClientRect().height + this.elLocal.getBoundingClientRect().height + this.elHint.getBoundingClientRect().height);
    const padding = 90;
    const available = Math.max(320, window.innerHeight - toolbarH - padding);
    const perMonthH = available / 4; // 12 месяцев -> 4 ряда
    const cellH = Math.max(20, Math.min(42, Math.floor((perMonthH - 34) / 7)));
    this.elRefs.grid.style.setProperty("--yp-day-h", `${cellH}px`);
  }
}
