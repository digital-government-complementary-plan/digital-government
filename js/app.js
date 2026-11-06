/* ============================================================
   app.js
   ------------------------------------------------------------
   Vueアプリ本体。フォーム状態の保持とCRUD操作のみを担当し、
   サンプルデータ生成は AppModules.SampleData、
   法定相続情報一覧図の描画は AppModules.DiagramEngine に委譲する。

   ------------------------------------------------------------
   作成者の排他制御について:
   「作成者」は原則1名（相続人の誰か、または代理人）に限定される。
   そのため各人物の isCreator と、代理人モード(creator.isAgentMode)
   は相互排他になるよう、必ず clearAllCreatorFlags() 経由で
   切り替える。個々の checkbox に直接 v-model で isCreator を
   バインドしていない（それだと他をクリアできないため）。

   代襲相続について:
   ・子の系統（直系卑属）は再代襲が民法上認められているため、
     子の代襲者はさらに自分自身の代襲者を持てる（substitutes配列を
     再帰的に持つ）。
   ・兄弟姉妹の系統は代襲が一代限り（民法889条2項が887条3項を
     準用しないため再代襲なし）のため、兄弟姉妹の代襲者は
     さらに代襲者を持てない（substitutesフィールドを持たせない）。
   ・代襲者をすべて削除したら、自動入力していた死亡日もクリアする
     （削除しても死亡日欄だけ残り続けるという不具合を防ぐため）。
   ・子・兄弟姉妹の「死亡」欄は「被相続人より先に死亡している場合」
     専用の欄である。被相続人の死亡後にその相続人が死亡した場合
     （数次相続）は、この法定相続情報一覧図における相続人としての地位に変わりは
     ないため、この欄には入力しない（入力すると代襲者がいない限り
     法定相続情報一覧図から除外されてしまうため）。

   非嫡出子について:
   ・非嫡出子の記載パターンは、平成25年9月4日以前に開始した相続に
     限られる（それ以降は嫡出子・非嫡出子の相続分が同等になり、
     この特別な記載様式を用いる対象ではなくなるため）。
   ・被相続人の死亡日から可能な範囲で自動判定し、条件を満たさない
     場合は警告を表示する（自由入力のため完全な自動判定はできない
     場合がある）。
   ============================================================ */

(function () {
  "use strict";

  const { createApp, ref, reactive, computed, provide, onMounted, onUpdated, nextTick, watch } = Vue;
  const { SampleData, DiagramEngine, SubstituteEditorComponent } = window.AppModules;
  const AssetDemos = window.AppModules.AssetDemos || [];


  // ------------------------------------------------------------
  // 和暦の日付文字列（例: "平成24年3月1日"）を西暦に変換する。
  // 解析できない場合は null を返す（プレースホルダの「〇」等）。
  // ------------------------------------------------------------
  const ERA_START_YEAR = { "明治": 1868, "大正": 1912, "昭和": 1926, "平成": 1989, "令和": 2019 };
  function parseJapaneseEraDate(str) {
    if (!str) return null;
    const m = String(str).match(/(明治|大正|昭和|平成|令和)\s*(元|[0-9]+)\s*年\s*([0-9]+)\s*月\s*([0-9]+)\s*日/);
    if (!m) return null;
    const eraStart = ERA_START_YEAR[m[1]];
    if (!eraStart) return null;
    const y = m[2] === "元" ? 1 : parseInt(m[2], 10);
    const month = parseInt(m[3], 10);
    const day = parseInt(m[4], 10);
    if (isNaN(y) || isNaN(month) || isNaN(day)) return null;
    return { year: eraStart + y - 1, month, day };
  }
  const ILLEGITIMATE_CUTOFF = { year: 2013, month: 9, day: 4 }; // 平成25年9月4日
  function compareYMD(a, b) {
    if (a.year !== b.year) return a.year - b.year;
    if (a.month !== b.month) return a.month - b.month;
    return a.day - b.day;
  }
  // 戻り値: true=条件を満たす(この日以前), false=満たさない, null=判定不能
  window.AppModules.checkIllegitimatePatternDate = function (deathStr) {
    const parsed = parseJapaneseEraDate(deathStr);
    if (!parsed) return null;
    return compareYMD(parsed, ILLEGITIMATE_CUTOFF) <= 0;
  };

  // 日付の入力欄。「令和 年 月 日」の枠で入力し、年と月は現在の日付が自動で入る。
  // 値は「令和8年10月5日」の形の文字列（未入力の部分は「〇」）で、書類にそのまま使う。
  // 続柄の入力部品。入力欄にはカッコを出さず、中身（長男・妻など）だけを入力する。
  // カッコは自動で付き、保存される値は「（長男）」のようにカッコつき（図に出力するときもカッコつき）。
  const ParenInput = {
    props: { modelValue: { type: String, default: "" }, placeholder: { type: String, default: "" } },
    emits: ["update:modelValue"],
    data() { return { composing: false }; },
    computed: {
      inner() { return String(this.modelValue || "").replace(/^[（(]+/, "").replace(/[）)]+$/, ""); }
    },
    methods: {
      commit(e) {
        const raw = e.target.value;
        const clean = raw.replace(/[（）()]/g, "");   // 自分でカッコを打っても二重にならない
        if (clean !== raw) e.target.value = clean;
        this.$emit("update:modelValue", clean.trim() ? "（" + clean + "）" : "");
      },
      onInput(e) { if (!this.composing && !e.isComposing) this.commit(e); },
      onCompEnd(e) { this.composing = false; this.commit(e); }
    },
    template: `<span class="paren-input"><input type="text" class="paren-field" :value="inner" :placeholder="placeholder" @input="onInput" @compositionstart="composing = true" @compositionend="onCompEnd" @click.stop></span>`
  };
  // 亡くなっている人の入力欄（「死亡」にチェックを入れたあとに出る）。
  // 死亡年月日（元号のプルダウン＋数字）を入力する。被相続人より先か後かは、日付で判定する。
  const DeadFields = {
    props: {
      person: { type: Object, required: true },
      judgeFn: { type: Function, required: true },        // 判定の説明文を返す
      checkFn: { type: Function, default: null }          // 日付が最後まで入力されたら呼ぶ（相続人にならない場合の注意）
    },
    methods: {
      setDate(v) { this.person.death = v; },
      onComplete() { if (this.checkFn) this.checkFn(this.person); }
    },
    template: `
      <div v-if="person.death" class="dead-box">
        <div class="form-group">
          <label>死亡年月日</label>
          <era-date :model-value="person.death" kind="death" :not-before="person.birth" @update:modelValue="setDate" @complete="onComplete"></era-date>
        </div>
        <div v-if="judgeFn(person)" class="dead-judge">{{ judgeFn(person) }}</div>
      </div>`
  };
  // ------------------------------------------------------------
  // 和暦の日付: 元号はプルダウン、年月日は数字だけを入力する。ありえない日付は、入力を受け付けない。
  // ------------------------------------------------------------
  const ERA_DEF = {
    "明治": { base: 1867, start: 18680125, end: 19120729 },
    "大正": { base: 1911, start: 19120730, end: 19261224 },
    "昭和": { base: 1925, start: 19261225, end: 19890107 },
    "平成": { base: 1988, start: 19890108, end: 20190430 },
    "令和": { base: 2018, start: 20190501, end: 99991231 }
  };
  const ERA_ORDER = ["令和", "平成", "昭和", "大正", "明治"];
  const toHalf = (v) => String(v == null ? "" : v).replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
  // 「昭和45年3月〇日」→ { era, y, m, d }（未入力・〇は null）。日付の形でなければ null
  function parseJa(str) {
    const t = toHalf(str).replace(/\s/g, "");
    const m = t.match(/(令和|平成|昭和|大正|明治)(元|\d+|〇)?年(\d+|〇)?月(\d+|〇)?日/);
    if (!m) return null;
    const n = (x) => (x === undefined || x === "〇" ? null : x === "元" ? 1 : parseInt(x, 10));
    return { era: m[1], y: n(m[2]), m: n(m[3]), d: n(m[4]) };
  }
  function composeJa(p) { return p.era + (p.y || "〇") + "年" + (p.m || "〇") + "月" + (p.d || "〇") + "日"; }
  // 2つの和暦の日付の前後（a が前なら -1、同じ日なら 0、後なら 1。年月日が足りず決められなければ null）
  function compareJa(a, b) {
    if (!a || !b || a.y === null || b.y === null) return null;
    const ga = ERA_DEF[a.era].base + a.y, gb = ERA_DEF[b.era].base + b.y;
    if (ga !== gb) return ga < gb ? -1 : 1;
    if (a.m === null || b.m === null) return null;
    if (a.m !== b.m) return a.m < b.m ? -1 : 1;
    if (a.d === null || b.d === null) return null;
    if (a.d !== b.d) return a.d < b.d ? -1 : 1;
    return 0;
  }
  // ありえない日付なら、その理由を返す（問題なければ ""）。年・月・日は、数字か null（未入力）。
  //   入力中に確かめる「暦のうえで、ありえない日付」（13月、2月30日、昭和65年、元号の切り替え前後など）。
  function hardJaProblem(p) {
    const def = ERA_DEF[p.era];
    if (!def) return "元号が正しくありません";
    const y = p.y, m = p.m, d = p.d;
    if (y !== null && y < 1) return "年は、1以上を入力してください";
    if (m !== null && (m < 1 || m > 12)) return "月は、1〜12を入力してください";
    if (d !== null && (d < 1 || d > 31)) return "日は、1〜31を入力してください";
    const sy = Math.floor(def.start / 10000), ey = Math.floor(def.end / 10000);
    const gy = y === null ? null : def.base + y;
    if (gy !== null && (gy < sy || gy > ey)) return p.era + y + "年は、ありません";
    if (gy !== null && m !== null && p.era !== "明治") {
      if (gy === sy && m < Math.floor(def.start / 100) % 100) return p.era + y + "年" + m + "月は、ありません";
      if (gy === ey && ey < 9999 && m > Math.floor(def.end / 100) % 100) return p.era + y + "年" + m + "月は、ありません";
    }
    if (m !== null && d !== null) {
      const maxd = gy !== null ? new Date(gy, m, 0).getDate() : [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];   // うるう年も判定
      if (d > maxd) return m + "月" + d + "日は、ありません";
    }
    if (gy !== null && m !== null && d !== null) {
      const iso = gy * 10000 + m * 100 + d;
      if ((p.era !== "明治" && iso < def.start) || iso > def.end) return p.era + y + "年" + m + "月" + d + "日は、ありません";
    }
    return "";
  }
  //   日付がそろったあとで確かめる規則（opt.notFuture … 未来は不可／opt.minToday … 今日より前は不可（申請日）
  //   ／opt.notBefore・opt.notAfter … この日付より前・後は不可（出生と死亡の前後）。parseJa の結果）
  //   time は、時間の規則（入力欄を離れたときに、前の日付へ戻す）、rel は、ほかの日付との前後（赤字で知らせる）
  function softJaProblem(p, opt) {
    opt = opt || {};
    const out = { time: "", rel: "" };
    if (p.y === null) return out;
    const gy = ERA_DEF[p.era].base + p.y, m = p.m, d = p.d;
    const now = new Date(), ty = now.getFullYear(), tm = now.getMonth() + 1, td = now.getDate();
    if (opt.notFuture && (gy > ty || (gy === ty && m !== null && (m > tm || (m === tm && d !== null && d > td))))) out.time = "未来の日付は入力できません";
    if (!out.time && opt.minToday && (gy < ty || (gy === ty && m !== null && (m < tm || (m === tm && d !== null && d < td))))) out.time = "過去の日付では申請できません。今日以降の日付にしてください";
    const me = { era: p.era, y: p.y, m, d };
    if (opt.notBefore) { const c = compareJa(me, opt.notBefore); if (c !== null && c < 0) out.rel = "出生年月日より前の日付になっています"; }
    if (opt.notAfter) { const c = compareJa(me, opt.notAfter); if (c !== null && c > 0) out.rel = "死亡年月日より後の日付になっています"; }
    return out;
  }
  function checkJaDate(p, opt) {
    const h = hardJaProblem(p);
    if (h) return h;
    const s2 = softJaProblem(p, opt);
    return s2.time || s2.rel;
  }
  const EraDate = {
    props: {
      modelValue: { type: String, default: "" },
      kind: { type: String, default: "any" },            // birth（出生）／death（死亡）／any
      notBefore: { type: String, default: "" },          // この日付より前は赤字で知らせる（死亡は、出生より前にできない）
      notAfter: { type: String, default: "" },           // この日付より後は赤字で知らせる（出生は、死亡より後にできない）
      fixedEra: { type: String, default: "" },           // 元号を固定する（令和のみ、など）
      minToday: { type: Boolean, default: false },       // 今日より前は不可（申請日）
      copyable: { type: Boolean, default: false }        // 「他の日付にコピー」ボタンを付ける
    },
    emits: ["update:modelValue", "copy", "complete"],
    data() { return { err: "", lastValid: this.modelValue }; },
    computed: {
      parts() {
        const p = parseJa(this.modelValue);
        const str = (x) => (x === null || x === undefined ? "" : String(x));
        if (p) return { era: this.fixedEra || p.era, y: str(p.y), m: str(p.m), d: str(p.d) };
        return { era: this.fixedEra || (this.kind === "death" ? "令和" : "昭和"), y: "", m: "", d: "" };
      },
      eras() { return this.fixedEra ? [this.fixedEra] : ERA_ORDER; },
      complete() { return this.parts.y !== "" && this.parts.m !== "" && this.parts.d !== ""; },
      // 年月日がそろったときの、規則違反（未来・過去・出生と死亡の前後）
      soft() {
        if (!this.complete) return { time: "", rel: "" };
        return softJaProblem(this.nums(this.parts), this.opts());
      },
      warn() { return this.soft.time || this.soft.rel; }
    },
    watch: {
      modelValue(v) { const q = parseJa(v); if (!q || !softJaProblem(q, this.opts()).time) this.lastValid = v; }
    },
    methods: {
      num(v) { return v === "" || v == null ? null : parseInt(v, 10); },
      nums(p) { return { era: p.era, y: this.num(p.y), m: this.num(p.m), d: this.num(p.d) }; },
      opts() {
        return { notFuture: this.kind === "birth" || this.kind === "death", minToday: this.minToday, notBefore: parseJa(this.notBefore), notAfter: parseJa(this.notAfter) };
      },
      change(key, value) {
        const next = Object.assign({}, this.parts, { [key]: value });
        const e = hardJaProblem(this.nums(next));            // 暦のうえでありえない日付は、入力を受け付けない
        if (e) { this.err = e; return false; }
        this.err = "";
        const out = composeJa(this.nums(next));
        this.$emit("update:modelValue", out);
        if (next.y !== "" && next.m !== "" && next.d !== "") this.$emit("complete", out);
        return true;
      },
      onNum(key, ev) {
        const clean = toHalf(ev.target.value).replace(/[^0-9]/g, "").slice(0, 2);
        if (!this.change(key, clean)) ev.target.value = this.parts[key];
        else if (ev.target.value !== clean) ev.target.value = clean;
      },
      onEra(ev) { if (!this.change("era", ev.target.value)) ev.target.value = this.parts.era; },
      // 入力欄から離れたとき、未来の日付・過去の申請日なら、前の日付に戻す（入力中は、1文字目で拒否しないよう、ここで判定する）
      onFocusOut(ev) {
        if (ev && ev.relatedTarget && this.$el.contains(ev.relatedTarget)) return;
        const t = softJaProblem(this.nums(this.parts), this.opts()).time;     // 年月日がそろっていなくても、年や月だけで過去・未来と分かるものは対象
        if (t) {
          this.err = t + "（元の日付に戻しました）";
          this.$emit("update:modelValue", this.lastValid && this.lastValid !== this.modelValue ? this.lastValid : composeJa({ era: this.parts.era, y: null, m: null, d: null }));
        } else if (!this.warn) this.err = "";
      }
    },
    template: `<span class="era-date date-input" :class="{ 'ed-copyable': copyable }" @focusout="onFocusOut">
      <span class="ed-row">
        <select v-if="eras.length > 1" class="ed-era" :value="parts.era" @change="onEra" aria-label="元号"><option v-for="e in eras" :key="e" :value="e">{{ e }}</option></select>
        <span v-else class="di-era">{{ parts.era }}</span>
        <input class="di-num" type="text" inputmode="numeric" maxlength="2" :value="parts.y" @input="onNum('y', $event)" aria-label="年">年
        <input class="di-num" type="text" inputmode="numeric" maxlength="2" :value="parts.m" @input="onNum('m', $event)" aria-label="月">月
        <input class="di-num" type="text" inputmode="numeric" maxlength="2" :value="parts.d" @input="onNum('d', $event)" placeholder="日" aria-label="日">日
        <button v-if="copyable" class="btn btn-outline btn-sm di-copy" type="button" @click="$emit('copy', modelValue)" title="この日付を、他の書類の日付欄にもコピーします">他の日付にコピー</button>
      </span>
      <span v-if="err || warn" class="ed-err" role="alert">{{ err || warn }}</span>
    </span>`
  };
  // 書類の日付欄（令和のみ。「他の日付にコピー」つき）
  // ------------------------------------------------------------
  // 住所の入力欄。郵便番号を入れると、都道府県・市区町村・字名が入る（js/addressTools.js）。
  // 一度入力した住所があれば、「複写」のチェックで、入力欄が、以前に入力した住所を選ぶプルダウンに変わる
  // （選ぶと、入力欄に戻って、その住所が入る。丁目・番地を直せる）。郵便番号は、住所を作るためだけの入力で、保存しない。
  // ------------------------------------------------------------
  const AddressInput = {
    props: {
      modelValue: { type: String, default: "" },
      tip: { type: String, default: "" }              // 注意書き（data-tip）の種類。住所には "addr"
    },
    emits: ["update:modelValue"],
    inject: { known: { from: "knownAddresses", default: null } },
    data() { return { postal: "", copying: false }; },
    computed: {
      // 以前に入力した住所（いま入っている住所は除く）
      choices() {
        const k = this.known && (Array.isArray(this.known) ? this.known : this.known.value);
        return (k || []).filter((a) => a && a !== this.modelValue);
      }
    },
    watch: { choices(v) { if (!v.length) this.copying = false; } },
    methods: {
      onPostal(ev) {
        const O = window.AppModules.Offices;
        this.postal = O.formatPostal(ev.target.value);
        ev.target.value = this.postal;
        const next = window.AppModules.AddressTools.fillFromPostal(this.modelValue, this.postal);
        if (next !== this.modelValue) this.$emit("update:modelValue", next);
      },
      onPick(ev) {
        const v = ev.target.value;
        if (v) { this.$emit("update:modelValue", v); this.copying = false; }
      }
    },
    template: `<div class="addr-input">
      <input class="addr-postal postal-input" type="text" inputmode="numeric" maxlength="8" placeholder="郵便番号" :value="postal" @input="onPostal" aria-label="郵便番号">
      <input v-if="!copying" class="addr-text" type="text" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" :data-tip="tip || null" aria-label="住所">
      <select v-else class="addr-select" @change="onPick" aria-label="以前に入力した住所から選ぶ">
        <option value="">（以前に入力した住所から選ぶ）</option>
        <option v-for="a in choices" :key="a" :value="a">{{ a }}</option>
      </select>
      <label v-if="choices.length" class="chk addr-copy" title="以前に入力した住所から選びます"><input type="checkbox" v-model="copying"><span>複写</span></label>
    </div>`
  };
  // ------------------------------------------------------------
  // 登記所の欄。住所（所在）の市区町村から、管轄の登記所を決める。
  //   1つに決まる  → 登記所の名前だけを表示する（プルダウンは出さない。住所を変えたら、自動で替わる）
  //   2つ以上にまたがる → 候補のボタンを出す。地番（大字・町名）で決まるので、管轄区域一覧のリンクを付け、利用者が調べて選ぶ
  //   決まらない（市区町村が未入力など） → 手で選ぶ。都道府県の法務局が1つだけなら、本局・支局・出張所のプルダウンだけ
  // ------------------------------------------------------------
  const OfficePicker = {
    props: {
      modelValue: { type: String, default: "" },
      address: { type: String, default: "" }          // 管轄を調べる住所（所在・本籍・住所）
    },
    emits: ["update:modelValue"],
    data() { return { bureauSel: window.AppModules.Offices.bureauOfOffice(this.modelValue), lastAuto: "" }; },
    computed: {
      O() { return window.AppModules.Offices; },
      pref() { return this.O.detectPref(this.address); },
      match() { return this.pref ? this.O.findOffices(this.pref, this.address) : { state: "none", offices: [], municipality: "" }; },
      // 住所の都道府県の法務局を、先頭に出す
      nearBureaus() { return this.pref ? this.O.bureausOf(this.pref) : []; },
      offices() { return this.bureauSel ? this.O.officesOf(this.bureauSel) : []; },
      // 管轄区域一覧のリンク（またがる登記所の法務局ごと。局のページが分からなければ、法務局のホームページ）
      links() {
        const names = [];
        const add = (b) => { if (b && names.indexOf(b) < 0) names.push(b); };
        if (this.match.state === "ambiguous") this.match.offices.forEach((o) => add(this.O.bureauOfOffice(o)));
        else if (this.bureauSel) add(this.bureauSel);
        else if (this.nearBureaus.length === 1) add(this.nearBureaus[0][0]);
        if (!names.length) return [{ text: "法務局のホームページ（管轄区域の一覧）", url: this.O.kankatsuUrl("") }];
        return names.map((b) => ({ text: b + "の管轄区域一覧", url: this.O.kankatsuUrl(b) }));
      },
      // 選ばれている登記所が、住所の都道府県のものでないとき
      warn() {
        if (this.pref && this.modelValue && !/〇/.test(this.modelValue) && this.match.state !== "unique") {
          const b = this.O.bureauOfOffice(this.modelValue);
          if (b && !this.nearBureaus.some((x) => x[0] === b)) return "「" + this.modelValue + "」は、" + this.pref + "の登記所ではありません";
        }
        return "";
      },
      // 手で選ぶときに、法務局のプルダウンが要るか（都道府県の法務局が1つに決まっていれば、要らない）
      needBureau() { return this.nearBureaus.length !== 1; }
    },
    watch: {
      address() { this.auto(); },
      modelValue(v) { const b = this.O.bureauOfOffice(v); if (b) this.bureauSel = b; }
    },
    mounted() { this.auto(); },
    methods: {
      blank(v) { return !String(v || "").trim() || /〇/.test(v); },
      set(v, auto) { this.lastAuto = auto ? v : ""; if (v !== this.modelValue) this.$emit("update:modelValue", v); },
      auto() {
        const m = this.match, cur = this.modelValue;
        if (m.state === "unique") {
          // 管轄は決まっているので、別の不動産の登記所などが残っていても、住所の管轄に合わせる
          const target = m.offices[0];
          this.bureauSel = this.O.bureauOfOffice(target);
          this.set(target, true);
        } else if (m.state === "ambiguous") {
          // 候補にない登記所（見本のまま、別の不動産の登記所、前の住所の登記所）は外し、候補から選んでもらう
          if (cur && !m.offices.includes(cur)) this.set("", false);
          this.bureauSel = this.O.bureauOfOffice(m.offices[0]);
        } else {
          // 自動で入れた登記所が、住所を変えて合わなくなったら外す。見本のままの登記所も外す
          if (cur && ((this.lastAuto && cur === this.lastAuto) || /〇/.test(cur))) this.set("", false);
          if (this.pref && this.nearBureaus.length === 1) this.bureauSel = this.nearBureaus[0][0];
        }
      },
      label(o) { const a = o.areas.length > 30 ? o.areas.slice(0, 30) + "…" : o.areas; return o.label + "（" + a + "）"; },
      onBureau(ev) {
        this.bureauSel = ev.target.value;
        const list = this.offices;
        if (list.length === 1) this.set(list[0].name, false);
        else if (this.modelValue && this.O.bureauOfOffice(this.modelValue) !== this.bureauSel) this.set("", false);
      },
      onOffice(ev) { this.set(ev.target.value, false); },
      choose(name) { this.set(name, false); }
    },
    template: `<div class="office-picker">
      <template v-if="match.state === 'unique'">
        <div class="op-result">{{ match.offices[0] }}</div>
        <div class="op-hint">「{{ match.municipality }}」の管轄（所在を変えると、自動で替わります）</div>
      </template>
      <template v-else-if="match.state === 'ambiguous'">
        <div class="op-cands"><button v-for="n in match.offices" :key="n" type="button" class="op-cand" :class="{ on: n === modelValue }" @click="choose(n)">{{ n }}</button></div>
        <div class="op-hint">「{{ match.municipality }}」は、複数の登記所にまたがっています。どちらになるかは、地番（大字・町名）で決まります。
          <template v-for="(l, i) in links" :key="l.url"><template v-if="i">、</template><a :href="l.url" target="_blank" rel="noopener noreferrer">{{ l.text }}</a></template>
          で、この不動産の所在がどの登記所の区域に入っているかを確認して、上から選んでください。</div>
      </template>
      <template v-else>
        <div class="op-row">
          <select v-if="needBureau" class="op-bureau" :value="bureauSel" @change="onBureau" aria-label="法務局・地方法務局">
            <option value="">法務局・地方法務局</option>
            <optgroup v-if="nearBureaus.length" label="住所の都道府県">
              <option v-for="b in nearBureaus" :key="'n' + b[0]" :value="b[0]">{{ b[0] }}</option>
            </optgroup>
            <optgroup v-for="r in O.REGIONS" :key="r.name" :label="r.name">
              <template v-for="p in r.prefs" :key="p"><option v-for="b in O.bureausOf(p)" :key="b[0]" :value="b[0]">{{ b[0] }}（{{ p }}）</option></template>
            </optgroup>
          </select>
          <select class="op-office" :value="modelValue" @change="onOffice" :disabled="!bureauSel" aria-label="本局・支局・出張所">
            <option value="">{{ needBureau ? '本局・支局・出張所' : (bureauSel || '') + ' の本局・支局・出張所' }}</option>
            <option v-for="o in offices" :key="o.name" :value="o.name" :title="o.areas">{{ label(o) }}</option>
          </select>
        </div>
        <div class="op-hint">{{ pref && O.afterPref(address).trim() ? '市区町村から、管轄の登記所を判定できません。' : '所在の市区町村を入力すると、管轄の登記所が自動で入ります。' }}
          <template v-for="(l, i) in links" :key="l.url"><template v-if="i">、</template><a :href="l.url" target="_blank" rel="noopener noreferrer">{{ l.text }}</a></template></div>
      </template>
      <div v-if="warn" class="op-hint op-warn">{{ warn }}</div>
    </div>`
  };
  const DateInput = Object.assign({}, EraDate, {
    props: Object.assign({}, EraDate.props, { fixedEra: { type: String, default: "令和" }, copyable: { type: Boolean, default: true } })
  });

  const app = createApp({
    setup() {
      const currentView = ref("input");
      const showDemoSelector = ref(false);
      const expandedSpouse = ref(false);
      const expandedChildren = ref([]);
      const expandedSiblings = ref([]);
      const expandedParents = ref([]);
      const expandedSubstitutes = ref([]);

      const deceased = ref({
        name: "法務太郎",
        birth: "昭和〇年〇月〇日",
        death: "令和〇年〇月〇日",
        lastAddr: "〇県〇市〇町〇番地",
        lastHoseki: "〇県〇市〇町〇番地"
      });

      // 配偶者は常に1人なので、id は固定値 "spouse"。
      // 相続パターン（successorPatterns）が人物を id で参照するため必要。
      const spouse = ref({
        id: "spouse",
        role: "（妻）",
        name: "法務花子",
        birth: "昭和〇年〇月〇日",
        addr: "〇県〇市〇町〇番地",
        isApplicant: false,
        isCreator: false
      });

      const children = ref([]);
      const siblings = ref([]);
      const parents = ref([]);
      const creator = ref({
        date: "令和〇年〇月〇日",
        isAgentMode: false,
        agentAddr: "〇県〇市〇町〇番地",
        agentName: "〇〇〇〇",
        agentPick: ""                  // 代理人: "" 未選択 | 相続人のid（入力済みの氏名から選んだ） | "other" それ以外の人（自分で入力）
      });

      // 表示中の書類種別: "ichiranzu"(法定相続情報一覧図) |
      // "setsumeizu"(相続関係説明図) | "moshidesho"(申出書) | "ininjo"(委任状)
      const docType = ref("ichiranzu");

      // 法定相続情報一覧図・相続関係説明図は、相続人が多いと複数ページに分かれる
      // ことがある（法務局の「子が多数であり複数枚にわたる場合」の
      // 実例に準拠）。currentPageは0始まり。
      // renderedPagesはreactiveにしておき、v-forで全ページ分のsvgを
      // DOMに保持する（画面には現在ページのみ表示し、印刷時のみ
      // CSSで全ページを表示することで、複数ページとも印刷できる）。
      const currentPage = ref(0);
      const renderedPages = ref([]);
      const totalPages = computed(() => renderedPages.value.length);

      // 申出書・委任状専用の追加情報。家系図(法定相続情報一覧図)には出てこない項目。
      const filing = ref({
        applicationDate: "令和〇年〇月〇日",
        applicantContact: "090-〇〇〇〇-〇〇〇〇",
        purposeRealEstate: false,
        purposeBankAccount: false,
        purposeTax: false,
        purposePension: false,
        purposeOtherChecked: false,
        purposeOtherText: "",
        copies: "1",
        deliveryMethod: "window", // "window" | "mail"
        hasRealEstate: false,
        realEstateInfo: "",
        officeBasis: "applicantAddress", // "honseki" | "lastAddress" | "applicantAddress" | "realEstate"
        officeName: "",
        agentOffice: "",
        agentRelation: "delegate", // "legal" | "delegate"
        delegationMatter: "法定相続情報一覧図の保管及び交付の申出並びに法定相続情報一覧図の写しの受領に関する一切の件",
        delegationDate: "令和〇年〇月〇日"
      });

      // 非嫡出子の生母・半血兄弟姉妹のもう一方の親の氏名。
      // 法定相続情報一覧図では常に「（女）」「〔女２〕」等の続柄
      // のみで表示され、この氏名は使われない（法定相続情報一覧図に特有の制約）。
      // 相続関係説明図では、入力されていればその氏名を表示する。
      // illegitimateMothers: 非嫡出子の母の一覧。母が異なる子を図でまとめ分ける
      // ために複数持てる（各子の motherId がどの母の子かを指す）。
      // illegitimateMotherName は旧形式（母が1人だけ）の保存ファイル用。
      const extraRelations = ref({
        illegitimateMotherName: "",
        fatherOtherPartnerName: "",
        motherOtherPartnerName: "",
        illegitimateMothers: [{ id: "mother1", name: "" }]
      });

      // ------------------------------------------------------------
      // 登記申請書（オプション）
      // ------------------------------------------------------------
      // 不動産ごとに「どの相続パターン（取得者・持分）か」と「管轄登記所」を
      // 持たせ、(相続パターン × 管轄登記所) ごとに1通の登記申請書を作る。
      // 管轄が違えば登記申請書は別になり、取得者や持分が違う不動産も別の
      // 申請になるため。持分は相続パターン側(pattern.shares)に持つ。
      const registration = ref({
        enabled: false,
        applicationDate: "令和〇年〇月〇日",
        contact: "090-〇〇〇〇-〇〇〇〇",
        lawNumber: "",
        applyExemption: true,
        omitDetailsWithNumber: false,   // 不動産番号を記載して所在等を省略する
        noIdentifier: false,            // 登記識別情報の通知を希望しない
        useNationality: true,           // 国籍等の記載（法務省の見本は令和8年10月5日付で追加）
        applicants: {},                 // 申請人ごとの追加情報 人物id → { kana, email, nationality, juminCode, 法定代理人 }
        addrChanges: {},                // 共有者である相続人の住所変更・更正 人物id → { kind: "change"|"correct", moveDate, cause }
        // 登記申請を代理人（司法書士など）に依頼する場合の代理人。
        // 法定相続情報一覧図の申出人・代理人（creator）とは別の人でありうるため、独立して持つ。
        agent: { enabled: false, name: "", address: "", pick: "" },
        delegationDate: "令和〇年〇月〇日",   // 登記申請用の委任状の日付
        properties: []
      });

      // ------------------------------------------------------------
      // 作成する書類の選択
      // ------------------------------------------------------------
      //   法定相続情報一覧図 ─ 申出書 ─ 委任状（代理人が手続する場合）
      //   相続関係説明図 ─ 遺産分割協議書（全員が相続人とならない場合のみ）
      //   登記申請書
      // 申出書は法定相続情報一覧図に、委任状は申出書に、遺産分割協議書は相続関係説明図にぶら下がる。
      const docs = ref({
        ichiranzu: true, moshidesho: true, ininjo: false,
        setsumeizu: true, kyogisho: false, toki: false,
        toukiIninjo: false,         // 登記申請書の下にぶら下がる委任状（代理人に依頼する場合）
        jusho: false,               // 登記申請書の下にぶら下がる、共有者である相続人の住所変更（更正）登記申請書
        setsumeizuCopies: 1,        // 相続関係説明図を、1パターンにつき何通印刷するか
        kyogishoCopies: 1           // 遺産分割協議書を、何通印刷するか
      });
      // 遺産分割協議書の入力。分割する不動産は登記申請書の不動産
      // （registration.properties）と同じものを使う。
      // 被相続人（手続）の一覧。画面に開いている手続のデータは入力欄にあり、
      // 他の手続のデータは cases[].data に退避されている。
      const cases = ref([{ id: "case1", data: null }]);
      const activeCaseId = ref("case1");
      const agreement = ref({
        date: "令和〇年〇月〇日",
        otherAssets: "",
        futureHeirId: ""
      });

      // ------------------------------------------------------------
      // 相続人の住所に関する注意ポップアップ（今後表示しない設定付き）
      // ------------------------------------------------------------
      // ホバー表示の注意書き。data-tip="キー" を付けた要素（入力欄・押印欄など）に
      // カーソルを重ねる（またはフォーカスする）と、その下に表示する。
      // 内容は法務局の記載例・案内に基づく。各注意書きは「今後表示しない」にできる。
      const TIPS = {
        addr: {
          title: "相続人の住所を法定相続情報一覧図に記載する場合の注意", need: "ichiranzu",
          items: [
            "法定相続情報一覧図に相続人の住所を記載するかどうかは任意です。記載する場合は、申出書に<strong>その住所を証する書面（住民票の写し等）の添付が必要</strong>です。",
            "記載しておくと、相続登記などの後続の手続で、相続人の住民票の提出が不要になることがあります。",
            "法定相続情報一覧図の写しの交付を受けた後は、住所が変わっても再申出はできません。"
          ]
        },
        date_ichiranzu: {
          title: "法定相続情報一覧図の作成日・作成者",
          items: [
            "作成日は、法定相続情報一覧図を作成した日付を記載します。",
            "作成者は申出人本人または代理人です。作成者は<strong>記名のみで、押印は不要</strong>です。資格者代理人が作成する場合は、氏名の下に事務所の住所を併記する例があります。"
          ]
        },
        date_moshidesho: { title: "申出年月日", items: ["法務局へ申出をする日付を記載します。"] },
        date_ininjo: { title: "委任状の日付", items: ["委任した日付を記載します。申出の日より前（または同日）の日付になります。"] },
        date_toki: {
          title: "申請年月日",
          items: [
            "登記所に登記申請書を提出する日付を記載します。",
            "相続登記は、相続で不動産を取得したことを知った日から3年以内に申請します（遺産分割が成立したときは、成立した日から3年以内）。"
          ]
        },
        date_kyogisho: {
          title: "遺産分割協議書の日付",
          items: ["協議が成立した日付を記載します。"]
        },
        seal_moshidesho: { title: "申出書・法定相続情報一覧図の押印（不要）", items: ["令和3年4月1日から、<strong>申出書への押印は不要</strong>です（記名は必要です）。代理人が申し出る場合の代理人も同じです。", "法定相続情報一覧図の作成者も、<strong>記名のみで、押印は不要</strong>です。", "押印しても、差し支えはありません。"] },
        hoseki: { title: "最後の本籍の記載", items: ["最後の本籍の記載は、申出人の任意です。", "ただし、住民票の除票等が市区町村において廃棄されている場合は、<strong>被相続人の最後の住所の記載に代えて、最後の本籍を必ず記載</strong>します（法務省の見本）。"] },
        seal_ininjo: { title: "委任状の押印", items: ["法務局の見本では、委任者の氏名の横に押印します。"] },
        seal_toki: {
          title: "登記申請書の押印",
          items: [
            "申請人が押印します。<strong>認印で差し支えありません</strong>（法務局の記載例）。",
            "一部の相続人だけが申請すると、申請人にならない相続人には登記識別情報が通知されません。全員に通知したい場合は、全員を申請人にしてください。"
          ]
        },
        keiin: {
          title: "契印（つづり目の押印）",
          items: [
            "登記申請書が複数枚になる場合は、各用紙のつづり目に、申請人（またはその代理人）が契印します。申請人が2人以上のときは、そのうちの1人で足ります。",
            "登録免許税の収入印紙を貼った用紙も、登記申請書と一緒につづって契印します（収入印紙に割印や消印はしません）。"
          ]
        },
        seal_kyogisho: {
          title: "遺産分割協議書の押印",
          items: [
            "相続人全員が署名し、<strong>実印</strong>を押します（法務局の記載例）。",
            "相続登記に使う場合は、相続人全員の印鑑証明書も添付するのが一般的です。"
          ]
        }
      };
      // 添付書類・免税・法定代理人についての注意書き（法務局の案内・記載例に基づく）
      Object.assign(TIPS, {
        att_genin: {
          title: "登記原因証明情報（戸籍謄本等）の有効期間と原本還付",
          items: [
            "被相続人の死亡が分かる戸籍（除籍）謄本と、相続人であることが分かる相続人の戸籍謄本を添付します。<strong>被相続人が死亡した日以後に証明されたもの</strong>が必要です（法務局）。",
            "戸籍謄本そのものに「発行後○か月以内」といった有効期限は定められていません（一般的な取扱い）。",
            "戸籍謄本・除籍謄本は、<strong>相続関係説明図を提出すれば原本還付を請求できます</strong>（法務局）。",
            "遺産分割協議書も原本還付を請求できます。原本のコピーに「原本に相違ありません」と記載し、登記申請書に押印した人が署名（記名）押印して、原本と一緒に提出します。<strong>請求しないと、登記完了後は返却されません。</strong>",
            "登記申請のためだけに作成した書類（登記申請用の委任状など）や印鑑証明書は、原本還付できません（法務局）。",
            "法定相続情報番号を登記申請書に記載するか、法定相続情報一覧図の写しを提出すれば、戸籍謄本等の添付に代えられます。"
          ]
        },
        att_jusho: {
          title: "住所証明情報（住民票の写し）の有効期間と原本還付",
          items: [
            "申請に係る不動産を取得する相続人の住民票の写しです。<strong>マイナンバー（個人番号）が記載されていないもの</strong>を提出します（法務局）。",
            "登記申請書に住民票コードを記載すれば、その人の住民票の写しの提出を省略できます。<strong>住民票コードは、申請人ごとに記載できます</strong>。自分の分だけ書いた場合は、自分の住民票の写しを省略でき、書いていない人の分は提出が必要です。",
            "法定相続情報一覧図の写しに相続人の現在の住所が記載されている場合は、住所証明書の添付に代えられます。",
            "住民票の写しは原本還付を請求できます（コピーに「原本に相違ありません」と記載し、登記申請書に押印した人が署名（記名）押印して提出）。",
            "相続登記では、住民票の写しに「発行後○か月以内」といった有効期限は一般に設けられていません。念のため管轄の法務局で確認してください。"
          ]
        },
        att_kokuseki: {
          title: "国籍等を証する情報",
          items: [
            "日本国籍の相続人は、相続人であることを示すために提出する戸籍謄本（抄本）や法定相続情報一覧図の写しで国籍等を確認できるため、通常は別の書類を用意する必要はありません。",
            "外国籍の相続人は、国籍の記載がある住民票の写しや旅券などが必要です。",
            "「国籍等」の欄は、法務省の記載例（令和8年10月5日付）で追加された項目です。"
          ]
        },
        att_dairi: {
          title: "代理権限証明情報（委任状など）",
          items: [
            "委任状は登記申請のためだけに作成する書類のため、<strong>原本還付はできません</strong>（法務局）。",
            "委任者の印は認印で足ります（法務局の記載例）。",
            "未成年者・成年被後見人などの法定代理人が申請する場合は、その資格を証する書面（親権者は戸籍謄本、成年後見人は後見登記の登記事項証明書、特別代理人は選任審判書の謄本など）を添付します。"
          ]
        },
        att_hyoka: {
          title: "課税価格と固定資産評価証明書",
          items: [
            "課税価格は、不動産の価額（固定資産課税台帳に登録された価格）で計算し、1,000円未満は切り捨てます。",
            "評価証明書（または固定資産税の課税明細書）は、申請時点で最新の年度のものを取得してください。",
            "複数の不動産がある場合は、すべての評価額を合計してから1,000円未満を切り捨てます。共有持分を移転する場合は、移転する持分の価額です。"
          ]
        },
        att_moshide: {
          title: "申出書の添付書類と原本の返却",
          items: [
            "提出した戸籍謄本等は、法定相続情報一覧図の写しを受け取る際に返却されます（法務局の手続案内）。",
            "相続人の住所を法定相続情報一覧図に記載する場合は、その住所を証する書面（住民票の写し等）が必要です。",
            "法定相続情報一覧図の写しは、保管期間（5年間）中は再交付を受けられます。"
          ]
        },
        tax_exempt: {
          title: "登録免許税の免税の要件（租税特別措置法第84条の2の3第2項）",
          items: [
            "<strong>土地</strong>について、相続（相続人への遺贈を含む）による所有権の移転登記を受ける場合で、<strong>不動産の価額が100万円以下</strong>であること。建物・区分建物は対象外です。",
            "100万円以下かどうかは、<strong>登録免許税の課税価格（固定資産税評価額の1,000円未満を切り捨てた額）</strong>で判定しています（例：評価額1,000,900円 → 課税価格1,000,000円 → 免税）。",
            "適用期限は<strong>令和9年3月31日</strong>までです（令和7年度の税制改正で延長）。",
            "登記申請書に「租税特別措置法第84条の2の3第2項により非課税」と記載しないと適用されません。免除の場合、課税価格の記載は不要です（法務局）。",
            "共有持分の場合の判定は、移転する持分の価額で計算しています。判断に迷う場合は管轄の法務局に確認してください。",
            "このほか、相続した土地の登記をしないまま亡くなった場合の免税（同条第1項）もありますが、本ツールは数次相続に未対応のため自動計算していません。"
          ]
        },
        legal_minor: {
          title: "相続人が未成年者（18歳未満）の場合",
          items: [
            "未成年者も相続人として登記名義人になれます。申請は、親権者などの法定代理人が、本人に代わって行います。",
            "法定相続分どおりに登記する場合は、親権者が代理して差し支えありません。",
            "遺産分割協議で、親権者と未成年者がともに相続人になるときは、家庭裁判所で<strong>特別代理人</strong>を選任します（未成年者が2人以上いるときは、それぞれに別の特別代理人）。",
            "親権者が相続人でない場合（代襲相続など）や、遺言どおりに登記する場合は、特別代理人は不要です。",
            "書き方に迷うときは、管轄の法務局で確認できます。"
          ]
        },
        legal_ward: {
          title: "相続人が成年被後見人などの場合",
          items: [
            "成年被後見人に代わって、<strong>成年後見人</strong>が申請・協議をします。",
            "成年後見人と成年被後見人がともに相続人となる遺産分割協議では、特別代理人（成年後見監督人がいる場合はその人）が必要です。",
            "後見登記の登記事項証明書などを、代理権限を証する書面として添付します。",
            "被保佐人・被補助人の場合は、保佐人・補助人の同意が必要になることがあります（本ツールでは自動記載しません）。"
          ]
        },
        legal_rep_kyogisho: {
          title: "法定代理人の署名押印（遺産分割協議書）",
          items: [
            "未成年者・成年被後見人に代わって、法定代理人が署名押印します。",
            "親権者（成年後見人）と本人がともに相続人の協議では、親権者（成年後見人）は代理できません。家庭裁判所が選任した特別代理人が署名押印し、選任審判書の謄本と特別代理人の印鑑証明書も添付します。"
          ]
        }
      });
      Object.assign(TIPS, {
        seal_toki_agent: {
          title: "代理人が申請する場合の押印",
          items: [
            "代理人が申請する場合は、申請人ではなく<strong>代理人の氏名の後に押印</strong>します（法務局のチェックリスト）。",
            "原本還付の謄本への署名押印や契印は、登記申請書に押印した人が行います。"
          ]
        },
        seal_toki_ininjo: {
          title: "登記申請の委任状の押印",
          items: [
            "委任者（申請人）の印は<strong>認印で結構</strong>です（法務局の記載例）。",
            "委任者となるのは登記の申請人です。法定代理人が代わって委任する場合は、法定代理人が押印します。",
            "委任状は登記申請のためだけに作成する書類のため、原本還付はできません。"
          ]
        },
        date_toki_ininjo: {
          title: "登記申請の委任状の日付",
          items: ["委任した日付を記載します。登記の申請日より前（または同日）の日付になります。"]
        }
      });
      Object.assign(TIPS, {
        assessed_value: {
          title: "固定資産税評価額と課税標準（課税価格）は別のもの",
          items: [
            "ここに入力するのは、評価証明書（または固定資産税の課税明細書）に記載された、<strong>不動産全体の価額（評価額）</strong>です。",
            "被相続人が共有持分の場合で、市区町村が<strong>共有持分ごとの価格</strong>を出しているときは、「評価証明書に載っている価格は」で「被相続人の持分だけの価額」を選び、その価額をそのまま入力します（持分は掛けません）。",
            "登録免許税の<strong>課税標準（課税価格）ではありません</strong>。課税価格は、この評価額から自動で計算されます（共有持分の場合は持分を掛け、複数の不動産は合計して1,000円未満を切り捨て）。",
            "評価証明書に「価格（評価額）」と「課税標準額」の両方が載っている場合は、「価格（評価額）」を入力してください。住宅用地の特例などで減額された「課税標準額」ではありません。"
          ]
        }
      });
      // テーマごとの「一般論」と、例外の注意書き（注意書きの一覧に出す。ホバーでは使わない）
      Object.assign(TIPS, {
        seal_general: {
          title: "押印の一般論",
          items: [
            "法務局に出す書類は、申請する人が記名して押印するのが基本です。<strong>認印で差し支えありません</strong>（法務局の記載例）。",
            "申出書と法定相続情報一覧図は、記名のみで、押印は不要です。実印を押して印鑑証明書を付けるのは、遺産分割協議書です。",
            "不安なときは、提出先の法務局の窓口や電話で、確認できます。"
          ]
        },
        date_general: {
          title: "日付の一般論",
          items: [
            "日付は、その書類を作った日（提出する日）を書けば足ります。迷うときは、提出する日に合わせてください。",
            "登記申請書の「登記所の表示」や「申請年月日」を書き間違えても、補正（直しの求め）の対象にならない取扱いです（不動産登記事務取扱手続準則）。気にしすぎなくて大丈夫です。",
            "日付に決まりがあるのは、委任状（提出日より前か同日）と、遺産分割協議書（協議が成立した日）です。"
          ]
        },
        office_general: {
          title: "提出先の一般論",
          items: [
            "登記申請書の提出先は、<strong>不動産の所在地を管轄する登記所</strong>です。所在の市区町村を入れると、管轄の登記所が自動で入ります。",
            "法定相続情報一覧図の申出先は、被相続人の本籍地・最後の住所地、申出人の住所地、被相続人名義の不動産の所在地のいずれかを管轄する登記所です。",
            "登記所の表示を書き間違えても、補正の対象にならない取扱いです（不動産登記事務取扱手続準則）。"
          ]
        },
        office_split: {
          title: "市区町村が複数の登記所にまたがる場合",
          items: [
            "市区町村の一部だけが、別の登記所（支局・出張所）の管轄になっている地域があります（成田市・下呂市・松山市・若狭町・新潟市北区など）。",
            "この場合は、地番（大字・町名）で決まります。画面の候補のボタンと、<a href=\"https://houmukyoku.moj.go.jp/\" target=\"_blank\" rel=\"noopener noreferrer\">法務局のホームページ</a>の管轄区域一覧で確認して、選んでください。分からないときは、法務局に電話で聞けば教えてもらえます。"
          ]
        },
        office_multi: {
          title: "不動産が複数の登記所にまたがる場合",
          items: [
            "不動産が別々の登記所の管轄にあるときは、登記所ごとに登記申請書を作ります。このプログラムは、管轄の登記所ごとに、登記申請書を分けます。"
          ]
        },
        att_general: {
          title: "添付書類の一般論",
          items: [
            "相続登記には、被相続人と相続人の戸籍謄本（法定相続情報一覧図の写しで代えられます）、相続人の住民票の写しを添付します。遺産分割協議書を使うときは、印鑑証明書も付けます。",
            "戸籍謄本・住民票の写し・遺産分割協議書は、コピーを付けて請求すれば、<strong>原本を返してもらえます</strong>（原本還付）。",
            "個別の書類の注意は、下の区分に書いています。必要なものだけ読めば足ります。"
          ]
        },
        tax_general: {
          title: "登録免許税の一般論",
          items: [
            "相続による所有権の移転登記の登録免許税は、不動産の価額（課税価格）の<strong>0.4%</strong>です。評価額を入力すると、自動で計算します。",
            "例外（免税になる土地など）は、下の区分に書いています。"
          ]
        },
        legal_general: {
          title: "法定代理人が手続する場合の一般論",
          items: [
            "相続人が未成年者や成年被後見人のときは、親権者・成年後見人などの<strong>法定代理人</strong>が、本人に代わって手続をします。",
            "法定代理人の資格を証する書面（戸籍謄本、後見登記の登記事項証明書など）を添付します。",
            "例外は、遺産分割協議で、法定代理人と本人がともに相続人になるとき（特別代理人が必要）です。下の区分を見てください。"
          ]
        }
      });
      // 以前の版が保存していた「今後表示しない」の設定は、使わなくなったので、消す
      try { window.localStorage.removeItem("houseki_hidden_tips"); window.localStorage.removeItem("houseki_hide_addr_notice"); } catch (e) { /* 何もしない */ }
      // 注意書きの一覧（画面上部の「ℹ」ボタンで開く）
      const tipsOpen = ref(false);
      function openTips() { tipsOpen.value = true; tipGenreIndex.value = 0; tipKeySelected.value = ""; }
      function closeTips() { tipsOpen.value = false; }
      const tipList = computed(() => Object.keys(TIPS).map((k) => ({
        key: k, title: TIPS[k].title, items: TIPS[k].items
      })));
      // 注意書きは、書類ごとではなく、テーマ（押印・日付・提出先・添付書類など）で分ける。
      // 各テーマの先頭が「一般論」、あとが、その一般論から外れる「例外の書類」
      const TIP_GENRES = [
        { name: "押印", general: "seal_general", keys: ["seal_general", "seal_toki", "seal_moshidesho", "seal_kyogisho", "seal_ininjo", "seal_toki_ininjo", "seal_toki_agent", "keiin"] },
        { name: "日付", general: "date_general", keys: ["date_general", "date_ichiranzu", "date_moshidesho", "date_toki", "date_ininjo", "date_toki_ininjo", "date_kyogisho"] },
        { name: "提出先（登記所）", general: "office_general", keys: ["office_general", "office_split", "office_multi"] },
        { name: "添付書類", general: "att_general", keys: ["att_general", "att_genin", "att_jusho", "att_kokuseki", "att_dairi", "att_moshide"] },
        { name: "登録免許税・評価額", general: "tax_general", keys: ["tax_general", "tax_exempt", "assessed_value", "att_hyoka"] },
        { name: "未成年者・成年被後見人", general: "legal_general", keys: ["legal_general", "legal_minor", "legal_ward", "legal_rep_kyogisho"] },
        { name: "住所・本籍の記載", keys: ["addr", "hoseki"] }
      ];
      const tipGenreIndex = ref(0);
      const tipKeySelected = ref("");
      const tipGenres = computed(() => {
        const byKey = {}; tipList.value.forEach((t) => { byKey[t.key] = t; });
        const used = {};
        // 各テーマの先頭（general）を「一般論」、そのほかを「例外」として、印を付ける
        const out = TIP_GENRES.map((g) => ({ name: g.name, tips: g.keys.filter((k) => byKey[k]).map((k) => { used[k] = true; return Object.assign({}, byKey[k], { kind: g.general ? (k === g.general ? "general" : "exception") : "" }); }) }));
        const rest = tipList.value.filter((t) => !used[t.key]);
        if (rest.length) out.push({ name: "その他", tips: rest });
        return out;
      });
      const tipsCurrentGenre = computed(() => tipGenres.value[tipGenreIndex.value] || tipGenres.value[0]);
      const tipsCurrent = computed(() => {
        const g = tipsCurrentGenre.value;
        return (g && (g.tips.find((t) => t.key === tipKeySelected.value) || g.tips[0])) || null;
      });
      function selectTipGenre(i) { tipGenreIndex.value = i; tipKeySelected.value = ""; }
      function selectTip(key) { tipKeySelected.value = key; }
      const tip = ref({ visible: false, key: "", top: 0, left: 0 });
      const tipDef = computed(() => TIPS[tip.value.key] || null);
      let tipShowTimer = null, tipHideTimer = null, tipTarget = null;
      const TIP_WIDTH = 360;
      function placeTip(el, key) {
        const r = el.getBoundingClientRect();
        const maxLeft = Math.max(8, window.innerWidth - TIP_WIDTH - 8);
        tip.value = { visible: true, key, top: r.bottom + 6, left: Math.max(8, Math.min(r.left, maxLeft)) };
      }
      function scheduleTipHide() {
        clearTimeout(tipHideTimer);
        tipHideTimer = setTimeout(() => { tip.value.visible = false; }, 250);
      }
      // 通過しただけで出ないよう、少し(0.35秒)とどまったときに表示する。
      function onTipTargetEnter(el) {
        const key = el.getAttribute("data-tip");
        const def = TIPS[key];
        if (!def) return;
        if (def.need && !docs.value[def.need]) return;
        clearTimeout(tipHideTimer);
        if (tip.value.visible && tip.value.key === key && tipTarget === el) return;
        clearTimeout(tipShowTimer);
        tipTarget = el;
        tipShowTimer = setTimeout(() => placeTip(el, key), 350);
      }
      function onTipTargetLeave() {
        clearTimeout(tipShowTimer);
        scheduleTipHide();
      }
      function onTipEnter() { clearTimeout(tipHideTimer); }
      function onTipLeave() { scheduleTipHide(); }
      function closeTip() {
        clearTimeout(tipShowTimer); clearTimeout(tipHideTimer);
        tip.value = Object.assign({}, tip.value, { visible: false });
      }
      function installTipListeners() {
        const find = (e) => (e.target && e.target.closest ? e.target.closest("[data-tip]") : null);
        document.addEventListener("mouseover", (e) => { const el = find(e); if (el) onTipTargetEnter(el); });
        document.addEventListener("mouseout", (e) => { if (find(e)) onTipTargetLeave(); });
        document.addEventListener("focusin", (e) => { const el = find(e); if (el) onTipTargetEnter(el); });
        document.addEventListener("focusout", (e) => { if (find(e)) onTipTargetLeave(); });
        // スクロールすると対象とポップアップの位置がずれるため、いったん閉じる
        window.addEventListener("scroll", () => { if (tip.value.visible) tip.value.visible = false; }, true);
      }

      let idCounter = 100000;

      // ------------------------------------------------------------
      // 相続関係説明図の「相続パターン」
      // ------------------------------------------------------------
      // 相続関係説明図は「その登記で誰が相続するか」を示す書類のため、
      // 不動産ごとに取得者が異なる場合は、登記ごとに別の図が必要になる。
      // 家系図（人物情報）は共通のまま、「誰が相続するか」だけを
      // パターンとして複数保持し、切り替えて表示・印刷できるようにする。
      //   successorPatterns = [ { id, name, successors: { 人物id: true/false } } ]
      // 人物との対応は id で取る（配偶者は id="spouse" 固定）。
      // successors に載っていない人は「相続する」として扱う。
      function newPatternId() {
        return "pat_" + Math.random().toString(36).slice(2, 8);
      }
      function newPattern(name, successors, shares, assets) {
        return {
          id: newPatternId(), name,
          assets: assets || "",   // 相続する財産の説明（預貯金など。任意）
          successors: Object.assign({}, successors || {}),
          shares: Object.assign({}, shares || {})   // 共有名義の持分（人物id → "1/2" 形式）
        };
      }
      const successorPatterns = ref([newPattern("パターン1")]);
      const activePatternId = ref(successorPatterns.value[0].id);
      const activePattern = computed(() =>
        successorPatterns.value.find((p) => p.id === activePatternId.value) || successorPatterns.value[0]);

      function isSuccessorIn(pattern, person) {
        if (!pattern || !person) return true;
        const v = pattern.successors[person.id];
        return v === undefined ? true : !!v;
      }
      function isSucc(person) { return isSuccessorIn(activePattern.value, person); }
      function setSucc(person, checked) {
        activePattern.value.successors[person.id] = !!checked;
      }
      function resetPatterns() {
        const p = newPattern("パターン1");
        successorPatterns.value = [p];
        activePatternId.value = p.id;
      }
      function addPattern() {
        const p = newPattern("パターン" + (successorPatterns.value.length + 1));
        successorPatterns.value.push(p);
        activePatternId.value = p.id;
      }
      function duplicatePattern() {
        const src = activePattern.value;
        const p = newPattern(src.name + "（コピー）", src.successors, src.shares, src.assets);
        successorPatterns.value.push(p);
        activePatternId.value = p.id;
      }
      function removePattern() {
        if (successorPatterns.value.length <= 1) return;
        if (!window.confirm("「" + activePattern.value.name + "」を削除します。よろしいですか？")) return;
        const idx = successorPatterns.value.findIndex((p) => p.id === activePatternId.value);
        successorPatterns.value.splice(idx, 1);
        activePatternId.value = successorPatterns.value[Math.max(0, idx - 1)].id;
      }

      // 全人物（配偶者・子・兄弟姉妹・親と、その代襲者すべて）に対して fn を呼ぶ。
      function forEachPerson(fn) {
        const walk = (arr) => (arr || []).forEach((p) => { fn(p); walk(p.substitutes); });
        if (spouse.value) fn(spouse.value);
        walk(children.value);
        walk(siblings.value);
        walk(parents.value);
      }
      // 読込み・サンプル展開の直後に呼ぶ。
      //  ・配偶者のidを固定値にする
      //  ・idを持たない人物（古い保存ファイル）にidを振る
      //  ・idCounterを既存の最大id+1に進める（保存ファイルを読み込んだ後に
      //    人物を追加した際、既存のidと重複して相続パターンが混線するのを防ぐ）
      function normalizeIds() {
        if (spouse.value) spouse.value.id = "spouse";
        let max = 99999;
        forEachPerson((p) => { if (typeof p.id === "number" && p.id > max) max = p.id; });
        idCounter = max + 1;
        forEachPerson((p) => {
          if (p.id === undefined || p.id === null || p.id === "") p.id = idCounter++;
        });
        // 個体ID（pid）: 手続をまたいで「同じ人」と分かるための印。ない人（古い保存ファイル・デモ）に振る。
        // 1つの手続の中で重なっていたら、後の人に振り直す。
        if (deceased.value && !deceased.value.pid) deceased.value.pid = Ledger.newPid();
        const seenPid = {};
        if (deceased.value) seenPid[deceased.value.pid] = true;
        forEachPerson((p) => {
          if (!p.pid || seenPid[p.pid]) p.pid = Ledger.newPid();
          seenPid[p.pid] = true;
        });
        normalizeMothers();
      }

      // ------------------------------------------------------------
      // 非嫡出子の母の管理
      // ------------------------------------------------------------
      function normalizeMothers() {
        const ex = extraRelations.value;
        if (!Array.isArray(ex.illegitimateMothers) || ex.illegitimateMothers.length === 0) {
          ex.illegitimateMothers = [{ id: "mother1", name: ex.illegitimateMotherName || "" }];
        }
        const list = ex.illegitimateMothers;
        children.value.forEach((c) => {
          if (c.isIllegitimate && !list.some((m) => m.id === c.motherId)) c.motherId = list[0].id;
        });
      }
      function addMother() {
        extraRelations.value.illegitimateMothers.push({
          id: "mother_" + Math.random().toString(36).slice(2, 8), name: ""
        });
      }
      function removeMother(index) {
        const list = extraRelations.value.illegitimateMothers;
        if (list.length <= 1) return;
        const removed = list.splice(index, 1)[0];
        children.value.forEach((c) => { if (c.motherId === removed.id) c.motherId = list[0].id; });
      }
      function motherLabel(m, idx) { return m.name || ("母" + (idx + 1)); }
      function onIllegitimateChange(c) { nextTick(normalizeMothers); }
      // 相続関係説明図の描画用に、指定パターンの「相続する／しない」を
      // 各人物の isSuccessor として反映した状態のコピーを作る。
      function applyPatternToState(state, pattern) {
        const clone = JSON.parse(JSON.stringify(state));
        // 数次相続で亡くなった人（after）が相続しないパターンでは、その人の相続人も〔相続しない〕
        const mark = (p, ok) => {
          if (!p) return;
          const self = isSuccessorIn(pattern, p);
          p.isSuccessor = ok && self;
          const childOk = ok && (p.deathKind === "after" ? self : true);
          (p.substitutes || []).forEach((x) => mark(x, childOk));
        };
        mark(clone.spouse, true);
        clone.children.forEach((x) => mark(x, true));
        clone.siblings.forEach((x) => mark(x, true));
        clone.parents.forEach((x) => mark(x, true));
        return clone;
      }

      // ------------------------------------------------------------
      // 相続順位による入力の排他制御
      // ------------------------------------------------------------
      // 民法の相続順位は、配偶者は常に相続人となり、それ以外は
      //   第1順位 子（及びその代襲者）
      //   第2順位 直系尊属（父母）
      //   第3順位 兄弟姉妹（及びその代襲者）
      // の順で、上位の相続人が1人でもいれば下位は相続人にならない。
      // 誤入力を防ぐため、上位の相続人が入力されている間は下位の
      // 入力欄自体を表示しない（一般の利用者が「子も親も入力して
      // しまう」ことを構造的に防ぐ）。
      //
      // 判定に使うのは「実際に相続人となる子」が1人以上いるかどうか。
      // 被相続人より先に死亡し代襲者もいない子は相続人にならないため、
      // その人だけしかいない場合は第2順位へ進む。
      function countEffectiveHeirs(list) {
        return (list || []).filter((p) => {
          const subs = p.substitutes || [];
          if (subs.length > 0) return true;       // 代襲者・（数次相続の）相続人がいるので相続関係は生きている
          if (p.death && deathKind(p) === "after") return true;   // 被相続人の死亡後に亡くなった人も相続人
          return !p.death;                        // 先死亡でなければ相続人
        }).length;
      }
      const effectiveChildCount = computed(() => countEffectiveHeirs(children.value));
      const effectiveParentCount = computed(() => countEffectiveHeirs(parents.value));

      // 子は常に入力可能（第1順位）。
      const showChildren = computed(() => true);
      // 親は、相続人となる子がいない場合のみ入力可能（第2順位）。
      const showParents = computed(() => effectiveChildCount.value === 0);
      // 兄弟姉妹は、相続人となる子も親もいない場合のみ入力可能（第3順位）。
      const showSiblings = computed(() =>
        effectiveChildCount.value === 0 && effectiveParentCount.value === 0);

      // 入力欄が隠れている理由を利用者に説明するためのメッセージ。
      const parentsBlockedReason = computed(() => {
        if (effectiveChildCount.value > 0) {
          return "子（第1順位）の相続人がいるため、父母は相続人になりません。子が亡くなっている場合は、子のカードの「死亡」にチェックを入れてください。代襲相続人（その方の子）もいなければ、相続人が自動で判定し直され、父母（いなければ兄弟姉妹）の入力欄が表示されます。";
        }
        return "";
      });
      const siblingsBlockedReason = computed(() => {
        if (effectiveChildCount.value > 0) {
          return "子の相続人がいるため、兄弟姉妹は相続人になりません。子が亡くなっている場合は、子のカードの「死亡」にチェックを入れてください。相続人が自動で判定し直されます。";
        }
        if (effectiveParentCount.value > 0) {
          return "父母の相続人がいるため、兄弟姉妹は相続人になりません。父母が亡くなっている場合は、父母のカードの「死亡」にチェックを入れてください。相続人が自動で判定し直されます。";
        }
        return "";
      });

      // 非嫡出子が1人以上いるか、その場合に日付要件を満たしているか
      const hasIllegitimateChild = computed(() => children.value.some((c) => c.isIllegitimate));
      // 「嫡出でない子」の欄は、被相続人の死亡日と連動する。特別な記載様式は、相続開始日が平成25年9月4日以前の場合だけ。
      // 死亡日が後（平成25年9月5日以後）なら、欄は出さない（すでにチェックが入っている子は、外せるよう出す）。日付が未入力・不完全なら、出す
      const illegitimateApplicable = computed(() => window.AppModules.checkIllegitimatePatternDate(deceased.value.death) !== false);
      const illegitimateDateStatus = computed(() => {
        if (!hasIllegitimateChild.value) return "n/a";
        const result = window.AppModules.checkIllegitimatePatternDate(deceased.value.death);
        if (result === null) return "unknown";
        return result ? "valid" : "invalid";
      });

      // 半血兄弟姉妹（父方のみ／母方のみ共通）が1人以上いるか。
      // いずれかがいる場合、相続関係説明図では「もう一方の親」の
      // 氏名入力欄を表示する。
      const hasFatherSideHalfSibling = computed(() =>
        siblings.value.some((s) => s.isHalfBlood && s.halfBloodParent === "father"));
      const hasMotherSideHalfSibling = computed(() =>
        siblings.value.some((s) => s.isHalfBlood && s.halfBloodParent === "mother"));

      // 申出書・委任状で使う「申出人（＝委任状の委任者）」を、
      // 作成者と同じ考え方で相続人ツリー全体から探す。
      function walkFindByFlag(flagName) {
        const found = { value: null };
        const check = (p) => { if (p && p[flagName] && !found.value) found.value = p; };
        const walk = (arr) => (arr || []).forEach((p) => { check(p); walk(p.substitutes); });
        check(spouse.value);
        walk(children.value);
        walk(siblings.value);
        walk(parents.value);
        return found.value;
      }
      const applicantPerson = computed(() => walkFindByFlag("isApplicant"));
      // 申出人は、相続人の代表者1人（申出書の申出人欄も1人分）。2人目にチェックを入れたら、前の人のチェックを外す
      const applicantFlagged = computed(() => {
        const out = [];
        const walk = (arr) => (arr || []).forEach((q) => { if (q && q.isApplicant) out.push(q); walk(q && q.substitutes); });
        if (spouse.value && spouse.value.isApplicant) out.push(spouse.value);
        walk(children.value); walk(siblings.value); walk(parents.value);
        return out;
      });
      watch(applicantFlagged, (now, old) => {
        if (now.length <= 1) return;
        const fresh = now.find((q) => !(old || []).includes(q)) || now[now.length - 1];
        now.forEach((q) => { if (q !== fresh) q.isApplicant = false; });
      }, { flush: "sync" });
      // 作成者は「相続人のうち1人」か「代理人」のどちらか。相続人の誰かにチェックが
      // 入っていれば、その人が作成者（代理人の入力は不要）。誰にも入っていなければ代理人。
      // 作成者と申出の代理人が別の人になるケースは扱わない。
      const creatorPerson = computed(() => walkFindByFlag("isCreator"));
      function syncAgentMode() { creator.value.isAgentMode = !creatorPerson.value; }
      watch(creatorPerson, (p) => {
        if (!p && !creator.value.isAgentMode) docs.value.ininjo = true;   // 代理人になったら委任状も作成対象にする
        syncAgentMode();
      }, { flush: "sync" });

      function toggleChild(id) {
        const idx = expandedChildren.value.indexOf(id);
        if (idx === -1) expandedChildren.value.push(id);
        else expandedChildren.value.splice(idx, 1);
      }
      function toggleSibling(id) {
        const idx = expandedSiblings.value.indexOf(id);
        if (idx === -1) expandedSiblings.value.push(id);
        else expandedSiblings.value.splice(idx, 1);
      }
      function toggleParent(id) {
        const idx = expandedParents.value.indexOf(id);
        if (idx === -1) expandedParents.value.push(id);
        else expandedParents.value.splice(idx, 1);
      }
      function toggleSubstitute(id) {
        const idx = expandedSubstitutes.value.indexOf(id);
        if (idx === -1) expandedSubstitutes.value.push(id);
        else expandedSubstitutes.value.splice(idx, 1);
      }
      function isSubExpanded(id) {
        return expandedSubstitutes.value.includes(id);
      }

      // ------------------------------------------------------------
      // 作成者の排他制御
      // ------------------------------------------------------------
      function clearSubTreeCreator(subs) {
        (subs || []).forEach((s) => {
          s.isCreator = false;
          if (s.substitutes) clearSubTreeCreator(s.substitutes);
        });
      }
      function clearAllCreatorFlags() {
        if (spouse.value) spouse.value.isCreator = false;
        children.value.forEach((c) => {
          c.isCreator = false;
          clearSubTreeCreator(c.substitutes);
        });
        siblings.value.forEach((s) => {
          s.isCreator = false;
          (s.substitutes || []).forEach((sub) => { sub.isCreator = false; });
        });
        parents.value.forEach((p) => { p.isCreator = false; });
      }
      function toggleCreator(target) {
        const turningOn = !target.isCreator;
        clearAllCreatorFlags();
        if (turningOn) target.isCreator = true;
        syncAgentMode();   // 相続人が作成者なら代理人は不要、誰もいなければ代理人が作成者
      }

      function loadSample(index) {
        demoMode.value = true;
        const sample = SampleData.get(index);
        if (!sample) return;

        deceased.value = sample.deceased;
        spouse.value = Object.assign({ id: "spouse", death: "", deathTiming: "auto", isApplicant: false, isCreator: false }, sample.spouse);
        children.value = sample.children;
        siblings.value = sample.siblings;
        parents.value = sample.parents;
        creator.value = { date: "令和〇年〇月〇日", isAgentMode: false, agentAddr: "〇県〇市〇町〇番地", agentName: "〇〇〇〇", agentPick: "" };

        extraRelations.value.illegitimateMothers = [{ id: "mother1", name: "" }];
        normalizeIds();
        syncAgentMode();
        resetPatterns();
        // 数次相続のデモ: 亡くなった相続人を承継する2人の取得割合を、均等（1/2ずつ）にしておく
        if (index === 7) splitEqually(successorPatterns.value[0]);
        // 相続関係のデモを選ぶと、最初の財産デモ（土地）も自動で入力される。後から財産ごとに変更できる
        registration.value.properties = [];
        registration.value.addrChanges = {};
        addProperty("land");
        applyAssetDemo(registration.value.properties[0], 0);
        fillDateDefaults();

        expandedChildren.value = [];
        expandedSiblings.value = [];
        expandedParents.value = [];
        expandedSubstitutes.value = [];
        showDemoSelector.value = false;
      }

      // ---- 子 ----
      function addChild() {
        children.value.push({
          id: idCounter++, pid: Ledger.newPid(), role: "（子）", name: "", birth: "", death: "", addr: "",
          isApplicant: false, isCreator: false, isAdopted: false, isIllegitimate: false,
          substitutes: []
        });
      }
      function removeChild(i) { children.value.splice(i, 1); }

      // ---- 代襲者(子の系統・再帰対応) ----
      function addSubstituteTo(parentObj) {
        parentObj.death = parentObj.death || "令和〇年〇月〇日";
        if (!parentObj.substitutes) parentObj.substitutes = [];
        parentObj.substitutes.push({
          id: idCounter++, pid: Ledger.newPid(), role: "（代襲者）", name: "", birth: "", death: "", addr: "",
          isApplicant: false, isCreator: false, substitutes: []
        });
      }
      // 代襲者を削除しても、「死亡」状態は保つ（外すには、人物カードの「死亡」のチェックを外す）
      function removeSubstituteFrom(parentObj, index) {
        parentObj.substitutes.splice(index, 1);
      }

      // ---- 兄弟姉妹 ----
      function addSibling() {
        siblings.value.push({
          id: idCounter++, pid: Ledger.newPid(), role: "（兄弟姉妹）", name: "", birth: "", addr: "",
          isApplicant: false, isCreator: false, isHalfBlood: false, halfBloodParent: "father",
          substitutes: []
        });
      }
      function removeSibling(i) { siblings.value.splice(i, 1); }

      function addSiblingSubstitute(sibling) {
        sibling.death = sibling.death || "令和〇年〇月〇日";
        if (!sibling.substitutes) sibling.substitutes = [];
        sibling.substitutes.push({
          id: idCounter++, pid: Ledger.newPid(), role: "（代襲者・甥姪）", name: "", birth: "", addr: "",
          isApplicant: false, isCreator: false
        });
      }
      function removeSiblingSubstitute(sibling, index) {
        sibling.substitutes.splice(index, 1);
      }

      // ---- 親 ----
      function addParent() {
        parents.value.push({
          id: idCounter++, pid: Ledger.newPid(), role: "（親）", name: "", birth: "", death: "", addr: "",
          isApplicant: false, isCreator: false
        });
      }
      function removeParent(i) { parents.value.splice(i, 1); }

      function currentFullState() {
        const st = JSON.parse(JSON.stringify({
          deceased: deceased.value, spouse: spouseIsHeir.value ? spouse.value : null, children: children.value,
          siblings: siblings.value, parents: parents.value, creator: creator.value,
          extraRelations: extraRelations.value
        }));
        // 図の描画用に、亡くなった人が代襲（before）か数次相続（after）かを付ける（保存はしない）
        const ann = (p) => { if (!p) return; p.deathKind = deathKind(p); (p.substitutes || []).forEach(ann); };
        ann(st.spouse); st.children.forEach(ann); st.siblings.forEach(ann); st.parents.forEach(ann);
        return st;
      }

      // ------------------------------------------------------------
      // 登記申請書：取得者・持分・登録免許税
      // ------------------------------------------------------------
      // 実際に相続人となる人（相続順位に従い、先死亡で代襲者のいない人は除く。
      // 代襲者がいる場合は被代襲者ではなく代襲者）。
      // ------------------------------------------------------------
      // 死亡した相続人（数次相続）
      // ------------------------------------------------------------
      // 死亡している相続人には2種類ある。
      //   before … 被相続人より前（同時を含む）に死亡 → 代襲相続。その人の子が直接の相続人
      //   after  … 被相続人の死亡後に死亡 → 数次相続。その人も相続人で、その人の相続人（人物の
      //            substitutes に入力）が、その人の相続分を承継する
      // 死亡の時期は、日付から自動判定する（日付が読めない場合や、手動で指定した場合は deathTiming）。
      // 亡くなった人が、被相続人より先か後かは、死亡年月日の日付で判定する（同じ日は、同時に亡くなったものとして「先」）
      //   state: alive（生存）／nodate（本人の死亡年月日が未入力）／nodeceased（被相続人の死亡年月日が未入力）
      //          ／ambiguous（月日が足りず決められない）／before（先に死亡）／after（死亡後に死亡）
      function deathJudge(p) {
        if (!p || !p.death) return { state: "alive" };
        const pd = parseJa(p.death), dd = parseJa(deceased.value.death);
        if (!pd || pd.y === null) return { state: "nodate" };
        if (!dd || dd.y === null) return { state: "nodeceased" };
        const c = compareJa(pd, dd);
        if (c === null) return { state: "ambiguous" };
        return { state: c > 0 ? "after" : "before" };
      }
      function deathKind(p) {
        const j = deathJudge(p);
        if (j.state === "alive") return "alive";
        if (j.state === "before" || j.state === "after") return j.state;
        // 日付だけでは決められないとき（古いデータなど）は、以前の指定があればそれに従い、なければ「先」とみなす
        return p.deathTiming === "after" ? "after" : "before";
      }
      // 被相続人の直接の相続人（代襲相続は子など、数次相続の死亡者は本人のまま）
      function lineUnits(p) {
        const k = deathKind(p);
        if (k === "alive" || k === "after") return [p];
        return (p.substitutes || []).reduce((acc, s) => acc.concat(lineUnits(s)), []);
      }
      function unitHeirs(p) {
        return (p.substitutes || []).reduce((acc, s) => acc.concat(lineUnits(s)), []);
      }
      function estateUnits() {
        const out = [];
        if (spouseIsHeir.value) out.push(spouse.value);
        if (effectiveChildCount.value > 0) children.value.forEach((c) => lineUnits(c).forEach((u) => out.push(u)));
        else if (effectiveParentCount.value > 0) parents.value.filter((p) => !p.death).forEach((p) => out.push(p));
        else siblings.value.forEach((s) => lineUnits(s).forEach((u) => out.push(u)));
        return out;
      }
      // 相続パターンで実際に取得する、生存している人（亡くなった人の分は、その相続人まで下りる）
      function finalLiving(units, pattern) {
        const out = [];
        units.forEach((u) => {
          if (!isSuccessorIn(pattern, u)) return;
          if (deathKind(u) === "after") finalLiving(unitHeirs(u), pattern).forEach((x) => out.push(x));
          else out.push(u);
        });
        return out;
      }
      function acquirersOf(pattern) { return finalLiving(estateUnits(), pattern); }
      // 取得割合を入力する単位（同じ親をもつ兄弟どうし）。合計が1になるのは、この単位ごと
      function shareGroups(pattern) {
        const groups = [];
        const walk = (units, key) => {
          const members = units.filter((u) => isSuccessorIn(pattern, u));
          groups.push({ key, members });
          members.forEach((u) => { if (deathKind(u) === "after") walk(unitHeirs(u), String(u.id)); });
        };
        walk(estateUnits(), "root");
        return groups;
      }
      function anyNotInheriting(pattern, units) {
        return units.some((u) => !isSuccessorIn(pattern, u) || (deathKind(u) === "after" && anyNotInheriting(pattern, unitHeirs(u))));
      }
      function patternRows(pattern) {
        const rows = [];
        const walk = (units, depth) => {
          const sel = units.filter((u) => isSuccessorIn(pattern, u)).length;
          units.forEach((u) => {
            const dead = deathKind(u) === "after", selected = isSuccessorIn(pattern, u);
            rows.push({ p: u, depth, dead, selected, showShare: sel > 1 && selected });
            if (dead && selected) walk(unitHeirs(u), depth + 1);
          });
        };
        walk(estateUnits(), 0);
        return rows;
      }
      function patternWarnings(pattern) {
        const out = [];
        const walk = (units) => units.forEach((u) => {
          if (deathKind(u) !== "after" || !isSuccessorIn(pattern, u)) return;
          const heirs = unitHeirs(u);
          if (heirs.filter((h) => isSuccessorIn(pattern, h)).length === 0) {
            out.push("亡" + (u.name || "〇〇") + "の相続人（取得者）が選択されていません");
          }
          walk(heirs);
        });
        walk(estateUnits());
        return out;
      }
      function unitText(pattern, units) {
        const sel = units.filter((u) => isSuccessorIn(pattern, u));
        return sel.map((u) => {
          const sh = (needShares.value && sel.length > 1) ? "（" + shareLabel(getShare(pattern, u)) + "）" : "";   // 持分は、遺産分割協議書・登記申請書を作るときだけ
          if (deathKind(u) === "after") {
            const inner = unitText(pattern, unitHeirs(u));
            return "亡" + (u.name || "〇〇") + sh + "の相続人 " + (inner || "（未選択）");
          }
          return (u.name || "〇〇") + sh;
        }).join("、");
      }
      // ---- 登記申請書の単位（数次相続では、登記申請書を段階に分ける）----
      //  ・亡くなった相続人が単独で承継 → 中間を省略して、最終の相続人へ直接（原因は2行以上）
      //  ・亡くなった相続人が他の人と共同で承継 → 先に、亡くなった相続人も名義人にする登記申請書、
      //    続けて「○○持分全部移転」でその相続人の分をその人の相続人へ移す登記申請書
      function sharesOfUnits(pattern, units) {
        const map = {};
        units.forEach((u) => { map[u.id] = units.length === 1 ? { n: 1, d: 1 } : parseShare(getShare(pattern, u)); });
        return map;
      }
      function specsFrom(pattern, units, ctx) {
        const sel = units.filter((u) => isSuccessorIn(pattern, u));
        if (sel.length === 0) return [];
        if (sel.length === 1 && deathKind(sel[0]) === "after") {
          return specsFrom(pattern, unitHeirs(sel[0]), Object.assign({}, ctx, { chain: ctx.chain.concat([sel[0]]) }));
        }
        const spec = { root: ctx.root, chain: ctx.chain, base: ctx.base, owners: sel, shares: sharesOfUnits(pattern, sel), isStep2: !!ctx.isStep2 };
        const specs = [spec];
        sel.forEach((u) => {
          if (deathKind(u) !== "after") return;
          const sh = spec.shares[u.id];
          const base = sh && ctx.base ? reduceFrac(ctx.base.n * sh.n, ctx.base.d * sh.d) : null;
          specsFrom(pattern, unitHeirs(u), { root: u, chain: [], base, isStep2: true }).forEach((x) => specs.push(x));
        });
        return specs;
      }
      function resolveSpecs(pattern) {
        return specsFrom(pattern, estateUnits(), {
          root: { id: "deceased", name: deceased.value.name, death: deceased.value.death }, chain: [], base: { n: 1, d: 1 }, isStep2: false
        });
      }
      function specKey(sp) {
        return [sp.root.id, sp.chain.map((c) => c.id).join(">"), sp.owners.map((o) => String(o.id)).sort().join("|"), sp.isStep2 ? 2 : 1].join("#");
      }
      function causeLinesOf(sp) {
        const r = sp.root, ch = sp.chain;
        if (ch.length === 0) return [(r.death || "") + "相続"];
        const lines = [(r.death || "") + (ch[0].name || "") + "相続"];
        for (let i = 0; i < ch.length - 1; i++) lines.push((ch[i].death || "") + (ch[i + 1].name || "") + "相続");
        lines.push((ch[ch.length - 1].death || "") + "相続");
        return lines;
      }
      // その財産のうち、被相続人（数次相続の段階ごとの被相続人）が持っていた割合
      function holdingOf(prop, sp) {
        const own = prop.rightKind === "share" ? parseShare(prop.deceasedShare) : { n: 1, d: 1 };
        if (!own || !sp || !sp.base) return null;
        return reduceFrac(own.n * sp.base.n, own.d * sp.base.d);
      }
      function deadFraction(sp) {
        let n = 0, d = 1, any = false;
        for (const o of sp.owners) {
          if (deathKind(o) !== "after") continue;
          any = true;
          const sh = sp.shares[o.id];
          if (!sh) return null;
          n = n * sh.d + sh.n * d; d = d * sh.d;
          const g = gcd(n, d); n /= g; d /= g;
        }
        return any ? { n, d } : null;
      }
      // 租税特別措置法第84条の2の3第1項: 相続した土地の登記をしないで死亡した個人を名義人にする登記の免税
      function exemptionClause1(pr, apply, dateStr) {
        if (!apply || pr.kind !== "land") return false;
        const d = parseWareki(dateStr);
        return !(d && d.getTime() > EXEMPT_DEADLINE.getTime());
      }
      function exemptClauseText(tax) {
        const c = [];
        if (tax.clause1) c.push("第1項");
        if (tax.clause2) c.push("第2項");
        return "租税特別措置法第84条の2の3" + (c.join("及び") || "第2項") + "により非課税";
      }
      function isDeadOwner(p) { return deathKind(p) === "after"; }

      function listHeirs() {
        const out = [];
        const addLeaf = (p) => {
          const subs = p.substitutes || [];
          if (subs.length > 0) { subs.forEach(addLeaf); return; }
          if (p.death) return;
          out.push(p);
        };
        if (spouseIsHeir.value && !spouse.value.death) out.push(spouse.value);
        if (effectiveChildCount.value > 0) children.value.forEach(addLeaf);
        else if (effectiveParentCount.value > 0) parents.value.forEach(addLeaf);
        else siblings.value.forEach(addLeaf);
        return out;
      }
      // 遺産分割協議書を選べるのは、どの相続パターンにも「相続しない」人がいる場合
      // （＝全員が相続人とならない場合）。全員が相続する場合は協議不要。
      // ------------------------------------------------------------
      // 法定相続分と、遺産分割協議書が必要かどうかの判定
      // ------------------------------------------------------------
      // 法定相続分（民法900・901条）。配偶者は、子と共に1/2、直系尊属と共に2/3、兄弟姉妹と共に3/4。
      // 子・兄弟姉妹の間は等分（半血の兄弟姉妹は全血の1/2。平成25年9月4日以前に開始した相続の
      // 非嫡出子は嫡出子の1/2）。代襲相続人は、被代襲者の相続分を等分する。
      function fracAdd(a, b) { return reduceFrac(a.n * b.d + b.n * a.d, a.d * b.d); }
      function fracMul(a, b) { return reduceFrac(a.n * b.n, a.d * b.d); }
      function fracEq(a, b) { return a.n * b.d === b.n * a.d; }
      function liveLeaves(p) {
        const subs = p.substitutes || [];
        if (subs.length) return subs.reduce((acc, s) => acc.concat(liveLeaves(s)), []);
        return p.death ? [] : [p];
      }
      function legalShareMap() {
        const out = {};
        const hasSpouse = spouseIsHeir.value;
        const dd = parseWareki(deceased.value.death);
        const before2013 = !!dd && dd.getTime() <= new Date(2013, 8, 4, 23, 59, 59).getTime();
        const alive = (p) => deathKind(p) === "after" || liveLeaves(p).length > 0;
        let lines = [], rank = "none";
        const kids = children.value.filter(alive);
        if (kids.length) {
          rank = "children";
          lines = kids.map((c) => ({ p: c, w: (before2013 && c.isIllegitimate) ? 1 : 2 }));
        } else {
          const pars = parents.value.filter((p) => !p.death);
          if (pars.length) { rank = "parents"; lines = pars.map((p) => ({ p, w: 1 })); }
          else {
            const sibs = siblings.value.filter(alive);
            if (sibs.length) { rank = "siblings"; lines = sibs.map((p) => ({ p, w: p.isHalfBlood ? 1 : 2 })); }
          }
        }
        const blood = !hasSpouse ? { n: 1, d: 1 } : ({ children: { n: 1, d: 2 }, parents: { n: 1, d: 3 }, siblings: { n: 1, d: 4 }, none: { n: 0, d: 1 } })[rank];
        if (hasSpouse) out[spouse.value.id] = rank === "none" ? { n: 1, d: 1 } : reduceFrac(blood.d - blood.n, blood.d);
        const wSum = lines.reduce((a, l) => a + l.w, 0);
        const dist = (p, share) => {
          if (deathKind(p) === "after") return;   // 数次相続: その人の相続人の法定相続分は、ここでは計算しない
          const subs = p.substitutes || [];
          if (subs.length) {
            const live = subs.filter(alive);
            live.forEach((sb) => dist(sb, fracMul(share, { n: 1, d: live.length })));
            return;
          }
          if (!p.death) out[p.id] = share;
        };
        lines.forEach((l) => dist(l.p, fracMul(blood, { n: l.w, d: wSum })));
        return out;
      }
      // 取得者が相続人全員のとき、その組み合わせの持分を法定相続分で入力できる
      function canFillLegal(pt) {
        const acq = acquirersOf(pt);
        return acq.length > 1 && acq.length === listHeirs().length && !estateUnits().some((u) => deathKind(u) === "after");
      }
      function fillLegalShares(pt) {
        const map = legalShareMap();
        acquirersOf(pt).forEach((a) => { if (map[a.id]) setShare(pt, a, map[a.id].n + "/" + map[a.id].d); });
      }
      // 遺産分割協議書が必要か: 相続しない人がいる、または持分が法定相続分と異なる場合
      const kyogishoAdvice = computed(() => {
        const heirs = listHeirs();
        const legal = legalShareMap();
        const reasons = [];
        successorPatterns.value.forEach((pt) => {
          const acq = acquirersOf(pt);
          if (acq.length === 0) return;
          if (anyNotInheriting(pt, estateUnits())) { reasons.push("「" + pt.name + "」は、相続しない相続人がいます"); return; }
          if (acq.length > 1) {
            const differs = acq.some((a) => {
              const sh = parseShare(getShare(pt, a)), lg = legal[a.id];
              return sh && lg && !fracEq(sh, lg);
            });
            if (differs) reasons.push("「" + pt.name + "」の持分が法定相続分と異なります");
          }
        });
        return { needed: reasons.length > 0, reasons };
      });
      // ------------------------------------------------------------
      // 相続パターン一覧（誰が・何を相続するか）の表示用
      // ------------------------------------------------------------
      function patternPropertyNames(pt) {
        return registration.value.properties.filter((pr) => patternFor(pr) === pt).map((pr) => {
          if (!isRealEstate(pr)) return assetSummary(pr) || assetKindLabel(pr);
          return ((pr.location || "") + " " + (pr.lotNo || "")).trim() || assetKindLabel(pr);
        });
      }
      function patternAssetsText(pt) {
        const parts = patternPropertyNames(pt);
        return parts.length ? parts.join("、") : "（財産が未割当）";
      }
      function patternDocsText(pt) {
        const parts = [];
        if (docs.value.setsumeizu) parts.push("相続関係説明図");
        if (docs.value.toki) {
          const n = applications.value.filter((ap) => ap.patterns.includes(pt)).length;
          if (n > 0) parts.push("登記申請書" + n + "通");
        }
        return parts.join("・") || "—";
      }
      // 作成される書類の通数（書類選択の横に表示）
      const docCounts = computed(() => {
        const sets = {};
        successorPatterns.value.forEach((pt) => { sets[acquirerSetSignature(pt)] = true; });
        return {
          ichiranzu: 1, moshidesho: 1, ininjo: 1, kyogisho: 1,
          setsumeizu: Object.keys(sets).length,
          toki: applications.value.length, toukiIninjo: applications.value.length,
          jusho: jushoApplications.value.length
        };
      });
      // 実際に作成する書類（親が選ばれていない子の書類は作成しない）
      const docEnabled = computed(() => {
        const d = docs.value;
        const moshidesho = d.ichiranzu && d.moshidesho;
        return {
          ichiranzu: d.ichiranzu,
          moshidesho,
          ininjo: moshidesho && creator.value.isAgentMode && d.ininjo,
          setsumeizu: d.setsumeizu,
          kyogisho: d.kyogisho,
          toki: d.toki,
          toukiIninjo: d.toki && registration.value.agent.enabled && d.toukiIninjo,
          jusho: d.toki && d.jusho
        };
      });
      // 相続パターンを複数作れるか。相続関係説明図は、パターンごと（誰が相続するかの組み合わせごと）に
      // 1通作るため、相続関係説明図だけを作る場合でも、パターンを複数作れる。
      const multiPattern = computed(() => docs.value.setsumeizu || docs.value.kyogisho || docs.value.toki);
      // 持分（取得割合）・相続財産・登記所を入力するのは、遺産分割協議書・登記申請書を作る場合だけ
      const needShares = computed(() => docs.value.kyogisho || docs.value.toki);
      // 入力欄のタブ（1度に1つの入力欄だけを表示して、縦に長くならないようにする）
      // 先頭は「作成する書類」。先に作る書類を選ばないと、不要な入力欄を作ってしまうため
      const inputTab = ref("docs");
      const inputTabs = computed(() => {
        const d = docs.value;
        const list = [{ id: "docs", label: "作成する書類" }, { id: "family", label: "被相続人・相続人" }];
        if (d.setsumeizu || d.kyogisho || d.toki) list.push({ id: "pattern", label: "相続パターン" });
        if (d.kyogisho || d.toki) list.push({ id: "assets", label: "相続財産" });
        if (d.toki) list.push({ id: "office", label: "登記所・登記申請書" });
        if (d.ichiranzu || d.kyogisho) list.push({ id: "info", label: "各書類の情報" });
        list.push({ id: "ledger", label: "個体・履歴" });      // 人物・不動産の個体管理と時系列の履歴（手続をまたぐ）
        return list;
      });
      const activeInputTab = computed(() => inputTabs.value.some((t) => t.id === inputTab.value) ? inputTab.value : "docs");
      const usesPatterns = computed(() => docs.value.setsumeizu || docs.value.toki || docs.value.kyogisho);

      // ------------------------------------------------------------
      // 通数（同じ内容を何通印刷するか）
      // ------------------------------------------------------------
      // 遺産分割協議書と相続関係説明図は、同じ内容のものを、登記所へ提出する分と、相続人がそれぞれ
      // 保管する分など、複数通ほしいことがある。そこで、印刷する通数を設定できるようにする。
      function clampCopies(v) {
        const n = parseInt(v, 10);
        return isNaN(n) ? 1 : Math.min(99, Math.max(1, n));
      }
      // いま表示している書類の印刷通数
      const printCopies = computed(() => {
        if (currentView.value !== "preview") return 1;
        if (docType.value === "setsumeizu") return clampCopies(docs.value.setsumeizuCopies);
        if (docType.value === "kyogisho") return clampCopies(docs.value.kyogishoCopies);
        return 1;
      });
      // ------------------------------------------------------------
      // 書類の文字の大きさ（余白が大きい書類は、余白を多めに確保したまま、文字を少し大きくする）
      // ------------------------------------------------------------
      // 申出書・委任状・遺産分割協議書・登記申請書は、内容が少ないと、下に大きな余白ができる。
      // そこで、A4の1ページに収まる範囲で、文字（と行間などの余白）の倍率を大きくする（最大1.3倍）。
      // 上下左右の余白（padding）は、そのまま確保する。2ページ以上になる書類は、倍率を変えない。
      // 複数ページある書類（登記申請書など）は、いちばん内容の多いページに合わせて、全ページ同じ倍率にする。
      const DOC_SCALE_MAX = 1.3, DOC_FIT_HEIGHT = 1000;     // 1ページに収める高さ（印刷の既定の余白でも、2ページ目にはみ出さない大きさ）
      function fitDocPapers() {
        const box = document.querySelector(".preview-container");
        if (!box) return;
        const papers = Array.from(box.querySelectorAll(".doc-paper")).filter((el) => !el.hasAttribute("data-print-copy"));
        if (papers.length === 0) return;
        const heightAt = (el, sc) => {
          const prevDisplay = el.style.display, prevMin = el.style.minHeight;
          if (prevDisplay === "none") el.style.display = "block";      // 隠れているページも測る
          el.style.minHeight = "0px";
          el.style.setProperty("--doc-scale", String(sc));
          const h = el.offsetHeight;
          el.style.minHeight = prevMin;
          el.style.display = prevDisplay;
          return h;
        };
        let best = DOC_SCALE_MAX;
        for (const el of papers) {
          const h1 = heightAt(el, 1);
          if (!h1) return;                                              // 画面の配置がない環境では、何もしない
          if (h1 > DOC_FIT_HEIGHT) { best = 1; continue; }              // 2ページ以上: 倍率は変えない
          let ok = 1;
          for (let k = 1; k <= 6; k++) {
            const sc = Math.round((1 + k * 0.05) * 100) / 100;
            if (sc > DOC_SCALE_MAX + 1e-9) break;
            if (heightAt(el, sc) <= DOC_FIT_HEIGHT) ok = sc; else break;
          }
          best = Math.min(best, ok);
        }
        papers.forEach((el) => el.style.setProperty("--doc-scale", String(best)));
      }
      // 印刷の直前に、表示中の書類を「通数−1」回ぶん複製して並べる（印刷後に取り除く）。
      // 相続関係説明図は、複数ページを1組として、組ごとにそろえて（1・2、1・2…）出力される。
      function removePrintCopies() {
        document.querySelectorAll("[data-print-copy]").forEach((el) => el.remove());
      }
      function onBeforePrint() {
        removePrintCopies();
        fitDocPapers();
        const n = printCopies.value;
        if (n <= 1) return;
        const box = document.querySelector(".preview-container");
        if (!box) return;
        const originals = Array.from(box.children);
        for (let i = 1; i < n; i++) {
          originals.forEach((el) => {
            const c = el.cloneNode(true);
            c.classList.add("print-copy");
            c.setAttribute("data-print-copy", "1");
            box.appendChild(c);
          });
        }
      }

      // ------------------------------------------------------------
      // 被代襲者（被相続人より先に亡くなり、その子などが代襲した人）の入力欄
      // ------------------------------------------------------------
      // 法定相続情報一覧図では、被代襲者は「（被代襲者）」と死亡年月日だけが表示される。
      // 法定相続情報一覧図（と申出書・委任状）だけを作る場合は、氏名（どの方の系統かを見分けるため）と
      // 死亡年月日以外の入力は不要なので、出生・住所などの入力欄を出さない。
      // 相続関係説明図・遺産分割協議書・登記申請書も作る場合は、従来どおり全項目を入力する。
      // ------------------------------------------------------------
      // 亡くなっている相続人（推定相続人）の入力
      // ------------------------------------------------------------
      // 入力の順序: ①まず「死亡」のチェックだけ → ②チェックが入ったら、必要なときだけ死亡年月日
      // → ③入力の結果、相続人にならないと分かったら注意を出す → ④死亡年月日が入力されたら、その方を被相続人とする
      // 手続のチェックを出す。相続順位は利用者が知らなくてよいよう、プログラムが判定し直す。
      // 死亡年月日が分からない（または不要な）間は、「令和〇年〇月〇日」を入れておく（亡くなっている印）。
      const DEATH_PLACEHOLDER = "令和〇年〇月〇日";
      // 死亡年月日が入力されているか（年が入っていれば入力済み。「令和〇年〇月〇日」のままなら、まだ）
      function deathDateEntered(p) { return !!(p && p.death && /[0-9０-９元]/.test(String(p.death))); }
      function personGroup(p) {
        if (p === spouse.value) return "spouse";
        if (children.value.includes(p)) return "child";
        if (siblings.value.includes(p)) return "sibling";
        if (parents.value.includes(p)) return "parent";
        return "sub";
      }
      function expandPerson(p) {
        const g = personGroup(p);
        const add = (arr) => { if (!arr.value.includes(p.id)) arr.value.push(p.id); };
        if (g === "spouse") expandedSpouse.value = true;
        else if (g === "child") add(expandedChildren);
        else if (g === "sibling") add(expandedSiblings);
        else if (g === "parent") add(expandedParents);
        else add(expandedSubstitutes);
      }
      // 「死亡」のチェック
      // デモのデータを読み込んでいる間は、「死亡」にチェックを入れると、死亡年月日の例（被相続人の3年前）も入る
      const demoMode = ref(false);
      function shiftJaYears(str, delta) {
        const pj = parseJa(str);
        if (!pj || pj.y === null || pj.m === null || pj.d === null) return "";
        const gy = ERA_DEF[pj.era].base + pj.y + delta;
        const d = (pj.m === 2 && pj.d === 29 && new Date(gy, 2, 0).getDate() < 29) ? 28 : pj.d;
        const iso = gy * 10000 + pj.m * 100 + d;
        for (const era of ERA_ORDER) {
          const def = ERA_DEF[era];
          if (iso >= def.start || era === "明治") return composeJa({ era, y: gy - def.base, m: pj.m, d });
        }
        return "";
      }
      function toggleDead(p, ev) {
        const on = !!(ev && ev.target && ev.target.checked);
        if (on) {
          if (!p.deathTiming) p.deathTiming = "auto";
          if (!p.death) {
            const demo = demoMode.value ? shiftJaYears(deceased.value.death, -3) : "";
            p.death = demo || DEATH_PLACEHOLDER;
            if (demo) nextTick(() => checkHeirStatus(p));         // デモでは、日付が入っているので、すぐ判定して知らせる
          }
          expandPerson(p);                                      // 続きの入力欄が見えるよう、カードを開く
          return;
        }
        if ((p.substitutes || []).length > 0 &&
            !window.confirm("「" + (p.name || "この方") + "」の代襲相続人（数次相続の場合は、この方の相続人）の入力も、あわせて消えます。よろしいですか？")) {
          if (ev && ev.target) ev.target.checked = true;
          return;
        }
        p.death = "";
        p.deathTiming = "auto";
        delete noticedKeys[p.id];
        if (p.substitutes) p.substitutes = [];
      }
      // 亡くなった人の、判定結果の説明（死亡年月日の下に出す）
      function deathJudgeText(p) {
        const st = deathJudge(p).state, g = personGroup(p), hasSubs = (p.substitutes || []).length > 0;
        if (st === "nodeceased") return "被相続人の死亡年月日を入力してください。";
        if (st === "ambiguous") return "月日まで入力してください。";
        if (st === "after") return "被相続人の死亡後に死亡（数次相続）。この方も相続人です。";
        if (st === "before") {
          if (hasSubs) return "被相続人より先に死亡。代襲相続です。";
          if (g === "spouse" || g === "parent") return "被相続人より先に死亡。相続人になりません。";
          return "被相続人より先に死亡。代襲相続人がいなければ、相続人になりません。";
        }
        return "";
      }
      // 見出しに出す、短い表示
      function deathBadge(p) {
        const st = deathJudge(p).state, g = personGroup(p), hasSubs = (p.substitutes || []).length > 0;
        if (st === "alive") return "";
        if (st === "nodate") return "死亡年月日が未入力";
        if (st === "nodeceased") return "被相続人の死亡年月日が未入力";
        if (st === "ambiguous") return "先に死亡か後に死亡か未判定";
        if (st === "after") return "被相続人の死亡後に死亡（数次相続）";
        if (hasSubs) return "被代襲者（先に死亡）";
        return (g === "spouse" || g === "parent") ? "先に死亡（相続人になりません）" : "先に死亡（代襲相続人がいなければ相続人になりません）";
      }
      // 代襲相続人（数次相続では、その方の相続人）の入力欄が必要か。代襲にならない人には、入力させない
      function substitutesWanted(p) {
        if (!p || !p.death) return false;
        if ((p.substitutes || []).length > 0) return true;       // すでに入力したものは、隠さない
        const st = deathJudge(p).state;
        if (st === "before") return personGroup(p) !== "spouse" && personGroup(p) !== "parent";
        if (st === "after") return usesPatterns.value;           // 数次相続人は、相続関係説明図・遺産分割協議書・登記申請書で必要
        return false;
      }
      // 被相続人との関係で「相続人にならない」と判定されたときの注意（ポップアップ）
      const notice = ref({ open: false, title: "", lines: [] });
      const noticedKeys = {};
      function closeNotice() { notice.value = { open: false, title: "", lines: [] }; }
      function checkHeirStatus(p) {
        if (!p || !p.death) return;
        // 被相続人より先に亡くなり、代襲相続人もいなければ、相続人にならない（代襲相続人がいれば、その方々が相続人）
        const notHeir = deathKind(p) === "before" && (p.substitutes || []).length === 0;
        if (!notHeir) { delete noticedKeys[p.id]; return; }
        if (noticedKeys[p.id]) return;                                // 同じ状態では、繰り返し出さない
        noticedKeys[p.id] = true;
        const who = (p.name ? p.name + "さん" : "この方");
        const g = personGroup(p);
        const lines = [];
        if (g === "spouse") lines.push(who + "は、被相続人より先に亡くなっているため、配偶者としての相続人にはなりません（配偶者には、代襲相続がありません）。");
        else if (g === "parent") lines.push(who + "は、被相続人より先に亡くなっているため、相続人になりません。");
        else lines.push(who + "は、被相続人より先に亡くなっていて、代襲相続人（その方の子など）もいないため、相続人になりません。その方の子がいる場合は、この方のカードの「＋ 代襲相続人を追加」で入力してください。");
        nextTick(() => {
          if (g === "child" && children.value.length > 0 && effectiveChildCount.value === 0) lines.push("子の側に相続人がいなくなったため、次の順位の方（父母。父母もいなければ兄弟姉妹）が相続人になります。それぞれの入力欄を表示しますので、入力してください。");
          else if (g === "parent" && effectiveChildCount.value === 0 && effectiveParentCount.value === 0) lines.push("父母が相続人にならないため、兄弟姉妹が相続人になります。兄弟姉妹の入力欄を表示しますので、入力してください。");
          notice.value = { open: true, title: "相続人にならない方がいます", lines };
        });
      }
      const deadApi = {
        check: checkHeirStatus, toggle: toggleDead, entered: deathDateEntered, judge: deathJudgeText, wanted: substitutesWanted
      };
      // 被相続人の配偶者は、被相続人より先に亡くなっていれば、相続人にならない（配偶者には代襲相続がない）
      const spouseIsHeir = computed(() => !!(spouse.value && spouse.value.name) && deathKind(spouse.value) !== "before");

      function isCompactDead(p) {
        return !usesPatterns.value && !!p && deathKind(p) === "before" && !!(p.substitutes && p.substitutes.length > 0);
      }

      // デモを選ぶと、入力した内容が見えるよう「被相続人・相続人」タブへ移る
      function pickDemo(index) {
        loadSample(index);
        inputTab.value = "family";
      }

      // ------------------------------------------------------------
      // タブの説明（「？」ボタンで、モーダルに表示する）
      // ------------------------------------------------------------
      // 画面には、いま開いているタブに必要な一言だけを表示し、くわしい説明は「？」を押したときだけ出す。
      const helpOpen = ref(false);
      const tabHelp = computed(() => {
        const d = docs.value;
        const withShares = d.kyogisho || d.toki;
        const H = {
          docs: {
            title: "作成する書類",
            short: "最初に、作る書類にチェックを入れてください。選んだ書類に必要な入力タブだけが、右に増えます。",
            items: [
              "作りたい書類にチェックを入れます。チェックを入れた書類に必要な入力タブだけが増えるので、不要な入力をしなくて済みます。あとからいつでも変更できます。",
              "<strong>法定相続情報一覧図</strong>：法務局（登記所）に申し出ると、法務局が保管し、認証文のついた写しを交付してもらえる図です。相続しない人も含め、法定相続人の全員が載ります。誰が何を相続するかは載りません。",
              "<strong>申出書・委任状</strong>：法定相続情報一覧図の保管及び交付を申し出るための書類です。司法書士などの代理人が申し出る場合は、委任状も作れます。",
              "<strong>相続関係説明図</strong>：相続する人に〔相続人〕、相続しない人に〔相続しない〕と書き込む図です。誰が相続するかの組み合わせ（相続パターン）ごとに1通作ります。",
              "<strong>遺産分割協議書・登記申請書</strong>：不動産などの相続財産の入力が必要になります。登記申請書は、さらに管轄の登記所の入力が必要です。",
              "<strong>印刷する通数</strong>：遺産分割協議書と相続関係説明図は、同じ内容のものを、登記所へ提出する分、相続人がそれぞれ保管する分など、複数通ほしいことがあります。チェックの下の「印刷する通数」で設定すると、その通数が印刷されます（相続関係説明図は、相続パターンごとに、設定した通数ずつ）。書類を表示した画面でも変更できます。"
            ]
          },
          family: {
            title: "被相続人・相続人",
            short: "亡くなった方（被相続人）と、相続人になる可能性のある人を、相続しない人も含めて全員入力します。",
            items: [
              "被相続人ごとに、相続する可能性のある人（推定相続人）を、<u>相続しない人も含めて全員</u>入力します。法定相続情報一覧図と相続関係説明図は、この内容から作られます。",
              "各人のカードの見出しにある氏名は、そのまま書き換えられます。続柄・出生・住所などは、カードをクリックすると開く入力欄に入力します。デモを選んだあとは、氏名を書き換えるだけで、そのまま自分用の入力の出発点にできます。",
              "続柄は、カッコ（　）が自動で付きます。「長男」「妻」のように、中身だけを入力してください。",
              "被相続人を追加するには、画面上部の色のついた枠の「追加」を押し、モーダルで、「死亡」にチェックを入れた関係者（または「それ以外」）を選びます。新しい被相続人の入力欄は新しくなり、引き継ぐのは関係者（人）の情報だけです（作成する書類・相続財産・日付などは引き継ぎません）。被相続人が2人以上になると、「追加」の隣に「削除」が出ます。",
              "亡くなった相続人（先に亡くなった方など）のカードにある「この方を被相続人とする手続も作る」にチェックを入れると、その方を被相続人とする新しい手続が作られ、その方の子（代襲相続人）が相続人として引き継がれます。チェックを外すと、その手続は削除されます（確認が出ます）。",
              "相続人が亡くなっている場合は、その方の見出しにある「死亡」にチェックを入れ、死亡年月日を入力します。被相続人より先に亡くなっていれば代襲相続、被相続人の死亡後に亡くなっていれば数次相続として、<strong>日付から自動で判定</strong>されます。代襲にならない方には、代襲相続人を入力させません。",
              "日付は、元号をプルダウンで選び、年・月・日の数字だけを入力します。ありえない日付（13月、2月30日、昭和65年、未来の日付など）は入力できません。登記の申請日と、法定相続情報一覧図の申出日は令和のみで、過去の日付では入力できません。",
              "法定相続情報一覧図だけを作る場合、代襲相続で先に亡くなった方（被代襲者）は、図に「（被代襲者）」と死亡年月日だけが表示されます。そのため、この方については、見分けるための氏名と死亡年月日だけを入力すれば足ります。"
            ]
          },
          pattern: {
            title: "相続パターン",
            short: d.setsumeizu && !withShares
              ? "相続関係説明図は、「誰が相続するか」の組み合わせ（相続パターン）ごとに1通作ります。"
              : "「誰が、どの財産を、どれだけの割合で相続するか」の組み合わせを、パターンとして作ります。",
            items: withShares ? [
              "相続パターンは、「誰が、どの財産を、どれだけの割合で相続するか」の組み合わせです。財産ごとに相続する人が違う場合は、パターンを分けます（画面上部の「相続パターン」で、切り替え・追加ができます）。",
              "相続関係説明図では、相続する人に〔相続人〕、相続しない人に〔相続しない〕と記載されます。相続しない人（相続放棄をした人、または遺産分割で他の人が取得する場合）は、チェックを外してください。",
              "共有で相続する場合は、取得割合（持分）も入力します。同じ親をもつ相続人どうしで、合計が1になるように入力します。「均等に分ける」「法定相続分で入力」のボタンも使えます。",
              "相続する財産は、「相続財産」タブで、どのパターンで相続するかを選びます。<strong>登記所は関係ありません</strong>（登記所は「登記所・登記申請書」タブで入力します）。"
            ] : [
              "相続関係説明図は、「誰が相続するか」の組み合わせ（相続パターン）ごとに、1通ずつ作られます。たとえば、不動産Aは長男、不動産Bは長女が相続する場合は、パターンを2つに分けて、それぞれの相続関係説明図を作ります。",
              "相続関係説明図では、相続する人に〔相続人〕、相続しない人（相続放棄をした人、または遺産分割で他の人が取得する場合）に〔相続しない〕と記載されます。<strong>相続しない人のチェックを外してください</strong>。",
              "相続する人の組み合わせが同じパターンは、1通の相続関係説明図にまとまります。パターンは、画面上部の「相続パターン」で、切り替え・追加ができます。",
              "法定相続情報一覧図には、誰が相続するかは載らないので、パターンの影響を受けません。"
            ]
          },
          assets: {
            title: "相続財産",
            short: "不動産・預貯金などの相続財産を入力し、それぞれをどの相続パターンで相続するかを選びます。",
            items: [
              "不動産・預貯金などの相続財産を、1つの一覧に入力します。それぞれを、どの相続パターン（誰が相続するか）で相続するかを選びます。",
              "不動産の所在は、「郵便番号」を入れるか、「都道府県」「市区町村」のプルダウンで選ぶと、所在の先頭に入ります。都道府県のプルダウンの先頭には、すでに入力した住所・本籍の都道府県が出ます。都道府県を替えると、前の都道府県の市区町村は外れます。同じカードの「管轄の登記所」に、市区町村から判定した登記所が自動で入ります。",
              "遺産分割協議書で分割する不動産と、登記申請書で登記を申請する不動産は、同じものです。",
              "登記所は、「登記所・登記申請書」タブで入力します。"
            ]
          },
          office: {
            title: "登記所・登記申請書",
            short: "不動産ごとの管轄登記所を入力します。登記所ごとに、登記申請書が作られます。",
            items: [
              "不動産ごとの管轄登記所を入力します。<strong>相続する人の組み合わせと登記所ごとに、登記申請書が1通ずつ</strong>作られます。",
              "登記所は、所在の市区町村から、管轄の登記所が自動で選ばれます（法務局・地方法務局、本局・支局・出張所のプルダウンで、選び直すこともできます）。複数の登記所にまたがる市（地番で決まる）は、候補が出ます。",
              "管轄は、誰がどれだけ相続するかには関係しません（どの登記所でも持分は同じです）。"
            ]
          },
          info: {
            title: "各書類の情報",
            short: "作成日・作成者などの、書類に記載する事項を入力します。",
            items: [
              "作成日・作成者・申出書・遺産分割協議書などの記載事項を入力します。",
              "日付は、年と月が自動で入ります。1つ入力して「他の日付にコピー」を押すと、すべての日付欄に反映されます。"
            ]
          },
          ledger: {
            title: "個体・履歴",
            short: "人物と不動産を、手続をまたいで「同じもの」として管理します。住所の変更や名義の変動を、日付をつけて残せます。",
            items: [
              "<strong>人物</strong>：被相続人を追加するときに、同じ人は同じ人として引き継がれます。手続によって氏名・生年月日・住所が食い違っていれば、ここで知らせ、そろえられます。",
              "<strong>住所などの履歴</strong>：転居・改姓などを日付つきで入力できます。時系列に並び、履歴の住所を各手続へ反映できます（相続人は最新の住所、被相続人は死亡した日の住所）。",
              "<strong>不動産</strong>：相続財産に入力した土地・建物を、個体として管理します。被相続人を追加するとき、その人が取得する不動産は、同じ不動産として引き継がれます。名義の流れは、被相続人の死亡日の順に並び、前の手続と持分が合わないときは知らせます。",
              "<strong>同一人物の候補</strong>：氏名と生年月日が同じ人が、別の人として入っているときは、まとめるかどうかを選べます。自動ではまとめません。",
              "ここで入力した履歴は、保存ファイルに入ります。手続の入力から分かる相続の流れは、保存せず、そのつど計算します。"
            ]
          }
        };
        return H;
      });
      const currentHelp = computed(() => tabHelp.value[activeInputTab.value] || tabHelp.value.docs);
      const tabHelpShort = computed(() => currentHelp.value.short);
      function openHelp() { helpOpen.value = true; }
      function closeHelp() { helpOpen.value = false; }

      // ------------------------------------------------------------
      // ブラウザの「戻る」ボタンで、書類の表示から入力欄へ戻れるようにする
      // ------------------------------------------------------------
      // 書類を表示するたびにURLの # 部分（例：#ichiranzu）を変える。入力欄から書類へ移るときだけ
      // 履歴を1つ積み、書類どうしの切り替えでは積まない（戻るボタン1回で、入力欄に戻れる）。
      let navPushed = false;      // 入力欄から書類へ移ったときに、履歴を積んだか
      let savedScrollY = 0;       // 入力欄のスクロール位置（戻ったときに復元する）
      function hashView() { return String(window.location.hash || "").replace(/^#/, ""); }
      function safeScrollTo(y) {
        try { if (typeof window.scrollTo === "function") window.scrollTo(0, y); } catch (e) { /* 無視 */ }
      }
      function syncHashToView() {
        const want = currentView.value === "preview" ? docType.value : "";
        const have = hashView();
        if (want === have) return;
        try {
          if (want === "") {                       // 書類 → 入力欄
            if (navPushed) { navPushed = false; window.history.back(); }
            else window.location.replace("#");
          } else if (have === "") {                // 入力欄 → 書類（履歴を1つ積む）
            navPushed = true;
            window.location.hash = want;
          } else {                                 // 書類 → ほかの書類（履歴は積まない）
            window.location.replace("#" + want);
          }
        } catch (e) { /* 履歴を操作できない環境では、画面の切り替えだけを行う */ }
      }
      function onHashChange() {
        const hv = hashView();
        if (!hv) {                                  // 戻るボタンなどで、入力欄へ
          navPushed = false;
          if (currentView.value !== "input") currentView.value = "input";
          return;
        }
        navPushed = true;
        if (docAvailable(hv)) {
          if (!(currentView.value === "preview" && docType.value === hv)) showPreview(hv);
        } else if (currentView.value !== "input") {
          currentView.value = "input";
        }
      }
      watch([currentView, docType], (nv, ov) => {
        if (ov && ov[0] === "input" && nv[0] === "preview") { savedScrollY = window.pageYOffset || 0; nextTick(() => safeScrollTo(0)); }
        if (ov && ov[0] === "preview" && nv[0] === "input") { nextTick(() => safeScrollTo(savedScrollY)); }
        syncHashToView();
      });
      // 日付欄: 年と月は現在の日付を自動で入れ、日だけ空欄にする（後から訂正できる）
      function todayWarekiPrefix() {
        const n = new Date();
        return "令和" + (n.getFullYear() - 2018) + "年" + (n.getMonth() + 1) + "月〇日";
      }
      function isBlankDate(v) { return !v || /^令和〇年〇月〇日$/.test(String(v).trim()); }
      function fillDateDefaults() {
        const t = todayWarekiPrefix();
        const f = (obj, key) => { if (isBlankDate(obj[key])) obj[key] = t; };
        f(creator.value, "date"); f(filing.value, "applicationDate"); f(filing.value, "delegationDate");
        f(registration.value, "applicationDate"); f(registration.value, "delegationDate"); f(agreement.value, "date");
      }
      // 1つの日付を、他の書類の日付欄すべてにコピーする
      function copyDateToAll(v) {
        if (!v) return;
        creator.value.date = v; filing.value.delegationDate = v;
        registration.value.delegationDate = v; agreement.value.date = v;
        // 申請日（登記）・申出日（法定相続情報一覧図）は、過去の日付では申請できないので、過去の日付はコピーしない
        const pj = parseJa(v);
        const past = pj ? checkJaDate(pj, { minToday: true }) : "";
        if (past) {
          notice.value = { open: true, title: "コピーできなかった日付欄があります", lines: ["登記の申請日と、法定相続情報一覧図の申出日には、この日付をコピーしませんでした。" + past + "。"] };
        } else {
          filing.value.applicationDate = v; registration.value.applicationDate = v;
        }
      }
      // 申請日（登記）・申出日が、過去の日付になっていたら、今月に直す（過去の日付では申請できないため）
      function fixPastApplicationDates() {
        const fixed = [];
        const t = todayWarekiPrefix();
        [[registration.value, "applicationDate", "登記の申請日"], [filing.value, "applicationDate", "法定相続情報一覧図の申出日"]].forEach(([obj, key, label]) => {
          const pj = parseJa(obj[key]);
          if (pj && checkJaDate(pj, { minToday: true })) { obj[key] = t; fixed.push(label); }
        });
        return fixed;
      }
      // ------------------------------------------------------------
      // 代理人は、親族（相続人）が代表して手続することがほとんどなので、入力済みの氏名から選べる。
      // それ以外の人（司法書士・弁護士など）は、「それ以外の人」を選んでから、住所・氏名を入力する。
      // ------------------------------------------------------------
      const agentCandidates = computed(() => listHeirs()
        .filter((h) => (h.name || "").trim())
        .map((h) => ({ id: String(h.id), label: (h.role ? h.role + "　" : "") + h.name, name: h.name, addr: h.addr || "" })));
      function inferAgentPick(name) { return name && !/〇/.test(name) ? "other" : ""; }
      function agentPersonOf(pick) { return agentCandidates.value.find((c) => c.id === pick) || null; }
      // 選んだ人の氏名・住所を、代理人の欄に入れる
      function pickAgent(obj, nameKey, addrKey, pick) {
        const prev = obj.pick !== undefined ? obj.pick : obj.agentPick;
        const key = obj.pick !== undefined ? "pick" : "agentPick";
        obj[key] = pick;
        const c = agentPersonOf(pick);
        if (c) { obj[nameKey] = c.name; obj[addrKey] = c.addr; }
        else if (pick === "other" && agentPersonOf(prev)) { obj[nameKey] = ""; obj[addrKey] = ""; }   // 相続人から切り替えたときは、空にして入力してもらう
      }
      function onCreatorAgentPick(pick) { pickAgent(creator.value, "agentName", "agentAddr", pick); }
      function onTokiAgentPick(pick) { pickAgent(registration.value.agent, "name", "address", pick); }
      // 選んだ相続人の氏名・住所を書き換えたら、代理人の欄にも反映する。選んだ人がいなくなったら、選択を外す
      function syncAgentPicks() {
        const c = creator.value, a = registration.value.agent;
        if (c.agentPick && c.agentPick !== "other") {
          const p = agentPersonOf(c.agentPick);
          if (p) { c.agentName = p.name; c.agentAddr = p.addr; } else c.agentPick = "";
        }
        if (a.pick && a.pick !== "other") {
          const p = agentPersonOf(a.pick);
          if (p) { a.name = p.name; a.address = p.addr; } else a.pick = "";
        }
      }
      watch(agentCandidates, syncAgentPicks, { deep: true });
      // 登記申請を代理人に依頼することにしたら、委任状も作成対象にする
      function onTokiAgentToggle() {
        if (registration.value.agent.enabled) docs.value.toukiIninjo = true;
      }
      // 法定相続情報一覧図（申出）の代理人と同じ人に、登記申請も依頼する場合
      function copyAgentFromIchiranzu() {
        registration.value.agent.name = creator.value.agentName || "";
        registration.value.agent.address = filing.value.agentOffice || creator.value.agentAddr || "";
        registration.value.agent.pick = creator.value.agentPick || "";
      }
      // 申出書の利用目的に「不動産登記」が入ったら、登記申請書も自動で選択する
      function onPurposeRealEstateChange() {
        if (filing.value.purposeRealEstate && docs.value.ichiranzu) docs.value.toki = true;
      }
      function patternLabel(pt) {
        const names = acquirersOf(pt).map((a) => a.name || "未入力").join("、");
        return pt.name + "：" + (names || "取得者なし");
      }
      function zen(n) {
        return String(n).replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xFEE0));
      }
      // 遺産分割協議書：不動産を取得者（相続パターン）ごとにまとめる
      const kyogishoNos = computed(() => {
        let n = kyogishoGroups.value.length;
        const other = 0;   // 預貯金などは相続財産の一覧に統一したため、別の条は設けない
        const future = agreement.value.futureHeirId ? ++n : 0;
        return { other, future };
      });
      const kyogishoSigners = computed(() => listHeirs());
      // 遺産分割協議書の署名欄: 未成年者・成年被後見人は法定代理人（特別代理人など）が署名押印する
      const kyogishoSignerList = computed(() => kyogishoSigners.value.map((h) => ({ person: h, info: applicantInfo(h) })));
      // 登記申請書の申請人（取得者）の一覧。複数の登記申請書に出る人も1人として扱う。
      const applicantList = computed(() => {
        const seen = {}, out = [];
        applications.value.forEach((ap) => ap.acquirers.forEach((a) => {
          if (!seen[a.id]) { seen[a.id] = true; out.push(a); }
        }));
        return out;
      });
      // 「A、B及びC」のように名前を並べる
      function joinNames(names) {
        if (names.length <= 1) return names.join("");
        return names.slice(0, -1).join("、") + "及び" + names[names.length - 1];
      }
      function futureHeirName() {
        const h = listHeirs().find((x) => String(x.id) === String(agreement.value.futureHeirId));
        return h ? (h.name || "〇〇") : "";
      }
      // 不動産の表示（登記事項証明書のとおりに記載する）。土地・建物・区分建物で記載事項が異なる。
      //   不動産番号を記載した場合は、所在・地番等の記載を省略できる（法務局の記載例）。
      function kyoKindWord(g) { return g.properties.every(isRealEstate) ? "不動産" : "財産"; }
      function propertyLines(pr) {
        if (!isRealEstate(pr)) return [assetKindLabel(pr) + "　" + (assetSummary(pr) || "（内容を入力してください）")];
        const lines = [];
        if (pr.number) lines.push("不動産番号　" + pr.number);
        if (pr.number && registration.value.omitDetailsWithNumber) return lines;
        if (pr.kind === "land") {
          lines.push("所　　在　" + (pr.location || ""), "地　　番　" + (pr.lotNo || ""),
            "地　　目　" + (pr.category || ""), "地　　積　" + areaText(pr.area));
        } else if (pr.kind === "building") {
          lines.push("所　　在　" + (pr.location || ""), "家屋番号　" + (pr.lotNo || ""), "種　　類　" + (pr.category || ""),
            "構　　造　" + (pr.structure || ""), "床 面 積　" + areaText(pr.area));
        } else {
          // 区分建物（マンション等）: 一棟の建物の表示、専有部分の建物の表示、敷地権の表示
          lines.push("一棟の建物の表示", "　所　　在　" + (pr.location || ""));
          if (pr.buildingName) lines.push("　建物の名称　" + pr.buildingName);
          lines.push("専有部分の建物の表示", "　家屋番号　" + (pr.lotNo || ""));
          if (pr.unitName) lines.push("　建物の名称　" + pr.unitName);
          lines.push("　種　　類　" + (pr.category || ""), "　構　　造　" + (pr.structure || ""), "　床 面 積　" + areaText(pr.area));
          if (pr.hasSiteRight) {
            lines.push("敷地権の表示");
            pr.siteRights.forEach((sr) => {
              lines.push("　土地の符号　" + (sr.symbol || ""), "　所在及び地番　" + (sr.location || "") + (sr.lotNo || ""),
                "　地　　目　" + (sr.category || ""), "　地　　積　" + areaText(sr.area),
                "　敷地権の種類　" + (sr.right || "所有権"), "　敷地権の割合　" + (sr.ratio || ""));
            });
          }
        }
        return lines;
      }

      // 取得割合の合計（同じ親をもつ兄弟どうしの単位ごとに、合計が1になる必要がある）
      function sharesStatus(pattern) {
        let needed = false, ok = true, missing = 0;
        const totals = [];
        shareGroups(pattern).forEach((g) => {
          if (g.members.length < 2) return;
          needed = true;
          let n = 0, d = 1;
          g.members.forEach((p) => {
            const sh = parseShare(getShare(pattern, p));
            if (!sh) { missing++; return; }
            n = n * sh.d + sh.n * d; d = d * sh.d;
            const gg = gcd(n, d); n /= gg; d /= gg;
          });
          totals.push(n + "/" + d);
          if (n !== d) ok = false;
        });
        if (missing) ok = false;
        return { needed, ok, missing, total: totals.join("、") };
      }
      function splitEqually(pattern) {
        shareGroups(pattern).forEach((g) => { if (g.members.length > 1) g.members.forEach((p) => setShare(pattern, p, "1/" + g.members.length)); });
      }
      function acquirerText(group) {
        const t = unitText(group.pattern, estateUnits());
        return t || "（取得者が選択されていません）";
      }
      function patternHeirsText(pt) {
        const units = estateUnits();
        if (acquirersOf(pt).length === 0) return "（誰も相続しない）";
        const all = !anyNotInheriting(pt, units);
        return (all && units.length > 1 ? "全員：" : "") + unitText(pt, units);
      }
      function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }
      // 持分の入力は、アラビア数字でも、「万」などの単位・漢数字でも読み取る。
      //   例：1/2　１／２　2分の1　二分の一　10000分の123　1万分の123　一万分の百二十三　1万2千分の5
      const KANJI_DIGIT = { "〇": 0, "零": 0, "一": 1, "壱": 1, "二": 2, "弐": 2, "三": 3, "参": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
      const KANJI_UNIT = { "十": 10, "百": 100, "千": 1000 };
      const KANJI_BIG = { "万": 10000, "億": 100000000 };
      // 「1万2千」「一万」「10,000」「百二十三」などを整数にする（読めなければ null）
      function parseJaInt(str) {
        const t = String(str || "").replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace(/[,，\s]/g, "");
        if (!t) return null;
        let total = 0, section = 0, num = null;
        for (const ch of t) {
          if (/[0-9]/.test(ch)) { num = (num === null ? 0 : num) * 10 + Number(ch); }
          else if (ch in KANJI_DIGIT) { num = (num === null ? 0 : num) * 10 + KANJI_DIGIT[ch]; }
          else if (ch in KANJI_UNIT) { section += (num === null ? 1 : num) * KANJI_UNIT[ch]; num = null; }
          else if (ch in KANJI_BIG) { const v = section + (num === null ? 0 : num); total += (v === 0 ? 1 : v) * KANJI_BIG[ch]; section = 0; num = null; }
          else return null;
        }
        return total + section + (num === null ? 0 : num);
      }
      function parseShare(str) {
        let t = String(str || "").replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace(/[／]/g, "/").replace(/\s/g, "").replace(/^持分/, "");
        let n = null, d = null, m;
        if ((m = t.match(/^(.+?)分の(.+)$/))) { d = parseJaInt(m[1]); n = parseJaInt(m[2]); }
        else if ((m = t.match(/^(.+?)\/(.+)$/))) { n = parseJaInt(m[1]); d = parseJaInt(m[2]); }
        if (!n || !d || n <= 0 || n > d) return null;
        return { n, d };
      }
      // 入力した持分を、どう読み取ったかの表示（入力欄の下に出す）
      function shareInterpret(str) {
        if (!String(str || "").trim()) return "";
        const sh = parseShare(str);
        return sh ? "→ " + yen(sh.d) + "分の" + yen(sh.n) + " として読み取りました" : "⚠ 読み取れません（例：1/2、2分の1、1万分の123）";
      }
      function getShare(pattern, person) { return (pattern.shares && pattern.shares[person.id]) || ""; }
      function setShare(pattern, person, v) {
        if (!pattern.shares) pattern.shares = {};
        pattern.shares[person.id] = v;
      }
      // 取得者が2人以上（共有名義）のとき、持分の合計が1になっているかを調べる
      function shareLabel(str) {
        const sh = parseShare(str);
        return sh ? "持分" + zen(sh.d) + "分の" + zen(sh.n) : "持分〇分の〇";
      }
      function areaText(v) {
        const t = String(v || "").trim();
        return /^[0-9.,]+$/.test(t) ? t + "㎡" : t;
      }
      function yen(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
      function toInt(v) { return parseInt(String(v || "").replace(/[,，\s]/g, ""), 10) || 0; }

      // 登録免許税（相続による所有権の移転）:
      //   課税価格 = 不動産の価額（固定資産評価額）の合計（1,000円未満切捨て）
      //              ・共有持分の移転なら「移転する持分の価額」
      //              ・敷地権付区分建物なら、建物の価額に敷地権の価額を加えた額
      //   税額     = 課税価格 × 4/1000（100円未満切捨て。1,000円未満なら1,000円）
      //   免税     = 課税価格（評価額の1,000円未満切捨て）が100万円以下の土地（租税特別措置法84条の2の3第2項。
      //              適用期限は令和9年3月31日）。建物・区分建物は対象外。
      // ------------------------------------------------------------
      // 免税の要件・法定代理人（未成年者・成年被後見人）
      // ------------------------------------------------------------
      // 「令和〇年〇月〇日」「令和8年10月8日」などの和暦文字列を日付にする（読めなければ null）。
      function parseWareki(str) {
        if (!str) return null;
        const t = String(str).replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace(/\s/g, "");
        const m = t.match(/(令和|平成|昭和|大正|明治)(元|\d+)年(\d+)月(\d+)日/);
        if (!m) return null;
        const base = { "令和": 2018, "平成": 1988, "昭和": 1925, "大正": 1911, "明治": 1867 }[m[1]];
        const y = (m[2] === "元" ? 1 : parseInt(m[2], 10)) + base;
        const d = new Date(y, parseInt(m[3], 10) - 1, parseInt(m[4], 10));
        return isNaN(d.getTime()) ? null : d;
      }
      const EXEMPT_DEADLINE = new Date(2027, 2, 31, 23, 59, 59);   // 令和9年3月31日
      // 租税特別措置法第84条の2の3第2項（価額100万円以下の土地）の要件を判定する
      function exemptionCheck(pr, v, apply, dateStr) {
        if (!apply) return { applies: false, reason: "免税の計算をオフにしています" };
        if (pr.kind !== "land") return { applies: false, reason: "土地ではないため対象外です（建物・区分建物は免税の対象外）" };
        if (v <= 0) return { applies: false, unknown: true, reason: "評価額（持分の価額）が未入力です" };
        // 100万円以下かどうかは、登録免許税の課税価格（評価額の1,000円未満を切り捨てた額）で判定する
        const taxable = Math.floor(v / 1000) * 1000;
        if (taxable > 1000000) return { applies: false, reason: "課税価格（千円未満切り捨て）が" + yen(taxable) + "円で、100万円を超えるため対象外です" };
        const d = parseWareki(dateStr);
        if (d && d.getTime() > EXEMPT_DEADLINE.getTime()) return { applies: false, reason: "申請日が適用期限（令和9年3月31日）を過ぎるため対象外です" };
        return { applies: true, reason: "課税価格100万円以下の土地として非課税" + (d ? "" : "（申請日が未入力のため、期限は未確認）") };
      }
      function exemptionStatus(pr) {
        return exemptionCheck(pr, propertyValue(pr), registration.value.applyExemption, registration.value.applicationDate);
      }
      // 相続人の法的な状況: none=通常 / minor=未成年者 / ward=成年被後見人 / curatee=被保佐人・被補助人
      function legalLabel(status) {
        return { minor: "未成年者", ward: "成年被後見人" }[status] || "";
      }
      function hasLegalRep(person) {
        const st = applicantInfo(person).status;
        return st === "minor" || st === "ward";
      }
      function ageOf(person, atDate) {
        const b = parseWareki(person && person.birth);
        if (!b) return null;
        let age = atDate.getFullYear() - b.getFullYear();
        const before = atDate.getMonth() < b.getMonth() || (atDate.getMonth() === b.getMonth() && atDate.getDate() < b.getDate());
        return before ? age - 1 : age;
      }
      // 生年月日から未成年者（18歳未満）の可能性があるのに、状況が「通常」のまま
      function possibleMinor(person) {
        if (applicantInfo(person).status !== "none") return false;
        const at = parseWareki(registration.value.applicationDate) || new Date();
        const age = ageOf(person, at);
        return age !== null && age < 18;
      }
      // 遺産分割協議・登記申請書で注意が必要な相続人（未成年者・成年被後見人など）の警告
      const legalWarnings = computed(() => {
        const heirs = listHeirs();
        const out = [];
        heirs.forEach((h) => {
          const info = applicantInfo(h);
          if (info.status === "none" && possibleMinor(h)) {
            out.push({ id: h.id, text: (h.name || "未入力") + "：生年月日から未成年者（18歳未満）の可能性があります。該当する場合は「相続人の状況」を「未成年者」にしてください。" });
          }
          if (info.status === "minor" || info.status === "ward") {
            if (!(info.repName || "").trim()) out.push({ id: h.id, text: (h.name || "未入力") + "：法定代理人の氏名が未入力です。" });
            const repIsHeir = (info.repRole === "親権者" || info.repRole === "成年後見人") &&
              heirs.some((o) => o !== h && (o.name || "").trim() && o.name === info.repName);
            if (repIsHeir && docs.value.kyogisho) {
              out.push({ id: h.id, text: (h.name || "未入力") + "：" + info.repRole + "（" + info.repName + "）も相続人のため、遺産分割協議は利益相反になります。家庭裁判所で特別代理人を選任してください。" });
            }
          }
        });
        return out;
      });

      // 入力する価額が「被相続人の持分だけの価額」か（共有持分で、市区町村が持分ごとに価格を出している場合）
      function valueIsShareBasis(pr) { return pr.rightKind === "share" && pr.valueBasis === "share"; }
      function assessedLabel(pr) {
        const sb = valueIsShareBasis(pr);
        if (pr.kind === "unit") return "固定資産税評価額（専有部分の建物" + (sb ? "・被相続人の持分だけの価額" : "") + "・円）";
        return "固定資産税評価額（" + (sb ? "被相続人の持分だけの価額" : "不動産全体の価額") + "・円）";
      }
      // 移転する持分（holding）の価額。
      //   不動産全体の価額を入力したとき … 全体の価額 × 移転する持分
      //   持分だけの価額を入力したとき  … 入力した価額（被相続人の持分の価額）。数次相続の段階などで、移転する持分が
      //                                    被相続人の持分と違うときは、その割合で按分する
      function propertyValue(pr, holding) {
        let v = toInt(pr.assessedValue);
        if (pr.kind === "unit" && pr.hasSiteRight) v += toInt(pr.landRightValue);
        const own = pr.rightKind === "share" ? parseShare(pr.deceasedShare) : { n: 1, d: 1 };
        const h = holding !== undefined ? holding : own;
        if (!h) return 0;            // 持分が未入力・不正なら計算不能
        if (valueIsShareBasis(pr)) {
          if (!own) return 0;
          if (h.n * own.d !== own.n * h.d) v = Number(BigInt(v) * BigInt(h.n) * BigInt(own.d) / (BigInt(h.d) * BigInt(own.n)));
          return v;
        }
        if (h.n !== h.d) v = Math.floor(v * h.n / h.d);
        return v;
      }
      // ctxFn(pr) → { holding, dead }: holding=被相続人が持っていた割合、dead=亡くなった相続人の名義にする分の割合
      function calcRegistrationTax(properties, applyExemption, applicationDate, ctxFn) {
        let taxable = 0, unknown = false;
        const exemptProps = [], clause1Props = [];
        properties.forEach((pr) => {
          const c = ctxFn ? ctxFn(pr) : { holding: undefined, dead: null };
          const v = propertyValue(pr, c.holding);
          if (v <= 0) { unknown = true; return; }
          if (exemptionCheck(pr, v, applyExemption, applicationDate).applies) { exemptProps.push(pr); return; }
          let t = v;
          if (c.dead && exemptionClause1(pr, applyExemption, applicationDate)) {
            t = Math.floor(v * (c.dead.d - c.dead.n) / c.dead.d);
            clause1Props.push(pr);
          }
          taxable += t;
        });
        const base = Math.floor(taxable / 1000) * 1000;
        let tax = Math.floor((base * 4 / 1000) / 100) * 100;
        if (base > 0 && tax < 1000) tax = 1000;
        return {
          base, tax, unknown, exemptProps, clause1Props,
          clause1: clause1Props.length > 0, clause2: exemptProps.length > 0,
          allExempt: base === 0 && !unknown && (exemptProps.length + clause1Props.length) > 0
        };
      }
      function propertyTaxLine(pr, holding) {
        const base = toInt(pr.assessedValue);
        if (base <= 0) return "";
        let total = base, text = yen(base) + "円";
        if (pr.kind === "unit" && pr.hasSiteRight) {
          const l = toInt(pr.landRightValue);
          total = base + l;
          text = "建物 " + yen(base) + "円 + 敷地権 " + yen(l) + "円 = " + yen(total) + "円";
        }
        const h = holding !== undefined ? holding : (pr.rightKind === "share" ? parseShare(pr.deceasedShare) : { n: 1, d: 1 });
        if (valueIsShareBasis(pr)) {
          const own = parseShare(pr.deceasedShare);
          text = "持分の価額 " + text;
          if (h === null || own === null) text += "（被相続人の持分が未入力）";
          else if (h.n * own.d !== own.n * h.d) text += " × 移転する持分" + zen(h.d) + "分の" + zen(h.n) + "（被相続人の持分" + zen(own.d) + "分の" + zen(own.n) + "に対する割合）= " + yen(propertyValue(pr, h)) + "円";
          return text;
        }
        if (h === null) text += " × 被相続人の持分（未入力）";
        else if (h.n !== h.d) text += " × 持分" + zen(h.d) + "分の" + zen(h.n) + " = " + yen(propertyValue(pr, h)) + "円";
        return text;
      }
      // 不動産の種類: land=土地, building=建物, unit=区分建物（マンション等の専有部分）
      // 相続財産（不動産・預貯金・その他）は1つの一覧に一元化する。
      // 不動産（土地・建物・区分建物）は、遺産分割協議書と登記申請書の両方に使い、
      // 預貯金・その他は遺産分割協議書にだけ載る。
      function newAsset(kind, office, otherKind) {
        return {
          id: "prop_" + Math.random().toString(36).slice(2, 8),
          kind: kind || "land", office: office || "", coOwners: [],
          number: "", location: "", lotNo: "", category: "", structure: "", area: "",
          assessedValue: "", patternId: activePatternId.value,
          rightKind: "full",      // full=所有権全部 / share=共有持分（被相続人が共有者の1人だった場合）
          deceasedShare: "",      // 被相続人の持分（例 1/2）
          valueBasis: "whole",    // 共有持分のときの、入力する価額の基準: whole=不動産全体の価額 / share=被相続人の持分だけの価額
          // 区分建物
          buildingName: "", unitName: "", hasSiteRight: true, landRightValue: "",
          siteRights: kind === "unit" ? [{ symbol: "1", location: "", lotNo: "", category: "宅地", area: "", right: "所有権", ratio: "" }] : [],
          assetName: "",          // 預貯金・その他（それ以外）の財産の内容
          // その他の財産の種類: stock=株式 / car=自動車 / other=それ以外
          otherKind: kind === "other" ? (otherKind || "other") : "",
          stockIssuer: "", stockCount: "", stockInstitution: "",        // 株式: 銘柄（会社名）・株数・預けている証券会社など
          carName: "", carRegNo: "", carVin: "",                        // 自動車: 車名・登録番号・車台番号
          postal: ""                                                     // 不動産の所在地の郵便番号（都道府県の選択に使う）
        };
      }
      // 読み込んだ財産に、足りない項目（その他の財産の種類など）を補う
      function fixAsset(pr) {
        if (!pr || typeof pr !== "object") return null;
        if (pr.kind === "other" && !pr.otherKind) pr.otherKind = "other";
        const d = { stockIssuer: "", stockCount: "", stockInstitution: "", carName: "", carRegNo: "", carVin: "", postal: "" };
        Object.keys(d).forEach((k) => { if (pr[k] === undefined) pr[k] = d[k]; });
        if (!Array.isArray(pr.coOwners)) pr.coOwners = [];      // すでに共有者として登記されている相続人 [{ id, rank }]
        if (pr.otherKind === undefined) pr.otherKind = "";
        if (pr.valueBasis !== "share") pr.valueBasis = "whole";      // 古いファイルは、不動産全体の価額
        return pr;
      }
      const REAL_ESTATE_KINDS = ["land", "building", "unit"];
      function isRealEstate(pr) { return REAL_ESTATE_KINDS.includes(pr.kind); }
      // ------------------------------------------------------------
      // 不動産の所在地: 都道府県のプルダウン・郵便番号との連動
      // ------------------------------------------------------------
      const Offices = window.AppModules.Offices;
      const prefRegions = Offices.REGIONS;
      function prefOf(pr) { return Offices.detectPref(pr.location); }
      // 所在・住所の文字列を作る部品は js/addressTools.js（郵便番号から、都道府県・市区町村・字名まで入れる。通信しない）
      const AT = window.AppModules.AddressTools;
      const canonicalCity = AT.canonicalCity;
      // 所在の先頭の都道府県を、選んだものに替える（外すときは、都道府県だけを取る）
      function setPref(pr, name) { pr.location = AT.setPref(pr.location, name); }
      // 所在の先頭の市区町村（プルダウンの値）。なければ ""
      function muniOf(pr) { const pf = prefOf(pr); return pf ? Offices.municipalityOf(pf, pr.location).text : ""; }
      function muniGroups(pr) { return Offices.municipalityGroups(prefOf(pr)); }
      // 市区町村を選ぶ（所在の、都道府県のあとの市区町村を替える。見本の「〇市」は外す）
      function setMunicipality(pr, text) {
        const pf = prefOf(pr);
        if (!pf) return;
        let rest = Offices.afterPref(pr.location).replace(/^\s+/, "");
        const cur = Offices.municipalityOf(pf, rest);
        if (cur.len) rest = rest.slice(cur.len);
        else rest = rest.replace(/^〇(市|区|町|村|郡)?/, "");
        pr.location = pf + (text || "") + rest;
      }
      // 郵便番号を入力すると、都道府県・市区町村・字名を、所在に自動で入れる
      function onPostalInput(pr, ev) {
        pr.postal = Offices.formatPostal(ev.target.value);
        ev.target.value = pr.postal;
        pr.location = AT.fillFromPostal(pr.location, pr.postal);
      }
      // 以前に入力した住所（被相続人 → 相続人 → 代理人 の順。重複と、見本のままの住所は除く）。住所の入力欄の「複写」で選べる
      const knownAddresses = computed(() => {
        const out = [];
        const add = (t) => { const a = String(t || "").trim(); if (a && !/^〇/.test(a) && !out.includes(a)) out.push(a); };
        add(deceased.value.lastAddr);
        const walk = (p) => { if (!p) return; add(p.addr); (p.substitutes || []).forEach(walk); };
        walk(spouse.value); children.value.forEach(walk); siblings.value.forEach(walk); parents.value.forEach(walk);
        add(creator.value.agentAddr); add(registration.value.agent.address);
        Object.keys(registration.value.applicants || {}).forEach((k) => add((registration.value.applicants[k] || {}).repAddr));
        return out;
      });
      provide("knownAddresses", knownAddresses);
      // すでに入力されている住所・本籍・他の財産の所在から、都道府県を、先に出す
      const prefPriority = computed(() => {
        const found = [];
        const add = (t) => { const p = Offices.detectPref(t); if (p && !found.includes(p)) found.push(p); };
        add(deceased.value.lastAddr); add(deceased.value.lastHoseki);
        const walk = (p) => { if (!p) return; add(p.addr); (p.substitutes || []).forEach(walk); };
        walk(spouse.value); children.value.forEach(walk); siblings.value.forEach(walk); parents.value.forEach(walk);
        registration.value.properties.forEach((q) => { if (isRealEstate(q)) add(q.location); });
        return found;
      });
      // 申出先の登記所を調べる住所（「申出先登記所の種別」に合わせる）
      const filingOfficeAddress = computed(() => {
        const b = filing.value.officeBasis;
        if (b === "honseki") return deceased.value.lastHoseki;
        if (b === "lastAddress") return deceased.value.lastAddr;
        if (b === "applicantAddress") return applicantPerson.value ? applicantPerson.value.addr : "";
        if (b === "realEstate") { const q = registration.value.properties.find((x) => isRealEstate(x) && x.location); return q ? q.location : ""; }
        return "";
      });
      function assetKindLabel(pr) {
        if (pr.kind === "other") return { stock: "株式", car: "自動車" }[pr.otherKind] || "その他の財産";
        return { land: "土地", building: "建物", unit: "区分建物", deposit: "預貯金" }[pr.kind] || "財産";
      }
      // 不動産以外の財産の内容（一覧・遺産分割協議書に出す文章）
      function assetSummary(pr) {
        if (pr.kind === "other" && pr.otherKind === "stock") {
          const n = (pr.stockCount || "").toString().trim();
          const base = (pr.stockIssuer || "").trim();
          return (base ? base : "") + (n ? (base ? "　" : "") + n + "株" : "")
            + ((pr.stockInstitution || "").trim() ? "（" + pr.stockInstitution.trim() + "に預けているもの）" : "");
        }
        if (pr.kind === "car") return "";
        if (pr.kind === "other" && pr.otherKind === "car") {
          const reg = (pr.carRegNo || "").trim(), vin = (pr.carVin || "").trim();
          const det = [reg ? "登録番号 " + reg : "", vin ? "車台番号 " + vin : ""].filter(Boolean).join("、");
          return ((pr.carName || "").trim()) + (det ? "（" + det + "）" : "");
        }
        return (pr.assetName || "").trim();
      }
      function addProperty(kind, otherKind, openIt) {
        const list = registration.value.properties;
        const pr = newAsset(kind, "", otherKind);
        list.push(pr);
        if (openIt) { openProps[pr.id] = true; nextTick(() => revealProperty(pr.id)); }
      }
      // ------------------------------------------------------------
      // 相続財産のカードの開閉（画面だけの状態。保存はしない）。閉じているときは、見出しに所在だけを出す
      // ------------------------------------------------------------
      const openProps = reactive({});
      function isPropOpen(pr) { return !!openProps[pr.id]; }
      function toggleProp(pr) { openProps[pr.id] = !openProps[pr.id]; }
      function setAllProps(open) { registration.value.properties.forEach((q) => { openProps[q.id] = !!open; }); }
      // 見出し（閉じているときも出る）。不動産は所在だけ。ほかの財産は内容
      function propHeading(pr) {
        const t = isRealEstate(pr) ? (pr.location || "").trim() : assetSummary(pr);
        return t || (isRealEstate(pr) ? "（所在を入力してください）" : "（内容を入力してください）");
      }
      // 追加したカードへ移り、最初の入力欄にカーソルを置く
      function revealProperty(id) {
        const el = document.getElementById("prop-" + id);
        if (!el) return;
        try { el.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { /* 無視 */ }
        const inp = el.querySelector("input[type=text]");
        if (inp) { try { inp.focus({ preventScroll: true }); } catch (e) { /* 無視 */ } }
      }
      // 狭い画面では、追加ボタンの代わりに、種類を選ぶプルダウンを使う
      function addFromSelect(ev) {
        const v = ev.target.value; ev.target.value = "";
        if (!v) return;
        const a = v.split(":");
        addProperty(a[0], a[1] || undefined, true);
      }
      // 画面上部に固定されたナビの高さ（財産を追加するボタンを、その下に固定するため）
      function measureNavHeight() {
        const nav = document.querySelector(".nav-bar");
        if (!nav) return;
        document.documentElement.style.setProperty("--nav-h", nav.offsetHeight + "px");
      }
      // 財産の種類に合うデモだけを選べるようにする（土地を追加したのに、建物のデモが出ないように）
      function assetDemosFor(pr) {
        const out = [];
        AssetDemos.forEach((d, idx) => {
          if (d.kind !== pr.kind) return;
          if (pr.kind === "other" && (d.otherKind || "other") !== (pr.otherKind || "other")) return;
          out.push({ idx, label: d.label });
        });
        return out;
      }
      // 財産のデモ入力（種類も含めて入れ替える。id と相続パターンは保つ）
      function applyAssetDemo(pr, idx) {
        const d = AssetDemos[Number(idx)];
        if (!d || d.kind !== pr.kind) return;         // 種類が違うデモは入れない
        const keep = { id: pr.id, patternId: pr.patternId };
        const fresh = newAsset(d.kind, d.office || pr.office || "", d.otherKind);
        Object.keys(pr).forEach((k) => { delete pr[k]; });
        Object.assign(pr, fresh, JSON.parse(JSON.stringify(d.fields || {})), keep);
      }
      function removeProperty(i) { registration.value.properties.splice(i, 1); }
      function addSiteRight(pr) {
        pr.siteRights.push({ symbol: String(pr.siteRights.length + 1), location: "", lotNo: "", category: "宅地", area: "", right: "所有権", ratio: "" });
      }
      function removeSiteRight(pr, i) { pr.siteRights.splice(i, 1); }
      // 申請人（取得者）の追加情報（氏名ふりがな・国籍等・メールアドレス・住民票コード）
      function defaultApplicant() {
        return { kana: "", email: "なし", nationality: "日本", juminCode: "", status: "none", repRole: "親権者", repName: "", repAddr: "" };
      }
      // ------------------------------------------------------------
      // 共有者である相続人の住所変更（更正）登記
      //   被相続人の共有持分を相続する不動産に、相続人のうち、すでに共有者として登記されている人がいて、その人の住所が登記簿と違うとき、
      //   登記名義人住所変更（引っ越したとき）または住所更正（登記の住所が誤っていたとき）の登記を、相続登記より先に、続けて申請する。
      //   相続人が単独で所有する不動産（相続の対象ではない不動産）は、扱わない。
      // ------------------------------------------------------------
      // 共有者として登記されている人にできる相続人（生存している人）
      const jushoCandidates = computed(() => listHeirs()
        .filter((h) => (h.name || "").trim() && deathKind(h) !== "after")
        .map((h) => ({ id: String(h.id), person: h, label: (h.role ? h.role + "　" : "") + h.name })));
      function coOwnerEntry(pr, id) { return (pr.coOwners || []).find((c) => String(c.id) === String(id)) || null; }
      function toggleCoOwner(pr, id, on) {
        if (!Array.isArray(pr.coOwners)) pr.coOwners = [];
        const has = coOwnerEntry(pr, id);
        if (on && !has) pr.coOwners.push({ id: String(id), rank: "" });
        if (!on && has) pr.coOwners.splice(pr.coOwners.indexOf(has), 1);
      }
      function setCoOwnerRank(pr, id, v) { const c = coOwnerEntry(pr, id); if (c) c.rank = v; }
      function addrChangeInfo(person) {
        return Object.assign({ kind: "change", moveDate: "", cause: "錯誤" }, registration.value.addrChanges[person.id]);   // moveDate: 住所を移した日（元号つき。昔のことも多いので、令和に限らない）
      }
      function setAddrChangeField(person, field, value) {
        registration.value.addrChanges[person.id] = Object.assign(addrChangeInfo(person), { [field]: value });
      }
      // 共有者として登記されている相続人（住所変更・更正の対象）。入力画面の一覧用
      const jushoPeople = computed(() => {
        const seen = {}, out = [];
        registration.value.properties.forEach((pr) => {
          if (!isRealEstate(pr) || pr.rightKind !== "share") return;
          (pr.coOwners || []).forEach((c) => {
            const cand = jushoCandidates.value.find((x) => x.id === String(c.id));
            if (cand && !seen[cand.id]) { seen[cand.id] = true; out.push(cand); }
          });
        });
        return out;
      });
      // 住所変更（更正）登記申請書の単位 = (登記名義人 × 管轄登記所 × 変更か更正か × 順位番号 × 原因)
      const jushoApplications = computed(() => {
        if (!docs.value.toki || !docs.value.jusho) return [];
        const groups = [], index = {};
        registration.value.properties.forEach((pr) => {
          if (!isRealEstate(pr) || pr.rightKind !== "share") return;
          (pr.coOwners || []).forEach((c) => {
            const cand = jushoCandidates.value.find((x) => x.id === String(c.id));
            if (!cand) return;
            const info = addrChangeInfo(cand.person);
            const office = (pr.office || "").trim();
            const rank = String(c.rank || "").trim().replace(/番$/, "");
            const cause = info.kind === "correct" ? (info.cause || "錯誤") : ((info.moveDate || "令和〇年〇月〇日") + "住所移転");
            const key = [cand.id, office, info.kind, rank, cause].join("@");
            if (!index[key]) { index[key] = { key, person: cand.person, kind: info.kind, office, rank, cause, properties: [] }; groups.push(index[key]); }
            index[key].properties.push(pr);
          });
        });
        const order = (g) => jushoCandidates.value.findIndex((x) => x.id === String(g.person.id));
        groups.sort((a, b) => order(a) - order(b));
        return groups.map((g) => Object.assign(g, {
          purpose: (g.rank || "〇") + "番登記名義人住所" + (g.kind === "correct" ? "更正" : "変更"),
          afterLabel: g.kind === "correct" ? "更正後の事項" : "変更後の事項",
          tax: g.properties.length * 1000         // 付記登記: 不動産1個につき1,000円
        }));
      });
      function applicantInfo(person) {
        return Object.assign(defaultApplicant(), registration.value.applicants[person.id]);
      }
      function setApplicantField(person, field, value) {
        registration.value.applicants[person.id] = Object.assign(applicantInfo(person), { [field]: value });
      }
      // 登記の目的: 所有権全部なら「所有権移転」、共有持分なら「○○持分全部移転」、
      // 両方を同じ登記申請書に含めるなら「所有権移転及び○○持分全部移転」（法務局のチェックリスト）
      // ------------------------------------------------------------
      // 不動産の振り分け
      // ------------------------------------------------------------
      // 不動産の情報（遺産分割協議書で分割する不動産と、登記申請書の不動産は同じもの）に、
      //   ・相続パターンと持分（＝相続パターン）
      //   ・管轄登記所
      // を持たせ、そこから機械的に書類を振り分ける。
      //   遺産分割協議書 … 相続パターン（＋持分）ごとにまとめる
      //   登記申請書     … 相続パターン（＋持分）× 管轄登記所ごとに1通
      // 「相続パターン」は、相続パターンの名前ではなく、実際の取得者と持分で
      // 判定する（別名のパターンでも、取得者と持分が同じなら同じ登記申請書にまとまる）。
      // 登記申請書の相続人（申請人）は、そのパターンで〔相続人〕と記載される人と常に同じ。
      function normShare(str) {
        const sh = parseShare(str);
        if (!sh) return String(str || "").trim();
        const g = gcd(sh.n, sh.d);
        return (sh.n / g) + "/" + (sh.d / g);
      }
      function acquirerSignature(pattern) {
        const acq = acquirersOf(pattern);
        const multi = acq.length > 1;
        const sig = acq.map((a) => a.id + (multi ? "=" + normShare(getShare(pattern, a)) : "")).sort().join("|");
        return sig || "(取得者なし)";
      }
      // ------------------------------------------------------------
      // 登記申請書に記載する持分
      // ------------------------------------------------------------
      // 相続パターンの持分（shares）は「取得者どうしの取得割合」（合計1）。
      //   ・所有権の全部を相続する不動産 … 登記申請書の持分 = 取得割合
      //   ・被相続人が共有持分（例 1/2）だけを持っていた不動産
      //       … 登記申請書の持分 = 被相続人の持分 × 取得割合
      //       （相続人が複数なら合計が被相続人の持分になる。相続人が1人でも持分を記載する）
      // 持分の記載が不要なのは、所有権全部を1人で相続する場合だけ。
      function reduceFrac(n, d) { const g = gcd(n, d) || 1; return { n: n / g, d: d / g }; }
      function propertyShareMap(prop, sp) {
        const hold = holdingOf(prop, sp);
        const full = !!hold && hold.n === hold.d;
        if (!(sp.owners.length > 1 || !full)) return null;
        const map = {};
        sp.owners.forEach((a) => {
          const sh = sp.shares[a.id];
          if (!sh || !hold) { map[a.id] = ""; return; }
          const f = reduceFrac(hold.n * sh.n, hold.d * sh.d);
          map[a.id] = f.n + "/" + f.d;
        });
        return map;
      }
      function ownerName(a) { return (deathKind(a) === "after" ? "亡" : "") + (a.name || "〇〇"); }
      function propertyShareDescription(prop, pattern) {
        const specs = resolveSpecs(pattern);
        if (specs.length === 0) return "（取得者なし）";
        return specs.map((sp) => {
          const map = propertyShareMap(prop, sp);
          const head = sp.isStep2 ? "【亡" + (sp.root.name || "〇〇") + "の分】" : "";
          if (!map) return head + "（単独名義のため持分の記載なし）";
          return head + sp.owners.map((a) => ownerName(a) + " " + (map[a.id] ? shareLabel(map[a.id]).replace("持分", "") : "未定")).join("、");
        }).join(" ／ ");
      }
      function purposeOf(group) {
        const holds = group.properties.map((p) => holdingOf(p, group.vpByProp[p.id]));
        const hasFull = holds.some((h) => h && h.n === h.d);
        const hasShare = holds.some((h) => !h || h.n !== h.d);
        const dn = group.vp.root.name || "〇〇";
        if (hasFull && hasShare) return "所有権移転及び" + dn + "持分全部移転";
        if (hasShare) return dn + "持分全部移転";
        return "所有権移転";
      }
      // 登記申請書内の持分の書き方: none=記載なし / common=全不動産で同じ（相続人欄に記載）/
      // perProperty=不動産ごとに異なる（相続人欄は「持分後記のとおり」、不動産の表示に記載）
      function applicationShareInfo(g) {
        const maps = g.properties.map((pr) => propertyShareMap(pr, g.vpByProp[pr.id]));
        const nonNull = maps.filter((m) => m);
        if (nonNull.length === 0) return { mode: "none", maps, common: null };
        const same = nonNull.length === maps.length && nonNull.every((m) => JSON.stringify(m) === JSON.stringify(nonNull[0]));
        return { mode: same ? "common" : "perProperty", maps, common: same ? nonNull[0] : null };
      }
      function acqShareLabel(ap, a) {
        if (ap.shareInfo.mode === "common") return shareLabel(ap.shareInfo.common[a.id]);
        if (ap.shareInfo.mode === "perProperty") return "持分後記のとおり";
        return "";
      }
      function propertyShareText(ap, pr) {
        if (ap.shareInfo.mode !== "perProperty") return "";
        const map = ap.shareInfo.maps[ap.properties.indexOf(pr)];
        if (!map) return "";
        const acq = ap.owners;
        if (acq.length === 1) return "（" + shareLabel(map[acq[0].id]) + "）";
        return "（持分　" + acq.map((a) => ownerName(a) + shareLabel(map[a.id]).replace("持分", "")).join("　") + "）";
      }
      // 遺産分割協議書: 共有持分を相続する不動産の注記
      function kyoShareNote(g, pr) {
        if (pr.rightKind !== "share") return "";
        const d = parseShare(pr.deceasedShare);
        const sp = resolveSpecs(g.pattern)[0];
        const map = sp && propertyShareMap(pr, sp);
        if (!d || !map) return "";
        return "（被相続人の持分" + zen(d.d) + "分の" + zen(d.n) + "の全部を取得する。取得する持分：" +
          sp.owners.map((a) => ownerName(a) + shareLabel(map[a.id]).replace("持分", "")).join("、") + "）";
      }
      // 課税標準の計算過程（入力画面と登記申請書の内訳に表示）
      // 登記申請書の単位は「申請人（取得者）の組み合わせ」と管轄だけで決まる。
      // 申請人が同じなら、所有権移転と○○持分全部移転、持分が異なる不動産も1通で申請できる。
      function acquirerSetSignature(pattern) {
        const sig = acquirersOf(pattern).map((a) => String(a.id)).sort().join("|");
        return sig || "(取得者なし)";
      }
      function patternFor(prop) {
        return successorPatterns.value.find((p) => p.id === prop.patternId) || successorPatterns.value[0];
      }
      // 登記申請書の単位 = (相続パターン・持分 × 管轄登記所)
      // 遺産分割協議書の単位 = 相続パターン・持分
      const kyogishoGroups = computed(() => groupProperties(false).map((g) =>
        Object.assign(g, { acquirers: acquirersOf(g.pattern), shareStatus: sharesStatus(g.pattern) })));
      // 振り分けの確認表: 各不動産が、遺産分割協議書のどの条・どの登記申請書に入るか
      function groupProperties(withOffice) {
        const groups = [], index = {};
        const specCache = {};
        const specsOf = (pat) => specCache[pat.id] || (specCache[pat.id] = resolveSpecs(pat));
        registration.value.properties.filter((prop) => !withOffice || isRealEstate(prop)).forEach((prop) => {
          const pat = patternFor(prop);
          const office = (prop.office || "").trim();
          // 登記申請書: 相続の段階（数次相続では複数）ごとに、申請人の組み合わせ × 管轄で1通。
          // 遺産分割協議書: 取得者と取得割合が同じものを1つの条にまとめる。
          const entries = withOffice
            ? specsOf(pat).map((sp) => ({ key: specKey(sp) + "@" + office, spec: sp }))
            : [{ key: acquirerSignature(pat), spec: null }];
          entries.forEach((en) => {
            if (!index[en.key]) {
              index[en.key] = { key: en.key, pattern: pat, patterns: [], office, properties: [], vp: en.spec, vpByProp: {} };
              groups.push(index[en.key]);
            }
            const g = index[en.key];
            if (!g.patterns.includes(pat)) g.patterns.push(pat);
            g.properties.push(prop);
            if (en.spec) g.vpByProp[prop.id] = en.spec;
          });
        });
        const order = (g) => successorPatterns.value.findIndex((x) => x.id === g.pattern.id);
        return groups.sort((x, y) => order(x) - order(y));
      }
      // 登記申請書の単位 = (相続の段階 × 申請人の組み合わせ × 管轄登記所)
      const applications = computed(() => groupProperties(true).map((g) => {
        const owners = g.vp.owners;
        const acquirers = owners.filter((o) => deathKind(o) !== "after");   // 申請人になる（生存している）人
        // 住民票コードは、申請人ごとに記載できる。記載した人の分は、その人の住民票の写し（住所証明情報）を省略できる
        const noJumin = acquirers.filter((a) => !(applicantInfo(a).juminCode || "").trim());
        const allJumin = acquirers.length > 0 && noJumin.length === 0;
        const ctxFn = (pr) => { const sp = g.vpByProp[pr.id]; return { holding: holdingOf(pr, sp), dead: deadFraction(sp) }; };
        return Object.assign(g, {
          owners, acquirers,
          decedentName: g.vp.root.name || "",
          isStep2: g.vp.isStep2,
          causeLines: causeLinesOf(g.vp),
          hasDeadOwner: owners.some((o) => deathKind(o) === "after"),
          purpose: purposeOf(g),
          allJumin,
          juminMissingNames: noJumin.map((a) => a.name || "未入力"),
          juminPartial: noJumin.length > 0 && noJumin.length < acquirers.length,
          shareInfo: applicationShareInfo(g),
          taxLines: g.properties.map((pr) => ({
            id: pr.id, text: propertyTaxLine(pr, holdingOf(pr, g.vpByProp[pr.id])),
            name: ((pr.location || "") + " " + (pr.lotNo || "")).trim() || "不動産",
            exempt: exemptionStatus(pr).applies
          })),
          shareStatus: sharesStatus(g.pattern),
          hasLegalRep: acquirers.some((a) => hasLegalRep(a)),
          tax: calcRegistrationTax(g.properties, registration.value.applyExemption, registration.value.applicationDate, ctxFn)
        });
      }));
      // 振り分けの確認表: 各財産が、遺産分割協議書のどの条・どの登記申請書に入るか
      const allocationRows = computed(() => {
        const apps = applications.value, kys = kyogishoGroups.value;
        return registration.value.properties.map((prop) => {
          const re = isRealEstate(prop);
          const pat = patternFor(prop);
          const sig = acquirerSignature(pat);
          const office = (prop.office || "").trim();
          const acq = acquirersOf(pat);
          const warnings = patternWarnings(pat).slice();
          if (acq.length === 0) warnings.push("取得者がいません");
          if (re && docs.value.toki && !office) warnings.push("管轄登記所が未入力です");
          const st = sharesStatus(pat);
          if (st.needed && !st.ok) warnings.push("持分の合計が1になっていません");
          if (re && prop.rightKind === "share" && !parseShare(prop.deceasedShare)) warnings.push("被相続人の持分が未入力です");
          if (re && propertyValue(prop) <= 0) warnings.push("評価額が未入力です");
          if (!re && !assetSummary(prop)) warnings.push("財産の内容が未入力です");
          const appNos = re ? apps.map((g, i) => (g.properties.includes(prop) ? i + 1 : 0)).filter(Boolean) : [];
          return {
            prop, pattern: pat, office, warnings, re,
            acquirerText: acquirerText({ acquirers: acq, pattern: pat }),
            shareText: propertyShareDescription(prop, pat),
            appNo: appNos[0] || 0, appNos,
            kyoNo: kys.findIndex((g) => g.key === sig) + 1
          };
        });
      });
      // この登記申請書に添付する相続関係説明図（取得者と〔相続人〕が一致するパターン）を開く
      function openDiagramForApplication(ap) {
        activePatternId.value = ap.pattern.id;
        goTo("setsumeizu");
      }

      // renderedPages（各ページのstate）に対応するsvg要素(id="chart-N")
      // すべてに実際の描画を行う。印刷時にも全ページが対象になるよう、
      // 画面上は現在ページだけをCSSで表示し、DOM自体は全ページ分保持する。
      function renderAllPages() {
        renderedPages.value.forEach((pageState, idx) => {
          const svg = document.getElementById("chart-" + idx);
          if (!svg) return;
          DiagramEngine.render(svg, pageState, {
            titleOverride: docType.value === "setsumeizu" ? "相続関係説明図" : null,
            isCertified: docType.value === "ichiranzu",
            pageIndex: idx,
            pageTotal: renderedPages.value.length
          });
        });
      }

      function showPreview(type) {
        docType.value = type || "ichiranzu";
        currentView.value = "preview";
        if (docType.value === "ichiranzu" || docType.value === "setsumeizu") {
          const isCertified = docType.value === "ichiranzu";
          // 相続関係説明図は、選択中の相続パターンの「相続する／しない」を反映する
          const baseState = currentFullState();
          const pageState = isCertified ? baseState : applyPatternToState(baseState, activePattern.value);
          renderedPages.value = DiagramEngine.buildPages(pageState, { isCertified });
          currentPage.value = 0;
          nextTick(renderAllPages);
        }
      }

      // プレビュー画面で相続パターンを切り替える（相続関係説明図のみ）
      function changePreviewPattern(id) {
        activePatternId.value = id;
        showPreview("setsumeizu");
      }

      // 画面上部のナビから、入力画面と各書類を直接切り替える
      function goTo(tab) {
        if (tab === "input") backToInput();
        else showPreview(tab);
      }

      function goToPage(idx) {
        if (idx < 0 || idx >= totalPages.value) return;
        currentPage.value = idx;
      }
      function nextPage() { goToPage(currentPage.value + 1); }
      function prevPage() { goToPage(currentPage.value - 1); }
      // 入力欄へ戻る（ブラウザの戻るボタンと同じ動き。履歴も1つ戻る）
      function backToInput() {
        currentView.value = "input";
      }
      function printDiagram() {
        window.print();
      }

      // ------------------------------------------------------------
      // 保存・読込み（JSONファイルとして書き出し／読み込み）
      // ------------------------------------------------------------
      // ------------------------------------------------------------
      // 被相続人（手続）の切り替え
      // ------------------------------------------------------------
      // 1つの手続 = 1人の被相続人についての全書類（法定相続情報一覧図・相続関係説明図・遺産分割協議書・登記申請書）。
      // 父の死亡後に母が亡くなった場合などは、被相続人ごとに手続を分けて作る。
      // 画面の入力欄は常に「いま開いている被相続人」の分で、切り替えるときに
      // 保存用データへ退避・復元する。
      // ------------------------------------------------------------
      // 保存ファイルの形式（詳細は dev/SAVE_FORMAT.md）
      // ------------------------------------------------------------
      // 仕様変更があっても、過去に保存したファイルを読めるようにするための決まり:
      //  1. 保存するのは入力データだけ。画面の状態（タブ・開閉）や計算結果は保存しない。
      //  2. 項目は追加のみ。削除・名前の変更・意味の変更はしない。やむを得ず変える場合は、
      //     SAVE_VERSION を上げ、旧項目を読み込み時に新項目へ移す処理（applyData 内）を足す。
      //  3. 読み込みは「形式の確認 → 旧項目の変換 → 既定値の補完」の順。未知の項目は無視し、
      //     足りない項目は既定値で補う（エラーにしない）。
      //  4. より新しい版で保存されたファイルは、読める範囲で読み込み、画面に注意を出す。
      const SAVE_FORMAT = "houseki-system-save";
      const SAVE_VERSION = 9;
      const loadNotice = ref("");
      function newCaseId() { return "case_" + Math.random().toString(36).slice(2, 8); }
      function buildSaveData() {
        return JSON.parse(JSON.stringify({
          deceased: deceased.value, spouse: spouse.value, children: children.value,
          siblings: siblings.value, parents: parents.value, creator: creator.value,
          filing: filing.value, extraRelations: extraRelations.value,
          successorPatterns: successorPatterns.value, activePatternId: activePatternId.value,
          registration: registration.value, docs: docs.value, agreement: agreement.value
        }));
      }
      // 続柄は「（長男）」の形にそろえる（カッコなしで保存されたものも、カッコつきにする）
      function normRole(r) {
        const inner = String(r == null ? "" : r).trim().replace(/^[（(]+/, "").replace(/[）)]+$/, "").trim();
        return inner ? "（" + inner + "）" : "";
      }
      function applyData(data) {
        data = data || {};
        deceased.value = Object.assign({ name: "", birth: "", death: "", lastAddr: "", lastHoseki: "" }, data.deceased);
        spouse.value = Object.assign({ role: "", name: "", birth: "", addr: "", death: "", deathTiming: "auto", isApplicant: false, isCreator: false }, data.spouse);
        // 型が崩れていても読み込めるよう、人物の形を整える（substitutes は必ず配列にする）
        const fixPerson = (p) => {
          if (!p || typeof p !== "object") return null;
          p.role = normRole(p.role);
          p.substitutes = (Array.isArray(p.substitutes) ? p.substitutes : []).map(fixPerson).filter(Boolean);
          return p;
        };
        children.value = (Array.isArray(data.children) ? data.children : []).map(fixPerson).filter(Boolean);
        siblings.value = (Array.isArray(data.siblings) ? data.siblings : []).map(fixPerson).filter(Boolean);
        parents.value = (Array.isArray(data.parents) ? data.parents : []).filter((p) => p && typeof p === "object").map((p) => { p.role = normRole(p.role); return p; });
        spouse.value.role = normRole(spouse.value.role);
        creator.value = Object.assign({ date: "", isAgentMode: false, agentAddr: "", agentName: "", agentPick: null }, data.creator);
        // 古いファイル（代理人の選択がない）は、氏名が入っていれば「それ以外の人」として読み込む
        if (creator.value.agentPick == null) creator.value.agentPick = inferAgentPick(creator.value.agentName);
        filing.value = Object.assign({
          applicationDate: "", applicantContact: "",
          purposeRealEstate: false, purposeBankAccount: false, purposeTax: false, purposePension: false,
          purposeOtherChecked: false, purposeOtherText: "",
          copies: "1", deliveryMethod: "window",
          hasRealEstate: false, realEstateInfo: "",
          officeBasis: "applicantAddress", officeName: "",
          agentOffice: "", agentRelation: "delegate",
          delegationMatter: "法定相続情報一覧図の保管及び交付の申出並びに法定相続情報一覧図の写しの受領に関する一切の件",
          delegationDate: ""
        }, data.filing);
        // 被相続人名義の不動産がないのに、「不動産の所在地」の登記所が選ばれている状態は、直す
        if (!filing.value.hasRealEstate && filing.value.officeBasis === "realEstate") filing.value.officeBasis = "applicantAddress";
        extraRelations.value = Object.assign({
          illegitimateMotherName: "", fatherOtherPartnerName: "", motherOtherPartnerName: ""
        }, data.extraRelations);
        normalizeIds();
        syncAgentMode();
        registration.value = Object.assign({
          enabled: false, applicationDate: "", contact: "", lawNumber: "", applyExemption: true,
          omitDetailsWithNumber: false, noIdentifier: false, useNationality: true, applicants: {}, addrChanges: {},
          delegationDate: ""
        }, data.registration, {
          agent: Object.assign({ enabled: false, name: "", address: "", pick: null }, data.registration && data.registration.agent),
          properties: (data.registration && Array.isArray(data.registration.properties)) ? data.registration.properties.map(fixAsset).filter(Boolean) : []
        });
        // 古いファイル（代理人の選択がない）は、氏名が入っていれば「それ以外の人」として読み込む
        if (registration.value.agent.pick == null) registration.value.agent.pick = inferAgentPick(registration.value.agent.name);
        const legacyToki = !!(data.registration && data.registration.enabled);
        docs.value = Object.assign({
          ichiranzu: true, moshidesho: true, ininjo: false, setsumeizu: true, kyogisho: false,
          toki: legacyToki, toukiIninjo: false, jusho: false, setsumeizuCopies: 1, kyogishoCopies: 1
        }, data.docs);
        agreement.value = Object.assign({ date: "", otherAssets: "", futureHeirId: "" }, data.agreement);
        if (Array.isArray(data.successorPatterns) && data.successorPatterns.length > 0) {
          successorPatterns.value = data.successorPatterns.map((p) => ({
            id: p.id || newPatternId(),
            name: p.name || "パターン",
            successors: Object.assign({}, p.successors),
            shares: Object.assign({}, p.shares),
            assets: p.assets || ""
          }));
          const found = successorPatterns.value.some((p) => p.id === data.activePatternId);
          activePatternId.value = found ? data.activePatternId : successorPatterns.value[0].id;
        } else {
          // v4以前の保存ファイル: 人物ごとの isSuccessor から1つの組み合わせを復元する
          const succ = {};
          forEachPerson((p) => { succ[p.id] = p.isSuccessor !== false; delete p.isSuccessor; });
          const pat = newPattern("パターン1", succ);
          successorPatterns.value = [pat];
          activePatternId.value = pat.id;
        }
        // 旧版の「相続する財産の説明」「不動産以外の遺産」の入力は、相続財産の一覧に移す
        successorPatterns.value.forEach((pt) => {
          if ((pt.assets || "").trim()) {
            registration.value.properties.push(Object.assign(newAsset("other"), { patternId: pt.id, assetName: pt.assets.trim() }));
          }
          pt.assets = "";
        });
        if ((agreement.value.otherAssets || "").trim()) {
          registration.value.properties.push(Object.assign(newAsset("other"), { patternId: successorPatterns.value[0].id, assetName: agreement.value.otherAssets.trim() }));
          agreement.value.otherAssets = "";
        }
        fillDateDefaults();
        const fixedDates = fixPastApplicationDates();
        if (fixedDates.length) {
          notice.value = { open: true, title: "日付を直しました", lines: [fixedDates.join("・") + "が過去の日付だったため、今月に直しました。過去の日付では申請できないので、日を入力し直してください。"] };
        }
        expandedSpouse.value = false;
        expandedChildren.value = [];
        expandedSiblings.value = [];
        expandedParents.value = [];
        expandedSubstitutes.value = [];
      }
      function caseLabel(c) {
        const nm = c.id === activeCaseId.value ? deceased.value.name : (c.data && c.data.deceased && c.data.deceased.name);
        return nm || "被相続人（未入力）";
      }
      function docAvailable(type) {
        const e = docEnabled.value;
        return !!({ ichiranzu: e.ichiranzu, moshidesho: e.moshidesho, ininjo: e.ininjo, setsumeizu: e.setsumeizu,
          kyogisho: e.kyogisho, touki: e.toki, toukiIninjo: e.toukiIninjo, jusho: e.jusho })[type];
      }
      function stashActiveCase() {
        const cur = cases.value.find((c) => c.id === activeCaseId.value);
        if (cur) cur.data = buildSaveData();
      }
      function openCase(id) {
        const next = cases.value.find((c) => c.id === id);
        if (!next) return;
        const keep = currentView.value === "preview" ? docType.value : null;
        applyData(next.data || {});
        activeCaseId.value = id;
        if (keep && docAvailable(keep)) showPreview(keep);
        else currentView.value = "input";
      }
      // 上部のプルダウンから被相続人を選ぶ（末尾の「＋ 追加」で新規作成）
      function onCaseSelect(v, ev) {
        if (v === "__new_blank__") addCase();
        else if (v === "__new_copy__") addCaseCopyHeirs();
        else switchCase(v);
        if (ev && ev.target) nextTick(() => { ev.target.value = activeCaseId.value; });
      }
      // 上部のプルダウンから相続パターンを選ぶ（末尾の「＋ 追加」で新規作成）
      function onPatternSelect(v, ev) {
        if (v === "__new__") addPattern();
        else activePatternId.value = v;
        if (currentView.value === "preview" && docType.value === "setsumeizu") showPreview("setsumeizu");
        if (ev && ev.target) nextTick(() => { ev.target.value = activePatternId.value; });
      }
      // ------------------------------------------------------------
      // 台帳（人物・不動産の個体管理と、時系列の履歴）。計算は js/ledger.js
      // ------------------------------------------------------------
      //  ・人物の個体ID（pid）と、不動産の個体ID（財産の id）で、手続をまたいで「同じもの」を結ぶ
      //  ・履歴（住所・氏名の変更、不動産の名義の変動）は、台帳（ledger）に日付つきで残す。保存ファイルに入る
      //  ・手続から分かる流れ（被相続人の死亡による相続）は、保存せず、そのつど計算して並べる
      Ledger.shareParser = parseShare;
      const ledger = ref(Ledger.emptyLedger());
      const ledgerCauses = ["売買", "贈与", "相続", "遺産分割", "持分移転", "住所変更・更正", "分筆・合筆", "その他"];
      // 全手続の入力データ（開いている手続は、いまの入力内容）
      function ledgerCasesList() {
        return cases.value.map((c) => ({ id: c.id, data: c.id === activeCaseId.value ? buildSaveData() : (c.data || {}) }));
      }
      // 台帳のタブを開いているときだけ計算する
      const ledgerView = computed(() => (currentView.value === "input" && activeInputTab.value === "ledger") ? Ledger.buildView(ledgerCasesList(), ledger.value) : null);
      // pid の人物の入力欄（開いている手続は画面の入力欄、ほかの手続は退避したデータ）すべてに fn(人物, 被相続人か) を呼ぶ
      function forEachPersonRecord(pid, fn) {
        cases.value.forEach((c) => {
          if (c.id === activeCaseId.value) {
            if (deceased.value.pid === pid) fn(deceased.value, true);
            forEachPerson((x) => { if (x.pid === pid) fn(x, false); });
          } else if (c.data) {
            if (c.data.deceased && c.data.deceased.pid === pid) fn(c.data.deceased, true);
            Ledger.walkPersons(c.data, (x) => { if (x.pid === pid) fn(x, false); });
          }
        });
      }
      function ledgerPerson(pid) { return (ledger.value.people[pid] = ledger.value.people[pid] || { history: [] }); }
      function ledgerAddHistory(pid, kind) { ledgerPerson(pid).history.push({ id: Ledger.newEntryId(), date: "", kind, value: "", note: "" }); }
      function ledgerRemoveHistory(pid, id) {
        const rec = ledgerPerson(pid), i = rec.history.findIndex((h) => h.id === id);
        if (i >= 0) rec.history.splice(i, 1);
      }
      function ledgerEstate(id) { return (ledger.value.estates[id] = ledger.value.estates[id] || { events: [] }); }
      function ledgerAddEvent(id) { ledgerEstate(id).events.push({ id: Ledger.newEntryId(), date: "", cause: "売買", text: "" }); }
      function ledgerRemoveEvent(id, entryId) {
        const rec = ledgerEstate(id), i = rec.events.findIndex((e) => e.id === entryId);
        if (i >= 0) rec.events.splice(i, 1);
      }
      // 手続によって食い違っている項目を、選んだ値にそろえる（field: name / birth / death / addr）
      function ledgerUnify(pid, field, value) {
        let n = 0;
        forEachPersonRecord(pid, (o, isDec) => {
          const k = (field === "addr" && isDec) ? "lastAddr" : field;
          if (o[k] !== value) { o[k] = value; n++; }
        });
        return n;
      }
      // 履歴の住所を、各手続へ反映する。相続人は「最新の住所」、被相続人は「死亡した日の住所」
      function ledgerApplyAddress(pid) {
        const hist = (ledger.value.people[pid] && ledger.value.people[pid].history) || [];
        let n = 0;
        forEachPersonRecord(pid, (o, isDec) => {
          if (isDec && !Ledger.hasDate(o.death)) return;
          const v = isDec ? Ledger.addressAt(hist, o.death) : Ledger.latestAddress(hist);
          const k = isDec ? "lastAddr" : "addr";
          if (v && o[k] !== v) { o[k] = v; n++; }
        });
        notice.value = { open: true, title: "住所を反映しました", lines: [
          n > 0 ? n + "件の手続の住所を、履歴にそろえました（被相続人は、死亡した日の住所）。" : "履歴から決まる住所は、すでに各手続の入力と同じです（被相続人は、死亡年月日が入力されている手続だけが対象です）。"
        ] };
        return n;
      }
      // 申請人情報（フリガナ・メール・国籍・住民票コード）を、ほかの手続の入力から、空欄のところへ写す
      function ledgerSyncApplicant(pid) {
        const def = defaultApplicant();
        const fields = ["kana", "email", "nationality", "juminCode"];
        const slots = [];       // { obj, key } の表（各手続の、その人の申請人情報）
        cases.value.forEach((c) => {
          const isActive = c.id === activeCaseId.value;
          const data = isActive ? null : c.data;
          let personId = null;
          if (isActive) forEachPerson((x) => { if (x.pid === pid) personId = x.id; });
          else if (data) Ledger.walkPersons(data, (x) => { if (x.pid === pid) personId = x.id; });
          if (personId === null) return;
          let app;
          if (isActive) app = registration.value.applicants;
          else { data.registration = data.registration || {}; app = data.registration.applicants = data.registration.applicants || {}; }
          slots.push({ app, id: personId });
        });
        const isBlank = (k, v) => !v || v === def[k];
        const src = {};
        slots.forEach((sl) => fields.forEach((k) => { const v = (sl.app[sl.id] || {})[k]; if (!isBlank(k, v) && src[k] === undefined) src[k] = v; }));
        let n = 0;
        slots.forEach((sl) => fields.forEach((k) => {
          const cur = (sl.app[sl.id] || {})[k];
          if (src[k] !== undefined && isBlank(k, cur)) { sl.app[sl.id] = Object.assign({}, def, sl.app[sl.id], { [k]: src[k] }); n++; }
        }));
        notice.value = { open: true, title: "申請人情報をそろえました", lines: [n > 0 ? n + "件の空欄に、ほかの手続の入力を写しました。" : "写せる入力はありませんでした（空欄のところだけに写します）。"] };
        return n;
      }
      // 同じ人物かもしれない2つ（氏名と生年月日が同じ）を、同じ人物にまとめる
      function ledgerMerge(keep, drop) {
        if (!window.confirm("この2つを同じ人物としてまとめます。すべての手続で、同じ人として扱われます。よろしいですか？")) return false;
        cases.value.forEach((c) => {
          if (c.id === activeCaseId.value) {
            if (deceased.value.pid === drop) deceased.value.pid = keep;
            forEachPerson((x) => { if (x.pid === drop) x.pid = keep; });
          } else if (c.data) Ledger.replacePid(c.data, drop, keep);
        });
        Ledger.mergeLedgerPeople(ledger.value, drop, keep);
        return true;
      }
      function ledgerNotSame(key) { if (ledger.value.notSame.indexOf(key) < 0) ledger.value.notSame.push(key); }

      function switchCase(id) {
        if (id === activeCaseId.value) return;
        stashActiveCase();
        openCase(id);
      }
      // 被相続人（手続）を追加する。入力欄は新しくなり（作成する書類・相続財産・日付なども初期状態）、
      // 引き継ぐのは、data に入れた関係者（人）の情報だけ。origin は「どの人から作ったか」の印
      function addCase(data, origin) {
        demoMode.value = false;
        stashActiveCase();
        const id = newCaseId();
        cases.value.push({ id, data: data || {}, origin: origin || null });
        currentView.value = "input";
        applyData(data || {});
        activeCaseId.value = id;
        inputTab.value = "docs";      // 新しい入力欄は、先に作る書類を選ぶところから
        caseAddOpen.value = false;
      }
      function addCaseBlank() { addCase(); }
      function removeCase(id) {
        if (cases.value.length <= 1) return;
        const target = cases.value.find((c) => c.id === id);
        if (!target) return;
        if (!window.confirm("「" + caseLabel(target) + "」の手続（入力内容）を削除します。よろしいですか？")) return;
        const idx = cases.value.findIndex((c) => c.id === id);
        const wasActive = id === activeCaseId.value;
        cases.value.splice(idx, 1);
        if (wasActive) {
          const next = cases.value[Math.max(0, idx - 1)];
          currentView.value = "input";
          applyData(next.data || {});
          activeCaseId.value = next.id;
        }
      }
      // 現在の相続人（配偶者・子・親・兄弟姉妹）をコピーして、被相続人を追加する
      function addCaseCopyHeirs() {
        const copy = JSON.parse(JSON.stringify({
          spouse: spouse.value, children: children.value, siblings: siblings.value, parents: parents.value
        }));
        const strip = (p) => { p.isApplicant = false; p.isCreator = false; (p.substitutes || []).forEach(strip); };
        strip(copy.spouse); copy.children.forEach(strip); copy.siblings.forEach(strip); copy.parents.forEach(strip);
        addCase(Object.assign({ deceased: { name: "", birth: "", death: "", lastAddr: "", lastHoseki: "" } }, copy));
      }
      // この人を被相続人とする手続を追加する（その人の死亡当時の相続人を流用する）
      //   配偶者 … 被相続人の子（二次相続）
      //   代襲者がいる人 … その代襲者を子として
      //   それ以外 … 相続人は空欄
      function addCaseFromPerson(p) {
        // すでにこの人から作った手続があれば、新しく作らず、その手続を開く
        const exist = linkedCase(p);
        if (exist) { caseAddOpen.value = false; switchCase(exist.id); inputTab.value = "docs"; return; }
        const strip = (x) => { x.isApplicant = false; x.isCreator = false; (x.substitutes || []).forEach(strip); };
        let kids = [];
        if (p.id === "spouse") {
          kids = JSON.parse(JSON.stringify(children.value.filter((c) => !c.death || (c.substitutes || []).length > 0)));
        } else if ((p.substitutes || []).length > 0) {
          kids = JSON.parse(JSON.stringify(p.substitutes));
          kids.forEach((k) => { k.role = "（子）"; k.isAdopted = false; k.isIllegitimate = false; });
        }
        kids.forEach(strip);
        // この人が、いまの手続で取得する不動産は、同じ不動産として、新しい手続に引き継ぐ（持分は、取得する割合）
        const snap = buildSaveData();
        const carried = carryOverEstates(snap, p);
        const data = {
          deceased: { name: p.name || "", birth: p.birth || "", death: p.death || "", lastAddr: p.addr || "", lastHoseki: "", pid: p.pid || Ledger.newPid() },
          children: kids
        };
        // 子（と、その代襲者）の申請人情報（フリガナ・住民票コードなど）も、引き継ぐ
        const appl = {};
        const collect = (arr) => (arr || []).forEach((k) => {
          const a = snap.registration && snap.registration.applicants && snap.registration.applicants[k.id];
          if (a) appl[k.id] = JSON.parse(JSON.stringify(a));
          collect(k.substitutes);
        });
        collect(kids);
        if (carried.length > 0) {
          const pat = newPattern("パターン1");
          carried.forEach((x) => { x.patternId = pat.id; });
          data.successorPatterns = [pat];
          data.activePatternId = pat.id;
        }
        if (carried.length > 0 || Object.keys(appl).length > 0) data.registration = { applicants: appl, properties: carried };
        addCase(data, { caseId: activeCaseId.value, personId: p.id });
        if (carried.length > 0) {
          notice.value = { open: true, title: "不動産を引き継ぎました", lines: [
            (p.name || "この方") + "さんが前の手続で取得する不動産" + carried.length + "件を、この手続の相続財産に引き継ぎました（同じ不動産として、「個体・履歴」タブでつながります）。",
            "被相続人の持分と、評価額を確認してください。"
          ] };
        }
      }
      // いまの手続（snap）で、人物 p が取得する不動産（土地・建物・区分建物）を、p を被相続人とする手続の相続財産にして返す
      function carryOverEstates(snap, p) {
        const out = [];
        const pats = snap.successorPatterns || [];
        ((snap.registration && snap.registration.properties) || []).forEach((pr) => {
          if (!Ledger.REAL_ESTATE[pr.kind]) return;
          const pattern = pats.find((x) => x.id === pr.patternId) || pats[0];
          const units = Ledger.acquirerUnits(snap, pattern);
          const hit = units.find((u) => String(u.id) === String(p.id));
          if (!hit) return;
          const own = Ledger.ownShare(pr);
          const sh = units.length === 1 ? { n: 1, d: 1 } : parseShare(pattern && pattern.shares ? pattern.shares[hit.id] : "");
          const hold = own && sh ? Ledger.reduce(own.n * sh.n, own.d * sh.d) : null;
          const np = JSON.parse(JSON.stringify(pr));
          np.coOwners = [];
          if (hold && hold.n === hold.d) {
            np.rightKind = "full"; np.deceasedShare = ""; np.valueBasis = "whole";
          } else {
            np.rightKind = "share"; np.deceasedShare = hold ? hold.n + "/" + hold.d : "";
            if (valueIsShareBasis(pr)) {
              // 入力した価額は、前の被相続人の持分の価額。新しい被相続人の持分の価額に直す（直せなければ空欄）
              const scale = (str) => {
                const v = toInt(str);
                if (v <= 0) return str;
                if (!hold || !own) return "";
                return yen(Number(BigInt(v) * BigInt(hold.n) * BigInt(own.d) / (BigInt(hold.d) * BigInt(own.n))));
              };
              np.assessedValue = scale(pr.assessedValue);
              np.landRightValue = scale(pr.landRightValue);
            }
          }
          out.push(np);
        });
        return out;
      }
      // この人から作った手続（あれば）。人物カードのチェックの状態になる
      function linkedCase(p) {
        return cases.value.find((c) => c.origin && c.origin.caseId === activeCaseId.value && c.origin.personId === p.id) || null;
      }
      // 人物カードのチェック: 入れると手続を追加（その手続へ移る）、外すと、その手続を削除（確認あり）
      function toggleCaseFromPerson(p, ev) {
        const on = ev && ev.target ? ev.target.checked : !linkedCase(p);
        if (on) { addCaseFromPerson(p); return; }
        const ex = linkedCase(p);
        if (ex) removeCase(ex.id);
        if (ev && ev.target) nextTick(() => { ev.target.checked = !!linkedCase(p); });
      }
      // 被相続人の追加の選択（旧：選択画面。いまは、ナビの色つきの枠にあるプルダウン）
      const caseAddOpen = ref(false);
      function openCaseAdd() { caseAddOpen.value = true; }
      function closeCaseAdd() { caseAddOpen.value = false; }
      // 新しい被相続人にできる、いまの関係者（「死亡」にチェックが入っている人だけ。代襲者・数次相続人も含む）
      const caseCandidates = computed(() => {
        const list = [];
        const add = (p) => {
          if (!p || !p.name || !p.death) return;
          const linked = !!linkedCase(p);
          list.push({ p, label: ((p.name || "") + (p.role ? " " + p.role : "") + (linked ? "（作成済み）" : "")).trim(), linked });
          (p.substitutes || []).forEach(add);
        };
        add(spouse.value);
        [children, siblings, parents].forEach((g) => g.value.forEach(add));
        return list;
      });
      // 「追加」ボタン: モーダルで、「死亡」にチェックが入っている関係者と、最後に「それ以外」を選ばせる（関係者がいなくても、モーダルは出す）
      function requestAddCase() { caseAddOpen.value = true; }
      function chooseCaseToAdd(index) {
        caseAddOpen.value = false;
        if (index === null || index === undefined || index === "__blank__") { addCase(); return; }
        const cd = caseCandidates.value[Number(index)];
        if (cd) addCaseFromPerson(cd.p);
      }
      function addNextCaseFromSpouse() { if (spouse.value.name) addCaseFromPerson(spouse.value); }

      // ダークモードの切替（js/theme.js）。ボタンのラベルも、theme.js が書き換える
      function toggleTheme() { if (window.ThemeManager) window.ThemeManager.toggleTheme(); }
      function saveToFile() {
        stashActiveCase();
        const snap = buildSaveData();
        // 直下の項目は、いま開いている被相続人の分（旧版の保存形式と互換）。
        // 複数の被相続人は cases にすべて入る。
        const revisedEl = document.getElementById("app-revised");
        const data = Object.assign({
          _format: SAVE_FORMAT, _version: SAVE_VERSION,
          _savedAt: new Date().toISOString(),
          _appRevised: revisedEl ? revisedEl.textContent.trim() : ""
        }, snap, {
          cases: cases.value.map((c) => ({ id: c.id, data: c.data, origin: c.origin || null })),
          activeCaseId: activeCaseId.value,
          ledger: ledger.value
        });
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const dateStr = new Date().toISOString().slice(0, 10);
        a.href = url;
        const names = cases.value.map((c) => caseLabel(c)).join("・");
        a.download = `法定相続情報_${names || "未入力"}_${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      function triggerLoadFile() {
        const input = document.getElementById("load-file-input");
        if (input) input.click();
      }

      function onLoadFileSelected(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            demoMode.value = false;
            const data = JSON.parse(reader.result);
            if (!data || typeof data !== "object" || (data._format && data._format !== SAVE_FORMAT)) {
              throw new Error("not a save file");
            }
            const ver = Number(data._version) || 1;
            loadNotice.value = ver > SAVE_VERSION
              ? "このファイルは、より新しい版（保存形式v" + ver + "）で保存されています。読み込めない項目がある場合があります。"
              : "";
            if (Array.isArray(data.cases) && data.cases.length > 0) {
              cases.value = data.cases.map((c) => ({ id: c.id || newCaseId(), data: c.data || {}, origin: (c.origin && typeof c.origin === "object") ? c.origin : null }));
              cases.value.forEach((c) => Ledger.ensurePids(c.data));      // 個体IDのない古い保存ファイルにも、個体IDを振る
              ledger.value = Ledger.normalizeLedger(data.ledger);
              const act = cases.value.find((c) => c.id === data.activeCaseId) || cases.value[0];
              activeCaseId.value = act.id;
              applyData(act.data);
            } else {
              cases.value = [{ id: "case1", data: null }];
              activeCaseId.value = "case1";
              ledger.value = Ledger.normalizeLedger(data.ledger);
              applyData(data);
            }
            showDemoSelector.value = false;
            currentView.value = "input";
          } catch (e) {
            window.alert("ファイルの読み込みに失敗しました。保存されたJSONファイルを選択してください。");
          } finally {
            event.target.value = "";
          }
        };
        reader.readAsText(file);
      }


      // 「被相続人名義の不動産がある」のチェックを外したら、申出先の登記所の種別から「不動産の所在地」を外す
      watch(() => filing.value.hasRealEstate, (v) => { if (!v && filing.value.officeBasis === "realEstate") filing.value.officeBasis = "applicantAddress"; });
      onUpdated(() => { if (currentView.value === "preview") fitDocPapers(); });
      onMounted(() => {
        installTipListeners();
        measureNavHeight();
        window.addEventListener("resize", measureNavHeight);
        if (typeof ResizeObserver !== "undefined") { const nb = document.querySelector(".nav-bar"); if (nb) new ResizeObserver(measureNavHeight).observe(nb); }
        loadSample(0);
        // 起動時は必ず入力欄から（#付きのURLで開き直しても、書類は表示しない）
        if (hashView()) { try { window.location.replace("#"); } catch (e) { /* 無視 */ } }
        window.addEventListener("hashchange", onHashChange);
        document.addEventListener("keydown", (e) => {
          if (e.key !== "Escape") return;
          if (helpOpen.value) closeHelp();
          if (caseAddOpen.value) closeCaseAdd();
          if (tipsOpen.value) closeTips();
        });
        window.addEventListener("beforeprint", onBeforePrint);
        window.addEventListener("afterprint", removePrintCopies);
      });

      return {
        ledger, ledgerView, ledgerCauses, ledgerAddHistory, ledgerRemoveHistory, ledgerAddEvent, ledgerRemoveEvent,
        ledgerUnify, ledgerApplyAddress, ledgerSyncApplicant, ledgerMerge, ledgerNotSame, assessedLabel, propertyValue, valueIsShareBasis,
        currentView, showDemoSelector, expandedSpouse, expandedChildren, expandedSiblings, expandedParents,
        expandedSubstitutes, toggleSubstitute, isSubExpanded,
        deceased, spouse, children, siblings, parents, creator,
        docType, filing, applicantPerson, extraRelations,
        successorPatterns, activePatternId, activePattern, isSucc, setSucc,
        goTo, registration, applications, jushoApplications, jushoCandidates, jushoPeople, coOwnerEntry, toggleCoOwner, setCoOwnerRank, addrChangeInfo, setAddrChangeField, agentCandidates, onCreatorAgentPick, onTokiAgentPick, addProperty, removeProperty, openProps, isPropOpen, toggleProp, setAllProps, propHeading, addFromSelect, canonicalCity, addSiteRight, removeSiteRight,
        applicantInfo, setApplicantField, purposeOf,
        acquirersOf, sharesStatus, getShare, setShare, splitEqually, shareLabel, yen, areaText,
        addMother, removeMother, motherLabel, onIllegitimateChange,
        tip, tipDef, deadApi, demoMode, notice, closeNotice, spouseIsHeir, toggleDead, deathDateEntered, checkHeirStatus, deathJudge, deathJudgeText, deathBadge, substitutesWanted, parseJa, compareJa, checkJaDate, tipsOpen, openTips, closeTips, tipList, tipGenres, tipGenreIndex, tipsCurrentGenre, tipsCurrent, selectTipGenre, selectTip, onTipEnter, onTipLeave, closeTip,
        docs, agreement, docEnabled, kyogishoAdvice, multiPattern, needShares, fitDocPapers, isCompactDead, pickDemo, clampCopies, printCopies, linkedCase, toggleCaseFromPerson, caseAddOpen, openCaseAdd, closeCaseAdd, caseCandidates, requestAddCase, chooseCaseToAdd, addCaseBlank, helpOpen, openHelp, closeHelp, tabHelp, currentHelp, tabHelpShort, loadNotice, SAVE_VERSION, inputTab, inputTabs, activeInputTab,
        assetDemos: AssetDemos, applyAssetDemo, isRealEstate, assetKindLabel, assetSummary, assetDemosFor, parseShare, shareInterpret, prefRegions, prefOf, setPref, muniOf, muniGroups, setMunicipality, onPostalInput, prefPriority, filingOfficeAddress, kyoKindWord, copyDateToAll, docCounts, canFillLegal, fillLegalShares, usesPatterns, onPurposeRealEstateChange,
        patternLabel, zen, acquirerText, kyogishoGroups, kyogishoNos, kyogishoSigners,
        futureHeirName, propertyLines, applicantList, joinNames, allocationRows,
        onCaseSelect, onPatternSelect, addCaseCopyHeirs, addCaseFromPerson, patternHeirsText, patternAssetsText, patternDocsText,
        cases, activeCaseId, caseLabel, switchCase, addCase, removeCase, addNextCaseFromSpouse, legalShareMap, openDiagramForApplication,
        acqShareLabel, propertyShareText, kyoShareNote, propertyTaxLine, propertyShareDescription,
        deathKind, patternRows, patternWarnings, isDeadOwner, ownerName, exemptClauseText, estateUnits, onTokiAgentToggle, copyAgentFromIchiranzu,
        exemptionStatus, legalLabel, hasLegalRep, possibleMinor, legalWarnings, kyogishoSignerList,
        addPattern, duplicatePattern, removePattern, changePreviewPattern,
        currentPage, totalPages, renderedPages, goToPage, nextPage, prevPage,
        showChildren, showSiblings, showParents,
        effectiveChildCount, effectiveParentCount,
        parentsBlockedReason, siblingsBlockedReason,
        hasIllegitimateChild, illegitimateApplicable, illegitimateDateStatus,
        hasFatherSideHalfSibling, hasMotherSideHalfSibling,
        toggleChild, toggleSibling, toggleParent,
        toggleCreator, creatorPerson,
        loadSample, addChild, removeChild,
        addSubstituteTo, removeSubstituteFrom,
        addSibling, removeSibling, addSiblingSubstitute, removeSiblingSubstitute,
        addParent, removeParent,
        showPreview, backToInput, printDiagram,
        saveToFile, triggerLoadFile, onLoadFileSelected, toggleTheme
      };
    }
  }).component("substitute-editor", SubstituteEditorComponent).component("date-input", DateInput).component("era-date", EraDate).component("office-picker", OfficePicker).component("address-input", AddressInput).component("paren-input", ParenInput).component("dead-fields", DeadFields)
    .mount("#app");
})();
