// ------------------------------------------------------------
// 台帳（人物・不動産の個体管理と、時系列の変更履歴）
// ------------------------------------------------------------
// 画面（Vue）には依存しない、入力データだけを扱う部品。通信しない。
//
// 考え方
//  ・人物の個体ID `pid` … 人物（被相続人・配偶者・子・兄弟姉妹・親・代襲者）ごとに持つ。
//    被相続人を追加するとき（人物カードの「この方を被相続人とする手続も作る」など）は、
//    同じ人物に同じ pid を引き継ぐ。→ 手続をまたいで「同じ人」と分かる。
//  ・不動産の個体ID … 相続財産（registration.properties[]）の既存の `id` をそのまま使う。
//    前の手続から引き継いだ不動産は、同じ id を持つ。
//  ・履歴 … 台帳（ledger）に、人物の住所・氏名などの変更、不動産の名義の変動を日付つきで残す。
//    手続から分かること（被相続人の死亡による相続）は、保存せず、そのつど計算して並べる。
//
// 台帳の保存形式（dev/SAVE_FORMAT.md）
//   ledger: {
//     people:  { [pid]: { history: [ { id, date, kind, value, note } ] } },     kind = address / name / other
//     estates: { [不動産id]: { events: [ { id, date, cause, text } ] } },
//     notSame: [ "pidA|pidB", ... ]       // 「別人です」と確認した組（同一人物の候補に出さない）
//   }
(function (root) {
  const ERA_BASE = { "明治": 1867, "大正": 1911, "昭和": 1925, "平成": 1988, "令和": 2018 };
  const toHalf = (v) => String(v == null ? "" : v).replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));

  // 「昭和45年3月〇日」→ { era, y, m, d }（未入力・〇は null）。日付の形でなければ null
  function parseJa(str) {
    const t = toHalf(str).replace(/\s/g, "");
    const m = t.match(/(令和|平成|昭和|大正|明治)(元|\d+|〇)?年(\d+|〇)?月(\d+|〇)?日/);
    if (!m) return null;
    const n = (x) => (x === undefined || x === "〇" ? null : x === "元" ? 1 : parseInt(x, 10));
    return { era: m[1], y: n(m[2]), m: n(m[3]), d: n(m[4]) };
  }
  // 並べ替え用の数（西暦年×10000＋月×100＋日）。年が分からなければ null。月・日が分からなければ 0 とする
  function dateKey(str) {
    const p = parseJa(str);
    if (!p || p.y === null) return null;
    return (ERA_BASE[p.era] + p.y) * 10000 + (p.m || 0) * 100 + (p.d || 0);
  }
  // 日付の前後（a が前なら負）。日付が読めないものは後ろへ。同じなら 0
  function compareDate(a, b) {
    const ka = dateKey(a), kb = dateKey(b);
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka - kb;
  }
  // 日付が「令和〇年〇月〇日」のような未入力の印だけか
  function hasDate(str) { return dateKey(str) !== null; }

  const rand = () => Math.random().toString(36).slice(2, 8);
  function newPid() { return "psn_" + rand(); }
  function newEntryId() { return "ent_" + rand(); }

  // ---- 人物をたどる ----
  // data は、被相続人1人分のデータ（buildSaveData の形）。fn(person, 区分) を、全人物に対して呼ぶ。
  //   区分: spouse / child / sibling / parent / substitute
  function walkPersons(data, fn) {
    if (!data) return;
    const sub = (arr) => (Array.isArray(arr) ? arr : []).forEach((p) => { if (p && typeof p === "object") { fn(p, "substitute"); sub(p.substitutes); } });
    const top = (arr, kind) => (Array.isArray(arr) ? arr : []).forEach((p) => { if (p && typeof p === "object") { fn(p, kind); sub(p.substitutes); } });
    if (data.spouse && typeof data.spouse === "object") fn(data.spouse, "spouse");
    top(data.children, "child");
    top(data.siblings, "sibling");
    top(data.parents, "parent");
    if (data.spouse && Array.isArray(data.spouse.substitutes)) sub(data.spouse.substitutes);
  }
  // 個体ID（pid）のない人物に振る。1つの手続の中で pid が重なっていたら、後の人に振り直す。振った数を返す
  function ensurePids(data) {
    if (!data || typeof data !== "object") return 0;
    let n = 0;
    const seen = {};
    if (data.deceased && typeof data.deceased === "object") {
      if (!data.deceased.pid) { data.deceased.pid = newPid(); n++; }
      seen[data.deceased.pid] = true;
    }
    walkPersons(data, (p) => {
      if (!p.pid || seen[p.pid]) { p.pid = newPid(); n++; }
      seen[p.pid] = true;
    });
    return n;
  }

  // ---- 台帳（ledger）の形を整える（型が崩れていても読み込む） ----
  function normalizeLedger(raw) {
    const out = { people: {}, estates: {}, notSame: [] };
    if (!raw || typeof raw !== "object") return out;
    if (raw.people && typeof raw.people === "object") {
      Object.keys(raw.people).forEach((k) => {
        const src = raw.people[k];
        const hist = src && Array.isArray(src.history) ? src.history : [];
        out.people[k] = { history: hist.filter((h) => h && typeof h === "object").map((h) => ({
          id: h.id || newEntryId(), date: String(h.date || ""), kind: ["address", "name", "other"].indexOf(h.kind) >= 0 ? h.kind : "other",
          value: String(h.value || ""), note: String(h.note || "")
        })) };
      });
    }
    if (raw.estates && typeof raw.estates === "object") {
      Object.keys(raw.estates).forEach((k) => {
        const src = raw.estates[k];
        const ev = src && Array.isArray(src.events) ? src.events : [];
        out.estates[k] = { events: ev.filter((e) => e && typeof e === "object").map((e) => ({
          id: e.id || newEntryId(), date: String(e.date || ""), cause: String(e.cause || ""), text: String(e.text || "")
        })) };
      });
    }
    if (Array.isArray(raw.notSame)) out.notSame = raw.notSame.filter((s) => typeof s === "string");
    return out;
  }
  function emptyLedger() { return normalizeLedger(null); }

  // ---- 相続パターンから、その手続で不動産を取得する人 ----
  // （app.js の estateUnits / finalLiving と同じ規則を、入力データだけで計算する。規則を変えたら、両方を直すこと）
  function isSuccessorIn(pattern, person) {
    if (!pattern || !person) return true;
    const v = pattern.successors ? pattern.successors[person.id] : undefined;
    return v === undefined ? true : !!v;
  }
  function deathKindOf(p, deceasedDeath) {
    if (!p || !p.death) return "alive";
    const pd = parseJa(p.death), dd = parseJa(deceasedDeath);
    if (pd && pd.y !== null && dd && dd.y !== null) {
      const a = dateKey(p.death), b = dateKey(deceasedDeath);
      const hasMD = (x) => x.m !== null && x.d !== null;
      // 年が違えば年で、同じ年は月日がそろっているときだけ判定する
      const ya = ERA_BASE[pd.era] + pd.y, yb = ERA_BASE[dd.era] + dd.y;
      if (ya !== yb) return ya > yb ? "after" : "before";
      if (hasMD(pd) && hasMD(dd)) return a > b ? "after" : "before";   // 同じ日は同時に亡くなったものとして「先」
    }
    return p.deathTiming === "after" ? "after" : "before";
  }
  function acquirerUnits(data, pattern) {
    const dd = data.deceased ? data.deceased.death : "";
    const kind = (p) => deathKindOf(p, dd);
    const lineUnits = (p) => {
      const k = kind(p);
      if (k === "alive" || k === "after") return [p];
      return (p.substitutes || []).reduce((acc, s) => acc.concat(lineUnits(s)), []);
    };
    const countEff = (list) => (list || []).filter((p) => {
      if ((p.substitutes || []).length > 0) return true;
      if (p.death && kind(p) === "after") return true;
      return !p.death;
    }).length;
    const units = [];
    if (data.spouse && data.spouse.name && kind(data.spouse) !== "before") units.push(data.spouse);
    const childCount = countEff(data.children), parentCount = countEff(data.parents);
    if (childCount > 0) (data.children || []).forEach((c) => lineUnits(c).forEach((u) => units.push(u)));
    else if (parentCount > 0) (data.parents || []).filter((p) => !p.death).forEach((p) => units.push(p));
    else (data.siblings || []).forEach((s) => lineUnits(s).forEach((u) => units.push(u)));
    return units.filter((u) => isSuccessorIn(pattern, u));
  }

  // ---- 持分の計算（分数） ----
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  function reduce(n, d) { const g = gcd(n, d); return { n: n / g, d: d / g }; }
  function parseShare(s) {
    if (root.Ledger && typeof root.Ledger.shareParser === "function") return root.Ledger.shareParser(s);
    const t = toHalf(s).replace(/[／]/g, "/").replace(/\s/g, "").replace(/^持分/, "");
    let m = t.match(/^(\d+)分の(\d+)$/);
    if (m) return { n: parseInt(m[2], 10), d: parseInt(m[1], 10) };
    m = t.match(/^(\d+)\/(\d+)$/);
    if (m) return { n: parseInt(m[1], 10), d: parseInt(m[2], 10) };
    return null;
  }
  function fracText(f) { return !f ? "" : (f.n === f.d ? "全部" : f.d + "分の" + f.n); }
  function sameFrac(a, b) { return !!a && !!b && a.n * b.d === b.n * a.d; }

  // 被相続人が、その不動産に持っていた割合（所有権全部なら 1、共有持分なら入力された持分。読めなければ null）
  function ownShare(pr) { return pr.rightKind === "share" ? parseShare(pr.deceasedShare) : { n: 1, d: 1 }; }

  const REAL_ESTATE = { land: "土地", building: "建物", unit: "区分建物" };

  // ---- 台帳の見え方を作る（保存しない。計算するだけ） ----
  // casesList: [ { id, data, label } ]（開いている手続は、いまの入力内容を入れておく）
  // ledger: 台帳（normalizeLedger を通したもの）
  function buildView(casesList, ledger) {
    const lg = ledger || emptyLedger();
    const people = {};      // pid → { pid, appearances: [...] }
    const estates = {};     // 不動産id → { id, appearances: [...] }
    const caseInfo = {};

    casesList.forEach((c) => {
      const d = c.data || {};
      const dec = d.deceased || {};
      const label = (dec.name || "") || "被相続人（未入力）";
      caseInfo[c.id] = { id: c.id, label, death: dec.death || "", pid: dec.pid || "" };
      if (dec.pid) {
        (people[dec.pid] = people[dec.pid] || { pid: dec.pid, appearances: [] }).appearances.push({
          caseId: c.id, caseLabel: label, role: "被相続人", isDeceased: true, personId: "deceased",
          name: dec.name || "", birth: dec.birth || "", death: dec.death || "", addr: dec.lastAddr || ""
        });
      }
      walkPersons(d, (p, kind) => {
        if (!p.pid) return;
        (people[p.pid] = people[p.pid] || { pid: p.pid, appearances: [] }).appearances.push({
          caseId: c.id, caseLabel: label, role: (p.role || "").replace(/^（|）$/g, "") || ({ spouse: "配偶者", child: "子", sibling: "兄弟姉妹", parent: "親", substitute: "代襲者等" })[kind],
          isDeceased: false, personId: p.id, name: p.name || "", birth: p.birth || "", death: p.death || "", addr: p.addr || ""
        });
      });
      // 不動産（土地・建物・区分建物）
      const regs = (d.registration && Array.isArray(d.registration.properties)) ? d.registration.properties : [];
      const patterns = Array.isArray(d.successorPatterns) ? d.successorPatterns : [];
      regs.forEach((pr) => {
        if (!pr || !REAL_ESTATE[pr.kind] || !pr.id) return;
        const pattern = patterns.find((x) => x.id === pr.patternId) || patterns[0] || null;
        const units = pattern || patterns.length === 0 ? acquirerUnits(d, pattern) : [];
        const own = ownShare(pr);
        const acquirers = units.map((u) => {
          const sh = units.length === 1 ? { n: 1, d: 1 } : parseShare(pattern && pattern.shares ? pattern.shares[u.id] : "");
          const hold = own && sh ? reduce(own.n * sh.n, own.d * sh.d) : null;
          return { pid: u.pid || "", name: u.name || "（氏名未入力）", share: sh, hold, dead: !!u.death };
        });
        (estates[pr.id] = estates[pr.id] || { id: pr.id, appearances: [] }).appearances.push({
          caseId: c.id, caseLabel: label, death: dec.death || "", deceasedPid: dec.pid || "",
          kind: pr.kind, location: pr.location || "", lotNo: pr.lotNo || "", buildingName: pr.buildingName || "", unitName: pr.unitName || "",
          rightKind: pr.rightKind, own, acquirers, patternName: pattern ? pattern.name : ""
        });
      });
    });

    // ---- 人物 ----
    const peopleList = Object.keys(people).map((pid) => {
      const rec = people[pid];
      const apps = rec.appearances;
      // 食い違い（手続によって、氏名・生年月日・死亡年月日・住所が違う）。「〇」を含む見本の値は比べない
      const conflicts = [];
      [["name", "氏名"], ["birth", "生年月日"], ["death", "死亡年月日"], ["addr", "住所"]].forEach(([f, lab]) => {
        const vals = [];
        apps.forEach((a) => { const v = (a[f] || "").trim(); if (v && v.indexOf("〇") < 0 && vals.indexOf(v) < 0) vals.push(v); });
        if (vals.length > 1) conflicts.push({ field: f, label: lab, values: vals });
      });
      const hist = ((lg.people[pid] && lg.people[pid].history) || []).slice().sort((a, b) => compareDate(a.date, b.date));
      const first = apps[0] || {};
      const bestName = (apps.map((a) => a.name).find((n) => n) || "（氏名未入力）");
      const birth = (apps.map((a) => a.birth).find((v) => v && v.indexOf("〇") < 0) || (first.birth || ""));
      const death = (apps.map((a) => a.death).find((v) => v) || "");
      // 時系列（生年月日・履歴・死亡・被相続人としての手続）
      const timeline = [];
      if (hasDate(birth)) timeline.push({ date: birth, label: "出生", auto: true });
      hist.forEach((h) => timeline.push({ date: h.date, label: ({ address: "住所変更", name: "氏名変更", other: "その他" })[h.kind] + (h.value ? "：" + h.value : "") + (h.note ? "（" + h.note + "）" : ""), auto: false, entry: h }));
      if (death) timeline.push({ date: death, label: "死亡" + (apps.some((a) => a.isDeceased) ? "（この方を被相続人とする手続あり）" : ""), auto: true });
      timeline.sort((a, b) => compareDate(a.date, b.date));
      return { pid, name: bestName, birth, death, appearances: apps, conflicts, history: hist, timeline };
    }).sort((a, b) => (b.appearances.length - a.appearances.length) || a.name.localeCompare(b.name, "ja"));

    // ---- 同一人物の候補（氏名と、日付がそろった生年月日が同じで、pid が違う） ----
    const candidates = [];
    const notSame = {};
    (lg.notSame || []).forEach((k) => { notSame[k] = true; });
    for (let i = 0; i < peopleList.length; i++) {
      for (let j = i + 1; j < peopleList.length; j++) {
        const a = peopleList[i], b = peopleList[j];
        if (!a.name || a.name.indexOf("未入力") >= 0 || a.name !== b.name) continue;
        if (!hasDate(a.birth) || !hasDate(b.birth) || a.birth !== b.birth) continue;
        const key = [a.pid, b.pid].sort().join("|");
        if (notSame[key]) continue;
        // 同じ手続に2人とも登場していれば、別人
        const casesA = {}; a.appearances.forEach((x) => { casesA[x.caseId] = true; });
        if (b.appearances.some((x) => casesA[x.caseId])) continue;
        candidates.push({ key, a, b });
      }
    }

    // ---- 不動産 ----
    const nameOfPid = {};
    peopleList.forEach((p) => { nameOfPid[p.pid] = p.name; });
    const estateList = Object.keys(estates).map((id) => {
      const apps = estates[id].appearances.slice().sort((a, b) => compareDate(a.death, b.death));
      const last = apps[apps.length - 1] || {};
      const title = (last.location || "（所在未入力）") + (last.lotNo ? " " + last.lotNo : "") + (last.kind === "unit" ? " " + (last.buildingName || "") + (last.unitName ? " " + last.unitName : "") : "");
      const warnings = [];
      const timeline = [];
      apps.forEach((a, i) => {
        const who = a.acquirers.map((q) => q.name + (a.acquirers.length > 1 && q.share ? "（" + fracText(q.share) + "）" : "")).join("、") || "（取得者なし・未選択）";
        const own = a.own ? (a.own.n === a.own.d ? "所有権全部" : "持分" + fracText(a.own)) : "持分未入力";
        timeline.push({ date: a.death, auto: true, label: "相続　" + a.caseLabel + "（" + own + "）→ " + who, caseId: a.caseId });
        // 前の手続の取得者に、この手続の被相続人がいるか。持分は合うか
        if (i > 0) {
          const prev = apps[i - 1];
          const hit = prev.acquirers.find((q) => q.pid && q.pid === a.deceasedPid);
          if (!hit) {
            if (prev.acquirers.length > 0) warnings.push("「" + a.caseLabel + "」の手続の被相続人は、前の手続（" + prev.caseLabel + "）で、この不動産を取得する人に入っていません。");
          } else if (hit.hold && a.own && !sameFrac(hit.hold, a.own)) {
            warnings.push("「" + prev.caseLabel + "」の手続で、" + hit.name + "さんが取得する持分は" + fracText(hit.hold) + "ですが、「" + a.caseLabel + "」の手続では、被相続人の持分が" + fracText(a.own) + "になっています。");
          }
        }
      });
      ((lg.estates[id] && lg.estates[id].events) || []).forEach((e) => {
        timeline.push({ date: e.date, auto: false, label: (e.cause || "その他") + (e.text ? "：" + e.text : ""), entry: e });
      });
      timeline.sort((a, b) => compareDate(a.date, b.date));
      return { id, title, kindLabel: REAL_ESTATE[last.kind] || "", appearances: apps, timeline, warnings, events: (lg.estates[id] && lg.estates[id].events) || [] };
    }).sort((a, b) => a.title.localeCompare(b.title, "ja"));

    return { people: peopleList, estates: estateList, candidates, cases: caseInfo };
  }

  // ---- 住所の履歴から ----
  // ある日（date）に、その人が住んでいた住所（履歴の住所変更のうち、その日以前で最も新しいもの）。なければ null
  function addressAt(history, date) {
    const list = (history || []).filter((h) => h.kind === "address" && h.value && hasDate(h.date)).sort((a, b) => compareDate(a.date, b.date));
    if (!list.length) return null;
    if (!date || !hasDate(date)) return list[list.length - 1].value;
    const k = dateKey(date);
    let hit = null;
    list.forEach((h) => { if (dateKey(h.date) <= k) hit = h; });
    return hit ? hit.value : null;
  }
  function latestAddress(history) { return addressAt(history, ""); }

  // ---- 手続の入力データ（plain）の書き換え：同一人物の統合・項目をそろえる ----
  function replacePid(data, from, to) {
    let n = 0;
    if (data && data.deceased && data.deceased.pid === from) { data.deceased.pid = to; n++; }
    walkPersons(data, (p) => { if (p.pid === from) { p.pid = to; n++; } });
    return n;
  }
  // 台帳の人物の履歴を、from から to へ集める（同じ内容は重ねない）
  function mergeLedgerPeople(ledger, from, to) {
    const src = ledger.people[from];
    if (!src) return;
    const dst = (ledger.people[to] = ledger.people[to] || { history: [] });
    src.history.forEach((h) => {
      if (!dst.history.some((x) => x.date === h.date && x.kind === h.kind && x.value === h.value && x.note === h.note)) dst.history.push(h);
    });
    delete ledger.people[from];
  }

  root.Ledger = {
    shareParser: null,
    parseJa, dateKey, compareDate, hasDate, newPid, newEntryId, walkPersons, ensurePids,
    normalizeLedger, emptyLedger, acquirerUnits, isSuccessorIn, parseShare, ownShare, reduce, fracText, sameFrac,
    buildView, addressAt, latestAddress, replacePid, mergeLedgerPeople, REAL_ESTATE
  };
})(typeof window !== "undefined" ? window : globalThis);
